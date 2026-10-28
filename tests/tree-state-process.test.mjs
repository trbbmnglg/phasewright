// Run with: node --test tests/tree-state-process.test.mjs
// The one real-process smoke of plugins/phased-shipping/skills/run/scripts/tree-state.mjs: id, check and record run as a real process on a temp git repo.
// It is slow (every run starts node and git), so it is a file of its own and runs beside the other tree-state tests, not after them.
// This file is one of 2 (tree-state.test.mjs, tree-state-process.test.mjs) that came from one file; the helpers they share are in tests/helpers/tree-state.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync, symlinkSync, unlinkSync, rmdirSync } from "node:fs";
import { SCRIPT, made, scratch, cleanEnv, git, makeRepo, PLAN, writePlan } from "./helpers/tree-state.mjs";


// ---------- the real script, once ----------
test("the real script: id prints one line equal to HEAD^{tree}, and check with no record exits 1", () => {
  const repo = makeRepo();
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: cleanEnv(), cwd: repo });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const r = run("id", "--root", ".");
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, `tree ${git(repo, "rev-parse", "HEAD^{tree}")}\n`);
  assert.equal(r.err, "");
  const plan = writePlan(repo, PLAN);
  const data = join(scratch(), "d");
  const c = run("check", "--root", repo, "--plan", plan, "--data", data);
  assert.deepEqual([c.status, c.out], [1, "no reuse: no record\n"]);
  assert.equal(run("record", "--root", repo, "--plan", plan, "--data", data).status, 0);
  const again = run("check", "--root", repo, "--plan", plan, "--data", data);
  assert.equal(again.status, 0, "the plan file is untracked, so it is part of the tree it was recorded on");
  assert.match(again.out, /^reuse [0-9a-f]{40} \d{4}-\d{2}-\d{2}\n$/);
  assert.equal(run("record", "--root", repo, "--plan", plan, "--data", "relative").status, 3);
});

// ---------- a script reached through a symbolic link or a junction ----------
// node gives the script's real path to the module and the link's path to process.argv[1]. A script that compares the two without resolving
// the link runs nothing and prints nothing, and exits 0.
test("tree-state.mjs and commands-hash.mjs reached through a link to their folder still run and print", (t) => {
  const dir = scratch();
  const link = join(dir, "linked-run-scripts");
  try { symlinkSync(dirname(SCRIPT), link, "junction"); } catch (e) { t.skip(`this OS refused to make a link (${e.code})`); return; }
  try {
    const repo = makeRepo();
    const viaLink = (name, ...args) => {
      const r = spawnSync(process.execPath, [join(link, name), ...args], { encoding: "utf8", env: cleanEnv(), cwd: repo });
      return { status: r.status, out: r.stdout, err: r.stderr };
    };
    const id = viaLink("tree-state.mjs", "id", "--root", ".");
    assert.equal(id.status, 0, id.err);
    assert.equal(id.out, `tree ${git(repo, "rev-parse", "HEAD^{tree}")}\n`, "exit 0 with no output would be a silent no-op");
    const plan = writePlan(dir, PLAN, "plan.md");
    const data = join(dir, "data");
    const none = viaLink("tree-state.mjs", "check", "--root", repo, "--plan", plan, "--data", data);
    assert.deepEqual([none.status, none.out], [1, "no reuse: no record\n"]);
    const hash = viaLink("commands-hash.mjs", plan, "--short");
    assert.equal(hash.status, 0, hash.err);
    assert.match(hash.out, /^[0-9a-f]{12}\n$/, "the hash is printed");
  } finally {
    // Remove the link itself (never its target), then check the target is still there.
    try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* left for the after hook */ } }
    // A link that could not be removed must never be walked by the after hook that removes the temp folders.
    if (existsSync(link) && made.includes(dir)) made.splice(made.indexOf(dir), 1);
    assert.ok(existsSync(SCRIPT), "the real script folder was not touched");
  }
});
