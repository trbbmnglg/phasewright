// Run with: node --test tests/roadmap.test.mjs
// Covers plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs: the reader, the check, standardize and set.
// The fixtures in tests/fixtures/roadmap are synthetic. Every file a test writes goes to a temp folder that the
// test makes and removes (the roadmap files there are named PHASES.md, like a real project's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, mkdirSync, realpathSync, symlinkSync, utimesSync, lstatSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoadmap, checkRoadmap, planStandardize, setPhase, mapStatus, toReadJson, STATUSES, MARKER, cellOf, clean, renameWithRetry, main } from "../plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SCRIPT = join(REPO, "plugins", "phased-shipping", "skills", "roadmap", "scripts", "roadmap.mjs");
const fixture = (name) => readFileSync(join(HERE, "fixtures", "roadmap", name), "utf8");
const STANDARD = fixture("standard.md");
const MESSY = fixture("legacy-messy.md");

const scratch = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "roadmap-test-")); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// Runs the command line in this process and collects what it prints.
// Everything every run printed is kept, so one test at the end can check that no absolute path was ever printed.
const TRANSCRIPT = [];
function run(argv, extra = {}) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), ...extra });
  TRANSCRIPT.push(...out, ...err);
  return { code, out: out.join("\n"), err: err.join("\n") };
}
// A project folder with a roadmap file named PHASES.md.
function project(text, name = "PHASES.md") {
  const dir = tmp();
  writeFileSync(join(dir, name), text);
  return { dir, file: join(dir, name), read: () => readFileSync(join(dir, name), "utf8") };
}
const spawn = (args, cwd) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const toCrlf = (s) => s.replace(/\n/g, "\r\n");
// A small table, with or without the marker line.
const table = (header, rows, marker = true) =>
  `${marker ? `${MARKER}\n` : ""}| ${header.join(" | ")} |\n|${header.map(() => "---").join("|")}|\n${rows.map((r) => `| ${r.join(" | ")} |\n`).join("")}`;
const MIN = ["#", "Phase", "Status"];
const codes = (text) => parseRoadmap(text).tables.flatMap((t) => t.problems.map((p) => p.code));

// ── parse ───────────────────────────────────────────────────────────────────
test("parse: the standard fixture gives the expected phases, statuses and counts", () => {
  const parsed = parseRoadmap(STANDARD);
  assert.equal(parsed.tables.length, 1, "the model-check table and the fenced table are not roadmap tables");
  const json = toReadJson(parsed, "standard.md");
  assert.equal(json.v, 1);
  assert.equal(json.file, "standard.md");
  const t = json.tables[0];
  assert.equal(t.legacy, false);
  assert.equal(t.marker, "v1");
  assert.equal(t.heading, "Roadmap");
  assert.deepEqual(t.phases.map((p) => [p.id, p.status]), [["1", "shipped"], ["2", "in progress"], ["3", "planned"], ["4", "parked"], ["5.1", "planned"]]);
  assert.deepEqual(json.summary, { planned: 2, inProgress: 1, shipped: 1, parked: 1, total: 5, legacyTables: 0, errors: 0, notices: 0 });
  assert.deepEqual(t.problems, []);
  assert.equal(t.phases.find((p) => p.id === "99"), undefined, "a table inside a code fence is skipped");
});

test("parse: unknown columns are ignored by the reader, escaped pipes stay in the cell, Est. numbers are extracted", () => {
  const t = toReadJson(parseRoadmap(STANDARD), "standard.md").tables[0];
  assert.ok(t.columns.includes("Owner"), "the unknown column is listed");
  for (const p of t.phases) assert.ok(!("owner" in p) && !("Owner" in p));
  const two = t.phases[1];
  assert.equal(two.phase, "Add a filter for a | b");
  assert.equal(two.note, "started late");
  assert.equal(t.phases[0].estRaw, 1);
  assert.equal(t.phases[0].estCal, 1.3);
  assert.equal(t.phases[0].actual, 1.2);
  assert.equal(t.phases[0].commit, "abc1234");
  assert.equal(t.phases[0].planFile, "plans/one.md");
  assert.equal(t.phases[2].estCal, 2);
  const free = t.phases[4];
  assert.equal(free.estRaw, null);
  assert.equal(free.estCal, null);
  assert.equal(free.actual, 0.5);
  assert.equal(free.statusRaw, "Planned");
  assert.equal(free.status, "planned", "a status is read case-insensitively");
});

test("parse: a row with a cost-style est text and an Est. cell with minutes keeps the first two numbers", () => {
  const text = table([...MIN, "Est. (raw → cal.)"], [["1", "x", "planned", "3.7 h → 2.2 h (mixed) build + 20 min review"]]);
  const p = toReadJson(parseRoadmap(text), "x.md").tables[0].phases[0];
  assert.equal(p.estRaw, 3.7);
  assert.equal(p.estCal, 2.2);
});

// ── legacy detection ────────────────────────────────────────────────────────
test("legacy: a candidate without the marker is legacy, the model-check table is not a candidate, two tables under one heading are two", () => {
  const parsed = parseRoadmap(MESSY);
  assert.deepEqual(parsed.tables.map((t) => [t.index, t.legacy, t.heading]), [[0, true, "Roadmap"], [1, true, "Roadmap"], [2, true, "Backlog"], [3, true, "Later"]]);
  assert.deepEqual(parsed.tables.map((t) => t.names.length), [16, 16, 8, 3]);
  assert.ok(!parsed.tables.some((t) => t.names.includes("Provider")));
  assert.equal(parsed.tables[0].problems[0].code, "legacy-table");
  assert.equal(parsed.tables[2].problems[0].code, "legacy-table");
  assert.match(parsed.tables[2].problems[0].message, /no Status column/);
});

test("legacy: unknown statuses are a notice, never an error, and are not counted", () => {
  const json = toReadJson(parseRoadmap(MESSY), "legacy-messy.md");
  const unmapped = json.tables[0].problems.filter((p) => p.code === "unmapped-status");
  assert.deepEqual(unmapped.map((p) => p.line), [19, 20]);
  assert.equal(json.summary.errors, 0);
  const byId = Object.fromEntries(json.tables[0].phases.map((p) => [p.id, p]));
  assert.equal(byId["7"].status, null);
  assert.equal(byId["7"].statusRaw, "$$");
  assert.equal(byId["3"].status, "planned");
  assert.equal(byId["3"].planFile, "docs/phases/phase-3-report.md");
  assert.equal(byId["9"].note, "waiting on review");
  assert.equal(byId["6"].status, "parked");
  assert.equal(byId["6"].note, "moved to phase 9");
  assert.equal(json.tables[3].phases[0].status, "shipped", "a State column is read as the status in a legacy table");
  assert.equal(json.summary.legacyTables, 4);
});

test("legacy: a file with no table gives no-roadmap-table, and odd input never throws", () => {
  const parsed = parseRoadmap("# Title\n\nJust text.\n");
  assert.deepEqual(parsed.tables, []);
  assert.deepEqual(parsed.problems.map((p) => p.code), ["no-roadmap-table"]);
  const checked = checkRoadmap(parsed, { strict: false });
  assert.equal(checked.exitCode, 0);
  assert.equal(checkRoadmap(parsed, { strict: true }).exitCode, 1);
  const odd = ["", "|", "||", "| # | Phase", "| # | Phase |\n|---|", "| # | Phase |\n| x | y |", "```\n| # | Phase |\n|---|---|\n", "| \\| |\n|---|\n", "\r\n\r\n", "\u0000\u0001|", "| # | Phase | Status |\n|---|---|---|\n|", ` ${MARKER}\n| # | Phase |\n|---|---|\n| 1 |`];
  for (const text of odd) {
    assert.doesNotThrow(() => { checkRoadmap(parseRoadmap(text)); toReadJson(parseRoadmap(text), "x.md"); planStandardize(text); }, JSON.stringify(text));
  }
  assert.doesNotThrow(() => { checkRoadmap(parseRoadmap(MESSY)); toReadJson(parseRoadmap(MESSY), "x.md"); });
});

test("legacy: a newer marker version is a notice and the table is read as v1", () => {
  const text = table(MIN, [["1", "x", "planned"]]).replace("roadmap v1", "roadmap v2");
  const t = parseRoadmap(text).tables[0];
  assert.equal(t.legacy, false);
  assert.equal(t.version, 2);
  assert.deepEqual(t.problems.map((p) => [p.code, p.level]), [["newer-version", "notice"]]);
  assert.equal(toReadJson(parseRoadmap(text), "x.md").tables[0].marker, "v2");
  assert.equal(toReadJson(parseRoadmap(text), "x.md").tables[0].phases[0].status, "planned");
});

test("the marker counts when it is the nearest non-blank line above the header, and not otherwise", () => {
  const rows = [["1", "x", "planned"]];
  assert.equal(parseRoadmap(`${MARKER}\n\n\n${table(MIN, rows, false)}`).tables[0].legacy, false);
  assert.equal(parseRoadmap(`${MARKER}\ntext\n${table(MIN, rows, false)}`).tables[0].legacy, true);
  assert.equal(parseRoadmap(`${MARKER} extra\n${table(MIN, rows, false)}`).tables[0].legacy, true);
  // A marker above a table does not make the next table standard.
  const two = `${table(MIN, rows)}\n${table(MIN, [["2", "y", "planned"]], false)}`;
  assert.deepEqual(parseRoadmap(two).tables.map((t) => t.legacy), [false, true]);
});

// ── check ───────────────────────────────────────────────────────────────────
test("check: each error code is reported on a small crafted table", () => {
  const cases = {
    "missing-column": table(["#", "Phase"], [["1", "x"]]),
    "bad-status": table(MIN, [["1", "x", "done"]]),
    "duplicate-id": table(MIN, [["1", "x", "planned"], ["1", "y", "planned"]]),
    "empty-id": table(MIN, [["", "x", "planned"]]),
    "bad-id": table(MIN, [["a b", "x", "planned"]]),
    "bad-priority": table([...MIN, "Priority"], [["1", "x", "planned", "P4"]]),
    "bad-kind": table([...MIN, "Kind"], [["1", "x", "planned", "huge"]]),
    "row-width": `${table(MIN, [["1", "x", "planned"]])}| 2 | y |\n`,
  };
  for (const [code, text] of Object.entries(cases)) {
    const found = parseRoadmap(text).tables[0].problems;
    assert.ok(found.some((p) => p.code === code && p.level === "error" && p.line > 0), `${code}: ${JSON.stringify(found)}`);
    const r = run(["check", writeTemp(text), "--strict"]);
    assert.equal(r.code, 1, code);
    assert.match(r.out, new RegExp(`error ${code}:`), code);
  }
  // A valid table with every optional value empty has no error.
  assert.deepEqual(codes(table([...MIN, "Priority", "Kind", "Actual"], [["1", "x", "Shipped", "", "", ""], ["2", "y", "planned", "p1", "UI", "2 h"]])), []);
  assert.deepEqual(codes(table(MIN, [["a.b-c_1", "x", "parked"]])), []);
  assert.equal(codes(table(MIN, [["-x", "x", "parked"]]))[0], "bad-id", "an id cannot start with a symbol");
});
function writeTemp(text) {
  const p = project(text, "roadmap-under-test.md");
  return p.file;
}

test("check: exit codes 0, 1 for errors, 1 with --strict for a legacy table, 2 for the unreadable and the wrong usage", () => {
  const std = writeTemp(STANDARD);
  const legacy = writeTemp(MESSY);
  const bad = writeTemp(table(MIN, [["1", "x", "nope"]]));
  assert.equal(run(["check", std]).code, 0);
  assert.equal(run(["check", std, "--strict"]).code, 0);
  assert.equal(run(["check", legacy]).code, 0, "notices, including legacy, are allowed");
  assert.equal(run(["check", legacy, "--strict"]).code, 1);
  assert.equal(run(["check", bad]).code, 1);
  const ok = run(["check", std]);
  assert.match(ok.out, /roadmap-under-test\.md: 0 error\(s\), 0 notice\(s\), 1 table\(s\), 5 phase\(s\)$/);
  assert.equal(run(["check", join(tmp(), "missing.md")]).code, 2);
  for (const argv of [[], ["nope"], ["check"], ["check", std, "extra"], ["check", std, "--bogus"], ["read"], ["set", std], ["standardize", std, "--table", "x"], ["check", std, "--root"]]) {
    assert.equal(run(argv).code, 2, JSON.stringify(argv));
  }
  const dirB = tmp();
  const outside = run(["check", std, "--root", dirB]);
  assert.equal(outside.code, 2);
  assert.match(outside.err, /outside the --root folder/);
  assert.equal(run(["check", std, "--root", dirname(std)]).code, 0);
  assert.equal(run(["check", std, "--root", join(dirB, "nope")]).code, 2);
});

test("check: the messy fixture never throws and lists its notices by line", () => {
  const r = run(["check", writeTemp(MESSY)]);
  assert.equal(r.code, 0);
  assert.match(r.out, /line 11: notice legacy-table:/);
  assert.match(r.out, /line 19: notice unmapped-status: Status "\$\$"/);
  assert.match(r.out, /0 error\(s\), 6 notice\(s\), 4 table\(s\), 18 phase\(s\)/);
});

test("read: prints JSON with the file's base name only", () => {
  const p = project(STANDARD);
  const r = run(["read", p.file]);
  assert.equal(r.code, 0);
  const json = JSON.parse(r.out);
  assert.equal(json.file, "PHASES.md");
  assert.equal(json.tables[0].phases.length, 5);
  assert.ok(!r.out.includes(p.dir));
});

// ── status mapping ──────────────────────────────────────────────────────────
test("mapStatus: every word of the mapping, case-insensitive and trimmed", () => {
  const table = {
    planned: ["planned", "to plan", "backlog", "next", "todo", "queued"],
    "in progress": ["in progress", "in-progress", "wip", "building", "started", "previewed"],
    shipped: ["shipped", "done", "complete", "completed", "released"],
    parked: ["parked", "dropped", "skipped", "deferred", "on hold", "blocked"],
  };
  for (const [status, words] of Object.entries(table)) {
    for (const w of words) {
      assert.deepEqual(mapStatus(w), { status }, w);
      assert.deepEqual(mapStatus(`  ${w.toUpperCase()}  `), { status }, w);
    }
  }
  assert.deepEqual(STATUSES, ["planned", "in progress", "shipped", "parked"]);
});

test("mapStatus: a parenthetical moves to Plan file or Note, moved-to is parked, the rest is blocked", () => {
  assert.deepEqual(mapStatus("planned (some/plan.md)"), { status: "planned", planFile: "some/plan.md" });
  assert.deepEqual(mapStatus("planned (docs\\plan-2.md)"), { status: "planned", planFile: "docs\\plan-2.md" });
  assert.deepEqual(mapStatus("planned (free text)"), { status: "planned", note: "free text" });
  assert.deepEqual(mapStatus("Done (abc1234)"), { status: "shipped", note: "abc1234" });
  assert.deepEqual(mapStatus("planned ()"), { status: "planned" });
  assert.deepEqual(mapStatus("moved to phase 9"), { status: "parked", note: "moved to phase 9" });
  assert.deepEqual(mapStatus("Moved to the next release"), { status: "parked", note: "Moved to the next release" });
  for (const raw of ["$$", "$", "", "   ", "maybe", "unknown (planned)", "plannedish", "planned later", undefined, null]) assert.equal(mapStatus(raw), null, String(raw));
});

test("mapStatus: the real-world forms (a date, a date with a parenthetical, bold with a plan reference, emphasis marks, the longest word)", () => {
  const D = "2026-10-24";
  const forms = [
    ["shipped 2026-10-24", { status: "shipped", note: D }],
    ["shipped 2026-10-25 (2nd attempt)", { status: "shipped", note: "2026-10-25 (2nd attempt)" }],
    ["**shipped 2026-10-26** (plan: docs/phases/phase-x.md)", { status: "shipped", note: "2026-10-26", planFile: "docs/phases/phase-x.md" }],
    ["**shipped**", { status: "shipped" }],
    ["_shipped_", { status: "shipped" }],
    ["`shipped`", { status: "shipped" }],
    ["__Done__ (abc1234)", { status: "shipped", note: "abc1234" }],
    ["**Shipped** 2026-10-24", { status: "shipped", note: D }],
    ["shipped 2026-10-24T10:00:00Z", { status: "shipped", note: "2026-10-24T10:00:00Z" }],
    ["in progress 2026-10-24", { status: "in progress", note: D }],
    ["In Progress (plan: plans/x.md)", { status: "in progress", planFile: "plans/x.md" }],
    ["planned (plan: plans/x.md)", { status: "planned", planFile: "plans/x.md" }],
    ["planned plan: plans/x.md", { status: "planned", planFile: "plans/x.md" }],
    ["shipped docs/phases/phase_x.md", { status: "shipped", planFile: "docs/phases/phase_x.md" }],
    ["shipped 2026-10-24 plan: plans/x.md", { status: "shipped", note: D, planFile: "plans/x.md" }],
    ["shipped 2026-10-24 (plans/x.md)", { status: "shipped", note: D, planFile: "plans/x.md" }],
    ["completed 2026-10-24", { status: "shipped", note: D }],
    ["on hold 2026-10-24", { status: "parked", note: D }],
    ["to plan (later)", { status: "planned", note: "later" }],
  ];
  for (const [raw, want] of forms) assert.deepEqual(mapStatus(raw), want, raw);
});

test("mapStatus: confirmed, a bare number and every other word or shape stay blocked (never guessed)", () => {
  for (const raw of ["confirmed", "**confirmed**", "confirmed 2026-10-24", "3", "3 shipped", "shipped later", "shipped on 2026-10-24", "shipped 2026-10-24abc", "in progress later",
    "in", "shipped (", "shipped2026-10-24", "done?", "**", "_", "unknown 2026-10-24", "2026-10-24", "plan: x.md", "x.md", "blocked by 3"]) {
    assert.equal(mapStatus(raw), null, raw);
  }
});

test("reader: a legacy table with the real-world status forms places them, and only the unknown words stay blocked, with the exact --set-status hint", () => {
  const text = table(["#", "Phase", "Status"], [
    ["1", "a", "shipped 2026-10-24"], ["2", "b", "shipped 2026-10-25 (2nd attempt)"], ["3", "c", "**shipped 2026-10-26** (plan: docs/phases/phase-x.md)"],
    ["4", "d", "confirmed"], ["5", "e", "3"], ["6", "f", "In Progress 2026-10-27"],
  ], false);
  const json = toReadJson(parseRoadmap(text), "x.md");
  const t = json.tables[0];
  assert.deepEqual(t.phases.map((p) => p.status), ["shipped", "shipped", "shipped", null, null, "in progress"]);
  assert.equal(t.phases[2].planFile, "docs/phases/phase-x.md");
  assert.equal(t.phases[2].note, "2026-10-26");
  assert.equal(t.phases[1].note, "2026-10-25 (2nd attempt)");
  assert.deepEqual(t.problems.filter((p) => p.code === "unmapped-status").map((p) => p.line), [6, 7]);
  assert.equal(json.summary.shipped, 3);
  const plan = planStandardize(text);
  assert.deepEqual(plan.blocked.map((b) => [b.id, b.code]), [["4", "unmapped-status"], ["5", "unmapped-status"]]);
  assert.ok(plan.blocked[0].hint.includes("--set-status 4=planned | --set-status \"4=in progress\" | --set-status 4=shipped | --set-status 4=parked"));
  const done = planStandardize(text, { statusOverrides: [{ id: "4", status: "planned" }, { id: "5", status: "parked" }] });
  assert.deepEqual(done.blocked, []);
  const after = parseRoadmap(done.text).tables[0];
  assert.equal(after.legacy, false);
  assert.deepEqual(after.problems, []);
  const cols = after.names;
  const cell = (row, name) => after.rows[row].vals[cols.indexOf(name)];
  assert.equal(cell(2, "Status"), "shipped");
  assert.equal(cell(2, "Plan file"), "docs/phases/phase-x.md");
  assert.equal(cell(2, "Note"), "2026-10-26");
  assert.equal(cell(1, "Note"), "2026-10-25 (2nd attempt)");
  assert.equal(cell(5, "Status"), "in progress");
  assert.equal(planStandardize(done.text).changed, false, "a second standardize changes nothing");
});

// ── standardize: the plan ───────────────────────────────────────────────────
test("standardize plan: writes nothing, lists the marker, renames, normalisations and the blocked rows with the exact hint", () => {
  const p = project(MESSY);
  const before = p.read();
  const r = run(["standardize", p.file, "--root", p.dir]);
  assert.equal(r.code, 0);
  assert.equal(p.read(), before, "the file bytes are identical after a plan");
  assert.deepEqual(readdirSync(p.dir), ["PHASES.md"], "no backup and no .tmp");
  assert.match(r.out, /nothing is written without --write/);
  assert.ok(r.out.includes(`    + ${MARKER}`));
  assert.ok(r.out.includes("    - | # | Phase | State |"));
  assert.ok(r.out.includes("    + | # | Phase | Status |"));
  assert.ok(r.out.includes("    - | # | Phase | Kind | Priority | Urgency | Est. | Plan | Blocked by |"));
  assert.ok(r.out.includes("Est. (raw → cal.) | Plan | Blocked by | Status |"));
  assert.match(r.out, /\| to plan \| \| \|\n\s+\+ .*\| planned \|/);
  assert.match(r.out, /BLOCKED line 19 \(id 7\): Status "\$\$" cannot be placed/);
  assert.ok(r.out.includes("--set-status 7=planned"));
  assert.ok(r.out.includes('--set-status "7=in progress"'));
  assert.ok(r.out.includes("--set-status 7=shipped"));
  assert.ok(r.out.includes("--set-status 7=parked"));
  assert.match(r.out, /BLOCKED line 20 \(id 8\)/);
  assert.match(r.out, /BLOCKED line 31 \(id 13\): row has 17 cells but the header has 16/);
  assert.ok(!r.out.includes(p.dir));
});

test("standardize plan: a table without a Status column gets the loud notice", () => {
  const r = run(["standardize", writeTemp(MESSY), "--table", "2"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /NOTICE: this table has no Status column\. A Status column will be added and EVERY row set to `planned`/);
  assert.doesNotMatch(r.out, /table 0 \(/, "an unchosen table is not planned");
  assert.match(r.out, /summary: 1 table\(s\) to change, \d+ line\(s\) changed or added, 0 blocked/);
});

test("standardize plan: the parenthetical text moves to Plan file or Note, and a cost cell moves to Note on a chosen status", () => {
  const plan = planStandardize(MESSY, { onlyTables: [0], statusOverrides: [{ id: "7", status: "planned" }, { id: "8", status: "parked" }] });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.blocked, []);
  const t = parseRoadmap(plan.text).tables[0];
  assert.equal(t.legacy, false);
  assert.deepEqual(t.names.slice(-2), ["Plan file", "Note"]);
  const row = (id) => Object.fromEntries(t.names.map((n, i) => [n, t.rows.find((r) => r.vals[0] === id).vals[i]]));
  assert.equal(row("3")["Plan file"], "docs/phases/phase-3-report.md");
  assert.equal(row("3").Status, "planned");
  assert.equal(row("9").Note, "waiting on review");
  assert.equal(row("6").Note, "moved to phase 9");
  assert.equal(row("7").Note, "$$");
  assert.equal(row("7").Status, "planned");
  assert.equal(row("8").Status, "parked");
  assert.equal(row("8").Phase, "A short row");
  assert.equal(row("10").Status, "planned");
  assert.equal(row("11").Status, "in progress");
});

test("standardize plan: a --set-status that matches no row is a usage error, and so is a bad status or table", () => {
  assert.match(planStandardize(MESSY, { statusOverrides: [{ id: "nope", status: "planned" }] }).error, /matches no row/);
  assert.match(planStandardize(MESSY, { statusOverrides: [{ id: "7", status: "done" }] }).error, /not one of/);
  assert.match(planStandardize(MESSY, { onlyTables: [9] }).error, /no table with index 9/);
  const p = project(MESSY);
  assert.equal(run(["standardize", p.file, "--set-status", "nope=planned"]).code, 2);
  assert.equal(run(["standardize", p.file, "--set-status", "garbage"]).code, 2);
  assert.equal(run(["standardize", p.file, "--table", "9"]).code, 2);
});

test("standardize plan: an id that is in two tables gets a table-prefixed hint, and the prefix selects the table", () => {
  const text = `${table(MIN, [["1", "a", "maybe"]], false)}\n${table(MIN, [["1", "b", "maybe"]], false)}`;
  const plan = planStandardize(text);
  assert.equal(plan.blocked.length, 2);
  assert.ok(plan.report.some((l) => l.includes("--set-status 0:1=planned")));
  assert.ok(plan.report.some((l) => l.includes("--set-status 1:1=planned")));
  const one = planStandardize(text, { statusOverrides: [{ table: 1, id: "1", status: "shipped" }, { table: 0, id: "1", status: "parked" }] });
  assert.deepEqual(one.blocked, []);
  const [a, b] = parseRoadmap(one.text).tables;
  assert.equal(a.rows[0].vals[2], "parked");
  assert.equal(b.rows[0].vals[2], "shipped");
  assert.equal(a.rows[0].vals[Math.max(0, a.names.indexOf("Note"))], "maybe", "the unknown status text is kept as a note");
});

test("standardize plan: a header that would clash, a bad priority and a duplicate id are blocked for hand fixing", () => {
  const clash = planStandardize(table(["#", "Phase", "State", "Status"], [["1", "x", "done", "planned"]], false));
  assert.ok(clash.blocked.some((b) => b.code === "alias-clash" && /already has a "Status" column/.test(b.message)));
  const bad = planStandardize(table([...MIN, "Priority"], [["1", "x", "planned", "high"], ["1", "y", "planned", "P1"]], false));
  assert.deepEqual(bad.blocked.map((b) => b.code).sort(), ["bad-priority", "duplicate-id"]);
  assert.ok(bad.blocked.every((b) => !b.hint));
  const occupied = planStandardize(table([...MIN, "Note"], [["1", "x", "planned (a note)", "already here"]], false));
  assert.ok(occupied.blocked.some((b) => b.code === "occupied"));
});

// ── standardize: write ──────────────────────────────────────────────────────
const NOW = () => new Date(2026, 0, 2, 3, 4, 5);
const BACKUP = "PHASES.md.bak-20260102-030405";
const BDIR = ".roadmap-backups";
const ORIGINAL = "PHASES.md.original";
// The names in the project's backup folder (sorted), or null when the folder is not there.
const kept = (p) => (existsSync(join(p.dir, BDIR)) && lstatSync(join(p.dir, BDIR)).isDirectory() ? readdirSync(join(p.dir, BDIR)).sort() : null);
const keptText = (p, name) => readFileSync(join(p.dir, BDIR, name), "utf8");

test("standardize --write: refuses while rows are blocked (exit 1, no backup, file unchanged)", () => {
  const p = project(MESSY);
  const r = run(["standardize", p.file, "--root", p.dir, "--table", "0", "--write"], { now: NOW });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to write: 2 blocked item\(s\)/);
  assert.equal(p.read(), MESSY);
  assert.deepEqual(readdirSync(p.dir), ["PHASES.md"]);
});

test("standardize --write: with --set-status it makes the backup and the new file, and prints no absolute path", () => {
  const p = project(MESSY);
  const r = run(["standardize", p.file, "--root", p.dir, "--table", "0", "--table", "2", "--table", "3", "--set-status", "7=planned", "--set-status", "8=in progress", "--write"], { now: NOW });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readdirSync(p.dir).sort(), [BDIR, "PHASES.md"].sort(), "the only new thing next to the file is the backup folder (the .tmp is gone)");
  assert.deepEqual(kept(p), [".gitignore", ORIGINAL, BACKUP].sort());
  assert.equal(keptText(p, BACKUP), MESSY, "the dated copy has the bytes the file had");
  assert.equal(keptText(p, ORIGINAL), MESSY, "the original is the first version");
  assert.equal(keptText(p, ".gitignore"), "*\n");
  assert.notEqual(p.read(), MESSY);
  assert.ok(r.out.includes(`backup: ${BACKUP}`));
  assert.match(r.out, /wrote PHASES\.md: \d+ line\(s\) changed or added/);
  for (const text of [r.out, r.err]) {
    assert.ok(!text.includes(p.dir), "the temp folder path was printed");
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|(^|\s)\/(tmp|var|home|Users)\b/);
  }
});

test("standardize --write: refuses when the backup name exists in the folder, and changes nothing", () => {
  const p = project(MESSY);
  mkdirSync(join(p.dir, BDIR));
  writeFileSync(join(p.dir, BDIR, BACKUP), "keep me");
  const r = run(["standardize", p.file, "--root", p.dir, "--table", "2", "--write"], { now: NOW });
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists; nothing was written/);
  assert.equal(keptText(p, BACKUP), "keep me");
  assert.equal(p.read(), MESSY);
  assert.ok(!existsSync(join(p.dir, "PHASES.md.tmp")));
});

test("standardize --write: refuses when the temp file is already in the backup folder, and the file stays as it was", () => {
  const p = project(MESSY);
  mkdirSync(join(p.dir, BDIR));
  writeFileSync(join(p.dir, BDIR, "PHASES.md.tmp"), "somebody's file");
  const r = run(["standardize", p.file, "--table", "2", "--write"], { now: NOW });
  assert.equal(r.code, 1);
  assert.match(r.err, /another write to PHASES\.md may be in progress; if none is, delete \.roadmap-backups\/PHASES\.md\.tmp and try again/);
  assert.equal(p.read(), MESSY);
  assert.equal(readFileSync(join(p.dir, BDIR, "PHASES.md.tmp"), "utf8"), "somebody's file");
  assert.deepEqual(readdirSync(p.dir).sort(), [BDIR, "PHASES.md"].sort(), "nothing was put next to the file");
});

// The messy fixture with its one unfixable long row repaired, so every table can be standardized.
const FIXABLE = MESSY.replace(" | extra cell |", " |");
const OVERRIDES = ["--set-status", "7=planned", "--set-status", "8=in progress"];

test("standardize --write: round trip, check exits 0 with no notice, a second standardize says nothing to change", () => {
  const p = project(FIXABLE);
  const first = run(["standardize", p.file, "--root", p.dir, ...OVERRIDES, "--write"], { now: NOW });
  assert.equal(first.code, 0, first.err + first.out);
  const checked = run(["check", p.file, "--strict"]);
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /0 error\(s\), 0 notice\(s\), 4 table\(s\), 18 phase\(s\)/);
  const after = p.read();
  const second = run(["standardize", p.file, "--root", p.dir, "--write"], { now: () => new Date(2026, 0, 2, 3, 4, 6) });
  assert.equal(second.code, 0);
  assert.match(second.out, /nothing to change/);
  assert.equal(p.read(), after, "nothing written");
  assert.deepEqual(kept(p), [".gitignore", ORIGINAL, BACKUP].sort(), "no second backup");
  const json = JSON.parse(run(["read", p.file]).out);
  assert.equal(json.summary.legacyTables, 0);
  assert.deepEqual([json.summary.planned, json.summary.inProgress, json.summary.shipped, json.summary.parked], [11, 3, 3, 1]);
});

test("standardize --write: every line outside the chosen tables is byte-identical, and an unchosen legacy table is untouched", () => {
  const p = project(MESSY);
  const r = run(["standardize", p.file, "--table", "0", "--table", "2", "--table", "3", ...OVERRIDES, "--write"], { now: NOW });
  assert.equal(r.code, 0, r.err);
  const was = MESSY.split("\n");
  const now = p.read().split("\n");
  const proseOf = (lines) => lines.filter((l) => !l.startsWith("|") && l !== MARKER);
  assert.deepEqual(proseOf(now), proseOf(was), "all text outside the tables is the same, in the same order");
  assert.equal(now.filter((l) => l === MARKER).length, 3, "three markers, one per chosen table");
  // Table 1 (lines 27 to 31 of the original) is still there, unchanged and still legacy.
  const block = was.slice(26, 31).join("\n");
  assert.ok(now.join("\n").includes(block));
  assert.equal(parseRoadmap(p.read()).tables[1].legacy, true);
  assert.equal(parseRoadmap(p.read()).tables.filter((t) => t.legacy).length, 1);
});

test("standardize --write: LF and CRLF files keep their line endings and the last-newline state", () => {
  const lf = project(FIXABLE);
  assert.equal(run(["standardize", lf.file, ...OVERRIDES, "--write"], { now: NOW }).code, 0);
  const expected = lf.read();
  assert.ok(!expected.includes("\r"));

  const crlf = project(toCrlf(FIXABLE));
  assert.equal(run(["standardize", crlf.file, ...OVERRIDES, "--write"], { now: NOW }).code, 0);
  const got = crlf.read();
  assert.equal(got, toCrlf(expected), "the CRLF result is the LF result with CRLF endings");
  assert.equal(got.replace(/\r\n/g, "").includes("\n"), false, "no bare LF");
  assert.equal(keptText(crlf, BACKUP), toCrlf(FIXABLE));
  assert.equal(keptText(crlf, ORIGINAL), toCrlf(FIXABLE));

  // No newline at the end of the file.
  const bare = FIXABLE.replace(/\n$/, "");
  const noEol = project(bare);
  assert.equal(run(["standardize", noEol.file, ...OVERRIDES, "--write"], { now: NOW }).code, 0);
  assert.equal(noEol.read(), expected.replace(/\n$/, ""));

  // The table is the last thing in the file and has no newline after its last row.
  const small = project(table(MIN, [["1", "x", "done"], ["2", "y", "wip"]], false).replace(/\n$/, ""));
  assert.equal(run(["standardize", small.file, "--write"], { now: NOW }).code, 0);
  assert.equal(small.read(), `${MARKER}\n| # | Phase | Status |\n|---|---|---|\n| 1 | x | shipped |\n| 2 | y | in progress |`);

  // A file that mixes endings keeps each line's own ending.
  const mixed = project("# T\r\n\n| # | Phase | State |\r\n|---|---|---|\n| 1 | x | done |\r\n");
  assert.equal(run(["standardize", mixed.file, "--write"], { now: NOW }).code, 0);
  assert.equal(mixed.read(), `# T\r\n\n${MARKER}\r\n| # | Phase | Status |\r\n|---|---|---|\n| 1 | x | shipped |\r\n`);
});

test("standardize: a table that is already standard says nothing to change and writes nothing", () => {
  const p = project(STANDARD);
  const r = run(["standardize", p.file, "--write"], { now: NOW });
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to change/);
  assert.deepEqual(readdirSync(p.dir), ["PHASES.md"]);
  assert.equal(p.read(), STANDARD);
  assert.match(run(["standardize", p.file, "--table", "0"]).out, /table 0 \(line 14\) is already standard/);
  const none = run(["standardize", project("# only text\n").file]);
  assert.match(none.out, /no roadmap table found/);
});

test("standardize --write: a file that is not valid UTF-8 is refused before anything is written", () => {
  const dir = tmp();
  const file = join(dir, "PHASES.md");
  writeFileSync(file, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  const r = run(["standardize", file, "--write"], { now: NOW });
  assert.equal(r.code, 2);
  assert.match(r.err, /not valid UTF-8/);
  assert.deepEqual(readdirSync(dir), ["PHASES.md"]);
});

test("standardize --write: a file outside --root is refused (exit 2) and nothing is written", () => {
  const p = project(MESSY);
  const other = tmp();
  const r = run(["standardize", p.file, "--root", other, "--table", "2", "--write"], { now: NOW });
  assert.equal(r.code, 2);
  assert.equal(p.read(), MESSY);
  assert.deepEqual(readdirSync(p.dir), ["PHASES.md"]);
  assert.deepEqual(readdirSync(other), []);
  // A path that climbs out of the root with ".." is refused too.
  const sub = join(p.dir, "sub");
  mkdirSync(sub);
  const climbed = run(["check", join(sub, "..", "PHASES.md"), "--root", sub]);
  assert.equal(climbed.code, 2);
});

// ── set ─────────────────────────────────────────────────────────────────────
test("set: changes only the one row, all other lines are identical, and no .tmp is left (the copies are in the backup folder)", () => {
  const p = project(STANDARD);
  const r = run(["set", p.file, "3", "--status", "In Progress", "--commit", "a1b2c3d", "--actual", "1.5", "--plan-file", "plans/three.md", "--note", "a | b", "--root", p.dir]);
  assert.equal(r.code, 0, r.err);
  const was = STANDARD.split("\n");
  const now = p.read().split("\n");
  assert.equal(now.length, was.length);
  const changed = now.map((l, i) => i).filter((i) => now[i] !== was[i]);
  assert.deepEqual(changed, [17], "only the line of id 3 changed");
  assert.deepEqual(readdirSync(p.dir).sort(), [BDIR, "PHASES.md"].sort(), "only the backup folder was added next to the file");
  assert.deepEqual(kept(p), [".gitignore", ORIGINAL, "PHASES.md.prev"].sort());
  assert.match(r.out, /^updated PHASES\.md line 18: \| 3 \| Landing page /);
  const phase = toReadJson(parseRoadmap(p.read()), "x").tables[0].phases[2];
  assert.equal(phase.status, "in progress");
  assert.equal(phase.commit, "a1b2c3d");
  assert.equal(phase.actual, 1.5);
  assert.equal(phase.planFile, "plans/three.md");
  assert.equal(phase.note, "a | b");
  assert.equal(phase.phase, "Landing page");
  assert.deepEqual(parseRoadmap(p.read()).tables[0].problems, []);
  assert.ok(!r.out.includes(p.dir));
});

test("set: touches only the cells it was given, writes the status in lowercase and the actual as <n> h", () => {
  const p = project(STANDARD);
  assert.equal(run(["set", p.file, "5.1", "--status", "SHIPPED"]).code, 0);
  assert.equal(run(["set", p.file, "5.1", "--actual", "2 h"]).code, 0);
  const phase = toReadJson(parseRoadmap(p.read()), "x").tables[0].phases[4];
  assert.equal(phase.status, "shipped");
  assert.equal(phase.statusRaw, "shipped");
  assert.equal(phase.actual, 2);
  assert.ok(p.read().includes("| 2 h |"));
  assert.equal(setPhase(STANDARD, "1", { note: "" }).text.split("\n")[15].includes("| shipped | abc1234 | 1.2 h | plans/one.md |"), true, "an empty value clears only that cell");
});

test("set: validates the status and the actual, and refuses unknown, legacy and ambiguous ids", () => {
  const p = project(STANDARD);
  assert.equal(run(["set", p.file, "3", "--status", "done"]).code, 2);
  assert.equal(run(["set", p.file, "3", "--actual", "lots"]).code, 2);
  assert.equal(run(["set", p.file, "3", "--actual", "-1"]).code, 2);
  assert.equal(run(["set", p.file, "3", "--note", "two\nlines"]).code, 2);
  assert.equal(run(["set", p.file, "3"]).code, 2, "nothing to set");
  assert.equal(p.read(), STANDARD, "nothing changed");

  const unknown = run(["set", p.file, "77", "--status", "shipped"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /id "77" is in no standard table/);

  const legacy = project(MESSY);
  const refused = run(["set", legacy.file, "13", "--status", "shipped"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /only in a legacy table \(line \d+\): run standardize first/);
  assert.equal(legacy.read(), MESSY);

  const dup = project(table(MIN, [["1", "x", "planned"], ["1", "y", "planned"]]));
  const ambiguous = run(["set", dup.file, "1", "--status", "shipped"]);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err, /more than one row/);
  const twoTables = project(`${table(MIN, [["1", "x", "planned"]])}\ntext\n${table(MIN, [["1", "y", "planned"]])}`);
  assert.equal(run(["set", twoTables.file, "1", "--status", "shipped"]).code, 1);

  const noCol = project(table(MIN, [["1", "x", "planned"]]));
  const missing = run(["set", noCol.file, "1", "--commit", "abc"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no "Commit \/ deploy" column/);
  assert.equal(noCol.read(), table(MIN, [["1", "x", "planned"]]));

  const wide = project(`${table(MIN, [["1", "x", "planned"]])}| 2 | y | planned | oops |\n`);
  assert.equal(run(["set", wide.file, "2", "--status", "shipped"]).code, 1);
  assert.equal(run(["set", wide.file, "1", "--status", "shipped"]).code, 0, "a bad row elsewhere does not stop a good row");
});

test("set: a standard table's id is found even when the same id is in a legacy table", () => {
  const text = `${table(MIN, [["1", "legacy one", "planned"]], false)}\ntext\n${table(MIN, [["1", "standard one", "planned"]])}`;
  const p = project(text);
  assert.equal(run(["set", p.file, "1", "--status", "shipped"]).code, 0);
  const [legacy, standard] = parseRoadmap(p.read()).tables;
  assert.equal(legacy.rows[0].vals[2], "planned");
  assert.equal(standard.rows[0].vals[2], "shipped");
});

test("set: keeps CRLF line endings and the last-newline state, and refuses an existing temp file in the backup folder", () => {
  const crlf = project(toCrlf(STANDARD));
  assert.equal(run(["set", crlf.file, "2", "--status", "shipped"]).code, 0);
  assert.equal(crlf.read().replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(crlf.read().length - toCrlf(STANDARD).length, "shipped".length - "in progress".length);
  const bare = project(STANDARD.replace(/\n$/, ""));
  assert.equal(run(["set", bare.file, "1", "--note", "x"]).code, 0);
  assert.equal(bare.read().endsWith("\n"), false);

  const p = project(STANDARD);
  mkdirSync(join(p.dir, BDIR));
  writeFileSync(join(p.dir, BDIR, "PHASES.md.tmp"), "other");
  const r = run(["set", p.file, "1", "--status", "parked"]);
  assert.equal(r.code, 1);
  assert.equal(p.read(), STANDARD);
  assert.equal(readFileSync(join(p.dir, BDIR, "PHASES.md.tmp"), "utf8"), "other");
});

// ── the command line, run as a real process ─────────────────────────────────
test("cli: exit codes and output as a real process, no absolute path is printed, and only the file's own folder is written", () => {
  const p = project(MESSY);
  const std = project(STANDARD);
  const elsewhere = tmp();
  const checks = [
    spawn(["check", std.file], elsewhere), spawn(["check", p.file, "--strict"], elsewhere), spawn(["read", p.file], elsewhere),
    spawn(["check", join(p.dir, "gone.md")], elsewhere), spawn(["standardize", p.file, "--table", "0", "--write"], elsewhere),
  ];
  assert.deepEqual(checks.map((c) => c.code), [0, 1, 0, 2, 1]);
  for (const c of checks) {
    for (const dir of [p.dir, std.dir]) assert.ok(!c.out.includes(dir) && !c.err.includes(dir), "an absolute path was printed");
  }
  assert.equal(JSON.parse(checks[2].out).file, "PHASES.md");
  assert.deepEqual(readdirSync(p.dir), ["PHASES.md"], "the refused write left no backup");
  const written = spawn(["standardize", p.file, "--table", "2", "--write"], elsewhere);
  assert.equal(written.code, 0, written.err);
  assert.deepEqual(readdirSync(p.dir).sort(), [BDIR, "PHASES.md"].sort(), "only the backup folder was added next to the file");
  assert.ok(kept(p).some((n) => /^PHASES\.md\.bak-\d{8}-\d{6}$/.test(n)));
  assert.ok(kept(p).includes(ORIGINAL));
  assert.ok(!written.out.includes(p.dir));
  assert.deepEqual(readdirSync(elsewhere), [], "nothing was created in the working folder");
});

// ── the source ──────────────────────────────────────────────────────────────
test("the script imports only node: built-ins and never calls require or a dynamic import", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const imports = [...src.matchAll(/^\s*import\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 3);
  for (const spec of imports) assert.match(spec, /^node:/, spec);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bimport\s*\(/);
  assert.doesNotMatch(src, /^\s*import\s+["']/m, "no side-effect imports");
});

test("the script never writes anywhere but the roadmap file's own folder or its backup folder: every write call names a known path variable", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const calls = [...src.matchAll(/\b(writeFileSync|openSync|copyFileSync|renameSync|rmSync|mkdirSync|unlinkSync|rmdirSync|appendFileSync|truncateSync|symlinkSync|linkSync|chmodSync|createWriteStream|cpSync)\(([^)]*)\)/g)]
    .map((m) => ({ fn: m[1], args: m[2] }));
  assert.ok(calls.length >= 6);
  const allowed = {
    writeFileSync: [/^fd, data$/],
    openSync: [/^path, "wx", FILE_MODE$/, /^dir, "r"$/],
    renameSync: [/^a, b$/],
    linkSync: [/^tmp, path$/],
    chmodSync: [/^tmp, f\.mode$/],
    rmSync: [/^path, \{ force: true \}$/],
    mkdirSync: [/^info\.dir, \{ mode: DIR_MODE \}$/],
  };
  for (const c of calls) {
    assert.ok(allowed[c.fn]?.some((re) => re.test(c.args)), `unexpected write call ${c.fn}(${c.args})`);
  }
  assert.equal(calls.filter((c) => c.fn === "linkSync").length, 1, "one link call, from the publish helper");
  // The one rename helper is called for exactly two things: the .prev copy and the roadmap file.
  const renames = [...src.matchAll(/= renameWithRetry\((tmp, [^,]+), /g)].map((m) => m[1]);
  assert.deepEqual(renames.sort(), ["tmp, f.path", "tmp, final"]);
  // Every file is created exclusively; the only rename targets are the .prev copy and the roadmap file.
  assert.doesNotMatch(src, /flag:\s*"w"/);
  assert.doesNotMatch(src, /["']w["']|["']a["']|["']r\+["']/, "no file is opened for overwrite or append");
  assert.ok(!/\.original/.test(calls.map((c) => c.args).join("\n")), "no write call names .original directly");
});

// ── the personal copies ─────────────────────────────────────────────────────
// The plan and run skills reach the roadmap script through a sibling path (../roadmap/scripts/roadmap.mjs), like
// commands-hash.mjs. sync-personal.mjs must rewrite that path to ../ps-roadmap/ for the personal copies, and
// must rename the skill's command from phased-shipping:roadmap to ps-roadmap.
test("sync-personal: the roadmap skill is installed as ps-roadmap and the sibling script path is rewritten", () => {
  const home = tmp();
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "sync-personal.mjs")], { encoding: "utf8", env: { ...process.env, SYNC_PERSONAL_CLAUDE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(home, "skills", "ps-roadmap", "SKILL.md"), "utf8"), /^name: ps-roadmap$/m);
  assert.ok(existsSync(join(home, "skills", "ps-roadmap", "scripts", "roadmap.mjs")));
  for (const skill of ["ps-plan", "ps-run"]) {
    const text = readFileSync(join(home, "skills", skill, "SKILL.md"), "utf8");
    assert.ok(text.includes("../ps-roadmap/scripts/roadmap.mjs"), `${skill} reaches the personal copy`);
    assert.doesNotMatch(text, /\.\.\/roadmap\//, `${skill} has no path to the plugin-only folder`);
  }
});

// Phase 7d1c: the onboard skill reaches its survey script the same way (there is no helper agent to install).
test("sync-personal: the onboard skill is installed as ps-onboard, no helper agent is installed, and the plan copy reaches the rewritten survey path", () => {
  const home = tmp();
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "sync-personal.mjs")], { encoding: "utf8", env: { ...process.env, SYNC_PERSONAL_CLAUDE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const onboard = readFileSync(join(home, "skills", "ps-onboard", "SKILL.md"), "utf8");
  assert.match(onboard, /^name: ps-onboard$/m);
  assert.ok(existsSync(join(home, "skills", "ps-onboard", "scripts", "survey.mjs")));
  assert.ok(existsSync(join(home, "skills", "ps-onboard", "references", "survey.md")));
  assert.ok(onboard.includes("../ps-roadmap/scripts/roadmap.mjs"), "the onboard copy reaches the roadmap copy");
  assert.ok(!/surveyor/i.test(onboard), "the onboard copy names no helper agent");
  assert.ok(!onboard.includes("phased-shipping:"), "no plugin-only component name is left in the personal copy");
  assert.deepEqual(readdirSync(join(home, "agents")).filter((n) => n.startsWith("ps-")).sort(), ["ps-builder.md", "ps-checker.md", "ps-model-scout.md", "ps-shipper.md"], "four agents are installed, and no survey agent");
  const plan = readFileSync(join(home, "skills", "ps-plan", "SKILL.md"), "utf8");
  assert.ok(plan.includes("../ps-onboard/scripts/survey.mjs"), "ps-plan reaches the personal copy");
  assert.doesNotMatch(plan, /\.\.\/onboard\//, "ps-plan has no path to the plugin-only folder");
  const check = spawnSync(process.execPath, [join(REPO, "scripts", "sync-personal.mjs"), "--check"], { encoding: "utf8", env: { ...process.env, SYNC_PERSONAL_CLAUDE_HOME: home } });
  assert.equal(check.status, 0, check.stdout);
});

test("every command accepts its flags: read --root, and a root spelled differently from the file's path (short and long names)", () => {
  const p = project(STANDARD);
  const longRoot = realpathSync.native(p.dir);
  for (const argv of [["read", p.file, "--root", p.dir], ["read", p.file, "--root", longRoot], ["check", p.file, "--root", longRoot], ["check", p.file, "--root=" + p.dir]]) {
    const r = run(argv);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`);
  }
  assert.equal(run(["read", p.file, "--bogus"]).code, 2);
  assert.equal(run(["read", p.file, "--strict"]).code, 2, "--strict belongs to check only");
  assert.equal(run(["standardize", p.file, "--set-status=1=planned", "--root", longRoot]).code, 2, "an id that matches no chosen row is a usage error");
});

// ── cells: the writer and the reader agree (a backslash and a pipe in a cell) ──
const ALPHABET = ["a", " ", "|", "\\"];
function everyString(maxLen) {
  let layer = [""];
  const all = [""];
  for (let n = 1; n <= maxLen; n++) {
    layer = layer.flatMap((s) => ALPHABET.map((c) => s + c));
    all.push(...layer);
  }
  return all;
}
const threeColumns = (middle) => `${MARKER}\n| # | Phase | Status |\n|---|---|---|\n|${cellOf("1")}|${middle}|${cellOf("planned")}|\n`;

test("cells: clean(cellOf(v).trim()) gives v back for every string of a, space, | and backslash up to 6 characters", () => {
  const strings = everyString(6);
  assert.equal(strings.length, 1 + 4 + 16 + 64 + 256 + 1024 + 4096);
  for (const v of strings) {
    const got = clean(cellOf(v).trim());
    assert.equal(got, v.trim(), JSON.stringify(v));
    if (v === v.trim()) assert.equal(got, v, JSON.stringify(v));
  }
});

test("cells: the explicit round-trip cases, and a row built from cellOf values always splits into the expected cells", () => {
  const cases = ["", "a|b", "a\\b", "a\\|b", "a\\\\|b", "x\\", "|", "\\", "\\\\", "|\\|"];
  for (const v of cases) assert.equal(clean(cellOf(v).trim()), v, JSON.stringify(v));
  assert.equal(cellOf("a|b"), " a\\|b ");
  assert.equal(cellOf("a\\b"), " a\\b ", "a backslash that is not before a pipe is written as it is");
  assert.equal(cellOf("a\\|b"), " a\\\\\\|b ", "a backslash before a pipe is doubled, then the pipe is escaped");
  for (const v of everyString(6)) {
    const t = parseRoadmap(threeColumns(cellOf(v))).tables[0];
    assert.equal(t.rows.length, 1, JSON.stringify(v));
    assert.equal(t.rows[0].raw.length, 3, `the row splits into 3 cells for ${JSON.stringify(v)}`);
    assert.equal(t.rows[0].vals[1], v.trim(), JSON.stringify(v));
    assert.equal(t.rows[0].vals[2], "planned");
  }
});

test("cells: the writer has a backslash replacement in the same function, and no regular expression is built from text", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const line = src.split("\n").find((l) => l.startsWith("export const cellOf"));
  assert.ok(line.includes('.replace(/\\\\(?=\\\\*\\|)/g, "\\\\$&")'), "cellOf puts a backslash in front of each backslash that is followed by backslashes and a pipe");
  assert.ok(!line.includes("(?<!"), "no lookbehind is needed");
  assert.ok(line.includes('replace(/\\|/g, "\\\\|")'), "cellOf still escapes the pipe");
  assert.doesNotMatch(src, /new RegExp/);
});

test("cells: legacy cells read exactly as before (a Windows path, a UNC path, an escaped pipe), and set on another row leaves them byte-identical", () => {
  assert.equal(clean("docs\\plan-2.md"), "docs\\plan-2.md");
  assert.equal(clean(" \\\\server\\share\\x.md "), "\\\\server\\share\\x.md");
  assert.equal(clean("a\\|b"), "a|b");
  assert.equal(clean("a\\\\|b"), "a\\|b", "an even run before a pipe reads as it always did");
  const text = `${MARKER}\n| # | Phase | Status | Plan file |\n|---|---|---|---|\n| 1 | one | planned | docs\\plan-2.md |\n| 2 | two | planned | \\\\server\\share\\two.md |\n| 3 | three | planned | a\\|b |\n`;
  assert.deepEqual(parseRoadmap(text).tables[0].problems, []);
  assert.deepEqual(parseRoadmap(text).tables[0].rows.map((r) => r.vals[3]), ["docs\\plan-2.md", "\\\\server\\share\\two.md", "a|b"]);
  assert.equal(run(["check", writeTemp(text), "--strict"]).code, 0, "check has no complaint about the cells");
  const p = project(text);
  assert.equal(run(["set", p.file, "3", "--status", "shipped"]).code, 0);
  const was = text.split("\n");
  const now = p.read().split("\n");
  assert.deepEqual(now.map((l, i) => i).filter((i) => now[i] !== was[i]), [5], "only the row of id 3 changed");
  assert.equal(run(["set", p.file, "1", "--note", "x"]).code, 1, "this table has no Note column, so nothing is written");
  // A value with a backslash and a pipe survives a set and a read.
  assert.equal(run(["set", p.file, "2", "--plan-file", "x\\|y"]).code, 0);
  assert.equal(toReadJson(parseRoadmap(p.read()), "x").tables[0].phases[1].planFile, "x\\|y");
});

// ── backups: the data-loss guarantees ───────────────────────────────────────
const bytes = (path) => readFileSync(path);
const keptBytes = (p, name) => bytes(join(p.dir, BDIR, name));
const same = (a, b, message) => assert.ok(Buffer.from(a).equals(Buffer.from(b)), message);
const leftovers = (p) => [...readdirSync(p.dir), ...(kept(p) ?? []).map((n) => `${BDIR}/${n}`)].filter((n) => /\.tmp/.test(n));
const clock = (start = 5) => { let s = start; return () => new Date(2026, 0, 2, 3, 4, s++); };
const setStatus = (p, id, status, extra = {}) => run(["set", p.file, id, "--status", status, "--root", p.dir], extra);
const MIXED = `${STANDARD}\n## Later\n\n${table(MIN, [["L1", "later one", "done"], ["L2", "later two", "wip"]], false)}`;

test("backups: the first set makes the folder, its .gitignore and the .original; standardize --write and 20 more sets leave the .original byte-identical", () => {
  const p = project(MIXED);
  const first = bytes(p.file);
  const r = setStatus(p, "3", "in progress");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(kept(p), [".gitignore", ORIGINAL, "PHASES.md.prev"].sort());
  assert.equal(keptText(p, ".gitignore"), "*\n");
  same(keptBytes(p, ORIGINAL), first, "the original is the first version, byte for byte");
  same(keptBytes(p, "PHASES.md.prev"), first, "the previous version is the first version too");
  assert.match(r.out, /first version kept as PHASES\.md\.original/);
  assert.equal(setStatus(p, "3", "planned").out.includes("first version kept"), false, "said once");
  assert.equal(run(["standardize", p.file, "--root", p.dir, "--write"], { now: clock() }).code, 0);
  same(keptBytes(p, ORIGINAL), first);
  const statuses = ["shipped", "parked", "planned", "in progress"];
  for (let i = 0; i < 20; i++) {
    const before = bytes(p.file);
    assert.equal(setStatus(p, "1", statuses[i % 4]).code, 0);
    same(keptBytes(p, ORIGINAL), first, `after set ${i + 1}`);
    same(keptBytes(p, "PHASES.md.prev"), before, `the previous version after set ${i + 1}`);
  }
  assert.equal(toReadJson(parseRoadmap(p.read()), "x").tables[0].phases[0].status, statuses[19 % 4], "the file changed as asked");
  assert.deepEqual(parseRoadmap(p.read()).tables.map((t) => t.legacy), [false, false], "standardize did its work");
  assert.deepEqual(leftovers(p), []);
});

test("backups: the .original is never overwritten, even when the roadmap file is replaced with something unrelated", () => {
  const p = project(STANDARD);
  const first = bytes(p.file);
  assert.equal(setStatus(p, "3", "parked").code, 0);
  writeFileSync(p.file, table(MIN, [["9", "something else entirely", "planned"]]));
  assert.equal(setStatus(p, "9", "shipped").code, 0);
  assert.equal(run(["standardize", p.file, "--write"], { now: clock() }).code, 0);
  same(keptBytes(p, ORIGINAL), first, "still the first version the tool ever saw");
  assert.ok(lstatSync(join(p.dir, BDIR, ORIGINAL)).isFile());
});

test("backups: a .original that is a directory makes every write fail closed, with the roadmap byte-identical", () => {
  for (const [file, argv] of [
    [FIXABLE, ["standardize", "FILE", ...OVERRIDES, "--write"]],
    [STANDARD, ["set", "FILE", "3", "--status", "parked"]],
    [STANDARD, ["restore", "FILE", "--from", "prev", "--write"]],
  ]) {
    const p = project(file);
    mkdirSync(join(p.dir, BDIR, ORIGINAL), { recursive: true });
    writeFileSync(join(p.dir, BDIR, "PHASES.md.prev"), "an older version\n");
    const before = bytes(p.file);
    const r = run(argv.map((a) => (a === "FILE" ? p.file : a)), { now: clock() });
    assert.equal(r.code, 1, `${argv[0]}: ${r.err}`);
    assert.match(r.err, /could not keep PHASES\.md\.original \(it is not a regular file\)/);
    same(bytes(p.file), before, `${argv[0]}: the roadmap is untouched`);
    assert.deepEqual(leftovers(p), []);
    assert.ok(lstatSync(join(p.dir, BDIR, ORIGINAL)).isDirectory(), "the directory is still there");
    assert.equal(keptText(p, "PHASES.md.prev"), "an older version\n");
  }
});

test("backups: a .original that is a symlink is refused and its target is never written (skipped where symlinks cannot be made)", (t) => {
  const p = project(STANDARD);
  const victim = join(tmp(), "victim.txt");
  writeFileSync(victim, "do not touch");
  mkdirSync(join(p.dir, BDIR));
  try { symlinkSync(victim, join(p.dir, BDIR, ORIGINAL), "file"); } catch { t.skip("this platform did not allow a symlink"); return; }
  const before = bytes(p.file);
  const r = setStatus(p, "3", "parked");
  assert.equal(r.code, 1);
  assert.match(r.err, /PHASES\.md\.original \(it is not a regular file\)/);
  same(bytes(p.file), before);
  assert.equal(readFileSync(victim, "utf8"), "do not touch");
});

test("backups: .prev is the file's bytes before the most recent set after each run, and a refused set leaves it alone", () => {
  const p = project(STANDARD);
  for (const [id, status] of [["1", "parked"], ["2", "planned"], ["3", "in progress"], ["1", "shipped"]]) {
    const before = bytes(p.file);
    assert.equal(setStatus(p, id, status).code, 0);
    same(keptBytes(p, "PHASES.md.prev"), before, `${id} to ${status}`);
  }
  const prev = keptBytes(p, "PHASES.md.prev");
  const current = bytes(p.file);
  const refused = setStatus(p, "77", "shipped");
  assert.equal(refused.code, 1);
  same(keptBytes(p, "PHASES.md.prev"), prev, "a refused set did not touch .prev");
  same(bytes(p.file), current);
  const fresh = project(STANDARD);
  assert.equal(setStatus(fresh, "77", "shipped").code, 1);
  assert.equal(kept(fresh), null, "a refused set creates no folder at all");
  assert.equal(run(["set", fresh.file, "3", "--status", "done"]).code, 2);
  assert.equal(kept(fresh), null, "nor does a usage error");
});

test("backups: fail closed when the folder cannot be used (a file in its place, a symlink or junction), the roadmap stays byte-identical, no .tmp left", (t) => {
  for (const [file, argv] of [
    [FIXABLE, ["standardize", "FILE", ...OVERRIDES, "--write"]],
    [STANDARD, ["set", "FILE", "3", "--status", "parked"]],
  ]) {
    const p = project(file);
    writeFileSync(join(p.dir, BDIR), "a file where the folder should be");
    const before = bytes(p.file);
    const r = run(argv.map((a) => (a === "FILE" ? p.file : a)), { now: clock() });
    assert.equal(r.code, 1, `${argv[0]}: ${r.err}`);
    assert.match(r.err, /could not use the \.roadmap-backups folder/);
    assert.match(r.err, /nothing was written/);
    same(bytes(p.file), before);
    assert.equal(readFileSync(join(p.dir, BDIR), "utf8"), "a file where the folder should be");
    assert.deepEqual(leftovers(p), []);
    assert.equal(run(["restore", p.file, "--from", "prev", "--write"]).code, 1, "restore refuses the same folder, with exit 1 like the others");
    assert.equal(run(["restore", p.file]).code, 1, "so does the listing");
  }
  // A symlinked (or junction) folder pointing elsewhere is refused and the other folder gets nothing.
  const p = project(STANDARD);
  const elsewhere = tmp();
  try { symlinkSync(elsewhere, join(p.dir, BDIR), process.platform === "win32" ? "junction" : "dir"); } catch { t.skip("this platform did not allow a symlink"); return; }
  const before = bytes(p.file);
  const r = setStatus(p, "3", "parked");
  assert.equal(r.code, 1, r.err);
  same(bytes(p.file), before);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing was written through the link");
  assert.equal(run(["standardize", writeTemp(MESSY), "--table", "2", "--write"]).code, 0, "a normal folder still works");
});

test("backups: a dated name that already exists, a temp file that already exists and a .prev that is a directory all fail closed", () => {
  const dated = project(FIXABLE);
  mkdirSync(join(dated.dir, BDIR));
  writeFileSync(join(dated.dir, BDIR, "PHASES.md.bak-20260102-030405"), "mine");
  const before = bytes(dated.file);
  assert.equal(run(["standardize", dated.file, ...OVERRIDES, "--write"], { now: NOW }).code, 1);
  same(bytes(dated.file), before);
  assert.equal(keptText(dated, "PHASES.md.bak-20260102-030405"), "mine");

  const tmpClash = project(STANDARD);
  mkdirSync(join(tmpClash.dir, BDIR));
  writeFileSync(join(tmpClash.dir, BDIR, "PHASES.md.tmp"), "someone else's");
  assert.equal(setStatus(tmpClash, "3", "parked").code, 1);
  same(bytes(tmpClash.file), Buffer.from(STANDARD));
  assert.equal(readFileSync(join(tmpClash.dir, BDIR, "PHASES.md.tmp"), "utf8"), "someone else's");
  same(keptBytes(tmpClash, ORIGINAL), Buffer.from(STANDARD), "the original is already kept; the roadmap was not changed");

  const dirPrev = project(STANDARD);
  mkdirSync(join(dirPrev.dir, BDIR, "PHASES.md.prev"), { recursive: true });
  const r = setStatus(dirPrev, "3", "parked");
  assert.equal(r.code, 1, r.err);
  same(bytes(dirPrev.file), Buffer.from(STANDARD));
  assert.deepEqual(leftovers(dirPrev), []);
});

test("backups: an existing .gitignore in the folder is never modified; a content other than '*' gets a warning, exactly '*' does not", () => {
  const warning = /warning: \.roadmap-backups\/\.gitignore does not hold only "\*", so git may list your backups/;
  for (const [content, warns] of [["keep\n", true], ["!*\n", true], ["", true], ["*\n", false], ["*", false], ["*\r\n", false], ["*\n*\n", true]]) {
    const p = project(STANDARD);
    mkdirSync(join(p.dir, BDIR));
    writeFileSync(join(p.dir, BDIR, ".gitignore"), content);
    const r = setStatus(p, "3", "parked");
    assert.equal(r.code, 0, `${JSON.stringify(content)}: ${r.err}`);
    assert.equal(keptText(p, ".gitignore"), content, "never modified");
    assert.equal(warning.test(r.err), warns, `${JSON.stringify(content)} -> warn ${warns}: ${r.err}`);
  }
});

test("backups: a .gitignore that is a folder or a link fails closed (exit 1, nothing written; the link part is skipped where links cannot be made)", (t) => {
  for (const [file, argv] of [
    [FIXABLE, ["standardize", "FILE", ...OVERRIDES, "--write"]],
    [STANDARD, ["set", "FILE", "3", "--status", "parked"]],
    [STANDARD, ["restore", "FILE", "--from", "prev", "--write"]],
  ]) {
    const p = project(file);
    mkdirSync(join(p.dir, BDIR, ".gitignore"), { recursive: true });
    writeFileSync(join(p.dir, BDIR, "PHASES.md.prev"), "an older version\n");
    const before = bytes(p.file);
    const r = run(argv.map((a) => (a === "FILE" ? p.file : a)), { now: clock() });
    assert.equal(r.code, 1, `${argv[0]}: ${r.err}`);
    assert.match(r.err, /\.gitignore is not a regular file\); nothing was written/);
    same(bytes(p.file), before);
    assert.ok(lstatSync(join(p.dir, BDIR, ".gitignore")).isDirectory());
    assert.deepEqual(kept(p), [".gitignore", "PHASES.md.prev"], "no .original, no copy, no temp file was made");
  }
  const p = project(STANDARD);
  const elsewhere = join(tmp(), "ignore.txt");
  writeFileSync(elsewhere, "*\n");
  mkdirSync(join(p.dir, BDIR));
  try { symlinkSync(elsewhere, join(p.dir, BDIR, ".gitignore"), "file"); } catch { t.skip("this platform did not allow a symlink"); return; }
  const r = setStatus(p, "3", "parked");
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /\.gitignore is not a regular file/);
  assert.equal(readFileSync(elsewhere, "utf8"), "*\n");
  same(bytes(p.file), Buffer.from(STANDARD));
});

test("backups: changed while writing - set, standardize --write and restore --write stop with the exact message and leave the injected change", () => {
  const MESSAGE = "the roadmap changed while it was being written; nothing was changed, run again";
  const injected = `${STANDARD}\n<!-- somebody else edited this -->\n`;
  const noTmp = (p) => assert.deepEqual(leftovers(p), []);

  // set, caught before .prev is replaced: .prev stays as it was.
  const a = project(STANDARD);
  assert.equal(setStatus(a, "1", "parked").code, 0);
  const prevBefore = keptBytes(a, "PHASES.md.prev");
  const stages = [];
  const r1 = setStatus(a, "2", "shipped", { beforeRename: (stage) => { stages.push(stage); if (stages.length === 1) writeFileSync(a.file, injected); } });
  assert.equal(r1.code, 1);
  assert.equal(r1.err, MESSAGE);
  assert.equal(a.read(), injected, "the other writer's change is still there");
  assert.deepEqual(stages, ["prev"], "it stopped at the first check");
  same(keptBytes(a, "PHASES.md.prev"), prevBefore, ".prev unchanged");
  noTmp(a);

  // set, caught at the last check, right before the roadmap rename.
  const b = project(STANDARD);
  const bStages = [];
  const startBytes = bytes(b.file);
  const r2 = setStatus(b, "2", "shipped", { beforeRename: (stage) => { bStages.push(stage); if (stage === "roadmap") writeFileSync(b.file, injected); } });
  assert.equal(r2.code, 1);
  assert.equal(r2.err, MESSAGE);
  assert.equal(b.read(), injected);
  assert.deepEqual(bStages, ["prev", "roadmap"]);
  same(keptBytes(b, ORIGINAL), startBytes);
  noTmp(b);

  // standardize --write.
  const c = project(FIXABLE);
  const cBefore = bytes(c.file);
  const cStages = [];
  const r3 = run(["standardize", c.file, ...OVERRIDES, "--write"], { now: NOW, beforeRename: (stage) => { cStages.push(stage); writeFileSync(c.file, injected); } });
  assert.equal(r3.code, 1);
  assert.equal(r3.err, MESSAGE);
  assert.equal(c.read(), injected);
  assert.deepEqual(cStages, ["roadmap"]);
  same(keptBytes(c, BACKUP), cBefore, "the dated copy holds what the command read");
  same(keptBytes(c, ORIGINAL), cBefore);
  noTmp(c);

  // restore --write.
  const d = project(STANDARD);
  assert.equal(setStatus(d, "3", "parked").code, 0);
  const dBefore = bytes(d.file);
  const r4 = run(["restore", d.file, "--from", "original", "--write"], { now: NOW, beforeRename: () => writeFileSync(d.file, injected) });
  assert.equal(r4.code, 1);
  assert.equal(r4.err, MESSAGE);
  assert.equal(d.read(), injected);
  same(keptBytes(d, "PHASES.md.before-restore-20260102-030405"), dBefore, "the copy of the file as the command read it");
  noTmp(d);
});

test("backups: LF and CRLF files - every copy is byte-identical to what it copied, and the new text keeps its endings", () => {
  const crlf = toCrlf(FIXABLE);
  const p = project(crlf);
  assert.equal(run(["standardize", p.file, ...OVERRIDES, "--write"], { now: NOW }).code, 0);
  same(keptBytes(p, BACKUP), Buffer.from(crlf));
  same(keptBytes(p, ORIGINAL), Buffer.from(crlf));
  assert.equal(p.read().replace(/\r\n/g, "").includes("\n"), false);
  const afterStandardize = bytes(p.file);
  assert.equal(setStatus(p, "3", "parked").code, 0);
  same(keptBytes(p, "PHASES.md.prev"), afterStandardize);
  assert.equal(p.read().replace(/\r\n/g, "").includes("\n"), false, "no bare LF after set");
  assert.equal(run(["restore", p.file, "--from", "original", "--write"], { now: clock() }).code, 0);
  same(bytes(p.file), Buffer.from(crlf), "the restore gives the CRLF bytes back");

  const lf = project(STANDARD);
  assert.equal(setStatus(lf, "1", "parked").code, 0);
  same(keptBytes(lf, ORIGINAL), Buffer.from(STANDARD));
  assert.equal(lf.read().includes("\r"), false);
});

// ── restore ─────────────────────────────────────────────────────────────────
function sequence() {
  // P0 (legacy) -> standardize -> P1 -> set -> P2
  const p = project(FIXABLE);
  const P0 = bytes(p.file);
  assert.equal(run(["standardize", p.file, "--root", p.dir, ...OVERRIDES, "--write"], { now: NOW }).code, 0);
  const P1 = bytes(p.file);
  assert.equal(setStatus(p, "3", "parked").code, 0);
  const P2 = bytes(p.file);
  return { p, P0, P1, P2 };
}
const restore = (p, args, extra = {}) => run(["restore", p.file, "--root", p.dir, ...args], extra);

test("restore: with no backups it says so, exits 0 and creates nothing", () => {
  const p = project(STANDARD);
  const r = restore(p, []);
  assert.equal(r.code, 0);
  assert.equal(r.out, "no backups yet");
  assert.deepEqual(readdirSync(p.dir), ["PHASES.md"], "a listing creates no folder");
  assert.equal(restore(p, ["--from", "original"]).code, 2);
  assert.match(restore(p, ["--from", "original"]).err, /there is no original copy of PHASES\.md yet/);
  assert.equal(restore(p, ["--from", "prev"]).code, 2);
  assert.deepEqual(readdirSync(p.dir), ["PHASES.md"]);
});

test("restore: the listing shows names, sizes, line counts and times newest first, and marks legacy copies beside the file", () => {
  const { p, P0, P1 } = sequence();
  const legacyName = "PHASES.md.bak-20250101-000000";
  writeFileSync(join(p.dir, legacyName), "# old\n| # | Phase |\n");
  const when = (name, date, inFolder = true) => { utimesSync(join(p.dir, ...(inFolder ? [BDIR] : []), name), date, date); };
  when(ORIGINAL, new Date(2026, 0, 1, 10, 0));
  when(BACKUP, new Date(2026, 0, 2, 11, 30));
  when("PHASES.md.prev", new Date(2026, 0, 3, 9, 5));
  when(legacyName, new Date(2025, 0, 1, 0, 0), false);
  const r = restore(p, []);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  const row = (name) => lines.findIndex((l) => l.startsWith(`  ${name}  `));
  assert.ok(row("PHASES.md.prev") >= 0 && row(BACKUP) >= 0 && row(ORIGINAL) >= 0 && row(legacyName) >= 0, r.out);
  assert.ok(row("PHASES.md.prev") < row(BACKUP) && row(BACKUP) < row(ORIGINAL) && row(ORIGINAL) < row(legacyName), "newest first");
  assert.ok(lines[row("PHASES.md.prev")].includes(`${P1.length} bytes`));
  assert.ok(lines[row("PHASES.md.prev")].includes("2026-01-03 09:05"));
  assert.ok(lines[row(ORIGINAL)].includes(`${P0.length} bytes`));
  assert.ok(lines[row(ORIGINAL)].includes(`${P0.toString("utf8").split("\n").length - 1} line(s)`));
  assert.ok(lines[row(BACKUP)].includes("2026-01-02 11:30"));
  assert.ok(lines[row(legacyName)].includes("legacy"));
  assert.ok(!lines[row(ORIGINAL)].includes("legacy"));
  assert.ok(lines[row(legacyName)].includes("2 line(s)"));
  assert.ok(!r.out.includes(p.dir));
});

test("restore: a plan prints the lines and writes nothing", () => {
  const { p, P0 } = sequence();
  const names = () => [readdirSync(p.dir).sort(), kept(p)];
  const before = names();
  const current = bytes(p.file);
  const r = restore(p, ["--from", "original"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /restore plan for PHASES\.md from PHASES\.md\.original: nothing is written without --write/);
  assert.ok(r.out.includes(`    + ${P0.toString("utf8").split("\n").find((l) => l.startsWith("| # | Phase | State"))}`), "the old header comes back");
  assert.ok(r.out.includes(`    - ${MARKER}`));
  assert.match(r.out, /summary: \d+ line\(s\) would change \(\d+ removed, \d+ added\)/);
  same(bytes(p.file), current);
  assert.deepEqual(names(), before);
  assert.equal(restore(p, ["--from", "prev"]).code, 0);
  assert.deepEqual(names(), before);
});

test("restore --write: from original, prev and a dated name each give exactly that copy's bytes; each restore saves the file first, so a second restore undoes the first", () => {
  const { p, P0, P1, P2 } = sequence();
  const tick = clock(10);
  const w = (from) => restore(p, ["--from", from, "--write"], { now: tick });
  let r = w("original");
  assert.equal(r.code, 0, r.err);
  same(bytes(p.file), P0);
  assert.match(r.out, /saved PHASES\.md\.before-restore-20260102-030410 in \.roadmap-backups\/ first/);
  assert.match(r.out, /restored PHASES\.md from PHASES\.md\.original/);
  same(keptBytes(p, "PHASES.md.before-restore-20260102-030410"), P2, "the file as it was before the restore");
  // undo
  r = w("PHASES.md.before-restore-20260102-030410");
  assert.equal(r.code, 0, r.err);
  same(bytes(p.file), P2, "the second restore undid the first");
  same(keptBytes(p, "PHASES.md.before-restore-20260102-030411"), P0);
  r = w("prev");
  assert.equal(r.code, 0, r.err);
  same(bytes(p.file), P1);
  r = w(BACKUP);
  assert.equal(r.code, 0, r.err);
  same(bytes(p.file), P0);
  same(keptBytes(p, ORIGINAL), P0, "the original never changed");
  same(keptBytes(p, "PHASES.md.prev"), P1, "restore does not touch .prev");
  assert.deepEqual(leftovers(p), []);
});

test("restore --write: a byte-identical choice says nothing to restore and writes nothing", () => {
  const p = project(STANDARD);
  assert.equal(setStatus(p, "3", "parked").code, 0);
  assert.equal(setStatus(p, "3", "parked").code, 0);
  const before = [readdirSync(join(p.dir, BDIR)).sort(), bytes(p.file)];
  const r = restore(p, ["--from", "prev", "--write"], { now: clock() });
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to restore: PHASES\.md\.prev is identical to PHASES\.md/);
  assert.deepEqual(readdirSync(join(p.dir, BDIR)).sort(), before[0]);
  same(bytes(p.file), before[1]);
});

test("restore: legacy copies beside the file are listed and restorable by name", () => {
  const p = project(MESSY);
  const legacy = "PHASES.md.bak-20250101-000000";
  writeFileSync(join(p.dir, legacy), STANDARD);
  assert.ok(restore(p, []).out.split("\n").some((l) => l.includes(legacy) && l.includes("legacy")), "the legacy copy is listed and marked legacy");
  const r = restore(p, ["--from", legacy, "--write"], { now: NOW });
  assert.equal(r.code, 0, r.err);
  assert.equal(p.read(), STANDARD);
  same(keptBytes(p, "PHASES.md.before-restore-20260102-030405"), Buffer.from(MESSY));
  same(keptBytes(p, ORIGINAL), Buffer.from(MESSY), "restoring counts as a write: the original is kept first");
  assert.equal(readFileSync(join(p.dir, legacy), "utf8"), STANDARD, "the legacy copy stays where it was");
});

test("restore: names with a slash, a backslash or .. are a usage error; an unknown name, an unreadable copy and a file outside --root exit 2 and write nothing", () => {
  const { p } = sequence();
  const before = [readdirSync(p.dir).sort(), kept(p), bytes(p.file)];
  const check = () => { assert.deepEqual([readdirSync(p.dir).sort(), kept(p)], before.slice(0, 2)); same(bytes(p.file), before[2]); };
  for (const bad of ["../PHASES.md", "sub/x", "sub\\x", "..", "a..b", "/etc/passwd", "C:\\x", ""]) {
    const r = restore(p, ["--from", bad, "--write"], { now: clock() });
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.err, /--from takes original, prev, or a backup name/);
    check();
  }
  const unknown = restore(p, ["--from", "PHASES.md.bak-20990101-000000", "--write"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /there is no backup named/);
  assert.equal(restore(p, ["--from", "PHASES.md.prev.tmp-1"]).code, 2, "only listed names count");
  assert.equal(restore(p, ["--from", ".gitignore"]).code, 2);
  assert.equal(restore(p, ["--write"]).code, 2, "--write needs --from");
  assert.equal(run(["restore", p.file, "--from", "prev", "--from", "original"]).code, 2);
  check();
  const elsewhere = tmp();
  for (const argv of [["restore", p.file, "--root", elsewhere], ["restore", p.file, "--root", elsewhere, "--from", "original", "--write"]]) {
    const r = run(argv);
    assert.equal(r.code, 2);
    assert.match(r.err, /outside the --root folder/);
  }
  assert.deepEqual(readdirSync(elsewhere), []);
  check();
  // A copy that is not valid UTF-8 is refused before anything is written.
  writeFileSync(join(p.dir, BDIR, "PHASES.md.prev"), Buffer.from([0x23, 0xff, 0xfe, 0x0a]));
  const bad = restore(p, ["--from", "prev", "--write"], { now: clock() });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /not valid UTF-8/);
  assert.deepEqual(readdirSync(p.dir).sort(), before[0]);
  same(bytes(p.file), before[2]);
  assert.equal(run(["restore", join(p.dir, "gone.md")]).code, 2);
});

test("restore: a backup that is a symlink is not listed and cannot be restored (skipped where symlinks cannot be made)", (t) => {
  const p = project(STANDARD);
  const secret = join(tmp(), "other.md");
  writeFileSync(secret, "not a roadmap backup\n");
  mkdirSync(join(p.dir, BDIR));
  try { symlinkSync(secret, join(p.dir, BDIR, "PHASES.md.prev"), "file"); } catch { t.skip("this platform did not allow a symlink"); return; }
  assert.equal(restore(p, []).out, "no backups yet");
  assert.equal(restore(p, ["--from", "prev", "--write"]).code, 2);
  assert.equal(p.read(), STANDARD);
});

// ── backups, second round: atomic copies, the folder as an argument, names, modes, retries ──
const CHANGED_MESSAGE = "the roadmap changed while it was being written; nothing was changed, run again";
const NAMES_ONLY = (p) => [readdirSync(p.dir).sort(), kept(p)];
// Same length, different bytes: the first "#" becomes "$".
const flip = (b) => { const c = Buffer.from(b); c[c.indexOf(0x23)] = 0x24; return c; };

test("changed while writing: an edit of the SAME length is caught for set, standardize --write and restore --write", () => {
  const a = project(STANDARD);
  const aBefore = bytes(a.file);
  const aEdit = flip(aBefore);
  assert.equal(aEdit.length, aBefore.length);
  assert.ok(!aEdit.equals(aBefore));
  const r1 = setStatus(a, "2", "shipped", { beforeRename: () => writeFileSync(a.file, aEdit) });
  assert.equal(r1.code, 1);
  assert.equal(r1.err, CHANGED_MESSAGE);
  same(bytes(a.file), aEdit, "the other writer's bytes are still there");
  assert.deepEqual(leftovers(a), []);

  const b = project(STANDARD);
  const bEdit = flip(bytes(b.file));
  const r2 = setStatus(b, "2", "shipped", { beforeRename: (stage) => { if (stage === "roadmap") writeFileSync(b.file, bEdit); } });
  assert.equal(r2.code, 1);
  assert.equal(r2.err, CHANGED_MESSAGE);
  same(bytes(b.file), bEdit);

  const c = project(FIXABLE);
  const cEdit = flip(bytes(c.file));
  const r3 = run(["standardize", c.file, ...OVERRIDES, "--write"], { now: NOW, beforeRename: () => writeFileSync(c.file, cEdit) });
  assert.equal(r3.code, 1);
  assert.equal(r3.err, CHANGED_MESSAGE);
  same(bytes(c.file), cEdit);

  const d = project(STANDARD);
  assert.equal(setStatus(d, "3", "parked").code, 0);
  const dEdit = flip(bytes(d.file));
  const r4 = run(["restore", d.file, "--from", "original", "--write"], { now: NOW, beforeRename: () => writeFileSync(d.file, dEdit) });
  assert.equal(r4.code, 1);
  assert.equal(r4.err, CHANGED_MESSAGE);
  same(bytes(d.file), dEdit);
  assert.deepEqual(leftovers(d), []);
});

test("changed while reading: the .original holds the bytes READ at the start, and the command stops, whatever the file becomes right after the read", () => {
  const injected = `${STANDARD}\n<!-- somebody else edited this -->\n`;
  const a = project(STANDARD);
  const aFirst = bytes(a.file);
  const r1 = setStatus(a, "3", "parked", { afterLoad: () => writeFileSync(a.file, injected) });
  assert.equal(r1.code, 1);
  assert.equal(r1.err, CHANGED_MESSAGE);
  assert.equal(a.read(), injected);
  same(keptBytes(a, ORIGINAL), aFirst, "set: the first-read bytes");

  const b = project(FIXABLE);
  const bFirst = bytes(b.file);
  const r2 = run(["standardize", b.file, ...OVERRIDES, "--write"], { now: NOW, afterLoad: () => writeFileSync(b.file, injected) });
  assert.equal(r2.code, 1);
  assert.equal(r2.err, CHANGED_MESSAGE);
  assert.equal(b.read(), injected);
  same(keptBytes(b, ORIGINAL), bFirst, "standardize: the first-read bytes");
  same(keptBytes(b, BACKUP), bFirst, "and the dated copy");

  const c = project(MESSY);
  const cFirst = bytes(c.file);
  const legacy = "PHASES.md.bak-20250101-000000";
  writeFileSync(join(c.dir, legacy), STANDARD);
  const r3 = run(["restore", c.file, "--from", legacy, "--write"], { now: NOW, afterLoad: () => writeFileSync(c.file, injected) });
  assert.equal(r3.code, 1);
  assert.equal(r3.err, CHANGED_MESSAGE);
  assert.equal(c.read(), injected);
  same(keptBytes(c, ORIGINAL), cFirst, "restore: the first-read bytes");
  same(keptBytes(c, "PHASES.md.before-restore-20260102-030405"), cFirst);
});

test("a kept copy of a roadmap cannot be given as the file: set, standardize --write and restore --write exit 2, change nothing and make no nested folder", () => {
  for (const argv of [["set", "FILE", "1", "--status", "parked"], ["standardize", "FILE", "--write"], ["restore", "FILE", "--from", "prev", "--write"], ["restore", "FILE"]]) {
    const p = project(STANDARD);
    mkdirSync(join(p.dir, BDIR));
    writeFileSync(join(p.dir, BDIR, ORIGINAL), MESSY);
    writeFileSync(join(p.dir, BDIR, "PHASES.md.prev"), "older\n");
    const copy = join(p.dir, BDIR, ORIGINAL);
    const before = [NAMES_ONLY(p), bytes(copy), bytes(p.file)];
    for (const root of [[], ["--root", p.dir]]) {
      const r = run([...argv.map((a) => (a === "FILE" ? copy : a)), ...root], { now: clock() });
      assert.equal(r.code, 2, `${argv[0]}: ${r.err}`);
      assert.match(r.err, /PHASES\.md\.original is inside a \.roadmap-backups folder, which holds kept copies/);
      assert.ok(!r.err.includes(p.dir), "no absolute path");
    }
    assert.deepEqual(NAMES_ONLY(p), before[0]);
    same(bytes(copy), before[1], "the kept copy is untouched");
    same(bytes(p.file), before[2]);
    assert.ok(!existsSync(join(p.dir, BDIR, BDIR)), "no nested backup folder");
  }
  // The folder name is compared without regard to case where the file system does not tell cases apart.
  if (process.platform === "win32") {
    const p = project(STANDARD);
    mkdirSync(join(p.dir, BDIR));
    writeFileSync(join(p.dir, BDIR, "x.md"), STANDARD);
    assert.equal(run(["set", join(p.dir, BDIR.toUpperCase(), "x.md"), "1", "--status", "parked"]).code, 2);
  }
});

test("a .original is published whole: while its temp file exists the final name does not, and a kill before the link leaves no .original at all", () => {
  const p = project(STANDARD);
  const seen = [];
  const r = setStatus(p, "3", "parked", {
    beforeLink: (tmpPath, finalPath) => {
      seen.push({ name: finalPath.split(/[\\/]/).pop(), tmp: existsSync(tmpPath), tmpBytes: bytes(tmpPath), final: existsSync(finalPath), tmpName: tmpPath.split(/[\\/]/).pop() });
    },
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seen.map((s) => s.name), [".gitignore", ORIGINAL]);
  for (const s of seen) {
    assert.ok(s.tmp && !s.final, `${s.name}: the temp file exists and the final name does not yet`);
    assert.ok(s.tmpName.startsWith(`${s.name}.tmp-${process.pid}-`), s.tmpName);
  }
  same(seen[1].tmpBytes, STANDARD, "the temp file already held the whole file when it was linked");
  same(seen[0].tmpBytes, "*\n");
  same(keptBytes(p, ORIGINAL), STANDARD);
  assert.deepEqual(leftovers(p), [], "the temp names are gone");

  // A kill (here: an exception) right before the link: the final name was never there, the roadmap is untouched.
  const k = project(STANDARD);
  const boom = setStatus(k, "3", "parked", { beforeLink: (_t, finalPath) => { if (finalPath.endsWith(ORIGINAL)) throw Object.assign(new Error("killed"), { code: "EKILL" }); } });
  assert.equal(boom.code, 1);
  assert.match(boom.err, /could not keep PHASES\.md\.original \(EKILL\)/);
  assert.ok(!existsSync(join(k.dir, BDIR, ORIGINAL)), "no .original exists, partial or not");
  same(bytes(k.file), Buffer.from(STANDARD));
  // The next run simply makes it.
  assert.equal(setStatus(k, "3", "parked").code, 0);
  same(keptBytes(k, ORIGINAL), STANDARD);
  assert.ok(!existsSync(join(k.dir, BDIR, `${ORIGINAL}.incomplete`)));
});

test("a .original that appears between the check and the link is kept as it is (treated as already kept), and the temp file is removed", () => {
  const p = project(STANDARD);
  const r = setStatus(p, "3", "parked", { beforeLink: (_t, finalPath) => { if (finalPath.endsWith(ORIGINAL)) writeFileSync(finalPath, "raced in"); } });
  assert.equal(r.code, 0, r.err);
  assert.equal(keptText(p, ORIGINAL), "raced in");
  assert.ok(!r.out.includes("first version kept"), "this run did not make it");
  assert.deepEqual(leftovers(p), []);
});

test("where a link cannot be made, the copy is written under its final name between a marker and its removal; no marker and no temp file remain", () => {
  for (const linkError of ["EPERM", "ENOTSUP", "EXDEV", "EINVAL", "ENOSYS"]) {
    const p = project(STANDARD);
    const marks = [];
    const r = setStatus(p, "3", "parked", {
      linkError,
      afterMarker: (marker, finalPath) => marks.push({ name: marker.split(/[\\/]/).pop(), marker: existsSync(marker), final: existsSync(finalPath) }),
    });
    assert.equal(r.code, 0, `${linkError}: ${r.err}`);
    assert.deepEqual(marks.map((m) => m.name), [".gitignore.incomplete", `${ORIGINAL}.incomplete`]);
    for (const m of marks) assert.ok(m.marker && !m.final, `${m.name}: the marker is there before the file is`);
    same(keptBytes(p, ORIGINAL), STANDARD);
    assert.equal(keptText(p, ".gitignore"), "*\n");
    assert.deepEqual(kept(p), [".gitignore", ORIGINAL, "PHASES.md.prev"].sort(), "no marker is left");
    assert.deepEqual(leftovers(p), []);
  }
  // A dated name that exists is still refused on that path, and its marker does not stay behind.
  const q = project(FIXABLE);
  mkdirSync(join(q.dir, BDIR));
  writeFileSync(join(q.dir, BDIR, BACKUP), "mine");
  const before = bytes(q.file);
  const r = run(["standardize", q.file, ...OVERRIDES, "--write"], { now: NOW, linkError: "EPERM" });
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists; nothing was written/);
  assert.equal(keptText(q, BACKUP), "mine");
  same(bytes(q.file), before);
  assert.ok(!kept(q).some((n) => n.endsWith(".incomplete")), "the marker was removed");
});

test("a leftover .incomplete marker (an earlier copy cut short) makes every write refuse with exit 1 and nothing written; read-only commands still work", () => {
  const markers = [`${ORIGINAL}.incomplete`, "PHASES.md.bak-20260102-030405.incomplete", "PHASES.md.before-restore-20260102-030405.incomplete", ".gitignore.incomplete"];
  for (const marker of markers) {
    for (const [file, argv] of [
      [FIXABLE, ["standardize", "FILE", ...OVERRIDES, "--write"]],
      [STANDARD, ["set", "FILE", "3", "--status", "parked"]],
      [STANDARD, ["restore", "FILE", "--from", "prev", "--write"]],
    ]) {
      const p = project(file);
      mkdirSync(join(p.dir, BDIR));
      writeFileSync(join(p.dir, BDIR, ORIGINAL), "short");
      writeFileSync(join(p.dir, BDIR, "PHASES.md.prev"), "older\n");
      writeFileSync(join(p.dir, BDIR, marker), "");
      const before = [NAMES_ONLY(p), bytes(p.file)];
      const r = run(argv.map((a) => (a === "FILE" ? p.file : a)), { now: clock() });
      assert.equal(r.code, 1, `${marker} ${argv[0]}: ${r.err}`);
      assert.ok(r.err.includes(`${marker} is in the .roadmap-backups folder`), r.err);
      if (marker === `${ORIGINAL}.incomplete`) assert.ok(r.err.includes("Compare PHASES.md.original with the roadmap; if it is shorter than the roadmap, different, or you are unsure, delete PHASES.md.original too (it is made again from the current roadmap), and only then delete the marker file; nothing was written"), r.err);
      else assert.ok(r.err.includes(`The cut-short copy is ${marker.slice(0, -".incomplete".length)}: delete ${marker.slice(0, -".incomplete".length)} and then delete the marker file; nothing was written`), r.err);
      assert.deepEqual(NAMES_ONLY(p), before[0], "nothing was created or removed");
      same(bytes(p.file), before[1]);
      assert.equal(keptText(p, ORIGINAL), "short", "the short copy is not touched either");
      assert.equal(run(["restore", p.file]).code, 0, "listing still works");
    }
  }
  // Once the owner has deleted the marker, writes go on; a marker of another roadmap file never blocks.
  const p = project(STANDARD);
  mkdirSync(join(p.dir, BDIR));
  writeFileSync(join(p.dir, BDIR, "Other.md.original.incomplete"), "");
  assert.equal(setStatus(p, "3", "parked").code, 0);
  rmSync(join(p.dir, BDIR, "Other.md.original.incomplete"));
  writeFileSync(join(p.dir, BDIR, `${ORIGINAL}.incomplete`), "");
  assert.equal(setStatus(p, "3", "planned").code, 1);
  rmSync(join(p.dir, BDIR, `${ORIGINAL}.incomplete`));
  assert.equal(setStatus(p, "3", "planned").code, 0);
});

test("a fallback publish that fails with something left at the final name keeps its marker: the next write refuses, and nothing is written", () => {
  const p = project(STANDARD);
  const before = bytes(p.file);
  const r = setStatus(p, "3", "parked", {
    linkError: "EPERM",
    afterMarker: (_marker, finalPath) => { if (finalPath.endsWith(ORIGINAL)) writeFileSync(finalPath, "short"); },
  });
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /could not keep PHASES\.md\.original/);
  assert.ok(existsSync(join(p.dir, BDIR, `${ORIGINAL}.incomplete`)), "the marker stays");
  assert.equal(keptText(p, ORIGINAL), "short", "the short file is untouched");
  same(bytes(p.file), before, "the roadmap is byte-identical");
  assert.ok(!kept(p).includes("PHASES.md.prev"), "no copy of the roadmap was made");
  assert.deepEqual(leftovers(p), []);
  // The next write refuses, because the marker is there.
  const again = setStatus(p, "3", "parked");
  assert.equal(again.code, 1);
  assert.match(again.err, /PHASES\.md\.original\.incomplete is in the \.roadmap-backups folder/);
  same(bytes(p.file), before);
  assert.equal(keptText(p, ORIGINAL), "short");
});

test("the in-place publish removes its marker only when nothing is left at the final name; a name that was taken before gets no marker at all", () => {
  // A dated name that is already there: no marker is made, so none can stay.
  const q = project(FIXABLE);
  mkdirSync(join(q.dir, BDIR));
  writeFileSync(join(q.dir, BDIR, BACKUP), "mine");
  const marks = [];
  const r = run(["standardize", q.file, ...OVERRIDES, "--write"], { now: NOW, linkError: "EPERM", afterMarker: (m) => marks.push(m) });
  assert.equal(r.code, 1);
  assert.ok(!marks.some((m) => m.includes(BACKUP)), "no marker was made for a name that was taken");
  assert.ok(!kept(q).some((n) => n.endsWith(".incomplete")));
  // The rule is in the code: on failure the marker goes only after a look at the final name, and the look cannot throw.
  const source = readFileSync(SCRIPT, "utf8");
  const body = source.slice(source.indexOf("function publishInPlace"), source.indexOf("// Removes a temp file this command made"));
  assert.match(body, /const made = createExclusive\(path, data\);\s*if \(!made\) \{ discard\(marker\); return null; \}/);
  assert.match(body, /try \{ if \(!lstatOrNull\(path\)\) discard\(marker\); \} catch \{[^}]*\}\s*return made;/);
  assert.equal(body.match(/discard\(marker\)/g).length, 2, "the marker is discarded after a success and after the look, nowhere else");
});

test("keepOriginal after EEXIST: a folder or a link at .original exits 1 and writes nothing; so does a file next to a .original.incomplete marker", (t) => {
  const cases = [
    ["a folder", (finalPath) => mkdirSync(finalPath), /it is not a regular file/],
    ["a link", (finalPath) => symlinkSync(join(tmp(), "elsewhere.md"), finalPath, "file"), /it is not a regular file/],
    ["a file with a marker", (finalPath) => { writeFileSync(finalPath, "short"); writeFileSync(`${finalPath}.incomplete`, ""); }, /an earlier copy of it was cut short/],
  ];
  for (const [label, plant, expected] of cases) {
    const p = project(STANDARD);
    const before = bytes(p.file);
    let planted = true;
    const r = setStatus(p, "3", "parked", {
      beforeLink: (_t, finalPath) => {
        if (!finalPath.endsWith(ORIGINAL)) return;
        try { plant(finalPath); } catch { planted = false; }
      },
    });
    if (!planted) { t.diagnostic(`${label}: this platform did not allow it`); continue; }
    assert.equal(r.code, 1, `${label}: ${r.err}`);
    assert.match(r.err, expected, label);
    assert.match(r.err, /could not keep PHASES\.md\.original/);
    same(bytes(p.file), before, `${label}: the roadmap is untouched`);
    assert.ok(!kept(p).includes("PHASES.md.prev"), `${label}: no copy was made`);
    assert.deepEqual(leftovers(p), [], label);
    if (label === "a file with a marker") assert.equal(keptText(p, ORIGINAL), "short");
  }
});

test("the recovery message names the cut-short copy: .original is compared and may be deleted too; any other marker names its own copy, not .original", () => {
  for (const [marker, copy] of [[`${ORIGINAL}.incomplete`, ORIGINAL], [".gitignore.incomplete", ".gitignore"], ["PHASES.md.bak-20260102-030405.incomplete", "PHASES.md.bak-20260102-030405"], ["PHASES.md.before-restore-20260102-030405.incomplete", "PHASES.md.before-restore-20260102-030405"]]) {
    for (const original of ["short", STANDARD.replace("planned", "parked")]) {
      const p = project(STANDARD);
      mkdirSync(join(p.dir, BDIR));
      writeFileSync(join(p.dir, BDIR, ORIGINAL), original);
      writeFileSync(join(p.dir, BDIR, marker), "");
      const r = setStatus(p, "3", "parked");
      assert.equal(r.code, 1, r.err);
      assert.ok(r.err.includes(`${marker} is in the .roadmap-backups folder`), r.err);
      if (copy === ORIGINAL) {
        assert.ok(r.err.includes("if it is shorter than the roadmap, different, or you are unsure, delete PHASES.md.original too"), r.err);
        assert.ok(r.err.includes("and only then delete the marker file"), r.err);
      } else {
        assert.ok(r.err.includes(`The cut-short copy is ${copy}`), r.err);
        assert.ok(!r.err.includes(".original"), `${marker}: .original is not mentioned: ${r.err}`);
      }
    }
  }
});

test("the byte order mark in the reader is written as an escape, not as an invisible character, and still works", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const bom = String.fromCharCode(0xFEFF);
  assert.ok(!source.includes(bom), "no literal U+FEFF in the script");
  assert.ok(source.includes("replace(/^" + String.fromCharCode(92) + "uFEFF/"), "the escape is used");
  const body = table(MIN, [["1", "one", "planned"]]);
  assert.equal(parseRoadmap(bom + body).tables[0].legacy, false);
  assert.equal(parseRoadmap(`intro\n${bom}${body}`).tables[0].legacy, true);
});

test("restore: a failure to list the backups exits 1 (like any unusable backup folder), writes nothing, and names the file by its base name", () => {
  const p = project(STANDARD);
  const before = bytes(p.file);
  for (const argv of [[], ["--from", "prev"], ["--from", "prev", "--write"]]) {
    const r = restore(p, argv, { listDir: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
    assert.equal(r.code, 1, `${argv.join(" ")}: ${r.err}`);
    assert.equal(r.err, "cannot list the backups of PHASES.md (EACCES); nothing was written");
  }
  same(bytes(p.file), before);
  assert.equal(kept(p), null, "no folder was made");
});

test("a roadmap path that cannot be resolved says 'no such file' only for a missing file; any other error gives its code", () => {
  const missing = run(["check", join(tmp(), "missing.md")]);
  assert.equal(missing.code, 2);
  assert.equal(missing.err, "cannot read missing.md: no such file");
  const source = readFileSync(SCRIPT, "utf8");
  assert.ok(source.includes('e?.code === "ENOENT" ? `cannot read ${typed}: no such file` : `cannot read ${typed} (${codeOf(e)})`'));
});

test("a short .original that is already there is trusted as a name, never written to, and never made by this tool", () => {
  const p = project(STANDARD);
  mkdirSync(join(p.dir, BDIR));
  writeFileSync(join(p.dir, BDIR, ORIGINAL), "0123456789");
  assert.equal(setStatus(p, "3", "parked").code, 0);
  assert.equal(keptText(p, ORIGINAL), "0123456789", "never overwritten");
  // Whatever way a run fails, no .original is left half made: this test's copies are all whole or absent.
  for (const stage of ["prev", "roadmap"]) {
    const q = project(STANDARD);
    setStatus(q, "3", "parked", { beforeRename: (s) => { if (s === stage) writeFileSync(q.file, `${STANDARD}\nx\n`); } });
    same(keptBytes(q, ORIGINAL), STANDARD, "whole");
  }
});

test("the files are flushed before they are published or closed", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const body = src.slice(src.indexOf("function createExclusive"), src.indexOf("function syncDir"));
  assert.ok(body.indexOf("fsyncSync(fd)") > body.indexOf("writeFileSync(fd, data)"), "flushed after the write");
  assert.ok(body.indexOf("fsyncSync(fd)") < body.indexOf("closeSync(fd)"), "and before the close");
});

test("every path that is not a plain regular .gitignore, or has other content, is dealt with before .original (no .original after a refusal)", () => {
  const p = project(STANDARD);
  mkdirSync(join(p.dir, BDIR, ".gitignore"), { recursive: true });
  assert.equal(setStatus(p, "3", "parked").code, 1);
  assert.ok(!existsSync(join(p.dir, BDIR, ORIGINAL)));
  assert.ok(!existsSync(join(p.dir, BDIR, "PHASES.md.prev")));
});

test("the roadmap's temp file lives in the backup folder; nothing named .tmp is ever next to the roadmap, at any moment of set, standardize --write or restore --write", () => {
  const watch = (p) => {
    const seen = [];
    const hook = (stage) => {
      const next = readdirSync(p.dir).sort();
      const inside = readdirSync(join(p.dir, BDIR)).sort();
      seen.push({ stage, next, inside });
    };
    return { seen, hook };
  };
  const a = project(STANDARD);
  const wa = watch(a);
  assert.equal(setStatus(a, "3", "parked", { beforeRename: wa.hook }).code, 0);
  assert.deepEqual(wa.seen.map((s) => s.stage), ["prev", "roadmap"]);
  for (const s of wa.seen) assert.deepEqual(s.next, [BDIR, "PHASES.md"].sort(), "nothing next to the roadmap but the folder");
  assert.ok(wa.seen[0].inside.some((n) => /^PHASES\.md\.prev\.tmp-\d+-[0-9a-f]{8}$/.test(n)), "the .prev temp name has a random part");
  assert.ok(wa.seen[1].inside.includes("PHASES.md.tmp"), "the roadmap's temp file is in the folder");
  assert.deepEqual(NAMES_ONLY(a)[0], [BDIR, "PHASES.md"].sort());

  const b = project(FIXABLE);
  const wb = watch(b);
  assert.equal(run(["standardize", b.file, ...OVERRIDES, "--write"], { now: NOW, beforeRename: wb.hook }).code, 0);
  assert.deepEqual(wb.seen.map((s) => s.stage), ["roadmap"]);
  assert.deepEqual(wb.seen[0].next, [BDIR, "PHASES.md"].sort());
  assert.ok(wb.seen[0].inside.includes("PHASES.md.tmp"));

  const c = project(STANDARD);
  assert.equal(setStatus(c, "3", "parked").code, 0);
  const wc = watch(c);
  assert.equal(run(["restore", c.file, "--from", "original", "--write"], { now: NOW, beforeRename: wc.hook }).code, 0);
  assert.deepEqual(wc.seen[0].next, [BDIR, "PHASES.md"].sort());
  assert.ok(wc.seen[0].inside.includes("PHASES.md.tmp"));
  assert.deepEqual(leftovers(c), []);
});

test("a stale .prev temp name from an earlier run with the same process id does not block a set", () => {
  const p = project(STANDARD);
  mkdirSync(join(p.dir, BDIR));
  writeFileSync(join(p.dir, BDIR, `PHASES.md.prev.tmp-${process.pid}`), "stale");
  const r = setStatus(p, "3", "parked");
  assert.equal(r.code, 0, r.err);
  assert.equal(keptText(p, `PHASES.md.prev.tmp-${process.pid}`), "stale", "the stale file is not ours to remove");
});

test("the 'first version kept' line is printed once by set, standardize --write and restore --write, whichever makes the .original", () => {
  const a = project(FIXABLE);
  const r1 = run(["standardize", a.file, ...OVERRIDES, "--write"], { now: NOW });
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /first version kept as PHASES\.md\.original in \.roadmap-backups\/ \(never overwritten\)/);
  const r2 = run(["standardize", a.file, "--write"], { now: clock() });
  assert.ok(!r2.out.includes("first version kept"));

  const b = project(MESSY);
  writeFileSync(join(b.dir, "PHASES.md.bak-20250101-000000"), STANDARD);
  const r3 = run(["restore", b.file, "--from", "PHASES.md.bak-20250101-000000", "--write"], { now: clock(20) });
  assert.equal(r3.code, 0, r3.err);
  assert.match(r3.out, /first version kept as PHASES\.md\.original in \.roadmap-backups\/ \(never overwritten\)/);
  const r4 = run(["restore", b.file, "--from", "original", "--write"], { now: clock() });
  assert.equal(r4.code, 0, r4.err);
  assert.ok(!r4.out.includes("first version kept"));
});

test("names: a differently-cased file argument and a link use the backup set of the real file name; a colon name is refused on Windows", (t) => {
  const p = project(STANDARD);
  if (process.platform === "win32") {
    const r = run(["set", join(p.dir, "phases.md"), "3", "--status", "parked", "--root", p.dir]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^updated PHASES\.md line/, "the printed name is the real one");
    assert.deepEqual(kept(p), [".gitignore", ORIGINAL, "PHASES.md.prev"].sort(), "one backup set, under the real name");
    const listed = run(["restore", join(p.dir, "Phases.MD"), "--root", p.dir]);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /^backups of PHASES\.md /);
    assert.ok(listed.out.includes(`  ${ORIGINAL}  `));
    const stream = run(["set", join(p.dir, "PHASES.md:evil"), "3", "--status", "planned"]);
    assert.equal(stream.code, 2);
    assert.match(stream.err, /colon in a file name is an NTFS stream name/);
    assert.deepEqual(readdirSync(p.dir).sort(), [BDIR, "PHASES.md"].sort(), "no stream and no empty file was made");
  } else {
    t.diagnostic("case-sensitive platform: the real-name behaviour is asserted instead of the case variant");
    assert.equal(setStatus(p, "3", "parked").code, 0);
    assert.deepEqual(kept(p), [".gitignore", ORIGINAL, "PHASES.md.prev"].sort());
  }
  // A link: the backup names come from the file the link points to, and the link itself stays a link.
  const q = project(STANDARD);
  try { symlinkSync(q.file, join(q.dir, "link.md"), "file"); } catch { t.diagnostic("this platform did not allow a symlink: that part is skipped"); return; }
  const r = run(["set", join(q.dir, "link.md"), "3", "--status", "parked"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^updated PHASES\.md line/);
  assert.deepEqual(kept(q), [".gitignore", ORIGINAL, "PHASES.md.prev"].sort(), "no link.md.* copies");
  assert.ok(lstatSync(join(q.dir, "link.md")).isSymbolicLink());
  assert.equal(q.read().includes("| parked |") || q.read().includes("parked"), true);
});

test("modes: the roadmap keeps its mode, copies are owner-only and the folder 0700 where the system has modes; on Windows nothing throws", () => {
  const posix = process.platform !== "win32";
  for (const mode of [0o640, 0o600, 0o664]) {
    const p = project(STANDARD);
    if (posix) chmodSync(p.file, mode);
    assert.equal(setStatus(p, "3", "parked").code, 0);
    assert.equal(run(["standardize", p.file, "--write"], { now: clock() }).code, 0, "standardize with nothing to change");
    assert.equal(run(["restore", p.file, "--from", "original", "--write"], { now: clock() }).code, 0);
    if (posix) {
      assert.equal(lstatSync(p.file).mode & 0o777, mode, "the roadmap keeps its mode");
      assert.equal(lstatSync(join(p.dir, BDIR)).mode & 0o777, 0o700);
      for (const n of kept(p)) assert.equal(lstatSync(join(p.dir, BDIR, n)).mode & 0o177, 0, `${n} has no group or other bits and is not executable`);
    }
    assert.deepEqual(leftovers(p), []);
  }
});

test("a BOM in front of the marker on the first line is allowed: the table is standard, set works and keeps the BOM; a BOM anywhere else does not count", () => {
  const body = table(MIN, [["1", "one", "planned"], ["2", "two", "shipped"]]);
  const text = `﻿${body}`;
  const parsed = parseRoadmap(text);
  assert.equal(parsed.tables[0].legacy, false);
  assert.equal(parsed.tables[0].markerLine, 1);
  assert.deepEqual(parsed.tables[0].problems, []);
  assert.equal(run(["check", writeTemp(text), "--strict"]).code, 0);
  const p = project(text);
  const r = setStatus(p, "1", "shipped");
  assert.equal(r.code, 0, r.err);
  const after = bytes(p.file);
  assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf], "the BOM is kept");
  assert.equal(toReadJson(parseRoadmap(p.read()), "x").tables[0].phases[0].status, "shipped");
  same(keptBytes(p, ORIGINAL), Buffer.from(text), "the .original has the BOM too");
  // not the first line: legacy
  assert.equal(parseRoadmap(`intro\n﻿${body}`).tables[0].legacy, true);
  assert.equal(parseRoadmap(body).tables[0].legacy, false);
});

test("--from matches a listed name exactly: a case variant of a dated name, of original or of prev is a usage error (exit 2) and writes nothing", () => {
  const { p } = sequence();
  const before = [NAMES_ONLY(p), bytes(p.file)];
  for (const bad of [BACKUP.toLowerCase(), BACKUP.replace("PHASES.md", "phases.md"), "Original", "ORIGINAL", "Prev", "PHASES.MD.ORIGINAL", "phases.md.prev"]) {
    for (const extra of [[], ["--write"]]) {
      const r = restore(p, ["--from", bad, ...extra], { now: clock() });
      assert.equal(r.code, 2, `${bad} ${extra}: ${r.err}`);
    }
  }
  assert.deepEqual(NAMES_ONLY(p), before[0]);
  same(bytes(p.file), before[1]);
  assert.equal(restore(p, ["--from", BACKUP]).code, 0, "the exact name works");
});

test("rename retry: on Windows a refused rename is retried up to 10 times after the same check, waiting 10..100 ms; elsewhere it is not retried", () => {
  const eperm = (code = "EPERM") => Object.assign(new Error("refused"), { code });
  // fails twice, then succeeds
  let calls = 0;
  const waits = [];
  let rechecks = 0;
  const flaky = () => { if (++calls <= 2) throw eperm(); };
  assert.equal(renameWithRetry("a", "b", () => { rechecks++; return true; }, { rename: flaky, platform: "win32", wait: (ms) => waits.push(ms) }), null);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(rechecks, 2, "the file was checked before each retry");
  // other codes that count
  for (const code of ["EACCES", "EBUSY"]) {
    let n = 0;
    assert.equal(renameWithRetry("a", "b", () => true, { rename: () => { if (++n < 2) throw eperm(code); }, platform: "win32", wait: () => {} }), null, code);
    assert.equal(n, 2);
  }
  // fails for good: 1 try + 10 retries, then the code
  calls = 0;
  waits.length = 0;
  rechecks = 0;
  const hopeless = () => { calls++; throw eperm(); };
  assert.deepEqual(renameWithRetry("a", "b", () => { rechecks++; return true; }, { rename: hopeless, platform: "win32", wait: (ms) => waits.push(ms) }), { code: "EPERM" });
  assert.equal(calls, 11);
  assert.deepEqual(waits, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(rechecks, 10);
  // the file changes: stop at once, report it, no more tries
  calls = 0;
  assert.deepEqual(renameWithRetry("a", "b", () => false, { rename: hopeless, platform: "win32", wait: () => {} }), { changed: true });
  assert.equal(calls, 1);
  // another error is not retried
  calls = 0;
  assert.deepEqual(renameWithRetry("a", "b", () => true, { rename: () => { calls++; throw eperm("ENOENT"); }, platform: "win32", wait: () => { throw new Error("must not wait"); } }), { code: "ENOENT" });
  assert.equal(calls, 1);
  // not Windows: one try
  calls = 0;
  assert.deepEqual(renameWithRetry("a", "b", () => { throw new Error("must not recheck"); }, { rename: hopeless, platform: "linux", wait: () => { throw new Error("must not wait"); } }), { code: "EPERM" });
  assert.equal(calls, 1);
});

test("rename retry, through the commands: a rename refused once per target still gives a finished set; a refused-for-good rename fails closed; a change during a wait is caught", () => {
  const failOncePerTarget = () => { const done = new Set(); return (a, b) => { if (!done.has(b)) { done.add(b); throw Object.assign(new Error("refused"), { code: "EPERM" }); } renameSync(a, b); }; };
  const p = project(STANDARD);
  const r = setStatus(p, "3", "parked", { rename: failOncePerTarget(), platform: "win32", wait: () => {} });
  assert.equal(r.code, 0, r.err);
  assert.equal(toReadJson(parseRoadmap(p.read()), "x").tables[0].phases[2].status, "parked");
  same(keptBytes(p, "PHASES.md.prev"), STANDARD);
  assert.deepEqual(leftovers(p), []);

  const q = project(STANDARD);
  const refused = setStatus(q, "3", "parked", { rename: () => { throw Object.assign(new Error("refused"), { code: "EBUSY" }); }, platform: "win32", wait: () => {} });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /could not keep PHASES\.md\.prev \(EBUSY\); nothing was written\. PHASES\.md was not changed/);
  same(bytes(q.file), Buffer.from(STANDARD));
  assert.deepEqual(leftovers(q), []);

  const s = project(STANDARD);
  const injected = `${STANDARD}\n<!-- changed during the wait -->\n`;
  const caught = setStatus(s, "3", "parked", { rename: () => { throw Object.assign(new Error("refused"), { code: "EPERM" }); }, platform: "win32", wait: () => writeFileSync(s.file, injected) });
  assert.equal(caught.code, 1);
  assert.equal(caught.err, CHANGED_MESSAGE);
  assert.equal(s.read(), injected);
  assert.deepEqual(leftovers(s), []);

  const t = project(FIXABLE);
  const std = run(["standardize", t.file, ...OVERRIDES, "--write"], { now: NOW, rename: () => { throw Object.assign(new Error("refused"), { code: "EACCES" }); }, platform: "win32", wait: () => {} });
  assert.equal(std.code, 1);
  assert.match(std.err, /could not replace PHASES\.md \(EACCES\)\. PHASES\.md was not changed/);
  same(bytes(t.file), Buffer.from(FIXABLE));
});

// ── git ─────────────────────────────────────────────────────────────────────
const hasGit =spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
test("git: the backup folder never shows up in git status and git add -A stages nothing from it", { skip: hasGit ? false : "git is not installed on this machine" }, () => {
  const p = project(FIXABLE);
  const git = (...args) => spawnSync("git", ["-c", "user.name=test", "-c", "user.email=nobody", "-c", "commit.gpgsign=false", ...args], { cwd: p.dir, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", "PHASES.md").status, 0);
  assert.equal(git("commit", "-q", "-m", "first").status, 0);
  assert.equal(run(["standardize", p.file, ...OVERRIDES, "--write"], { now: NOW }).code, 0);
  assert.equal(setStatus(p, "3", "parked").code, 0);
  assert.ok(kept(p).length >= 4, "the folder holds the copies");
  const status = git("status", "--porcelain");
  assert.equal(status.status, 0);
  assert.ok(!status.stdout.includes(BDIR), `git lists nothing from the folder: ${status.stdout}`);
  assert.ok(status.stdout.includes("PHASES.md"), "the roadmap itself shows as modified");
  assert.equal(git("add", "-A").status, 0);
  const staged = git("diff", "--cached", "--name-only").stdout;
  assert.ok(!staged.includes(BDIR), `nothing staged from the folder: ${staged}`);
  assert.ok(staged.includes("PHASES.md"));
  const ignored = git("status", "--porcelain", "--ignored").stdout;
  assert.ok(ignored.includes(`!! ${BDIR}/`), `the folder is ignored: ${ignored}`);
});

// ── the whole run ───────────────────────────────────────────────────────────
test("no message of any command above contained an absolute path to a temp folder", () => {
  assert.ok(TRANSCRIPT.length > 100, "the transcript is not empty");
  const dirs = scratch.flatMap((d) => { try { return [d, realpathSync.native(d)]; } catch { return [d]; } });
  for (const line of TRANSCRIPT) {
    for (const d of dirs) assert.ok(!line.includes(d), "a temp folder path was printed");
    assert.doesNotMatch(line, /[A-Za-z]:[\\/](Users|Windows|Temp)|(^|\s)\/(tmp|var|home|Users)\//i);
  }
});
