// Run with: node --test tests/
// The use-case-discovery exporter: backlog.json (version 1) to Jira and Azure Boards import files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InputError, azureGroups, buildAzure, buildJira, csvCell, guardCell, orderItems, parseArgs, run, splitAzure, validateBacklog,
} from "../skills/use-case-discovery/scripts/backlog-to-csv.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "skills/use-case-discovery/scripts/backlog-to-csv.mjs");

const sample = () => ({
  version: 1,
  topic: "Weekly release note",
  items: [
    { id: "EP1", type: "epic", title: "Produce the weekly release note", description: "Use case UC1." },
    {
      id: "US1", type: "story", parent: "EP1", title: "Flag changes, with \"quotes\", and commas",
      description: "As a release lead, I want a flag.\n\nSecond paragraph <b>& more</b>.",
      acceptanceCriteria: ["Scenario: A\nGiven x\nWhen y\nThen z", "Scenario: B\nGiven p\nThen q"],
      priority: 2, tags: ["release note", "automation"], trace: ["UC1", "PP1", "E4"],
    },
    { id: "US2", type: "story", parent: "EP1", title: "=HYPERLINK(\"http://example.com\")" },
    { id: "US3", type: "story", title: "A story with no epic", tags: ["a"] },
  ],
});

// A strict reader for the files this script writes: every field quoted, CRLF between rows.
function readCsv(text) {
  assert.ok(text.endsWith("\r\n"), "ends with CRLF");
  const rows = [];
  let row = [];
  let i = 0;
  while (i < text.length) {
    assert.equal(text[i], '"', `field starts with a quote at ${i}`);
    let cell = "";
    i++;
    for (;;) {
      assert.ok(i < text.length, "unterminated field");
      if (text[i] === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        i++;
        break;
      }
      cell += text[i++];
    }
    row.push(cell);
    if (text[i] === ",") i++;
    else if (text.startsWith("\r\n", i)) { rows.push(row); row = []; i += 2; } else assert.fail(`unexpected character after a field at ${i}`);
  }
  return rows;
}
const tmp = () => mkdtempSync(join(tmpdir(), "zork-ucd-"));
const bad = (data) => { try { validateBacklog(data); } catch (e) { assert.ok(e instanceof InputError); return e.problems.join(" | "); } assert.fail("expected a validation error"); };

test("use-case-discovery csv: a cell is always quoted, with a doubled quote and line breaks kept", () => {
  assert.equal(csvCell("plain"), '"plain"');
  assert.equal(csvCell('a, "b"\nc'), '"a, ""b""\nc"');
  assert.equal(csvCell(""), '""');
});

test("use-case-discovery csv: a cell that could run as a formula gets a single quote in front", () => {
  for (const s of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", "\nx", "\n=x", "  =x", "＝x", "＋x", "－x", "＠x"]) assert.equal(guardCell(s), `'${s}`, JSON.stringify(s));
  for (const s of ["As a user", "<p>ok</p>", "a=b", "1-2", ""]) assert.equal(guardCell(s), s, JSON.stringify(s));
});

test("use-case-discovery csv: the example in references/outputs.md is a valid backlog.json", () => {
  const md = readFileSync(join(REPO, "skills/use-case-discovery/references/outputs.md"), "utf8");
  const m = /```json\n([\s\S]*?)\n```/.exec(md);
  assert.ok(m, "a json block");
  const { items } = validateBacklog(JSON.parse(m[1]));
  assert.equal(items.length, 2);
});

test("use-case-discovery csv: validation rejects each kind of bad input and lists several problems at once", () => {
  assert.match(bad({ version: 2, items: sample().items }), /"version" must be 1/);
  assert.match(bad({ ...sample(), extra: 1 }), /unknown field "extra"/);
  assert.match(bad({ version: 1, items: [] }), /1 to 2000/);
  assert.match(bad([]), /one JSON object/);
  const d = (f) => { const x = sample(); f(x.items); return x; };
  assert.match(bad(d((i) => { i[1].id = "EP1"; })), /duplicate id/);
  assert.match(bad(d((i) => { i[1].id = "has space"; })), /"id" must be letters/);
  assert.match(bad(d((i) => { i[1].type = "task"; })), /"type" must be/);
  assert.match(bad(d((i) => { i[1].parent = "US3"; })), /is not an epic/);
  assert.match(bad(d((i) => { i[1].parent = "NOPE"; })), /not in the file/);
  assert.match(bad(d((i) => { i[0].parent = "EP1"; })), /an epic has no parent/);
  assert.match(bad(d((i) => { i[0].acceptanceCriteria = ["x"]; })), /an epic carries no acceptanceCriteria/);
  assert.match(bad(d((i) => { i[1].priority = 5; })), /"priority"/);
  assert.match(bad(d((i) => { i[1].priority = 1.5; })), /"priority"/);
  assert.match(bad(d((i) => { i[1].tags = ["a,b"]; })), /"tags"/);
  assert.match(bad(d((i) => { i[1].tags = ["a;b"]; })), /"tags"/);
  assert.match(bad(d((i) => { i[1].title = "x".repeat(256); })), /"title"/);
  assert.match(bad(d((i) => { i[1].title = "two\nlines"; })), /"title"/);
  assert.match(bad(d((i) => { i[1].description = "bell\u0007"; })), /"description"/);
  assert.match(bad(d((i) => { i[1].description = "flip‮text"; })), /"description"/);
  assert.match(bad(d((i) => { i[1].unknown = 1; })), /unknown field "unknown"/);
  assert.match(bad(d((i) => { i[1].trace = ["bad id"]; })), /"trace"/);
  const many = d((i) => { for (const x of i) x.type = "task"; });
  assert.ok(bad(many).split(" | ").length >= 4, "several problems in one message");
});

test("use-case-discovery csv: Jira file has numbered ids, parents, repeated Label columns and the discovery trace", () => {
  const rows = readCsv(buildJira(sample().items));
  assert.deepEqual(rows[0], ["Work item ID", "Work type", "Summary", "Description", "Parent", "Label", "Label"]);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r[0]).slice(1), ["1", "2", "3", "4"], "sequential ids");
  assert.deepEqual(rows.slice(1).map((r) => r[1]), ["Epic", "Story", "Story", "Story"]);
  const us1 = rows[2];
  assert.equal(us1[2], 'Flag changes, with "quotes", and commas');
  assert.equal(us1[4], "1", "parent is the epic's work item id");
  assert.deepEqual(us1.slice(5), ["release-note", "automation"], "spaces in a label become hyphens");
  assert.match(us1[3], /^As a release lead, I want a flag\.\n\nSecond paragraph <b>& more<\/b>\./);
  assert.match(us1[3], /Acceptance criteria:\nScenario: A\nGiven x\nWhen y\nThen z\n\nScenario: B/);
  assert.match(us1[3], /Discovery ID: US1\. Trace: UC1, PP1, E4\.$/);
  assert.equal(rows[3][2], "'=HYPERLINK(\"http://example.com\")", "formula guard");
  assert.equal(rows[4][4], "", "a story with no epic has no parent");
  assert.deepEqual(rows[4].slice(5), ["a", ""], "short rows are padded to the label count");
});

test("use-case-discovery csv: Azure file nests stories under their epic with an empty ID column", () => {
  const [file] = buildAzure(sample().items, { process: "agile" });
  const rows = readCsv(file);
  assert.deepEqual(rows[0], ["ID", "Work Item Type", "Title 1", "Title 2", "Description", "Priority", "Tags"]);
  assert.deepEqual(rows.slice(1).map((r) => [r[0], r[1], r[2] !== "", r[3] !== ""]), [
    ["", "Epic", true, false],
    ["", "User Story", false, true],
    ["", "User Story", false, true],
    ["", "User Story", true, false],
  ]);
  assert.equal(rows[2][3], 'Flag changes, with "quotes", and commas');
  assert.equal(rows[2][5], "2");
  assert.equal(rows[2][6], "release note; automation", "tags are separated by a semicolon");
  assert.equal(rows[3][3], "'=HYPERLINK(\"http://example.com\")");
  assert.match(rows[2][4], /^<p>As a release lead, I want a flag\.<\/p><p>Second paragraph &lt;b&gt;&amp; more&lt;\/b&gt;\.<\/p><p><strong>Acceptance criteria<\/strong><\/p><p>Scenario: A<br>Given x<br>When y<br>Then z<\/p>/);
  assert.match(rows[2][4], /<p>Discovery ID: US1\. Trace: UC1, PP1, E4\.<\/p>$/);
});

test("use-case-discovery csv: the process sets the story type for Azure Boards", () => {
  const type = (proc) => readCsv(buildAzure(sample().items, { process: proc })[0])[2][1];
  assert.equal(type("agile"), "User Story");
  assert.equal(type("scrum"), "Product Backlog Item");
  assert.equal(type("cmmi"), "Requirement");
  assert.throws(() => buildAzure(sample().items, { process: "basic" }), InputError);
});

test("use-case-discovery csv: --flat leaves out the ID column and the hierarchy, and names the epic in the story", () => {
  const rows = readCsv(buildAzure(sample().items, { flat: true })[0]);
  assert.deepEqual(rows[0], ["Work Item Type", "Title", "Description", "Priority", "Tags"]);
  assert.equal(rows.length, 5);
  assert.match(rows[2][2], /^<p>Epic: Produce the weekly release note<\/p><p>As a release lead/);
  assert.doesNotMatch(rows[4][2], /Epic:/);
});

test("use-case-discovery csv: --acceptance-column moves the criteria out of the description", () => {
  const rows = readCsv(buildAzure(sample().items, { acceptanceColumn: true })[0]);
  assert.deepEqual(rows[0], ["ID", "Work Item Type", "Title 1", "Title 2", "Description", "Acceptance Criteria", "Priority", "Tags"]);
  assert.doesNotMatch(rows[2][4], /Acceptance criteria/);
  assert.match(rows[2][5], /^<p>Scenario: A<br>Given x<br>When y<br>Then z<\/p><p>Scenario: B/);
  assert.equal(rows[1][5], "", "an epic has none");
});

test("use-case-discovery csv: the 1,000 limit splits between epics, never inside one, and an oversize epic is refused", () => {
  const epic = (n, stories) => [{ id: `E${n}`, type: "epic", title: `epic ${n}` }, ...Array.from({ length: stories }, (_, i) => ({ id: `S${n}-${i}`, type: "story", parent: `E${n}`, title: `s ${n} ${i}` }))];
  const items = [...epic(1, 599), ...epic(2, 599), ...epic(3, 10)];
  const files = splitAzure(azureGroups(items, false));
  assert.deepEqual(files.map((f) => f.length), [600, 611], "epics of 600 and 600 do not fit together; the third joins the second");
  for (const f of files) for (const it of f) if (it.parent) assert.ok(f.some((x) => x.id === it.parent), "a story stays with its epic");
  const outputs = buildAzure(items, {});
  assert.equal(outputs.length, 2);
  assert.equal(readCsv(outputs[0]).length, 1 + 600);
  assert.equal(readCsv(outputs[1]).length, 1 + 611);
  assert.throws(() => splitAzure([epic(9, 1000)]), /Split the epic/);
  const flat = buildAzure(items, { flat: true });
  assert.deepEqual(flat.map((f) => readCsv(f).length - 1), [1000, 211], "flat rows split at exactly 1,000");
});

test("use-case-discovery csv: items are ordered epic first, then its stories, then stories with no epic", () => {
  const items = sample().items;
  assert.deepEqual(orderItems([items[3], items[1], items[0], items[2]]).map((i) => i.id), ["EP1", "US1", "US2", "US3"]);
});

test("use-case-discovery csv: option parsing is strict", () => {
  assert.deepEqual(parseArgs(["--input", "a.json"]), { input: "a.json", process: "agile", flat: false, acceptanceColumn: false, help: false });
  assert.equal(parseArgs(["--input", "a.json", "--process", "scrum", "--flat", "--acceptance-column"]).process, "scrum");
  for (const args of [[], ["--input"], ["--input", "--flat"], ["--input", "a", "--input", "b"], ["--input", "a", "--process", "x"], ["--input", "a", "--bogus"], ["a.json"]]) {
    assert.throws(() => parseArgs(args), InputError, JSON.stringify(args));
  }
  assert.equal(parseArgs(["--help"]).help, true);
});

test("use-case-discovery csv: run writes both files next to the input and says what to do next", () => {
  const dir = tmp();
  try {
    const input = join(dir, "backlog.json");
    writeFileSync(input, JSON.stringify(sample()));
    let out = "";
    const code = run(["--input", input, "--process", "scrum"], { out: (s) => { out += s; }, err: (s) => assert.fail(s) });
    assert.equal(code, 0);
    assert.deepEqual(readdirSync(dir).sort(), ["azure-devops.csv", "backlog.json", "jira.csv"]);
    assert.match(out, /Read 4 items \(1 epics, 3 stories\)/);
    assert.match(out, /Azure Boards process: scrum, with parent-child rows/);
    assert.match(out, /Import three rows into a scratch project first/);
    assert.equal(readCsv(readFileSync(join(dir, "azure-devops.csv"), "utf8"))[2][1], "Product Backlog Item");
    // a second run with the same input overwrites its own files and warns about an old numbered file
    writeFileSync(join(dir, "azure-devops-2.csv"), "old");
    out = "";
    assert.equal(run(["--input", input], { out: (s) => { out += s; }, err: () => {} }), 0);
    assert.match(out, /azure-devops-2\.csv is left over from an earlier run/);
    assert.equal(readFileSync(join(dir, "azure-devops-2.csv"), "utf8"), "old", "a file this run did not write is left alone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("use-case-discovery csv: run fails closed: bad input writes nothing and exits 1", () => {
  const dir = tmp();
  try {
    const input = join(dir, "backlog.json");
    const go = (args) => { let err = ""; const code = run(args, { out: () => {}, err: (s) => { err += s; } }); return { code, err }; };
    writeFileSync(input, "{ not json");
    let r = go(["--input", input]);
    assert.equal(r.code, 1);
    assert.match(r.err, /not valid JSON/);
    writeFileSync(input, JSON.stringify({ ...sample(), version: 3 }));
    r = go(["--input", input]);
    assert.equal(r.code, 1);
    assert.match(r.err, /"version" must be 1/);
    assert.deepEqual(readdirSync(dir), ["backlog.json"], "no output file");
    r = go(["--input", join(dir, "missing.json")]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no such file/);
    r = go(["--input", join(dir, "notes.txt")]);
    assert.equal(r.code, 1);
    assert.match(r.err, /\.json file/);
    r = go(["--input", `${input}\u0001`]);
    assert.equal(r.code, 1);
    assert.match(r.err, /control character/);
    writeFileSync(input, JSON.stringify(sample()));
    assert.equal(go(["--input", input, "--process", "kanban"]).code, 1);
    // an output name that is a folder is refused before anything is written
    mkdirSync(join(dir, "azure-devops.csv"));
    r = go(["--input", input]);
    assert.equal(r.code, 1);
    assert.match(r.err, /not a regular file/);
    assert.equal(existsSync(join(dir, "jira.csv")), false, "jira.csv is not written when azure-devops.csv cannot be");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("use-case-discovery csv: a linked input or output is refused", (t) => {
  const dir = tmp();
  try {
    const real = join(dir, "real.json");
    writeFileSync(real, JSON.stringify(sample()));
    try { symlinkSync(real, join(dir, "backlog.json")); } catch { t.skip("this system does not allow symbolic links"); return; }
    let err = "";
    assert.equal(run(["--input", join(dir, "backlog.json")], { out: () => {}, err: (s) => { err += s; } }), 1);
    assert.match(err, /regular file, not a link/);
    rmSync(join(dir, "backlog.json"));
    symlinkSync(real, join(dir, "jira.csv"));
    err = "";
    assert.equal(run(["--input", real], { out: () => {}, err: (s) => { err += s; } }), 1);
    assert.match(err, /not a regular file/);
    assert.equal(readFileSync(real, "utf8"), JSON.stringify(sample()), "the link's target was not overwritten");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("use-case-discovery csv: the script runs from the command line and its output reads back", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "backlog.json"), JSON.stringify(sample()));
    const r = spawnSync(process.execPath, [SCRIPT, "--input", join(dir, "backlog.json")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Wrote: jira\.csv, azure-devops\.csv/);
    assert.equal(readCsv(readFileSync(join(dir, "jira.csv"), "utf8")).length, 5);
    const bad = spawnSync(process.execPath, [SCRIPT, "--input"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--input needs a value/);
    assert.match(spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" }).stdout, /^usage: node backlog-to-csv\.mjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
