// Run with: node --test tests/history.test.mjs
// Covers plugins/phased-shipping/skills/plan/scripts/history.mjs: record, the optional tokens field
// and stats. Always uses a temp history file, never the real ~/.claude/phased-shipping/history.jsonl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../plugins/phased-shipping/skills/plan/scripts/history.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "plugins", "phased-shipping", "skills", "plan", "scripts", "history.mjs");

// Every folder is removed by the test that made it and, if an assertion fails first, by the after hook below.
const scratch = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "history-test-")); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
// The cases call the script's main(argv, io) in this process (a node process per case is slow where this runs); the tests that say
// "real process" run the file itself, so the command line, its exit code and its output stay covered.
const node = (...args) => {
  let out = "";
  let err = "";
  const status = main(args, { out: (line) => { out += line + "\n"; }, err: (line) => { err += line + "\n"; } });
  return { status, out, err };
};
const nodeReal = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const record = (file, rec) => node("record", file, JSON.stringify(rec));
const recordReal = (file, rec) => nodeReal("record", file, JSON.stringify(rec));
const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const base = (over = {}) => ({
  project: "demo", phase: 1, kind: "mixed", est_h: 2, actual_h: 1, build_model: "sonnet",
  build_effort: "high", runs_as: "builder", check_rounds: 0, prod_first_pass: true, rolled_back: false, date: "2026-01-01",
  ...over,
});

// The same three records as lines, so the stats output can be compared with a fixed expected text.
const FIXTURE = [
  base(),
  base({ phase: 2, actual_h: 2, check_rounds: 1, prod_first_pass: false, rolled_back: true }),
  base({ phase: 3, kind: "backend", est_h: 4, actual_h: 2, build_effort: "medium", runs_as: "main", prod_first_pass: undefined, rolled_back: undefined }),
].map((r) => JSON.stringify(r)).join("\n") + "\n";

const EXPECTED_STATS = [
  "Phases recorded: 3 (3 timed)",
  "Estimate multiplier (median actual/estimate): x0.50",
  "  mixed: x0.75 over 2 phases",
  "Build model outcomes (first-pass checks / first-pass prod / rollbacks):",
  "  sonnet (high) as builder: 50% / 50% / 1 over 2",
  "  sonnet (medium) as main: 100% / 0% / 0 over 1",
  "Use the multiplier on raw estimates (show raw -> calibrated). Prefer the cheapest build model with a strong first-pass rate for that kind of work.",
  "",
].join("\n");

test("a record with tokens is saved as given", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const r = recordReal(file, base({ tokens: { builder: 120000, checker: 18000 } }));
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /recorded demo phase 1/);
  assert.deepEqual(lines(file)[0].tokens, { builder: 120000, checker: 18000 });
  rmSync(dir, { recursive: true });
});

test("a record without tokens is saved as before, with no tokens field added", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const r = record(file, base());
  assert.equal(r.status, 0, r.err);
  const [saved] = lines(file);
  assert.equal("tokens" in saved, false);
  assert.deepEqual(saved, { ...base(), v: 1 }, "the only addition is the schema version");
  rmSync(dir, { recursive: true });
});

test("actual_h is still computed from the timestamps, and --from reads a file", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const json = join(dir, "rec.json");
  const rec = base({ tokens: { shipper: 5 } });
  delete rec.actual_h;
  Object.assign(rec, { started: "2026-01-01T10:00:00Z", previewed: "2026-01-01T11:00:00Z", approved: "2026-01-01T13:00:00Z", shipped: "2026-01-01T13:30:00Z" });
  writeFileSync(json, JSON.stringify(rec));
  const r = node("record", file, "--from", json);
  assert.equal(r.status, 0, r.err);
  assert.equal(lines(file)[0].actual_h, 1.5);
  assert.deepEqual(lines(file)[0].tokens, { shipper: 5 });
  rmSync(dir, { recursive: true });
});

test("invalid tokens are rejected with a message naming the field, and nothing is written", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const cases = [
    [{ builder: -1 }, /tokens\.builder must be a non-negative integer \(got -1\)/],
    [{ builder: "lots" }, /tokens\.builder must be a non-negative integer \(got "lots"\)/],
    [{ builder: 1.5 }, /tokens\.builder must be a non-negative integer/],
    [{ janitor: 5 }, /tokens\.janitor is not a known agent \(allowed: builder, checker, shipper, model_scout, reviewer\)/],
    [[1, 2], /tokens must be an object/],
    [null, /tokens must be an object/],
    ["many", /tokens must be an object/],
  ];
  for (const [tokens, message] of cases) {
    const r = record(file, base({ tokens }));
    assert.equal(r.status, 1, JSON.stringify(tokens));
    assert.match(r.err, message);
    assert.match(r.err, /^invalid field: /);
  }
  assert.equal(existsSync(file), false);
  rmSync(dir, { recursive: true });
});

test("the old required-field check still works", () => {
  const dir = tmp();
  const r = record(join(dir, "history.jsonl"), { project: "demo", phase: 1, est_h: 1 });
  assert.equal(r.status, 1);
  assert.match(r.err, /missing field: build_model/);
  rmSync(dir, { recursive: true });
});

test("stats output for records without tokens is unchanged, with no tokens line", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  writeFileSync(file, FIXTURE);
  const r = node("stats", file);
  assert.equal(r.status, 0);
  assert.equal(r.out, EXPECTED_STATS);
  rmSync(dir, { recursive: true });
});

test("stats prints how many phases have tokens and the median agent tokens per phase", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const [a, b, c] = FIXTURE.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const withTokens = [
    { ...a, tokens: { builder: 120000, checker: 18000 } },
    b,
    { ...c, tokens: { builder: 30000, checker: 9000, shipper: 3000 } },
  ];
  writeFileSync(file, withTokens.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = node("stats", file);
  assert.equal(r.status, 0);
  assert.match(r.out, /tokens recorded on 2 of 3 phases/);
  // Totals are 138000 and 42000, so the median is 90000.
  assert.match(r.out, /Agent tokens per phase: median 90000 /);
  // Every other line is exactly what it was without tokens.
  const rest = r.out.split("\n").filter((l) => !l.startsWith("Agent tokens per phase"));
  assert.equal(rest.join("\n"), EXPECTED_STATS);
  rmSync(dir, { recursive: true });
});

test("stats with no history still says so and exits 0", () => {
  const dir = tmp();
  const r = nodeReal("stats", join(dir, "missing.jsonl")); // a real process: the exit code of the command
  assert.equal(r.status, 0);
  assert.match(r.out, /No phase history yet/);
  assert.equal(node("stats", join(dir, "missing.jsonl")).out, r.out, "the same text in this process");
  rmSync(dir, { recursive: true });
});

test("a record with a guard value is saved as given, for each of the three values", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  for (const [i, guard] of ["active", "inactive", "unknown"].entries()) {
    const r = record(file, base({ phase: i + 1, guard }));
    assert.equal(r.status, 0, r.err);
  }
  assert.deepEqual(lines(file).map((r) => r.guard), ["active", "inactive", "unknown"]);
  rmSync(dir, { recursive: true });
});

test("an invalid guard value is rejected with invalid field: guard, and nothing is written", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  for (const guard of ["maybe", "Active", true, null]) {
    const r = record(file, base({ guard }));
    assert.equal(r.status, 1, JSON.stringify(guard));
    assert.match(r.err, /^invalid field: guard must be one of active, inactive, unknown \(got /);
  }
  const maybe = record(file, base({ guard: "maybe" }));
  assert.match(maybe.err, /invalid field: guard/);
  assert.match(maybe.err, /\(got "maybe"\)/);
  assert.equal(existsSync(file), false);
  rmSync(dir, { recursive: true });
});

test("stats prints how many phases had the guard active, counting only phases that recorded it", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const [a, b, c] = FIXTURE.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(file, [{ ...a, guard: "active" }, { ...b, guard: "inactive" }, { ...c, guard: "active" }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const all = node("stats", file);
  assert.equal(all.status, 0);
  assert.match(all.out, /^Guard active on 2 of 3 phases$/m);
  // Every other line is exactly what it was without the guard field.
  assert.equal(all.out.split("\n").filter((l) => !l.startsWith("Guard active on")).join("\n"), EXPECTED_STATS);

  // Older records without the field are not counted as inactive.
  writeFileSync(file, [{ ...a, guard: "active" }, b, { ...c, guard: "unknown" }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.match(node("stats", file).out, /^Guard active on 1 of 2 phases$/m);

  // No record has the field: no line.
  writeFileSync(file, FIXTURE);
  assert.doesNotMatch(node("stats", file).out, /Guard active/);
  rmSync(dir, { recursive: true });
});

test("a valid caught_by is saved as given: [] with no rounds, one entry per round, plus one for a rollback", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  for (const [i, over] of [
    { caught_by: [] },
    { check_rounds: 1, caught_by: ["compare"] },
    { check_rounds: 1, rolled_back: true, caught_by: ["security-review", "prod-check"] },
    { check_rounds: 0, rolled_back: true, caught_by: ["prod-check"] },
  ].entries()) {
    const r = record(file, base({ phase: i + 1, ...over }));
    assert.equal(r.status, 0, r.err);
  }
  assert.deepEqual(lines(file).map((r) => r.caught_by), [[], ["compare"], ["security-review", "prod-check"], ["prod-check"]]);
  rmSync(dir, { recursive: true });
});

test("an invalid caught_by is rejected with invalid field: caught_by, and nothing is written", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const cases = [
    { check_rounds: 1, caught_by: ["luck"] },
    { check_rounds: 1, caught_by: [null] },
    { check_rounds: 1, caught_by: "compare" },
    { check_rounds: 1, caught_by: null },
    { check_rounds: 1, caught_by: [] },
    { check_rounds: 0, caught_by: ["compare"] },
    { check_rounds: 1, rolled_back: true, caught_by: ["compare"] },
  ];
  for (const over of cases) {
    const r = record(file, base(over));
    assert.equal(r.status, 1, JSON.stringify(over));
    assert.match(r.err, /^invalid field: caught_by/, JSON.stringify(over));
  }
  assert.equal(existsSync(file), false);
  rmSync(dir, { recursive: true });
});

test("a record without caught_by still loads, and stats prints no catches line for such a file", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  assert.equal(record(file, base()).status, 0);
  assert.equal("caught_by" in lines(file)[0], false);
  writeFileSync(file, FIXTURE);
  const out = node("stats", file).out;
  assert.doesNotMatch(out, /Caught by/);
  assert.doesNotMatch(out, /Conditional compare/);
  assert.equal(out, EXPECTED_STATS);
  rmSync(dir, { recursive: true });
});

test("stats counts each check, says how many phases recorded caught_by, and shows progress to 15", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const [a, b, c] = FIXTURE.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const d = { ...a, phase: 4 };
  writeFileSync(file, [
    { ...a, caught_by: [] },
    { ...b, check_rounds: 2, caught_by: ["security-review", "own-review", "prod-check"] },
    { ...c, check_rounds: 1, rolled_back: false, caught_by: ["security-review"] },
    d,
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = node("stats", file);
  assert.equal(r.status, 0);
  assert.match(r.out, /^Caught by \(phases with caught_by recorded: 3 of 4; 1 needed no fix\): builder-self 0, compare 0, own-review 1, security-review 2, browser-check 0, prod-check 1$/m);
  assert.match(r.out, /^Conditional compare needs 15 phases with caught_by recorded \(3 so far\)$/m);
  rmSync(dir, { recursive: true });
});

test("record adds v: 1, keeps a given v, and rejects a v that is not a positive integer", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  assert.equal(recordReal(file, base()).status, 0); // a real process: the command line writes v: 1
  assert.equal(lines(file)[0].v, 1);
  assert.equal(record(file, base({ phase: 2, v: 1 })).status, 0);
  assert.equal(lines(file)[1].v, 1);
  assert.equal(record(file, base({ phase: 3, v: 2 })).status, 0);
  assert.equal(lines(file)[2].v, 2);
  for (const v of [0, "1", 1.5, -1, true, [], {}]) {
    const r = record(file, base({ phase: 9, v }));
    assert.equal(r.status, 1, JSON.stringify(v));
    assert.equal(r.err.trim(), "invalid field: v must be a positive integer", JSON.stringify(v));
  }
  assert.equal(lines(file).length, 3, "a rejected record is not written");
  rmSync(dir, { recursive: true });
});

test("a history file with old lines (no v) gives the same stats as before, and mixed lines read the same", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  writeFileSync(file, FIXTURE);
  assert.equal(node("stats", file).out, EXPECTED_STATS);
  // The same records with v on every line, and on some lines only, give the same text.
  const withV = FIXTURE.split("\n").filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), v: 1 })).join("\n") + "\n";
  writeFileSync(file, withV);
  assert.equal(node("stats", file).out, EXPECTED_STATS);
  const some = FIXTURE.split("\n").filter(Boolean).map((l, i) => (i === 1 ? JSON.stringify({ ...JSON.parse(l), v: 1 }) : l)).join("\n") + "\n";
  writeFileSync(file, some);
  assert.equal(node("stats", file).out, EXPECTED_STATS);
  rmSync(dir, { recursive: true });
});

// ---------- phase 7p: reviewer tokens, timings, baseline_reused ----------
test("tokens.reviewer is accepted and counts in the agent tokens line", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const r = record(file, base({ tokens: { builder: 1000, reviewer: 500 } }));
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(lines(file)[0].tokens, { builder: 1000, reviewer: 500 });
  assert.match(node("stats", file).out, /Agent tokens per phase: median 1500 /);
  assert.equal(record(file, base({ phase: 2, tokens: { reviewer: -1 } })).status, 1);
  assert.equal(record(file, base({ phase: 2, tokens: { reviewer: 1.5 } })).status, 1);
  rmSync(dir, { recursive: true });
});

test("a record with timings and baseline_reused is saved as given", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const timings = { baseline_s: 0, checks_s: 240, review_s: 1800, full_runs: 2, fast_runs: 3, reviews: 2 };
  const r = record(file, base({ timings, baseline_reused: true }));
  assert.equal(r.status, 0, r.err);
  const [saved] = lines(file);
  assert.deepEqual(saved.timings, timings);
  assert.equal(saved.baseline_reused, true);
  // Each key is optional, and baseline_reused may be false.
  assert.equal(record(file, base({ phase: 2, timings: { full_runs: 1 }, baseline_reused: false })).status, 0);
  assert.equal(record(file, base({ phase: 3, timings: {} })).status, 0);
  rmSync(dir, { recursive: true });
});

test("invalid timings are rejected with a message naming the key, and nothing is written", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const cases = [
    [{ baseline_s: -1 }, /timings\.baseline_s must be a non-negative integer \(got -1\)/],
    [{ checks_s: 1.5 }, /timings\.checks_s must be a non-negative integer \(got 1\.5\)/],
    [{ review_s: "long" }, /timings\.review_s must be a non-negative integer \(got "long"\)/],
    [{ full_runs: null }, /timings\.full_runs must be a non-negative integer/],
    [{ fast_runs: true }, /timings\.fast_runs must be a non-negative integer/],
    [{ reviews: NaN }, /timings\.reviews must be a non-negative integer/],
    [{ wall_s: 5 }, /timings\.wall_s is not a known key \(allowed: baseline_s, checks_s, review_s, full_runs, fast_runs, reviews, ship_s\)/],
    [{ full_runs: 1, extra: 1 }, /timings\.extra is not a known key/],
    [[1, 2], /timings must be an object/],
    [null, /timings must be an object/],
    ["fast", /timings must be an object/],
  ];
  for (const [timings, message] of cases) {
    const r = record(file, base({ timings }));
    assert.equal(r.status, 1, JSON.stringify(timings));
    assert.match(r.err, /^invalid field: /);
    assert.match(r.err, message);
  }
  assert.equal(existsSync(file), false);
  rmSync(dir, { recursive: true });
});

test("baseline_reused must be a boolean", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  for (const v of ["true", 1, 0, null, [], {}]) {
    const r = record(file, base({ baseline_reused: v }));
    assert.equal(r.status, 1, JSON.stringify(v));
    assert.match(r.err, /^invalid field: baseline_reused must be true or false \(got /);
  }
  assert.equal(existsSync(file), false);
  rmSync(dir, { recursive: true });
});

test("stats prints median seconds, median full runs and reused baselines over phases that have timings", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const [a, b, c] = FIXTURE.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(file, [
    { ...a, timings: { baseline_s: 200, checks_s: 400, review_s: 1000, full_runs: 4, fast_runs: 2, reviews: 3 }, baseline_reused: false },
    { ...b, timings: { baseline_s: 0, checks_s: 100, review_s: 600, full_runs: 2, fast_runs: 3, reviews: 1 }, baseline_reused: true },
    c,
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = node("stats", file);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^Timings \(phases with timings recorded: 2 of 3\): median baseline 100 s, checks 250 s, review 800 s$/m);
  assert.match(r.out, /^Full runs per phase: median 3 \(over 2 phases with timings\)$/m);
  assert.match(r.out, /^Baselines reused 1 of 2$/m);
  // Every other line is exactly what it was without timings.
  const rest = r.out.split("\n").filter((l) => !/^(Timings|Full runs per phase|Baselines reused)/.test(l));
  assert.equal(rest.join("\n"), EXPECTED_STATS);
  // A record with some keys only: each kind is a median over the records that have it.
  writeFileSync(file, [{ ...a, timings: { full_runs: 5 } }, { ...b, timings: { review_s: 90 } }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const some = node("stats", file).out;
  assert.match(some, /^Timings \(phases with timings recorded: 2 of 2\): median review 90 s$/m);
  assert.match(some, /^Full runs per phase: median 5 \(over 1 phases with timings\)$/m);
  assert.match(some, /^Baselines reused 0 of 2$/m);
  rmSync(dir, { recursive: true });
});

test("stats with no timings prints none of the new lines, and old records are unchanged", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  writeFileSync(file, FIXTURE);
  const out = node("stats", file).out;
  assert.equal(out, EXPECTED_STATS);
  assert.doesNotMatch(out, /Timings|Full runs per phase|Baselines reused/);
  // An old record is saved exactly as before: no timings or baseline_reused field appears.
  assert.equal(record(file, base({ phase: 9 })).status, 0);
  const saved = lines(file).at(-1);
  assert.equal("timings" in saved, false);
  assert.equal("baseline_reused" in saved, false);
  // A damaged timings field in an old file is ignored by stats instead of crashing it.
  writeFileSync(file, FIXTURE.replace('"kind":"mixed"', '"timings":"x","kind":"mixed"'));
  const damaged = node("stats", file);
  assert.equal(damaged.status, 0);
  assert.doesNotMatch(damaged.out, /Timings/);
  rmSync(dir, { recursive: true });
});

// ---------- phase 7p fix round 1: ship_s, safe integers, a script reached through a link ----------
test("timings.ship_s is accepted, and stats shows the median ship seconds", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  assert.equal(record(file, base({ timings: { ship_s: 90, full_runs: 2 } })).status, 0);
  assert.equal(record(file, base({ phase: 2, timings: { ship_s: 30 } })).status, 0);
  assert.deepEqual(lines(file)[0].timings, { ship_s: 90, full_runs: 2 });
  assert.match(node("stats", file).out, /^Timings \(phases with timings recorded: 2 of 2\): median ship 60 s$/m);
  assert.equal(record(file, base({ phase: 3, timings: { ship_s: -1 } })).status, 1);
  assert.match(record(file, base({ phase: 3, timings: { ship_s: 1.5 } })).err, /timings\.ship_s must be a non-negative integer/);
  rmSync(dir, { recursive: true });
});

test("a value beyond the safe integer range is refused for timings and tokens, and stats ignores one in an old file", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  for (const big of [2 ** 53, 1e21, Number.MAX_SAFE_INTEGER + 2]) {
    const t = record(file, base({ timings: { checks_s: big } }));
    assert.equal(t.status, 1, String(big));
    assert.match(t.err, /^invalid field: timings\.checks_s must be a non-negative integer/);
    const k = record(file, base({ tokens: { builder: big } }));
    assert.equal(k.status, 1, String(big));
    assert.match(k.err, /^invalid field: tokens\.builder must be a non-negative integer/);
  }
  assert.equal(existsSync(file), false);
  assert.equal(record(file, base({ timings: { checks_s: Number.MAX_SAFE_INTEGER }, tokens: { builder: Number.MAX_SAFE_INTEGER } })).status, 0);
  // An old file with a huge value does not poison the medians.
  const [a, b] = FIXTURE.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(file, [{ ...a, timings: { checks_s: 1e21, full_runs: 2 } }, { ...b, timings: { checks_s: 100 } }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.match(node("stats", file).out, /median checks 100 s/);
  rmSync(dir, { recursive: true });
});

test("real process: the script reached through a symbolic link or junction to its folder still runs and records", (t) => {
  const dir = tmp();
  const link = join(dir, "linked-scripts");
  try { symlinkSync(dirname(SCRIPT), link, "junction"); } catch (e) { t.skip(`this OS refused to make a link (${e.code})`); return; }
  const file = join(dir, "history.jsonl");
  const r = spawnSync(process.execPath, [join(link, "history.mjs"), "record", file, JSON.stringify(base())], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^recorded demo phase 1/, "a script that runs prints its result");
  assert.equal(lines(file).length, 1, "and writes its record");
  const s = spawnSync(process.execPath, [join(link, "history.mjs"), "stats", file], { encoding: "utf8" });
  assert.match(s.stdout, /Phases recorded: 1/);
  // Remove the link itself (never its target), then check the target is still there.
  try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* left for the after hook */ } }
  assert.ok(existsSync(SCRIPT), "the real script folder was not touched");
  if (!existsSync(link)) rmSync(dir, { recursive: true, force: true });
});

// ---------- phase 7p fix round 2 ----------
test("stats counts a record as having timings only when it holds at least one valid timings value", () => {
  const dir = tmp();
  const file = join(dir, "history.jsonl");
  const [a, b, c] = FIXTURE.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(file, [
    { ...a, timings: { checks_s: 100 }, baseline_reused: true },
    { ...b, timings: {}, baseline_reused: true },
    { ...c, timings: { checks_s: -1, review_s: 1.5, unknown_key: 7, full_runs: "3", ship_s: 2 ** 60 }, baseline_reused: true },
    { ...a, phase: 4, timings: [5], baseline_reused: true },
    { ...a, phase: 5, timings: null },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = node("stats", file).out;
  assert.match(out, /^Timings \(phases with timings recorded: 1 of 5\): median checks 100 s$/m);
  assert.match(out, /^Baselines reused 1 of 1$/m, "a record with no valid value is not in the denominator or the count");
  assert.doesNotMatch(out, /Full runs per phase/);
  // With no valid value anywhere there is no timings line at all.
  writeFileSync(file, [{ ...a, timings: {}, baseline_reused: true }, { ...b, timings: { checks_s: -5 } }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.doesNotMatch(node("stats", file).out, /Timings|Baselines reused/);
  rmSync(dir, { recursive: true });
});
