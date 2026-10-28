// Run with: node --test tests/tree-state.test.mjs
// Covers plugins/phased-shipping/skills/run/scripts/tree-state.mjs: the id of a working tree, and the record
// and check of green full verifies. Uses temp git repos and temp data folders under the OS temp folder, never
// the real data folder. Most cases call main(argv, io) in this process; one case runs the real script. Git is slow where this runs
// (every call starts a process), so the cases that need a real repository share one, and the id cases answer the two checks the script
// makes before it builds the tree (rev-parse) once per repository: the three commands that build the tree still run for real.
// This file is one of 2 (tree-state.test.mjs, tree-state-process.test.mjs) that came from one file; the helpers they share are in tests/helpers/tree-state.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, verifyText, addRecord, MAX_RECORDS, MAX_AGE_MS, RECORD_FILE } from "../plugins/phased-shipping/skills/run/scripts/tree-state.mjs";
import { commandsSection } from "../plugins/phased-shipping/skills/run/scripts/commands-hash.mjs";
import { SCRIPT, made, scratch, git, makeRepo, PLAN, writePlan } from "./helpers/tree-state.mjs";


// One repository for the cases that only read it (or change a file and put it back), made on first use.
let shared = null;
const sharedRepo = () => (shared ??= makeRepo());
// The real git, for the seam io.git. The rev-parse checks are remembered per folder and arguments (they hold while HEAD stays put);
// read-tree, add and write-tree always run.
const realGit = (args, o) => execFileSync("git", args, { cwd: o.cwd, env: o.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
// The script puts "-c name=value" pairs before the git verb; these helpers look past them.
const stripC = (args) => { let i = 0; while (args[i] === "-c") i += 2; return args.slice(i); };
const cachedGit = () => {
  const memo = new Map();
  return (args, o) => {
    if (stripC(args)[0] !== "rev-parse") return realGit(args, o);
    const key = [o.cwd, ...stripC(args)].join("\0");
    if (!memo.has(key)) memo.set(key, realGit(args, o));
    return memo.get(key);
  };
};
const call = (argv, io = {}) => {
  let out = "";
  let err = "";
  const code = main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; }, ...io });
  return { code, out, err };
};
const idOfWith = (root, io) => {
  const r = call(["id", "--root", root], io);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^tree [0-9a-f]{40}\n$/);
  return r.out.trim().slice(5);
};
const OLD_PLAN = PLAN.replace(/- \*\*Full verify\*\*[^\n]*\n- \*\*Fast verify\*\*[^\n]*\n/, "- Baseline and verify (same commands): `npm run verify`\n");
const T0 = Date.parse("2026-10-28T10:00:00Z");
const hexN = (n) => n.toString(16).padStart(40, "0");
// A stand-in for git: answers the checks the script makes and returns the tree id it is given.
const fakeGit = (tree) => (all) => {
  const args = stripC(all);
  if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n\n";
  if (args[0] === "rev-parse") return "ok\n";
  if (args.includes("write-tree")) return `${typeof tree === "function" ? tree() : tree}\n`;
  return "";
};

// ---------- the id ----------
test("id equals HEAD^{tree} on a clean repo, changes on an edit, a new file and a deletion, and ignores an ignored file", () => {
  const repo = sharedRepo();
  const io = { git: cachedGit() };
  const idOf = (root) => idOfWith(root, io);
  const head = git(repo, "rev-parse", "HEAD^{tree}");
  assert.equal(idOf(repo), head);

  writeFileSync(join(repo, "a.txt"), "alpha changed\n");
  const edited = idOf(repo);
  assert.notEqual(edited, head, "an edit");
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  assert.equal(idOf(repo), head, "reverting the edit gives the first id back");

  writeFileSync(join(repo, "new.txt"), "new\n");
  const added = idOf(repo);
  assert.notEqual(added, head, "a new untracked file");
  assert.notEqual(added, edited);
  unlinkSync(join(repo, "new.txt"));

  unlinkSync(join(repo, "sub", "b.txt"));
  assert.notEqual(idOf(repo), head, "a deletion");
  writeFileSync(join(repo, "sub", "b.txt"), "beta\n");

  // A file that .gitignore ignores does not change the id.
  writeFileSync(join(repo, "ignored.log"), "noise\n");
  assert.equal(idOf(repo), head, "an ignored file");
  unlinkSync(join(repo, "ignored.log"));
});
test("the real index, HEAD, refs and status are untouched, and the id after a commit equals the new HEAD tree", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.txt"), "alpha dirty\n");
  writeFileSync(join(repo, "fresh.txt"), "fresh\n");
  const indexFile = join(repo, ".git", "index");
  const indexBefore = readFileSync(indexFile);
  const headBefore = readFileSync(join(repo, ".git", "HEAD"), "utf8");
  const refsBefore = git(repo, "show-ref");
  const id = idOfWith(repo);
  assert.deepEqual(readFileSync(indexFile), indexBefore, "the real index is byte-identical");
  assert.equal(readFileSync(join(repo, ".git", "HEAD"), "utf8"), headBefore);
  assert.equal(git(repo, "show-ref"), refsBefore);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "alpha dirty\n", "working files are unchanged");
  assert.match(git(repo, "status", "--porcelain"), /^M a\.txt\n\?\? fresh\.txt$/);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "second");
  assert.equal(git(repo, "rev-parse", "HEAD^{tree}"), id, "after everything is committed the id is the commit's tree");
});
test("the temp index is made in the OS temp folder and is gone after success and after a forced failure", () => {
  const repo = sharedRepo();
  const temp = scratch();
  const seen = [];
  const real = cachedGit();
  const watching = (failOn) => (args, o) => {
    if (o.env.GIT_INDEX_FILE) seen.push(o.env.GIT_INDEX_FILE);
    if (failOn && args.includes(failOn)) throw new Error("forced");
    return real(args, o);
  };
  const ok = call(["id", "--root", repo], { tmpdir: temp, git: watching() });
  assert.equal(ok.code, 0, ok.err);
  assert.ok(seen.length >= 3 && seen.every((p) => p.startsWith(temp)), "the temp index lives in the temp folder");
  assert.ok(!seen.includes(join(repo, ".git", "index")));
  assert.deepEqual(readdirSync(temp), [], "removed after success");

  for (const step of ["read-tree", "add", "write-tree"]) {
    const bad = call(["id", "--root", repo], { tmpdir: temp, git: watching(step) });
    assert.equal(bad.code, 3, step);
    assert.equal(bad.out, "");
    assert.equal(bad.err, "tree-state: git failed\n", "a fixed phrase, no git output");
    assert.deepEqual(readdirSync(temp), [], `removed after a failure in ${step}`);
  }
});
test("a folder that is not a git repo, a sub-folder of one, and a missing folder are refused, with nothing printed but a fixed phrase", () => {
  const repo = sharedRepo();
  const plain = scratch();
  const phrase = "tree-state: root is not the top of a git work tree\n";
  for (const root of [plain, join(repo, "sub"), join(plain, "missing")]) {
    const r = call(["id", "--root", root]);
    assert.equal(r.code, 3, root);
    assert.equal(r.out, "");
    assert.equal(r.err, phrase);
  }
  const plan = writePlan(plain, PLAN);
  const rec = call(["record", "--root", join(repo, "sub"), "--plan", plan, "--data", join(plain, "data")]);
  assert.equal(rec.code, 3);
  assert.equal(existsSync(join(plain, "data")), false, "nothing written");
});
test("a repository with no commit yet is refused", () => {
  const dir = scratch();
  git(dir, "init", "-q");
  const r = call(["id", "--root", dir]);
  assert.equal(r.code, 3);
  assert.equal(r.err, "tree-state: the repository has no commit yet\n");
});
test("the source runs git with an argument array and never a shell", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /execFileSync\("git", args,/);
  assert.doesNotMatch(src, /shell:\s*true/);
  assert.doesNotMatch(src, /\bexec\(|\bexecSync\(|\bspawn\(|\bspawnSync\(/);
});

// ---------- the plan's Full verify text ----------
test("verifyText takes the Full verify bullet with its indented lines, falls back to the Baseline line, and is null without either", () => {
  assert.equal(verifyText(PLAN), "- **Full verify** (baseline and final compare): `npm run verify`");
  const nested = "## Commands\n- **Full verify** (a):\n  - `npm run verify`\n  - `node x.mjs`\n\n- **Fast verify**: `lint`\n";
  assert.equal(verifyText(nested), "- **Full verify** (a):\n  - `npm run verify`\n  - `node x.mjs`");
  assert.equal(verifyText(OLD_PLAN), "- Baseline and verify (same commands): `npm run verify`");
  assert.equal(verifyText(OLD_PLAN.replace(/- Baseline[^\n]*\n/, "")), null);
  assert.equal(verifyText("# Phase\n## Risks\n- a\n"), null);
  // A full verify line wins over an earlier baseline line.
  assert.equal(verifyText("## Commands\n- Baseline: `a`\n- Full verify: `b`\n"), "- Full verify: `b`");
  assert.equal(verifyText(PLAN.replace(/\n/g, "\r\n")), verifyText(PLAN), "line endings do not matter");
});

// ---------- record and check ----------
test("check reuses only on an exact match: tree, full-verify text and Node version, within 7 days", () => {
  const dir = scratch();
  const data = join(dir, "data");
  const plan = writePlan(dir, PLAN);
  const base = { git: fakeGit("a".repeat(40)), now: T0, nodeVersion: "v24.1.0" };
  const args = (verb, p = plan) => [verb, "--root", dir, "--plan", p, "--data", data];

  let r = call(args("check"), base);
  assert.deepEqual([r.code, r.out], [1, "no reuse: no record\n"]);

  r = call(args("record"), base);
  assert.deepEqual([r.code, r.out, r.err], [0, `recorded ${"a".repeat(40)}\n`, ""]);

  r = call(args("check"), base);
  assert.deepEqual([r.code, r.out], [0, `reuse ${"a".repeat(40)} 2026-10-28\n`]);
  assert.equal(r.err, "");

  r = call(args("check"), { ...base, git: fakeGit("b".repeat(40)) });
  assert.deepEqual([r.code, r.out], [1, "no reuse: tree differs\n"]);

  const changed = writePlan(dir, PLAN.replace("npm run verify", "npm run verify && npm run build"), "changed.md");
  r = call(args("check", changed), base);
  assert.deepEqual([r.code, r.out], [1, "no reuse: commands differ\n"]);

  r = call(args("check"), { ...base, nodeVersion: "v24.1.1" });
  assert.deepEqual([r.code, r.out], [1, "no reuse: Node differs\n"]);

  r = call(args("check"), { ...base, now: T0 + MAX_AGE_MS });
  assert.equal(r.code, 0, "exactly 7 days old is still fresh");
  r = call(args("check"), { ...base, now: T0 + MAX_AGE_MS + 1 });
  assert.deepEqual([r.code, r.out], [1, "no reuse: too old\n"]);
  assert.equal(MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);

  // A change outside the Full verify text does not change the hash; a change inside it does.
  const other = writePlan(dir, PLAN.replace("`npm run lint`", "`npm run lint && npm test`").replace("git push origin main", "git push"), "other.md");
  assert.equal(call(args("check", other), base).code, 0);
});
test("an older plan with one Baseline line is read as its full verify, and a plan with neither line exits 2", () => {
  const dir = scratch();
  const data = join(dir, "data");
  const old = writePlan(dir, OLD_PLAN, "old.md");
  const base = { git: fakeGit("c".repeat(40)), now: T0, nodeVersion: "v24.1.0" };
  assert.equal(call(["record", "--root", dir, "--plan", old, "--data", data], base).code, 0);
  assert.deepEqual([call(["check", "--root", dir, "--plan", old, "--data", data], base).code], [0]);

  const none = writePlan(dir, OLD_PLAN.replace(/- Baseline[^\n]*\n/, ""), "none.md");
  for (const verb of ["record", "check"]) {
    const r = call([verb, "--root", dir, "--plan", none, "--data", data], base);
    assert.equal(r.code, 2, verb);
    assert.equal(r.out, "");
    assert.equal(r.err, "tree-state: the plan has no usable Full verify or Baseline text\n");
  }
  const noSection = writePlan(dir, "# Phase\n\n## Risks\n- x\n", "nosection.md");
  assert.equal(call(["check", "--root", dir, "--plan", noSection, "--data", data], base).code, 2);
  assert.equal(call(["check", "--root", dir, "--plan", join(dir, "missing.md"), "--data", data], base).code, 3);
});
test("there is no way to record a red result: record takes no status option and a stray option is refused", () => {
  const dir = scratch();
  const data = join(dir, "data");
  const plan = writePlan(dir, PLAN);
  const base = { git: fakeGit("d".repeat(40)), now: T0 };
  for (const extra of [["--red"], ["--status", "red"], ["--exit", "1"], ["--force"], ["--green"], ["--tree", "e".repeat(40)]]) {
    const r = call(["record", "--root", dir, "--plan", plan, "--data", data, ...extra], base);
    assert.equal(r.code, 3, extra.join(" "));
    assert.equal(r.out, "");
  }
  assert.equal(existsSync(join(data, RECORD_FILE)), false, "nothing was written");
  assert.doesNotMatch(readFileSync(SCRIPT, "utf8").split("\n").filter((l) => /^const (USAGE|REASONS)/.test(l)).join("\n"), /\bred\b|--status|fail/i);
});
test("the cap is 50 records, the newest kept, and the file stays valid JSON", () => {
  const dir = scratch();
  const data = join(dir, "data");
  const plan = writePlan(dir, PLAN);
  let n = 0;
  const io = { git: fakeGit(() => hexN(++n)), nodeVersion: "v24.1.0" };
  for (let i = 1; i <= MAX_RECORDS + 5; i++) {
    assert.equal(call(["record", "--root", dir, "--plan", plan, "--data", data], { ...io, now: T0 + i * 1000 }).code, 0);
  }
  const saved = JSON.parse(readFileSync(join(data, RECORD_FILE), "utf8"));
  assert.equal(saved.v, 1);
  assert.equal(saved.records.length, 50);
  assert.equal(saved.records[0].tree, hexN(6), "the oldest five were dropped");
  assert.equal(saved.records[49].tree, hexN(55));
  assert.deepEqual(Object.keys(saved.records[0]).sort(), ["at", "commands", "node", "tree"]);
  assert.equal(addRecord([{ tree: "t", commands: "c", node: "n", at: "x" }], { tree: "t", commands: "c", node: "n", at: "y" }).length, 1, "the same tree, commands and Node replace each other");
  const rec = (t) => ({ tree: t, commands: "c", node: "n", at: "x" });
  assert.deepEqual(addRecord([rec("1"), rec("2"), rec("3")], rec("4"), 3).map((r) => r.tree), ["2", "3", "4"]);
  // The oldest record is gone: its tree no longer reuses.
  n = 0;
  const first = call(["check", "--root", dir, "--plan", plan, "--data", data], { git: fakeGit(hexN(1)), now: T0 + 60000, nodeVersion: "v24.1.0" });
  assert.deepEqual([first.code, first.out], [1, "no reuse: tree differs\n"]);
  const last = call(["check", "--root", dir, "--plan", plan, "--data", data], { git: fakeGit(hexN(55)), now: T0 + 60000, nodeVersion: "v24.1.0" });
  assert.equal(last.code, 0);
});
test("an interrupted write leaves the old file valid and no temp file behind", () => {
  const dir = scratch();
  const data = join(dir, "data");
  const plan = writePlan(dir, PLAN);
  const io = { git: fakeGit("a".repeat(40)), now: T0, nodeVersion: "v24.1.0" };
  assert.equal(call(["record", "--root", dir, "--plan", plan, "--data", data], io).code, 0);
  const file = join(data, RECORD_FILE);
  const before = readFileSync(file, "utf8");
  const interrupted = call(["record", "--root", dir, "--plan", plan, "--data", data], { ...io, git: fakeGit("b".repeat(40)), rename: () => { throw new Error("interrupted"); } });
  assert.equal(interrupted.code, 3);
  assert.equal(interrupted.err, "tree-state: can't write the record\n");
  assert.equal(readFileSync(file, "utf8"), before, "the old file is untouched");
  assert.equal(JSON.parse(before).records.length, 1);
  assert.deepEqual(readdirSync(data), [RECORD_FILE], "no temp file left");
});
test("a damaged or foreign record file means no record, and record replaces it with a valid one", () => {
  const dir = scratch();
  const data = join(dir, "data");
  mkdirSync(data);
  const plan = writePlan(dir, PLAN);
  const io = { git: fakeGit("a".repeat(40)), now: T0, nodeVersion: "v24.1.0" };
  const file = join(data, RECORD_FILE);
  for (const bad of ["{ not json", "[]", "null", '{"records": 5}', '{"records":[{"tree":"x"},null,7]}', ""]) {
    writeFileSync(file, bad);
    assert.deepEqual([call(["check", "--root", dir, "--plan", plan, "--data", data], io).out], ["no reuse: no record\n"], JSON.stringify(bad));
  }
  assert.equal(call(["record", "--root", dir, "--plan", plan, "--data", data], io).code, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).records.length, 1);
  // A record dated in the future is not trusted.
  const future = { tree: "a".repeat(40), commands: "f".repeat(64), node: "v24.1.0", at: "2030-01-01T00:00:00.000Z" };
  writeFileSync(file, JSON.stringify({ v: 1, records: [future] }));
  assert.equal(call(["check", "--root", dir, "--plan", plan, "--data", data], io).out, "no reuse: no record\n");
});
test("a relative --data is refused with nothing read or written, and so are missing and repeated options", () => {
  const dir = scratch();
  const plan = writePlan(dir, PLAN);
  const base = { git: fakeGit("a".repeat(40)), now: T0 };
  for (const verb of ["record", "check"]) {
    const r = call([verb, "--root", dir, "--plan", plan, "--data", "data"], base);
    assert.equal(r.code, 3);
    assert.equal(r.err, "tree-state: --data must be an absolute path\n");
    assert.equal(r.out, "");
    assert.equal(call([verb, "--root", dir, "--plan", plan, "--data", ""], base).code, 3);
    assert.equal(call([verb, "--root", dir, "--plan", plan], base).code, 3, "no --data");
    assert.equal(call([verb, "--root", dir, "--data", join(dir, "d")], base).code, 3, "no --plan");
    assert.equal(call([verb, "--plan", plan, "--data", join(dir, "d")], base).code, 3, "no --root");
    assert.equal(call([verb, "--root", dir, "--root", dir, "--plan", plan, "--data", join(dir, "d")], base).code, 3, "a repeated option");
  }
  assert.equal(existsSync(join(dir, "data")), false);
  assert.equal(call(["id", "--root", dir, "--data", join(dir, "d")], base).code, 3, "id takes only --root");
  assert.equal(call([], base).code, 3);
  assert.match(call(["bogus"], base).err, /^usage: tree-state\.mjs id --root/);
  assert.equal(call(["id", "--root"], base).code, 3);
  assert.equal(call(["id", "extra"], base).code, 3);
});
test("nothing from the plan, the files or the data folder reaches the output: only fixed phrases, ids and dates", () => {
  const dir = scratch();
  const data = join(dir, "data-SECRETNAME");
  const marker = "SECRET-MARKER-7731";
  const plan = writePlan(dir, PLAN.replace("`npm run verify`", `\`npm run verify --token ${marker}\``));
  const io = { git: fakeGit("a".repeat(40)), now: T0, nodeVersion: "v24.1.0" };
  const all = [];
  all.push(call(["check", "--root", dir, "--plan", plan, "--data", data], io));
  all.push(call(["record", "--root", dir, "--plan", plan, "--data", data], io));
  all.push(call(["check", "--root", dir, "--plan", plan, "--data", data], io));
  all.push(call(["check", "--root", dir, "--plan", plan, "--data", data], { ...io, nodeVersion: "v25.0.0" }));
  all.push(call(["record", "--root", dir, "--plan", join(dir, "missing-SECRETNAME.md"), "--data", data], io));
  all.push(call(["record", "--root", dir, "--plan", plan, "--data", `relative-${marker}`], io));
  all.push(call(["record", "--root", join(dir, `missing-${marker}`), "--plan", plan, "--data", data]));
  all.push(call([`--${marker}`]));
  for (const r of all) {
    const text = r.out + r.err;
    assert.ok(!text.includes(marker) && !text.includes("SECRETNAME") && !text.includes(dir) && !text.includes("npm run"), text);
  }
  assert.ok(!readFileSync(join(data, RECORD_FILE), "utf8").includes(marker), "the record holds a hash, not the commands");
  assert.ok(!readFileSync(join(data, RECORD_FILE), "utf8").includes("npm run"));
});

// ---------- phase 7p fix round 1 ----------
test("verifyText skips fenced lines, refuses two Full verify bullets or none with a command, and hashes the parallel groups and the fast set it points at", () => {
  // (a) Lines inside a fenced code block are not bullets.
  const fenced = "## Commands\n```\n- **Full verify**: `fake`\n```\n- **Full verify**: `real`\n";
  assert.equal(verifyText(fenced), "- **Full verify**: `real`");
  assert.equal(verifyText("## Commands\n```\n- **Full verify**: `fake`\n```\n- Deploy: `x`\n"), null, "only a fenced bullet is no bullet");
  // (b) Two Full verify bullets, or one with no command in backticks, give null.
  assert.equal(verifyText("## Commands\n- **Full verify**: `a`\n- **Full verify**: `b`\n"), null);
  assert.equal(verifyText("## Commands\n- Baseline: `a`\n- Baseline: `b`\n"), null);
  assert.equal(verifyText("## Commands\n- **Full verify**: everything we have\n"), null);
  assert.equal(verifyText("## Commands\n- **Full verify** (baseline and final compare):\n- **Fast verify**: `lint`\n"), null, "a label with no command text");
  assert.equal(verifyText("## Commands\n- **Full verify**:\n  - `npm run verify`\n"), "- **Full verify**:\n  - `npm run verify`", "commands on the lines under it count");
  // (c) The Parallel groups bullet is part of the text; two of them give null.
  const withGroups = `${PLAN.replace("- Deploy", "- **Parallel groups** (optional): group 1 = `a`; group 2 = `b`\n- Deploy")}`;
  assert.equal(verifyText(withGroups), "- **Full verify** (baseline and final compare): `npm run verify`\n- **Parallel groups** (optional): group 1 = `a`; group 2 = `b`");
  assert.equal(verifyText(withGroups.replace("- Deploy", "- **Parallel groups**: `c`\n- Deploy")), null);
  assert.notEqual(verifyText(withGroups), verifyText(withGroups.replace("group 2 = `b`", "group 2 = `c`")));
  // (d) "same as fast" pulls in the Fast verify text.
  const same = PLAN.replace("`npm run verify`", "same as fast");
  assert.equal(verifyText(same), "- **Full verify** (baseline and final compare): same as fast\n- **Fast verify** (after the build and each fix round): `npm run lint`");
  assert.notEqual(verifyText(same), verifyText(same.replace("`npm run lint`", "`npm run lint && npm test`")));
  assert.equal(verifyText(same.replace(/- \*\*Fast verify\*\*[^\n]*\n/, "")), null, "no Fast verify bullet to point at");
  assert.equal(verifyText(same.replace("`npm run lint`", "lint it")), null, "no command anywhere");
  assert.equal(verifyText(PLAN.replace("- Deploy", "- **Fast verify**: `again`\n- Deploy").replace("`npm run verify`", "same as the fast set")), null, "two Fast verify bullets");
});

test("check exits 2 for a plan with two Full verify bullets or none with a command, and a changed parallel group or fast set changes the hash", () => {
  const dir = scratch();
  const data = join(dir, "data");
  const base = { git: fakeGit("a".repeat(40)), now: T0, nodeVersion: "v24.1.0" };
  const run = (verb, text, name) => call([verb, "--root", dir, "--plan", writePlan(dir, text, name), "--data", data], base);
  assert.equal(run("check", "## Commands\n- **Full verify**: `a`\n- **Full verify**: `b`\n", "two.md").code, 2);
  assert.equal(run("record", "## Commands\n- **Full verify**: nothing\n", "none.md").code, 2);
  assert.equal(existsSync(join(data, RECORD_FILE)), false);
  const groups = (g) => PLAN.replace("- Deploy", `- **Parallel groups**: ${g}\n- Deploy`);
  assert.equal(run("record", groups("group 1 = `a`"), "g1.md").code, 0);
  assert.equal(run("check", groups("group 1 = `a`"), "g1b.md").code, 0);
  assert.equal(run("check", groups("group 1 = `a`; group 2 = `b`"), "g2.md").out, "no reuse: commands differ\n");
  const same = PLAN.replace("`npm run verify`", "same as fast");
  assert.equal(run("record", same, "s1.md").code, 0);
  assert.equal(run("check", same, "s1b.md").code, 0);
  assert.equal(run("check", same.replace("`npm run lint`", "`npm run lint && npm test`"), "s2.md").out, "no reuse: commands differ\n");
});

test("check --since accepts only a record made at or after it, and a bad --since is a usage error", () => {
  const dir = scratch();
  const data = join(dir, "data");
  const plan = writePlan(dir, PLAN);
  const io = { git: fakeGit("a".repeat(40)), now: T0, nodeVersion: "v24.1.0" };
  const check = (...more) => call(["check", "--root", dir, "--plan", plan, "--data", data, ...more], io);
  assert.equal(call(["record", "--root", dir, "--plan", plan, "--data", data], io).code, 0);
  assert.equal(check().code, 0, "no --since: any fresh record");
  assert.equal(check("--since", "2026-10-28T09:59:59Z").code, 0, "recorded after it");
  assert.equal(check("--since", "2026-10-28T10:00:00Z").code, 0, "recorded at it");
  assert.equal(check("--since", "2026-10-28T10:00:00.000Z").code, 0, "a fraction is allowed");
  const late = check("--since", "2026-10-28T10:00:01Z");
  assert.deepEqual([late.code, late.out], [1, "no reuse: recorded before --since\n"]);
  // The record is also rejected for its other conditions first, with their own phrases.
  assert.equal(call(["check", "--root", dir, "--plan", plan, "--data", data, "--since", "2026-10-28T09:00:00Z"], { ...io, nodeVersion: "v25.0.0" }).out, "no reuse: Node differs\n");
  for (const bad of ["2026-10-28", "2026-10-28T10:00:00", "2026-10-28T10:00:00+00:00", "2026-10-28 10:00:00Z", "2026-02-31T10:00:00Z", "2026-13-01T10:00:00Z", "2026-10-28T25:00:00Z", "yesterday", "", "1761645600000", "2026-10-28T10:00:00Zjunk"]) {
    const r = check("--since", bad);
    assert.equal(r.code, 3, JSON.stringify(bad));
    assert.equal(r.out, "");
    assert.equal(r.err, "tree-state: --since must be a UTC time like 2026-10-28T06:12:09Z\n", JSON.stringify(bad));
  }
  for (const verb of [["record"], ["id"]]) {
    const more = verb[0] === "id" ? ["--root", dir] : ["--root", dir, "--plan", plan, "--data", data];
    const r = call([...verb, ...more, "--since", "2026-10-28T06:12:09Z"], io);
    assert.equal(r.code, 3, verb[0]);
    assert.equal(r.err, "tree-state: unknown option or extra argument\n");
  }
});

test("id refuses a tree that holds a submodule or a nested repository (mode 160000)", () => {
  // The answer of git, stubbed: a gitlink entry among others.
  const root = scratch();
  const stub = (ls) => (all) => {
    const args = stripC(all);
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n\n";
    if (args[0] === "rev-parse") return "ok\n";
    if (args[0] === "ls-files") return ls;
    if (args.includes("write-tree")) return `${"a".repeat(40)}\n`;
    return "";
  };
  const phrase = "tree-state: the tree holds a submodule or a nested repository (mode 160000)\n";
  const temp = scratch();
  const NUL = String.fromCharCode(0);
  const entries = (...e) => e.join(NUL) + NUL;
  const bad = call(["id", "--root", root], { git: stub(entries(`100644 ${"b".repeat(40)} 0	a.txt`, `160000 ${"c".repeat(40)} 0	mod`)), tmpdir: temp });
  assert.deepEqual([bad.code, bad.out, bad.err], [3, "", phrase]);
  assert.deepEqual(readdirSync(temp), [], "the temp folder is gone");
  assert.equal(call(["id", "--root", root], { git: stub(entries(`100644 ${"b".repeat(40)} 0	a.txt`, `100755 ${"c".repeat(40)} 0	b.sh`)), tmpdir: temp }).code, 0);
  // A file whose name only looks like a gitlink entry is not one.
  assert.equal(call(["id", "--root", root], { git: stub(entries(`100644 ${"b".repeat(40)} 0	160000 x`)), tmpdir: temp }).code, 0);
  // Real git: a nested repository with a commit is added as a gitlink.
  const repo = makeRepo();
  const inner = join(repo, "inner");
  mkdirSync(inner);
  git(inner, "init", "-q");
  writeFileSync(join(inner, "f.txt"), "x\n");
  git(inner, "add", "-A");
  git(inner, "commit", "-q", "-m", "inner");
  const real = call(["id", "--root", repo], { tmpdir: temp });
  assert.deepEqual([real.code, real.out, real.err], [3, "", phrase]);
  assert.deepEqual(readdirSync(temp), []);
});

test("every git call runs with an empty hooks folder and fsmonitor off, and a post-index-change hook of the repository does not run during id", () => {
  // The calls, seen through the seam: each has the -c pairs, and the hooks folder exists and is empty while git runs.
  const root = scratch();
  const seen = [];
  const watcher = (all, o) => {
    const pairs = [];
    for (let i = 0; all[i] === "-c"; i += 2) pairs.push(all[i + 1]);
    const hooks = pairs.find((p) => p.startsWith("core.hooksPath="))?.slice("core.hooksPath=".length);
    seen.push({ verb: stripC(all)[0], pairs, hooks, empty: hooks && existsSync(hooks) ? readdirSync(hooks).length === 0 : null, cwd: o.cwd });
    return fakeGit("a".repeat(40))(all, o);
  };
  const temp = scratch();
  assert.equal(call(["id", "--root", root], { git: watcher, tmpdir: temp }).code, 0);
  assert.deepEqual(seen.map((s) => s.verb), ["rev-parse", "rev-parse", "read-tree", "add", "ls-files", "write-tree"]);
  for (const s of seen) {
    assert.ok(s.pairs.includes("core.fsmonitor=false"), s.verb);
    assert.ok(s.hooks && s.hooks.startsWith(temp.split("\\").join("/")), `${s.verb}: the hooks folder is inside the temp folder`);
    assert.equal(s.empty, true, `${s.verb}: the hooks folder exists and is empty during the call`);
  }
  assert.equal(new Set(seen.map((s) => s.hooks)).size, 1, "one hooks folder for the whole call");
  assert.deepEqual(readdirSync(temp), []);

  // A real hook. First prove the hook fires with a plain git add, and with the id flow when the hooksPath pair is removed (a mutation).
  const repo = makeRepo();
  const marker = join(scratch(), "hook-ran.txt").split("\\").join("/");
  const hookFile = join(repo, ".git", "hooks", "post-index-change");
  writeFileSync(hookFile, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  writeFileSync(join(repo, "a.txt"), "alpha one\n");
  git(repo, "add", "-A");
  assert.ok(existsSync(marker), "the hook fires on a plain git add (so the test below can fail)");
  unlinkSync(marker);
  const withoutHooksPath = (all, o) => {
    const rest = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i] === "-c" && String(all[i + 1]).startsWith("core.hooksPath=")) { i++; continue; }
      rest.push(all[i]);
    }
    return realGit(rest, o);
  };
  writeFileSync(join(repo, "a.txt"), "alpha two\n");
  idOfWith(repo, { git: withoutHooksPath });
  assert.ok(existsSync(marker), "mutation: without core.hooksPath the hook runs during the id flow");
  unlinkSync(marker);
  writeFileSync(join(repo, "a.txt"), "alpha three\n");
  idOfWith(repo);
  assert.equal(existsSync(marker), false, "with core.hooksPath the hook does not run");
});

test("id refuses a temp folder that is the repository or inside it, and makes nothing there", () => {
  const root = scratch();
  const inside = join(root, "tmp");
  mkdirSync(inside);
  const phrase = "tree-state: the temp folder is inside the repository\n";
  for (const temp of [root, inside, join(root, "tmp", "deeper")]) {
    const r = call(["id", "--root", root], { git: fakeGit("a".repeat(40)), tmpdir: temp });
    assert.deepEqual([r.code, r.out, r.err], [3, "", phrase], temp);
  }
  assert.deepEqual(readdirSync(inside), [], "nothing was made inside the repository");
  assert.deepEqual(readdirSync(root), ["tmp"]);
  for (const verb of ["record", "check"]) {
    const plan = writePlan(scratch(), PLAN);
    const r = call([verb, "--root", root, "--plan", plan, "--data", join(scratch(), "d")], { git: fakeGit("a".repeat(40)), tmpdir: inside });
    assert.equal(r.code, 3, verb);
    assert.equal(r.err, phrase);
  }
  // A folder next to it, or its parent, is fine.
  const sibling = scratch();
  assert.equal(call(["id", "--root", root], { git: fakeGit("a".repeat(40)), tmpdir: sibling }).code, 0);
});

test("record refuses a record file that exists but cannot be read, and ignores a stored record whose time is not strict ISO", () => {
  const dir = scratch();
  const data = join(dir, "data");
  const plan = writePlan(dir, PLAN);
  const io = { git: fakeGit("a".repeat(40)), now: T0, nodeVersion: "v24.1.0" };
  const file = join(data, RECORD_FILE);
  // A folder in place of the file: reading it fails with an error that is not "not found".
  mkdirSync(file, { recursive: true });
  const r = call(["record", "--root", dir, "--plan", plan, "--data", data], io);
  assert.deepEqual([r.code, r.out, r.err], [3, "", "tree-state: can't read the record file\n"]);
  assert.ok(existsSync(file) && readdirSync(file).length === 0, "nothing was written over it");
  assert.equal(readdirSync(data).length, 1, "no temp file left");
  assert.equal(call(["check", "--root", dir, "--plan", plan, "--data", data], io).out, "no reuse: no record\n", "check reads it as no record");
  // Not found is fine: record makes the file.
  const fresh = join(dir, "data2");
  assert.equal(call(["record", "--root", dir, "--plan", plan, "--data", fresh], io).code, 0);
  const saved = JSON.parse(readFileSync(join(fresh, RECORD_FILE), "utf8"));
  assert.match(saved.records[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // A stored record whose time is not a strict ISO time is ignored, even when Date can read it.
  const good = saved.records[0];
  for (const at of ["2026-10-28", "Oct 28 2026 10:00:00 UTC", "2026-10-28T10:00:00", "2026-10-28T10:00:00+00:00", 1761645600000, null, "2026-02-31T10:00:00.000Z"]) {
    writeFileSync(join(fresh, RECORD_FILE), JSON.stringify({ v: 1, records: [{ ...good, at }] }));
    assert.equal(call(["check", "--root", dir, "--plan", plan, "--data", fresh], io).out, "no reuse: no record\n", JSON.stringify(at));
  }
  // The same record with a strict time works, and record keeps a valid record and drops the bad one.
  writeFileSync(join(fresh, RECORD_FILE), JSON.stringify({ v: 1, records: [{ ...good, at: "2026-10-28T09:00:00Z" }, { ...good, tree: "b".repeat(40), at: "yesterday" }] }));
  assert.equal(call(["check", "--root", dir, "--plan", plan, "--data", fresh], io).code, 0);
  assert.equal(call(["record", "--root", dir, "--plan", plan, "--data", fresh], { ...io, git: fakeGit("c".repeat(40)) }).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(fresh, RECORD_FILE), "utf8")).records.map((x) => x.tree[0]), ["a", "c"]);
});

test("GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE in the parent environment, pointing at another repository, do not change the id", () => {
  const repo = sharedRepo();
  const other = makeRepo();
  writeFileSync(join(other, "only-in-other.txt"), "other\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "other");
  const own = git(repo, "rev-parse", "HEAD^{tree}");
  assert.notEqual(git(other, "rev-parse", "HEAD^{tree}"), own);
  const keep = {};
  const names = { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, ".git", "index") };
  for (const k of Object.keys(names)) keep[k] = process.env[k];
  try {
    Object.assign(process.env, names);
    assert.equal(idOfWith(repo, { git: cachedGit() }), own, "the root's own tree, not the other repository's");
    assert.equal(idOfWith(repo), own);
  } finally {
    for (const k of Object.keys(names)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
  }
});

// ---------- phase 7p fix round 2 ----------
test("verifyText and commandsSection follow the standard Markdown fence rules: a longer fence is not closed by a shorter one, the closing fence must use the same character, an unclosed fence gives null", () => {
  // A four-backtick fence holds a three-backtick line and a decoy bullet: the decoy is not read, the real bullet is.
  const nested = "## Commands\n````\n```\n- **Full verify**: `decoy`\n````\n- **Full verify**: `real`\n";
  assert.equal(verifyText(nested), "- **Full verify**: `real`");
  // A tilde fence is not closed by backticks: everything after it is inside, and the fence never closes.
  assert.equal(verifyText("## Commands\n~~~\n- **Full verify**: `real`\n```\n- **Full verify**: `decoy`"), null, "the decoy is not hashed");
  // Closed by the same character it opened with, the next bullet is read again.
  assert.equal(verifyText("## Commands\n~~~\n- **Full verify**: `a`\n```\n~~~\n- **Full verify**: `real`\n"), "- **Full verify**: `real`");
  // A closing fence may be longer, and may be followed by spaces, but not by other text.
  assert.equal(verifyText("## Commands\n```\n- **Full verify**: `a`\n`````   \n- **Full verify**: `real`\n"), "- **Full verify**: `real`");
  assert.equal(verifyText("## Commands\n```\n- **Full verify**: `a`\n``` js\n- **Full verify**: `b`\n"), null, "a fence line with text is not a closing fence");
  // An unclosed fence after a bullet makes the whole text unusable.
  assert.equal(verifyText("## Commands\n- Baseline: `old`\n```\n- other\n"), null);
  // A fence line indented four spaces is not a fence (the rest is read as before).
  assert.equal(verifyText("## Commands\n    ```\n- **Full verify**: `real`\n"), "- **Full verify**: `real`");
  // A backtick fence's info text can't hold a backtick, so that line opens nothing.
  assert.equal(verifyText("## Commands\n``` `x`\n- **Full verify**: `real`\n"), "- **Full verify**: `real`");
  // A normal plan is read as before.
  assert.equal(verifyText(PLAN), "- **Full verify** (baseline and final compare): `npm run verify`");
  assert.equal(verifyText(`${PLAN.replace("- Deploy", "```\n- **Full verify**: `fenced`\n```\n- Deploy")}`), "- **Full verify** (baseline and final compare): `npm run verify`");
  // commandsSection: a heading inside a four-backtick fence that holds a three-backtick line does not end the section.
  const section = commandsSection("# P\n## Commands\n````\n```\n## Risks\n````\n- x\n\n## Risks\n- y\n");
  assert.ok(section.includes("## Risks\n````\n- x") && !section.includes("- y"), section);
  // commandsSection: an unclosed fence runs to the end, so a later heading is not an end.
  assert.ok(commandsSection("## Commands\n~~~\n- a\n## Risks\n- y\n").includes("- y"));
  // A lookalike heading inside a fence is not counted (and one hidden in a longer fence by a shorter closer is).
  assert.equal(commandsSection("## Risks\n````\n```\n### Commands\n````\n## Commands\n- ok\n"), "## Commands\n- ok");
});

test("verifyText: an empty or blank backtick span is not a command, and any mention of fast points at the one Fast verify bullet", () => {
  for (const blank of ["` `", "``", "`   `", "`\t`", "` ` ` `"]) {
    assert.equal(verifyText(`## Commands\n- **Full verify**: ${blank}\n`), null, JSON.stringify(blank));
  }
  assert.equal(verifyText("## Commands\n- **Full verify**: ` ` and `real`\n"), "- **Full verify**: ` ` and `real`", "a real span beside a blank one counts");
  const fast = "- **Fast verify** (each round): `npm run lint`\n";
  const pointing = `## Commands\n- **Full verify**: identical to the \`Fast verify\` set\n${fast}`;
  assert.equal(verifyText(pointing), `- **Full verify**: identical to the \`Fast verify\` set\n- **Fast verify** (each round): \`npm run lint\``);
  assert.notEqual(verifyText(pointing), verifyText(pointing.replace("npm run lint", "npm run lint && npm test")), "a changed Fast verify changes the hash");
  assert.equal(verifyText(`## Commands\n- **Full verify**: like FAST, plus the build\n${fast}`).includes("npm run lint"), true, "any case, any wording");
  assert.equal(verifyText("## Commands\n- **Full verify**: identical to the `Fast verify` set\n"), null, "no Fast verify bullet");
  assert.equal(verifyText(`${pointing}${fast}`), null, "two Fast verify bullets");
  assert.equal(verifyText(`## Commands\n- **Full verify**: the Fast verify set, no more\n- **Fast verify**: same as full\n`), null, "no command anywhere");
  // The word fast only inside a longer word does not point at the Fast set.
  assert.equal(verifyText("## Commands\n- **Full verify**: `npm run verify` (faster than before)\n"), "- **Full verify**: `npm run verify` (faster than before)");
});

// ---------- phase 7p fix round 3 ----------
test("verifyText fails closed on a fence opener indented 1 to 3 spaces, and on a comment or an HTML block that starts a line outside a code block", () => {
  // A fence opened inside a list item: readers disagree about where it ends, so there is no text to hash.
  assert.equal(verifyText("## Commands\n- note:\n  ```\n- **Full verify**: `real`\n```\n- **Full verify**: `decoy`\n"), null);
  for (const indent of [" ", "  ", "   "]) {
    assert.equal(verifyText(`## Commands\n${indent}\`\`\`\n${indent}x\n${indent}\`\`\`\n- **Full verify**: \`real\`\n`), null, `an opener indented ${indent.length}`);
    assert.equal(verifyText(`## Commands\n${indent}~~~\n- **Full verify**: \`real\`\n${indent}~~~\n`), null, `a tilde opener indented ${indent.length}`);
  }
  // A comment can hide a bullet from one reader and not from another.
  assert.equal(verifyText("## Commands\n<!--\n- **Full verify**: `hidden`\n-->"), null);
  assert.equal(verifyText("## Commands\n  <!-- indented up to 3 spaces still starts a comment block\n- **Full verify**: `hidden`\n-->"), null);
  // An HTML block hides lines from a reader that this one would read.
  assert.equal(verifyText("## Commands\n<div hidden>\n- **Full verify**: `hidden`\n</div>\n- Fast verify: `f`\n"), null);
  assert.equal(verifyText("## Commands\n</div>\n- **Full verify**: `real`\n"), null);
  assert.equal(verifyText("## Commands\n<DIV hidden>\n- **Full verify**: `hidden`\n</DIV>\n- Fast verify: `f`\n"), null, "an upper-case tag is a block too");
  assert.equal(verifyText("## Commands\n<Div>\n- **Full verify**: `real`\n"), null, "a mixed-case tag is a block too");
  assert.equal(verifyText("## Commands\n<?php\n- **Full verify**: `real`\n"), null);
  // The comment marker inside a command or in the middle of a line cannot hide a bullet (a bullet starts its own line), so a
  // plan like that keeps its hash. Plans that grep for a marker in their prod check are normal.
  assert.equal(verifyText("## Commands\n- **Full verify**: `real` <!-- note -->\n"), "- **Full verify**: `real` <!-- note -->");
  assert.equal(verifyText("## Commands\n- **Full verify**: `real`\n- Prod check: `grep -c -F \"<!-- x:start -->\" README.md`\n"), "- **Full verify**: `real`");
  assert.equal(verifyText("## Commands\n- **Full verify**: `real`\n- Deploy: `<!--`\n"), "- **Full verify**: `real`");
  // An inline tag in the middle of a line is not a block.
  assert.equal(verifyText("## Commands\n- **Full verify**: `real`, see <b>this</b>\n"), "- **Full verify**: `real`, see <b>this</b>");
  // A comment outside the Commands section does not matter, and a normal plan still works.
  assert.equal(verifyText("<!-- top -->\n# P\n## Commands\n- **Full verify**: `real`\n## Risks\n<!-- later -->\n"), "- **Full verify**: `real`");
  assert.equal(verifyText(PLAN), "- **Full verify** (baseline and final compare): `npm run verify`");
  assert.equal(verifyText("## Commands\n```\n- **Full verify**: `fenced`\n```\n- **Full verify**: `real`\n"), "- **Full verify**: `real`", "a fence at column 0 is still read");
  assert.equal(verifyText("## Commands\n    indented text with ``` in it\n- **Full verify**: `real`\n"), "- **Full verify**: `real`");
});

test("a tilde fence whose info string holds a backtick still opens a fence and wraps a decoy bullet", () => {
  assert.equal(verifyText("## Commands\n~~~ `info`\n- **Full verify**: `decoy`\n~~~\n- **Full verify**: `real`\n"), "- **Full verify**: `real`");
  assert.equal(verifyText("## Commands\n~~~ a`b\n- **Full verify**: `decoy`\n~~~\n- **Full verify**: `real`\n"), "- **Full verify**: `real`");
  // The same text with a backtick fence is not a fence, so the decoy is a bullet and there are two.
  assert.equal(verifyText("## Commands\n``` `info`\n- **Full verify**: `decoy`\n```\n- **Full verify**: `real`\n"), null);
  // commandsSection sees the same fence: a heading inside it does not end the section.
  assert.ok(commandsSection("## Commands\n~~~ `info`\n## Risks\n~~~\n- x\n").includes("- x"));
});
