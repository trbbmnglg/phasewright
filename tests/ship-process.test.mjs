// Run with: node --test tests/ship-process.test.mjs
// The one real-process smoke of plugins/phased-shipping/skills/run/scripts/ship.mjs: commands-hash.mjs records a preview and ship.mjs ships
// it as real processes, in a temp git repo with a local bare remote, through the real guard rules and the real bash (Git Bash on Windows).
// It is slow (node, git and bash start many times), so it is a file of its own. The in-process cases are in tests/ship.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./helpers/tree-state.mjs";
import { shipCase, git, planText, scratch, MESSAGE_REL } from "./helpers/ship.mjs";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "phased-shipping", "skills", "run", "scripts");
// The scripts' OS temp folder is a scratch folder (removed after the run), so no ship-* log folder is left in the real one.
const TEMP_DIR = scratch();
const node = (cwd, name, ...args) => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, name), ...args], { encoding: "utf8", env: { ...cleanEnv(), TMP: TEMP_DIR, TEMP: TEMP_DIR, TMPDIR: TEMP_DIR }, cwd, timeout: 300000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

test("the real scripts: preview, then ship (commit and push to a bare remote, checks pass), then a code change after a fresh preview exits 3 and runs nothing", () => {
  const c = shipCase([
    "branch: main",
    "step: git add -A -- feature.txt",
    "step: git commit -q -F '.plans/commits/zork-commit.txt'",
    "step: git push -q origin main",
    "check: test -z \"$(git status --short)\"",
    "check: test \"$(git rev-parse HEAD)\" = \"$(git ls-remote origin refs/heads/main | cut -f1)\"",
    "rollback: git revert --no-edit HEAD",
    "rollback: git push -q origin main",
  ]);
  writeFileSync(join(c.repo, "feature.txt"), "zork feature\n");
  const args = ["--plan", c.plan, "--root", c.repo, "--roadmap", c.roadmap, "--data", c.data];
  const record = () => node(c.repo, "commands-hash.mjs", c.plan, "--record", "previewed", "--data", c.data, "--root", c.repo, "--roadmap", c.roadmap);

  const rec = record();
  assert.equal(rec.status, 0, rec.out + rec.err);
  assert.match(rec.out, /^recorded previewed [0-9a-f]{12}\n## Commands\n/);
  const before = git(c.repo, "rev-parse", "HEAD");

  const shipped = node(c.repo, "ship.mjs", "run", ...args);
  assert.equal(shipped.status, 0, shipped.out + shipped.err);
  const head = git(c.repo, "rev-parse", "HEAD");
  assert.notEqual(head, before, "a commit was made");
  assert.equal(git(c.base, "--git-dir=remote.git", "rev-parse", "main"), head, "and pushed to the bare remote");
  assert.equal(git(c.repo, "log", "-1", "--format=%B"), readFileSync(join(c.repo, MESSAGE_REL), "utf8").trim(), "with the bound message file");
  assert.deepEqual(shipped.out.split("\n").filter((l) => /^(step|check|rollback) \d+ exit/.test(l)).map((l) => l.replace(/ seconds \d+$/, "")),
    ["step 1 exit 0", "step 2 exit 0", "step 3 exit 0", "check 1 exit 0", "check 2 exit 0"]);
  assert.match(shipped.out, new RegExp(`^shipped ${head}$`, "m"));
  assert.match(shipped.out, /^Commands hash: [0-9a-f]{12}$/m);
  assert.match(shipped.out, /^total seconds \d+$/m);
  assert.ok(shipped.out.includes(`log folder ${join(TEMP_DIR, "ship-")}`), "the log folder is in the temp folder the process was given");

  // A fresh preview, then a tracked file changes before the ship: refused, and the sentinel step never runs.
  writeFileSync(c.plan, planText(["branch: main", "step: echo zork > ../sentinel-ran", "check: true", "rollback: true"]));
  assert.equal(record().status, 0);
  writeFileSync(join(c.repo, "a.txt"), "changed after the preview\n");
  const refused = node(c.repo, "ship.mjs", "run", ...args);
  assert.equal(refused.status, 3, refused.out + refused.err);
  assert.match(refused.out, /the code changed since it was previewed/);
  assert.match(refused.out, /^ {2}a\.txt$/m);
  assert.ok(!existsSync(c.at("sentinel-ran")), "nothing ran");
  assert.equal(git(c.base, "--git-dir=remote.git", "rev-parse", "main"), head, "nothing was pushed");
});

// The plan template's own ship block, filled in with made-up names, run as written (fix round 3, M3): it ships, and a stray change stops it.
const TEMPLATE = readFileSync(join(SCRIPTS, "..", "..", "plan", "references", "templates.md"), "utf8").replace(/\r\n/g, "\n");
const templateBlock = () => {
  const start = TEMPLATE.indexOf("```ship\n") + "```ship\n".length;
  const fill = { "<branch>": "main", "<paths>": "zork.txt", "<commit message file>": MESSAGE_REL, "<deploy command>": "echo acmecorp-deploy",
    "<prod check command, exit 0 when it passes>": "test \"$(git rev-parse HEAD)\" = \"$(git ls-remote origin refs/heads/main | cut -f1)\"",
    "<cmd that restores the previous version>": "git revert --no-edit HEAD && git push -q origin main" };
  return TEMPLATE.slice(start, TEMPLATE.indexOf("\n```", start)).split("\n")
    .filter((l) => !l.startsWith("check: for i in")) // the CI watch: the template says to drop it when a push starts no CI
    .map((l) => Object.entries(fill).reduce((s, [k, v]) => s.split(k).join(v), l));
};

test("fix round 3 (7r), M3: the plan template's ship block, filled in, ships through the real scripts; a stray unstaged or untracked change stops it before the commit", () => {
  const lines = templateBlock();
  assert.ok(!lines.some((l) => /<[a-z][a-z ,]*>/.test(l)), `every placeholder is filled in:\n${lines.join("\n")}`);
  const run = (stray) => {
    const c = shipCase(lines);
    writeFileSync(join(c.repo, "zork.txt"), "zork feature\n");
    stray(c);
    const rec = node(c.repo, "commands-hash.mjs", c.plan, "--record", "previewed", "--data", c.data, "--root", c.repo, "--roadmap", c.roadmap);
    assert.equal(rec.status, 0, rec.out + rec.err);
    const before = git(c.repo, "rev-parse", "HEAD");
    const r = node(c.repo, "ship.mjs", "run", "--plan", c.plan, "--root", c.repo, "--roadmap", c.roadmap, "--data", c.data);
    return { c, r, before };
  };
  const ok = run(() => {});
  assert.equal(ok.r.status, 0, ok.r.out + ok.r.err);
  const head = git(ok.c.repo, "rev-parse", "HEAD");
  assert.notEqual(head, ok.before);
  assert.equal(git(ok.c.base, "--git-dir=remote.git", "rev-parse", "main"), head, "pushed");
  assert.match(git(ok.c.repo, "show", "--name-only", "--format=", "HEAD"), /^zork\.txt$/m);
  assert.match(ok.r.out, new RegExp(`^shipped ${head}$`, "m"));
  for (const [what, stray, failing] of [["a tracked file changed and not staged", (c) => writeFileSync(join(c.repo, "a.txt"), "stray change\n"), 2],
    ["an untracked file", (c) => writeFileSync(join(c.repo, "stray.txt"), "stray\n"), 3]]) {
    const bad = run(stray);
    assert.equal(bad.r.status, 1, `${what}: ${bad.r.out}${bad.r.err}`);
    assert.match(bad.r.out, new RegExp(`^step ${failing} exit 1 seconds \\d+$`, "m"), what);
    assert.equal(git(bad.c.repo, "rev-parse", "HEAD"), bad.before, `${what}: nothing was committed`);
    assert.equal(git(bad.c.base, "--git-dir=remote.git", "rev-parse", "main"), bad.before, `${what}: nothing was pushed`);
  }
});

test("fix round 4 (7r), M3: a ref of origin changed by something else while a check fails stops the ship, and the rollback lines still run (the real scripts)", () => {
  const c = shipCase(["branch: main", "step: echo zork-step", "check: bash ../zork-ci.sh", "rollback: echo zork-rollback > ../rollback-ran"]);
  // What a CI job or a bot would do on the remote while the check runs: a branch of its own appears; the check then fails.
  writeFileSync(c.at("zork-ci.sh"), "git --git-dir=../remote.git update-ref refs/heads/zork-bot main\nexit 1\n");
  const rec = node(c.repo, "commands-hash.mjs", c.plan, "--record", "previewed", "--data", c.data, "--root", c.repo, "--roadmap", c.roadmap);
  assert.equal(rec.status, 0, rec.out + rec.err);
  const r = node(c.repo, "ship.mjs", "run", "--plan", c.plan, "--root", c.repo, "--roadmap", c.roadmap, "--data", c.data);
  // Since fix round 5 the change is reported and the failed check rolls back as any failed check does (exit 4).
  assert.equal(r.status, 4, r.out + r.err);
  assert.match(r.out, /after check 1 origin's refs changed, and no strict push step can explain it \(reported; the check failed, so the rollback lines run\)/);
  assert.match(r.out, /^ {2}refs\/heads\/zork-bot$/m);
  assert.match(r.out, /^rollback 1 exit 0 seconds \d+$/m);
  assert.ok(existsSync(c.at("rollback-ran")), "the rollback line ran");
});

test("fix round 5 (7r), A: a passing check while someone tags origin stops the run (exit 3) with no rollback, and origin's main is still HEAD (the real scripts)", () => {
  const c = shipCase(["branch: main", "step: echo zork-step", "check: bash ../zork-tag.sh", "rollback: echo zork-rollback > ../rollback-ran"]);
  // What a release bot would do on the remote while the check runs; the check itself passes.
  writeFileSync(c.at("zork-tag.sh"), "git --git-dir=../remote.git tag v9.9.9 main\n");
  const rec = node(c.repo, "commands-hash.mjs", c.plan, "--record", "previewed", "--data", c.data, "--root", c.repo, "--roadmap", c.roadmap);
  assert.equal(rec.status, 0, rec.out + rec.err);
  const head = git(c.repo, "rev-parse", "HEAD");
  const r = node(c.repo, "ship.mjs", "run", "--plan", c.plan, "--root", c.repo, "--roadmap", c.roadmap, "--data", c.data);
  assert.equal(r.status, 3, r.out + r.err);
  assert.match(r.out, /the check passed, so nothing was rolled back; origin's main is HEAD/);
  assert.match(r.out, /^ {2}refs\/tags\/v9\.9\.9$/m);
  assert.ok(!existsSync(c.at("rollback-ran")), "the rollback line did not run");
  assert.equal(git(c.base, "--git-dir=remote.git", "rev-parse", "main"), head);
});

test("fix round 5 (7r), B: a background job behind shell options (bash --norc -c '... &') is refused before anything runs: exit 2, and origin is unchanged later (the real scripts)", () => {
  const c = shipCase(["branch: main", "step: echo zork-step", "check: bash --norc -c 'bash ../late.sh &'", "rollback: true"]);
  writeFileSync(c.at("late.sh"), "sleep 1\ngit push -q origin HEAD:refs/heads/evil\n");
  const rec = node(c.repo, "commands-hash.mjs", c.plan, "--record", "previewed", "--data", c.data, "--root", c.repo, "--roadmap", c.roadmap);
  assert.equal(rec.status, 0, rec.out + rec.err);
  const before = git(c.base, "--git-dir=remote.git", "for-each-ref", "--format=%(refname) %(objectname)");
  const r = node(c.repo, "ship.mjs", "run", "--plan", c.plan, "--root", c.repo, "--roadmap", c.roadmap, "--data", c.data);
  assert.equal(r.status, 2, r.out + r.err);
  assert.match(r.out, /nothing ran: the ship block is invalid: .*background/);
  spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 2500)"]); // longer than the job's own wait
  assert.equal(git(c.base, "--git-dir=remote.git", "for-each-ref", "--format=%(refname) %(objectname)"), before);
});

test("fix round 6 (7r), B1: a background job behind a quoted -c or an escaped & is refused before anything runs (exit 2), and no tag appears later (the real scripts)", () => {
  for (const check of ["bash '-c' 'bash ../bgpush.sh &'", "bash -c 'bash ../bgpush.sh '\\&"]) {
    const c = shipCase(["branch: main", "step: echo zork-step", `check: ${check}`, "rollback: true"]);
    writeFileSync(c.at("bgpush.sh"), "sleep 4\ngit push -q origin HEAD:refs/tags/zork-late\n");
    const rec = node(c.repo, "commands-hash.mjs", c.plan, "--record", "previewed", "--data", c.data, "--root", c.repo, "--roadmap", c.roadmap);
    assert.equal(rec.status, 0, rec.out + rec.err);
    const before = git(c.base, "--git-dir=remote.git", "for-each-ref", "--format=%(refname) %(objectname)");
    const r = node(c.repo, "ship.mjs", "run", "--plan", c.plan, "--root", c.repo, "--roadmap", c.roadmap, "--data", c.data);
    assert.equal(r.status, 2, `${check}: ${r.out}${r.err}`);
    assert.match(r.out, /nothing ran: the ship block is invalid/, check);
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]); // longer than the job's own wait
    assert.equal(git(c.base, "--git-dir=remote.git", "for-each-ref", "--format=%(refname) %(objectname)"), before, check);
  }
});
