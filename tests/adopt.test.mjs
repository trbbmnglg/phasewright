// Run with: node --test tests/adopt.test.mjs
// Covers `adopt` in plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs: finding plan files, reading their
// headings and Timestamps lines, the status rules, the history join, the both case, and the writing.
// The fixtures in tests/fixtures/adopt are synthetic .txt files (shapes only). Each test copies them at run time
// into a temp project layout (docs/phases/phase-*.md, .plans/phases/, docs/<topic>/, node_modules/...), and every
// temp folder is removed afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, mkdirSync, realpathSync, symlinkSync, statSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRoadmap, parsePlanFile, MARKER, main } from "../plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "plugins", "phased-shipping", "skills", "roadmap", "scripts", "roadmap.mjs");
const fx = (name) => readFileSync(join(HERE, "fixtures", "adopt", name), "utf8");
const NOW = () => new Date(2026, 0, 2, 3, 4, 5);
const BDIR = ".roadmap-backups";

const scratch = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "roadmap-test-adopt-")); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// Characters that print as nothing or reorder text: a right-to-left override, zero-width characters, the Arabic letter
// mark, a soft hyphen and tag characters. Built at run time from code points.
const INVISIBLE = [0x202e, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x061c, 0x00ad, 0xe0001, 0xe0041, 0xe007f].map((c) => String.fromCodePoint(c));
const INVISIBLE_RE = new RegExp(`[\\p{Cf}${String.fromCodePoint(0xe0000)}-${String.fromCodePoint(0xe007f)}]`, "u");

// A copy of the script with one line removed, to show that a test depends on that line. The copy is written to a temp
// folder (removed afterwards) and imported; roadmap.mjs imports only node: built-ins.
const dropLine = (src, token) => {
  const lines = src.split("\n");
  const at = lines.findIndex((l) => l.includes(token));
  assert.ok(at >= 0, `the script has no line with ${token}`);
  lines.splice(at, 1);
  return lines.join("\n");
};
async function loadMutant(transform) {
  const dir = tmp();
  const file = join(dir, "roadmap-mutant.mjs");
  const src = readFileSync(SCRIPT, "utf8");
  const text = transform(src);
  assert.notEqual(text, src);
  writeFileSync(file, text);
  return (await import(pathToFileURL(file).href)).main;
}
function adoptWith(mainFn, root, args = []) {
  const out = [];
  const err = [];
  const code = mainFn(["adopt", root, ...args], { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, now: NOW });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const TRANSCRIPT = [];
function adopt(root, args = [], extra = {}) {
  const out = [];
  const err = [];
  const code = main(["adopt", root, ...args], { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, now: NOW, ...extra });
  TRANSCRIPT.push(...out, ...err);
  return { code, out: out.join("\n"), err: err.join("\n") };
}
function roadmap(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const put = (root, rel, text) => {
  const p = join(root, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const read = (root, rel) => readFileSync(join(root, ...rel.split("/")), "utf8");
const bytes = (root, rel) => readFileSync(join(root, ...rel.split("/")));
// Every file and folder under a folder, as relative paths.
function listing(dir, base = dir) {
  const names = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    names.push(p.slice(base.length + 1).split(/[\\/]/).join("/"));
    if (e.isDirectory()) names.push(...listing(p, base));
  }
  return names.sort();
}

// The project layout the tests share.
function layout() {
  const root = tmp();
  put(root, "docs/phases/phase-1-setup.md", fx("shipped-1.txt"));
  put(root, "docs/phases/phase-2-graph-core.md", fx("dup-2-graph.txt"));
  put(root, "docs/phases/phase-2-code-map.md", fx("dup-2-code-map.txt"));
  put(root, "docs/phases/phase-3-dashboard.md", fx("started-3.txt"));
  put(root, "docs/phases/phase-7b-widget.md", fx("shipped-7b.txt"));
  put(root, ".plans/phases/phase-I1a-intake.md", fx("placeholders-i1a.txt"));
  put(root, "docs/topic-a/phase-10-tenth.md", fx("shipped-10.txt"));
  put(root, "docs/topic-a/phase-4-export.md", fx("dash-4.txt"));
  put(root, "docs/notes/phase-9-notes.md", fx("no-heading.txt"));
  put(root, "node_modules/pkg/phase-99-vendored.md", fx("vendored-99.txt"));
  put(root, "extra-plans/phase-5-custom.md", fx("custom-5.txt"));
  return root;
}

// The rows of the first roadmap table in some text, as objects keyed by column name.
function rowsOf(text) {
  const t = parseRoadmap(text).tables[0];
  if (!t) return [];
  return t.rows.map((r) => Object.fromEntries(t.names.map((n, i) => [n, r.vals[i] ?? ""])));
}
const idsOf = (text) => rowsOf(text).map((r) => r["#"]);
const standard = (rows, heading = "Roadmap") => `# Plans\n\n## ${heading}\n\n${MARKER}\n| # | Phase | Status |\n|---|---|---|\n${rows.map((r) => `| ${r.join(" | ")} |\n`).join("")}`;
const toCrlf = (s) => s.replace(/\n/g, "\r\n");

// ── the plan file reader ────────────────────────────────────────────────────
test("parsePlanFile: heading variants, ids with letters, and a file with no Phase heading", () => {
  const h = (text) => parsePlanFile(text).heading;
  assert.deepEqual(h("# Phase 2: Graph core\n"), { id: "2", qualifier: null, title: "Graph core" });
  assert.deepEqual(h("# Phase 2 (code map): Notes\n"), { id: "2", qualifier: "code map", title: "Notes" });
  assert.deepEqual(h("# Phase 7b: Widget\r\n"), { id: "7b", qualifier: null, title: "Widget" });
  assert.deepEqual(h("# Phase I1a - Intake: plan\n"), { id: "I1a", qualifier: null, title: "Intake: plan" });
  assert.deepEqual(h("\n\n# Phase 3.1: Sub step\n"), { id: "3.1", qualifier: null, title: "Sub step" });
  assert.deepEqual(h("Notes\n\n# Phase 4: after a prose line\n"), { id: "4", qualifier: null, title: "after a prose line" }, "a prose line is not a heading");
  assert.equal(h("## Phase 4: two hashes\n"), null);
  assert.equal(h("# Phase: no id\n"), null);
  assert.equal(h("# Phase 5:   \n"), null, "an empty title is no heading");
  assert.equal(h("# Overview\n\n# Phase 6: second heading\n"), null);
  assert.equal(h(fx("no-heading.txt")), null);
});

test("parsePlanFile: every Timestamps shape (all real, started only, all placeholders, no line, date only, odd text)", () => {
  const ts = (line) => parsePlanFile(`# Phase 1: x\n\n${line}\n`).timestamps;
  assert.deepEqual(ts("**Timestamps:** started 2026-01-02T03:04:05Z · previewed 2026-01-02T04:00:00Z · approved 2026-01-02T05:00:00Z · shipped 2026-01-02T06:00:00Z"),
    { started: "2026-01-02T03:04:05Z", previewed: "2026-01-02T04:00:00Z", approved: "2026-01-02T05:00:00Z", shipped: "2026-01-02T06:00:00Z" });
  assert.deepEqual(ts("**Timestamps:** started 2026-01-02T03:04:05Z · previewed <ISO> · approved <ISO> · shipped <ISO>"),
    { started: "2026-01-02T03:04:05Z", previewed: null, approved: null, shipped: null });
  assert.deepEqual(ts("**Timestamps:** started <ISO> · previewed <ISO> · approved <ISO> · shipped <ISO>"),
    { started: null, previewed: null, approved: null, shipped: null });
  assert.equal(parsePlanFile("# Phase 1: x\n\nno line here\n").timestamps, null);
  assert.deepEqual(ts("**Timestamps:** started 2026-01-02 · shipped 2026-01-05"), { started: "2026-01-02", previewed: null, approved: null, shipped: "2026-01-05" });
  assert.deepEqual(ts("**Timestamps:** started soon · shipped 2026-13-45T99:99:99Z"), { started: null, previewed: null, approved: null, shipped: null },
    "text and an impossible date are not real times");
  assert.deepEqual(ts("**Timestamps:** shipped 2026-01-02T03:04:05Z · shipped <ISO>").shipped, "2026-01-02T03:04:05Z", "the first value of a key counts");
  const late = `# Phase 1: x\n${"filler\n".repeat(70)}**Timestamps:** started 2026-01-02T03:04:05Z\n`;
  assert.equal(parsePlanFile(late).timestamps, null, "a Timestamps line far below the header (for example quoted in prose) is not read");
});

// ── finding plan files ──────────────────────────────────────────────────────
test("adopt plan: finds plan files in docs/phases, .plans/phases and docs/<topic>, never in node_modules, and a custom --plans folder only when given", () => {
  const root = layout();
  const before = listing(root);
  const r = adopt(root);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(listing(root), before, "a plan writes nothing at all (no folder, no file)");
  const rel = (n) => r.out.includes(n);
  assert.ok(rel("docs/phases/phase-1-setup.md"));
  assert.ok(rel("docs/topic-a/phase-10-tenth.md"));
  assert.ok(rel("docs/topic-a/phase-4-export.md"));
  assert.ok(rel(".plans/phases/phase-I1a-intake.md"));
  assert.ok(!rel("node_modules") && !rel("phase-99"), "node_modules is never read, never named");
  assert.ok(!rel("phase-5-custom.md"), "a folder nobody asked for is not scanned");
  const withCustom = adopt(root, ["--plans", "extra-plans"]);
  assert.equal(withCustom.code, 0, withCustom.err);
  assert.ok(idsOf(withCustom.out).includes("5"));
  assert.ok(!idsOf(r.out).includes("5"));
});

test("adopt plan: the proposal holds only the rows the plan files prove, in id order, with a Note that names the source", () => {
  const root = layout();
  const r = adopt(root, ["--plans", "extra-plans"]);
  assert.equal(r.code, 0, r.err);
  const rows = rowsOf(r.out);
  assert.deepEqual(rows.map((x) => [x["#"], x.Status]), [["1", "shipped"], ["3", "in progress"], ["4", "in progress"], ["5", "in progress"], ["7b", "shipped"], ["10", "shipped"]]);
  const one = rows[0];
  assert.equal(one.Phase, "Set up the project");
  assert.equal(one["Plan file"], "docs/phases/phase-1-setup.md");
  assert.equal(one.Note, "from plan file, shipped 2026-01-02");
  for (const row of rows) for (const col of ["Kind", "Priority", "Urgency", "Est. (raw → cal.)", "Actual", "Commit / deploy"]) assert.equal(row[col], "", `${row["#"]} ${col} stays empty without a history`);
  assert.equal(rows[1].Note, "from plan file, started 2026-02-01, not shipped; qualifier: revised");
  assert.ok(r.out.includes(MARKER), "the proposed table is a standard table");
  assert.equal(parseRoadmap(r.out).tables[0].legacy, false);
  assert.deepEqual(parseRoadmap(r.out).tables[0].problems, []);
});

test("adopt plan: a file with no Timestamps line, placeholders only, a duplicate id and a heading-less file are never given a status", () => {
  const root = layout();
  const r = adopt(root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /undecided \(1\)/);
  assert.ok(r.out.split("\n").some((l) => l.includes("I1a") && l.includes(".plans/phases/phase-I1a-intake.md") && l.includes("--set-status 'I1a=planned'")), "placeholders give no status, with the exact hint");
  assert.match(r.out, /duplicate-id \(2 files\)/);
  assert.ok(r.out.split("\n").some((l) => l.includes("2: docs/phases/phase-2-graph-core.md")));
  assert.ok(r.out.split("\n").some((l) => l.includes("2: docs/phases/phase-2-code-map.md")), "the code map with no Timestamps and the shipped plan are both left out");
  assert.match(r.out, /no-heading: docs\/notes\/phase-9-notes\.md/);
  const ids = idsOf(r.out);
  for (const id of ["2", "I1a", "9"]) assert.ok(!ids.includes(id), `${id} is not proposed`);
  // A lone file without a Timestamps line is undecided too.
  const lone = tmp();
  put(lone, "docs/phases/phase-8-code-map.md", fx("dup-2-code-map.txt").replace("Phase 2", "Phase 8"));
  const l = adopt(lone);
  assert.match(l.out, /undecided \(1\)[^\n]*\n[^\n]*no Timestamps line/);
  assert.match(l.out, /summary: no plan files|summary: nothing new/);
  assert.deepEqual(idsOf(l.out), []);
  const w = adopt(lone, ["--write"]);
  assert.equal(w.code, 0);
  assert.match(w.out, /nothing to write/);
  assert.equal(existsSync(join(lone, "PHASES.md")), false, "nothing was written for an undecided file");
});

test("adopt plan: a plan file and a roadmap are found to depth 3 and not deeper; symbolic links are not followed", (t) => {
  const root = tmp();
  put(root, "docs/a/b/c/phase-1-deep.md", "# Phase 1: Three folders down\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  put(root, "docs/a/b/c/d/phase-2-too-deep.md", "# Phase 2: Four folders down\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  put(root, "build/phase-3-output.md", "# Phase 3: Build output\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  put(root, "docs/dist/phase-4-output.md", "# Phase 4: Output below docs\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  put(root, "docs/.git/phase-6-git.md", "# Phase 6: In .git\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  const r = adopt(root);
  assert.deepEqual(idsOf(r.out), ["1"]);
  const outside = tmp();
  put(outside, "phase-7-outside.md", "# Phase 7: Outside the project\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  const linkRoot = tmp();
  mkdirSync(join(linkRoot, "plans"));
  try { symlinkSync(outside, join(linkRoot, "docs"), process.platform === "win32" ? "junction" : "dir"); } catch { t.skip("this platform did not allow a symlink"); return; }
  put(linkRoot, "plans/phase-8-real.md", "# Phase 8: Real\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  const l = adopt(linkRoot);
  assert.equal(l.code, 0, l.err);
  assert.deepEqual(idsOf(l.out), ["8"], "the folder that is a link to somewhere else is not followed");
  assert.match(l.out, /1 symbolic link\(s\) not followed/);
  assert.ok(!l.out.includes("phase-7-outside"), "nothing from outside is named");
});

test("adopt plan: plans/ and the project's own phases/ are scanned, a root-level phase file is not, and a name with a control or invisible character is skipped", async (t) => {
  const root = tmp();
  put(root, "plans/phase-1-a.md", "# Phase 1: In plans\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  put(root, "phases/phase-2-b.md", "# Phase 2: In phases\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  put(root, "phase-3-c.md", "# Phase 3: At the root\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  put(root, "src/phase-4-d.md", "# Phase 4: In source\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  assert.deepEqual(idsOf(adopt(root).out), ["1", "2"]);
  // Names a Windows file system accepts: a right-to-left override, the Arabic letter mark, a zero-width space, a tag
  // character and a soft hyphen (a newline in a name is not possible here, so it is tried only where it is).
  const odd = [0x202e, 0x061c, 0x200b, 0xe0041, 0x00ad].map((c) => String.fromCodePoint(c));
  let made = 0;
  odd.forEach((c, i) => {
    try { put(root, `docs/phase-${5 + i}-x${c}y.md`, `# Phase ${5 + i}: Odd name\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n`); made++; } catch { /* this file system refuses the name */ }
  });
  try { put(root, "docs/phase-20-line\nbreak.md", "# Phase 20: Odd name\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n"); made++; } catch { /* a newline is not allowed in a name here */ }
  assert.ok(made >= 3, "this machine can make several of these names");
  const r = adopt(root);
  assert.deepEqual(idsOf(r.out), ["1", "2"]);
  assert.ok(r.out.includes(`${made} name(s) with a control character skipped`), r.out);
  assert.ok(!INVISIBLE_RE.test(r.out), "an invisible character was printed");
  // A name with an invisible character in a folder name is skipped with everything under it.
  let dirMade = true;
  try { put(root, `docs/topic${odd[0]}z/phase-30-inside.md`, "# Phase 30: Inside\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n"); } catch { dirMade = false; }
  if (dirMade) assert.deepEqual(idsOf(adopt(root).out), ["1", "2"], "a folder with an invisible character in its name is not entered");
  // The name check is what skips them: without it the odd names are read.
  const mutant = await loadMutant((s) => dropLine(s, "if (CONTROL.test(e.name))"));
  const m = adoptWith(mutant, root);
  assert.ok(idsOf(m.out).length > 2, "the mutated script reads the odd names");
});

test("adopt plan: an invisible character in a plan title (tag, zero-width, format, bidirectional) reaches neither the output nor the written roadmap", () => {
  const root = tmp();
  const tag = INVISIBLE.join("");
  put(root, "docs/phases/phase-1-x.md", `# Phase 1 (q${tag}q): Title${tag}end\n\n**Timestamps:** started 2026-01-01 · shipped 2026-01-02\n`);
  assert.ok(INVISIBLE_RE.test(read(root, "docs/phases/phase-1-x.md")), "the planted file does hold invisible characters");
  const r = adopt(root);
  assert.equal(r.code, 0, r.err);
  assert.ok(!INVISIBLE_RE.test(r.out), "an invisible character was printed");
  assert.equal(rowsOf(r.out)[0].Phase.startsWith("Title"), true);
  const w = adopt(root, ["--write"]);
  assert.equal(w.code, 0, w.err);
  assert.ok(!INVISIBLE_RE.test(read(root, "PHASES.md")), "an invisible character was written");
  assert.equal(roadmap(["check", join(root, "PHASES.md"), "--strict"]).code, 0);
});

test("adopt plan: a hard-linked plan file or roadmap file is skipped and named, and the link-count check is what skips it", async (t) => {
  const outside = tmp();
  const root = tmp();
  put(outside, "plan.md", "# Phase 1: HARD_LINKED_TITLE\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  put(root, "docs/phases/phase-2-own.md", "# Phase 2: Own\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  try {
    linkSync(join(outside, "plan.md"), join(root, "docs", "phases", "phase-1-linked.md"));
  } catch { t.skip("hard links cannot be made here"); return; }
  const r = adopt(root);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(idsOf(r.out), ["2"], "the hard-linked plan file is not read");
  assert.ok(r.out.includes("skipped docs/phases/phase-1-linked.md: hard link"), r.out);
  assert.ok(!r.out.includes("HARD_LINKED_TITLE"));
  // A hard-linked roadmap file is skipped the same way.
  const root2 = tmp();
  put(outside, "road.md", "| # | Phase | Status |\n|---|---|---|\n| 9 | HARD_ROW | planned |\n");
  put(root2, "docs/phases/phase-2-own.md", "# Phase 2: Own\n\n**Timestamps:** started 2026-01-02T03:04:05Z\n");
  linkSync(join(outside, "road.md"), join(root2, "PHASES.md"));
  const r2 = adopt(root2);
  assert.ok(r2.out.includes("skipped PHASES.md: hard link"), r2.out + r2.err);
  assert.ok(!(r2.out + r2.err).includes("HARD_ROW"));
  const mutant = await loadMutant((s) => dropLine(s, 'if (st.nlink > 1) return { skip: "hard link" };'));
  const m = adoptWith(mutant, root);
  assert.ok(m.out.includes("HARD_LINKED_TITLE"), "the mutated script reads the hard-linked plan file");
  const m2 = adoptWith(mutant, root2);
  assert.ok(!(m2.out + m2.err).includes("skipped PHASES.md: hard link"), "the mutated script does not skip the hard-linked roadmap file");
});

test("adopt plan: --plans must be a folder inside the project and not under a folder adopt never reads; --root limits the project folder", () => {
  const root = layout();
  const other = tmp();
  put(other, "phase-1-x.md", "# Phase 1: x\n");
  const r1 = adopt(root, ["--plans", other]);
  assert.equal(r1.code, 2);
  assert.match(r1.err, /outside the project folder/);
  const r2 = adopt(root, ["--plans", "node_modules/pkg"]);
  assert.equal(r2.code, 2);
  assert.match(r2.err, /never reads/);
  assert.equal(adopt(root, ["--plans", "no-such-folder"]).code, 2);
  assert.equal(adopt(root, ["--plans", "docs/phases/phase-1-setup.md"]).code, 2, "a file is not a folder");
  assert.equal(adopt(root, ["--root", other]).code, 2);
  assert.equal(adopt(root, ["--root", root]).code, 0);
  assert.equal(adopt(join(root, "nope")).code, 2);
  const noArg = roadmap(["adopt"]);
  assert.equal(noArg.code, 2);
  assert.match(noArg.err, /adopt needs a project folder/);
});

// ── the history join ────────────────────────────────────────────────────────
function history(recs) {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  writeFileSync(file, `${recs.map((r) => JSON.stringify(r)).join("\n")}\nnot json at all\n`);
  return file;
}
const RECS = [
  { project: "alpha-label", phase: "1", actual_h: 1.5, date: "2026-01-02", deploy: "deployed v1" },
  { project: "alpha-label", phase: "1", actual_h: 2.5, date: "2026-02-01", deploy: "deployed v2" },
  { project: "alpha-label", phase: 7, actual_h: 4, date: "2026-03-02" },
  { project: "beta-label", phase: "1", actual_h: 9, date: "2026-01-01" },
  { project: "gamma-label", phase: "500", actual_h: 3, date: "2026-01-01" },
];

test("history: without --project it lists the candidate labels with their overlap counts and stops, joining nothing", () => {
  const root = layout();
  const h = history(RECS);
  const r = adopt(root, ["--history", h]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /alpha-label: 1 shared id\(s\)/, "7 is a number in the record and 7b in the plan file: only exact ids overlap");
  assert.match(r.out, /beta-label: 1 shared id\(s\)/);
  assert.ok(!r.out.includes("gamma-label"), "a label with no shared id is not offered");
  assert.ok(!r.out.includes(MARKER), "no table is proposed until the owner chooses");
  assert.match(r.out, /Nothing was proposed or written/);
  assert.ok(!r.out.includes(dirname(h)), "the history file is named by its base name only");
  const w = adopt(root, ["--history", h, "--write"]);
  assert.equal(w.code, 1, "asking for a write that cannot go ahead is a refusal");
  assert.equal(existsSync(join(root, "PHASES.md")), false);
  const skip = adopt(root, ["--history", h, "--no-history"]);
  assert.equal(skip.code, 2, "--no-history cannot be combined with --history");
  const none = adopt(root, ["--no-history"]);
  assert.equal(none.code, 0);
  assert.ok(idsOf(none.out).includes("1"));
});

test("history: with --project it joins Actual and the deploy text; the newest record wins and the Note says so", () => {
  const root = layout();
  const h = history(RECS);
  const r = adopt(root, ["--history", h, "--project", "alpha-label"]);
  assert.equal(r.code, 0, r.err);
  const one = rowsOf(r.out).find((x) => x["#"] === "1");
  assert.equal(one.Actual, "2.5 h");
  assert.equal(one["Commit / deploy"], "deployed v2");
  assert.match(one.Note, /Actual and Commit \/ deploy from the history, project "alpha-label", newest of 2 records/);
  const seven = rowsOf(r.out).find((x) => x["#"] === "7b");
  assert.equal(seven.Actual, "", "a record for phase 7 (a number) is not phase 7b");
  const three = rowsOf(r.out).find((x) => x["#"] === "3");
  assert.equal(three.Actual, "");
  assert.ok(!three.Note.includes("history"));
  const both = adopt(root, ["--history", h, "--project", "alpha-label", "--project", "beta-label"]);
  assert.equal(rowsOf(both.out).find((x) => x["#"] === "1").Actual, "2.5 h", "the newest of all chosen labels wins");
  const beta = adopt(root, ["--history", h, "--project", "beta-label"]);
  assert.equal(rowsOf(beta.out).find((x) => x["#"] === "1").Actual, "9 h");
  const wrong = adopt(root, ["--history", h, "--project", "no-such-label"]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /no record with that project label/);
  assert.equal(adopt(root, ["--project", "alpha-label"]).code, 2, "--project needs a history file");
  assert.equal(adopt(root, ["--history", join(dirname(h), "missing.jsonl")]).code, 2);
  assert.equal(adopt(root, ["--history", h, "--history", h]).code, 2);
});

test("history: the plugin data folder's history.jsonl is the default, only when it exists", () => {
  const root = layout();
  const h = history(RECS);
  const r = adopt(root, [], { env: { CLAUDE_PLUGIN_DATA: dirname(h) } });
  assert.match(r.out, /alpha-label: 1 shared id\(s\)/);
  const empty = adopt(root, [], { env: { CLAUDE_PLUGIN_DATA: tmp() } });
  assert.ok(empty.out.includes(MARKER), "no history file there: the proposal goes ahead");
});

test("history: the joined text is one line in one cell and never carries a pipe or a newline into the table", () => {
  const root = layout();
  const h = history([{ project: "alpha-label", phase: "1", actual_h: 1, date: "2026-01-02", deploy: "line one\nline two | pipe" }]);
  const r = adopt(root, ["--history", h, "--project", "alpha-label", "--into", "NEW.md"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(rowsOf(r.out).find((x) => x["#"] === "1")["Commit / deploy"], "line one line two | pipe");
  assert.deepEqual(parseRoadmap(r.out).tables[0].problems, []);
});

// ── the both case ───────────────────────────────────────────────────────────
test("both case: a legacy table refuses to propose until it is standard, unless --into names the file", () => {
  const root = layout();
  put(root, "PHASES.md", "# Plans\n\n| # | Phase | State |\n|---|---|---|\n| 1 | Set up the project | done |\n");
  const r = adopt(root);
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to propose rows: PHASES\.md still has a legacy table/);
  assert.match(r.err, /Run standardize on it first, or pass --into/);
  assert.ok(!r.out.includes(MARKER));
  const into = adopt(root, ["--into", "PHASES.md"]);
  assert.equal(into.code, 0, into.err);
  assert.ok(!idsOf(into.out).includes("1"), "id 1 is already in that table, so only unlisted ids are proposed");
  assert.deepEqual(idsOf(into.out), ["3", "4", "7b", "10"]);
  assert.match(into.out, /already in the roadmap, not proposed again \(1\): 1/);
  assert.match(into.out, /appended under "## Roadmap" at the end of PHASES\.md/);
});

test("both case: a standard table lists only the plan files whose ids are not in it; with no --into a write is refused", () => {
  const root = layout();
  put(root, "PHASES.md", standard([["1", "Set up", "shipped"], ["7b", "Widget", "shipped"], ["3", "Dashboard", "in progress"]]));
  const r = adopt(root);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(idsOf(r.out), ["4", "10"]);
  assert.match(r.out, /no file chosen yet: pass --into <roadmap file>/);
  const before = bytes(root, "PHASES.md");
  const w = adopt(root, ["--write"]);
  assert.equal(w.code, 1);
  assert.match(w.err, /Pass --into <roadmap file> to append the rows/);
  assert.deepEqual(bytes(root, "PHASES.md"), before);
  assert.equal(existsSync(join(root, BDIR)), false);
});

test("both case: several roadmap files are listed, --into picks one, nothing is merged across files", () => {
  const root = layout();
  put(root, "docs/topic-a/PHASES.md", standard([["10", "Tenth", "shipped"]]));
  put(root, "docs/topic-b/PHASES.md", standard([["1", "B one", "shipped"], ["3", "B three", "planned"]]));
  put(root, "docs/notes/PHASES.md", "# Notes\n\nNo table in this file.\n");
  const r = adopt(root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /roadmap files \(2\):/, "a PHASES.md without a table is not a roadmap file");
  assert.match(r.out, /docs\/topic-a\/PHASES\.md: 1 table\(s\), 0 legacy, 1 phase\(s\)/);
  assert.match(r.out, /docs\/topic-b\/PHASES\.md: 1 table\(s\), 0 legacy, 2 phase\(s\)/);
  const a = readFileSync(join(root, "docs/topic-a/PHASES.md"));
  const b = readFileSync(join(root, "docs/topic-b/PHASES.md"));
  const pick = adopt(root, ["--into", "docs/topic-b/PHASES.md"]);
  assert.equal(pick.code, 0, pick.err);
  assert.deepEqual(idsOf(pick.out), ["4", "7b", "10"], "only the chosen file's ids count as listed");
  const w = adopt(root, ["--into", "docs/topic-b/PHASES.md", "--write"], { now: NOW });
  assert.equal(w.code, 0, w.err);
  assert.deepEqual(readFileSync(join(root, "docs/topic-a/PHASES.md")), a, "the other roadmap file is untouched");
  assert.ok(read(root, "docs/topic-b/PHASES.md").startsWith(b.toString("utf8")));
  assert.equal(existsSync(join(root, "docs/topic-a", BDIR)), false);
  assert.equal(parseRoadmap(read(root, "docs/topic-b/PHASES.md")).tables.length, 2);
});

// ── writing ─────────────────────────────────────────────────────────────────
test("write: with no roadmap it creates PHASES.md, check passes, and a second adopt proposes nothing new", () => {
  const root = layout();
  const w = adopt(root, ["--write"]);
  assert.equal(w.code, 0, w.err);
  assert.match(w.out, /created PHASES\.md with 5 row\(s\)/);
  assert.deepEqual(idsOf(read(root, "PHASES.md")), ["1", "3", "4", "7b", "10"]);
  const c = roadmap(["check", join(root, "PHASES.md"), "--strict"]);
  assert.equal(c.code, 0, c.out);
  assert.equal(existsSync(join(root, BDIR)), false, "nothing existed under that name, so there is nothing to back up");
  const again = adopt(root);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /summary: nothing new to propose/);
  assert.ok(!again.out.includes(MARKER), "no table the second time");
  assert.match(again.out, /already in the roadmap, not proposed again \(5\)/);
  const second = adopt(root, ["--write"]);
  assert.equal(second.code, 0);
  assert.match(second.out, /nothing to write/);
});

test("write: it never overwrites a file: an existing name is refused, and --into appends after the existing text", () => {
  const root = layout();
  const prose = "# My own notes\n\nNo table here, but it is mine.\n";
  put(root, "PHASES.md", prose);
  const r = adopt(root);
  assert.equal(r.code, 0, r.err);
  const refused = adopt(root, ["--write"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /PHASES\.md already exists in the project folder, and adopt never overwrites a file/);
  assert.equal(read(root, "PHASES.md"), prose);
  const into = adopt(root, ["--write", "--into", "PHASES.md"], { now: NOW });
  assert.equal(into.code, 0, into.err);
  const after = read(root, "PHASES.md");
  assert.ok(after.startsWith(prose), "the existing text is kept, byte for byte, in front");
  assert.equal(after.slice(prose.length), `\n## Roadmap\n\n${MARKER}\n${after.split(`${MARKER}\n`)[1]}`);
  assert.equal(read(root, `${BDIR}/PHASES.md.original`), prose, ".original keeps the first version");
  assert.equal(read(root, `${BDIR}/PHASES.md.bak-20260102-030405`), prose, "the dated copy keeps the version before this write");
  assert.equal(read(root, `${BDIR}/.gitignore`), "*\n");
  assert.deepEqual(roadmap(["check", join(root, "PHASES.md"), "--strict"]).code, 0);
  // A new name is created, an existing one is appended to.
  const fresh = adopt(root, ["--write", "--into", "docs/second-roadmap.md"]);
  assert.equal(fresh.code, 0, fresh.err);
  assert.match(fresh.out, /created docs\/second-roadmap\.md/);
  assert.ok(existsSync(join(root, "docs", "second-roadmap.md")));
  assert.equal(adopt(root, ["--write", "--into", "docs/missing-folder/x.md"]).code, 2);
  assert.equal(adopt(root, ["--write", "--into", "notes.txt"]).code, 2, "a new roadmap file must end .md");
  const outside = tmp();
  assert.equal(adopt(root, ["--write", "--into", join(outside, "x.md")]).code, 2, "outside the project");
  put(outside, "PHASES.md", standard([["1", "x", "planned"]]));
  assert.equal(adopt(root, ["--write", "--into", join(outside, "PHASES.md")]).code, 2, "an existing file outside the project");
  assert.equal(adopt(root, ["--write", "--into", `${BDIR}/x.md`]).code, 2, "never into a backup folder");
});

test("write: a second adopt after an --into append proposes nothing new, and the file keeps passing check", () => {
  const root = layout();
  put(root, "docs/PHASES.md", standard([["1", "Set up", "shipped"]]));
  const w = adopt(root, ["--write", "--into", "docs/PHASES.md"], { now: NOW });
  assert.equal(w.code, 0, w.err);
  assert.equal(roadmap(["check", join(root, "docs", "PHASES.md"), "--strict"]).code, 0);
  assert.equal(parseRoadmap(read(root, "docs/PHASES.md")).tables.length, 2);
  for (const args of [["--into", "docs/PHASES.md"], []]) {
    const again = adopt(root, args);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /summary: nothing new to propose/, JSON.stringify(args));
  }
  const bytesBefore = bytes(root, "docs/PHASES.md");
  const noop = adopt(root, ["--write", "--into", "docs/PHASES.md"], { now: () => new Date(2026, 0, 2, 3, 4, 6) });
  assert.equal(noop.code, 0);
  assert.deepEqual(bytes(root, "docs/PHASES.md"), bytesBefore, "a second --write changes nothing");
});

test("write: LF and CRLF files both keep their line endings, and a file with no last newline gets one", () => {
  const rows = [["1", "Set up", "shipped"]];
  const lf = layout();
  put(lf, "PHASES.md", standard(rows));
  assert.equal(adopt(lf, ["--write", "--into", "PHASES.md"], { now: NOW }).code, 0);
  assert.ok(!read(lf, "PHASES.md").includes("\r"), "an LF file stays LF");
  const crlf = layout();
  const original = toCrlf(standard(rows));
  put(crlf, "PHASES.md", original);
  assert.equal(adopt(crlf, ["--write", "--into", "PHASES.md"], { now: NOW }).code, 0);
  const text = read(crlf, "PHASES.md");
  assert.ok(text.startsWith(original));
  assert.ok(!/(?<!\r)\n/.test(text), "no bare LF anywhere in a CRLF file");
  assert.equal(parseRoadmap(text).tables.length, 2);
  const bare = layout();
  const noEnd = standard(rows).replace(/\n$/, "");
  put(bare, "PHASES.md", noEnd);
  assert.equal(adopt(bare, ["--write", "--into", "PHASES.md"], { now: NOW }).code, 0);
  const t = read(bare, "PHASES.md");
  assert.ok(t.startsWith(`${noEnd}\n\n## Roadmap\n`));
  assert.ok(t.endsWith("\n"));
  assert.equal(roadmap(["check", join(bare, "PHASES.md"), "--strict"]).code, 0);
});

test("write: undecided files are written only with --set-status; the other rows still go ahead", () => {
  const root = layout();
  const skipped = adopt(root, ["--write"]);
  assert.equal(skipped.code, 0, skipped.err);
  assert.match(skipped.out, /undecided \(1\)/);
  assert.ok(!idsOf(read(root, "PHASES.md")).includes("I1a"));
  const root2 = layout();
  const w = adopt(root2, ["--write", "--set-status", "I1a=parked"]);
  assert.equal(w.code, 0, w.err);
  const rows = rowsOf(read(root2, "PHASES.md"));
  const row = rows.find((x) => x["#"] === "I1a");
  assert.equal(row.Status, "parked");
  assert.equal(row["Plan file"], ".plans/phases/phase-I1a-intake.md");
  assert.match(row.Note, /status chosen by the owner \(the file has no usable Timestamps\)/);
  assert.ok(!w.out.includes("undecided ("), "nothing is left undecided");
  assert.ok(!idsOf(read(root2, "PHASES.md")).includes("2"), "a duplicate id stays out");
});

test("--set-status: only an undecided file takes one; a decided file, a duplicate id, an unknown id and a bad status are usage errors", () => {
  const root = layout();
  const cases = [
    [["--set-status", "1=planned"], /already proves "shipped"/],
    [["--set-status", "2=planned"], /two plan files carry the id 2/],
    [["--set-status", "77=planned"], /matches no plan file that is still to be added/],
    [["--set-status", "I1a=maybe"], /is not one of planned, in progress, shipped, parked/],
    [["--set-status", "I1a"], /needs <id>=<status>/],
    [["--set-status", "I1a=planned", "--set-status", "I1a=parked"], /given twice/],
  ];
  for (const [args, pattern] of cases) {
    const r = adopt(root, [...args, "--write"]);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, pattern);
    assert.equal(existsSync(join(root, "PHASES.md")), false, "a usage error writes nothing");
  }
  const ok = adopt(root, ["--set-status", "I1a=In Progress"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(rowsOf(ok.out).find((x) => x["#"] === "I1a").Status, "in progress");
});

test("write: fails closed (nothing written) when the backup cannot be made, and keeps .original", () => {
  const original = standard([["1", "Set up", "shipped"]]);
  // A .original that is a folder.
  const a = layout();
  put(a, "PHASES.md", original);
  mkdirSync(join(a, BDIR, "PHASES.md.original"), { recursive: true });
  const r1 = adopt(a, ["--write", "--into", "PHASES.md"], { now: NOW });
  assert.equal(r1.code, 1, r1.err);
  assert.match(r1.err, /nothing was written/);
  assert.equal(read(a, "PHASES.md"), original);
  // A file where the backup folder should be.
  const b = layout();
  put(b, "PHASES.md", original);
  writeFileSync(join(b, BDIR), "a file");
  const r2 = adopt(b, ["--write", "--into", "PHASES.md"], { now: NOW });
  assert.equal(r2.code, 1, r2.err);
  assert.match(r2.err, /could not use the \.roadmap-backups folder/);
  assert.equal(read(b, "PHASES.md"), original);
  // The dated copy name is taken.
  const c = layout();
  put(c, "PHASES.md", original);
  put(c, `${BDIR}/PHASES.md.bak-20260102-030405`, "mine");
  const r3 = adopt(c, ["--write", "--into", "PHASES.md"], { now: NOW });
  assert.equal(r3.code, 1, r3.err);
  assert.equal(read(c, "PHASES.md"), original);
  assert.equal(read(c, `${BDIR}/PHASES.md.bak-20260102-030405`), "mine");
  // The copy step fails with a link error that is not "exists": the in-place fallback still keeps everything.
  const d = layout();
  put(d, "PHASES.md", original);
  const r4 = adopt(d, ["--write", "--into", "PHASES.md"], { now: NOW, linkError: "EPERM" });
  assert.equal(r4.code, 0, r4.err);
  assert.equal(read(d, `${BDIR}/PHASES.md.original`), original);
  assert.deepEqual(readdirSync(join(d, BDIR)).filter((n) => n.endsWith(".incomplete") || n.includes(".tmp")), []);
  // A new file whose name appears while it is being made is never overwritten.
  const e = layout();
  const r5 = adopt(e, ["--write"], { beforeLink: (tmpName, final) => writeFileSync(final, "someone else's file") });
  assert.equal(r5.code, 1, r5.err);
  assert.match(r5.err, /already exists, and adopt never overwrites a file/);
  assert.equal(read(e, "PHASES.md"), "someone else's file");
  assert.deepEqual(readdirSync(e).filter((n) => n.includes(".tmp-")), []);
});

test("write: the changed-while-writing check stops it with exit 1 and leaves the other writer's text", () => {
  const original = standard([["1", "Set up", "shipped"]]);
  const injected = `${original}\nedited by someone else\n`;
  const a = layout();
  put(a, "PHASES.md", original);
  const r1 = adopt(a, ["--write", "--into", "PHASES.md"], { now: NOW, beforeRename: (stage) => { if (stage === "roadmap") writeFileSync(join(a, "PHASES.md"), injected); } });
  assert.equal(r1.code, 1);
  assert.match(r1.err, /the roadmap changed while it was being written; nothing was changed, run again/);
  assert.equal(read(a, "PHASES.md"), injected);
  assert.deepEqual(readdirSync(join(a, BDIR)).filter((n) => n.endsWith(".tmp")), [], "the temp file is removed");
  const b = layout();
  put(b, "PHASES.md", original);
  const r2 = adopt(b, ["--write", "--into", "PHASES.md"], { now: NOW, afterLoad: () => writeFileSync(join(b, "PHASES.md"), injected) });
  assert.equal(r2.code, 1);
  assert.equal(read(b, "PHASES.md"), injected);
});

test("write: the backup folder is git-ignored by its own .gitignore and a second --into write keeps the first .original", () => {
  const root = layout();
  const first = standard([["1", "Set up", "shipped"]]);
  put(root, "PHASES.md", first);
  assert.equal(adopt(root, ["--write", "--into", "PHASES.md"], { now: NOW }).code, 0);
  const afterFirst = read(root, "PHASES.md");
  put(root, "docs/phases/phase-11-eleventh.md", fx("shipped-10.txt").replace("Phase 10", "Phase 11"));
  assert.equal(adopt(root, ["--write", "--into", "PHASES.md"], { now: () => new Date(2026, 0, 2, 3, 4, 9) }).code, 0);
  assert.equal(read(root, `${BDIR}/PHASES.md.original`), first, ".original is never replaced");
  assert.equal(read(root, `${BDIR}/PHASES.md.bak-20260102-030409`), afterFirst);
  assert.ok(idsOf(read(root, "PHASES.md")).includes("1"));
  assert.equal(parseRoadmap(read(root, "PHASES.md")).tables.length, 3);
});

// ── review fixes: plain text from plan files, and where --into may write ────
test("a plan title with escape, link and bell characters reaches neither the output nor the written roadmap", () => {
  const root = tmp();
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const nasty = `Title ${ESC}[31mred${ESC}[0m ${ESC}]8;;evil.example${BEL}link${ESC}]8;;${BEL} ${String.fromCharCode(0x202e)}end${String.fromCharCode(0x2066)}x${String.fromCharCode(0x85)}y`;
  put(root, "docs/phases/phase-1-x.md", `# Phase 1 (q${ESC}[1mq${BEL}): ${nasty}\n\n**Timestamps:** started 2026-01-01 · shipped 2026-01-02\n`);
  const bad = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
  const r = adopt(root);
  assert.equal(r.code, 0, r.err);
  assert.ok(!bad.test(r.out), "a control or bidirectional character was printed");
  assert.equal(rowsOf(r.out)[0].Phase.startsWith("Title "), true);
  const w = adopt(root, ["--write"]);
  assert.equal(w.code, 0, w.err);
  const written = read(root, "PHASES.md");
  assert.ok(!bad.test(written), "a control or bidirectional character was written");
  assert.equal(roadmap(["check", join(root, "PHASES.md"), "--strict"]).code, 0);
});

test("--into takes only a regular .md file outside node_modules, .git, build output, the backup folder and .phased-shipping", (t) => {
  const root = layout();
  const pkg = JSON.stringify({ name: "demo", scripts: {} });
  put(root, "package.json", pkg);
  const r = adopt(root, ["--write", "--into", "package.json"]);
  assert.equal(r.code, 2);
  assert.equal(read(root, "package.json"), pkg, "an existing file that is not Markdown is never appended to");
  put(root, "notes.txt", "plain\n");
  assert.equal(adopt(root, ["--write", "--into", "notes.txt"]).code, 2);
  assert.equal(read(root, "notes.txt"), "plain\n");
  for (const dir of ["node_modules/pkg", ".git", "dist", "build", ".next", "out", "target", BDIR, ".phased-shipping"]) {
    const existing = `${dir}/PHASES.md`;
    const text = standard([["1", "x", "planned"]]);
    put(root, existing, text);
    const e = adopt(root, ["--write", "--into", existing]);
    assert.equal(e.code, 2, `existing file in ${dir}`);
    assert.equal(read(root, existing), text, `${dir}: untouched`);
    mkdirSync(join(root, dir), { recursive: true });
    const n = adopt(root, ["--write", "--into", `${dir}/NEW-ROADMAP.md`]);
    assert.equal(n.code, 2, `new file in ${dir}`);
    assert.ok(!existsSync(join(root, dir, "NEW-ROADMAP.md")), `${dir}: nothing created`);
  }
  mkdirSync(join(root, "docs", "folder.md"));
  assert.equal(adopt(root, ["--write", "--into", "docs/folder.md"]).code, 2, "a folder is not a regular file");
  put(root, "docs/real.md", "# Mine\n");
  let linked = true;
  try { symlinkSync(join(root, "docs", "real.md"), join(root, "docs", "link.md"), "file"); } catch { linked = false; }
  if (linked) {
    assert.equal(adopt(root, ["--write", "--into", "docs/link.md"]).code, 2, "a link is not a regular file");
    assert.equal(read(root, "docs/real.md"), "# Mine\n");
  } else t.diagnostic("links cannot be made here: the link case was not run");
});

// ── output ──────────────────────────────────────────────────────────────────
test("no absolute path is printed by any adopt run in this file, and every temp folder is removed afterwards", () => {
  assert.ok(TRANSCRIPT.length > 100, "the runs above printed something");
  const roots = new Set();
  for (const d of scratch) {
    roots.add(d);
    try { roots.add(realpathSync.native(d)); } catch { /* already gone */ }
  }
  roots.add(tmpdir());
  for (const line of TRANSCRIPT) {
    for (const base of roots) {
      for (const form of [base, base.split("\\").join("/")]) assert.ok(!line.includes(form), `an absolute path in the output: ${line.slice(0, 80)}`);
    }
    assert.ok(!/[A-Za-z]:[\\/]/.test(line), `a drive path in the output: ${line.slice(0, 80)}`);
  }
});

test("source: adopt builds no regular expression from text and reads no folder it should not", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /new RegExp/);
  for (const name of ["node_modules", ".git", "dist", "build", ".next", "out", "target"]) assert.ok(src.includes(`"${name}"`), name);
  assert.ok(statSync(SCRIPT).isFile());
});
