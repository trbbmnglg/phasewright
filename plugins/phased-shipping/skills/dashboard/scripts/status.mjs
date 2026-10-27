#!/usr/bin/env node
// The dashboard's status files: an on/off setting, a local list of projects and one small file per running phase.
// It uses node built-ins only, sends nothing anywhere and reads or writes nothing outside the data folder, except that
// it resolves the project folder it is told about (a real path, nothing is read inside it).
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
//   sessions/<id>-<phase>.json  { v, project, phase, phase_name, step, state, step_started, updated }, at most 16 KB.
// <id> is the first 12 hex digits of the SHA-256 of the project's real path (lower-cased on Windows). A session file
// name is built only from that id and a phase id that matches [A-Za-z0-9._-]{1,40} and is not only dots, lower-cased
// (so 7a and 7A are one file everywhere): no other text reaches a path.
// Text fields are cleaned (control, bidirectional, zero-width, tag and other format characters become spaces, one
// line, at most 200 characters; labels and names 80). Every write is a temp file in the same folder, flushed, then a
// rename (retried a few times on Windows). A failure leaves the old file whole.
//
// main(argv, io) is the test seam: io.out, io.err, io.now (epoch ms), io.rename (replaces the rename step),
// io.maxSessionBytes, io.fd = { open, fstat, read, close } (every file of ours is opened and read through these, once
// and checked on the open descriptor; each is optional). Nothing in the command line, the environment or a file can reach it.

import { lstatSync, realpathSync, statSync, mkdirSync, openSync, fstatSync, readSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, constants as fsConstants } from "node:fs";
import { basename, dirname, join, resolve, isAbsolute } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const FILE_MODE = WIN ? undefined : 0o600;
const DIR_MODE = WIN ? undefined : 0o700;
const MAX_PROJECTS = 100;
const MAX_LABELS = 20;
const MAX_ROADMAPS = 10;
const MAX_SESSION_BYTES = 16 * 1024;
const MAX_CONFIG_BYTES = 4096;
const MAX_REGISTRY_BYTES = 512 * 1024;
const STEPS = ["baseline", "build", "compare", "review", "preview", "approve", "ship", "prod-check"];
const STATES = ["working", "waiting", "done"];
const PHASE_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,40}$/;
const ID_RE = /^[0-9a-f]{12}$/;
const DEFAULT_ROADMAP = "PHASES.md";
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
  if (s.split("/").some((p) => /^\.+$/.test(p) || p !== p.trim() || p.endsWith("."))) return null;
  return /\.md$/i.test(s) ? s : null;
}

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
    if (!Array.isArray(p.roadmaps) || p.roadmaps.length > MAX_ROADMAPS || !p.roadmaps.every((r) => roadmapOf(r) !== null)) return bad;
    if (projects.some((q) => q.id === p.id)) return bad;
    projects.push({ id: p.id, path: p.path, name: clean(p.name, 80), labels: p.labels.map((l) => clean(l, 80)).filter(Boolean), roadmaps: p.roadmaps.map(roadmapOf), added: clean(p.added, 40) });
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

function resolveProject(rootArg) {
  try {
    const real = realpathSync.native(resolve(rootArg));
    if (!statSync(real).isDirectory()) throw new Error("not a folder");
    return { real, id: idOf(real), name: clean(basename(real), 80) || "project" };
  } catch {
    return { fail: "cannot use --root: it is not an existing folder" };
  }
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
function registerProject(projects, proj, labels, roadmaps, nowMs) {
  let entry = projects.find((p) => p.id === proj.id);
  let changed = false;
  if (!entry) {
    if (projects.length >= MAX_PROJECTS) return { fail: `the project list is full (${MAX_PROJECTS}); unregister one first` };
    entry = { id: proj.id, path: proj.real, name: proj.name, labels: [], roadmaps: [DEFAULT_ROADMAP], added: new Date(nowMs).toISOString() };
    projects.push(entry);
    changed = true;
  }
  if (mergeInto(entry.labels, labels, MAX_LABELS)) changed = true;
  if (mergeInto(entry.roadmaps, roadmaps, MAX_ROADMAPS, (a, b) => keyOf(a) === keyOf(b))) changed = true;
  return { entry, changed };
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
  const proj = resolveProject(opts["--root"][0]);
  if (proj.fail) return fail(err, proj.fail);
  const reg = loadRegistry(dir, io);
  if (reg.fail) return fail(err, `${reg.fail}; nothing was changed`);
  const res = registerProject(reg.projects, proj, labels, roadmaps, io.nowMs);
  if (res.fail) return fail(err, res.fail);
  if (res.changed) {
    const failed = saveRegistry(dir, reg.projects, io);
    if (failed) return fail(err, `${failed}; nothing was changed`);
  }
  out(`${res.changed ? "registered" : "already listed"}: ${res.entry.name} (id ${res.entry.id})`);
  return 0;
}

function unregisterCommand(dir, id, io, out, err) {
  if (!ID_RE.test(id)) { err("an id is 12 lower-case hex digits, as `list` prints it"); return 2; }
  const reg = loadRegistry(dir, io);
  if (reg.fail) return fail(err, `${reg.fail}; nothing was changed`);
  const at = reg.projects.findIndex((p) => p.id === id);
  if (at < 0) return fail(err, "no project with that id; nothing was changed");
  const [gone] = reg.projects.splice(at, 1);
  const failed = saveRegistry(dir, reg.projects, io);
  if (failed) return fail(err, `${failed}; nothing was changed`);
  out(`removed: ${gone.name} (id ${gone.id}); its session files, if any, stay until they are cleared`);
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

function sessionName(id, phase) {
  return `${id}-${phase.toLowerCase()}.json`;
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
  const proj = resolveProject(opts["--root"][0]);
  if (proj.fail) return fail(err, proj.fail);
  const reg = loadRegistry(dir, io);
  if (reg.fail) return fail(err, `${reg.fail}; nothing was written`);
  const res = registerProject(reg.projects, proj, labels, [], io.nowMs);
  if (res.fail) return fail(err, `${res.fail}; nothing was written`);
  const sdir = join(dir, "sessions");
  const made = ensureDir(sdir, false);
  if (made.fail) return fail(err, `${made.fail}; nothing was written`);
  const file = sessionName(proj.id, phase);
  const prev = readOwn(sdir, file, MAX_SESSION_BYTES, io);
  if (prev.fail && prev.hard) return fail(err, `${prev.fail}; nothing was written`);
  const old = prev.value !== undefined && !prev.fail && isObj(prev.value) ? prev.value : null;
  const sameStep = old && old.step === step && Number.isFinite(old.step_started);
  const name = opts["--name"] ? clean(opts["--name"][0], 200) : typeof old?.phase_name === "string" ? clean(old.phase_name, 200) : "";
  const session = { v: 1, project: proj.id, phase, phase_name: name, step, state, step_started: sameStep ? old.step_started : io.nowMs, updated: io.nowMs };
  const text = json(session);
  if (Buffer.byteLength(text) > (io.maxSessionBytes ?? MAX_SESSION_BYTES)) return fail(err, "the session file would be over 16 KB; nothing was written");
  if (res.changed) {
    const failed = saveRegistry(dir, reg.projects, io);
    if (failed) return fail(err, `${failed}; nothing was written`);
  }
  const failed = writeAtomic(join(sdir, file), text, io);
  if (failed) return fail(err, `session file: ${failed}; nothing was written`);
  out(`status set: phase ${phase} ${step} ${state}`);
  return 0;
}

function clearCommand(dir, opts, config, out, err) {
  const phase = opts["--phase"][0];
  if (!PHASE_RE.test(phase)) { err("--phase must be 1 to 40 characters from A-Z a-z 0-9 . _ -"); return 2; }
  if (!config.enabled) { out(OFF_NOTE); return 0; }
  const proj = resolveProject(opts["--root"][0]);
  if (proj.fail) return fail(err, proj.fail);
  const sdir = join(dir, "sessions");
  const info = inspectDir(sdir);
  if (info.fail) return fail(err, `${info.fail}; nothing was changed`);
  if (!info.exists) { out("no status file to clear"); return 0; }
  const path = join(sdir, sessionName(proj.id, phase));
  try {
    const st = lstatOrNull(path);
    if (!st) { out("no status file to clear"); return 0; }
    if (!st.isFile()) return fail(err, "the status file is not a regular file; nothing was changed");
    rmSync(path);
  } catch (e) {
    return fail(err, `status file: ${codeOf(e)}; nothing was changed`);
  }
  out(`status cleared: phase ${phase}`);
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────────────
// A failure nobody planned for is reported by its code only (never a stack, which would carry absolute paths).
export function main(argv, io = {}) {
  try {
    return execute(argv, io);
  } catch (e) {
    (io.err ?? ((m) => console.error(m)))(`unexpected failure (${codeOf(e)}); nothing more was written`);
    return 1;
  }
}

function execute(argv, io) {
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
  const ctx = { ...io, nowMs };

  const dir = resolve(opts["--data"][0]);
  const info = inspectDir(dir);
  if (info.fail) return fail(err, `cannot use the data folder (${info.fail}); nothing was written`);
  const loaded = info.exists ? loadConfig(dir, ctx) : { config: { ...DEFAULT_CONFIG } };
  if (loaded.fail) return fail(err, `${loaded.fail}; nothing was written`);
  const config = loaded.config;

  if (cmd === "state") return stateCommand(config, out);
  if (cmd === "enable" || cmd === "disable" || cmd === "asked") return switchCommand(dir, cmd, config, ctx, out, err);
  if (cmd === "register") return registerCommand(dir, opts, config, ctx, out, err);
  if (cmd === "unregister") return unregisterCommand(dir, pos[0], ctx, out, err);
  if (cmd === "list") return listCommand(dir, opts, ctx, out, err);
  if (cmd === "set") return setCommand(dir, opts, config, ctx, out, err);
  return clearCommand(dir, opts, config, out, err);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
