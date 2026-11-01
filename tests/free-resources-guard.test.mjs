// Run with: node --test tests/free-resources-guard.test.mjs
// Two programs live in the free-resources scripts. The scan, measure and headroom only read. free.mjs can stop a process,
// and only through lib/terminate.mjs. These guards read the code that can run (everything an entry script imports, found
// by following the imports) instead of a hand-written list, so a new module cannot slip past them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allScripts, closure, rel } from "./helpers/free-resources-closure.mjs";
import { load } from "./helpers/free-resources-headroom.mjs";

const ENTRIES = ["processes.mjs", "measure.mjs", "headroom.mjs"];
const { files, bare } = closure(ENTRIES);
const names = [...files].map(rel).sort();
const text = (f) => readFileSync(f, "utf8");
// The stop program and the modules only it uses.
const STOP = closure(["free.mjs"]);
const stopNames = [...STOP.files].map(rel).sort();
const STOP_ONLY = ["free.mjs", "lib/facts.mjs", "lib/free-core.mjs", "lib/gate.mjs", "lib/pin-windows.mjs", "lib/plans.mjs", "lib/selfcheck.mjs", "lib/terminate.mjs"];

// Tokens that end, signal or elevate. The one exception is the sampler ending the two helper processes it started itself.
const BAD = [/process\.kill/, /\.kill\(/, /\.Kill\(/, /\[\s*["'`]kill["'`]\s*\]/, /taskkill/i, /\btskill\b/i, /\bwmic\b/i, /Stop-Process/i, /Stop-Service/i, /Debug-Process/i, /DebugActiveProcess/i, /NtSuspendProcess/i, /NtTerminateProcess/i, /\bkill\b\s+-/, /\bpkill\b/, /\bkillall\b/i, /CloseMainWindow/i, /TerminateProcess/i, /\.Terminate\(/i, /\bsudo\b/i, /\bdoas\b/, /\brunas\b/i, /\bpkexec\b/, /\blaunchctl\b/, /\bsystemctl\b/];
// The sampler ending its own children, and the helper table naming launchctl (used only by free.mjs, only to list jobs).
const ALLOWED = new Map([["lib/sampler.mjs", ["child.kill(); // ends our own child through its handle"]], ["lib/bin.mjs", ['launchctl: ["/bin/launchctl"],']]]);

test("free-resources guard: the read-only scripts and free.mjs together reach every module, and the read-only ones never reach the stop code", () => {
  for (const m of ["processes.mjs", "measure.mjs", "headroom.mjs", "lib/analysis.mjs", "lib/bin.mjs", "lib/classify.mjs", "lib/config.mjs", "lib/headroom.mjs", "lib/linux.mjs", "lib/paths.mjs", "lib/peaks.mjs", "lib/powershell.mjs", "lib/pressure.mjs", "lib/report.mjs", "lib/rules.mjs", "lib/sampler.mjs", "lib/sanitize.mjs", "lib/scan.mjs", "lib/snapshot.mjs", "lib/text.mjs"]) {
    assert.ok(names.includes(m), `${m} is not reached from a read-only entry script`);
  }
  for (const m of STOP_ONLY) {
    assert.ok(stopNames.includes(m), `${m} is not reached from free.mjs`);
    assert.ok(!names.includes(m), `${m} is reached from a read-only script: the scan, measure and headroom must never load stop code`);
  }
  assert.deepEqual(stopNames.filter((m) => !names.includes(m)), STOP_ONLY, "free.mjs loads no other module of its own: a new one is added to STOP_ONLY on purpose");
  const outside = allScripts().map(rel).filter((f) => !names.includes(f) && !stopNames.includes(f));
  assert.deepEqual(outside, [], "a script that no entry imports is code these guards never read: import it from an entry on purpose, or remove it");
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
  assert.equal(seen.get("lib/sampler.mjs|child.kill(); // ends our own child through its handle"), 1, "the sampler's one line, used once");
  assert.equal(seen.get('lib/bin.mjs|launchctl: ["/bin/launchctl"],'), 1, "the helper table's launchctl entry, once");
  assert.equal(seen.size, 2);
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

// ---------- free.mjs: the one program that can stop a process ----------

const stopOnly = [...STOP.files].filter((f) => STOP_ONLY.includes(rel(f)));
const code = (f) => text(f).split(/\r?\n/).map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => !line.trim().startsWith("//"));
const END = [/process\.kill/, /\.kill\(/, /\.Kill\(/, /\[\s*["'`]kill["'`]\s*\]/, /taskkill/i, /\btskill\b/i, /\bwmic\b/i, /Stop-Process/i, /Stop-Service/i, /Debug-Process/i, /DebugActiveProcess/i, /NtSuspendProcess/i, /NtTerminateProcess/i, /\bpkill\b/, /\bkillall\b/i, /CloseMainWindow/i, /TerminateProcess/i, /\.Terminate\(/i, /\bdoas\b/, /\brunas\b/i, /\bpkexec\b/, /\blaunchctl\b/, /\bsystemctl\b/];
// The lines outside terminate.mjs allowed to name a way to end a process, or launchctl: the pin helper ending its own
// PowerShell, free.mjs handing terminate.mjs's two functions to the core (which receives them and never imports them), and
// macOS asking launchd, with its read-only "list" and "managername" commands, for its jobs and its kind of session (and
// saying so when it cannot).
const STOP_ALLOWED = new Map([
  ["lib/pin-windows.mjs", ["try { child.kill(); } catch { /* already gone */ }"]],
  ["free.mjs", ['import { taskkill, signal } from "./lib/terminate.mjs";', "act: { taskkill: (pid, { force }) => taskkill(pid, { force }), signal: (pid, sig) => signal(pid, sig) },"]],
  ["lib/free-core.mjs", ["const r = deps.act.taskkill(pid, { force });"]],
  ["lib/facts.mjs", ['const r = await runHelper("launchctl", ["list"], { platform: "darwin" });', 'const r = await runHelper("launchctl", ["managername"], { platform: "darwin" });']],
  ["lib/selfcheck.mjs", ['if (!(await launchdJobs())) reasons.push("`launchctl list` could not be read, so a launchd job could not be told apart from a left-over");']],
]);

test("free-resources guard: in free.mjs's code only terminate.mjs ends a process; the pin ends only its own PowerShell; nothing elevates", () => {
  const seen = [];
  for (const f of stopOnly) {
    const r = rel(f);
    if (r === "lib/terminate.mjs") continue;
    for (const { line, n } of code(f)) {
      for (const re of END) {
        if (!re.test(line)) continue;
        assert.ok((STOP_ALLOWED.get(r) ?? []).includes(line.trim()), `${r}:${n} has ${re}: ${line.trim()}`);
        seen.push(`${r}|${line.trim()}`);
      }
      // sudo is never a command: no string starts with it and no path ends in it (it appears only in refusals and the
      // variables sudo itself sets).
      assert.ok(!/["'`]\s*sudo\b|\/sudo\b/i.test(line), `${r}:${n} could run sudo: ${line.trim()}`);
    }
  }
  assert.deepEqual([...new Set(seen)].sort(), [...STOP_ALLOWED.entries()].flatMap(([r, ls]) => ls.map((l) => `${r}|${l}`)).sort(), "each allowed line is used, and no other");
  // Only free.mjs imports the two acting functions; the core gets them passed in.
  for (const f of STOP.files) {
    const r = rel(f);
    const m = text(f).match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/(?:lib\/)?terminate\.mjs["']/);
    if (!m) continue;
    const imported = m[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
    if (r === "free.mjs") assert.deepEqual(imported, ["signal", "taskkill"]);
    else if (r === "lib/free-core.mjs") assert.deepEqual(imported, ["assertPid"]);
    else assert.fail(`${r} imports from terminate.mjs`);
  }
});

test("free-resources guard: terminate.mjs runs only System32's taskkill with /PID and /F, and sends only SIGTERM or SIGKILL", () => {
  const src = text([...STOP.files].find((f) => rel(f) === "lib/terminate.mjs"));
  const body = code([...STOP.files].find((f) => rel(f) === "lib/terminate.mjs")).map((x) => x.line).join("\n");
  assert.equal((body.match(/process\.kill\(/g) ?? []).length, 1, "one place calls process.kill");
  assert.match(body, /killFn = \(p, s\) => process\.kill\(p, s\)/);
  assert.match(body, /if \(platform === "win32"\) throw new Error\("signals are not used on Windows"\);/, "never on Windows, where it ends at once");
  assert.match(body, /export const SIGNALS = new Set\(\["SIGTERM", "SIGKILL"\]\);/);
  assert.match(body, /join\(windowsDir\(env\), "System32", "taskkill\.exe"\)/);
  assert.match(body, /const args = \["\/PID", String\(pid\), \.\.\.\(force \? \["\/F"\] : \[\]\)\];/);
  for (const flag of ["/IM", "/T", "/FI", "/S", "/U", "/P"]) assert.ok(!body.includes(`"${flag}"`), flag);
  assert.ok(!/\bshell\s*:\s*true/.test(src));
  assert.equal((body.match(/^\s+assertPid\(pid, \{ self, parent \}\);$/gm) ?? []).length, 2, "both acting functions check the number first");
});

test("free-resources guard: the pin script makes only read-only native calls and opens processes with query and synchronize rights only", async () => {
  const { PIN_SCRIPT } = await load("pin-windows");
  const natives = [...PIN_SCRIPT.matchAll(/@\('(\w+\.dll)', '(\w+)'/g)].map((m) => `${m[1]}:${m[2]}`).sort();
  assert.deepEqual(natives, [
    "advapi32.dll:GetTokenInformation", "advapi32.dll:OpenProcessToken", "kernel32.dll:CloseHandle", "kernel32.dll:GetProcessId", "kernel32.dll:GetProcessTimes",
    "kernel32.dll:IsProcessCritical", "kernel32.dll:OpenProcess", "kernel32.dll:ProcessIdToSessionId", "kernel32.dll:QueryFullProcessImageName", "kernel32.dll:WaitForSingleObject",
    "ntdll.dll:NtQueryInformationProcess",
  ]);
  const rights = [...PIN_SCRIPT.matchAll(/OpenProcess\((0x[0-9A-Fa-f]+)/g)].map((m) => Number(m[1]));
  assert.deepEqual([...new Set(rights)].sort((a, b) => a - b), [0x1000, 0x00101000], "query-limited information, plus synchronize to wait");
  for (const verb of [/Stop-/i, /Kill/i, /Terminate/i, /taskkill/i, /Remove-Item/i, /Set-/i, /New-Item/i, /Out-File/i, /Invoke-Expression/i, /\biex\b/i, /Add-Type/i, /Start-Process/i, /AdjustTokenPrivileges/i, /DebugPrivilege/]) {
    assert.ok(!verb.test(PIN_SCRIPT), `the pin script has ${verb}`);
  }
  assert.match(PIN_SCRIPT, /OpenProcessToken\(\$h, 8,/, "tokens are opened for query only (TOKEN_QUERY)");
});

test("free-resources guard: free.mjs's code starts programs only through the fixed table with no shell, loads nothing by a computed name and imports only Node's own modules", () => {
  for (const f of STOP.files) {
    const r = rel(f);
    const src = text(f);
    for (const re of [/\bimport\s*\(/, /\brequire\s*\(/, /\bcreateRequire\b/, /\beval\s*\(/, /\bnew Function\b/, /\bnode:vm\b/]) assert.ok(!re.test(src), `${r} has ${re}`);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g)) {
      for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) assert.ok(["spawn", "spawnSync", "execFile", "execFileSync"].includes(n), `${r} imports ${n}`);
      assert.ok(/from\s*["']\.\/(lib\/)?bin\.mjs["']/.test(src), `${r} starts processes without the helper table`);
    }
    if (STOP_ONLY.includes(r)) for (const { line, n } of code(f)) assert.ok(!/\bshell\b\s*:\s*(?!false)/.test(line), `${r}:${n} sets a shell`);
  }
  for (const { file, spec } of STOP.bare) assert.ok(spec.startsWith("node:"), `${file} imports ${spec}`);
});
