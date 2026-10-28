#!/usr/bin/env node
// Merges everything the dashboard shows into one JSON: the roadmaps of the listed projects, the timestamps in their
// plan files, the phase history and the running sessions. It uses node built-ins and the roadmap reader next to it,
// sends nothing anywhere, and writes nothing except the --out file.
//
//   node collect.mjs --data <dir> [--out <file>] [--now <epoch ms>]
//
// --data must be an absolute path (an empty or relative one is a usage error, exit 2, nothing read or written).
// Without --out the JSON is printed. With --out it is written atomically (a temp file in the same folder, flushed,
// then a rename) and only the file's base name and the counts are printed.
//
// What is read: dashboard.json, projects.json, history.jsonl and sessions/*.json in the data folder, and, for each
// project in projects.json, the roadmap files listed for it and the plan files those roadmaps name. A project file is
// read only when its real path is inside the project's real path, it is a regular file (not a link, not a hard link
// with a second name), and it is at most 256 KB. Each file is opened once, the open descriptor is checked (regular
// file, one name, size) and at most the cap plus one byte is read from that descriptor. A plan file whose resolved
// path has a .git, node_modules or .roadmap-backups folder in it is refused. A file that fails a check is reported by
// base name with the reason, and the rest of the project still loads. A folder that moved shows as "not found" and
// stays listed. Nothing is ever deleted. History records are joined to a project only by the labels stored with it
// (never by folder name).
//
// The roadmap reader (parseRoadmap, toReadJson, parsePlanFile) is imported from the roadmap skill's script. The one
// place it is looked for is chosen by this script's own folder name: next to a folder named "dashboard" it is
// ../../roadmap/scripts/roadmap.mjs, next to one named "ps-dashboard" (the personal copy) it is
// ../../ps-roadmap/scripts/roadmap.mjs, and under any other folder name the script stops. Nothing in a file or the
// command line takes part in the choice.
//
// --out is refused (exit 2, nothing written) when the folder it would sit in is the data folder or inside it, or when a
// real path is already there that is inside the data folder or is not a regular file.
//
// Output (schema v 1): { v, generatedAt, thresholds: { warnMin, idleMin }, projects: [...], sessions: [...],
// warnings: [...], errors: [...], notes?: [...] }, described in references/status.md. No path the tool builds is put in it: files are
// relative to their project or base names. Every text value is cleaned (control, bidirectional, zero-width, tag and
// other format characters become spaces, one line, capped) and is untrusted plain text for whoever reads it. Text
// copied from a file is shown as written, but the known forms of this machine's registered project paths, the data
// folder path and the home folder path in it (and of <drive>:\Users\<name>, /c/Users/<name>, /Users/<name> and
// /home/<name>) become [path], in string values only (never in a key); other spellings of a path may remain. The
// JSON is written with < > & and U+2028, U+2029 as \u escapes, so it is safe to inline in a script and parses to the
// same values. Caps: 100
// projects, 100 sessions, 300 phases and 500 history records per project, 2 MB of output. Only a session file of a listed
// project counts (a file of a project that is not listed is not read or reported). Of those files only the newest 250 by
// modified time are opened (every name is looked at with an lstat, nothing more), and past 100 sessions the 100 with the newest
// updated time are kept (a clock-skewed session counts as the oldest); one entry in errors, a fixed phrase with the number left
// out and no file name, says how many sessions the 100 cap left out, and (only then) a notes entry, another fixed phrase with a
// number, says how many older files were not opened.
// The result is parsed again before anything is printed or written.
//
// A session whose updated time is more than 5 minutes ahead of the clock, or whose step_started is after updated,
// is clock-skewed: it is shown as Idle with noUpdate true, its project gets a "clock skew" warning, and it never
// counts as an open session.
//
// A run reads at most 64 MB of project files in all (a file past that is skipped and reported).
//
// Added in 7d3 (all additive, the schema stays v 1): each session also has loops [{ from, to, count, active }], rounds,
// visits, workedMs, elapsedMs, estimateH and archived (see flowOf), each phase has estimateH, and each project has a
// summary (see summaryOf). collectData(options) is the function behind this command; the page script calls it too.
//
// A session file is sessions/<id>-<tag>+<phase>.json with a roadmap field (the roadmap file's path relative to the project,
// <tag> the first 6 hex digits of the SHA-256 of that path, in lower case only where the file system ignores letter case:
// Windows and macOS by default, io.caseInsensitive is the seam), or sessions/<id>-u<tag>+<phase>.json (a literal u before the
// tag) with unlisted: true and no roadmap field (a folder whose roadmap path is not usable; <tag> then only tells such folders
// apart), or, from before, sessions/<id>-<phase>.json with none of these. The name and the content must agree: the u in the name
// exactly when the marker is there, a roadmap field exactly when it is not; any other mix is skipped and reported by base name.
// The phase in a file name is lower case; a name with a capital in it is not a session file name. Each session carries that path
// (null for the older form, "(unlisted:<tag>)" for an unlisted folder, which has no listed roadmap, no title and no estimate);
// its estimate is the calibrated hours of the standard roadmap row with its phase id in that roadmap (the letter case of the
// roadmap path is ignored only where io.caseInsensitive is true), and a session with no roadmap field, or one the project does
// not list, takes the first standard roadmap that has the phase id. A roadmap entry whose path has a .git, node_modules or
// .roadmap-backups folder in it is not read.
// The older form is read, never written (the status script neither writes, takes over nor removes it). When an older-form file and
// a tagged file exist for the same project and phase (the phase compared without regard to letter case), only the newer one by
// updated time is shown (a clock-skewed session counts as the oldest, and on a tie the tagged file wins); the other is dropped silently.
// With two or more tagged files (two roadmaps) every tagged file is shown and the older-form file is dropped. Otherwise an
// older-form file ages out as Idle and is archived like any session.
//
// main(argv, io) is the test seam (async, because the reader is imported): io.out, io.err, io.now (epoch ms),
// io.fd = { open, fstat, read, close } (every file is opened and read through these; each is optional), io.rename,
// io.maxTotalRead, io.caseInsensitive (whether a roadmap path is lower-cased for its tag; the default comes from the platform). Nothing in the command line, the environment or a file can reach it.

import { readdirSync, lstatSync, realpathSync, statSync, openSync, fstatSync, readSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const WIN = process.platform === "win32";
// Windows and macOS (by default) do not tell Docs and docs apart; elsewhere the letter case of a name matters (seam: caseInsensitive).
const CASE_INSENSITIVE = WIN || process.platform === "darwin";
const HERE = dirname(fileURLToPath(import.meta.url));
const FILE_MODE = WIN ? undefined : 0o600;
const MAX_PROJECTS = 100;
// The sessions list is capped at 100: a page with more sessions (40-entry trails, long names) can pass its 1 MB limit.
const MAX_SESSIONS = 100;
// Of the session files of listed projects only the newest 250 by modified time are opened; the others are counted as left out.
const MAX_SESSION_READS = 250;
const MAX_PHASES = 300;
const MAX_HISTORY = 500;
const MAX_LABELS = 20;
const MAX_ROADMAPS = 10;
const MAX_PROJECT_FILE = 256 * 1024;
const MAX_SESSION_BYTES = 16 * 1024;
const MAX_TRAIL = 40;
const ARCHIVE_MS = 7 * 24 * 3600000;
const MAX_CONFIG_BYTES = 4096;
const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_OUT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_READ = 64 * 1024 * 1024;
const STEPS = ["baseline", "build", "compare", "review", "preview", "approve", "ship", "prod-check"];
const STATES = ["working", "waiting", "done"];
const SHOWN = { working: "Working", waiting: "Waiting for you", done: "Done" };
const CAUGHT_BY = ["builder-self", "compare", "own-review", "security-review", "browser-check", "prod-check"];
const TOKEN_KEYS = ["builder", "checker", "shipper", "model_scout"];
const ID_RE = /^[0-9a-f]{12}$/;
// A session file is <id>-<tag>+<phase>.json (tag: 6 hex digits of the SHA-256 of its roadmap path; the file has a roadmap
// field and no marker), or <id>-u<tag>+<phase>.json (a literal u before the tag; the file has the marker unlisted: true and no
// roadmap field, because its folder has no usable roadmap path), or, from before, <id>-<phase>.json (no roadmap field). The
// "+" cannot occur in a phase id, so the forms never read as each other, and the u means no unlisted name is ever the name of a
// listed roadmap's file. The phase part of a name is lower case, as the status script writes it: a name with an upper-case phase
// is not a session file name.
const SESSION_FILE_RE = /^([0-9a-f]{12})-([a-z0-9._-]{1,40})\.json$/;
const SESSION_FILE_TAGGED_RE = /^([0-9a-f]{12})-(u?)([0-9a-f]{6})\+([a-z0-9._-]{1,40})\.json$/;
const UNLISTED_PREFIX = "(unlisted:";
const PHASE_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const TEMP_FILE_RE = /\.tmp-\d+-[0-9a-f]{8}$/;
const MS_MAX = 8.64e15;
const CLOCK_AHEAD_MS = 5 * 60000;
const NEVER_READ = new Set([".git", "node_modules", ".roadmap-backups"]);
const NEVER_READ_WHY = "inside a folder that is never read (.git, node_modules or .roadmap-backups)";
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const PATH_MARK = "[path]";

const cp = (n) => String.fromCodePoint(n);
// Control, C1, line-separator, bidirectional, zero-width, tag and every other Unicode format (Cf) character.
const UNSAFE_TEXT = new RegExp(
  `[${cp(0)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x61c)}${cp(0x200b)}-${cp(0x200f)}${cp(0x2028)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2069)}${cp(0xfeff)}${cp(0xe0000)}-${cp(0xe007f)}\\p{Cf}]`,
  "gu",
);
const UNSAFE_ANY = new RegExp(UNSAFE_TEXT.source, "u");
// While a collect runs, redactor is set: this machine's paths in a text are replaced before anything else is done to
// it (see makeRedactor), so a path cannot survive because a cleaning step cut it up.
let redactor = null;
const clean = (s, n = 200) => Array.from((redactor ? redactor(String(s ?? "")) : String(s ?? "")).slice(0, n * 4).replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim()).slice(0, n).join("");
const cleanOrNull = (s, n = 200) => (s === null || s === undefined ? null : clean(s, n));

const codeOf = (e) => e?.code ?? "error";
const keyOf = (p) => (WIN ? p.toLowerCase() : p);
const samePath = (a, b) => keyOf(a) === keyOf(b);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const idOf = (real) => createHash("sha256").update(WIN ? real.toLowerCase() : real).digest("hex").slice(0, 12);
const lstatOrNull = (path) => {
  try { return lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
};
const insideOf = (base, p) => {
  const rel = relative(base, p);
  return !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..";
};
const slashes = (p) => p.split(/[\\/]/).join("/");
const realpathOrNull = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// A roadmap file path relative to the project: plain names joined by "/", no "..", ending .md. Null when it is not.
function roadmapOf(raw) {
  const s = String(raw ?? "").replace(/\\/g, "/");
  if (!/^[A-Za-z0-9._@+() -]{1,100}(\/[A-Za-z0-9._@+() -]{1,100}){0,5}$/.test(s)) return null;
  if (s.split("/").some((p) => /^\.+$/.test(p) || p !== p.trim() || p.endsWith(".") || NEVER_READ.has(p.toLowerCase()))) return null;
  return /\.md$/i.test(s) ? s : null;
}
// The tag of a roadmap path: lower case only where the file system does not tell letter case apart.
const roadmapTag = (rel, caseInsensitive = CASE_INSENSITIVE) => createHash("sha256").update(caseInsensitive ? rel.toLowerCase() : rel).digest("hex").slice(0, 6);

// ── The data folder (read only) ─────────────────────────────────────────────
function inspectDir(dir) {
  try {
    const st = lstatOrNull(dir);
    if (!st) return { exists: false };
    if (st.isSymbolicLink()) return { fail: "a link, not a real folder" };
    if (!st.isDirectory()) return { fail: "not a real folder" };
    if (!samePath(realpathSync.native(dir), join(realpathSync.native(dirname(dir)), basename(dir)))) return { fail: "a link, not a real folder" };
    return { exists: true };
  } catch (e) {
    return { fail: codeOf(e) };
  }
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

// Reads one small file of ours as text. Returns { text } (undefined when absent) or { fail }.
function readOwnText(dir, name, limit, io) {
  const path = join(dir, name);
  const notRegular = "not a regular file (a link, a hard link or a folder)";
  let st;
  try { st = lstatOrNull(path); } catch (e) { return { fail: codeOf(e) }; }
  if (!st) return { text: undefined };
  if (!st.isFile() || st.nlink > 1) return { fail: notRegular };
  if (st.size > limit) return { fail: "too large" };
  // Where the file should really be, worked out before the open: its real folder and its name.
  let expected;
  try { expected = join(realpathSync.native(dir), name); } catch (e) { return { fail: codeOf(e) }; }
  const got = readOpenFile(path, limit, io);
  if (got.code) return { fail: got.code };
  if (got.why) return { fail: got.why === "size" ? "too large" : notRegular };
  // The path may have been swapped for a link (or its folder for a junction) after the checks, and a platform without
  // O_NOFOLLOW does not stop the open from following one: check again and drop what was read.
  try { if (!samePath(realpathSync.native(path), expected)) return { fail: "a link, not a real file" }; } catch (e) { return { fail: codeOf(e) }; }
  try { return { text: DECODER.decode(got.bytes) }; } catch { return { fail: "not valid text" }; }
}

function loadConfig(dir, io) {
  const got = readOwnText(dir, "dashboard.json", MAX_CONFIG_BYTES, io);
  const dflt = { warnMin: 90, idleMin: 180 };
  if (got.fail) return { ...dflt, error: got.fail };
  if (got.text === undefined) return dflt;
  let v;
  try { v = JSON.parse(got.text); } catch { return { ...dflt, error: "not valid JSON" }; }
  const minutes = (n) => Number.isInteger(n) && n >= 1 && n <= 100000;
  if (!isObj(v) || v.v !== 1 || !minutes(v.warnMin) || !minutes(v.idleMin)) return { ...dflt, error: "not as expected" };
  return { warnMin: v.warnMin, idleMin: v.idleMin };
}

// Returns { projects } or { fail }.
function loadRegistry(dir, io) {
  const got = readOwnText(dir, "projects.json", MAX_REGISTRY_BYTES, io);
  if (got.fail) return { fail: got.fail };
  if (got.text === undefined) return { projects: [] };
  let v;
  try { v = JSON.parse(got.text); } catch { return { fail: "not valid JSON" }; }
  const bad = { fail: "not as expected" };
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.projects) || v.projects.length > MAX_PROJECTS) return bad;
  const projects = [];
  for (const p of v.projects) {
    if (!isObj(p) || typeof p.id !== "string" || !ID_RE.test(p.id) || typeof p.path !== "string" || p.path.length > 1024 || typeof p.name !== "string") return bad;
    if (!Array.isArray(p.labels) || p.labels.length > MAX_LABELS || !p.labels.every((l) => typeof l === "string")) return bad;
    if (!Array.isArray(p.roadmaps) || p.roadmaps.length > MAX_ROADMAPS || !p.roadmaps.every((r) => typeof r === "string")) return bad;
    if (projects.some((q) => q.id === p.id)) return bad;
    projects.push({ id: p.id, path: p.path, name: p.name, labels: p.labels, roadmaps: p.roadmaps });
  }
  return { projects };
}

// The history file: one JSON object per line; a line that is not an object with a project and a phase is skipped.
function loadHistory(dir, io) {
  const got = readOwnText(dir, "history.jsonl", MAX_HISTORY_BYTES, io);
  if (got.fail) return { fail: got.fail, records: [] };
  const records = [];
  for (const line of (got.text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (isObj(r) && typeof r.project === "string" && r.phase !== undefined && r.phase !== null) records.push(r);
    } catch { /* a bad line is skipped */ }
  }
  return { records };
}

// The fields of a history record that are kept, each checked for its type. Nothing else is copied.
function historyRow(r) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const tokens = isObj(r.tokens) ? Object.fromEntries(TOKEN_KEYS.filter((k) => Number.isInteger(r.tokens[k]) && r.tokens[k] >= 0).map((k) => [k, r.tokens[k]])) : null;
  return {
    phase: clean(r.phase, 40),
    est_h: num(r.est_h),
    actual_h: num(r.actual_h),
    check_rounds: Number.isInteger(r.check_rounds) && r.check_rounds >= 0 ? r.check_rounds : null,
    caught_by: Array.isArray(r.caught_by) ? r.caught_by.filter((x) => CAUGHT_BY.includes(x)).slice(0, 20) : null,
    prod_first_pass: typeof r.prod_first_pass === "boolean" ? r.prod_first_pass : null,
    rolled_back: typeof r.rolled_back === "boolean" ? r.rolled_back : null,
    tokens,
  };
}

// ── The roadmap reader, found next to this skill ────────────────────────────
// This script's own folder name decides which sibling it reads: exactly one place, never a search.
const READER_FOLDER = { dashboard: "roadmap", "ps-dashboard": "ps-roadmap" };

async function loadReader() {
  const own = basename(dirname(HERE));
  const sibling = Object.hasOwn(READER_FOLDER, own) ? READER_FOLDER[own] : null;
  if (!sibling) return { fail: `this script must sit in a folder named dashboard or ps-dashboard, not ${clean(own, 40)}; no roadmap script was looked for` };
  const path = join(HERE, "..", "..", sibling, "scripts", "roadmap.mjs");
  let st = null;
  try { st = lstatSync(path); } catch { /* not there */ }
  if (!st || !st.isFile()) return { fail: `cannot find the roadmap script (looked for ../../${sibling} next to this skill)` };
  const mod = await import(pathToFileURL(path).href);
  if (typeof mod.parseRoadmap === "function" && typeof mod.toReadJson === "function" && typeof mod.parsePlanFile === "function") return mod;
  return { fail: "the roadmap script next to this one lacks parseRoadmap, toReadJson or parsePlanFile" };
}

// ── Reading a project file ──────────────────────────────────────────────────
// Every read of a project file goes through here (and through io.fd). `rel` is "/"-joined plain names that are
// already known to stay inside the project. With `plan` set (a plan file) a path through .git, node_modules or
// .roadmap-backups is refused. Returns { text } or { skip: reason }.
const SKIP_WHY = { type: "not a regular file", links: "hard link (a second name may lead outside the project)", size: "too large (over 256 KB)" };
const inNeverRead = (relPath) => relPath.split(/[\\/]/).some((s) => NEVER_READ.has(s.toLowerCase()));

function readProjectFile(real, rel, io, plan = false) {
  const abs = join(real, ...rel.split("/"));
  if (plan && inNeverRead(rel)) return { skip: NEVER_READ_WHY };
  let st;
  try { st = lstatSync(abs); } catch (e) { return { skip: e.code === "ENOENT" || e.code === "ENOTDIR" ? "not found" : `unreadable (${codeOf(e)})` }; }
  if (st.isSymbolicLink()) return { skip: "symbolic link or junction (not followed)" };
  if (!st.isFile()) return { skip: SKIP_WHY.type };
  if (st.nlink > 1) return { skip: SKIP_WHY.links };
  if (st.size > MAX_PROJECT_FILE) return { skip: SKIP_WHY.size };
  if (io.readBytes + st.size > (io.maxTotalRead ?? MAX_TOTAL_READ)) return { skip: "over the read budget for one collect" };
  // Where the file really is: inside the project and, for a plan file, not under a folder that is never read.
  const placed = () => {
    const at = realpathSync.native(abs);
    if (!insideOf(real, at)) return "outside the project folder";
    return plan && inNeverRead(relative(real, at)) ? NEVER_READ_WHY : null;
  };
  try { const why = placed(); if (why) return { skip: why }; } catch (e) { return { skip: `unreadable (${codeOf(e)})` }; }
  // One open: the descriptor that is checked is the one that is read (a swap after the lstat above is caught here).
  const got = readOpenFile(abs, MAX_PROJECT_FILE, io);
  if (got.code) return { skip: `unreadable (${got.code})` };
  if (got.why) return { skip: SKIP_WHY[got.why] };
  const bytes = got.bytes;
  io.readBytes += bytes.length;
  // The path may have been swapped for a link after the first check: check again and drop what was read.
  try { const why = placed(); if (why) return { skip: why }; } catch (e) { return { skip: `unreadable (${codeOf(e)})` }; }
  let text;
  try { text = DECODER.decode(bytes); } catch { return { skip: "not valid UTF-8 text" }; }
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
}

// A plan file named in a roadmap row: the text as written, to a relative path inside the project or null. It is tried
// next to the roadmap file first, then from the project folder; a path that leaves the project is never touched.
function planCandidates(real, roadmapRel, written) {
  const raw = String(written ?? "").trim();
  // A colon would be a drive, a URL or (on Windows) an alternate data stream; only a Markdown file is ever read.
  if (!raw || raw.length > 260 || UNSAFE_ANY.test(raw) || /:|^[\\/]/.test(raw) || !/\.md$/i.test(raw)) return { bad: true };
  const p = slashes(raw);
  const out = [];
  for (const base of [dirname(roadmapRel) === "." ? "" : dirname(roadmapRel), ""]) {
    const abs = resolve(real, base, p);
    if (!insideOf(real, abs)) return { outside: true };
    const rel = slashes(relative(real, abs));
    if (rel && !out.includes(rel)) out.push(rel);
  }
  return { rels: out };
}

const MD_ONLY = /^[\w./\\-]+\.md$/;

// ── One project ─────────────────────────────────────────────────────────────
// The calibrated hours in an Est. cell: "3.3 h" gives 3.3, "5.4 h → 3.3 h + 0.5 h" gives 3.3 (the number after the
// arrow), anything else null.
const EST_CELL = new RegExp(`^\\s*(\\d+(?:\\.\\d+)?)\\s*h(?![A-Za-z])(?:\\s*(?:${cp(0x2192)}|->)\\s*(\\d+(?:\\.\\d+)?)\\s*h(?![A-Za-z]))?`, "i");
function estimateOf(cell) {
  const m = String(cell ?? "").match(EST_CELL);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : null;
}

function projectErrors() {
  const list = [];
  const seen = new Set();
  return {
    list,
    add(file, reason) {
      const e = { file: clean(file, 80) || "(unnamed)", reason };
      const k = `${e.file}\n${reason}`;
      if (seen.has(k) || list.length >= 50) return;
      seen.add(k);
      list.push(e);
    },
  };
}

function readProject(p, reader, io) {
  const name = clean(basename(String(p.name).replace(/\\/g, "/")), 80) || "project";
  const base = { id: p.id, name, status: "ok", roadmaps: [], history: [], errors: [] };
  let real;
  try {
    real = realpathSync.native(resolve(p.path));
    if (!statSync(real).isDirectory()) throw Object.assign(new Error("not a folder"), { code: "ENOTDIR" });
  } catch (e) {
    return { ...base, status: e.code === "ENOENT" || e.code === "ENOTDIR" ? "not found" : "unreadable" };
  }
  if (idOf(real) !== p.id) return { ...base, status: "not found" };
  const errors = projectErrors();
  const planCache = new Map();
  let phaseCount = 0;
  // Entries that are the same path (a backslash or another letter case where the file system ignores it) are read once, the first one.
  const seenRoadmaps = new Set();
  const foldRel = (rel) => ((io.caseInsensitive ?? CASE_INSENSITIVE) ? rel.toLowerCase() : rel);
  for (const rawRel of p.roadmaps) {
    const rel = roadmapOf(rawRel);
    if (!rel) { errors.add(basename(String(rawRel).replace(/\\/g, "/")), "not a usable roadmap path"); continue; }
    if (seenRoadmaps.has(foldRel(rel))) continue;
    seenRoadmaps.add(foldRel(rel));
    const got = readProjectFile(real, rel, io);
    if (got.skip) { errors.add(basename(rel), got.skip); continue; }
    let read;
    let estCells;
    try {
      const parsed = reader.parseRoadmap(got.text);
      read = reader.toReadJson(parsed, basename(rel));
      // The Est. cell of every row, in the order of the rows in read.tables (the same tables, the same rows).
      estCells = parsed.tables.flatMap((t) => {
        const col = t.names.findIndex((n) => /^est/i.test(String(n)));
        return t.rows.map((r) => (col >= 0 ? String(r.vals[col] ?? "") : ""));
      });
    } catch { errors.add(basename(rel), "could not be read as a roadmap"); continue; }
    const phases = [];
    for (const [rowAt, row] of read.tables.flatMap((t) => t.phases).entries()) {
      if (phaseCount >= MAX_PHASES) { errors.add(basename(rel), `more than ${MAX_PHASES} phases; the rest were left out`); break; }
      phaseCount++;
      let written = row.planFile;
      if (!written && typeof row.note === "string" && MD_ONLY.test(row.note.trim())) written = row.note.trim();
      let planFile = null;
      let timestamps = { started: null, previewed: null, approved: null, shipped: null };
      if (written) {
        const cand = planCandidates(real, rel, written);
        const shown = basename(String(written).replace(/\\/g, "/"));
        if (cand.bad) errors.add(shown, "not a usable plan file path");
        else if (cand.outside) errors.add(shown, "outside the project folder");
        else {
          let found = null;
          let last = null;
          for (const c of cand.rels) {
            if (!planCache.has(c)) planCache.set(c, readProjectFile(real, c, io, true));
            const r = planCache.get(c);
            if (r.text !== undefined) { found = { rel: c, text: r.text }; break; }
            last = r;
            if (r.skip !== "not found") break;
          }
          if (found) {
            planFile = clean(found.rel, 200);
            const ts = reader.parsePlanFile(found.text).timestamps;
            if (ts) for (const k of Object.keys(timestamps)) timestamps[k] = cleanOrNull(ts[k], 40);
          } else errors.add(shown, last?.skip ?? "not found");
        }
      }
      phases.push({
        id: clean(row.id, 40),
        phase: clean(row.phase, 200),
        status: row.status ?? null,
        kind: cleanOrNull(row.kind, 40),
        priority: cleanOrNull(row.priority, 40),
        urgency: cleanOrNull(row.urgency, 40),
        estRaw: typeof row.estRaw === "number" ? row.estRaw : null,
        estCal: typeof row.estCal === "number" ? row.estCal : null,
        estimateH: estimateOf(estCells[rowAt]),
        actual: typeof row.actual === "number" ? row.actual : null,
        commit: cleanOrNull(row.commit, 80),
        planFile,
        timestamps,
      });
    }
    // A file is standard when it has at least one table and every table carries the roadmap marker line (none is legacy).
    base.roadmaps.push({ file: clean(rel, 200), tables: read.tables.length, standard: read.tables.length > 0 && read.tables.every((t) => t.legacy === false), phases });
  }
  base.errors = errors.list;
  return base;
}

// ── Sessions ────────────────────────────────────────────────────────────────
// Returns { sessions, errors, skewed, dropped } from <data>/sessions (skewed: the ids of projects with a clock-skewed session).
// A bad file is skipped and named by base name only. Only files of listed projects count: every such file name is looked at
// (an lstat, never opened) and only the newest MAX_SESSION_READS by modified time are opened, so a folder that only grows costs
// a bounded number of reads. Past MAX_SESSIONS the newest by their updated time are kept (a clock-skewed session counts as the
// oldest). dropped is how many sessions were left out by that cap; unread is how many files of listed projects were never opened
// because of the read limit (they are usually old, finished sessions, so they are a note, not an error). An older-form file hidden
// by a newer file of the same project and phase (see below) is in neither count.
// A session of an older-form file (<id>-<phase>.json) and one of a tagged file (<id>-<tag>+<phase>.json or the u form) of the same
// project and phase are one phase after an upgrade: when there is exactly one tagged file, only the newer by updated time is shown,
// the other is dropped without a word; with two or more tagged files (two roadmaps) every tagged file is shown and the older-form
// file is the one dropped.
const sessionRank = (e) => (e.skew ? -1 : e.s.updated);
function readSessions(dir, known, config, nowMs, io) {
  const sessions = [];
  const errors = [];
  const skewed = new Set();
  const sdir = join(dir, "sessions");
  const info = inspectDir(sdir);
  if (info.fail) return { sessions, skewed, errors: [{ file: "sessions", reason: info.fail }] };
  if (!info.exists) return { sessions, skewed, errors };
  let names;
  try { names = readdirSync(sdir).sort(); } catch (e) { return { sessions, skewed, errors: [{ file: "sessions", reason: `unreadable (${codeOf(e)})` }] }; }
  const skip = (name, reason) => { if (errors.length < 50) errors.push({ file: clean(name, 80) || "(unnamed)", reason }); };
  const candidates = [];
  for (const name of names) {
    if (TEMP_FILE_RE.test(name)) continue;
    const plain = name.match(SESSION_FILE_RE);
    const tagged = name.match(SESSION_FILE_TAGGED_RE);
    if (!plain && !tagged) { skip(name, "not a session file name"); continue; }
    // A file of a project that is not registered (or was unregistered) leaves no trace: it is not read or reported.
    if (!known.has((plain ?? tagged)[1])) continue;
    let mtime = 0;
    try { mtime = lstatSync(join(sdir, name)).mtimeMs; } catch { /* the read below reports it */ }
    candidates.push({ name, plain, tagged, mtime });
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const chosen = candidates.length > MAX_SESSION_READS ? [...candidates].sort((a, b) => b.mtime - a.mtime || byName(a, b)).slice(0, MAX_SESSION_READS).sort(byName) : candidates;
  const found = [];
  for (const { name, plain, tagged } of chosen) {
    const id = (plain ?? tagged)[1];
    const got = readOwnText(sdir, name, MAX_SESSION_BYTES, io);
    if (got.fail || got.text === undefined) { skip(name, got.fail ?? "gone"); continue; }
    let v;
    try { v = JSON.parse(got.text); } catch { skip(name, "not valid JSON"); continue; }
    const ms = (n) => Number.isInteger(n) && n >= 0 && n <= MS_MAX;
    if (!isObj(v) || v.v !== 1 || typeof v.project !== "string" || typeof v.phase !== "string" || typeof v.phase_name !== "string") { skip(name, "not the expected shape"); continue; }
    // Phase ids are compared without regard to letter case (7a and 7A share one file on every system).
    // A name <id>-<tag>+<phase> needs a roadmap field whose path has that tag; a name <id>-u<tag>+<phase> needs unlisted: true and no
    // roadmap field (a folder that has no usable roadmap path: no listed roadmap, no title, no estimate, and the tag only tells such
    // folders apart); an older <id>-<phase> name has neither. A roadmap field that is not a usable path is a file that is not as expected.
    let roadmap = null;
    let unlisted = false;
    if (v.roadmap !== undefined) {
      roadmap = typeof v.roadmap === "string" ? roadmapOf(v.roadmap) : null;
      if (!roadmap) { skip(name, "not the expected shape"); continue; }
    }
    if (v.unlisted !== undefined) {
      if (v.unlisted !== true || !tagged || tagged[2] !== "u" || v.roadmap !== undefined) { skip(name, "not the expected shape"); continue; }
      unlisted = true;
    }
    const ownName = roadmap ? tagged && tagged[2] === "" && tagged[3] === roadmapTag(roadmap, io.caseInsensitive ?? CASE_INSENSITIVE) && tagged[4].toLowerCase() : unlisted ? tagged[4] : plain?.[2].toLowerCase();
    if (v.project !== id || !PHASE_ID_RE.test(v.phase) || v.phase.toLowerCase() !== ownName) { skip(name, "its content does not match its file name"); continue; }
    if (!STEPS.includes(v.step)) { skip(name, "unknown step"); continue; }
    if (!STATES.includes(v.state)) { skip(name, "unknown state"); continue; }
    if (!ms(v.step_started) || !ms(v.updated)) { skip(name, "a time is not a whole number of milliseconds"); continue; }
    let trail = null;
    if (v.trail !== undefined) {
      trail = trailFrom(v.trail);
      if (!trail) { skip(name, "its trail is not as expected"); continue; }
    }
    const age = nowMs - v.updated;
    // A time in the future (more than 5 minutes ahead), or a step that started after its last update, means a wrong clock.
    const skew = v.updated - nowMs > CLOCK_AHEAD_MS || v.step_started > v.updated;
    const idle = skew || age >= config.idleMin * 60000;
    found.push({ id, skew, older: !tagged, s: {
      project: id,
      roadmap: roadmap ? clean(roadmap, 200) : unlisted ? `${UNLISTED_PREFIX}${tagged[3]})` : null,
      phase: v.phase,
      phase_name: clean(v.phase_name, 200),
      step: v.step,
      state: v.state,
      shown: idle ? "Idle" : SHOWN[v.state],
      noUpdate: skew || (v.state === "working" && age >= config.warnMin * 60000),
      updated: v.updated,
      step_started: v.step_started,
      ...flowOf(v, trail),
      estimateH: null,
      archived: v.state === "done" && nowMs - v.updated > ARCHIVE_MS,
    } });
  }
  // One phase in an older-form file and in a tagged file: the newer one is shown (a skewed one counts as the oldest; on a tie the tagged file wins).
  const groups = new Map();
  for (const e of found) {
    const k = `${e.id}\u0000${e.s.phase.toLowerCase()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const hidden = new Set();
  for (const g of groups.values()) {
    const older = g.find((e) => e.older);
    const tagged = g.filter((e) => !e.older);
    if (!older || !tagged.length) continue;
    // The older-form file displaces a tagged file only when that is the one tagged file of the phase. With two or more tagged files
    // (two roadmaps) the older-form file stood for none of them alone: it is the one dropped and every tagged file is shown.
    hidden.add(tagged.length === 1 && sessionRank(older) > sessionRank(tagged[0]) ? tagged[0] : older);
  }
  const shown = found.filter((e) => !hidden.has(e));
  let live = shown;
  if (shown.length > MAX_SESSIONS) {
    const newest = new Set([...shown].sort((a, b) => sessionRank(b) - sessionRank(a)).slice(0, MAX_SESSIONS));
    live = shown.filter((e) => newest.has(e));
  }
  for (const e of live) { sessions.push(e.s); if (e.skew) skewed.add(e.id); }
  return { sessions, errors, skewed, dropped: shown.length - live.length, unread: candidates.length - chosen.length };
}

// The optional trail of a session file: at most 40 entries, each { step, state, at } with a known step and state and a
// time in milliseconds. Returns the cleaned list, or null when it is not that (the file is then skipped and reported).
function trailFrom(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_TRAIL) return null;
  const out = [];
  for (const e of raw) {
    if (!isObj(e) || !STEPS.includes(e.step) || !STATES.includes(e.state) || !Number.isInteger(e.at) || e.at < 0 || e.at > MS_MAX) return null;
    out.push({ step: e.step, state: e.state, at: e.at });
  }
  return out;
}

// What a session's trail says. Without a trail (a file from an earlier version, or a run that has not changed its step
// or state yet) the one entry is the file's own step, state and step_started. The steps visited in order (a step
// repeated straight away is one visit) give:
//   visits    how many times each step was entered
//   rounds    the most visits of any one step (1 when nothing repeated)
//   loops     one { from, to, count, active } per pair of steps with a move back from `from` to an earlier `to`; active
//             only for the latest move back, while the run is still between `to` and `from` and not done
//   workedMs  the time spent in state working, up to the last update (never the time since)
//   elapsedMs the time from the first entry to the last update
function flowOf(v, trail) {
  const entries = trail?.length ? trail : [{ step: v.step, state: v.state, at: v.step_started }];
  const seq = [];
  for (const e of entries) if (seq.at(-1) !== e.step) seq.push(e.step);
  const at = (s) => STEPS.indexOf(s);
  const visits = {};
  for (const s of seq) visits[s] = (visits[s] ?? 0) + 1;
  const moves = [];
  for (let k = 1; k < seq.length; k++) if (at(seq[k]) < at(seq[k - 1])) moves.push({ from: seq[k - 1], to: seq[k], pos: k });
  const loops = [];
  for (const m of moves) {
    const found = loops.find((l) => l.from === m.from && l.to === m.to);
    if (found) found.count++;
    else loops.push({ from: m.from, to: m.to, count: 1, active: false });
  }
  const latest = moves.at(-1);
  if (latest && v.state !== "done" && at(v.step) < at(latest.from) && !seq.slice(latest.pos).some((s) => at(s) >= at(latest.from))) {
    loops.find((l) => l.from === latest.from && l.to === latest.to).active = true;
  }
  let workedMs = 0;
  entries.forEach((e, i) => {
    const end = i + 1 < entries.length ? entries[i + 1].at : v.updated;
    if (e.state === "working" && end > e.at) workedMs += end - e.at;
  });
  const first = entries[0].at;
  return {
    loops,
    rounds: Math.max(1, ...Object.values(visits)),
    visits,
    workedMs,
    elapsedMs: Math.max(0, v.updated - first),
  };
}

// The totals shown on a project's row: its standard roadmaps and phases (and how many files are not standard), and its sessions by what they are doing now.
function summaryOf(item, sessions) {
  const mine = sessions.filter((s) => s.project === item.id && !s.archived);
  const live = (s) => s.shown !== "Idle";
  const working = mine.filter((s) => s.state === "working" && live(s));
  const waiting = mine.filter((s) => s.state === "waiting" && live(s));
  const active = [...working, ...waiting];
  const sum = (list, f) => list.reduce((a, s) => a + f(s), 0);
  // Strict: only standard roadmap files count. The others are counted in legacyFiles and named (at most 10) in legacyNames.
  const standard = item.roadmaps.filter((r) => r.standard === true);
  const legacy = item.roadmaps.filter((r) => r.standard !== true);
  return {
    roadmaps: standard.length,
    phasesTotal: sum(standard, (r) => r.phases.length),
    phasesShipped: sum(standard, (r) => r.phases.filter((p) => p.status === "shipped").length),
    legacyFiles: legacy.length,
    legacyNames: legacy.slice(0, 10).map((r) => clean(r.file, 200)),
    active: active.length,
    working: working.length,
    waiting: waiting.length,
    idle: mine.filter((s) => s.state !== "done" && !live(s)).length,
    archived: sessions.filter((s) => s.project === item.id && s.archived).length,
    estimateActiveH: Math.round(sum(active, (s) => s.estimateH ?? 0) * 100) / 100,
    workedActiveMs: sum(active, (s) => s.workedMs),
  };
}

// ── Output ──────────────────────────────────────────────────────────────────
// The JSON text, with < > & and the line and paragraph separators written as \u escapes: it parses to the same values
// and is safe to inline in a script or a page.
const JSON_ESCAPES = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" };
const safeJson = (v, indent) => JSON.stringify(v, null, indent).replace(/[<>&\u2028\u2029]/g, (c) => JSON_ESCAPES[c]);

// Paths of this machine that must not appear in text copied from a file. Known forms are replaced by [path]; other
// spellings of a path may remain, so a plan should not hold a path at all.
//   1. The registered project paths, the data folder and the home folder, in any mix of "\", "/" (one or more of each,
//      so a doubled backslash counts as one separator) and the URL-encoded %5C and %2F (and %3A for the drive colon).
//      Only a path of at least 4 characters counts, and not as part of a longer name.
//   2. Any drive letter and "Users" and one name segment (<drive>:\Users\<name>, also the 8.3 form, mixed, doubled or
//      URL-encoded), and /c/Users/<name>, /mnt/c/Users/<name>, /Users/<name> and /home/<name>. Only the prefix up to
//      and including the name segment is replaced.
// Before either, the invisible characters (the UNSAFE_TEXT set) are taken out of the text entirely: when that reveals a
// path the text without them is used, so a zero-width character inside a path cannot hide it. Text with no path is left
// alone and the normal cleaning turns those characters into spaces afterwards.
const SEP = String.raw`(?:\\|/|%5[Cc]|%2[Ff])+`;
const SLASH = String.raw`(?:/|%2[Ff])+`;
const COLON = String.raw`(?::|%3[Aa])`;
const NAME = String.raw`(?:%(?!5[Cc]|2[Ff])|[^\\/%\s"'${"`"},;:*?<>|()\[\]{}])+`;
const USER_PATHS = [
  new RegExp(`(?<![A-Za-z])[A-Za-z]${COLON}${SEP}Users${SEP}${NAME}`, "gi"),
  new RegExp(`(?<![A-Za-z0-9_.-])(?:${SLASH}mnt)?${SLASH}[A-Za-z]${SLASH}Users${SLASH}${NAME}`, "gi"),
  new RegExp(`(?<![A-Za-z0-9_.-])${SLASH}(?:Users|home)${SLASH}${NAME}`, "gi"),
];

// The pattern for the exact paths of this machine, split into segments so any separator spelling matches. Null when
// there is none.
function pathPattern(paths) {
  const forms = new Set();
  for (const p of paths) {
    if (typeof p !== "string" || !isAbsolute(p)) continue;
    const bare = p.replace(/[\\/]+$/, "");
    if (bare.length < 4) continue;
    const segments = bare.split(/[\\/]+/).filter((s, i) => s || i > 0);
    const lead = /^[\\/]/.test(bare) ? SEP : "";
    forms.add(lead + segments.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:/g, COLON)).join(SEP));
  }
  if (!forms.size) return null;
  const alts = [...forms].sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![A-Za-z0-9_.-])(?:${alts.join("|")})(?![A-Za-z0-9_-])`, WIN ? "gi" : "g");
}

// Returns a function that replaces this machine's paths in a text (see above).
function makeRedactor(paths) {
  const known = pathPattern(paths);
  const replace = (t) => USER_PATHS.reduce((s, re) => s.replace(re, PATH_MARK), known ? t.replace(known, PATH_MARK) : t);
  return (text) => {
    const stripped = text.replace(UNSAFE_TEXT, "");
    const whole = replace(stripped);
    return whole !== stripped ? whole : replace(text);
  };
}

// Walks the parsed result and redacts string values only. A key is never touched.
function scrubbed(value, redact) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => scrubbed(v, redact));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubbed(v, redact)]));
  return value;
}

const RENAME_CODES = ["EPERM", "EACCES", "EBUSY"];
const sleepMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Writes the text into a temp file (flushed), then renames it over the final name, which must be absent or a regular
// file with one name. On Windows a rename refused for a moment is retried up to 10 times. Returns null or an error text.
function writeAtomic(path, text, io) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const rename = io.rename ?? ((a, b) => renameSync(a, b));
  let fd;
  try {
    const st = lstatOrNull(path);
    if (st && (!st.isFile() || st.nlink > 1)) return "not a regular file";
    fd = openSync(tmp, "wx", FILE_MODE);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    for (let attempt = 0; ; attempt++) {
      try { rename(tmp, path); return null; } catch (e) {
        if (!WIN || !RENAME_CODES.includes(e?.code) || attempt >= 10) { rmSync(tmp, { force: true }); return codeOf(e); }
      }
      sleepMs(Math.min(100, 10 * (attempt + 1)));
    }
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { rmSync(tmp, { force: true }); } catch { /* the temp file holds only what the output would */ }
    return codeOf(e);
  }
}

// Why a --out target must not be written, or null. It is refused when it starts with two path separators (a network or
// device path such as \\host\share or //host/share, on every platform: such a path can name the data folder by a route
// the real-path check does not see), when its file name has a colon, when the real folder it would sit in is the data
// folder or inside it (the output must never replace the status files), when the target or any folder above it is the
// data folder itself under another route (the same device and file number), or when a real path is already there and is
// inside the data folder or is not a regular file. A folder that is not there is left to the write, which fails.
// seams (tests only): realpath, stat (with bigint numbers) and lstat.
const TWO_SEPARATORS = /^[\\/]{2}/;
const sameFile = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
const hasFileNumber = (s) => s && s.ino !== undefined && s.ino !== null && String(s.ino) !== "0";
export function outProblem(raw, dir, realData, seams = {}) {
  const realpath = seams.realpath ?? ((p) => realpathSync.native(p));
  const stat = seams.stat ?? ((p) => statSync(p, { bigint: true }));
  const lstat = seams.lstat ?? lstatOrNull;
  const target = resolve(String(raw));
  if (TWO_SEPARATORS.test(String(raw)) || TWO_SEPARATORS.test(target)) return "must not be a network or device path (two separators at the start)";
  // A colon in the file name is refused on every platform: on Windows it names an alternate data stream and the write
  // would leave an empty file of the part before it behind.
  if (basename(target).includes(":")) return "must not have a colon in its file name";
  const roots = [dir, ...(realData ? [realData] : [])];
  // The same folder by any route (a link, a junction, a mount, another spelling): the device and file number match.
  let own = null;
  try { own = stat(dir); } catch { /* no data folder to match */ }
  if (hasFileNumber(own)) {
    let at = target;
    for (let step = 0; step < 4096; step++) {
      let s = null;
      try { s = stat(at); } catch { /* not there: look higher up */ }
      if (hasFileNumber(s) && sameFile(s, own)) return "must not be in the data folder";
      const up = dirname(at);
      if (up === at) break;
      at = up;
    }
  }
  let parent;
  try { parent = realpath(dirname(target)); } catch { return null; }
  if (roots.some((r) => insideOf(r, parent))) return "must not be in the data folder";
  let st;
  try { st = lstat(target); } catch { return null; }
  if (!st) return null;
  let real;
  try { real = realpath(target); } catch { return null; }
  if (roots.some((r) => insideOf(r, real))) return "must not be in the data folder";
  try { if (!statSync(real).isFile()) return "must be a regular file or a name that is not used yet"; } catch { return null; }
  return null;
}

const USAGE = ["usage: collect.mjs --data <dir> [--out <file>] [--now <epoch ms>]"];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    if (!["--data", "--out", "--now"].includes(a)) return { error: a.startsWith("--") ? `unknown option ${a}` : `unexpected argument ${clean(a, 40)}` };
    const v = inline !== undefined ? inline : argv[++i];
    if (v === undefined) return { error: `${a} needs a value` };
    if (opts[a] !== undefined) return { error: `${a} can be given once` };
    opts[a] = v;
  }
  return { opts };
}

// ── Entry ───────────────────────────────────────────────────────────────────
// collectData is the function behind the command (the page script calls it too). options: { data (an absolute path),
// now (epoch ms, default the clock), out (a file that will be written, only checked here), fd, maxTotalRead }. It
// writes nothing. It returns { ok: true, data, text, projects, sessions } (data is the result, text the JSON as printed)
// or { ok: false, code, message, usage } (usage is true for a command line mistake, exit 2). A failure nobody planned
// for is reported by its code only (never a stack, which would carry absolute paths).
export async function collectData(options = {}) {
  try {
    return await gather(options);
  } catch (e) {
    return { ok: false, code: 1, message: `unexpected failure (${codeOf(e)}); nothing was written` };
  } finally {
    redactor = null;
  }
}

async function gather(options) {
  const ctx = { fd: options.fd, maxTotalRead: options.maxTotalRead, readBytes: 0, caseInsensitive: options.caseInsensitive };
  const usage = (message) => ({ ok: false, code: 2, usage: true, message });
  const failed = (message) => ({ ok: false, code: 1, message });
  if (typeof options.data !== "string" || !options.data || !isAbsolute(options.data)) return usage("--data must be an absolute path");
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  if (!(nowMs >= 0 && nowMs <= MS_MAX)) return usage("--now is out of range");

  const reader = await loadReader();
  if (reader.fail) return failed(reader.fail);

  const dir = resolve(options.data);
  const info = inspectDir(dir);
  if (info.fail) return failed(`cannot use the data folder (${info.fail}); nothing was read`);
  const realData = info.exists ? realpathOrNull(dir) : null;
  if (options.out !== undefined) {
    const why = outProblem(options.out, dir, realData);
    if (why) return usage(`--out ${why}; nothing was written`);
  }
  const errors = [];
  const config = loadConfig(dir, ctx);
  if (config.error) errors.push({ file: "dashboard.json", reason: `${config.error}; the default thresholds were used` });
  const reg = info.exists ? loadRegistry(dir, ctx) : { projects: [] };
  if (reg.fail) return failed(`projects.json: ${reg.fail}; nothing was read`);
  const history = info.exists ? loadHistory(dir, ctx) : { records: [] };
  if (history.fail) errors.push({ file: "history.jsonl", reason: history.fail });
  // From here to the end nothing waits, so the redactor is set for this run only.
  const redact = makeRedactor([...reg.projects.map((p) => p.path), dir, ...(realData ? [realData] : []), homedir()]);
  redactor = redact;

  // Sessions first, so the output budget can be reserved for them.
  const known = new Set(reg.projects.map((p) => p.id));
  const sess = info.exists ? readSessions(dir, known, config, nowMs, ctx) : { sessions: [], errors: [], skewed: new Set() };
  errors.push(...sess.errors);
  if (sess.dropped > 0) errors.unshift({ file: "sessions", reason: `${sess.dropped} session(s) left out: more than ${MAX_SESSIONS} live sessions, the newest were kept` });
  // Files never opened because of the read limit are usually old, finished sessions: a quiet note (fixed words, a count), not an error.
  const notes = sess.unread > 0 ? [`${sess.unread} older session file(s) not opened (only the newest ${MAX_SESSION_READS} are read)`] : [];
  const warnings = [];
  for (const id of known) {
    if (sess.sessions.filter((s) => s.project === id && (s.shown === "Working" || s.shown === "Waiting for you")).length > 1) warnings.push({ kind: "same project, more than one open session", project: id });
  }
  for (const id of known) if (sess.skewed?.has(id)) warnings.push({ kind: "clock skew", project: id });

  const projects = [];
  // The size of a value as it will be printed: two-space indentation, plus the four spaces of nesting inside "projects".
  const printed = (v, nest) => { const t = safeJson(v, 2); return Buffer.byteLength(t) + (t.split("\n").length * nest); };
  let budget = MAX_OUT_BYTES - 128 * 1024 - printed(sess.sessions.slice(0, MAX_SESSIONS), 2);
  for (const p of reg.projects.slice(0, MAX_PROJECTS)) {
    const item = readProject(p, reader, ctx);
    const labels = new Set(p.labels.filter((l) => typeof l === "string"));
    item.history = history.records.filter((r) => labels.has(r.project)).slice(-MAX_HISTORY).map(historyRow);
    // A session's estimate is the calibrated hours of the row with the same phase id (letter case ignored) in the roadmap
    // the session belongs to (its roadmap field; its letter case is ignored only where the file system ignores it). A session with no roadmap field,
    // or one that names a file the project does not list, takes the first roadmap that has the phase id. Only standard
    // roadmaps count: a file that is not standard is not drawn, and gives no estimate.
    const fold = ctx.caseInsensitive ?? CASE_INSENSITIVE;
    const hoursIn = (r, id) => r.phases.find((ph) => ph.id.toLowerCase() === id && ph.estimateH !== null)?.estimateH ?? null;
    for (const s of sess.sessions) {
      if (s.project !== p.id) continue;
      const id = s.phase.toLowerCase();
      const own = s.roadmap ? item.roadmaps.find((r) => r.file === s.roadmap) ?? (fold ? item.roadmaps.find((r) => r.file.toLowerCase() === s.roadmap.toLowerCase()) : undefined) : undefined;
      if (s.roadmap?.startsWith(UNLISTED_PREFIX)) s.estimateH = null;
      else if (own) s.estimateH = own.standard === true ? hoursIn(own, id) : null;
      else s.estimateH = item.roadmaps.filter((r) => r.standard === true).reduce((found, r) => found ?? hoursIn(r, id), null);
    }
    let size = printed(item, 4);
    if (size > budget) {
      item.roadmaps = [];
      item.history = [];
      item.errors = [{ file: "(output)", reason: "left out: the output would be over 2 MB" }];
      size = printed(item, 4);
    }
    item.summary = summaryOf(item, sess.sessions);
    budget -= size;
    projects.push(item);
  }

  const result = {
    v: 1,
    generatedAt: new Date(nowMs).toISOString(),
    thresholds: { warnMin: config.warnMin, idleMin: config.idleMin },
    projects,
    sessions: sess.sessions.slice(0, MAX_SESSIONS),
    warnings,
    errors: errors.slice(0, 50),
    ...(notes.length ? { notes } : {}),
  };
  // The known forms of this machine's paths become [path] inside string values (never keys), then the
  // text is written with < > & as \u escapes and parsed once more before it leaves.
  const text = `${safeJson(scrubbed(result, redact), 2)}\n`;
  let data;
  try { data = JSON.parse(text); } catch { return failed("the output could not be made safe; nothing was printed or written"); }
  if (Buffer.byteLength(text) > MAX_OUT_BYTES) return failed("the output is over 2 MB; nothing was printed or written");
  return { ok: true, data, text, projects: projects.length, sessions: result.sessions.length };
}

// A failure nobody planned for is reported by its code only (never a stack, which would carry absolute paths).
export async function main(argv, io = {}) {
  try {
    return await execute(argv, io);
  } catch (e) {
    (io.err ?? ((m) => console.error(m)))(`unexpected failure (${codeOf(e)}); nothing was written`);
    return 1;
  }
}

async function execute(argv, io) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const usage = (msg) => { err(msg); for (const l of USAGE) err(l); return 2; };
  const parsed = parseArgs(argv);
  if (parsed.error) return usage(parsed.error);
  const { opts } = parsed;
  if (opts["--data"] === undefined) return usage("--data <dir> is required");
  if (!opts["--data"] || !isAbsolute(opts["--data"])) return usage("--data must be an absolute path");
  if (opts["--now"] !== undefined && !/^\d{1,16}$/.test(opts["--now"])) return usage("--now must be a whole number of milliseconds since 1970");
  const nowMs = opts["--now"] !== undefined ? Number(opts["--now"]) : Number.isFinite(io.now?.()) ? io.now() : Date.now();

  const got = await collectData({ data: opts["--data"], now: nowMs, out: opts["--out"], fd: io.fd, maxTotalRead: io.maxTotalRead, caseInsensitive: io.caseInsensitive });
  if (!got.ok) {
    if (got.usage) return usage(got.message);
    err(got.message);
    return got.code;
  }
  if (opts["--out"] === undefined) { out(got.text.replace(/\n$/, "")); return 0; }
  const target = resolve(opts["--out"]);
  const failed = writeAtomic(target, got.text, { rename: io.rename });
  if (failed) { err(`cannot write ${clean(basename(target), 80)} (${failed}); nothing was written`); return 1; }
  out(`wrote ${clean(basename(target), 80)}: ${got.projects} project(s), ${got.sessions} session(s)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
