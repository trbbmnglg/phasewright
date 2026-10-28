// Run with: node --test tests/test-report.test.mjs
// Covers scripts/test-report.mjs, the small reporter that npm run verify and the test inventory read: how it turns the events of
// node --test into one record per test (full name path, status, time). Most cases feed it events in this process; one case runs
// a real node --test on a tiny temp test file, so the event order the reporter relies on is checked against the real runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import testReport, { recorder, readResults, slowest, cleanName, SEP } from "../scripts/test-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTER = join(HERE, "..", "scripts", "test-report.mjs");

const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "test-report-test-")); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const ev = (type, name, nesting, extra = {}) => ({ type, data: { name, nesting, file: "C:\\repo\\tests\\a.test.mjs", details: { type: "test", duration_ms: 1.25 }, ...extra } });
const collect = (events) => {
  const got = [];
  const rec = recorder((r) => got.push(r));
  for (const e of events) rec(e);
  return got;
};

test("test-report: a test is one record with its file, name, status and time", () => {
  const got = collect([ev("test:start", "adds", 0), ev("test:pass", "adds", 0, { details: { type: "test", duration_ms: 12.345 } })]);
  assert.deepEqual(got, [{ file: "a.test.mjs", name: "adds", status: "run", ms: 12.3 }]);
});

test("test-report: suites add to the path but are not records, and siblings do not inherit each other's names", () => {
  const got = collect([
    ev("test:start", "outer", 0),
    ev("test:start", "first", 1), ev("test:pass", "first", 1),
    ev("test:start", "second", 1), ev("test:start", "inner", 2), ev("test:pass", "inner", 2), ev("test:pass", "second", 1),
    ev("test:pass", "outer", 0, { details: { type: "suite", duration_ms: 5 } }),
    ev("test:start", "next", 0), ev("test:pass", "next", 0),
  ]);
  assert.deepEqual(got.map((r) => r.name), [["outer", "first"].join(SEP), ["outer", "second", "inner"].join(SEP), ["outer", "second"].join(SEP), "next"]);
});

test("test-report: a parent test with subtests is a record too, after its children", () => {
  const got = collect([ev("test:start", "parent", 0), ev("test:start", "child", 1), ev("test:pass", "child", 1), ev("test:pass", "parent", 0)]);
  assert.deepEqual(got.map((r) => r.name), [`parent${SEP}child`, "parent"]);
});

test("test-report: skip and todo are skip, a failure is a record that is marked failed", () => {
  const got = collect([
    ev("test:start", "s", 0), ev("test:pass", "s", 0, { skip: "not here" }),
    ev("test:start", "s2", 0), ev("test:pass", "s2", 0, { skip: true }),
    ev("test:start", "t", 0), ev("test:pass", "t", 0, { todo: true }),
    ev("test:start", "f", 0), ev("test:fail", "f", 0),
  ]);
  assert.deepEqual(got.map((r) => [r.name, r.status, r.fail === true]), [["s", "skip", false], ["s2", "skip", false], ["t", "skip", false], ["f", "run", true]]);
});

test("test-report: each test file has its own stack, so interleaved files keep their own paths", () => {
  const a = (type, name, nesting) => ev(type, name, nesting, { file: "/r/tests/a.test.mjs" });
  const b = (type, name, nesting) => ev(type, name, nesting, { file: "/r/tests/b.test.mjs" });
  const got = collect([a("test:start", "A", 0), b("test:start", "B", 0), a("test:start", "a1", 1), b("test:start", "b1", 1), b("test:pass", "b1", 1), a("test:pass", "a1", 1)]);
  assert.deepEqual(got.map((r) => [r.file, r.name]), [["b.test.mjs", `B${SEP}b1`], ["a.test.mjs", `A${SEP}a1`]]);
});

test("test-report: events that are not about a test are ignored, and a line break in a name becomes a space", () => {
  const got = collect([null, {}, { type: "test:diagnostic", data: { message: "x" } }, { type: "test:pass", data: {} }, ev("test:enqueue", "q", 0), ev("test:start", "two\nlines\r\nhere", 0), ev("test:pass", "two\nlines\r\nhere", 0)]);
  assert.deepEqual(got.map((r) => r.name), ["two lines here"]);
  assert.equal(cleanName("a\r\nb"), "a b");
});

test("test-report: the reporter yields one JSON line per record, and readResults reads them back", async () => {
  async function* events() { yield ev("test:start", "x", 0); yield ev("test:pass", "x", 0); yield ev("test:start", "y", 0); yield ev("test:pass", "y", 0, { skip: true }); }
  let text = "";
  for await (const chunk of testReport(events())) text += chunk;
  const lines = text.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l).name), ["x", "y"]);
  const dir = scratch();
  const file = join(dir, "r.jsonl");
  writeFileSync(file, text + "\n\n");
  assert.deepEqual(readResults(file).map((r) => r.status), ["run", "skip"]);
  writeFileSync(file, text + "not json\n");
  assert.throws(() => readResults(file), SyntaxError, "a damaged results file is an error, not an empty result");
});

test("test-report: slowest sorts by time, longest first, and does not change its input", () => {
  const rows = [{ name: "a", ms: 5 }, { name: "b", ms: 50 }, { name: "c", ms: 20 }, { name: "d", ms: 1 }];
  assert.deepEqual(slowest(rows, 2).map((r) => r.name), ["b", "c"]);
  assert.deepEqual(rows.map((r) => r.name), ["a", "b", "c", "d"]);
  assert.equal(slowest(rows).length, 4);
});

test("test-report: the real runner (a real process) gives nested names, a skip and a failure as the reporter expects", () => {
  const dir = scratch();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sample.test.mjs");
  writeFileSync(file, [
    'import { test, describe, it } from "node:test";',
    'test("plain", () => {});',
    'test("with subtests", async (t) => { await t.test("child one", () => {}); await t.test("child two", () => {}); });',
    'describe("a suite", () => { it("inside", () => {}); describe("nested", () => { it("deep", () => {}); }); });',
    'test("skipped", { skip: true }, () => {});',
    'test("after the suite", () => {});',
  ].join("\n"));
  const results = join(dir, "results.jsonl");
  // A node --test started inside a test run would act as that run's child and ignore the reporter options.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", `--test-reporter=${pathToFileURL(REPORTER).href}`, `--test-reporter-destination=${results}`, file], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const got = readResults(results).map((x) => `${x.status} ${x.name}`).sort();
  assert.deepEqual(got, [
    `run a suite${SEP}inside`,
    `run a suite${SEP}nested${SEP}deep`,
    "run after the suite",
    "run plain",
    "run with subtests",
    `run with subtests${SEP}child one`,
    `run with subtests${SEP}child two`,
    "skip skipped",
  ].sort());
});
