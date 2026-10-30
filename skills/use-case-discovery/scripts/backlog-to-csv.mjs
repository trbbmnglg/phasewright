#!/usr/bin/env node
// backlog-to-csv: turns a discovery pack's export/backlog.json (version 1) into import files for Jira and Azure Boards.
//   node backlog-to-csv.mjs --input <path to backlog.json> [--process agile|scrum|cmmi] [--flat] [--acceptance-column]
// Writes jira.csv and azure-devops.csv (numbered azure-devops-1.csv, -2, ... past 1,000 items) in the folder of the input.
// Fails closed: the whole file is checked and both outputs are built in memory before anything is written.
// No dependencies. Exit codes: 0 done, 1 bad input or usage, 2 file error.
//
// Format rules, from the vendors' pages (read 2026-10-30):
//  - Jira (support.atlassian.com, "Prepare and structure your CSV file"): Summary is required; the header row maps columns; fields with
//    commas or line breaks are quoted, a literal quote is doubled; one repeated column per value (Label, Label); hierarchies use
//    "Work item ID" and "Parent" columns where Parent is the parent's work item ID.
//  - Azure Boards (learn.microsoft.com, "Export, update, and import bulk work items with CSV files", updated 2026-07-23): Work Item Type and
//    Title are required; new items take no ID; up to 1,000 per import; parent-child through indented Title 1 / Title 2 columns; tags are
//    separated by a semicolon; HTML fields hold HTML.
//  - OWASP "CSV Injection": a cell that starts with = + - @ (also tab, CR, LF, or the full-width forms) can run as a formula. A single quote is
//    put in front of such a cell. OWASP warns that no sanitizing works in every spreadsheet.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_ITEMS = 2000;
export const AZURE_ROW_LIMIT = 1000;
const MAX_INPUT_BYTES = 1_000_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// control characters except tab and line breaks, and bidirectional or zero-width format characters
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/;
const ITEM_KEYS = new Set(["id", "type", "title", "description", "acceptanceCriteria", "priority", "tags", "parent", "trace"]);
const TOP_KEYS = new Set(["version", "topic", "items"]);
const PROCESS_TYPES = {
  agile: { epic: "Epic", story: "User Story" },
  scrum: { epic: "Epic", story: "Product Backlog Item" },
  cmmi: { epic: "Epic", story: "Requirement" },
};

export class InputError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

// ---- validation ----

const isText = (v) => typeof v === "string";
const clean = (v) => !BAD_CHARS.test(v);

// Returns { topic, items } or throws InputError listing every problem found (first 20).
export function validateBacklog(data) {
  const problems = [];
  const bad = (msg) => { if (problems.length < 20) problems.push(msg); };
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new InputError(["the file must hold one JSON object"]);
  for (const k of Object.keys(data)) if (!TOP_KEYS.has(k)) bad(`unknown field "${k}" at the top level`);
  if (data.version !== 1) bad(`"version" must be 1 (found ${JSON.stringify(data.version)})`);
  if (data.topic !== undefined && (!isText(data.topic) || data.topic.length > 200 || !clean(data.topic))) bad('"topic" must be text of at most 200 characters');
  const items = data.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) throw new InputError([...problems, `"items" must be a list of 1 to ${MAX_ITEMS} items`]);

  const byId = new Map();
  items.forEach((it, i) => {
    const at = `items[${i}]${it && isText(it.id) ? ` (${it.id})` : ""}`;
    if (it === null || typeof it !== "object" || Array.isArray(it)) return bad(`${at}: must be an object`);
    for (const k of Object.keys(it)) if (!ITEM_KEYS.has(k)) bad(`${at}: unknown field "${k}"`);
    if (!isText(it.id) || !ID_RE.test(it.id)) bad(`${at}: "id" must be letters, digits, _ or -, up to 32 characters`);
    else if (byId.has(it.id)) bad(`${at}: duplicate id`);
    else byId.set(it.id, it);
    if (it.type !== "epic" && it.type !== "story") bad(`${at}: "type" must be "epic" or "story"`);
    if (!isText(it.title) || it.title.trim().length < 1 || it.title.length > 255 || /[\r\n]/.test(it.title) || !clean(it.title)) bad(`${at}: "title" must be 1 to 255 characters on one line`);
    if (it.description !== undefined && (!isText(it.description) || it.description.length > 20000 || !clean(it.description))) bad(`${at}: "description" must be text of at most 20000 characters`);
    if (it.acceptanceCriteria !== undefined) {
      const a = it.acceptanceCriteria;
      if (it.type === "epic") bad(`${at}: an epic carries no acceptanceCriteria`);
      else if (!Array.isArray(a) || a.length > 30 || a.some((x) => !isText(x) || x.trim().length < 1 || x.length > 4000 || !clean(x))) bad(`${at}: "acceptanceCriteria" must be a list of up to 30 texts of at most 4000 characters`);
    }
    if (it.priority !== undefined && (!Number.isInteger(it.priority) || it.priority < 1 || it.priority > 4)) bad(`${at}: "priority" must be a whole number from 1 to 4`);
    if (it.tags !== undefined) {
      const t = it.tags;
      if (!Array.isArray(t) || t.length > 20 || t.some((x) => !isText(x) || x.trim().length < 1 || x.length > 50 || /[,;\r\n\t]/.test(x) || !clean(x))) bad(`${at}: "tags" must be a list of up to 20 texts of 1 to 50 characters with no comma or semicolon`);
    }
    if (it.trace !== undefined && (!Array.isArray(it.trace) || it.trace.length > 20 || it.trace.some((x) => !isText(x) || !ID_RE.test(x)))) bad(`${at}: "trace" must be a list of up to 20 IDs`);
    if (it.parent !== undefined && !isText(it.parent)) bad(`${at}: "parent" must be an id`);
  });
  for (const [id, it] of byId) {
    if (it.parent === undefined) continue;
    const p = byId.get(it.parent);
    if (it.type === "epic") problems.length < 20 && problems.push(`${id}: an epic has no parent`);
    else if (!p) problems.length < 20 && problems.push(`${id}: parent "${it.parent}" is not in the file`);
    else if (p.type !== "epic") problems.length < 20 && problems.push(`${id}: parent "${it.parent}" is not an epic`);
  }
  if (problems.length) throw new InputError(problems);
  return { topic: data.topic ?? "", items };
}

// ---- CSV helpers ----

const FORMULA_START = /^\s*[=+\-@＝＋－＠]|^[\t\r\n]/;
// A cell that could run as a formula gets a single quote in front (OWASP, "CSV Injection").
export const guardCell = (s) => (FORMULA_START.test(s) ? `'${s}` : s);
export const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;
export const csvRows = (rows) => `${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
const nl = (s) => s.replace(/\r\n?/g, "\n");
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const traceLine = (it) => `Discovery ID: ${it.id}.${it.trace?.length ? ` Trace: ${it.trace.join(", ")}.` : ""}`;

// Epics first, each followed by its stories (file order), then stories without an epic.
export function orderItems(items) {
  const out = [];
  const used = new Set();
  for (const e of items.filter((i) => i.type === "epic")) {
    out.push(e);
    used.add(e.id);
    for (const s of items) if (s.parent === e.id) { out.push(s); used.add(s.id); }
  }
  for (const s of items) if (!used.has(s.id)) out.push(s);
  return out;
}

// ---- Jira ----

export function buildJira(items) {
  const ordered = orderItems(items);
  const num = new Map(ordered.map((it, i) => [it.id, i + 1]));
  const labelsOf = (it) => (it.tags ?? []).map((t) => t.trim().replace(/\s+/g, "-"));
  const maxLabels = Math.max(0, ...ordered.map((it) => labelsOf(it).length));
  const header = ["Work item ID", "Work type", "Summary", "Description", "Parent", ...Array(maxLabels).fill("Label")];
  const rows = ordered.map((it) => {
    const parts = [];
    if (it.description) parts.push(nl(it.description).trim());
    if (it.acceptanceCriteria?.length) parts.push(`Acceptance criteria:\n${it.acceptanceCriteria.map((c) => nl(c).trim()).join("\n\n")}`);
    parts.push(traceLine(it));
    const labels = labelsOf(it);
    return [
      String(num.get(it.id)),
      it.type === "epic" ? "Epic" : "Story",
      guardCell(it.title.trim()),
      guardCell(parts.join("\n\n")),
      it.parent ? String(num.get(it.parent)) : "",
      ...Array.from({ length: maxLabels }, (_, i) => (labels[i] ? guardCell(labels[i]) : "")),
    ];
  });
  return csvRows([header, ...rows]);
}

// ---- Azure Boards ----

function htmlOf(it, { acceptanceColumn, epicTitle }) {
  const para = (text) => `<p>${escHtml(nl(text).trim()).replace(/\n/g, "<br>")}</p>`;
  const out = [];
  if (epicTitle) out.push(para(`Epic: ${epicTitle}`));
  if (it.description) for (const p of nl(it.description).trim().split(/\n{2,}/)) out.push(para(p));
  if (it.acceptanceCriteria?.length && !acceptanceColumn) {
    out.push("<p><strong>Acceptance criteria</strong></p>");
    for (const c of it.acceptanceCriteria) out.push(para(c));
  }
  out.push(para(traceLine(it)));
  return out.join("");
}

// Groups of rows that must stay in one file: an epic with its stories, or one story alone.
export function azureGroups(items, flat) {
  if (flat) return items.map((it) => [it]);
  const groups = [];
  const used = new Set();
  for (const e of items.filter((i) => i.type === "epic")) {
    const g = [e, ...items.filter((s) => s.parent === e.id)];
    g.forEach((x) => used.add(x.id));
    groups.push(g);
  }
  for (const s of items) if (!used.has(s.id)) groups.push([s]);
  return groups;
}

export function splitAzure(groups, limit = AZURE_ROW_LIMIT) {
  const files = [];
  let cur = [];
  let n = 0;
  for (const g of groups) {
    if (g.length > limit) throw new InputError([`the epic "${g[0].id}" and its stories are ${g.length} items; one Azure Boards import takes up to ${limit}. Split the epic.`]);
    if (n + g.length > limit) { files.push(cur); cur = []; n = 0; }
    cur.push(...g);
    n += g.length;
  }
  if (cur.length) files.push(cur);
  return files;
}

export function buildAzure(items, { process: proc = "agile", flat = false, acceptanceColumn = false } = {}) {
  const types = PROCESS_TYPES[proc];
  if (!types) throw new InputError([`--process must be agile, scrum or cmmi (found "${proc}")`]);
  const epicTitle = new Map(items.filter((i) => i.type === "epic").map((e) => [e.id, e.title.trim()]));
  const files = splitAzure(azureGroups(items, flat));
  const header = [...(flat ? [] : ["ID"]), "Work Item Type", ...(flat ? ["Title"] : ["Title 1", "Title 2"]), "Description", ...(acceptanceColumn ? ["Acceptance Criteria"] : []), "Priority", "Tags"];
  return files.map((chunk) => {
    const rows = chunk.map((it) => {
      const nested = !flat && it.type === "story" && it.parent;
      const title = guardCell(it.title.trim());
      const ac = acceptanceColumn && it.acceptanceCriteria?.length ? it.acceptanceCriteria.map((c) => `<p>${escHtml(nl(c).trim()).replace(/\n/g, "<br>")}</p>`).join("") : "";
      return [
        ...(flat ? [] : [""]),
        types[it.type],
        ...(flat ? [title] : [nested ? "" : title, nested ? title : ""]),
        guardCell(htmlOf(it, { acceptanceColumn, epicTitle: flat && it.parent ? epicTitle.get(it.parent) : "" })),
        ...(acceptanceColumn ? [ac] : []),
        it.priority ? String(it.priority) : "",
        guardCell((it.tags ?? []).map((t) => t.trim()).join("; ")),
      ];
    });
    return csvRows([header, ...rows]);
  });
}

// ---- command line ----

export function parseArgs(argv) {
  const o = { input: null, process: "agile", flat: false, acceptanceColumn: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "--process") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new InputError([`${a} needs a value`]);
      if (a === "--input") { if (o.input !== null) throw new InputError(["--input was given twice"]); o.input = v; } else o.process = v;
    } else if (a === "--flat") o.flat = true;
    else if (a === "--acceptance-column") o.acceptanceColumn = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new InputError([`unknown option "${a}"`]);
  }
  if (!o.help && o.input === null) throw new InputError(["--input is required"]);
  if (!PROCESS_TYPES[o.process]) throw new InputError([`--process must be agile, scrum or cmmi (found "${o.process}")`]);
  return o;
}

const USAGE = "usage: node backlog-to-csv.mjs --input <path to backlog.json> [--process agile|scrum|cmmi] [--flat] [--acceptance-column]\n";

function checkTarget(path) {
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new InputError([`will not write over ${basename(path)}: it is not a regular file`]);
}

export function run(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { io.out(USAGE); return 0; }
    if (/[\u0000-\u001F]/.test(opts.input)) throw new InputError(["the input path holds a control character"]);
    const input = resolve(opts.input);
    if (!input.toLowerCase().endsWith(".json")) throw new InputError(["the input must be a .json file"]);
    if (!existsSync(input)) throw new InputError([`no such file: ${basename(input)}`]);
    const st = lstatSync(input);
    if (st.isSymbolicLink() || !st.isFile()) throw new InputError(["the input must be a regular file, not a link"]);
    if (st.size > MAX_INPUT_BYTES) throw new InputError([`the input is larger than ${MAX_INPUT_BYTES} bytes`]);
    let data;
    try { data = JSON.parse(readFileSync(input, "utf8").replace(/^﻿/, "")); } catch (e) { throw new InputError([`the input is not valid JSON: ${e.message}`]); }
    const { items } = validateBacklog(data);
    const jira = buildJira(items);
    const azure = buildAzure(items, opts);
    // every output is built; now write. The folder is the input's real folder, so a link cannot redirect the files.
    const dir = realpathSync(dirname(input));
    const targets = [[join(dir, "jira.csv"), jira], ...azure.map((c, i) => [join(dir, azure.length === 1 ? "azure-devops.csv" : `azure-devops-${i + 1}.csv`), c])];
    for (const [p] of targets) checkTarget(p);
    for (const [p, text] of targets) writeFileSync(p, text, "utf8");
    const written = new Set(targets.map(([p]) => basename(p)));
    const stale = readdirSync(dir).filter((f) => /^azure-devops(-\d+)?\.csv$/.test(f) && !written.has(f));
    const epics = items.filter((i) => i.type === "epic").length;
    io.out(`Read ${items.length} items (${epics} epics, ${items.length - epics} stories) from ${basename(input)}.\n`);
    io.out(`Azure Boards process: ${opts.process}${opts.flat ? ", flat (no hierarchy)" : ", with parent-child rows"}.\n`);
    io.out(`Wrote: ${[...written].join(", ")}\n`);
    for (const f of stale) io.out(`Note: ${f} is left over from an earlier run and was not changed. Delete it before importing.\n`);
    io.out("Import three rows into a scratch project first: field names and process settings differ between projects.\n");
    return 0;
  } catch (e) {
    if (e instanceof InputError) {
      io.err(`${e.problems.length > 1 ? "Problems:\n  " : "Problem: "}${e.problems.join("\n  ")}\n`);
      io.err(USAGE);
      return 1;
    }
    io.err(`File error: ${e.code ?? ""} ${e.message}\n`);
    return 2;
  }
}

// Run only when started from the command line, not when a test imports the functions. The native form fixes drive-letter case on Windows.
const isMain = (() => {
  try { return process.argv[1] !== undefined && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = run(process.argv.slice(2));
