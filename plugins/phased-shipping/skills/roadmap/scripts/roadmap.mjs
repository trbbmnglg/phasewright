#!/usr/bin/env node
// Reads, checks and standardizes a project's roadmap file (the tables in PHASES.md), keeps a way back for every
// write, and restores a kept copy. No dependencies.
//
//   node roadmap.mjs read <file> [--root <dir>]
//   node roadmap.mjs check <file> [--strict] [--root <dir>]
//   node roadmap.mjs standardize <file> [--table <index>]... [--set-status <id>=<status>]... [--write] [--root <dir>]
//   node roadmap.mjs set <file> <id> [--status <s>] [--commit <text>] [--actual <hours>] [--plan-file <p>] [--note <t>] [--root <dir>]
//   node roadmap.mjs restore <file> [--from original|prev|<backup name>] [--write] [--root <dir>]
//
// The format is described in ../references/format.md. In short: a roadmap table has the columns "#" and
// "Phase". When the nearest non-blank line above its header is exactly
// "<!-- phased-shipping:roadmap v1 -->" it is a standard table and is held to the format; without that
// line it is a legacy table, which is read as well as possible and reported with a notice, never rejected.
//
// read         prints JSON: every roadmap table, its phases and its problems. Never throws on bad input.
// check        prints one line per problem and a summary. Read-only.
// standardize  prints a plan (a diff and the rows it cannot place) and writes nothing. With --write it keeps
//              <name>.original (first write only) and <name>.bak-<YYYYMMDD-HHMMSS> in .roadmap-backups/, writes
//              the new text to .roadmap-backups/<name>.tmp and renames it over the file. It refuses to write while
//              a chosen table still has a row it cannot place. Lines outside the chosen tables are never touched.
// set          changes cells of one row of one standard table and nothing else. It keeps <name>.original (first
//              write only) and <name>.prev (the file as it was before this set) in .roadmap-backups/, then writes
//              atomically (.roadmap-backups/<name>.tmp, then a rename).
// restore      without --from lists the kept copies; with --from it prints what would change and writes nothing;
//              with --from and --write it first saves the current file as <name>.before-restore-<stamp>, then puts
//              the chosen copy back (atomic). Legacy <name>.bak-* copies next to the file are listed and restorable.
//
// Backups: every copy lives in ONE folder, .roadmap-backups/, next to the roadmap file. The folder gets a
// .gitignore that holds only "*", so git never lists or commits it. <name>.original is the file as the tool first
// saw it: it is created once (never overwritten, renamed or deleted by this script). These are local copies on
// the same disk, not an off-machine backup. If any copy cannot be made, nothing is written to the roadmap file.
// Every kept copy is written complete under a temporary name, then published under its final name with a hard
// link (which fails when the name exists), so a final name never holds half a file. Where links are not
// possible (FAT and some network drives) a "<copy>.incomplete" marker is made first and removed last; a marker
// left behind makes every later write refuse until the owner has looked. Files are flushed to disk before they
// are published. Backup files are owner-only (0600) and the folder 0700 where the system has file modes; the
// roadmap file keeps its own mode.
// Just before each rename the file is read again; if it changed since the command read it, the command stops
// with exit 1 and changes nothing. That narrows the window for two writers; it is not a lock. On Windows a
// rename that is refused for a moment (a scanner holding the file) is retried a few times, each time after
// the same check.
//
// --root <dir>: the file must resolve inside that folder, or the command exits 2. The skill always passes
// the project folder. Without --root there is no containment check.
//
// Exit codes: 0 done; 1 the check found problems, or a write was refused, or set could not apply, or a copy
// failed, or the file changed while it was being written; 2 the file cannot be read, is outside --root, a backup
// name is unknown, or the usage is wrong.
//
// Only the file's base name is ever printed, never an absolute path. The line endings (LF or CRLF, per
// line) and the last-newline state of the file are kept. The only paths this script writes are the roadmap file
// itself (replaced by a rename) and the files in the .roadmap-backups/ folder next to it, including the temp
// file the new text is written to first.
//
// Exports for tests and for other tools: parseRoadmap, checkRoadmap, planStandardize, setPhase, mapStatus,
// STATUSES, MARKER, cellOf, clean, renameWithRetry, main. The reader is line-based and tables-only: it is not a
// full Markdown parser.

import {
  readFileSync, renameSync, rmSync, realpathSync, mkdirSync, lstatSync, readdirSync, openSync, writeFileSync, closeSync,
  fsyncSync, linkSync, chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- phased-shipping:roadmap v1 -->";
const MARKER_RE = /^<!-- phased-shipping:roadmap v(\d+) -->\s*$/;
export const STATUSES = ["planned", "in progress", "shipped", "parked"];
const KINDS = ["ui", "backend", "data", "infra", "docs", "mixed"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TABLE_LINE = /^\s{0,3}\|/;
const EST_CANON = "Est. (raw → cal.)";
const ALIASES = {
  "est.": EST_CANON,
  "est. (raw → calibrated)": EST_CANON,
  state: "Status",
  id: "#",
  no: "#",
  name: "Phase",
};
const STATUS_WORDS = {
  planned: "planned", "to plan": "planned", backlog: "planned", next: "planned", todo: "planned", queued: "planned",
  "in progress": "in progress", "in-progress": "in progress", wip: "in progress", building: "in progress", started: "in progress", previewed: "in progress",
  shipped: "shipped", done: "shipped", complete: "shipped", completed: "shipped", released: "shipped",
  parked: "parked", dropped: "parked", skipped: "parked", deferred: "parked", "on hold": "parked", blocked: "parked",
};

// ── Status mapping ──────────────────────────────────────────────────────────
// The whole cell, trimmed and lower-cased, is looked up. "<word> (<text>)" maps by the word and moves the
// text to Plan file (when it looks like a path to a .md file) or to Note. "moved to ..." is parked, with the
// whole text as the note. Anything else returns null: it is never guessed.
export function mapStatus(raw) {
  const text = String(raw ?? "").trim();
  const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const whole = STATUS_WORDS[norm(text)];
  if (whole) return { status: whole };
  if (/^moved to\b/i.test(text)) return { status: "parked", note: text };
  const m = text.match(/^(.+?)\s*\(([\s\S]*)\)$/);
  if (m) {
    const status = STATUS_WORDS[norm(m[1])];
    if (!status) return null;
    const inner = m[2].trim();
    if (!inner) return { status };
    return /^[\w./\\-]+\.md$/.test(inner) ? { status, planFile: inner } : { status, note: inner };
  }
  return null;
}

// ── Lines and cells ─────────────────────────────────────────────────────────
// Each line keeps its own terminator, so joining the pieces gives back the exact text.
function splitLines(text) {
  const parts = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return parts.map((p) => {
    const m = p.match(/^([\s\S]*?)(\r?\n)?$/);
    return { text: m[1], eol: m[2] ?? "" };
  });
}

// Cell text. In a cell, `\|` is a pipe. A backslash that sits directly before a pipe is written doubled (a run
// of k backslashes then a pipe is written as 2k+1 backslashes then the pipe); any other backslash is written as
// it is, so a Windows path such as docs\plan-2.md reads exactly as it always did. The reader undoes exactly
// that, so clean(cellOf(v).trim()) === v for every string v with no space at either end (a value with spaces at
// its ends comes back without them, as the reader always trimmed). This is a round trip with this tool's own
// reader; it makes no claim about how a Markdown renderer shows the cell. The only legacy text that reads
// differently is an odd run of three or more backslashes right before a pipe.
// The first replace puts one more backslash in front of each backslash that is followed by zero or more
// backslashes and then a pipe; the second escapes the pipe.
export const cellOf = (value) => ` ${String(value).replace(/\\(?=\\*\|)/g, "\\$&").replace(/\|/g, "\\|")} `;
const unescapeCell = (s) => s.replace(/(?<!\\)\\+\|/g, (m) => {
  const n = m.length - 1;
  return `${"\\".repeat(n > 1 && n % 2 === 1 ? (n - 1) / 2 : n - 1)}|`;
});
export const clean = (raw) => unescapeCell(String(raw ?? "").trim());

// A table line as { indent, cells (raw, with their spaces), trail }. A "\|" is cell text, not a separator.
function splitRow(line) {
  const m = line.match(/^(\s*)\|([\s\S]*)$/);
  const indent = m[1];
  const rest = m[2];
  const trail = rest.match(/\s*$/)[0];
  const body = rest.slice(0, rest.length - trail.length);
  const cells = [];
  let cur = "";
  let closed = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") { cur += "\\|"; i++; closed = false; continue; }
    if (ch === "|") { cells.push(cur); cur = ""; closed = true; continue; }
    cur += ch;
    closed = false;
  }
  if (!closed) cells.push(cur);
  return { indent, cells, trail };
}

const rebuildRow = (row, cells) => `${row.indent}|${cells.join("|")}|${row.trail}`;
const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));

// ── Parsing ─────────────────────────────────────────────────────────────────
const colIndex = (lower, name, legacy) => {
  if (name === "est") return lower.findIndex((l) => /^est\b/.test(l));
  const at = lower.indexOf(name);
  if (at >= 0) return at;
  return legacy && name === "status" ? lower.indexOf("state") : -1;
};

function buildTable(segs, a, b, heading, index) {
  if (b - a < 1) return null;
  const head = splitRow(segs[a].text);
  const sep = splitRow(segs[a + 1].text);
  if (!isSeparator(sep.cells)) return null;
  const names = head.cells.map(clean);
  const lower = names.map((n) => n.toLowerCase());
  if (!lower.includes("#") || !lower.includes("phase")) return null;
  let k = a - 1;
  while (k >= 0 && /^\s*$/.test(segs[k].text)) k--;
  // A byte order mark in front of the first line of the file does not hide the marker on that line.
  const mm = k >= 0 ? (k === 0 ? segs[k].text.replace(/^\uFEFF/, "") : segs[k].text).match(MARKER_RE) : null;
  const rows = [];
  for (let r = a + 2; r <= b; r++) {
    const row = splitRow(segs[r].text);
    rows.push({ idx: r, line: r + 1, indent: row.indent, trail: row.trail, raw: row.cells, vals: row.cells.map(clean) });
  }
  const table = {
    index, heading, headerIdx: a, sepIdx: a + 1, line: a + 1,
    markerIdx: mm ? k : null, markerLine: mm ? k + 1 : null, version: mm ? Number(mm[1]) : null, legacy: !mm,
    headRow: head, sepRow: sep, names, rows, problems: [],
  };
  table.problems = problemsFor(table);
  return table;
}

// Problems of one table. `t` needs: legacy, names, rows ({ line, vals, width? }), line, markerLine, version.
function problemsFor(t) {
  const out = [];
  const add = (line, level, code, message) => out.push({ line, level, code, message });
  const lower = t.names.map((n) => n.toLowerCase());
  const shorten = (s) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
  const statusCol = colIndex(lower, "status", t.legacy);
  if (t.legacy) {
    add(t.line, "notice", "legacy-table",
      `table has no "${MARKER}" line above it, so it is read as a legacy table${statusCol < 0 ? " (it has no Status column)" : ""}; run standardize to adopt the format`);
    if (statusCol >= 0) {
      for (const row of t.rows) {
        const v = row.vals[statusCol] ?? "";
        if (!mapStatus(v)) add(row.line, "notice", "unmapped-status", `Status "${shorten(v)}" is not one the reader knows; the row is not counted in any status`);
      }
    }
    return sorted(out);
  }
  if (t.version !== 1) add(t.markerLine, "notice", "newer-version", `the marker says v${t.version}; this reader knows v1 and reads the table as v1, best effort`);
  for (const [need, label] of [["#", "#"], ["phase", "Phase"], ["status", "Status"]]) {
    if (!lower.includes(need)) add(t.line, "error", "missing-column", `required column "${label}" is missing`);
  }
  const idCol = lower.indexOf("#");
  const prCol = lower.indexOf("priority");
  const kindCol = lower.indexOf("kind");
  const seen = new Map();
  for (const row of t.rows) {
    const width = row.width ?? row.vals.length;
    if (width !== t.names.length) add(row.line, "error", "row-width", `row has ${width} cells but the header has ${t.names.length}`);
    if (idCol >= 0) {
      const id = row.vals[idCol] ?? "";
      if (id === "") add(row.line, "error", "empty-id", "the # cell is empty");
      else if (!ID_RE.test(id)) add(row.line, "error", "bad-id", `id "${shorten(id)}" must start with a letter or digit and use only letters, digits, ".", "_" or "-"`);
      else if (seen.has(id)) add(row.line, "error", "duplicate-id", `id "${id}" is already used on line ${seen.get(id)}`);
      else seen.set(id, row.line);
    }
    if (statusCol >= 0) {
      const v = row.vals[statusCol] ?? "";
      if (!STATUSES.includes(v.toLowerCase())) add(row.line, "error", "bad-status", `Status "${shorten(v)}" must be one of ${STATUSES.join(", ")}`);
    }
    if (prCol >= 0) {
      const v = row.vals[prCol] ?? "";
      if (v !== "" && !/^P[0-3]$/i.test(v)) add(row.line, "error", "bad-priority", `Priority "${shorten(v)}" must be P0 to P3 or empty`);
    }
    if (kindCol >= 0) {
      const v = row.vals[kindCol] ?? "";
      if (v !== "" && !KINDS.includes(v.toLowerCase())) add(row.line, "error", "bad-kind", `Kind "${shorten(v)}" must be one of ${KINDS.join(", ")} or empty`);
    }
  }
  return sorted(out);
}

const sorted = (list) => list.map((p, i) => [p, i]).sort((x, y) => x[0].line - y[0].line || x[1] - y[1]).map(([p]) => p);

// Finds every roadmap table in the text. Never throws: odd input gives fewer tables, not an error.
export function parseRoadmap(text) {
  const segs = splitLines(String(text ?? ""));
  const tables = [];
  let heading = null;
  let fence = null;
  for (let i = 0; i < segs.length;) {
    const line = segs[i].text;
    const fm = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && /^\s{0,3}(`+|~+)\s*$/.test(line)) fence = null;
      i++;
      continue;
    }
    if (fm) { fence = { ch: fm[1][0], len: fm[1].length }; i++; continue; }
    const hm = line.match(/^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/);
    if (hm) { heading = hm[1]; i++; continue; }
    if (!TABLE_LINE.test(line)) { i++; continue; }
    let j = i;
    while (j < segs.length && TABLE_LINE.test(segs[j].text)) j++;
    const table = buildTable(segs, i, j - 1, heading, tables.length);
    if (table) tables.push(table);
    i = j;
  }
  const problems = [];
  if (!tables.length) problems.push({ line: 0, level: "notice", code: "no-roadmap-table", message: 'the file has no table with the columns "#" and "Phase"' });
  return { segs, tables, problems };
}

// ── The read output ─────────────────────────────────────────────────────────
const EST_RE = /^\s*(\d+(?:\.\d+)?)\s*h\s*(?:→|->)\s*(\d+(?:\.\d+)?)\s*h/i;

function phaseOf(t, row) {
  const lower = t.names.map((n) => n.toLowerCase());
  const at = (name) => colIndex(lower, name, t.legacy);
  const get = (name) => {
    const c = at(name);
    const v = c >= 0 ? (row.vals[c] ?? "") : "";
    return v === "" ? null : v;
  };
  const statusRaw = get("status") ?? "";
  const mapped = t.legacy ? mapStatus(statusRaw) : (STATUSES.includes(statusRaw.toLowerCase()) ? { status: statusRaw.toLowerCase() } : null);
  const est = (get("est") ?? "").match(EST_RE);
  const actual = (get("actual") ?? "").match(/^(\d+(?:\.\d+)?)\s*h?$/i);
  return {
    id: row.vals[at("#")] ?? "",
    phase: row.vals[at("phase")] ?? "",
    status: mapped?.status ?? null,
    statusRaw,
    kind: get("kind"),
    priority: get("priority"),
    urgency: get("urgency"),
    estRaw: est ? Number(est[1]) : null,
    estCal: est ? Number(est[2]) : null,
    actual: actual ? Number(actual[1]) : null,
    commit: get("commit / deploy"),
    blockedBy: get("blocked by"),
    planFile: get("plan file") ?? mapped?.planFile ?? null,
    note: get("note") ?? mapped?.note ?? null,
    line: row.line,
  };
}

// The JSON that `read` prints (an object). `file` is the base name only.
export function toReadJson(parsed, file) {
  const summary = { planned: 0, inProgress: 0, shipped: 0, parked: 0, total: 0, legacyTables: 0, errors: 0, notices: 0 };
  const tables = parsed.tables.map((t) => {
    const phases = t.rows.map((row) => phaseOf(t, row));
    for (const p of phases) {
      summary.total++;
      if (p.status === "planned") summary.planned++;
      else if (p.status === "in progress") summary.inProgress++;
      else if (p.status === "shipped") summary.shipped++;
      else if (p.status === "parked") summary.parked++;
    }
    if (t.legacy) summary.legacyTables++;
    for (const p of t.problems) summary[p.level === "error" ? "errors" : "notices"]++;
    return {
      index: t.index, heading: t.heading, line: t.line,
      marker: t.version === null ? null : `v${t.version}`, legacy: t.legacy,
      columns: t.names, phases, problems: t.problems,
    };
  });
  for (const p of parsed.problems) summary[p.level === "error" ? "errors" : "notices"]++;
  return { v: 1, file, tables, problems: parsed.problems, summary };
}

// ── The check ───────────────────────────────────────────────────────────────
// Returns { exitCode, errors, notices, lines }. Exit 0 with no errors, 1 with errors (or, with strict, notices).
export function checkRoadmap(parsed, { strict = false, file = "" } = {}) {
  const all = [];
  for (const p of parsed.problems) all.push({ ...p, table: null });
  for (const t of parsed.tables) for (const p of t.problems) all.push({ ...p, table: t.index });
  const errors = all.filter((p) => p.level === "error").length;
  const notices = all.length - errors;
  const lines = all.map((p) => `${p.line > 0 ? `line ${p.line}` : "file"}: ${p.level} ${p.code}: ${p.message}${p.table === null ? "" : ` (table ${p.table})`}`);
  const phases = parsed.tables.reduce((n, t) => n + t.rows.length, 0);
  lines.push(`${file ? `${file}: ` : ""}${errors} error(s), ${notices} notice(s), ${parsed.tables.length} table(s), ${phases} phase(s)`);
  return { exitCode: errors > 0 || (strict && notices > 0) ? 1 : 0, errors, notices, lines };
}

// ── Standardize ─────────────────────────────────────────────────────────────
const hintFor = (id, prefix) => STATUSES.map((s) => (s.includes(" ") ? `--set-status "${prefix}${id}=${s}"` : `--set-status ${prefix}${id}=${s}`)).join(" | ");

function planTable(t, overrides, tables) {
  const res = { index: t.index, line: t.line, heading: t.heading, edits: [], changes: [], notices: [], blocked: [] };
  const H = t.headRow.cells.length;
  const lower = t.names.map((n) => n.toLowerCase());
  const newHead = [...t.headRow.cells];
  const finalNames = [...t.names];
  t.names.forEach((n, j) => {
    const target = ALIASES[n.toLowerCase()];
    if (!target) return;
    if (lower.some((l, k) => k !== j && l === target.toLowerCase())) {
      res.blocked.push({ line: t.line, id: null, code: "alias-clash", message: `header "${n}" cannot become "${target}": the table already has a "${target}" column; remove or rename one of them by hand` });
      return;
    }
    newHead[j] = newHead[j].replace(n, () => target);
    finalNames[j] = target;
  });
  const finalLower = finalNames.map((n) => n.toLowerCase());
  const idCol = finalLower.indexOf("#");
  let statusCol = finalLower.indexOf("status");
  let pfCol = finalLower.indexOf("plan file");
  let ntCol = finalLower.indexOf("note");
  const idOf = (row) => (idCol >= 0 ? (row.vals[idCol] ?? "") : "");
  const uniqueId = (id) => tables.filter((x) => x.rows.some((r) => clean(r.raw[x.names.map((n) => n.toLowerCase()).indexOf("#")] ?? "") === id)).length <= 1;

  // Pass 1: decide every row's status and the text that moves to Plan file or Note.
  const info = t.rows.map((row) => {
    const r = { row, skip: row.raw.length > H, status: null, extra: null, blockedStatus: false };
    const id = idOf(row);
    if (r.skip) {
      res.blocked.push({ line: row.line, id, code: "row-width", message: `row has ${row.raw.length} cells but the header has ${H}; fix the row by hand (an unescaped | in a cell?)` });
      return r;
    }
    const matching = overrides.filter((o) => id !== "" && o.id === id && (o.table === null || o.table === t.index));
    matching.forEach((o) => { o.used = true; });
    const ov = matching[0];
    const raw = statusCol >= 0 ? clean(row.raw[statusCol] ?? "") : null;
    const mapped = raw === null ? null : mapStatus(raw);
    if (ov) {
      r.status = ov.status;
      r.extra = mapped ? { planFile: mapped.planFile, note: mapped.note } : (raw && raw.toLowerCase() !== ov.status ? { note: raw } : null);
    } else if (raw === null) {
      r.status = "planned";
    } else if (mapped) {
      r.status = mapped.status;
      r.extra = { planFile: mapped.planFile, note: mapped.note };
    } else {
      r.blockedStatus = true;
      const prefix = uniqueId(id) ? "" : `${t.index}:`;
      res.blocked.push({
        line: row.line, id, code: "unmapped-status",
        message: `Status "${raw.length > 60 ? `${raw.slice(0, 57)}...` : raw}" cannot be placed`,
        hint: id !== "" && ID_RE.test(id) ? `choose one: ${hintFor(id, prefix)}` : "the row has no usable # cell; fix it by hand",
      });
    }
    return r;
  });

  const appended = [];
  if (statusCol < 0) appended.push("Status");
  if (pfCol < 0 && info.some((r) => r.extra?.planFile)) appended.push("Plan file");
  if (ntCol < 0 && info.some((r) => r.extra?.note)) appended.push("Note");
  if (statusCol < 0) {
    statusCol = H + appended.indexOf("Status");
    res.notices.push("this table has no Status column. A Status column will be added and EVERY row set to `planned`; rows that are already shipped, in progress or parked need --set-status.");
  }
  if (pfCol < 0 && appended.includes("Plan file")) pfCol = H + appended.indexOf("Plan file");
  if (ntCol < 0 && appended.includes("Note")) ntCol = H + appended.indexOf("Note");
  const addedStatus = appended.includes("Status");

  // Pass 2: build the new cells.
  const finalRows = [];
  for (const r of info) {
    const { row } = r;
    if (r.skip) { finalRows.push({ line: row.line, vals: row.vals, width: row.raw.length }); continue; }
    const cells = [...row.raw];
    // A last cell with no closing pipe has no space after it yet.
    if ((cells.length < H || appended.length) && cells.length && /\S$/.test(cells[cells.length - 1])) cells[cells.length - 1] += " ";
    while (cells.length < H) cells.push(" ");
    for (let k = 0; k < appended.length; k++) cells.push(" ");
    if (r.status !== null && (addedStatus || clean(cells[statusCol]) !== r.status)) cells[statusCol] = cellOf(r.status);
    for (const [key, col, label] of [["planFile", pfCol, "Plan file"], ["note", ntCol, "Note"]]) {
      const value = r.extra?.[key];
      if (!value) continue;
      const existing = clean(cells[col] ?? "");
      if (existing !== "" && existing !== value) {
        res.blocked.push({ line: row.line, id: idOf(row), code: "occupied", message: `the ${label} cell already has a value, so "${value}" from the Status cell cannot be moved there; fix the row by hand` });
        r.blockedStatus = true;
      } else cells[col] = cellOf(value);
    }
    const changed = cells.length !== row.raw.length || cells.some((c, i) => c !== row.raw[i]);
    if (changed) {
      const text = rebuildRow(row, cells);
      res.edits.push({ idx: row.idx, text });
      res.changes.push({ line: row.line, old: t.segsText[row.idx], new: text, idx: row.idx });
    }
    finalRows.push({ line: row.line, vals: cells.map(clean), width: cells.length, blocked: r.blockedStatus });
  }

  // Header, separator and marker.
  const headChanged = newHead.some((c, i) => c !== t.headRow.cells[i]) || appended.length > 0;
  if (headChanged) {
    const cells = [...newHead, ...appended.map((n) => ` ${n} `)];
    const text = rebuildRow(t.headRow, cells);
    res.edits.push({ idx: t.headerIdx, text });
    res.changes.push({ line: t.line, old: t.segsText[t.headerIdx], new: text, idx: t.headerIdx });
    if (appended.length) {
      const stext = rebuildRow(t.sepRow, [...t.sepRow.cells, ...appended.map(() => "---")]);
      res.edits.push({ idx: t.sepIdx, text: stext });
      res.changes.push({ line: t.line + 1, old: t.segsText[t.sepIdx], new: stext, idx: t.sepIdx });
    }
  }
  res.edits.push({ idx: t.headerIdx, insertBefore: MARKER });
  res.changes.push({ line: t.line, new: MARKER, insert: true, idx: t.headerIdx });

  // Whatever would still be an error in a standard table cannot be fixed here: say so, so --write is refused.
  const blockedLines = new Set(res.blocked.map((b) => b.line));
  const virtual = { legacy: false, version: 1, names: [...finalNames, ...appended], rows: finalRows, line: t.line, markerLine: t.line };
  for (const p of problemsFor(virtual)) {
    if (p.level !== "error" || blockedLines.has(p.line)) continue;
    res.blocked.push({ line: p.line, id: null, code: p.code, message: `${p.message}; fix it by hand` });
  }
  return res;
}

// Plans the standardizing of the chosen legacy tables. Returns { text, changed, changedLines, blocked, report }
// or { error }. It never writes anything. options: onlyTables (indexes; default every legacy table),
// statusOverrides ([{ id, status, table? }]).
export function planStandardize(text, options = {}) {
  const parsed = parseRoadmap(text);
  const { segs, tables } = parsed;
  const overrides = [];
  for (const o of options.statusOverrides ?? []) {
    const status = String(o.status ?? "").trim().toLowerCase();
    if (!STATUSES.includes(status)) return { error: `--set-status: "${o.status}" is not one of ${STATUSES.join(", ")}` };
    if (!o.id) return { error: "--set-status needs an id before the = sign" };
    overrides.push({ id: String(o.id), status, table: o.table ?? null, used: false });
  }
  const wanted = options.onlyTables ?? [];
  for (const n of wanted) if (!tables[n]) return { error: `there is no table with index ${n}` };
  const chosen = wanted.length ? [...new Set(wanted)].sort((a, b) => a - b) : tables.filter((t) => t.legacy).map((t) => t.index);
  const report = [];
  if (!tables.length) report.push("no roadmap table found");
  const results = [];
  for (const n of chosen) {
    const t = tables[n];
    if (!t.legacy) { report.push(`table ${n} (line ${t.line}) is already standard: nothing to change`); continue; }
    t.segsText = segs.map((s) => s.text);
    results.push(planTable(t, overrides, tables));
  }
  const unused = overrides.find((o) => !o.used);
  if (unused) return { error: `--set-status ${unused.table === null ? "" : `${unused.table}:`}${unused.id}=${unused.status} matches no row of the chosen tables` };

  const blocked = results.flatMap((r) => r.blocked.map((b) => ({ ...b, table: r.index })));
  const changedLines = results.reduce((n, r) => n + r.changes.length, 0);
  for (const r of results) {
    report.push(`table ${r.index} (line ${r.line}${r.heading ? `, heading "${r.heading}"` : ""}): legacy, will get the marker line`);
    for (const note of r.notices) report.push(`  NOTICE: ${note}`);
    for (const c of [...r.changes].sort((x, y) => x.idx - y.idx || (x.insert ? -1 : 0) - (y.insert ? -1 : 0))) {
      report.push(`  line ${c.line}${c.insert ? " (inserted above it)" : ""}:`);
      if (c.old !== undefined) report.push(`    - ${c.old}`);
      report.push(`    + ${c.new}`);
    }
    for (const b of r.blocked) {
      report.push(`  BLOCKED line ${b.line}${b.id ? ` (id ${b.id})` : ""}: ${b.message}`);
      if (b.hint) report.push(`    ${b.hint}`);
    }
  }
  report.push(changedLines === 0 && blocked.length === 0
    ? "nothing to change"
    : `summary: ${results.length} table(s) to change, ${changedLines} line(s) changed or added, ${blocked.length} blocked`);

  // Build the new text.
  const edits = new Map();
  for (const r of results) for (const e of r.edits) {
    const slot = edits.get(e.idx) ?? {};
    if (e.insertBefore) slot.insertBefore = e.insertBefore; else slot.text = e.text;
    edits.set(e.idx, slot);
  }
  const out = [];
  segs.forEach((s, i) => {
    const e = edits.get(i);
    if (e?.insertBefore) out.push(e.insertBefore + s.eol);
    out.push(e?.text !== undefined ? e.text + s.eol : s.text + s.eol);
  });
  const newText = out.join("");

  // A last safety net: a plan with nothing blocked must give tables that pass the check.
  if (!blocked.length && results.length) {
    const again = parseRoadmap(newText);
    const bad = results.find((r) => !again.tables[r.index] || again.tables[r.index].legacy || again.tables[r.index].problems.some((p) => p.level === "error"));
    if (bad) return { error: `internal check failed for table ${bad.index}: the result would not pass check, so nothing is written` };
  }
  return { text: newText, changed: results.length > 0, changedLines, blocked, report };
}

// ── set ─────────────────────────────────────────────────────────────────────
// Changes cells of one row of one standard table. Returns { text, line, row } or { error }.
// patch: { status, commit, actual, planFile, note } (only the keys given are written).
export function setPhase(text, id, patch = {}) {
  const parsed = parseRoadmap(text);
  const hits = [];
  const legacyHits = [];
  for (const t of parsed.tables) {
    const idCol = t.names.findIndex((n) => n.toLowerCase() === "#");
    for (const row of t.rows) if ((row.vals[idCol] ?? "") === id) (t.legacy ? legacyHits : hits).push({ t, row });
  }
  if (!hits.length) {
    return { error: legacyHits.length
      ? `id "${id}" is only in a legacy table (line ${legacyHits[0].t.line}): run standardize first`
      : `id "${id}" is in no standard table` };
  }
  if (hits.length > 1) return { error: `id "${id}" is in more than one row of the standard tables (lines ${hits.map((h) => h.row.line).join(", ")}); fix the ids first` };
  const { t, row } = hits[0];
  const values = {};
  if (patch.status !== undefined) {
    const s = String(patch.status).trim().toLowerCase();
    if (!STATUSES.includes(s)) return { error: `status "${patch.status}" must be one of ${STATUSES.join(", ")}`, usage: true };
    values.status = s;
  }
  if (patch.actual !== undefined) {
    const raw = String(patch.actual).trim().replace(/\s*h$/i, "");
    if (!/^\d+(\.\d+)?$/.test(raw)) return { error: `actual "${patch.actual}" must be a number of hours`, usage: true };
    values.actual = `${Number(raw)} h`;
  }
  for (const [key, label] of [["commit", "commit"], ["planFile", "plan-file"], ["note", "note"]]) {
    if (patch[key] === undefined) continue;
    const v = String(patch[key]);
    if (/[\r\n]/.test(v)) return { error: `${label} must be one line`, usage: true };
    values[key] = v.trim();
  }
  if (!Object.keys(values).length) return { error: "nothing to set", usage: true };
  const lower = t.names.map((n) => n.toLowerCase());
  const target = { status: "status", commit: "commit / deploy", actual: "actual", planFile: "plan file", note: "note" };
  const labels = { status: "Status", commit: "Commit / deploy", actual: "Actual", planFile: "Plan file", note: "Note" };
  if (row.raw.length !== t.names.length) return { error: `the row of id "${id}" (line ${row.line}) has ${row.raw.length} cells but the header has ${t.names.length}; fix the row first` };
  const cells = [...row.raw];
  for (const [key, v] of Object.entries(values)) {
    const c = lower.indexOf(target[key]);
    if (c < 0) return { error: `the table has no "${labels[key]}" column, so ${key === "planFile" ? "plan-file" : key} cannot be set` };
    cells[c] = cellOf(v);
  }
  const line = rebuildRow(row, cells);
  const out = parsed.segs.map((s, i) => (i === row.idx ? line : s.text) + s.eol).join("");
  return { text: out, line: row.line, row: line.trim() };
}

// ── Files ───────────────────────────────────────────────────────────────────
const USAGE = [
  "usage: node roadmap.mjs read <file> [--root <dir>]",
  "       node roadmap.mjs check <file> [--strict] [--root <dir>]",
  "       node roadmap.mjs standardize <file> [--table <index>]... [--set-status <id>=<status>]... [--write] [--root <dir>]",
  "       node roadmap.mjs set <file> <id> [--status <s>] [--commit <text>] [--actual <hours>] [--plan-file <p>] [--note <t>] [--root <dir>]",
  "       node roadmap.mjs restore <file> [--from original|prev|<backup name>] [--write] [--root <dir>]",
];

function parseArgs(argv, bool, value) {
  const pos = [];
  const opts = {};
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

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const WIN = process.platform === "win32";
const BACKUP_DIR = ".roadmap-backups";

// Resolves and reads the file. Returns { path, name, mode, bytes, text } or { fail } with a message that names
// the base name only. `name` is the real file's name (after symlinks, 8.3 names and letter case are resolved), so
// every backup of one file has one name however it was typed. `bytes` is exactly what was read; every copy is
// made from it, never by reading the file again.
function load(file, rootOpt) {
  const typed = basename(String(file));
  if (WIN && typed.includes(":")) return { fail: `${typed} cannot be used: a colon in a file name is an NTFS stream name on Windows` };
  let real;
  try { real = realpathSync.native(resolve(file)); } catch (e) { return { fail: e?.code === "ENOENT" ? `cannot read ${typed}: no such file` : `cannot read ${typed} (${codeOf(e)})` }; }
  const name = basename(real);
  if (WIN && name.includes(":")) return { fail: `${name} cannot be used: a colon in a file name is an NTFS stream name on Windows` };
  const folder = basename(dirname(real));
  if (WIN ? folder.toLowerCase() === BACKUP_DIR : folder === BACKUP_DIR) {
    return { fail: `${name} is inside a ${BACKUP_DIR} folder, which holds kept copies; give the roadmap file itself, not a copy. Nothing was read or written` };
  }
  if (rootOpt !== undefined) {
    let root;
    try { root = realpathSync.native(resolve(rootOpt)); } catch { return { fail: "cannot use --root: the folder cannot be read" }; }
    const rel = relative(root, real);
    if (isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") return { fail: `${name} is outside the --root folder; nothing was read or written` };
  }
  try {
    const bytes = readFileSync(real);
    return { path: real, name, mode: lstatSync(real).mode & 0o777, bytes, text: decoder.decode(bytes) };
  } catch (e) {
    return { fail: `cannot read ${name}: ${e instanceof TypeError ? "it is not valid UTF-8 text" : (e.code ?? "error")}` };
  }
}

// ── Backups ─────────────────────────────────────────────────────────────────
const CHANGED = "the roadmap changed while it was being written; nothing was changed, run again";
const codeOf = (e) => e?.code ?? "error";
// File modes apply where the system has them: copies are owner-only, the folder too. Windows gets the defaults.
const FILE_MODE = WIN ? undefined : 0o600;
const DIR_MODE = WIN ? undefined : 0o700;

// Creates a file that must not exist yet (flag wx), writes all of data into it and flushes it to disk. Returns
// null, or an error code. A file this call created but could not finish is removed again; a file that was
// already there is never opened for writing and never removed.
function createExclusive(path, data) {
  let fd;
  try { fd = openSync(path, "wx", FILE_MODE); } catch (e) { return codeOf(e); }
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    discard(path);
    return codeOf(e);
  }
  return null;
}

// Flushes a folder's entries after a rename or a link, where the system allows it. Never throws; not done on Windows.
function syncDir(dir) {
  if (WIN) return;
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best effort only */ }
}

const INCOMPLETE = ".incomplete";
const tempName = (path) => `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;

// Publishes a COMPLETE file under a final name that must not exist yet. The bytes go into a temp file first
// (flushed to disk); a hard link then gives the temp file its final name, which fails when the name is taken,
// and the temp name is removed. So the final name never holds half a file. Returns null, or an error code
// ("EEXIST" when the name is taken). Where links are not possible (FAT, exFAT, some network drives) the file is
// written under its final name instead, with "<final>.incomplete" made first and removed last: if the process
// is killed in between, the marker stays, and every later write refuses until the owner has looked.
// io.beforeLink and io.afterMarker are seams for tests; io.linkError makes the link step fail with that code.
function publishExclusive(path, data, io = {}) {
  const tmp = tempName(path);
  const made = createExclusive(tmp, data);
  if (made) return made;
  io.beforeLink?.(tmp, path);
  try {
    if (io.linkError) throw Object.assign(new Error("link refused"), { code: io.linkError });
    linkSync(tmp, path);
  } catch (e) {
    discard(tmp);
    if (e?.code === "EEXIST") return "EEXIST";
    return publishInPlace(path, data, io);
  }
  discard(tmp);
  syncDir(dirname(path));
  return null;
}

function publishInPlace(path, data, io) {
  // A name that is taken already is not ours to mark: no marker is made for it.
  try { if (lstatOrNull(path)) return "EEXIST"; } catch { /* createExclusive below reports what is wrong */ }
  const marker = `${path}${INCOMPLETE}`;
  const flagged = createExclusive(marker, "");
  if (flagged) return flagged;
  io.afterMarker?.(marker, path);
  const made = createExclusive(path, data);
  if (!made) { discard(marker); return null; }
  // The write failed. The marker goes only when nothing is left at the final name; a file that is still there
  // (a half-written one that could not be removed, or one another process made) keeps the marker, so it is
  // never trusted until the owner has looked. The check cannot throw.
  try { if (!lstatOrNull(path)) discard(marker); } catch { /* the marker stays */ }
  return made;
}

// Removes a temp file this command made. Never throws.
function discard(path) {
  try { rmSync(path, { force: true }); } catch { /* the temp file stays; it is not the roadmap */ }
}

// True when the file still holds exactly these bytes. A file that cannot be read counts as changed.
function unchanged(path, bytes) {
  try { return readFileSync(path).equals(bytes); } catch { return false; }
}

function lstatOrNull(path) {
  try { return lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// Looks at the backup folder without creating anything. Returns { dir, exists } or { fail } (a short reason).
// The folder must be a real directory (not a symlink or a file) that resolves inside the roadmap file's folder.
function inspectBackupDir(realFile) {
  const dir = join(dirname(realFile), BACKUP_DIR);
  try {
    const st = lstatOrNull(dir);
    if (!st) return { dir, exists: false };
    if (!st.isDirectory()) return { fail: "it is not a real folder" };
    const inside = join(realpathSync.native(dirname(realFile)), BACKUP_DIR);
    if (!samePath(realpathSync.native(dir), inside)) return { fail: "it does not resolve inside the roadmap file's folder" };
    return { dir, exists: true };
  } catch (e) {
    return { fail: codeOf(e) };
  }
}

// Looks for the marker of a copy that was cut short (one that belongs to this roadmap's backups). Reads directory
// entries only. Returns { marker } (a name, or null) or { fail }.
function interruptedCopy(dir, name) {
  let names;
  try { names = readdirSync(dir); } catch (e) { return { fail: `could not list it (${codeOf(e)})` }; }
  for (const n of names) {
    if (!n.endsWith(INCOMPLETE)) continue;
    const base = n.slice(0, -INCOMPLETE.length);
    if (base === ".gitignore" || base === `${name}.original` || hasStamp(base, `${name}.bak-`) || hasStamp(base, `${name}.before-restore-`)) return { marker: n };
  }
  return { marker: null };
}

// Makes the backup folder when it is missing (and its .gitignore, which holds only "*"). Returns { dir, warn } or
// { fail }. An existing .gitignore is never changed: a folder or a link in its place fails closed, and a file with
// other content sets warn (the owner may have a reason, but git may then list the backups).
function ensureBackupDir(realFile, name, io) {
  let info = inspectBackupDir(realFile);
  if (info.fail) return info;
  if (!info.exists) {
    try { mkdirSync(info.dir, { mode: DIR_MODE }); } catch (e) { if (codeOf(e) !== "EEXIST") return { fail: codeOf(e) }; }
    info = inspectBackupDir(realFile);
    if (info.fail) return info;
    if (!info.exists) return { fail: "it could not be created" };
  }
  const found = interruptedCopy(info.dir, name);
  if (found.fail) return found;
  if (found.marker) return { interrupted: found.marker };
  const ignore = join(info.dir, ".gitignore");
  try {
    let st = lstatOrNull(ignore);
    if (!st) {
      const ignored = publishExclusive(ignore, "*\n", io);
      if (!ignored) return { dir: info.dir, warn: false };
      if (ignored !== "EEXIST") return { fail: `.gitignore: ${ignored}` };
      st = lstatOrNull(ignore);
    }
    if (!st?.isFile()) return { fail: ".gitignore is not a regular file" };
    return { dir: info.dir, warn: readFileSync(ignore, "utf8").replace(/\r?\n$/, "") !== "*" };
  } catch (e) {
    return { fail: `.gitignore: ${codeOf(e)}` };
  }
}

// Keeps <name>.original: published complete (see publishExclusive) once from the bytes read, never overwritten,
// never opened for writing again. Returns { created } or { fail } (a short reason).
function keepOriginal(dir, name, bytes, io) {
  const path = join(dir, `${name}.original`);
  const notRegular = { fail: "it is not a regular file" };
  try {
    const st = lstatOrNull(path);
    if (st) return st.isFile() ? { created: false } : notRegular;
    const made = publishExclusive(path, bytes, io);
    if (!made) return { created: true };
    if (made !== "EEXIST") return { fail: made };
    if (!lstatOrNull(path)?.isFile()) return notRegular;
    if (lstatOrNull(`${path}${INCOMPLETE}`)) return { fail: "an earlier copy of it was cut short" };
    return { created: false };
  } catch (e) {
    return { fail: codeOf(e) };
  }
}

// What to do about a marker: name the copy it belongs to. A cut-short .original must not be trusted, so the owner
// compares it and deletes it too when it looks wrong (it is made again from the current roadmap).
function markerAdvice(marker, name) {
  const copy = marker.slice(0, -INCOMPLETE.length);
  if (copy === `${name}.original`) {
    return `Compare ${copy} with the roadmap; if it is shorter than the roadmap, different, or you are unsure, delete ${copy} too (it is made again from the current roadmap), and only then delete the marker file`;
  }
  return `The cut-short copy is ${copy}: delete ${copy} and then delete the marker file`;
}

// The folder and <name>.original, before any write. Returns { dir, madeOriginal } or { msg }.
function prepareBackups(f, io, err) {
  const made = ensureBackupDir(f.path, f.name, io);
  if (made.interrupted) {
    return { msg: `${made.interrupted} is in the ${BACKUP_DIR} folder: an earlier copy was cut short. ${markerAdvice(made.interrupted, f.name)}; nothing was written. ${f.name} was not changed` };
  }
  if (made.fail) return { msg: `could not use the ${BACKUP_DIR} folder (${made.fail}); nothing was written. ${f.name} was not changed` };
  if (made.warn) err(`warning: ${BACKUP_DIR}/.gitignore does not hold only "*", so git may list your backups; check it`);
  const orig = keepOriginal(made.dir, f.name, f.bytes, io);
  if (orig.fail) return { msg: `could not keep ${f.name}.original (${orig.fail}); nothing was written. ${f.name} was not changed` };
  return { dir: made.dir, madeOriginal: orig.created };
}

const keptFirst = (f) => `first version kept as ${f.name}.original in ${BACKUP_DIR}/ (never overwritten)`;

const RETRY_CODES = ["EPERM", "EACCES", "EBUSY"];
const RETRIES = 10;
const sleepMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Renames tmp over final. On Windows only, a rename refused for a moment (EPERM, EACCES, EBUSY: a scanner or
// indexer holding a file) is retried up to 10 times, waiting 10 ms, then 20 ms, up to 100 ms; before each retry
// recheck() must still say the roadmap is as the command read it. Returns null when it is done, { changed: true }
// when recheck said no, or { code } for the error that stopped it. env is for tests: { rename, platform, wait }.
export function renameWithRetry(tmp, final, recheck, env = {}) {
  const rename = env.rename ?? ((a, b) => renameSync(a, b));
  const retrying = (env.platform ?? process.platform) === "win32";
  const wait = env.wait ?? sleepMs;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, final);
      if (!env.rename) syncDir(dirname(final));
      return null;
    } catch (e) {
      if (!retrying || !RETRY_CODES.includes(e?.code) || attempt >= RETRIES) return { code: codeOf(e) };
    }
    wait(Math.min(100, 10 * (attempt + 1)));
    if (!recheck()) return { changed: true };
  }
}

// set: keeps the file as it is now as <name>.prev (a temp file, then a rename), unless the file changed since it
// was read. Returns an error message or null. A failure leaves the old .prev in place.
function keepPrev(dir, f, io) {
  const final = join(dir, `${f.name}.prev`);
  const tmp = join(dir, `${f.name}.prev.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const made = createExclusive(tmp, f.bytes);
  if (made) return `could not keep ${f.name}.prev (${made}); nothing was written. ${f.name} was not changed`;
  io.beforeRename?.("prev");
  if (!unchanged(f.path, f.bytes)) {
    discard(tmp);
    return CHANGED;
  }
  const moved = renameWithRetry(tmp, final, () => unchanged(f.path, f.bytes), io);
  if (moved) {
    discard(tmp);
    return moved.changed ? CHANGED : `could not keep ${f.name}.prev (${moved.code}); nothing was written. ${f.name} was not changed`;
  }
  return null;
}

// Writes the new text to <dir>/<name>.tmp (the backup folder, flag wx; same disk, so the rename is atomic), then
// renames it over the file, after one more read to see that the file is still what the command read. The file
// keeps its mode. Returns an error message or null.
function replaceFile(f, data, io, dir) {
  const tmp = join(dir, `${f.name}.tmp`);
  const made = createExclusive(tmp, data);
  if (made) {
    return made === "EEXIST"
      ? `another write to ${f.name} may be in progress; if none is, delete ${BACKUP_DIR}/${f.name}.tmp and try again. ${f.name} was not changed`
      : `could not write ${BACKUP_DIR}/${f.name}.tmp (${made}). ${f.name} was not changed`;
  }
  if (!WIN) {
    try { chmodSync(tmp, f.mode); } catch (e) {
      discard(tmp);
      return `could not set the mode of the new ${f.name} (${codeOf(e)}). ${f.name} was not changed`;
    }
  }
  io.beforeRename?.("roadmap");
  if (!unchanged(f.path, f.bytes)) {
    discard(tmp);
    return CHANGED;
  }
  const moved = renameWithRetry(tmp, f.path, () => unchanged(f.path, f.bytes), io);
  if (moved) {
    discard(tmp);
    return moved.changed ? CHANGED : `could not replace ${f.name} (${moved.code}). ${f.name} was not changed`;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, "0");
const stampOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const minuteOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const countLines = (bytes) => { let n = 0; for (const b of bytes) if (b === 0x0a) n++; return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? n + 1 : n; };

// ── restore ─────────────────────────────────────────────────────────────────
const STAMPED = /^\d{8}-\d{6}$/;
const hasStamp = (n, prefix) => n.startsWith(prefix) && STAMPED.test(n.slice(prefix.length));

// The kept copies of one roadmap file: the ones in the backup folder, then legacy <name>.bak-* copies next to
// the file (made by 0.7.0). Only regular files count. Newest first. Reads nothing but directory entries and stats.
// io.listDir is a seam for tests: a function that replaces the folder listing.
function collectBackups(f, info, io = {}) {
  const list = io.listDir ?? readdirSync;
  const entries = [];
  const add = (dir, n, legacy) => {
    const path = join(dir, n);
    const st = lstatOrNull(path);
    if (st?.isFile()) entries.push({ name: n, path, legacy, size: st.size, mtime: st.mtime, mtimeMs: st.mtimeMs });
  };
  const stampedBak = `${f.name}.bak-`;
  const stampedRestore = `${f.name}.before-restore-`;
  if (info.exists) {
    for (const n of list(info.dir)) {
      if (n === `${f.name}.original` || n === `${f.name}.prev` || hasStamp(n, stampedBak) || hasStamp(n, stampedRestore)) add(info.dir, n, false);
    }
  }
  for (const n of list(dirname(f.path))) {
    if (hasStamp(n, stampedBak) && !entries.some((e) => e.name === n)) add(dirname(f.path), n, true);
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
}

// The lines that differ between two texts, as hunks { line (1-based, in the current text), del, add } with the
// line text. `null` hunks with counts when the middle part is too big to compare (nothing is hidden: the counts say so).
function lineDiff(currentText, otherText) {
  const a = splitLines(currentText);
  const b = splitLines(otherText);
  const key = (s) => s.text + s.eol;
  let pre = 0;
  while (pre < a.length && pre < b.length && key(a[pre]) === key(b[pre])) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && key(a[a.length - 1 - suf]) === key(b[b.length - 1 - suf])) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const styles = (segs) => [...new Set(segs.map((s) => s.eol))].sort().join("|");
  const marks = styles(a) !== styles(b);
  const show = (s) => s.text + (marks ? (s.eol === "\r\n" ? " [CRLF]" : s.eol === "\n" ? " [LF]" : " [no newline at end]") : "");
  if (am.length * bm.length > 4_000_000) return { hunks: null, removed: am.length, added: bm.length };
  const n = am.length;
  const m = bm.length;
  const W = m + 1;
  const L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = key(am[i]) === key(bm[j]) ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  let removed = 0;
  let added = 0;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && key(am[i]) === key(bm[j])) { flush(); i++; j++; continue; }
    cur ??= { line: pre + i + 1, del: [], add: [] };
    if (j >= m || (i < n && L[(i + 1) * W + j] >= L[i * W + j + 1])) { cur.del.push(show(am[i])); removed++; i++; } else { cur.add.push(show(bm[j])); added++; j++; }
  }
  flush();
  return { hunks, removed, added };
}

// restore <file>: list, plan or write. f is the loaded roadmap file. Returns the exit code.
function restoreCommand(f, from, write, io, out, err, now) {
  const info = inspectBackupDir(f.path);
  if (info.fail) { err(`cannot use the ${BACKUP_DIR} folder (${info.fail}); nothing was read or written`); return 1; }
  let entries;
  try { entries = collectBackups(f, info, io); } catch (e) { err(`cannot list the backups of ${f.name} (${codeOf(e)}); nothing was written`); return 1; }

  if (from === undefined) {
    if (!entries.length) { out("no backups yet"); return 0; }
    out(`backups of ${f.name} (${BACKUP_DIR}/ next to the file, newest first; ${f.name}.original is the first version the tool ever saw)`);
    for (const e of entries) {
      let lines = "?";
      try { lines = String(countLines(readFileSync(e.path))); } catch { /* listed without a line count */ }
      out(`  ${e.name}  ${e.size} bytes  ${lines} line(s)  ${minuteOf(e.mtime)}${e.legacy ? "  legacy (next to the file, made by an older version)" : ""}`);
    }
    out(`to see what a restore would change: restore ${f.name} --from <name>`);
    return 0;
  }

  const wanted = from === "original" ? `${f.name}.original` : from === "prev" ? `${f.name}.prev` : from;
  const hit = entries.find((e) => e.name === wanted);
  if (!hit) {
    err(from === "original" || from === "prev" ? `there is no ${from} copy of ${f.name} yet` : `there is no backup named ${from}; run restore without --from to list them`);
    return 2;
  }
  let other;
  let otherText;
  try {
    other = readFileSync(hit.path);
    otherText = decoder.decode(other);
  } catch (e) {
    err(`cannot read ${hit.name}: ${e instanceof TypeError ? "it is not valid UTF-8 text" : codeOf(e)}; nothing was written`);
    return 2;
  }
  if (other.equals(f.bytes)) { out(`nothing to restore: ${hit.name} is identical to ${f.name}`); return 0; }

  const diff = lineDiff(f.text, otherText);
  out(`restore plan for ${f.name} from ${hit.name}${write ? " (with --write)" : ": nothing is written without --write"}`);
  if (diff.hunks) {
    for (const h of diff.hunks) {
      out(`  line ${h.line}:`);
      for (const l of h.del) out(`    - ${l}`);
      for (const l of h.add) out(`    + ${l}`);
    }
  } else out("  (too many lines differ to list them one by one)");
  out(`summary: ${Math.max(diff.removed, diff.added)} line(s) would change (${diff.removed} removed, ${diff.added} added)`);
  if (!write) return 0;

  const prep = prepareBackups(f, io, err);
  if (prep.msg) { err(prep.msg); return 1; }
  const saved = `${f.name}.before-restore-${stampOf(now())}`;
  const made = publishExclusive(join(prep.dir, saved), f.bytes, io);
  if (made) {
    err(made === "EEXIST"
      ? `the copy ${saved} already exists; nothing was written. Wait a second and run again`
      : `could not save ${saved} (${made}); nothing was written. ${f.name} was not changed`);
    return 1;
  }
  const failed = replaceFile(f, other, io, prep.dir);
  if (failed) { err(failed); return 1; }
  if (prep.madeOriginal) out(keptFirst(f));
  out(`saved ${saved} in ${BACKUP_DIR}/ first (restore from it to undo this)`);
  out(`restored ${f.name} from ${hit.name}`);
  return 0;
}

// The command line. io: { out, err, now } and the test seams { afterLoad(f) (right after the file was read),
// beforeRename(stage), beforeLink(tmp, final), afterMarker(marker, final), linkError (a code), rename, platform,
// wait } for tests. Returns the exit code. A failure nobody planned
// for is reported by its code only (never a stack, which would carry absolute paths) and gives exit 1.
export function main(argv, io = {}) {
  try {
    return execute(argv, io);
  } catch (e) {
    (io.err ?? ((m) => console.error(m)))(`unexpected failure (${codeOf(e)}); check that the roadmap file is as you expect and run again`);
    return 1;
  }
}

function execute(argv, io) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const now = io.now ?? (() => new Date());
  const usage = (msg) => { if (msg) err(msg); for (const l of USAGE) err(l); return 2; };
  const [cmd, ...rest] = argv;
  if (!["read", "check", "standardize", "set", "restore"].includes(cmd)) return usage(cmd ? `unknown command ${cmd}` : "");
  const spec = {
    read: [["--root"], []], check: [["--root"], ["--strict"]],
    standardize: [["--root", "--table", "--set-status"], ["--write"]],
    set: [["--root", "--status", "--commit", "--actual", "--plan-file", "--note"], []],
    restore: [["--root", "--from"], ["--write"]],
  }[cmd];
  const parsed = parseArgs(rest, spec[1], spec[0]);
  if (parsed.error) return usage(parsed.error);
  const { pos, opts } = parsed;
  const wantPos = cmd === "set" ? 2 : 1;
  if (pos.length !== wantPos) return usage(`${cmd} needs ${cmd === "set" ? "a file and an id" : "a file"}`);
  if (opts["--root"] && opts["--root"].length > 1) return usage("--root can be given once");
  let from;
  if (cmd === "restore") {
    if (opts["--from"] && opts["--from"].length > 1) return usage("--from can be given once");
    from = opts["--from"]?.[0];
    if (from !== undefined && (from === "" || from.includes("/") || from.includes("\\") || from.includes(".."))) {
      return usage("--from takes original, prev, or a backup name from the list (no folders, no path)");
    }
    if (opts["--write"] && from === undefined) return usage("--write needs --from");
  }
  const f = load(pos[0], opts["--root"]?.[0]);
  if (f.fail) { err(f.fail); return 2; }
  io.afterLoad?.(f);

  if (cmd === "read") {
    out(JSON.stringify(toReadJson(parseRoadmap(f.text), f.name), null, 2));
    return 0;
  }
  if (cmd === "check") {
    const r = checkRoadmap(parseRoadmap(f.text), { strict: opts["--strict"] === true, file: f.name });
    for (const l of r.lines) out(l);
    return r.exitCode;
  }
  if (cmd === "restore") return restoreCommand(f, from, opts["--write"] === true, io, out, err, now);
  if (cmd === "standardize") {
    const tablesGiven = [];
    for (const v of opts["--table"] ?? []) {
      if (!/^\d+$/.test(v)) return usage(`--table needs a table index (a whole number), got "${v}"`);
      tablesGiven.push(Number(v));
    }
    const overrides = [];
    for (const v of opts["--set-status"] ?? []) {
      const m = v.match(/^(?:(\d+):)?([^=:]+)=(.+)$/);
      if (!m) return usage(`--set-status needs <id>=<status> (or <table>:<id>=<status>), got "${v}"`);
      overrides.push({ table: m[1] === undefined ? null : Number(m[1]), id: m[2].trim(), status: m[3] });
    }
    const plan = planStandardize(f.text, { onlyTables: tablesGiven, statusOverrides: overrides });
    if (plan.error) return usage(plan.error);
    out(`standardize plan for ${f.name}${opts["--write"] ? " (with --write)" : ": nothing is written without --write"}`);
    for (const l of plan.report) out(l);
    if (!opts["--write"]) return 0;
    if (plan.blocked.length) {
      err(`refusing to write: ${plan.blocked.length} blocked item(s) above. Resolve them (--set-status, or by hand) and run again. ${f.name} was not changed and no backup was made`);
      return 1;
    }
    if (!plan.changed) return 0;
    const prep = prepareBackups(f, io, err);
    if (prep.msg) { err(prep.msg); return 1; }
    const backup = `${f.name}.bak-${stampOf(now())}`;
    const made = publishExclusive(join(prep.dir, backup), f.bytes, io);
    if (made) {
      err(made === "EEXIST"
        ? `the backup ${backup} already exists; nothing was written. Wait a second and run again`
        : `could not make the backup (${made}); nothing was written`);
      return 1;
    }
    const failed = replaceFile(f, plan.text, io, prep.dir);
    if (failed) { err(failed); return 1; }
    if (prep.madeOriginal) out(keptFirst(f));
    out(`backup: ${backup} (in ${BACKUP_DIR}/, ignored by git; ${f.name}.original keeps your first version for good, the other copies can be deleted)`);
    out(`wrote ${f.name}: ${plan.changedLines} line(s) changed or added`);
    return 0;
  }
  // set
  const patch = {};
  for (const [flag, key] of [["--status", "status"], ["--commit", "commit"], ["--actual", "actual"], ["--plan-file", "planFile"], ["--note", "note"]]) {
    if (opts[flag]) {
      if (opts[flag].length > 1) return usage(`${flag} can be given once`);
      patch[key] = opts[flag][0];
    }
  }
  const res = setPhase(f.text, pos[1], patch);
  if (res.error) { err(res.error); return res.usage ? 2 : 1; }
  const prep = prepareBackups(f, io, err);
  if (prep.msg) { err(prep.msg); return 1; }
  const kept = keepPrev(prep.dir, f, io);
  if (kept) { err(kept); return 1; }
  const failed = replaceFile(f, res.text, io, prep.dir);
  if (failed) { err(failed); return 1; }
  out(`updated ${f.name} line ${res.line}: ${res.row}`);
  if (prep.madeOriginal) out(`${keptFirst(f)}; the version before this change is ${f.name}.prev`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
