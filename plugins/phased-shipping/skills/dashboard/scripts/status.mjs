#!/usr/bin/env node
// The dashboard's status files: an on/off setting, a local list of projects and one small file per running phase.
// It uses node built-ins only, sends nothing anywhere and reads or writes nothing outside the data folder, except that
// it resolves the project folder it is told about (a real path, nothing is read inside it) and looks, by name only, for a
// .git entry in that folder and its parents (see "The project" below).
//
//   node status.mjs state      --data <dir>
//   node status.mjs enable     --data <dir>
//   node status.mjs disable    --data <dir>
//   node status.mjs asked      --data <dir>
//   node status.mjs register   --data <dir> --root <project> [--label <l>]... [--roadmap <relative path>]...
//   node status.mjs unregister --data <dir> <id>
//   node status.mjs list       --data <dir> [--paths]
//   node status.mjs set        --data <dir> --root <project> --phase <id> --step <step> --state <state> [--name <title>] [--label <l>]...
//   node status.mjs clear      --data <dir> --root <project> --phase <id>
//
// Off by default. The dashboard is on only after `enable` (the owner's yes). While it is off or was never turned on,
// `set`, `clear` and the automatic registration done by `set` are a silent no-op: exit 0, one line, nothing written.
// Only `enable`, `disable`, `asked` and `unregister` write while it is off. An explicit `register` while it is off exits
// 1 and says to run `enable` first. `unregister <id>` only removes an entry from the list, so it works while off.
// --data must be an absolute path (an empty or relative one is a usage error, exit 2, nothing read or written).
//
// Files, all in the data folder (created on first write; the folder and each file must be a real folder or a
// regular file, never a link, and a hard-linked file is refused; anything else fails closed and writes nothing):
//   dashboard.json            { v, enabled, asked, warnMin, idleMin }
//   projects.json             { v, projects: [{ id, path, name, labels, roadmaps, added }] }, at most 100 projects.
//                             The only place an absolute path is ever written, and it is printed only by `list --paths`.
//   sessions/<id>-<tag>+<phase>.json  (<id>-u<tag>+<phase>.json for an unlisted folder)  { v, project, roadmap?, unlisted?, phase, phase_name, step, state, step_started, updated, trail? }, at most 16 KB.
//                             roadmap is the path of the roadmap file the run was started for, relative to the project root
//                             (the folder the run passes, plus PHASES.md); <tag> is the first 6 hex digits of the SHA-256 of that
//                             path, in lower case only where the file system does not tell letter case apart (Windows and macOS by
//                             default; seam io.caseInsensitive). Two roadmaps of one repository so keep one file each for the same
//                             phase id. A folder whose roadmap path is not usable has no roadmap field; its file carries unlisted: true, its name has a
//                             literal u before the 6 hex digits (<id>-u<tag>+<phase>.json) and its tag is of a fixed text and the folder's path from the
//                             project root, so two such folders do not share a file and no unlisted name is ever the name of a listed roadmap's file.
//                             A file from before (sessions/<id>-<phase>.json, no roadmap field) is read by the collector and never written, taken over or
//                             removed by `set` or `clear`: a `set` or `clear` only ever reads, writes or removes its own file. It ages out as Idle and is then
//                             archived like any session.
//                             trail is optional: [{ step, state, at }], the last 40 changes of step or state, appended only
//                             when `set` changes the step or the state (a first call writes none, a repeated call only moves
//                             `updated`, a call after `done` starts it again). The dashboard page draws loops from it.
// The project: --root is the folder that holds PHASES.md. The project is the repository around it: the nearest folder (the
// folder itself first, then each parent, at most 40 folders) that has a .git entry, a folder or a file (checked by name,
// never opened, read or followed). The climb stops at the user's home folder and at the filesystem root; a .git there is
// ignored. On a system with user ids (process.getuid; seam io.getuid) a .git that is not owned by the current user is not
// trusted: the climb stops there and the folder itself is the project. With no repository the project is the folder itself,
// as before. A repository root that is the data folder, is inside it or holds it is not used (the folder itself is). When the
// folder is not the project root (it was found by climbing) and holds a PHASES.md, its path from the project root is added
// to the project's roadmaps; the project root's own PHASES.md is not added then. A --root whose path from the project root
// has a .git, node_modules or .roadmap-backups folder in it is refused (exit 1, nothing written). When a roadmap is not added
// (more than 5 folders deep, a folder name with a character that is not allowed, or 10 roadmaps already) one more line says why,
// in fixed words and never with the path. A --roadmap is relative to the project root.
// <id> is the first 12 hex digits of the SHA-256 of the project's real path (lower-cased on Windows). A session file
// name is built only from that id, the 6 hex digits of the tag, a "+" and a phase id that matches [A-Za-z0-9._-]{1,40} and is
// not only dots, lower-cased (so 7a and 7A are one file everywhere): no other text reaches a path. The "+" cannot occur in a
// phase id, so a new name never reads as the older <id>-<phase>.json of another phase. A folder whose roadmap path is not
// usable (see roadmapOf) is unlisted: it gets its own tag, the marker and the u in its name, never the older name.
// A stored roadmap that is not a usable path is left out when projects.json is read (the file is not changed unless the
// command writes it anyway); only a new --roadmap value must be usable.
// Text fields are cleaned (control, bidirectional, zero-width, tag and other format characters become spaces, one
// line, at most 200 characters; labels and names 80). Every write is a temp file in the same folder, flushed, then a
// rename (retried a few times on Windows). A failure leaves the old file whole.
//
// The page: when `set`, `clear` or `unregister` worked while the dashboard is on, the command line then rebuilds <data>/dashboard.html in
// the same process with page.mjs, the script next to this one (run(), one fixed import; the builder is given the data
// folder and nothing else). A page that cannot be built prints one line, `page not rebuilt (<reason>)` (an error code or a
// short fixed phrase, never a path), and the exit code stays 0. While the dashboard is off nothing is built, and `disable`
// leaves the page as it was last written.
//
// main(argv, io) is the test seam (it never builds the page; run(argv, io) is main plus the page and takes io.buildPage
// as the seam for the builder): io.out, io.err, io.now (epoch ms), io.rename (replaces the rename step),
// io.homedir (the home folder the climb stops at), io.caseInsensitive (whether a roadmap path is lower-cased for its tag; default from the platform), io.getuid and io.lstat (the current user id and the lstat of a .git entry),
// io.maxSessionBytes, io.fd = { open, fstat, read, close } (every file of ours is opened and read through these, once
// and checked on the open descriptor; each is optional). Nothing in the command line, the environment or a file can reach it.

import { lstatSync, realpathSync, statSync, mkdirSync, openSync, fstatSync, readSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, constants as fsConstants } from "node:fs";
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
// Windows and macOS (by default) do not tell Docs and docs apart; elsewhere the letter case of a name matters (seam: io.caseInsensitive).
const CASE_INSENSITIVE = WIN || process.platform === "darwin";
const FILE_MODE = WIN ? undefined : 0o600;
const DIR_MODE = WIN ? undefined : 0o700;
const MAX_PROJECTS = 100;
const MAX_LABELS = 20;
const MAX_ROADMAPS = 10;
const MAX_CLIMB = 40;
const MAX_ROADMAP_FOLDERS = 5;
const NEVER_LISTED = new Set([".git", "node_modules", ".roadmap-backups"]);
const MAX_SESSION_BYTES = 16 * 1024;
const MAX_TRAIL = 40;
const MAX_CONFIG_BYTES = 4096;
const MAX_REGISTRY_BYTES = 512 * 1024;
const STEPS = ["baseline", "build", "compare", "review", "preview", "approve", "ship", "prod-check"];
const STATES = ["working", "waiting", "done"];
const PHASE_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,40}$/;
const ID_RE = /^[0-9a-f]{12}$/;
const DEFAULT_ROADMAP = "PHASES.md";
const UNLISTED_SENTINEL = "phased-shipping:unlisted-roadmap";
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const cp = (n) => String.fromCodePoint(n);
// Control, C1, line-separator, bidirectional, zero-width, tag and every other Unicode format (Cf) character.
const UNSAFE_TEXT = new RegExp(
  `[${cp(0)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x61c)}${cp(0x200b)}-${cp(0x200f)}${cp(0x2028)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2069)}${cp(0xfeff)}${cp(0xe0000)}-${cp(0xe007f)}\\p{Cf}]`,
  "gu",
);
// Plain one-line text, at most n characters.
const clean = (s, n = 200) => Array.from(String(s ?? "").slice(0, n * 4).replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim()).slice(0, n).join("");

const codeOf = (e) => e?.code ?? "error";
const keyOf = (p) => (WIN ? p.toLowerCase() : p);
const samePath = (a, b) => keyOf(a) === keyOf(b);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const idOf = (real) => createHash("sha256").update(WIN ? real.toLowerCase() : real).digest("hex").slice(0, 12);
const lstatOrNull = (path) => {
  try { return lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
};
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// A roadmap file path relative to the project: plain names joined by "/", no "..", ending .md. Null when it is not.
function roadmapOf(raw) {
  const s = String(raw ?? "").replace(/\\/g, "/");
  if (!/^[A-Za-z0-9._@+() -]{1,100}(\/[A-Za-z0-9._@+() -]{1,100}){0,5}$/.test(s)) return null;
  if (s.split("/").some((p) => /^\.+$/.test(p) || p !== p.trim() || p.endsWith(".") || NEVER_LISTED.has(p.toLowerCase()))) return null;
  return /\.md$/i.test(s) ? s : null;
}

// The letter case of a path counts only where the file system tells names apart by it.
const foldPath = (p, io = {}) => ((io.caseInsensitive ?? CASE_INSENSITIVE) ? p.toLowerCase() : p);
// The first 6 hex digits of the SHA-256 of a roadmap path (folded as above). A folder whose roadmap path is not usable has no
// such path: its tag is of a fixed sentinel and its folder path from the project root, so two such folders do not share one
// (its file name also has a u before the tag, which a listed roadmap's file name never has).
const roadmapTag = (roadmap, io = {}) => createHash("sha256").update(foldPath(roadmap, io)).digest("hex").slice(0, 6);
const unlistedTag = (folder, io = {}) => createHash("sha256").update([UNLISTED_SENTINEL, foldPath(folder, io)].join(String.fromCodePoint(0))).digest("hex").slice(0, 6);

// ── Arguments ───────────────────────────────────────────────────────────────
const SPEC = {
  state: [["--data"], []],
  enable: [["--data"], []],
  disable: [["--data"], []],
  asked: [["--data"], []],
  register: [["--data", "--root", "--label", "--roadmap"], []],
  unregister: [["--data"], []],
  list: [["--data"], ["--paths"]],
  set: [["--data", "--root", "--phase", "--step", "--state", "--name", "--label"], []],
  clear: [["--data", "--root", "--phase"], []],
};
const REPEATABLE = new Set(["--label", "--roadmap"]);
const USAGE = [
  "usage: status.mjs state|enable|disable|asked --data <dir>",
  "       status.mjs register --data <dir> --root <project> [--label <l>]... [--roadmap <relative path>]...",
  "       status.mjs unregister --data <dir> <id>",
  "       status.mjs list --data <dir> [--paths]",
  `       status.mjs set --data <dir> --root <project> --phase <id> --step <${STEPS.join("|")}> --state <${STATES.join("|")}> [--name <title>] [--label <l>]...`,
  "       status.mjs clear --data <dir> --root <project> --phase <id>",
];

function parseArgs(argv, bool, value) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    let inline;
    const eq = a.indexOf("=");
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    if (bool.includes(a)) {
      if (inline !== undefined) return { error: `${a} takes no value` };
      opts[a] = true;
    } else if (value.includes(a)) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      (opts[a] ??= []).push(v);
    } else return { error: `unknown option ${a}` };
  }
  return { pos, opts };
}

// ── The data folder ─────────────────────────────────────────────────────────
// Returns { exists } or { fail }. The folder must be a real folder (not a link or junction) that resolves to itself.
function inspectDir(dir) {
  try {
    const st = lstatOrNull(dir);
    if (!st) return { exists: false };
    if (st.isSymbolicLink()) return { fail: `${basename(dir)} is a link, not a real folder` };
    if (!st.isDirectory()) return { fail: `${basename(dir)} is not a real folder` };
    if (!samePath(realpathSync.native(dir), join(realpathSync.native(dirname(dir)), basename(dir)))) return { fail: `${basename(dir)} is a link, not a real folder` };
    return { exists: true };
  } catch (e) {
    return { fail: `${basename(dir)}: ${codeOf(e)}` };
  }
}

// Makes the folder when it is absent (one level, or the whole chain for the data folder), then checks it again.
function ensureDir(dir, recursive) {
  let info = inspectDir(dir);
  if (info.fail || info.exists) return info;
  try { mkdirSync(dir, { recursive, mode: DIR_MODE }); } catch (e) { if (codeOf(e) !== "EEXIST") return { fail: `${basename(dir)}: ${codeOf(e)}` }; }
  info = inspectDir(dir);
  if (!info.fail && !info.exists) return { fail: `${basename(dir)} could not be created` };
  return info;
}

// Opens a file once, checks the open descriptor (a regular file with one name, at most `cap` bytes) and reads at most
// cap + 1 bytes from that descriptor, so the file that was checked is the file that was read. The descriptor is always
// closed. Returns { bytes }, { why: "type" | "links" | "size" } or { code } (the error code of a failed open or read).
// Every open, fstat, read and close goes through io.fd (each member optional) so a test can stand in for them.
function readOpenFile(path, cap, io) {
  const fdio = io.fd ?? {};
  const open = fdio.open ?? openSync;
  const fstat = fdio.fstat ?? fstatSync;
  const readBytes = fdio.read ?? readSync;
  const close = fdio.close ?? closeSync;
  let fd;
  try { fd = open(path, OPEN_FLAGS); } catch (e) { return { code: codeOf(e) }; }
  try {
    const st = fstat(fd);
    if (!st.isFile()) return { why: "type" };
    if (st.nlink > 1) return { why: "links" };
    if (st.size > cap) return { why: "size" };
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readBytes(fd, buf, n, buf.length - n, null);
      if (!got) break;
      n += got;
    }
    if (n > cap) return { why: "size" };
    return { bytes: buf.subarray(0, n) };
  } catch (e) {
    return { code: codeOf(e) };
  } finally {
    try { close(fd); } catch { /* already closed */ }
  }
}

// Reads a small JSON file of ours. Returns { value } (undefined when absent) or { fail, hard }; hard is true when the
// path is not a regular file (never overwritten), false when only the content is bad.
function readOwn(dir, name, limit, io) {
  const path = join(dir, name);
  let st;
  try { st = lstatOrNull(path); } catch (e) { return { fail: `${name}: ${codeOf(e)}`, hard: true }; }
  if (!st) return { value: undefined };
  const notRegular = `${name} is not a regular file (a link, a hard link or a folder)`;
  if (!st.isFile() || st.nlink > 1) return { fail: notRegular, hard: true };
  if (st.size > limit) return { fail: `${name} is too large`, hard: false };
  const got = readOpenFile(path, limit, io);
  if (got.code) return { fail: `${name}: ${got.code}`, hard: true };
  if (got.why) return got.why === "size" ? { fail: `${name} is too large`, hard: false } : { fail: notRegular, hard: true };
  try {
    return { value: JSON.parse(DECODER.decode(got.bytes)) };
  } catch (e) {
    return { fail: `${name} is not valid JSON`, hard: false };
  }
}

// ── Atomic writes ───────────────────────────────────────────────────────────
const RETRY_CODES = ["EPERM", "EACCES", "EBUSY"];
const RETRIES = 10;
const sleepMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Renames tmp over final. On Windows only, a rename refused for a moment (a scanner or indexer holding a file) is
// retried up to 10 times, waiting 10 ms, then 20 ms, up to 100 ms. Returns null or { code }.
function renameWithRetry(tmp, final, io) {
  const rename = io.rename ?? ((a, b) => renameSync(a, b));
  for (let attempt = 0; ; attempt++) {
    try { rename(tmp, final); return null; } catch (e) {
      if (!WIN || !RETRY_CODES.includes(e?.code) || attempt >= RETRIES) return { code: codeOf(e) };
    }
    sleepMs(Math.min(100, 10 * (attempt + 1)));
  }
}

// Writes the whole text into a temp file (flushed), then renames it to the final name. The final name must be
// absent or a regular file with one name (never a link or a folder). Returns null or an error text.
function writeAtomic(path, text, io) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  let fd;
  try {
    const st = lstatOrNull(path);
    if (st && (!st.isFile() || st.nlink > 1)) return "not a regular file";
    fd = openSync(tmp, "wx", FILE_MODE);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const moved = renameWithRetry(tmp, path, io);
    if (moved) { rmSync(tmp, { force: true }); return moved.code; }
    return null;
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { rmSync(tmp, { force: true }); } catch { /* the temp file holds only what the file would */ }
    return codeOf(e);
  }
}

// ── The three files ─────────────────────────────────────────────────────────
const DEFAULT_CONFIG = { v: 1, enabled: false, asked: null, warnMin: 90, idleMin: 180 };

function loadConfig(dir, io) {
  const got = readOwn(dir, "dashboard.json", MAX_CONFIG_BYTES, io);
  if (got.fail) return got;
  if (got.value === undefined) return { config: { ...DEFAULT_CONFIG } };
  const v = got.value;
  const minutes = (n) => Number.isInteger(n) && n >= 1 && n <= 100000;
  if (!isObj(v) || v.v !== 1 || typeof v.enabled !== "boolean" || !(v.asked === null || (typeof v.asked === "string" && v.asked.length <= 40)) || !minutes(v.warnMin) || !minutes(v.idleMin)) {
    return { fail: "dashboard.json is not as expected; fix or delete it" };
  }
  return { config: { v: 1, enabled: v.enabled, asked: v.asked === null ? null : clean(v.asked, 40), warnMin: v.warnMin, idleMin: v.idleMin }, exists: true };
}

function loadRegistry(dir, io) {
  const got = readOwn(dir, "projects.json", MAX_REGISTRY_BYTES, io);
  if (got.fail) return got;
  if (got.value === undefined) return { projects: [] };
  const bad = { fail: "projects.json is not as expected; fix or delete it" };
  const v = got.value;
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.projects) || v.projects.length > MAX_PROJECTS) return bad;
  const projects = [];
  for (const p of v.projects) {
    if (!isObj(p) || typeof p.id !== "string" || !ID_RE.test(p.id) || typeof p.path !== "string" || p.path.length > 1024 || typeof p.name !== "string" || typeof p.added !== "string") return bad;
    if (!Array.isArray(p.labels) || p.labels.length > MAX_LABELS || !p.labels.every((l) => typeof l === "string")) return bad;
    // A stored roadmap that is not a usable path (a file written by an earlier version) is left out of the list in memory; the
    // file is not changed unless the command is writing it anyway. Only a roadmap that is not even text fails the file.
    if (!Array.isArray(p.roadmaps) || p.roadmaps.length > MAX_ROADMAPS || !p.roadmaps.every((r) => typeof r === "string")) return bad;
    if (projects.some((q) => q.id === p.id)) return bad;
    // Entries that become the same path once cleaned (docs\PHASES.md and docs/PHASES.md; on Windows also another letter case) are one: the first stays.
    const seen = new Set();
    const roadmaps = p.roadmaps.map(roadmapOf).filter((r) => { if (r === null || seen.has(foldPath(r, io))) return false; seen.add(foldPath(r, io)); return true; });
    projects.push({ id: p.id, path: p.path, name: clean(p.name, 80), labels: p.labels.map((l) => clean(l, 80)).filter(Boolean), roadmaps, added: clean(p.added, 40) });
  }
  return { projects };
}

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

function saveConfig(dir, config, io) {
  const made = ensureDir(dir, true);
  if (made.fail) return made.fail;
  const failed = writeAtomic(join(dir, "dashboard.json"), json(config), io);
  return failed ? `dashboard.json: ${failed}` : null;
}

function saveRegistry(dir, projects, io) {
  const made = ensureDir(dir, true);
  if (made.fail) return made.fail;
  const failed = writeAtomic(join(dir, "projects.json"), json({ v: 1, projects }), io);
  return failed ? `projects.json: ${failed}` : null;
}

// True when `inner` is `outer` or inside it (both real paths).
function insidePath(outer, inner) {
  const rel = relative(outer, inner);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

// The project root for a folder: the nearest folder (the folder itself first, then each parent, at most MAX_CLIMB folders)
// that has a .git entry, a folder or a file (lstat only: it is never opened, read or followed).
// The climb stops at the user's home folder and at the filesystem root, and a .git found at either is ignored.
// Where the system has user ids, a .git owned by someone else is not trusted: the climb
// stops there, so a repository above that belongs to another user never becomes the project. Where it has none (Windows),
// nothing is checked. io.getuid and io.lstat are the test seams. Returns null when there is none (or it is not trusted).
function repoRootOf(real, home, io = {}) {
  const lstat = io.lstat ?? lstatSync;
  const getuid = typeof io.getuid === "function" ? io.getuid : typeof process.getuid === "function" ? () => process.getuid() : null;
  let cur = real;
  for (let i = 0; i < MAX_CLIMB; i++) {
    if (home && samePath(cur, home)) return null;
    const up = dirname(cur);
    if (up === cur) return null;
    let found = null;
    try { found = lstat(join(cur, ".git")); } catch { found = null; }
    if (found) return getuid && found.uid !== getuid() ? null : cur;
    cur = up;
  }
  return null;
}

// The project for the folder the run names (the folder that holds PHASES.md). It is the repository around that folder, so a
// roadmap kept in a subfolder belongs to the repository's one project; with no repository it is the folder itself.
// A repository root that is the data folder, inside it, or that holds it is not used: the folder itself is.
function resolveProject(rootArg, dataDir, io = {}) {
  let given;
  try {
    given = realpathSync.native(resolve(rootArg));
    if (!statSync(given).isDirectory()) throw new Error("not a folder");
  } catch {
    return { fail: "cannot use --root: it is not an existing folder" };
  }
  let data = dataDir;
  try { data = realpathSync.native(dataDir); } catch { /* the data folder is not made yet */ }
  if (insidePath(data, given)) return { fail: "cannot use --root: it is the data folder or inside it" };
  let home = null;
  try { home = realpathSync.native(io.homedir ?? homedir()); } catch { /* no home folder to stop at */ }
  let real = repoRootOf(given, home, io) ?? given;
  if (insidePath(data, real) || insidePath(real, data)) real = given;
  const atRoot = samePath(real, given);
  const parts = atRoot ? [] : relative(real, given).split(sep);
  // A folder inside .git, node_modules or .roadmap-backups is never a place a run is for.
  if (parts.some((s) => NEVER_LISTED.has(s.toLowerCase()))) return { fail: "cannot use --root: it is inside a .git, node_modules or .roadmap-backups folder of the project" };
  const sub = [];
  let skipped = null;
  // The roadmap this run is for: the PHASES.md of the folder it passes, as a path from the project root (null when that path is not usable).
  let roadmap = DEFAULT_ROADMAP;
  if (!atRoot) {
    roadmap = roadmapOf(`${parts.join("/")}/${DEFAULT_ROADMAP}`);
    let st = null;
    try { st = lstatOrNull(join(given, DEFAULT_ROADMAP)); } catch { /* not there */ }
    if (st && st.isFile()) {
      if (roadmap) sub.push(roadmap);
      else skipped = parts.length > MAX_ROADMAP_FOLDERS ? "deep" : "name";
    }
  }
  const tag = roadmap ? roadmapTag(roadmap, io) : unlistedTag(parts.join("/"), io);
  return { real, id: idOf(real), name: clean(basename(real), 80) || "project", found: sub, skipped, roadmap, tag, defaults: atRoot ? [DEFAULT_ROADMAP] : [] };
}

// Adds labels and roadmaps to a list without duplicates, up to the caps. Returns true when the list changed.
function mergeInto(list, extra, cap, same = (a, b) => a === b) {
  let changed = false;
  for (const x of extra) {
    if (list.some((y) => same(x, y))) continue;
    if (list.length >= cap) break;
    list.push(x);
    changed = true;
  }
  return changed;
}

// Finds the project in the list or adds it. Returns { entry, changed } or { fail }.
function registerProject(projects, proj, labels, roadmaps, nowMs, io = {}) {
  let entry = projects.find((p) => p.id === proj.id);
  let changed = false;
  if (!entry) {
    if (projects.length >= MAX_PROJECTS) return { fail: `the project list is full (${MAX_PROJECTS}); unregister one first` };
    entry = { id: proj.id, path: proj.real, name: proj.name, labels: [], roadmaps: [...proj.defaults], added: new Date(nowMs).toISOString() };
    projects.push(entry);
    changed = true;
  }
  if (mergeInto(entry.labels, labels, MAX_LABELS)) changed = true;
  if (mergeInto(entry.roadmaps, roadmaps, MAX_ROADMAPS, (a, b) => foldPath(a, io) === foldPath(b, io))) changed = true;
  // A roadmap that is not in the list after the merge was left out because the list is full.
  const full = roadmaps.some((r) => !entry.roadmaps.some((y) => foldPath(y, io) === foldPath(r, io)));
  return { entry, changed, full };
}

// The one extra line that says why a roadmap was not added: fixed words, never a path.
function whyNotAdded(proj, res) {
  if (proj.skipped === "deep") return `roadmap not listed: its folder is more than ${MAX_ROADMAP_FOLDERS} folders below the project root`;
  if (proj.skipped === "name") return "roadmap not listed: a folder name has a character that is not allowed (letters, digits and . _ @ + ( ) - and space only)";
  if (res.full) return `roadmap not listed: the project already lists ${MAX_ROADMAPS} roadmaps`;
  return null;
}

// ── Commands ────────────────────────────────────────────────────────────────
const fail = (err, msg) => { err(msg); return 1; };
const OFF_NOTE = "dashboard is off; nothing written";

function stateCommand(config, out) {
  out(`dashboard: ${config.enabled ? "on" : "off"}`);
  out(config.asked ? `asked: yes (${config.asked})` : "asked: no");
  out(config.enabled ? "status files are written at each step of a run" : "turn it on with: dashboard enable");
  return 0;
}

function switchCommand(dir, cmd, config, io, out, err) {
  const next = { ...config, asked: config.asked ?? isoDate(io.nowMs) };
  if (cmd === "enable") next.enabled = true;
  if (cmd === "disable") next.enabled = false;
  const failed = saveConfig(dir, next, io);
  if (failed) return fail(err, `${failed}; nothing was changed`);
  out(cmd === "asked" ? `recorded: the question was asked; the dashboard stays ${next.enabled ? "on" : "off"}` : `dashboard is ${next.enabled ? "on" : "off"}`);
  return 0;
}

function registerCommand(dir, opts, config, io, out, err) {
  if (!config.enabled) return fail(err, "dashboard is off: run `enable` first. Nothing was written");
  const labels = (opts["--label"] ?? []).map((l) => clean(l, 80));
  if (labels.some((l) => !l)) { for (const l of USAGE) err(l); err("a label cannot be empty"); return 2; }
  const roadmaps = (opts["--roadmap"] ?? []).map(roadmapOf);
  if (roadmaps.some((r) => r === null)) { err("a --roadmap must be a relative path of plain names ending .md, without .."); return 2; }
  const proj = resolveProject(opts["--root"][0], dir, io);
  if (proj.fail) return fail(err, proj.fail);
  const reg = loadRegistry(dir, io);
  if (reg.fail) return fail(err, `${reg.fail}; nothing was changed`);
  const res = registerProject(reg.projects, proj, labels, [...proj.found, ...roadmaps], io.nowMs, io);
  if (res.fail) return fail(err, res.fail);
  if (res.changed) {
    const failed = saveRegistry(dir, reg.projects, io);
    if (failed) return fail(err, `${failed}; nothing was changed`);
  }
  out(`${res.changed ? "registered" : "already listed"}: ${res.entry.name} (id ${res.entry.id})`);
  const why = whyNotAdded(proj, res);
  if (why) out(why);
  return 0;
}

function unregisterCommand(dir, id, config, io, out, err) {
  if (!ID_RE.test(id)) { err("an id is 12 lower-case hex digits, as `list` prints it"); return 2; }
  const reg = loadRegistry(dir, io);
  if (reg.fail) return fail(err, `${reg.fail}; nothing was changed`);
  const at = reg.projects.findIndex((p) => p.id === id);
  if (at < 0) return fail(err, "no project with that id; nothing was changed");
  const [gone] = reg.projects.splice(at, 1);
  const failed = saveRegistry(dir, reg.projects, io);
  if (failed) return fail(err, `${failed}; nothing was changed`);
  out(`removed: ${gone.name} (id ${gone.id}); its session files, if any, stay until they are cleared`);
  if (config.enabled) io.after.changed = true;
  return 0;
}

function listCommand(dir, opts, io, out, err) {
  const reg = loadRegistry(dir, io);
  if (reg.fail) return fail(err, reg.fail);
  out(`projects: ${reg.projects.length}`);
  for (const p of reg.projects) {
    out(`  ${p.id}  ${p.name}  labels: ${p.labels.join(", ") || "(none)"}  roadmaps: ${p.roadmaps.join(", ")}  added ${p.added.slice(0, 10)}`);
    if (opts["--paths"]) out(`    path: ${clean(p.path, 1024)}`);
  }
  return 0;
}

// The session file of a phase in one roadmap: <id>-<tag>+<phase in lower case>.json, and for a folder whose roadmap path is not
// usable (unlisted) <id>-u<tag>+<phase in lower case>.json: the u is in the name, so an unlisted file never has the name of a listed
// roadmap's file, whatever the tags. The "+" cannot occur in a phase id, so a new name never reads as the older
// <id>-<phase>.json of some other phase. That older name is read by the collector and is never written, taken over or removed here.
const sessionName = (id, phase, tag, unlisted = false) => `${id}-${unlisted ? "u" : ""}${tag}+${phase.toLowerCase()}.json`;

// The valid entries of a session file's trail ({ step, state, at }), newest MAX_TRAIL at most. Nothing else is kept.
function trailOf(v) {
  if (!isObj(v) || !Array.isArray(v.trail)) return [];
  const ok = (e) => isObj(e) && STEPS.includes(e.step) && STATES.includes(e.state) && Number.isInteger(e.at) && e.at >= 0 && e.at <= 8.64e15;
  return v.trail.filter(ok).map((e) => ({ step: e.step, state: e.state, at: e.at })).slice(-MAX_TRAIL);
}

// The trail after a `set`. A first call writes none (the session's own step, state and step_started say it all). A call
// that changes the step or the state appends one entry; a repeated call changes nothing in it. A session that was
// done starts a new run, so its trail starts again.
function nextTrail(old, step, state, nowMs) {
  if (!old || old.state === "done") return [];
  const kept = trailOf(old);
  if (old.step === step && old.state === state) return kept;
  const first = STEPS.includes(old.step) && STATES.includes(old.state) && Number.isInteger(old.step_started) ? [{ step: old.step, state: old.state, at: old.step_started }] : [];
  return [...(kept.length ? kept : first), { step, state, at: nowMs }].slice(-MAX_TRAIL);
}

function setCommand(dir, opts, config, io, out, err) {
  const phase = opts["--phase"][0];
  const step = opts["--step"][0];
  const state = opts["--state"][0];
  if (!PHASE_RE.test(phase)) { err("--phase must be 1 to 40 characters from A-Z a-z 0-9 . _ -"); return 2; }
  if (!STEPS.includes(step)) { err(`--step must be one of ${STEPS.join(", ")}`); return 2; }
  if (!STATES.includes(state)) { err(`--state must be one of ${STATES.join(", ")}`); return 2; }
  const labels = (opts["--label"] ?? []).map((l) => clean(l, 80));
  if (labels.some((l) => !l)) { err("a label cannot be empty"); return 2; }
  if (!config.enabled) { out(OFF_NOTE); return 0; }
  const proj = resolveProject(opts["--root"][0], dir, io);
  if (proj.fail) return fail(err, proj.fail);
  const reg = loadRegistry(dir, io);
  if (reg.fail) return fail(err, `${reg.fail}; nothing was written`);
  const res = registerProject(reg.projects, proj, labels, proj.found, io.nowMs, io);
  if (res.fail) return fail(err, `${res.fail}; nothing was written`);
  const sdir = join(dir, "sessions");
  const made = ensureDir(sdir, false);
  if (made.fail) return fail(err, `${made.fail}; nothing was written`);
  // Only this run's own file is read, written or removed (an older <id>-<phase>.json is never touched).
  const file = sessionName(proj.id, phase, proj.tag, !proj.roadmap);
  const prev = readOwn(sdir, file, MAX_SESSION_BYTES, io);
  if (prev.fail && prev.hard) return fail(err, `${prev.fail}; nothing was written`);
  const old = prev.value !== undefined && !prev.fail && isObj(prev.value) ? prev.value : null;
  const sameStep = old && old.step === step && Number.isFinite(old.step_started);
  const name = opts["--name"] ? clean(opts["--name"][0], 200) : typeof old?.phase_name === "string" ? clean(old.phase_name, 200) : "";
  const session = { v: 1, project: proj.id, ...(proj.roadmap ? { roadmap: proj.roadmap } : { unlisted: true }), phase, phase_name: name, step, state, step_started: sameStep ? old.step_started : io.nowMs, updated: io.nowMs };
  let trail = nextTrail(old, step, state, io.nowMs);
  const limit = io.maxSessionBytes ?? MAX_SESSION_BYTES;
  let text = json(trail.length ? { ...session, trail } : session);
  // Over the cap: the oldest trail entries go first (the newest one always stays); the file is refused only when it
  // is still too large without them.
  while (Buffer.byteLength(text) > limit && trail.length > 1) {
    trail = trail.slice(1);
    text = json({ ...session, trail });
  }
  if (Buffer.byteLength(text) > limit) text = json(session);
  if (Buffer.byteLength(text) > limit) return fail(err, "the session file would be over 16 KB; nothing was written");
  if (res.changed) {
    const failed = saveRegistry(dir, reg.projects, io);
    if (failed) return fail(err, `${failed}; nothing was written`);
  }
  const failed = writeAtomic(join(sdir, file), text, io);
  if (failed) return fail(err, `session file: ${failed}; nothing was written`);
  out(`status set: phase ${phase} ${step} ${state}`);
  const why = whyNotAdded(proj, res);
  if (why) out(why);
  io.after.changed = true;
  return 0;
}

function clearCommand(dir, opts, config, io, out, err) {
  const phase = opts["--phase"][0];
  if (!PHASE_RE.test(phase)) { err("--phase must be 1 to 40 characters from A-Z a-z 0-9 . _ -"); return 2; }
  if (!config.enabled) { out(OFF_NOTE); return 0; }
  const proj = resolveProject(opts["--root"][0], dir, io);
  if (proj.fail) return fail(err, proj.fail);
  const sdir = join(dir, "sessions");
  const info = inspectDir(sdir);
  if (info.fail) return fail(err, `${info.fail}; nothing was changed`);
  if (!info.exists) { out("no status file to clear"); return 0; }
  // Only the file of this roadmap (or unlisted folder) and phase; a file from before (<id>-<phase>.json) is never removed here.
  const path = join(sdir, sessionName(proj.id, phase, proj.tag, !proj.roadmap));
  try {
    const st = lstatOrNull(path);
    if (!st) { out("no status file to clear"); return 0; }
    if (!st.isFile()) return fail(err, "the status file is not a regular file; nothing was changed");
    rmSync(path);
  } catch (e) {
    return fail(err, `status file: ${codeOf(e)}; nothing was changed`);
  }
  out(`status cleared: phase ${phase}`);
  io.after.changed = true;
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────────────
// A failure nobody planned for is reported by its code only (never a stack, which would carry absolute paths).
export function main(argv, io = {}) {
  try {
    return execute(argv, io, {});
  } catch (e) {
    (io.err ?? ((m) => console.error(m)))(`unexpected failure (${codeOf(e)}); nothing more was written`);
    return 1;
  }
}

// What the page builder's failure may say: an error code (EPERM) or a short lower-case phrase, nothing else.
const REASON_RE = /^(?:[A-Z][A-Z0-9_]{1,24}|[a-z][a-z ]{2,40})$/;

// The page is built in the same process by the script next to this one. The one import below is fixed (a file in this
// folder); the builder is given the data folder and nothing else, and writes only <data>/dashboard.html there.
async function buildThePage(dir, ctx) {
  const mod = await import("./page.mjs");
  return mod.buildPage(dir, { now: ctx.nowMs, rename: ctx.rename });
}

// run is main plus the page: after a `set`, `clear` or `unregister` that worked while the dashboard is on, <data>/dashboard.html is
// rebuilt. A page that could not be built prints one line, `page not rebuilt (<reason>)`, and never changes the exit
// code. While the dashboard is off, or when nothing changed, nothing is built. io.buildPage (async, (dir, io) =>
// { ok } or { ok: false, reason }) is the test seam for the builder. The command line runs this.
export async function run(argv, io = {}) {
  const after = {};
  let code;
  try {
    code = execute(argv, io, after);
  } catch (e) {
    (io.err ?? ((m) => console.error(m)))(`unexpected failure (${codeOf(e)}); nothing more was written`);
    return 1;
  }
  if (code !== 0 || !after.changed || !after.dir) return code;
  const out = io.out ?? ((s) => console.log(s));
  let reason = null;
  try {
    const built = await (io.buildPage ?? buildThePage)(after.dir, { nowMs: after.nowMs, rename: io.rename });
    if (!isObj(built) || built.ok !== true) reason = isObj(built) && typeof built.reason === "string" && REASON_RE.test(built.reason) ? built.reason : "error";
  } catch (e) {
    const c = codeOf(e);
    reason = typeof c === "string" && REASON_RE.test(c) ? c : "error";
  }
  // The line is the last thing done; a failure to print it (a closed pipe) still leaves the command's own code.
  if (reason) { try { out(`page not rebuilt (${reason})`); } catch { /* nothing more can be said */ } }
  return code;
}

function execute(argv, io, after) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const usage = (msg) => { if (msg) err(msg); for (const l of USAGE) err(l); return 2; };
  const [cmd, ...rest] = argv;
  if (!Object.hasOwn(SPEC, cmd ?? "")) return usage(cmd ? `unknown command ${cmd}` : "");
  const parsed = parseArgs(rest, SPEC[cmd][1], SPEC[cmd][0]);
  if (parsed.error) return usage(parsed.error);
  const { pos, opts } = parsed;
  for (const [flag, values] of Object.entries(opts)) if (values.length > 1 && !REPEATABLE.has(flag)) return usage(`${flag} can be given once`);
  if (!opts["--data"]) return usage("--data <dir> is required");
  if (!opts["--data"][0] || !isAbsolute(opts["--data"][0])) return usage("--data must be an absolute path");
  const need = { register: ["--root"], set: ["--root", "--phase", "--step", "--state"], clear: ["--root", "--phase"] }[cmd] ?? [];
  for (const flag of need) if (!opts[flag]) return usage(`${cmd} needs ${flag}`);
  if (cmd === "unregister") { if (pos.length !== 1) return usage("unregister needs one id"); } else if (pos.length) return usage(`${cmd} takes no positional argument`);
  const nowMs = Number.isFinite(io.now?.()) ? io.now() : Date.now();
  const ctx = { ...io, nowMs, after };

  const dir = resolve(opts["--data"][0]);
  after.dir = dir;
  after.nowMs = nowMs;
  const info = inspectDir(dir);
  if (info.fail) return fail(err, `cannot use the data folder (${info.fail}); nothing was written`);
  const loaded = info.exists ? loadConfig(dir, ctx) : { config: { ...DEFAULT_CONFIG } };
  if (loaded.fail) return fail(err, `${loaded.fail}; nothing was written`);
  const config = loaded.config;

  if (cmd === "state") return stateCommand(config, out);
  if (cmd === "enable" || cmd === "disable" || cmd === "asked") return switchCommand(dir, cmd, config, ctx, out, err);
  if (cmd === "register") return registerCommand(dir, opts, config, ctx, out, err);
  if (cmd === "unregister") return unregisterCommand(dir, pos[0], config, ctx, out, err);
  if (cmd === "list") return listCommand(dir, opts, ctx, out, err);
  if (cmd === "set") return setCommand(dir, opts, config, ctx, out, err);
  return clearCommand(dir, opts, config, ctx, out, err);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
