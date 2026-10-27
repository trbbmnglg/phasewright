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
// warnings: [...], errors: [...] }, described in references/status.md. No path the tool builds is put in it: files are
// relative to their project or base names. Every text value is cleaned (control, bidirectional, zero-width, tag and
// other format characters become spaces, one line, capped) and is untrusted plain text for whoever reads it. Text
// copied from a file is shown as written, but the known forms of this machine's registered project paths, the data
// folder path and the home folder path in it (and of <drive>:\Users\<name>, /c/Users/<name>, /Users/<name> and
// /home/<name>) become [path], in string values only (never in a key); other spellings of a path may remain. The
// JSON is written with < > & and U+2028, U+2029 as \u escapes, so it is safe to inline in a script and parses to the
// same values. Caps: 100
// projects, 200 sessions, 300 phases and 500 history records per project, 2 MB of output. The result is parsed again
// before anything is printed or written.
//
// A session whose updated time is more than 5 minutes ahead of the clock, or whose step_started is after updated,
// is clock-skewed: it is shown as Idle with noUpdate true, its project gets a "clock skew" warning, and it never
// counts as an open session.
//
// A run reads at most 64 MB of project files in all (a file past that is skipped and reported).
//
// main(argv, io) is the test seam (async, because the reader is imported): io.out, io.err, io.now (epoch ms),
// io.fd = { open, fstat, read, close } (every file is opened and read through these; each is optional), io.rename,
// io.maxTotalRead. Nothing in the command line, the environment or a file can reach it.

import { readdirSync, lstatSync, realpathSync, statSync, openSync, fstatSync, readSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const WIN = process.platform === "win32";
const HERE = dirname(fileURLToPath(import.meta.url));
const FILE_MODE = WIN ? undefined : 0o600;
const MAX_PROJECTS = 100;
const MAX_SESSIONS = 200;
const MAX_PHASES = 300;
const MAX_HISTORY = 500;
const MAX_LABELS = 20;
const MAX_ROADMAPS = 10;
const MAX_PROJECT_FILE = 256 * 1024;
const MAX_SESSION_BYTES = 16 * 1024;
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
const SESSION_FILE_RE = /^([0-9a-f]{12})-([A-Za-z0-9._-]{1,40})\.json$/;
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
  if (s.split("/").some((p) => /^\.+$/.test(p) || p !== p.trim() || p.endsWith("."))) return null;
  return /\.md$/i.test(s) ? s : null;
}

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
  for (const rawRel of p.roadmaps) {
    const rel = roadmapOf(rawRel);
    if (!rel) { errors.add(basename(String(rawRel).replace(/\\/g, "/")), "not a usable roadmap path"); continue; }
    const got = readProjectFile(real, rel, io);
    if (got.skip) { errors.add(basename(rel), got.skip); continue; }
    let read;
    try { read = reader.toReadJson(reader.parseRoadmap(got.text), basename(rel)); } catch { errors.add(basename(rel), "could not be read as a roadmap"); continue; }
    const phases = [];
    for (const row of read.tables.flatMap((t) => t.phases)) {
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
        actual: typeof row.actual === "number" ? row.actual : null,
        commit: cleanOrNull(row.commit, 80),
        planFile,
        timestamps,
      });
    }
    base.roadmaps.push({ file: clean(rel, 200), tables: read.tables.length, phases });
  }
  base.errors = errors.list;
  return base;
}

// ── Sessions ────────────────────────────────────────────────────────────────
// Returns { sessions, errors, skewed } from <data>/sessions (skewed: the ids of projects with a clock-skewed session).
// A bad file is skipped and named by base name only.
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
  let taken = 0;
  for (const name of names) {
    if (TEMP_FILE_RE.test(name)) continue;
    const m = name.match(SESSION_FILE_RE);
    if (!m) { skip(name, "not a session file name"); continue; }
    if (taken >= MAX_SESSIONS) { skip("sessions", `more than ${MAX_SESSIONS} session files; the rest were left out`); break; }
    taken++;
    const [, id, phase] = m;
    const got = readOwnText(sdir, name, MAX_SESSION_BYTES, io);
    if (got.fail || got.text === undefined) { skip(name, got.fail ?? "gone"); continue; }
    let v;
    try { v = JSON.parse(got.text); } catch { skip(name, "not valid JSON"); continue; }
    const ms = (n) => Number.isInteger(n) && n >= 0 && n <= MS_MAX;
    if (!isObj(v) || v.v !== 1 || typeof v.project !== "string" || typeof v.phase !== "string" || typeof v.phase_name !== "string") { skip(name, "not the expected shape"); continue; }
    // Phase ids are compared without regard to letter case (7a and 7A share one file on every system).
    if (v.project !== id || !PHASE_ID_RE.test(v.phase) || v.phase.toLowerCase() !== phase.toLowerCase()) { skip(name, "its content does not match its file name"); continue; }
    if (!STEPS.includes(v.step)) { skip(name, "unknown step"); continue; }
    if (!STATES.includes(v.state)) { skip(name, "unknown state"); continue; }
    if (!ms(v.step_started) || !ms(v.updated)) { skip(name, "a time is not a whole number of milliseconds"); continue; }
    if (!known.has(id)) continue;
    const age = nowMs - v.updated;
    // A time in the future (more than 5 minutes ahead), or a step that started after its last update, means a wrong clock.
    const skew = v.updated - nowMs > CLOCK_AHEAD_MS || v.step_started > v.updated;
    if (skew) skewed.add(id);
    const idle = skew || age >= config.idleMin * 60000;
    sessions.push({
      project: id,
      phase: v.phase,
      phase_name: clean(v.phase_name, 200),
      step: v.step,
      state: v.state,
      shown: idle ? "Idle" : SHOWN[v.state],
      noUpdate: skew || (v.state === "working" && age >= config.warnMin * 60000),
      updated: v.updated,
      step_started: v.step_started,
    });
  }
  return { sessions, errors, skewed };
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

// Why a --out target must not be written, or null. It is refused when the real folder it would sit in is the data
// folder or inside it (the output must never replace the status files), or when a real path is already there and is
// inside the data folder or is not a regular file. A folder that is not there is left to the write, which fails.
function outProblem(target, dir, realData) {
  let parent;
  try { parent = realpathSync.native(dirname(target)); } catch { return null; }
  const roots = [dir, ...(realData ? [realData] : [])];
  if (roots.some((r) => insideOf(r, parent))) return "must not be in the data folder";
  let st;
  try { st = lstatOrNull(target); } catch { return null; }
  if (!st) return null;
  let real;
  try { real = realpathSync.native(target); } catch { return null; }
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
// A failure nobody planned for is reported by its code only (never a stack, which would carry absolute paths).
export async function main(argv, io = {}) {
  try {
    return await execute(argv, io);
  } catch (e) {
    (io.err ?? ((m) => console.error(m)))(`unexpected failure (${codeOf(e)}); nothing was written`);
    return 1;
  } finally {
    redactor = null;
  }
}

async function execute(argv, io) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const ctx = { fd: io.fd, rename: io.rename, maxTotalRead: io.maxTotalRead, readBytes: 0 };
  const usage = (msg) => { err(msg); for (const l of USAGE) err(l); return 2; };
  const parsed = parseArgs(argv);
  if (parsed.error) return usage(parsed.error);
  const { opts } = parsed;
  if (opts["--data"] === undefined) return usage("--data <dir> is required");
  if (!opts["--data"] || !isAbsolute(opts["--data"])) return usage("--data must be an absolute path");
  if (opts["--now"] !== undefined && !/^\d{1,16}$/.test(opts["--now"])) return usage("--now must be a whole number of milliseconds since 1970");
  const nowMs = opts["--now"] !== undefined ? Number(opts["--now"]) : Number.isFinite(io.now?.()) ? io.now() : Date.now();
  if (!(nowMs >= 0 && nowMs <= MS_MAX)) return usage("--now is out of range");

  const reader = await loadReader();
  if (reader.fail) { err(reader.fail); return 1; }

  const dir = resolve(opts["--data"]);
  const info = inspectDir(dir);
  if (info.fail) { err(`cannot use the data folder (${info.fail}); nothing was read`); return 1; }
  const realData = info.exists ? realpathOrNull(dir) : null;
  if (opts["--out"] !== undefined) {
    const why = outProblem(resolve(opts["--out"]), dir, realData);
    if (why) return usage(`--out ${why}; nothing was written`);
  }
  const errors = [];
  const config = loadConfig(dir, ctx);
  if (config.error) errors.push({ file: "dashboard.json", reason: `${config.error}; the default thresholds were used` });
  const reg = info.exists ? loadRegistry(dir, ctx) : { projects: [] };
  if (reg.fail) { err(`projects.json: ${reg.fail}; nothing was read`); return 1; }
  const history = info.exists ? loadHistory(dir, ctx) : { records: [] };
  if (history.fail) errors.push({ file: "history.jsonl", reason: history.fail });
  // From here to the end nothing waits, so the redactor is set for this run only.
  const redact = makeRedactor([...reg.projects.map((p) => p.path), dir, ...(realData ? [realData] : []), homedir()]);
  redactor = redact;

  // Sessions first, so the output budget can be reserved for them.
  const known = new Set(reg.projects.map((p) => p.id));
  const sess = info.exists ? readSessions(dir, known, config, nowMs, ctx) : { sessions: [], errors: [], skewed: new Set() };
  errors.push(...sess.errors);
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
    let size = printed(item, 4);
    if (size > budget) {
      item.roadmaps = [];
      item.history = [];
      item.errors = [{ file: "(output)", reason: "left out: the output would be over 2 MB" }];
      size = printed(item, 4);
    }
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
  };
  // The known forms of this machine's paths become [path] inside string values (never keys), then the
  // text is written with < > & as \u escapes and parsed once more before it leaves.
  const text = `${safeJson(scrubbed(result, redact), 2)}\n`;
  try { JSON.parse(text); } catch { err("the output could not be made safe; nothing was printed or written"); return 1; }
  if (Buffer.byteLength(text) > MAX_OUT_BYTES) { err("the output is over 2 MB; nothing was printed or written"); return 1; }

  if (opts["--out"] === undefined) { out(text.replace(/\n$/, "")); return 0; }
  const target = resolve(opts["--out"]);
  const failed = writeAtomic(target, text, ctx);
  if (failed) { err(`cannot write ${clean(basename(target), 80)} (${failed}); nothing was written`); return 1; }
  out(`wrote ${clean(basename(target), 80)}: ${projects.length} project(s), ${result.sessions.length} session(s)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
