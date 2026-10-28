// Run with: node --test tests/board-range.test.mjs
// Checks which commits board-sync reads for a pushed range, with real git in a throwaway repository:
// a normal range, a new branch, and a force-push or amended head whose "before" is gone or not an ancestor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitShas } from "../scripts/board-range.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IDENTITY = { GIT_AUTHOR_NAME: "tester", GIT_AUTHOR_EMAIL: "tester@example.org", GIT_COMMITTER_NAME: "tester", GIT_COMMITTER_EMAIL: "tester@example.org" };

const dirs = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// A repository with three commits, and a git function bound to it (the shape commitShas expects). Git is slow where this runs (every
// call starts a process), so the three commits are made once. The tests that only read use that repository; the ones that change history
// work in a clone of it (the same commit ids), which is one git call instead of ten.
const gitIn = (dir) => (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...IDENTITY }, stdio: ["ignore", "pipe", "ignore"] });
let base = null;
function baseRepo() {
  if (base) return base;
  const dir = mkdtempSync(join(tmpdir(), "board-range-"));
  dirs.push(dir);
  const git = gitIn(dir);
  git("init", "--quiet");
  const commit = (message) => {
    writeFileSync(join(dir, "file.txt"), `${message}\n${Math.random()}\n`);
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  return (base = { dir, git, commit, a: commit("first"), b: commit("second"), c: commit("third") });
}
const fixture = () => baseRepo();
function cloneFixture() {
  const origin = baseRepo();
  const dir = mkdtempSync(join(tmpdir(), "board-range-clone-"));
  dirs.push(dir);
  execFileSync("git", ["clone", "--quiet", origin.dir, dir], { env: { ...process.env, ...IDENTITY }, stdio: "ignore" });
  // The origin's commit helper writes into the shared repository, so a clone does not get it: a test that needs a commit in the clone makes
  // one with git, which is bound to the clone.
  const { commit, ...shared } = origin;
  return { ...shared, dir, git: gitIn(dir) };
}

test("a normal range returns its commits, oldest first", () => {
  const { git, a, b, c } = fixture();
  const logged = [];
  assert.deepEqual(commitShas(`${a}..${c}`, git, (m) => logged.push(m)), [b, c]);
  assert.deepEqual(logged, []);
});

test("an all-zero before returns only the latest commit", () => {
  const { git, c } = fixture();
  assert.deepEqual(commitShas(`${"0".repeat(40)}..${c}`, git), [c]);
});

test("after the last commit is rewritten, the old head to the new head returns only the new head", () => {
  const { git, c } = cloneFixture();
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "--amend", "-m", "third, reworded");
  const head = git("rev-parse", "HEAD").trim();
  assert.notEqual(head, c);
  const logged = [];
  assert.deepEqual(commitShas(`${c}..${head}`, git, (m) => logged.push(m)), [head]);
  assert.deepEqual(logged, ["force-push detected: reading the pushed head only"]);
});

test("a before that is not in the repository returns only the new head", () => {
  const { git, c } = fixture();
  const logged = [];
  assert.deepEqual(commitShas(`${"1234567".repeat(5)}..${c}`, git, (m) => logged.push(m)), [c]);
  assert.deepEqual(logged, ["force-push detected: reading the pushed head only"]);
});

test("a before that is not an ancestor of the new head returns only the new head", () => {
  const { git, a, c } = cloneFixture();
  git("checkout", "--quiet", "-b", "other", a);
  writeFileSync(join(git("rev-parse", "--show-toplevel").trim(), "other.txt"), "x\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", "side");
  const side = git("rev-parse", "HEAD").trim();
  assert.deepEqual(commitShas(`${c}..${side}`, git, () => {}), [side]);
});

test("a git failure that is not a missing or unrelated commit is not hidden", () => {
  const boom = (...args) => {
    if (args[0] === "merge-base") throw Object.assign(new Error("git failed"), { status: 128 });
    return "";
  };
  assert.throws(() => commitShas("abc..def", boom, () => {}), /git failed/);
});

test("board-sync.mjs imports commitShas from ./board-range.mjs and no longer builds the range itself", () => {
  const source = readFileSync(join(ROOT, "scripts", "board-sync.mjs"), "utf8");
  assert.match(source, /import \{ commitShas \} from "\.\/board-range\.mjs";/);
  assert.match(source, /commitShas\(range, git\)/);
  assert.doesNotMatch(source, /firstPush/);
});
