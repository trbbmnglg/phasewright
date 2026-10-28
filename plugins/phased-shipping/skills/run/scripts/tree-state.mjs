#!/usr/bin/env node
// Tree state: an id for the working tree's content, and a small record of green full verifies, so a run can
// skip a baseline that an earlier green full verify already proved on exactly the same tree.
//
//   node tree-state.mjs id     --root <repo>
//   node tree-state.mjs record --root <repo> --plan <plan> --data <absolute folder>
//   node tree-state.mjs check  --root <repo> --plan <plan> --data <absolute folder> [--since <ISO time>]
//
// id prints "tree <hex>" and nothing else: the id of the content of the working tree, leaving out what
// .gitignore ignores. It is the same id `git rev-parse HEAD^{tree}` gives right after everything was committed.
// It is made with a temporary index file in a fresh folder in the OS temp folder (GIT_INDEX_FILE: read-tree
// HEAD, add -A, write-tree). The folder is removed on every path, including a failure, except when the
// process is killed. The real index, HEAD, the refs and the working files are never changed by this script.
// Its side effects are that git writes the blob and tree objects into the repository's object store (no ref
// points at them and `git gc` removes them in time), and that a filter driver set in the repository's own
// configuration runs, as it does with `git add` (see "How git runs" below).
//
// What the id does NOT see: an edit to a file that .gitignore ignores, node_modules, the contents of a
// submodule, and a change of line endings alone when the repository converts them (core.autocrlf). `id`
// refuses a tree that holds a submodule or a nested repository (a gitlink, mode 160000), and refuses a
// temp folder that is inside the repository. A caller that changed any file outside what the id sees must
// not reuse a record.
//
// How git runs: every call is execFile with an argument array, never a shell, with the GIT_* variables of
// the parent removed and with core.hooksPath pointing at an empty folder and core.fsmonitor off, so a hook
// of the repository (such as post-index-change) cannot run. A filter driver set in the repository's own
// configuration (a clean filter, for example) still runs, exactly as with `git add`. Nothing is cached:
// every call re-reads and re-filters every tracked and untracked file, so the first call on a large repository
// takes as long as `git add -A` on a fresh index.
//
// record stores one GREEN full verify: {tree, commands (the SHA-256 of the plan's Full verify text, see
// verifyText), node (process.version), at (ISO time)} in <data>/verify-records.json, at most 50 records, the
// newest kept, written to a temp file and renamed over the old one. There is no option that records a red
// result: the run skill calls record only after a green full verify. A record file that exists but cannot
// be read is not overwritten (exit 3). Two runs that record at the same moment can lose one record, which
// only means one less reuse.
//
// check prints "reuse <tree> <date>" and exits 0 only when a record matches the tree, the commands and the
// Node version and is at most 7 days old (and, with --since, was recorded at or after that time). Otherwise it
// prints "no reuse: <reason>" and exits 1. The reasons are fixed phrases: no record, tree differs, commands
// differ, Node differs, too old, recorded before --since. Exit 0 with nothing printed is not reuse.
//
// Exit codes: 0 done (or check found a reusable record); 1 check found no reusable record; 2 the plan has
// no usable Full verify (or Baseline) text; 3 a usage, refusal or I/O error (a fixed phrase on stderr).
//
// It prints only fixed phrases, tree ids and dates, never a file's content, a path or text from the plan.
// It refuses a root that is not the top of a git work tree. --data must be an absolute path. It uses no
// network and no dependencies.
//
// main(argv, io) is the test seam. io.out and io.err take a string; io.now is the clock in epoch ms;
// io.nodeVersion replaces process.version; io.tmpdir is the folder for the temp index; io.git(args, { cwd, env })
// returns git's stdout and throws on a non-zero exit; io.rename replaces the rename step of a write.

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { commandsSection, fenceStep } from "./commands-hash.mjs";

export const MAX_RECORDS = 50;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RECORD_FILE = "verify-records.json";

const HEX_TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const NODE_VERSION = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SKEW_MS = 60 * 1000;

const USAGE = "usage: tree-state.mjs id --root <repo> | record --root <repo> --plan <plan> --data <absolute folder> | check --root <repo> --plan <plan> --data <absolute folder> [--since <ISO time>]";
const REASONS = { none: "no record", tree: "tree differs", commands: "commands differ", node: "Node differs", old: "too old", since: "recorded before --since" };

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// A strict UTC time such as 2026-10-28T06:12:09Z (a fraction of a second is allowed), and a real calendar date.
export function isIsoTime(s) {
  if (typeof s !== "string" || !ISO_TIME.test(s)) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19);
}

// The real path of `p` (links and short Windows names resolved). A path that does not exist yet is resolved
// through its nearest folder that does, so two spellings of the same place compare equal.
function realPath(p) {
  const abs = resolve(p);
  try { return realpathSync.native(abs); } catch {
    const up = dirname(abs);
    return up === abs ? abs : join(realPath(up), abs.slice(up.length).replace(/^[\\/]+/, ""));
  }
}

export function defaultGit(args, { cwd, env }) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

// A command is a backtick span with something other than white space in it (an empty or blank span is not one).
const COMMAND_SPAN = /`[^`\n]*[^`\s][^`\n]*`/;

// The text the commands hash is made of, or null when the plan has no usable Full verify. Everything is read
// from the "## Commands" section, from top-level bullets only, and never from inside a fenced code block
// (fences follow the standard Markdown fence rules, see fenceStep; a fence still open at the end of the section gives null).
// - The Full verify bullet (or, for an older plan, its single Baseline bullet) with the lines indented under it.
//   More than one such bullet, or one with no command in backticks, gives null.
// - When the Full verify bullet mentions "fast" in any wording, it points at the Fast set: the single Fast verify
//   bullet's text too (none or more than one gives null).
// - The Parallel groups bullet's text, when there is one (more than one gives null).
export function verifyText(planText) {
  let section;
  try { section = commandsSection(planText); } catch { return null; }
  if (section === null) return null;
  const lines = section.split("\n");
  // Which lines belong to a fenced block (its content and its opening and closing lines).
  const fenced = [];
  let open = null;
  for (const line of lines) {
    const before = open;
    open = fenceStep(open, line);
    // Fail closed where a reader could disagree about the fence: an opener indented 1 to 3 spaces (a fence inside a list
    // item). An opener at column 0 is a plain fence, so a line inside it is never less indented than its opener.
    if (before === null && open !== null && line.length - line.trimStart().length >= 1) return null;
    fenced.push(before !== null || open !== null);
  }
  if (open !== null) return null;
  // A comment or an HTML block can hide lines from a reader that this one would read, so a section with a line
  // outside a code block that starts one is not used. The text "<!--" inside a command or in the middle of a line is
  // fine: it cannot hide a bullet, because a bullet starts its own line.
  for (let i = 0; i < lines.length; i++) if (!fenced[i] && /^ {0,3}<[!?\/A-Za-z]/.test(lines[i])) return null;
  const find = (word) => {
    const re = new RegExp(`^[-*][ \\t]+(?:\\*\\*|__)?${word}\\b`, "i");
    const found = [];
    for (let i = 0; i < lines.length; i++) if (!fenced[i] && re.test(lines[i])) found.push(i);
    return found;
  };
  const textAt = (at) => {
    const out = [lines[at]];
    for (let j = at + 1; j < lines.length && (lines[j] === "" || /^[ \t]/.test(lines[j])); j++) out.push(lines[j]);
    while (out.length > 1 && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  };
  const fulls = find("full verify");
  let main;
  if (fulls.length > 1) return null;
  if (fulls.length === 1) main = fulls[0];
  else {
    const baselines = find("baseline");
    if (baselines.length !== 1) return null;
    main = baselines[0];
  }
  const parts = [textAt(main)];
  if (fulls.length === 1 && /\bfast\b/i.test(parts[0])) {
    const fasts = find("fast verify");
    if (fasts.length !== 1) return null;
    parts.push(textAt(fasts[0]));
  }
  if (!COMMAND_SPAN.test(parts.join("\n"))) return null;
  const groups = find("parallel groups");
  if (groups.length > 1) return null;
  if (groups.length === 1) parts.push(textAt(groups[0]));
  return parts.join("\n");
}

// Adds a record to a list ordered oldest first: an earlier record for the same tree, commands and Node is
// replaced, and only the newest `cap` records are kept.
export function addRecord(list, rec, cap = MAX_RECORDS) {
  const kept = list.filter((r) => !(r.tree === rec.tree && r.commands === rec.commands && r.node === rec.node));
  kept.push(rec);
  return kept.slice(-cap);
}

function validRecord(r) {
  return r !== null && typeof r === "object"
    && typeof r.tree === "string" && HEX_TREE.test(r.tree)
    && typeof r.commands === "string" && HEX_SHA256.test(r.commands)
    && typeof r.node === "string" && NODE_VERSION.test(r.node)
    && isIsoTime(r.at);
}

class Refusal extends Error {
  constructor(code, phrase) { super(phrase); this.code = code; }
}

// The records in the file, oldest first, or [] for a missing or malformed file. With `strict`, a file that
// exists but cannot be read (any error but "not found") is refused instead of being taken for an empty one.
function loadRecords(file, strict = false) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if (strict && e?.code !== "ENOENT") throw new Refusal(3, "tree-state: can't read the record file");
    return [];
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.records)) return [];
  return parsed.records.filter(validRecord).map((r) => ({ tree: r.tree, commands: r.commands, node: r.node, at: r.at }));
}

// On Windows a rename that a scanner or indexer refuses for a moment is retried up to 20 times, waiting 10 ms,
// then 20 ms, up to 100 ms. Any other error is thrown at once.
const RETRY_CODES = ["EPERM", "EACCES", "EBUSY"];
const sleepMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function renameWithRetry(from, to, io) {
  const rename = io.rename ?? renameSync;
  for (let attempt = 0; ; attempt++) {
    try { rename(from, to); return; } catch (e) {
      if (process.platform !== "win32" || !RETRY_CODES.includes(e?.code) || attempt >= 20) throw e;
    }
    sleepMs(Math.min(100, 10 * (attempt + 1)));
  }
}

function writeRecords(file, records, io) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify({ v: 1, records }, null, 2) + "\n");
    renameWithRetry(tmp, file, io);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    throw e;
  }
}

// The parent's environment without any GIT_* variable (GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE would point
// git at another repository), plus what this call adds.
function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith("GIT_")) delete env[k];
  return { ...env, GIT_TERMINAL_PROMPT: "0", ...extra };
}

// Whether `child` is the folder `parent` or lies inside it (real paths, letter case ignored on Windows).
function isInside(child, parent) {
  const fold = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const rel = relative(fold(realPath(parent)), fold(realPath(child)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// "tree <hex>" for the working tree at `root`. Throws a Refusal with a fixed phrase.
function treeId(root, io) {
  const git = io.git ?? defaultGit;
  const NOT_TOP = "tree-state: root is not the top of a git work tree";
  let isDir = false;
  try { isDir = statSync(root).isDirectory(); } catch { /* not there */ }
  if (!isDir) throw new Refusal(3, NOT_TOP);
  const temp = io.tmpdir ?? tmpdir();
  if (isInside(temp, root)) throw new Refusal(3, "tree-state: the temp folder is inside the repository");
  let dir;
  try {
    dir = mkdtempSync(join(temp, "tree-state-"));
    mkdirSync(join(dir, "hooks"));
  } catch {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS */ } }
    throw new Refusal(3, "tree-state: can't make a temp folder");
  }
  try {
    const hooks = join(dir, "hooks").split("\\").join("/");
    const run = (args, env) => git(["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", ...args], { cwd: root, env });
    let top;
    try { top = run(["rev-parse", "--is-inside-work-tree", "--show-prefix"], gitEnv()); } catch { throw new Refusal(3, NOT_TOP); }
    // At the top of a work tree git prints "true", then an empty prefix line.
    const topLines = String(top).split(/\r?\n/);
    if (topLines[0] !== "true" || topLines[1] !== "") throw new Refusal(3, NOT_TOP);
    try { run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], gitEnv()); } catch { throw new Refusal(3, "tree-state: the repository has no commit yet"); }
    const env = gitEnv({ GIT_INDEX_FILE: join(dir, "index") });
    try {
      run(["read-tree", "HEAD"], env);
      run(["add", "-A"], env);
      const staged = String(run(["ls-files", "--stage", "-z"], env));
      if (staged.split("\0").some((entry) => entry.startsWith("160000 "))) {
        throw new Refusal(3, "tree-state: the tree holds a submodule or a nested repository (mode 160000)");
      }
      const out = String(run(["write-tree"], env)).trim();
      if (!HEX_TREE.test(out)) throw new Refusal(3, "tree-state: git failed");
      return out;
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal(3, "tree-state: git failed");
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* left for the OS temp cleaner */ }
  }
}

const VALUE_OPTIONS = ["--root", "--plan", "--data", "--since"];
const ALLOWED = { id: ["--root"], record: ["--root", "--plan", "--data"], check: ["--root", "--plan", "--data", "--since"] };

function parse(argv) {
  const [mode, ...rest] = argv;
  if (!["id", "record", "check"].includes(mode)) return { error: USAGE };
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!VALUE_OPTIONS.includes(a)) return { error: "tree-state: unknown option or extra argument" };
    if (opts[a] !== undefined) return { error: "tree-state: an option is given twice" };
    if (i + 1 >= rest.length || String(rest[i + 1]).startsWith("--")) return { error: "tree-state: an option needs a value" };
    opts[a] = rest[++i];
  }
  if (Object.keys(opts).some((k) => !ALLOWED[mode].includes(k))) return { error: "tree-state: unknown option or extra argument" };
  if (!opts["--root"]) return { error: "tree-state: --root is needed" };
  if (mode !== "id") {
    if (!opts["--plan"]) return { error: "tree-state: --plan is needed" };
    if (!opts["--data"]) return { error: "tree-state: --data is needed" };
    if (!isAbsolute(opts["--data"])) return { error: "tree-state: --data must be an absolute path" };
  }
  if (opts["--since"] !== undefined && !isIsoTime(opts["--since"])) return { error: "tree-state: --since must be a UTC time like 2026-10-28T06:12:09Z" };
  return { mode, opts };
}

export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const parsed = parse(argv);
  if (parsed.error) { err(`${parsed.error}\n`); return 3; }
  const { mode, opts } = parsed;
  const root = resolve(opts["--root"]);
  try {
    if (mode === "id") {
      out(`tree ${treeId(root, io)}\n`);
      return 0;
    }
    let planText;
    try { planText = readFileSync(opts["--plan"], "utf8"); } catch { throw new Refusal(3, "tree-state: can't read the plan"); }
    const text = verifyText(planText);
    if (text === null) throw new Refusal(2, "tree-state: the plan has no usable Full verify or Baseline text");
    const commands = sha256(text);
    const tree = treeId(root, io);
    const node = io.nodeVersion ?? process.version;
    const now = io.now ?? Date.now();
    const file = join(resolve(opts["--data"]), RECORD_FILE);

    if (mode === "record") {
      const rec = { tree, commands, node, at: new Date(now).toISOString() };
      const existing = loadRecords(file, true);
      try { writeRecords(file, addRecord(existing, rec), io); } catch { throw new Refusal(3, "tree-state: can't write the record"); }
      out(`recorded ${tree}\n`);
      return 0;
    }

    // check: narrow the records one condition at a time, so the reason names the first one that failed.
    const reason = (key) => { out(`no reuse: ${REASONS[key]}\n`); return 1; };
    const all = loadRecords(file).filter((r) => Date.parse(r.at) <= now + SKEW_MS);
    if (!all.length) return reason("none");
    const sameTree = all.filter((r) => r.tree === tree);
    if (!sameTree.length) return reason("tree");
    const sameCommands = sameTree.filter((r) => r.commands === commands);
    if (!sameCommands.length) return reason("commands");
    const sameNode = sameCommands.filter((r) => r.node === node);
    if (!sameNode.length) return reason("node");
    const fresh = sameNode.filter((r) => now - Date.parse(r.at) <= MAX_AGE_MS);
    if (!fresh.length) return reason("old");
    const since = opts["--since"] === undefined ? undefined : Date.parse(opts["--since"]);
    const recent = since === undefined ? fresh : fresh.filter((r) => Date.parse(r.at) >= since);
    if (!recent.length) return reason("since");
    const newest = recent[recent.length - 1];
    out(`reuse ${tree} ${new Date(newest.at).toISOString().slice(0, 10)}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    err(`${e.message}\n`);
    return e.code;
  }
}

// Run as a script, not when a test imports it. Both paths are resolved through links (a symbolic link or a
// junction to this folder gives a different argv[1] than the module's own path), so the script still runs.
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
