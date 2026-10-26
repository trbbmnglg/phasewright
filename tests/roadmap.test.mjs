// Run with: node --test tests/roadmap.test.mjs
// Covers plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs: the reader, the check, standardize and set.
// The fixtures in tests/fixtures/roadmap are synthetic. Every file a test writes goes to a temp folder that the
// test makes and removes (the roadmap files there are named PHASES.md, like a real project's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoadmap, checkRoadmap, planStandardize, setPhase, mapStatus, toReadJson, STATUSES, MARKER, main } from "../plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs";

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
function run(argv, extra = {}) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), ...extra });
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
  assert.deepEqual(readdirSync(p.dir).sort(), [BACKUP, "PHASES.md"].sort(), "the only new file is the backup (the .tmp is gone)");
  assert.equal(readFileSync(join(p.dir, BACKUP), "utf8"), MESSY, "the backup has the original bytes");
  assert.notEqual(p.read(), MESSY);
  assert.match(r.out, new RegExp(`backup: ${BACKUP.replace(/\./g, "\\.")}`));
  assert.match(r.out, /wrote PHASES\.md: \d+ line\(s\) changed or added/);
  for (const text of [r.out, r.err]) {
    assert.ok(!text.includes(p.dir), "the temp folder path was printed");
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|(^|\s)\/(tmp|var|home|Users)\b/);
  }
});

test("standardize --write: refuses when the backup name exists, and changes nothing", () => {
  const p = project(MESSY);
  writeFileSync(join(p.dir, BACKUP), "keep me");
  const r = run(["standardize", p.file, "--root", p.dir, "--table", "2", "--write"], { now: NOW });
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists; nothing was written/);
  assert.equal(readFileSync(join(p.dir, BACKUP), "utf8"), "keep me");
  assert.equal(p.read(), MESSY);
});

test("standardize --write: refuses when a .tmp file is already there, and the file stays as it was", () => {
  const p = project(MESSY);
  writeFileSync(join(p.dir, "PHASES.md.tmp"), "somebody's file");
  const r = run(["standardize", p.file, "--table", "2", "--write"], { now: NOW });
  assert.equal(r.code, 1);
  assert.match(r.err, /PHASES\.md\.tmp already exists/);
  assert.equal(p.read(), MESSY);
  assert.equal(readFileSync(join(p.dir, "PHASES.md.tmp"), "utf8"), "somebody's file");
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
  assert.deepEqual(readdirSync(p.dir).sort(), [BACKUP, "PHASES.md"].sort(), "no second backup");
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
  assert.equal(readFileSync(join(crlf.dir, BACKUP), "utf8"), toCrlf(FIXABLE));

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
test("set: changes only the one row, all other lines are identical, and no .tmp is left", () => {
  const p = project(STANDARD);
  const r = run(["set", p.file, "3", "--status", "In Progress", "--commit", "a1b2c3d", "--actual", "1.5", "--plan-file", "plans/three.md", "--note", "a | b", "--root", p.dir]);
  assert.equal(r.code, 0, r.err);
  const was = STANDARD.split("\n");
  const now = p.read().split("\n");
  assert.equal(now.length, was.length);
  const changed = now.map((l, i) => i).filter((i) => now[i] !== was[i]);
  assert.deepEqual(changed, [17], "only the line of id 3 changed");
  assert.deepEqual(readdirSync(p.dir), ["PHASES.md"]);
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

test("set: keeps CRLF line endings and the last-newline state, and refuses an existing .tmp", () => {
  const crlf = project(toCrlf(STANDARD));
  assert.equal(run(["set", crlf.file, "2", "--status", "shipped"]).code, 0);
  assert.equal(crlf.read().replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(crlf.read().length - toCrlf(STANDARD).length, "shipped".length - "in progress".length);
  const bare = project(STANDARD.replace(/\n$/, ""));
  assert.equal(run(["set", bare.file, "1", "--note", "x"]).code, 0);
  assert.equal(bare.read().endsWith("\n"), false);

  const p = project(STANDARD);
  writeFileSync(join(p.dir, "PHASES.md.tmp"), "other");
  const r = run(["set", p.file, "1", "--status", "parked"]);
  assert.equal(r.code, 1);
  assert.equal(p.read(), STANDARD);
  assert.equal(readFileSync(join(p.dir, "PHASES.md.tmp"), "utf8"), "other");
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
  const names = readdirSync(p.dir);
  assert.equal(names.length, 2, "only the backup was added next to the file");
  assert.ok(names.some((n) => /^PHASES\.md\.bak-\d{8}-\d{6}$/.test(n)));
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

test("the script never writes anywhere but the roadmap file's own folder: its writes name only the file, the .tmp and the backup", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const writes = [...src.matchAll(/\b(writeFileSync|copyFileSync|renameSync|rmSync)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
  for (const w of writes) assert.match(w, /\btmp\b|\bpath\b|\bbackup\b|f\.path/, w);
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
