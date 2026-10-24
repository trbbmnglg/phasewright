// Run with: node --test tests/history.test.mjs
// Covers plugins/phased-shipping/skills/plan/scripts/history.mjs: record, the optional tokens field
// and stats. Always uses a temp history file, never the real ~/.claude/phased-shipping/history.jsonl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "plugins", "phased-shipping", "skills", "plan", "scripts", "history.mjs");

const tmp = () => mkdtempSync(join(tmpdir(), "history-test-"));
const node = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const record = (file, rec) => node("record", file, JSON.stringify(rec));
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
  const r = record(file, base({ tokens: { builder: 120000, checker: 18000 } }));
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
  assert.deepEqual(saved, base());
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
    [{ janitor: 5 }, /tokens\.janitor is not a known agent \(allowed: builder, checker, shipper, model_scout\)/],
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
  const r = node("stats", join(dir, "missing.jsonl"));
  assert.equal(r.status, 0);
  assert.match(r.out, /No phase history yet/);
  rmSync(dir, { recursive: true });
});
