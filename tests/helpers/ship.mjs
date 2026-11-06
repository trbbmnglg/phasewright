// Shared helpers of tests/ship.test.mjs and tests/ship-process.test.mjs. Not a test file (no .test.mjs). Each case works in a copy
// of one template folder made once per test file under the OS temp folder: a git repo with a local bare remote (origin, as the relative
// path ../remote.git), a git-ignored .plans folder for the plan, the roadmap and a commit message file, and a data folder beside the repo.
// The temp folders are removed after each test file's run (tests/helpers/tree-state.mjs registers that). ship.mjs's log folders go into
// a scratch folder of their own (io.tmpdir, or TMP, TEMP and TMPDIR for a process), so none is left in the OS temp folder.
import { EventEmitter } from "node:events";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { scratch, git } from "./tree-state.mjs";
import { main as hashMain, commandsSection, hashOf } from "../../plugins/phased-shipping/skills/run/scripts/commands-hash.mjs";
import { defaultGit } from "../../plugins/phased-shipping/skills/run/scripts/tree-state.mjs";
import { main as shipMain } from "../../plugins/phased-shipping/skills/run/scripts/ship.mjs";

export { scratch, git } from "./tree-state.mjs";
export const PLAN_REL = ".plans/phases/phase-1-zork.md";
export const ROADMAP_REL = ".plans/PHASES.md";
export const MESSAGE_REL = ".plans/commits/zork-commit.txt";
// The strict commit step of most cases: exactly `git commit` with -q and the bound message file.
export const COMMIT = `git commit -q -F '${MESSAGE_REL}'`;

// A plan whose Commands section holds the ship block built from `lines` (an array of "key: value" lines, or null for no block).
export function planText(lines) {
  return [
    "# Phase 1: zork",
    "**Timestamps:** started 2026-01-01T00:00:00Z",
    "",
    "## Commands",
    "- **Full verify** (baseline and final compare): `npm run verify`",
    "- **Fast verify** (after the build and after each fix round): `npm run lint`",
    "- Deploy: `git push origin main`",
    "- Rollback (required before deploy): `git revert --no-edit HEAD`",
    ...(lines ? ["", "```ship", ...lines, "```"] : []),
    "",
    "## Risks",
    "- none",
    "",
  ].join("\n");
}

let template = null;
function makeTemplate() {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Tester"], ["user.email", "tester@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repo, "config", k, v);
  writeFileSync(join(repo, ".gitignore"), ".plans/\n");
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  git(base, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(repo, "remote", "add", "origin", "../remote.git");
  git(repo, "push", "-q", "origin", "main");
  mkdirSync(join(repo, ".plans", "phases"), { recursive: true });
  mkdirSync(join(repo, ".plans", "commits"), { recursive: true });
  writeFileSync(join(repo, ROADMAP_REL), "# Roadmap\n");
  writeFileSync(join(repo, MESSAGE_REL), "Ship zork\n\nShips the zork change.\n");
  return base;
}

// A fresh copy of the template: { base, repo, plan, roadmap, data, at(name) }. `lines` is the ship block (see planText).
export function shipCase(lines) {
  template ??= makeTemplate();
  const base = scratch();
  cpSync(template, base, { recursive: true });
  const repo = join(base, "repo");
  const plan = join(repo, PLAN_REL);
  writeFileSync(plan, planText(lines));
  return { base, repo, plan, roadmap: join(repo, ROADMAP_REL), data: join(base, "data"), at: (name) => join(base, name),
    ran: () => (existsSync(join(base, "ran.log")) ? readFileSync(join(base, "ran.log"), "utf8").split("\n").filter(Boolean) : []) };
}

const capture = () => {
  let out = "";
  let err = "";
  return { io: { out: (t) => { out += t; }, err: (t) => { err += t; } }, get out() { return out; }, get err() { return err; } };
};

// commands-hash --record previewed (with --root and --roadmap unless root is false), in this process. `extra` replaces --root and --roadmap.
export function recordPreview(c, { root = true, extra } = {}) {
  const k = capture();
  const args = [c.plan, "--record", "previewed", "--data", c.data, ...(extra ?? (root ? ["--root", c.repo, "--roadmap", c.roadmap] : []))];
  const status = hashMain(args, k.io);
  return { status, out: k.out, err: k.err };
}

// commands-hash --check previewed, in this process.
export function checkPreview(c, extra = ["--root", c.repo, "--roadmap", c.roadmap]) {
  const k = capture();
  const status = hashMain([c.plan, "--check", "previewed", "--data", c.data, ...extra], k.io);
  return { status, out: k.out, err: k.err };
}

// ship.mjs run, in this process. `io` adds to or replaces the seams; the log folder goes into a scratch folder unless io.tmpdir says otherwise.
export async function ship(c, io = {}, { roadmap = c.roadmap, root = c.repo, plan = c.plan } = {}) {
  let out = "";
  const status = await shipMain(["run", "--plan", plan, "--root", root, "--roadmap", roadmap, "--data", c.data], { out: (t) => { out += t; }, tmpdir: scratch(), ...io });
  return { status, out };
}

// A fake token, assembled at run time so this file holds no token-shaped text.
export const FAKE_TOKEN = ["gh", "p_", "A1b2C3d4E5".repeat(4)].join("");

// A link to a folder that needs no privilege: a junction on Windows, a symbolic link elsewhere. unlinkLink removes the link, never its target.
export const linkFolder = (target, path) => symlinkSync(target, path, "junction");
export const unlinkLink = (path) => { try { unlinkSync(path); } catch { rmdirSync(path); } };

// ---------- seams for the cases that are not about the binding (no git, no bash: both are slow on some machines) ----------

// A folder with a plan, for the cases that inject the binding: { base, repo, plan, roadmap, data, at(name), ran() }.
export function fakeCase(lines) {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(repo);
  const plan = join(base, "plan.md");
  writeFileSync(plan, planText(lines));
  return { base, repo, plan, roadmap: join(base, "PHASES.md"), data: join(base, "data"), at: (name) => join(base, name),
    ran: () => (existsSync(join(base, "ran.log")) ? readFileSync(join(base, "ran.log"), "utf8").split("\n").filter(Boolean) : []) };
}
// A bound commit message file in a fake case's repo folder, as the record holds it: { file, path (real, forward slashes), sha256 }.
export function fakeMessage(c, file = MESSAGE_REL, text = "Ship zork\n") {
  const path = join(c.repo, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return { file, path: realpathSync.native(path).replace(/\\/g, "/"), sha256: createHash("sha256").update(text).digest("hex") };
}
// A binding that passed, for the plan's current section (what checkPreviewed returns on a match): the bound real root is the repo folder,
// and the bound HEAD is `head` (fakeIo passes the one its git gives).
export const FAKE_HEAD = "c0ffee".padEnd(40, "0");
export const fakeBind = (c, messages = [], head = FAKE_HEAD) => () => {
  const section = commandsSection(readFileSync(c.plan, "utf8"));
  return { code: 0, out: "", err: "", section, hash: hashOf(section), saved: { text: section, messages, head }, root: realpathSync.native(c.repo).replace(/\\/g, "/"), allowed: [] };
};
// git as ship.mjs calls it: the branch (rev-parse and symbolic-ref), the staged diff, HEAD and origin's refs (ls-remote: the branch, the same
// commit as HEAD unless `remote` says otherwise),
// and the real --exec-path.
export const fakeGit = ({ branch = "main", diff = "", head = FAKE_HEAD, remote = head } = {}) => (args, opts) => {
  if (args[0] === "--exec-path") return defaultGit(args, opts); // where the real Git Bash is, for the cases that run it
  if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return `${branch}\n`;
  if (args[0] === "rev-parse") return `${head}\n`;
  if (args.includes("ls-remote")) return `${remote}\tHEAD\n${remote}\trefs/heads/${branch}\n`;
  if (args[0] === "symbolic-ref") return `refs/heads/${branch}\n`;
  if (args.includes("diff")) return diff;
  throw new Error(`unexpected git ${args.join(" ")}`);
};
// A spawn that runs nothing: it appends each command to <base>/ran.log (the sentinel) and exits with `false` -> 1, `exit N` -> N, anything
// else -> 0; `sleep N` never exits on its own. effects[command](options) runs first, for a command that must change something.
export function scriptedSpawn(c, effects = {}) {
  const calls = [];
  const kills = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 5000 + calls.length;
    const command = args[3];
    calls.push({ file, args, options, command, child });
    appendFileSync(c.at("ran.log"), `${command}\n`);
    effects[command]?.(options);
    const m = /^exit (\d+)$/.exec(command);
    const code = command === "false" ? 1 : m ? Number(m[1]) : 0;
    if (!/^sleep /.test(command)) setImmediate(() => child.emit("exit", code, null));
    return child;
  };
  const killTree = (child) => { kills.push(child.pid); setImmediate(() => child.emit("exit", null, "SIGKILL")); };
  return { spawn, killTree, calls, kills };
}
// The io for a case with the binding, git, bash and spawn all injected, and a scratch folder for the logs. The fake children have made-up
// pids, so nothing is reaped after a command (a case that wants it passes reap), and there is no wait before the last ref check (settleMs).
export const fakeIo = (c, { git = fakeGit(), messages, effects, bash = "/usr/zork/bin/bash", ...rest } = {}) => {
  const s = scriptedSpawn(c, effects);
  let head = FAKE_HEAD;
  try { head = String(git(["rev-parse", "HEAD"], {})).trim(); } catch { /* a git that can't say: the default */ }
  return { io: { bind: fakeBind(c, messages, head), git, findBash: () => bash, spawn: s.spawn, killTree: s.killTree, reap: () => {}, settleMs: 0, tmpdir: scratch(), ...rest }, spawned: s };
};
// The io for a case with the real binding and real git, and the scripted spawn (nothing runs but the effects).
export const realBindIo = (c, opts = {}) => {
  const { io, spawned } = fakeIo(c, opts);
  delete io.bind;
  if (!("git" in opts)) delete io.git;
  return { io, spawned };
};
