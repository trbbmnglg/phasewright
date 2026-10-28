#!/usr/bin/env node
// Writes the dashboard as one self-contained HTML file: a progress sheet with a row for each project, and inside each
// project its sessions (each with the eight gates of a phase and the loops back), its roadmap, its estimate against
// actual and its archived sessions. It uses node built-ins and the collect script next to it, sends nothing anywhere
// and writes nothing except the one page.
//
//   node page.mjs --data <dir> [--out <file>] [--now <epoch ms>] [--no-fonts] [--refresh-s <5-300>]
//
// --data must be an absolute path (an empty or relative one is a usage error, exit 2, nothing read or written). The
// data is read by collectData (collect.mjs), so every rule of that script holds: nothing here opens a file of the data
// folder, and no path the tool builds appears in the page (text copied from your files is shown as written; the known
// path forms of this machine are replaced, so do not put paths in plan text). The page is written to
// <data>/dashboard.html unless --out names another file; --out is refused (exit 2) when it is inside the data folder
// under any name or route (a link, a junction, or a network path such as \\host\share), and the data folder is never
// created (it has to be there for the default file, or the page is not written and exit is 1). The write is atomic:
// a temp file in the same folder, flushed, then a rename (retried on Windows). A page over 1 MB is not written (fail
// closed). Between 256 KB and 1 MB the page is kept small instead: see "A big page" below.
//
// The page is rendered on the server, with plain string functions. Every text is cleaned (control, bidirectional,
// zero-width, tag and other format characters become spaces, one line, capped) and then escaped, and is put only in
// element text or a double-quoted attribute: none of it goes into the script, the style, an address, an id or an event
// handler, and there is no JSON in the page. Ids and the keys the script stores are generated (a letter and ten hex
// digits). The one script is the file assets/client.js, and the page's Content-Security-Policy names its SHA-256.
//
// Only standardized roadmaps are drawn (strict): a roadmap file counts when it has at least one table and every table has the
// marker line, as the collector reports in each roadmap's `standard` field (a missing field means not standard). The files
// that are not are named in one note inside their project, never drawn; the estimate part still works from the history.
//
// Layout, nested with native details elements: a project row (closed, with a one-line summary), and inside it the
// sessions, a Roadmap part, an Estimate against actual part and an Archived sessions part. A project with a working or
// waiting session starts open. The only things that move are the in-progress hatching (the running gate of a working session, the in-progress mark of a roadmap row, the in-progress segment of a project's roadmap bar), the header rule while a session is working (class has-working on the sheet, decided here from the data) and the arrow of the loop that is active right now; all of it is CSS, declared only for a screen with no reduced-motion request, and the paused class (set by the Pause button) stops it. The hatching moves by transform only (a pseudo-element, clipped by its parent, one tile to the right), never by background-position, which a browser repaints on its main thread. When the page has more than 25 moving things it carries the class calm and only the header rule and the running gates of working sessions move.
//
// A big page: when the page would be over 256 KB, the Roadmap and Estimate against actual parts of the projects that have no
// working or waiting session are replaced by one short note ("left out to keep the page small: N rows; the dashboard JSON
// still has them"), the project with the most to save first, until the page is under 256 KB or nothing is left to drop;
// if it is still over, the same is done for the projects with a running session, the project with the most to save first.
// The project row, the sessions (a waiting one always) and the archived sessions always stay, and the page says in a
// visible line that it left something out. A page still over 1 MB with every table left out is not written.
//
// Fonts: assets/pw-sans.woff2 and assets/pw-mono.woff2 are subsets of IBM Plex Sans and Plex Mono under the SIL Open Font
// License 1.1 (assets/OFL.txt), renamed PW Sans and PW Mono (only their copyright and licence records keep the Plex notice); they are embedded as data: urls unless --no-fonts is given.
//
// status.mjs rebuilds the page after a `set`, `clear` or `unregister` while the dashboard is on, through buildPage(dir, io) below: it is
// given the data folder only and writes only <data>/dashboard.html.
//
// main(argv, io) is the test seam (async): io.out, io.err, io.now (epoch ms), io.rename, io.fd, io.maxTotalRead (both
// handed to collectData), io.caseInsensitive (handed to both collectData and the page) and io.maxPageBytes. Nothing in the command line, the environment or a file can reach it.

import { lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve, isAbsolute } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { collectData } from "./collect.mjs";

const WIN = process.platform === "win32";
// Windows and macOS (by default) do not tell Docs and docs apart; elsewhere the letter case of a roadmap path counts (seam: io.caseInsensitive).
const CASE_INSENSITIVE = WIN || process.platform === "darwin";
const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "..", "assets");
const FILE_MODE = WIN ? undefined : 0o600;
const SOFT_PAGE_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 128 * 1024;
const STEPS = ["baseline", "build", "compare", "review", "preview", "approve", "ship", "prod-check"];
const STATES = ["working", "waiting", "done"];
const STEP_NAMES = { baseline: "Baseline", build: "Build", compare: "Compare", review: "Review", preview: "Preview", approve: "Approve", ship: "Ship", "prod-check": "Prod check" };
const STATE_WORDS = { working: "Working", waiting: "Waiting for you", done: "Done", idle: "Idle" };
const MARKS = { working: "mk-w", waiting: "mk-q", done: "mk-d", idle: "mk-i" };
const ORDER = { waiting: 0, working: 1, idle: 2, done: 3 };
const MS_MAX = 8.64e15;
// The written time must have a four-digit year: from 1970 to the end of 9999.
const GENERATED_MIN = 0;
const GENERATED_MAX = 253402300799999;
const CLOCK_AHEAD_MS = 5 * 60000;
const TRUNC_AT = 26;
const MAX_LOOPS_DRAWN = 8;
const MAX_MOVING = 25;
// The page says it is stale when it has not been rewritten for this long: the same 90 minutes as the "No update" warning.
// The page attribute, the placeholder in the banner and the script's own default all come from this one number.
const PAGE_STALE_MIN = 90;
const FONT_NOTICE = [
  "Fonts: PW Sans and PW Mono are subsets of IBM Plex Sans and IBM Plex Mono, Copyright 2017 IBM Corp., Reserved Font Name \"Plex\".",
  "They are licensed under the SIL Open Font License, Version 1.1 (OFL-1.1). As that licence requires, the subsets are Modified Versions",
  "and are renamed PW Sans and PW Mono. The licence text is the file OFL.txt in the assets folder of the dashboard skill.",
].join("\n");

const cp = (n) => String.fromCodePoint(n);
const MINUS = cp(0x2212);
const MIDDOT = cp(0x00b7);
// Control, C1, line-separator, bidirectional, zero-width, tag and every other Unicode format (Cf) character.
const UNSAFE_TEXT = new RegExp(
  `[${cp(0)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x61c)}${cp(0x200b)}-${cp(0x200f)}${cp(0x2028)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2069)}${cp(0xfeff)}${cp(0xe0000)}-${cp(0xe007f)}\\p{Cf}]`,
  "gu",
);
// Plain one-line text, at most n characters.
const clean = (s, n = 200) => Array.from(String(s ?? "").slice(0, n * 4).replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim()).slice(0, n).join("");
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
// A text from the data as it goes into the page: cleaned, then escaped. The only way text gets in.
const txt = (v, n = 200) => esc(clean(typeof v === "string" || typeof v === "number" ? v : "", n));
const num = (v) => (Number.isFinite(v) ? String(Math.max(-1e15, Math.min(1e15, v))) : "0");
const fix1 = (v) => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : "0.0");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const ms = (v) => (Number.isFinite(v) && v >= 0 && v <= MS_MAX ? Math.floor(v) : 0);
const hours = (v) => (Number.isFinite(v) && v >= 0 && v <= 100000 ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 1e6 ? v : 0);
// A figure from the collector's summary: a whole number of zero or more (at most a million), else null (the page counts the rows itself).
const UNLISTED_PREFIX = "(unlisted:";
const whole = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 1e6) : null);
// The collector lists at most 10 names of files that are not standard; a count above 10,000 is not believed.
const MAX_LEGACY_NAMES = 10;
const MAX_LEGACY_COUNT = 10000;
const codeOf = (e) => e?.code ?? "error";

// A generated id: a letter and ten hex digits from the hash of the parts. Text never reaches an id.
const slug = (prefix, ...parts) => `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 10)}`;

// "1 h 05 min", "17 min", "40 s": the same wording the script in the page uses.
function dur(msec) {
  const s = Math.max(0, Math.floor(msec / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
// The clock time on this machine, as the script in the page shows it.
const clockText = (t) => { const d = new Date(t); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":"); };
const thresholdText = (min) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`);
const signed = (v) => (Math.abs(v) < 0.05 ? "0.0 h" : `${v < 0 ? MINUS : "+"}${fix1(Math.abs(v))} h`);

// ── The data, checked ───────────────────────────────────────────────────────
// The page trusts nothing in the data it is given: every field is checked for its type and range, every text is a
// string cleaned to one line, and what does not fit is left out or becomes a zero or an empty text.
function loopsOf(raw) {
  const out = [];
  for (const l of list(raw, 40)) {
    if (!isObj(l) || !STEPS.includes(l.from) || !STEPS.includes(l.to) || STEPS.indexOf(l.to) >= STEPS.indexOf(l.from)) continue;
    const n = Number.isInteger(l.count) && l.count >= 1 && l.count <= 99 ? l.count : 1;
    out.push({ from: l.from, to: l.to, count: n, active: l.active === true && !out.some((o) => o.active) });
  }
  return out;
}

function visitsOf(raw, step) {
  const out = {};
  if (isObj(raw)) for (const s of STEPS) if (Number.isInteger(raw[s]) && raw[s] >= 1 && raw[s] <= 99) out[s] = raw[s];
  if (!out[step]) out[step] = 1;
  return out;
}

function sessionOf(s) {
  if (!isObj(s) || !STEPS.includes(s.step) || !STATES.includes(s.state)) return null;
  return {
    project: clean(s.project, 12),
    roadmap: clean(s.roadmap, 200),
    phase: clean(s.phase, 40),
    name: clean(s.phase_name, 200),
    step: s.step,
    state: s.state,
    idleShown: s.shown === "Idle",
    updated: ms(s.updated),
    started: ms(s.step_started),
    loops: loopsOf(s.loops),
    visits: visitsOf(s.visits, s.step),
    rounds: Number.isInteger(s.rounds) && s.rounds >= 1 && s.rounds <= 99 ? s.rounds : 1,
    workedMs: ms(s.workedMs),
    elapsedMs: ms(s.elapsedMs),
    estimateH: hours(s.estimateH),
    archived: s.archived === true,
  };
}

function projectOf(p, fold = CASE_INSENSITIVE) {
  if (!isObj(p)) return null;
  // Strict display: only a roadmap file the collector marked standard (standard: true) is drawn. A file with no such field
  // (data from before the field existed) is not standard. The others are only named, in one note, with a count.
  // Entries that are the same path (a backslash, or another letter case where the file system ignores it) are drawn once, the first.
  const seenFiles = new Set();
  const entries = list(p.roadmaps, 10).filter(isObj).filter((r) => {
    const key = clean(r.file, 200).replace(/\\/g, "/");
    const folded = fold ? key.toLowerCase() : key;
    if (seenFiles.has(folded)) return false;
    seenFiles.add(folded);
    return true;
  }).map((r) => ({
    file: clean(r.file, 200),
    standard: r.standard === true,
    phases: list(r.phases, 300).filter(isObj).map((x) => ({
      id: clean(x.id, 40), title: clean(x.phase, 200), status: clean(x.status, 20), kind: clean(x.kind, 40), priority: clean(x.priority, 40),
      urgency: clean(x.urgency, 40), estRaw: hours(x.estRaw), estCal: hours(x.estCal), estimateH: hours(x.estimateH), actual: hours(x.actual), commit: clean(x.commit, 80),
    })),
  }));
  const sum = isObj(p.summary) ? p.summary : null;
  const unlisted = entries.filter((r) => !r.standard).map((r) => r.file);
  // The collector's own count and names when its summary has them (a count can be larger than the names it lists), else
  // the files of this entry that are not standard. A count that is not a whole number of zero or more is not used.
  const legacy = whole(sum?.legacyFiles) !== null
    ? { count: Math.min(whole(sum.legacyFiles), MAX_LEGACY_COUNT), names: list(sum.legacyNames, MAX_LEGACY_NAMES).filter((n) => typeof n === "string").map((n) => clean(n, 200)).filter(Boolean) }
    : { count: unlisted.length, names: unlisted.slice(0, 10).filter(Boolean) };
  const roadmaps = entries.filter((r) => r.standard);
  return {
    id: clean(p.id, 12),
    name: clean(p.name, 80) || "project",
    status: ["ok", "not found", "unreadable"].includes(p.status) ? p.status : "ok",
    roadmaps,
    files: entries.map((r) => r.file),
    legacy,
    history: list(p.history, 500).filter(isObj).map((h) => ({
      phase: clean(h.phase, 40),
      est: hours(h.est_h),
      actual: hours(h.actual_h),
      rounds: Number.isInteger(h.check_rounds) && h.check_rounds >= 0 ? h.check_rounds : null,
      firstPass: typeof h.prod_first_pass === "boolean" ? h.prod_first_pass : null,
      rolledBack: typeof h.rolled_back === "boolean" ? h.rolled_back : null,
    })),
    errors: list(p.errors, 50).filter(isObj).map((e) => ({ file: clean(e.file, 80) || "(unnamed)", reason: clean(e.reason, 200) })),
    summary: sum,
  };
}

function modelOf(data, nowMs, fold = CASE_INSENSITIVE) {
  const d = isObj(data) ? data : {};
  const th = isObj(d.thresholds) ? d.thresholds : {};
  const minutes = (n, dflt) => (Number.isInteger(n) && n >= 1 && n <= 100000 ? n : dflt);
  // generatedAt is an ISO text or an epoch in milliseconds, in a range a four-digit year can show; anything else is unknown.
  const generated = typeof d.generatedAt === "string" || typeof d.generatedAt === "number" ? (typeof d.generatedAt === "number" ? d.generatedAt : Date.parse(d.generatedAt)) : NaN;
  const known = Number.isFinite(generated) && generated >= GENERATED_MIN && generated <= GENERATED_MAX;
  const projects = list(d.projects, 100).map((p) => projectOf(p, fold)).filter(Boolean);
  const listed = new Set(projects.map((p) => p.id));
  const m = {
    fold,
    now: Number.isFinite(nowMs) ? nowMs : known ? generated : Date.now(),
    generated: known ? Math.floor(generated) : null,
    warnMin: minutes(th.warnMin, 90),
    idleMin: minutes(th.idleMin, 180),
    projects,
    // A session of a project that is not listed is not drawn and is not counted anywhere.
    sessions: list(d.sessions, 200).map(sessionOf).filter((s) => s && listed.has(s.project)),
    warnings: list(d.warnings, 200).filter(isObj).map((w) => ({ kind: clean(w.kind, 80), project: clean(w.project, 12) })),
    errors: list(d.errors, 50).filter(isObj).map((e) => ({ file: clean(e.file, 80) || "(unnamed)", reason: clean(e.reason, 200) })),
    // Quiet notes (fixed phrases with a count), shown without the error styling.
    notes: list(d.notes, 10).filter((n) => typeof n === "string").map((n) => clean(n, 200)).filter(Boolean),
  };
  return m;
}

const skewed = (s, now) => s.updated - now > CLOCK_AHEAD_MS || s.started > s.updated;
function effective(s, m) {
  if (s.state === "done") return "done";
  if (skewed(s, m.now) || s.idleShown || m.now - s.updated >= m.idleMin * 60000) return "idle";
  return s.state;
}

// ── Small parts ─────────────────────────────────────────────────────────────
// A text that may be cut with an ellipsis: the cut line is hidden from a screen reader, the full text is not.
function trunc(text) {
  const t = clean(text, 200);
  if (Array.from(t).length <= TRUNC_AT) return esc(t);
  return `<span class="t"><span class="t-s" aria-hidden="true">${esc(t)}</span><span class="t-f">${esc(t)}</span></span>`;
}

const noteIcon = '<span class="mk mk-n" aria-hidden="true"></span>';
const note = (cls, inner) => `<div class="note${cls ? ` ${cls}` : ""}" role="note">${noteIcon}${inner}</div>`;
const empty = (strong, rest) => `<p class="empty"><strong>${strong}</strong> ${rest}</p>`;

// ── The phase flow ──────────────────────────────────────────────────────────
// Eight gates in a row, joined by short arrows, as an inline SVG made of straight segments with square joins. A loop is a
// right-angled arrow under the row, from the gate it left to the gate it went back to, labelled "x N" in text. A gate
// entered more than once says "round N" in text. Only the active loop's arrow moves (its dashes run, by CSS).
const GATE_W = 104;
const GATE_H = 56;
const GATE_STEP = 122;
const FLOW_W = 976;
const TOP = 8;
const LOOP_DROP = 30;
const LOOP_ROW = 32;
const HEAD_H = 12;

// live (default: the session is working) says whether the running gate's hatching drifts; the page passes false for a
// session that has gone Idle, and the script's own state change (data-state on the row) stops it again in the browser.
export function phaseFlow(session, live) {
  const s = sessionOf(session);
  if (!s) return "";
  const drifts = live === undefined ? s.state === "working" : live === true;
  const cur = STEPS.indexOf(s.step);
  const kind = (i) => {
    if (s.state === "done") return i <= cur ? "done" : "pend";
    if (i < cur) return "done";
    if (i === cur) return s.state === "waiting" ? "wait" : "run";
    return "pend";
  };
  const word = (i, k) => (k === "done" ? "Done" : k === "run" ? "Running" : k === "wait" ? "Waiting" : s.visits[STEPS[i]] ? "To redo" : "Not started");
  const gx = (i) => 8 + i * GATE_STEP;
  const mid = TOP + GATE_H / 2;
  const parts = [];
  STEPS.forEach((step, i) => {
    const k = kind(i);
    const x = gx(i);
    const g = [`<g class="g-${k}"><rect class="gb" x="${x}" y="${TOP}" width="${GATE_W}" height="${GATE_H}"/>`];
    if (k === "done" || k === "wait") g.push(`<rect class="band" x="${x}" y="${TOP}" width="${GATE_W}" height="8"/>`);
    if (k === "run") {
      // Stripes at 45 degrees, 6 units apart, in a nested svg that cuts them at the band's edges; the drift moves them one
      // period (6 units) to the right, so the path starts a period or two before the gate and the loop has no jump.
      let d = "";
      for (let hx = x - 16; hx <= x + GATE_W; hx += 6) d += `M${hx} ${TOP + 8}l8 -8`;
      g.push(`<svg class="hclip" x="${x}" y="${TOP}" width="${GATE_W}" height="8" viewBox="${x} ${TOP} ${GATE_W} 8"><path class="hatch${drifts ? " live" : ""}" d="${d}"/></svg>`);
    }
    g.push(`<path class="bandline" d="M${x} ${TOP + 8}H${x + GATE_W}"/>`);
    g.push(`<text class="gname" x="${x + 7}" y="${TOP + 27}">${esc(STEP_NAMES[step])}</text>`);
    g.push(`<text class="gst" x="${x + 7}" y="${TOP + 41}">${esc(word(i, k))}</text>`);
    if ((s.visits[step] ?? 0) >= 2) g.push(`<text class="grd" x="${x + 7}" y="${TOP + 53}">round ${num(s.visits[step])}</text>`);
    g.push("</g>");
    parts.push(g.join(""));
    if (i < STEPS.length - 1) {
      const x2 = gx(i + 1);
      parts.push(`<path class="link" d="M${x + GATE_W} ${mid}H${x2 - 5}"/><polygon class="head" points="${x2 - 7},${mid - 4} ${x2},${mid} ${x2 - 7},${mid + 4}"/>`);
    }
  });
  const base = TOP + GATE_H;
  const drawn = s.loops.slice(0, MAX_LOOPS_DRAWN);
  drawn.forEach((l, n) => {
    const cx = (step) => gx(STEPS.indexOf(step)) + GATE_W / 2 + ((n % 4) - 1.5) * 8;
    const xf = cx(l.from);
    const xt = cx(l.to);
    const yd = base + LOOP_DROP + n * LOOP_ROW;
    const a = l.active ? " loop-active" : "";
    // The line leaves the gate it came from, runs under the row and goes up into the gate it went back to; the head sits
    // under that gate's edge. The count and the names are text on their own line under the run.
    parts.push(`<path class="loop${a}" d="M${xf} ${base}V${yd}H${xt}V${base + HEAD_H}"/>`);
    parts.push(`<polygon class="loop-head${l.active ? " loop-active-head" : ""}" points="${xt - 6},${base + HEAD_H} ${xt + 6},${base + HEAD_H} ${xt},${base + 2}"/>`);
    const tx = Math.min(xf, xt);
    parts.push(`<text class="loop-lbl${l.active ? " loop-lbl-active" : ""}" x="${tx}" y="${yd + 16}">x ${num(l.count)}</text>`);
    parts.push(`<text class="loop-name" x="${tx + 38}" y="${yd + 16}">${esc(STEP_NAMES[l.from])} back to ${esc(STEP_NAMES[l.to])}</text>`);
  });
  const height = drawn.length ? base + LOOP_DROP + (drawn.length - 1) * LOOP_ROW + 26 : base + 6;
  const label = `Phase flow: ${STEP_NAMES[s.step]} is ${s.state === "done" ? "done" : s.state === "waiting" ? "waiting for you" : "running"}${s.loops.length ? `, ${s.loops.length} loop${s.loops.length === 1 ? "" : "s"} back` : ""}`;
  return `<svg class="flow" viewBox="0 0 ${FLOW_W} ${height}" width="${FLOW_W}" height="${height}" role="img" aria-label="${esc(label)}" focusable="false" stroke-linejoin="miter">${parts.join("")}</svg>`;
}

function loopText(s) {
  if (!s.loops.length) return "No loops back so far.";
  const items = s.loops.map((l) => `${STEP_NAMES[l.from]} back to ${STEP_NAMES[l.to]} x ${l.count}${l.active ? " (running now)" : ""}`);
  const extra = s.loops.length > MAX_LOOPS_DRAWN ? ` (${s.loops.length - MAX_LOOPS_DRAWN} more not drawn)` : "";
  return `Loops: ${items.join("; ")}${extra}.`;
}

// ── Sessions ────────────────────────────────────────────────────────────────
// The title of a phase for a session: from the roadmap the session belongs to (its roadmap field, letter case ignored). A
// session of a roadmap file that is listed but not standard has none (that file is not drawn). A session with no roadmap
// field, or one whose file the project does not list, takes the first roadmap that has the phase id.
// A session of a folder with no usable roadmap path (its roadmap reads "(unlisted:<tag>)") has no title.
// The roadmap path is matched as written; its letter case is ignored only where the file system ignores it (fold).
function titleOf(p, phaseId, roadmap = "", fold = false) {
  if (roadmap.startsWith(UNLISTED_PREFIX)) return "";
  const id = phaseId.toLowerCase();
  const same = fold ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  const pick = (rs) => { for (const r of rs) for (const x of r.phases) if (x.id.toLowerCase() === id && x.title) return x.title; return ""; };
  if (roadmap && p.files.some((f) => same(f, roadmap))) {
    const exact = p.roadmaps.filter((r) => r.file === roadmap);
    return pick(exact.length ? exact : p.roadmaps.filter((r) => same(r.file, roadmap)));
  }
  return pick(p.roadmaps);
}

function sessionRow(p, s, m) {
  const k = slug("s", p.id, s.roadmap, s.phase.toLowerCase());
  const st = effective(s, m);
  const age = m.now - s.updated;
  const skew = skewed(s, m.now);
  const showWarn = skew || (s.state === "working" && st !== "idle" && age >= m.warnMin * 60000);
  const title = s.name || titleOf(p, s.phase, s.roadmap, m.fold);
  const live = st === "working" || st === "waiting";
  const worked = s.workedMs + (st === "working" && age > 0 ? age : 0);
  const elapsed = s.elapsedMs + (live && age > 0 ? age : 0);
  const over = s.estimateH !== null && worked / 3600000 > s.estimateH;
  const est = s.estimateH === null ? '<span class="none">no estimate</span>' : `est <span class="fig">${fix1(s.estimateH)} h</span>`;
  return [
    `<details class="sess" id="${k}" data-k="${k}" data-session data-declared="${s.state}" data-state="${st}"${skew ? " data-skew" : ""} data-t="${num(s.updated)}" data-w="${num(s.workedMs)}" data-e="${num(s.elapsedMs)}">`,
    "<summary>",
    `<span class="c sname"><span class="ph-n">#${txt(s.phase, 40)}</span>${title ? trunc(title) : '<span class="none">(untitled)</span>'}</span>`,
    `<span class="c" data-h="State"><span class="st"><span class="mk ${MARKS[st]}" data-mk aria-hidden="true"></span><span data-label>${STATE_WORDS[st]}</span></span>`,
    `<span class="warn" data-warn${showWarn ? "" : " hidden"}>${noteIcon}<span data-warn-text>${skew ? "Clock skew" : `No update for ${dur(age)}`}</span></span>`,
    `<span class="idle-note" data-idle-note${st === "idle" ? "" : " hidden"}>no update for ${thresholdText(m.idleMin)} or more</span></span>`,
    `<span class="c" data-h="Step">${esc(STEP_NAMES[s.step])}${s.rounds > 1 ? ` ${MIDDOT} round ${num(s.rounds)}` : ""}</span>`,
    `<span class="c num" data-h="On this step"><span data-since data-t="${num(s.started)}">${dur(m.now - s.started)}</span></span>`,
    `<span class="c num" data-h="Last update"><span data-since data-t="${num(s.updated)}">${dur(age)}</span> <span class="unit">ago</span></span>`,
    `<span class="c num" data-h="Worked, estimate"><span class="${over ? "over" : ""}" data-worked>${dur(worked)}</span> ${MIDDOT} ${est}</span>`,
    "</summary>",
    '<div class="sbody">',
    `<p class="scroll-hint" aria-hidden="true">Narrow screen: the drawing scrolls sideways, so all eight gates and the loops stay in one piece.</p>`,
    `<div class="scroll" role="region" aria-label="Phase flow of this session, scrolls sideways on a narrow screen" tabindex="0">${phaseFlow(s, st === "working")}</div>`,
    `<p class="flow-note">${esc(loopText(s))}</p>`,
    '<dl class="facts">',
    `<div><dt>Step</dt><dd>${esc(STEP_NAMES[s.step])}</dd></div>`,
    `<div><dt>Rounds</dt><dd>${num(s.rounds)}</dd></div>`,
    `<div><dt>Worked</dt><dd class="fig" data-worked>${dur(worked)}</dd></div>`,
    `<div><dt>Elapsed</dt><dd class="fig" data-elapsed>${dur(elapsed)}</dd></div>`,
    `<div><dt>Estimate</dt><dd class="fig">${s.estimateH === null ? "none" : `${fix1(s.estimateH)} h`}</dd></div>`,
    `<div><dt>Last update</dt><dd class="fig">${clockText(s.updated)}</dd></div>`,
    "</dl></div></details>",
  ].join("");
}

function sessionsPart(p, mine, m) {
  const id = slug("h", p.id, "sessions");
  const out = [`<section aria-labelledby="${id}">`, `<div class="kick"><span class="kicker">Now</span><h2 id="${id}">Sessions</h2></div>`];
  if (p.status === "not found") out.push(note("note-err", "<strong>Project folder not found.</strong> It stays listed. Sessions and history still show; its roadmap cannot be read until the folder is back or the project is unregistered."));
  if (p.status === "unreadable") out.push(note("note-err", "<strong>Project folder cannot be read.</strong> Its roadmap is not shown; the sessions below are still current."));
  for (const w of m.warnings.filter((x) => x.project === p.id)) {
    if (w.kind === "same project, more than one open session") out.push(note("", "<strong>Two sessions in one repo.</strong> More than one phase is running in this project at the same time. They can overwrite each other's files and status."));
    else if (w.kind === "clock skew") out.push(note("", "<strong>Clock skew.</strong> A session file has a time that does not fit this machine's clock, so it is shown as Idle with a warning."));
  }
  if (!mine.length) out.push(empty("No session is running a phase.", "Sessions appear here when a run starts and the status folder is enabled."));
  else out.push(`<div class="slist">${mine.map((s) => sessionRow(p, s, m)).join("")}</div>`);
  out.push("</section>");
  return out.join("");
}

// ── The roadmap, the estimates and the archive ──────────────────────────────
const STATUS_MARK = { shipped: "", "in progress": "mk-h", planned: "mk-p", parked: "mk-x" };
function statusCell(status) {
  const known = Object.hasOwn(STATUS_MARK, status);
  const mark = known ? STATUS_MARK[status] : "mk-p";
  return `<span class="stt stt-${known ? status.replace(" ", "-") : "planned"}"><span class="mk ${mark}" aria-hidden="true"></span>${txt(status || "unknown", 20)}</span>`;
}

function roadmapPart(p) {
  const k = slug("r", p.id, "roadmap");
  const phases = p.roadmaps.flatMap((r) => r.phases);
  const shipped = phases.filter((x) => x.status === "shipped").length;
  const body = [];
  if (p.errors.length) {
    body.push(note("note-err", `<strong>${p.errors.length === 1 ? "A file could not be read." : "Some files could not be read."}</strong> The rest of the page is still current.<ul>${p.errors.map((e) => `<li>${txt(e.file, 80)}: ${txt(e.reason, 200)}</li>`).join("")}</ul>`));
  }
  if (!p.roadmaps.length && p.legacy.count > 0) body.push(empty("No standardized roadmap yet.", "Only a roadmap with the marker line above every table is drawn. Standardize the files named above with the roadmap skill, mode standardize."));
  else if (!p.roadmaps.length && !p.errors.length) body.push(empty("No roadmap was read for this project.", p.status === "ok" ? "A project lists its roadmap file when it is registered." : "The project folder is not available."));
  for (const r of p.roadmaps) {
    const rows = r.phases.map((x) => [
      `<tr${x.status === "parked" ? ' class="r-parked"' : ""}>`,
      `<td class="id">${txt(x.id, 40)}</td><td>${trunc(x.title)}</td><td>${txt(x.kind, 40)}</td><td>${txt(x.priority, 40)}</td><td>${txt(x.urgency, 40)}</td>`,
      `<td class="n">${x.estRaw === null ? "" : `${fix1(x.estRaw)} h`}${x.estCal === null ? "" : ` &rarr; ${fix1(x.estCal)} h`}</td>`,
      `<td>${statusCell(x.status)}</td><td class="id">${txt(x.commit, 80)}</td><td class="n">${x.actual === null ? "" : `${fix1(x.actual)} h`}</td></tr>`,
    ].join("")).join("");
    body.push([
      '<div class="scroll" role="region" aria-label="Roadmap table" tabindex="0"><table class="tbl tbl-road">',
      `<caption>${txt(r.file, 200)}</caption>`,
      '<thead><tr><th scope="col">#</th><th scope="col">Phase</th><th scope="col">Kind</th><th scope="col">Pri.</th><th scope="col">Urgency</th><th scope="col" class="n">Est. raw &rarr; cal.</th><th scope="col">Status</th><th scope="col">Commit</th><th scope="col" class="n">Actual</th></tr></thead>',
      `<tbody>${rows || '<tr><td colspan="9">No phases in this file.</td></tr>'}</tbody></table></div>`,
    ].join(""));
  }
  return `<details class="part" id="${k}" data-k="${k}"><summary>Roadmap <span class="sub">${shipped} of ${phases.length} shipped, ${p.roadmaps.length} standard file${p.roadmaps.length === 1 ? "" : "s"}</span></summary><div class="pbox">${body.join("")}</div></details>`;
}

// One line per project that has roadmap files which are not standard: how many, which (at most 10 names, then "and M more")
// and what to do. Nothing of those files is drawn.
function legacyNote(p) {
  const n = p.legacy.count;
  if (n < 1) return "";
  const names = p.legacy.names.slice(0, 10).map((x) => txt(x, 200));
  const more = n - names.length;
  const named = names.length ? `: ${names.join(", ")}${more > 0 ? ` and ${num(more)} more` : ""}` : "";
  return note("", `<strong>${num(n)} roadmap file${n === 1 ? "" : "s"} not standardized${named} (not drawn).</strong> Standardize ${n === 1 ? "it" : "them"} with the roadmap skill, mode standardize.`);
}

// The rows of the estimate table. They come from the project's history: the newest record of each phase id that has an
// actual time (its estimate is the history's, else the calibrated estimate of the roadmap row with that id; its title
// comes from that roadmap row, else the row has the id alone). Shipped roadmap rows that have an Actual and no row yet
// follow, as they always did. History order, oldest first. The same list sizes the part for the page-size check.
function estimateData(p) {
  const road = p.roadmaps.flatMap((r) => r.phases);
  const rowOf = (id) => road.find((x) => x.id.toLowerCase() === id.toLowerCase() && x.title) ?? road.find((x) => x.id.toLowerCase() === id.toLowerCase());
  const newest = new Map();
  p.history.forEach((h, at) => { if (h.actual !== null && h.phase) newest.set(h.phase.toLowerCase(), at); });
  const rows = [...newest.values()].sort((a, b) => a - b).map((at) => {
    const h = p.history[at];
    const x = rowOf(h.phase);
    return { id: h.phase, title: x ? x.title : "", est: h.est ?? (x ? x.estimateH ?? x.estCal : null), actual: h.actual, h };
  });
  for (const x of road) {
    if (x.status !== "shipped" || x.actual === null || newest.has(x.id.toLowerCase())) continue;
    rows.push({ id: x.id, title: x.title, est: x.estimateH ?? x.estCal, actual: x.actual, h: null });
  }
  return rows;
}

function estimatePart(p) {
  const k = slug("e", p.id, "estimate");
  const rows = estimateData(p);
  const scale = Math.max(0.1, ...rows.map((r) => Math.max(r.est ?? 0, r.actual)));
  const W = 132;
  let body;
  if (!rows.length) body = empty("No phase has an actual time yet.", "Estimates are uncalibrated until the first phase ships.");
  else {
    const tr = rows.map(({ id, title, est, actual, h }) => {
      const aw = (actual / scale) * W;
      const ew = est === null ? 0 : (est / scale) * W;
      const over = est !== null && actual > est;
      const chart = `<svg class="eva" width="${W + 2}" height="16" viewBox="0 0 ${W + 2} 16" role="img" aria-label="Estimate ${est === null ? "none" : `${fix1(est)} h`}, actual ${fix1(actual)} h">${est === null ? "" : `<path class="dim" d="M1 6H${fix1(ew + 1)}M1 2V10M${fix1(ew + 1)} 2V10"/>`}<rect class="act${over ? " over" : ""}" x="1" y="10" width="${fix1(aw)}" height="4"/></svg>`;
      const prod = !h ? "" : h.rolledBack ? "rolled back" : h.firstPass === true ? "first pass" : h.firstPass === false ? "fixed after" : "";
      return `<tr><td class="id">${txt(id, 40)}</td><td>${trunc(title)}</td><td class="n">${est === null ? "" : `${fix1(est)} h`}</td><td class="n"><strong>${fix1(actual)} h</strong></td><td class="n${over ? " over" : ""}">${est === null ? "" : signed(actual - est)}</td><td>${chart}</td><td class="n">${h && h.rounds !== null ? num(h.rounds) : ""}</td><td>${esc(prod)}</td></tr>`;
    }).join("");
    const estSum = rows.reduce((a, r) => a + (r.est ?? 0), 0);
    const actSum = rows.reduce((a, r) => a + r.actual, 0);
    body = [
      '<div class="scroll" role="region" aria-label="Estimate against actual" tabindex="0"><table class="tbl tbl-est">',
      "<caption>Phases with an actual time, from the history log (a roadmap row with an Actual and no history record is added). The time counts from timestamps and includes any waiting. Bars share one scale.</caption>",
      '<thead><tr><th scope="col">#</th><th scope="col">Phase</th><th scope="col" class="n">Est.</th><th scope="col" class="n">Actual</th><th scope="col" class="n">Var.</th><th scope="col">Estimate and actual</th><th scope="col" class="n">Fix rounds</th><th scope="col">Prod</th></tr></thead>',
      `<tbody>${tr}</tbody>`,
      `<tfoot><tr><th scope="row" colspan="2">Total, ${rows.length} phase${rows.length === 1 ? "" : "s"}</th><td class="n">${fix1(estSum)} h</td><td class="n">${fix1(actSum)} h</td><td class="n">${signed(actSum - estSum)}</td><td></td><td></td><td></td></tr></tfoot></table></div>`,
    ].join("");
  }
  return `<details class="part" id="${k}" data-k="${k}"><summary>Estimate against actual <span class="sub">${rows.length} phase${rows.length === 1 ? "" : "s"} with a time</span></summary><div class="pbox">${body}</div></details>`;
}

function archivedPart(p, arch, m) {
  const k = slug("a", p.id, "archived");
  const body = arch.length
    ? `<div class="scroll" role="region" aria-label="Archived sessions" tabindex="0"><table class="tbl"><thead><tr><th scope="col">#</th><th scope="col">Phase</th><th scope="col">Last step</th><th scope="col">Finished (UTC)</th><th scope="col" class="n">Worked</th></tr></thead><tbody>${arch.map((s) => `<tr><td class="id">${txt(s.phase, 40)}</td><td>${trunc(s.name || titleOf(p, s.phase, s.roadmap, m.fold) || "(untitled)")}</td><td>${esc(STEP_NAMES[s.step])}</td><td class="n">${new Date(s.updated).toISOString().slice(0, 10)}</td><td class="n">${dur(s.workedMs)}</td></tr>`).join("")}</tbody></table></div>`
    : empty("No archived sessions.", "A finished session moves here 7 days after its last update.");
  return `<details class="part" id="${k}" data-k="${k}"><summary>Archived sessions <span class="sub">${arch.length}</span></summary><div class="pbox">${body}</div></details>`;
}

// ── A big page ──────────────────────────────────────────────────────────────
// The rows a project's Roadmap and Estimate parts hold: every roadmap row and every row of the estimate table.
const roadmapRows = (p) => p.roadmaps.reduce((a, r) => a + r.phases.length, 0);
const estimateRows = (p) => estimateData(p).length;
const hiddenRows = (p) => roadmapRows(p) + estimateRows(p);
function leftOutPart(p) {
  const k = slug("r", p.id, "left-out");
  return `<div class="part-out" id="${k}">${note("", `Roadmap and estimates <strong>left out to keep the page small: ${hiddenRows(p)} rows</strong>; the dashboard JSON still has them.`)}</div>`;
}

// ── A project ───────────────────────────────────────────────────────────────
// The phases of a project's standard roadmaps, counted: the collected summary when it has one, else the rows themselves.
// Only standard roadmap files count. A summary from before the strict rule (it has no legacyFiles) counted every file, so
// it is not used: the rows, which are the standard files only, are counted instead.
function roadmapCounts(p) {
  const phases = p.roadmaps.flatMap((r) => r.phases);
  const sum = isObj(p.summary) && whole(p.summary.legacyFiles) !== null ? p.summary : {};
  // Every figure is a whole number of zero or more; one that is not is counted again from the rows drawn. The page draws
  // the rows itself, so a figure is never more than what is drawn (the smaller of the two is shown), and the shipped count
  // is never more than the total.
  const drawn = phases.filter((x) => x.status === "shipped").length;
  const total = Math.min(whole(sum.phasesTotal) ?? phases.length, phases.length);
  return {
    roadmaps: Math.min(whole(sum.roadmaps) ?? p.roadmaps.length, p.roadmaps.length),
    total,
    shipped: Math.min(total, whole(sum.phasesShipped) ?? drawn, drawn),
    legacy: p.legacy.count,
  };
}

function summaryFor(p, mine, arch, m) {
  const states = mine.map((s) => ({ s, st: effective(s, m) }));
  const working = states.filter((x) => x.st === "working");
  const waiting = states.filter((x) => x.st === "waiting");
  const active = [...working, ...waiting];
  return {
    ...roadmapCounts(p),
    active: active.length,
    working: working.length,
    waiting: waiting.length,
    idle: states.filter((x) => x.st === "idle").length,
    archived: arch.length,
    estimateH: active.reduce((a, x) => a + (x.s.estimateH ?? 0), 0),
    workedMs: active.reduce((a, x) => a + x.s.workedMs + (x.st === "working" && m.now > x.s.updated ? m.now - x.s.updated : 0), 0),
  };
}

// The roadmap bar of a project row: one segment each for the shipped, in progress and planned phases (a status that is none of
// the four counts as planned, as the roadmap table shows it), the width of each in proportion to its count; parked phases are
// not drawn but are named in the label. A segment with no phases is not drawn. With no phases at all there is no bar.
function progressOf(p) {
  const phases = p.roadmaps.flatMap((r) => r.phases);
  const n = { shipped: 0, "in progress": 0, planned: 0, parked: 0 };
  for (const x of phases) n[Object.hasOwn(n, x.status) ? x.status : "planned"]++;
  const label = `${num(n.shipped)} shipped, ${num(n["in progress"])} in progress, ${num(n.planned)} planned${n.parked ? `, ${num(n.parked)} parked` : ""}`;
  const drawn = n.shipped + n["in progress"] + n.planned;
  // Files that are not standard are not drawn: with none that is standard there is no bar (and no row of zeros).
  if (!p.roadmaps.length && p.legacy.count > 0) return "";
  if (!phases.length) return '<span class="progress"><span class="plabel">No roadmap phases</span></span>';
  const seg = (cls, v) => (v ? `<span class="seg ${cls}" style="flex-grow:${num(v)}"></span>` : "");
  const bar = drawn ? `<span class="pbar" role="img" aria-label="Roadmap: ${label}">${seg("seg-s", n.shipped)}${seg("seg-p", n["in progress"])}${seg("seg-n", n.planned)}</span>` : "";
  return `<span class="progress">${bar}<span class="plabel"${bar ? ' aria-hidden="true"' : ""}>${label}</span></span>`;
}

function projectBlock(p, all, m, leftOut = false) {
  const k = slug("p", p.id);
  const mine = all.filter((s) => s.project === p.id && !s.archived)
    .sort((a, b) => ORDER[effective(a, m)] - ORDER[effective(b, m)] || b.updated - a.updated);
  const arch = all.filter((s) => s.project === p.id && s.archived).sort((a, b) => b.updated - a.updated);
  const sm = summaryFor(p, mine, arch, m);
  const open = sm.working + sm.waiting > 0;
  const bad = [];
  if (p.status === "not found") bad.push("Folder not found");
  if (p.status === "unreadable") bad.push("Folder cannot be read");
  if (p.errors.length) bad.push(`${p.errors.length} file problem${p.errors.length === 1 ? "" : "s"}`);
  return [
    `<details class="proj" id="${k}" data-k="${k}"${open ? " open" : ""}${sm.waiting ? " data-attn" : ""}>`,
    '<summary class="prow">',
    `<span class="c"><span class="pname">${trunc(p.name)}</span><span class="stamp" data-wait-stamp${sm.waiting ? "" : " hidden"}>Waiting for you</span>${bad.length ? `<span class="pbad">${esc(bad.join(", "))}</span>` : ""}${progressOf(p)}</span>`,
    `<span class="c num" data-h="Roadmaps"><span class="fig">${num(sm.roadmaps)}</span>${sm.legacy > 0 ? ` <span class="unit">(${num(sm.legacy)} not standardized)</span>` : ""}</span>`,
    `<span class="c num" data-h="Shipped"><span class="fig">${num(sm.shipped)} of ${num(sm.total)}</span></span>`,
    `<span class="c num" data-h="Active"><span class="fig" data-n="active">${num(sm.active)}</span> (<span data-n="working">${num(sm.working)}</span> working, <span data-n="waiting">${num(sm.waiting)}</span> waiting)</span>`,
    `<span class="c num" data-h="Idle"><span class="fig" data-n="idle">${num(sm.idle)}</span></span>`,
    `<span class="c num" data-h="Archived"><span class="fig">${num(sm.archived)}</span></span>`,
    `<span class="c num" data-h="Estimate, active"><span class="kv">${sm.estimateH > 0 ? `est <span class="fig">${fix1(sm.estimateH)} h</span>` : '<span class="none">no estimate</span>'}</span><span class="kv">worked <span class="fig" data-proj-worked>${dur(sm.workedMs)}</span></span></span>`,
    "</summary>",
    `<div class="pbody">${sessionsPart(p, mine, m)}${legacyNote(p)}${leftOut ? leftOutPart(p) : roadmapPart(p) + estimatePart(p)}${archivedPart(p, arch, m)}</div>`,
    "</details>",
  ].join("");
}

// ── The page ────────────────────────────────────────────────────────────────
function readAsset(name, io) {
  const path = join(ASSETS, name);
  const st = (io?.lstat ?? lstatSync)(path);
  if (!st.isFile() || st.size > MAX_ASSET_BYTES) throw Object.assign(new Error("asset"), { code: "EBADASSET" });
  return readFileSync(path);
}

// The files the page is made of: assets/page.css, assets/client.js and, unless fonts are off, the two fonts.
export function loadAssets({ fonts = true } = {}) {
  const assets = { css: readAsset("page.css").toString("utf8"), js: readAsset("client.js").toString("utf8") };
  if (fonts) { assets.sans = readAsset("pw-sans.woff2"); assets.mono = readAsset("pw-mono.woff2"); }
  return assets;
}

function fontFaces(assets) {
  const face = (family, bytes, weight, extra) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2");font-weight:${weight};font-style:normal;font-display:swap;${extra}}`;
  return `${face("PW Sans", assets.sans, "400 600", "font-stretch:85% 100%;")}\n${face("PW Mono", assets.mono, "400 500", "")}\n`;
}

const ICON = noteIcon;

// renderPage(data, options): the whole page as a string. options: now (epoch ms; default the time the data was made),
// fonts (default true), refreshS (5 to 300, default 10), assets (what loadAssets returns), softBytes (the size over which
// the tables of idle projects are left out; default 256 KB; a test seam), caseInsensitive (whether the letter case of a roadmap path is ignored when a session is matched to its roadmap; default from the platform).
export function renderPage(data, options = {}) {
  const fonts = options.fonts !== false;
  const assets = options.assets ?? loadAssets({ fonts });
  const refresh = Number.isInteger(options.refreshS) && options.refreshS >= 5 && options.refreshS <= 300 ? options.refreshS : 10;
  const m = modelOf(data, options.now, options.caseInsensitive ?? CASE_INSENSITIVE);
  // The browser turns CR LF and a lone CR into LF before it hashes an inline script, so the script is made that way here
  // and the same text is hashed and inlined.
  const js = assets.js.replace(/\r\n?/g, "\n");
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; script-src 'sha256-${createHash("sha256").update(js).digest("base64")}'; base-uri 'none'; form-action 'none'`;

  const projects = [...m.projects].sort((a, b) => {
    const rank = (p) => { const mine = m.sessions.filter((s) => s.project === p.id && !s.archived).map((s) => effective(s, m)); return mine.includes("waiting") ? 0 : mine.includes("working") ? 1 : 2; };
    return rank(a) - rank(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  const open = m.sessions.filter((s) => !s.archived).map((s) => effective(s, m));
  const nWait = open.filter((x) => x === "waiting").length;
  const nWork = open.filter((x) => x === "working").length;
  const nIdle = open.filter((x) => x === "idle").length;
  const lead = [nWait ? `${nWait} waiting for you` : null, `${nWork} working`, `${nIdle} idle`].filter(Boolean).join(` ${MIDDOT} `);

  const running = (p) => m.sessions.some((s) => s.project === p.id && !s.archived && ["working", "waiting"].includes(effective(s, m)));
  const build = (dropped) => {
  const main = [];
  main.push(`<p class="lead" id="pw-summary" aria-live="polite" data-live><span class="fig">${projects.length} project${projects.length === 1 ? "" : "s"}</span> ${MIDDOT} <span data-text>${esc(lead)}</span></p>`);
  if (m.errors.length) main.push(note("note-err", `<strong>Skipped.</strong> A file could not be used and was left out; only its name is shown.<ul>${m.errors.map((e) => `<li>${txt(e.file, 80)}: ${txt(e.reason, 200)}</li>`).join("")}</ul>`));
  if (m.notes.length) main.push(note("", m.notes.map((n) => txt(n, 200)).join(" ")));
  if (dropped.size) {
    const live = [...dropped].filter(running).length;
    const which = live ? `(${live} with a running session)` : "with no running session";
    main.push(note("", `<strong>Page kept small.</strong> The roadmap and estimate tables of ${dropped.size} project${dropped.size === 1 ? "" : "s"} ${which} are left out to keep the page small (${[...dropped].reduce((a, p) => a + hiddenRows(p), 0)} rows); the dashboard JSON still has them.`));
  }
  if (!projects.length) main.push(empty("No projects are listed yet.", "A project appears here after its first run with the dashboard turned on."));
  else main.push(`<div class="projects">${projects.map((p) => projectBlock(p, m.sessions, m, dropped.has(p))).join("")}</div>`);

  // The moving things: one in-progress mark or segment each, one drifting gate each, and the header rule while a session works.
  // Over MAX_MOVING of them the marks and segments are drawn still (class calm); the header rule and the running gates still move.
  // The class attributes are looked for with their quotes, which no text of the data can contain (text is escaped).
  const body = main.join("");
  const moving = ['class="mk mk-h"', 'class="seg seg-p"', 'class="hatch live"'].reduce((a, needle) => a + body.split(needle).length - 1, nWork ? 1 : 0);
  const calm = moving > MAX_MOVING;
  const written = m.generated ?? m.now;
  // The title block: real figures, as written when the page was built (the script keeps the session counts of each project row
  // current, not these).
  const road = projects.reduce((a, p) => { const c = roadmapCounts(p); return { shipped: a.shipped + c.shipped, total: a.total + c.total }; }, { shipped: 0, total: 0 });
  const archivedAll = m.sessions.filter((s) => s.archived && projects.some((p) => p.id === s.project)).length;
  const utc = new Date(ms(written)).toISOString();
  // A time that is missing or not usable (see modelOf) is shown as unknown, never as a wrong date.
  const writtenText = m.generated === null ? "unknown" : `${utc.slice(0, 10)} ${utc.slice(11, 19)}`;
  const figure = (name, value, cls = "") => `<div${cls ? ` class="${cls}"` : ""}><dt>${name}</dt><dd>${value}</dd></div>`;
  const titleBlock = [
    '<dl class="titleblock">',
    figure("Written (UTC)", writtenText),
    figure("Projects", num(projects.length)),
    figure("Roadmap", `${num(road.shipped)} of ${num(road.total)}`),
    figure("Sessions", `${num(nWork + nWait)} active, ${num(nWait)} waiting`),
    figure("Archived", num(archivedAll)),
    figure("Source", "plan, history, status files"),
    figure("Network", "none"),
    figure("Refresh", `${num(refresh)} s, pausable`, "foot-refresh"),
    "</dl>",
  ].join("");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    "<title>Phasewright progress sheet</title>",
    `<!--\n${FONT_NOTICE}\n-->`,
    `<style>\n${fonts ? fontFaces(assets) : ""}${assets.css}\n</style>`,
    "</head>",
    `<body data-refresh-s="${refresh}" data-warn-min="${m.warnMin}" data-idle-min="${m.idleMin}" data-page-stale-min="${PAGE_STALE_MIN}">`,
    '<a class="skip" href="#main">Skip to the dashboard</a>',
    `<div class="sheet${nWork ? " has-working" : ""}${calm ? " calm" : ""}">`,
    '<header class="top">',
    '<div class="tb-left"><span class="brand">Phasewright</span><span class="sep">/</span><span>Progress sheet</span></div>',
    `<div class="controls"><span class="written">Written <span data-written data-clock data-t="${num(written)}">${clockText(written)}</span></span><span class="cd" id="pw-countdown">Refresh every ${refresh} s</span><button type="button" id="pw-pause" class="btn" aria-pressed="false">Pause refresh</button></div>`,
    '<span class="top-band" aria-hidden="true"></span>',
    "</header>",
    `<p class="banner" id="pw-stale" hidden role="status">${ICON}<strong>This page has not been rewritten for <span data-since-written>${dur(PAGE_STALE_MIN * 60000)}</span>.</strong> The run that writes it may have stopped; times below still count up from the last write.</p>`,
    '<noscript><p class="banner">Scripts are off: times and states are as written and the page will not refresh. Reload to update.</p></noscript>',
    `<main id="main" tabindex="-1">${body}</main>`,
    '<footer class="foot">',
    `${titleBlock}`,
    "<p>Local file. Nothing is uploaded and the page makes no network requests.</p>",
    "</footer>",
    "</div>",
    `<script>${js}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
  };

  const soft = Number.isInteger(options.softBytes) && options.softBytes > 0 ? options.softBytes : SOFT_PAGE_BYTES;
  let html = build(new Set());
  if (Buffer.byteLength(html) <= soft) return html;
  // Over 256 KB: the tables of projects with no running session go first, the largest saving first; if the page is still
  // over, the tables of the projects with a running session go too, again the largest saving first. A project's row, its
  // sessions (a waiting one included) and its archived part always stay.
  const size = (p, leftOut) => Buffer.byteLength(projectBlock(p, m.sessions, m, leftOut));
  const biggest = (pool) => pool.filter((p) => hiddenRows(p) > 0)
    .map((p) => ({ p, save: size(p, false) - size(p, true) })).filter((c) => c.save > 0).sort((a, b) => b.save - a.save);
  const order = [...biggest(projects.filter((p) => !running(p))), ...biggest(projects.filter(running))];
  const dropped = new Set();
  let left = Buffer.byteLength(html);
  for (const c of order) { if (left <= soft) break; dropped.add(c.p); left -= c.save; }
  html = build(dropped);
  // The note line itself takes some bytes: one more project goes, if it is still over.
  for (const c of order) { if (Buffer.byteLength(html) <= soft) break; if (!dropped.has(c.p)) { dropped.add(c.p); html = build(dropped); } }
  return html;
}

// ── Writing ─────────────────────────────────────────────────────────────────
const RETRY_CODES = ["EPERM", "EACCES", "EBUSY"];
const sleepMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const lstatOrNull = (path) => {
  try { return lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
};

// Writes the text into a temp file in the same folder (flushed), then renames it over the final name, which must be
// absent or a regular file with one name. On Windows a rename refused for a moment is retried up to 10 times.
// Returns null or an error code.
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
        if (!WIN || !RETRY_CODES.includes(e?.code) || attempt >= 10) { rmSync(tmp, { force: true }); return codeOf(e); }
      }
      sleepMs(Math.min(100, 10 * (attempt + 1)));
    }
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { rmSync(tmp, { force: true }); } catch { /* the temp file holds only what the page would */ }
    return codeOf(e);
  }
}

const USAGE = ["usage: page.mjs --data <dir> [--out <file>] [--now <epoch ms>] [--no-fonts] [--refresh-s <5-300>]"];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === "--no-fonts") {
      if (inline !== undefined) return { error: "--no-fonts takes no value" };
      opts[a] = true;
      continue;
    }
    if (!["--data", "--out", "--now", "--refresh-s"].includes(a)) return { error: a.startsWith("--") ? `unknown option ${a}` : `unexpected argument ${clean(a, 40)}` };
    const v = inline !== undefined ? inline : argv[++i];
    if (v === undefined) return { error: `${a} needs a value` };
    if (opts[a] !== undefined) return { error: `${a} can be given once` };
    opts[a] = v;
  }
  return { opts };
}

const keyOf = (p) => (WIN ? p.toLowerCase() : p);

// ── The builder status.mjs calls ────────────────────────────────────────────
// buildPage(dir, io): collects the data and writes <dir>/dashboard.html, and nothing else: the one path it is given is the
// data folder, the file name is fixed, and the folder is never created. Returns { ok: true } or { ok: false, reason },
// the reason being an error code or a short fixed phrase (never a path, a file name or text from a file). It never
// throws and prints nothing. io: now (epoch ms), rename, maxPageBytes (the test seams of the command).
export async function buildPage(dir, io = {}) {
  try {
    if (typeof dir !== "string" || !dir || !isAbsolute(dir)) return { ok: false, reason: "bad folder" };
    const folder = resolve(dir);
    const nowMs = Number.isFinite(io.now) ? io.now : Date.now();
    if (!existsSync(folder)) return { ok: false, reason: "no data folder" };
    const got = await collectData({ data: folder, now: nowMs, caseInsensitive: io.caseInsensitive });
    if (!got.ok) return { ok: false, reason: "data not readable" };
    let assets;
    try { assets = loadAssets({ fonts: true }); } catch (e) { return { ok: false, reason: codeOf(e) }; }
    const html = renderPage(got.data, { now: nowMs, fonts: true, refreshS: 10, assets, caseInsensitive: io.caseInsensitive });
    if (Buffer.byteLength(html) > (io.maxPageBytes ?? MAX_PAGE_BYTES)) return { ok: false, reason: "page too large" };
    const failed = writeAtomic(join(folder, "dashboard.html"), html, { rename: io.rename });
    if (failed) return { ok: false, reason: String(failed) };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: codeOf(e) };
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────
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
  let refreshS = 10;
  if (opts["--refresh-s"] !== undefined) {
    if (!/^\d{1,3}$/.test(opts["--refresh-s"]) || Number(opts["--refresh-s"]) < 5 || Number(opts["--refresh-s"]) > 300) return usage("--refresh-s must be a whole number from 5 to 300");
    refreshS = Number(opts["--refresh-s"]);
  }
  if (opts["--out"] !== undefined && !opts["--out"]) return usage("--out needs a file name");
  const nowMs = opts["--now"] !== undefined ? Number(opts["--now"]) : Number.isFinite(io.now?.()) ? io.now() : Date.now();
  const dir = resolve(opts["--data"]);
  const fonts = opts["--no-fonts"] !== true;
  const defaultTarget = join(dir, "dashboard.html");
  const target = opts["--out"] !== undefined ? resolve(opts["--out"]) : defaultTarget;
  const isDefault = keyOf(target) === keyOf(defaultTarget);

  // The page is made from the collected data; the --out check of collectData keeps the page out of the data folder.
  const got = await collectData({ data: dir, now: nowMs, out: isDefault ? undefined : opts["--out"], fd: io.fd, maxTotalRead: io.maxTotalRead, caseInsensitive: io.caseInsensitive });
  if (!got.ok) {
    if (got.usage) return usage(got.message);
    err(got.message);
    return got.code;
  }
  if (isDefault && !existsSync(dir)) { err("the data folder is not there; it is not created and nothing was written"); return 1; }
  let assets;
  try { assets = loadAssets({ fonts }); } catch (e) { err(`cannot read the page's own files (${codeOf(e)}); nothing was written`); return 1; }
  const html = renderPage(got.data, { now: nowMs, fonts, refreshS, assets, caseInsensitive: io.caseInsensitive });
  const bytes = Buffer.byteLength(html);
  if (bytes > (io.maxPageBytes ?? MAX_PAGE_BYTES)) { err(`the page would be ${Math.ceil(bytes / 1024)} KB, over the ${Math.round((io.maxPageBytes ?? MAX_PAGE_BYTES) / 1024)} KB limit; nothing was written${fonts ? " (--no-fonts makes it smaller)" : ""}`); return 1; }
  const failed = writeAtomic(target, html, { rename: io.rename });
  if (failed) { err(`cannot write ${clean(basename(target), 80)} (${failed}); nothing was written`); return 1; }
  out(`wrote ${clean(basename(target), 80)}: ${got.projects} project(s), ${got.sessions} session(s), ${Math.ceil(bytes / 1024)} KB`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
