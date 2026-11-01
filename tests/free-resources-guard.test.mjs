// Run with: node --test tests/free-resources-guard.test.mjs
// The free-resources scripts only read. These guards read the code that can run (everything the three entry scripts import,
// found by following the imports) instead of a hand-written list, so a new module cannot slip past them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allScripts, closure, rel } from "./helpers/free-resources-closure.mjs";

const ENTRIES = ["processes.mjs", "measure.mjs", "headroom.mjs"];
const { files, bare } = closure(ENTRIES);
const names = [...files].map(rel).sort();
const text = (f) => readFileSync(f, "utf8");

// Tokens that end, signal or elevate. The one exception is the sampler ending the two helper processes it started itself.
const BAD = [/process\.kill/, /\.kill\(/, /\.Kill\(/, /taskkill/i, /Stop-Process/i, /Stop-Service/i, /\bkill\b\s+-/, /\bpkill\b/, /\bkillall\b/i, /CloseMainWindow/i, /TerminateProcess/i, /\.Terminate\(/i, /\bsudo\b/i, /\bdoas\b/, /\brunas\b/i, /\bpkexec\b/, /\blaunchctl\b/, /\bsystemctl\b/];
const ALLOWED = new Map([["lib/sampler.mjs", ["child.kill(); // ends our own child through its handle"]]]);

test("free-resources guard: the three entry scripts reach every module of the plugin, and the closure includes the newer ones", () => {
  for (const m of ["processes.mjs", "measure.mjs", "headroom.mjs", "lib/analysis.mjs", "lib/bin.mjs", "lib/classify.mjs", "lib/config.mjs", "lib/headroom.mjs", "lib/linux.mjs", "lib/paths.mjs", "lib/peaks.mjs", "lib/powershell.mjs", "lib/pressure.mjs", "lib/report.mjs", "lib/rules.mjs", "lib/sampler.mjs", "lib/sanitize.mjs", "lib/scan.mjs", "lib/snapshot.mjs", "lib/text.mjs"]) {
    assert.ok(names.includes(m), `${m} is not reached from an entry script`);
  }
  const outside = allScripts().map(rel).filter((f) => !names.includes(f));
  assert.deepEqual(outside, [], "a script that no entry imports is code these guards never read: add it to ENTRIES on purpose, or remove it");
});

test("free-resources guard: no code in the closure can close, kill, signal or elevate a process, except one line in the sampler", () => {
  const seen = new Map();
  for (const f of files) {
    const r = rel(f);
    text(f).split(/\r?\n/).forEach((line, i) => {
      for (const re of BAD) {
        if (!re.test(line)) continue;
        assert.ok((ALLOWED.get(r) ?? []).includes(line.trim()), `${r}:${i + 1} has ${re}: ${line.trim()}`);
        seen.set(`${r}|${line.trim()}`, (seen.get(`${r}|${line.trim()}`) ?? 0) + 1);
      }
    });
  }
  assert.equal(seen.get("lib/sampler.mjs|child.kill(); // ends our own child through its handle"), 1, "exactly one allowed line, used once");
  assert.equal(seen.size, 1);
});

test("free-resources guard: the sampler ends only the handles of the two helpers it started", () => {
  const src = text([...files].find((f) => rel(f) === "lib/sampler.mjs"));
  const callers = src.split(/\r?\n/).filter((l) => /endOwnChild\(/.test(l) && !/function endOwnChild/.test(l));
  assert.deepEqual(callers.map((l) => l.trim()), ["await Promise.all(owned.map((c) => endOwnChild(c)));"]);
  assert.equal((src.match(/owned\.push\(/g) ?? []).length, 2);
  assert.ok(/owned\.push\((typeperf|tree)\)/.test(src), "`owned` only receives the sampler's own spawn() results");
  assert.ok(!/pid\s*=\s*\w+\.pid[\s\S]{0,40}kill/.test(src), "no end-by-pid");
});

test("free-resources guard: nothing is loaded by a computed name, so the closure above is the whole program", () => {
  for (const f of files) {
    const src = text(f);
    for (const re of [/\bimport\s*\(/, /\brequire\s*\(/, /\bcreateRequire\b/, /\beval\s*\(/, /\bnew Function\b/, /\bnode:vm\b/, /\bprocess\.binding\b/, /\bprocess\.dlopen\b/]) {
      assert.ok(!re.test(src), `${rel(f)} has ${re}`);
    }
  }
});

test("free-resources guard: only Node's own modules are imported, never a package", () => {
  assert.ok(bare.length > 0);
  for (const { file, spec } of bare) assert.ok(spec.startsWith("node:"), `${file} imports ${spec}`);
  const used = [...new Set(bare.map((b) => b.spec))].sort();
  for (const spec of used) assert.ok(["node:child_process", "node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path", "node:url", "node:util", "node:process", "node:timers/promises", "node:readline", "node:perf_hooks"].includes(spec), `${spec} is a built-in the guards have not looked at; check what it is used for, then add it here`);
});

test("free-resources guard: child processes come from the argument-list functions only, started through the fixed absolute helper table", () => {
  const SAFE = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
  // measure.mjs runs the command the person typed, so on Windows it goes through cmd.exe (an absolute path from the Windows folder).
  const SHELL_RUN = new Map([["measure.mjs", '? spawn(windowsCommandLine(opts.command), [], { shell, stdio: "inherit" })']]);
  let shellLines = 0;
  const starters = [];
  for (const f of files) {
    const r = rel(f);
    const src = text(f);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g)) {
      const imported = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const n of imported) assert.ok(SAFE.has(n), `${r} imports ${n} from node:child_process; only the functions that take an argument list are allowed (no exec, execSync or fork)`);
      starters.push(r);
      assert.ok(/from\s*["']\.\/(lib\/)?bin\.mjs["']/.test(src), `${r} starts processes without the helper table (lib/bin.mjs)`);
    }
    assert.ok(!/import\s+(\*\s+as\s+\w+|\w+)\s+from\s*["']node:child_process["']/.test(src), `${r} imports child_process whole, which this guard cannot check`);
    src.split(/\r?\n/).forEach((line, i) => {
      if (line.trim().startsWith("//") || !/\bshell\b\s*[:,}]/.test(line) || /\bshell:\s*false\b/.test(line)) return;
      assert.ok(SHELL_RUN.get(r) === line.trim(), `${r}:${i + 1} turns a shell on: ${line.trim()}`);
      shellLines += 1;
    });
  }
  assert.ok(starters.length > 0, "the check found no place that starts a process, so its pattern is wrong");
  assert.equal(shellLines, 1, "one shell line in all: measure.mjs runs the person's own command");
  const measure = text([...files].find((f) => rel(f) === "measure.mjs"));
  assert.match(measure, /const shell = process\.platform === "win32" \? bin\("cmd", \{ platform: "win32" \}\) : null;/, "that shell is the absolute cmd.exe from the Windows folder");
});
