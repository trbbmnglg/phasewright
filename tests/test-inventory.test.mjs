// Run with: node --test tests/test-inventory.test.mjs
// Covers scripts/test-inventory.mjs: tests/inventory.txt lists every test by its full name and status, and --check fails when a listed
// test is missing, a test is newly skipped, the count drops, or a test is not listed yet. The cases call main(argv, io) in this
// process with synthetic results; the last cases read the real tests/inventory.txt without running any test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main, compare, toLines, parseInventory, INVENTORY } from "../scripts/test-inventory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "test-inventory-test-")); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const rec = (name, status = "run", extra = {}) => ({ file: "x.test.mjs", name, status, ms: 1, ...extra });
const item = (name, status = "run") => ({ name, status });
const resultsFile = (dir, records) => { const f = join(dir, "results.jsonl"); writeFileSync(f, records.map((r) => JSON.stringify(r)).join("\n") + "\n"); return f; };
const call = (argv, io = {}) => {
  let out = "";
  let err = "";
  const code = main(argv, { stdout: (s) => { out += s + "\n"; }, stderr: (s) => { err += s + "\n"; }, ...io });
  return { code, out, err };
};
// A folder with a results file and an inventory path, for --write then --check.
// The first write of an inventory has nothing to compare with, so it needs --allow-removals; this is that, for the tests that start from no inventory.
const first = (args, io) => call(["--write", "--allow-removals", ...args], io);
const setup = (records) => { const dir = scratch(); return { dir, results: resultsFile(dir, records), inventory: join(dir, "inventory.txt") }; };

test("inventory: lines are status, a tab and the full name, sorted, one per test", () => {
  const lines = toLines([rec("b"), rec("a > c", "skip"), rec("a")]);
  assert.deepEqual(lines, ["run\ta", "run\tb", "skip\ta > c"]);
  assert.deepEqual(parseInventory("# comment\n\nrun\ta\r\nskip\tb > c\n"), [item("a"), item("b > c", "skip")]);
  assert.throws(() => parseInventory("maybe\tx"), /not "run<TAB>name"/);
  assert.throws(() => parseInventory("no tab here"), /not "run<TAB>name"/);
});

test("inventory: the same results pass; a name that moves to another file keeps its line", () => {
  const listed = [item("a"), item("b"), item("c", "skip")];
  assert.equal(compare(listed, [item("c", "skip"), item("b"), item("a")]).ok, true);
  const moved = compare([item("x"), item("y")], [rec("y", "run", { file: "other.test.mjs" }), rec("x")]);
  assert.equal(moved.ok, true);
});

test("inventory: a missing test fails and is named", () => {
  const c = compare([item("a"), item("b"), item("c")], [item("a"), item("c")]);
  assert.equal(c.ok, false);
  assert.deepEqual(c.missing, ["b"]);
  assert.deepEqual([c.newlySkipped, c.unlisted], [[], []]);
});

test("inventory: a test that is newly skipped fails, and one that now runs is only noted", () => {
  const skipped = compare([item("a"), item("b")], [item("a"), item("b", "skip")]);
  assert.equal(skipped.ok, false);
  assert.deepEqual(skipped.newlySkipped, ["b"]);
  const runs = compare([item("a", "skip")], [item("a")]);
  assert.equal(runs.ok, true);
  assert.deepEqual(runs.nowRuns, ["a"]);
});

test("inventory: a test that is not listed fails until the inventory is written", () => {
  const c = compare([item("a")], [item("a"), item("new")]);
  assert.equal(c.ok, false);
  assert.deepEqual(c.unlisted, ["new"]);
});

test("inventory: names are a multiset, so a name used twice must run twice", () => {
  assert.equal(compare([item("same"), item("same")], [item("same"), item("same")]).ok, true);
  const one = compare([item("same"), item("same")], [item("same")]);
  assert.equal(one.ok, false);
  assert.deepEqual(one.missing, ["same"]);
  const three = compare([item("same"), item("same")], [item("same"), item("same"), item("same")]);
  assert.deepEqual(three.unlisted, ["same"]);
  const mixed = compare([item("same"), item("same", "skip")], [item("same"), item("same")]);
  assert.deepEqual(mixed.nowRuns, ["same"]);
});

test("inventory: the count dropping is reported even when the names that remain are all listed", () => {
  const c = compare([item("a"), item("b")], [item("a")]);
  assert.equal(c.ok, false);
  assert.ok(c.actualCount < c.expectedCount);
  const { dir, results, inventory } = setup([rec("a"), rec("b")]);
  assert.equal(first(["--results", results], { inventory }).code, 0);
  const fewer = call(["--check", "--results", resultsFile(dir, [rec("a")])], { inventory });
  assert.equal(fewer.code, 1);
  assert.match(fewer.out, /missing from this run \(1\):\n  b\n/);
  assert.match(fewer.out, /the count dropped: 2 listed, 1 ran/);
  assert.match(fewer.err, /inventory check FAILED/);
});

test("inventory: --write then --check passes and prints the count; --write prints what it wrote", () => {
  const { results, inventory } = setup([rec("a"), rec("b", "skip"), rec("c")]);
  const w = first(["--results", results], { inventory });
  assert.deepEqual([w.code, w.out], [0, "NO INVENTORY TO COMPARE WITH: writing a new one (--allow-removals)\ninventory written: 3 tests (1 skipped)\n"]);
  const text = readFileSync(inventory, "utf8");
  assert.match(text, /^# Test inventory\./);
  assert.match(text, /\n# tests: 3\n/);
  assert.match(text, /\nrun\ta\nrun\tc\nskip\tb\n$/);
  const c = call(["--check", "--results", results], { inventory });
  assert.deepEqual([c.code, c.out, c.err], [0, "inventory ok: 3 tests, none missing, none newly skipped\n", ""]);
});

test("inventory: --check prints exactly what changed: missing, newly skipped and unlisted", () => {
  const { dir, results, inventory } = setup([rec("keep"), rec("gone"), rec("will skip")]);
  first(["--results", results], { inventory });
  const next = resultsFile(dir, [rec("keep"), rec("will skip", "skip"), rec("brand new")]);
  const c = call(["--check", "--results", next], { inventory });
  assert.equal(c.code, 1);
  assert.match(c.out, /missing from this run \(1\):\n  gone\n/);
  assert.match(c.out, /newly skipped \(1\):\n  will skip\n/);
  assert.match(c.out, /not in the inventory \(run --write and read the diff\) \(1\):\n  brand new\n/);
});

test("inventory: a long list of changes is cut with a count of the rest", () => {
  const many = Array.from({ length: 55 }, (_, i) => rec(`t${String(i).padStart(2, "0")}`));
  const { dir, results, inventory } = setup(many);
  first(["--results", results], { inventory });
  const c = call(["--check", "--results", resultsFile(dir, [])], { inventory });
  assert.match(c.out, /missing from this run \(55\):/);
  assert.match(c.out, /\.\.\. and 15 more/);
});

test("inventory: --write refuses a run with a failing test or no tests, and writes nothing", () => {
  const { dir, results, inventory } = setup([rec("a"), rec("b", "run", { fail: true })]);
  const bad = call(["--write", "--results", results], { inventory });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /1 test\(s\) failed/);
  assert.throws(() => readFileSync(inventory), /ENOENT/);
  const empty = call(["--write", "--results", resultsFile(dir, [])], { inventory });
  assert.equal(empty.code, 1);
  assert.match(empty.err, /holds no tests/);
});

test("inventory: --write over an inventory that has a test the run lost is refused, and says which", () => {
  const { dir, results, inventory } = setup([rec("a"), rec("b"), rec("c")]);
  assert.equal(first(["--results", results], { inventory }).code, 0);
  const before = readFileSync(inventory, "utf8");
  const lost = call(["--write", "--results", resultsFile(dir, [rec("a")])], { inventory });
  assert.equal(lost.code, 1);
  assert.match(lost.out, /missing from this run \(2\):\n  b\n  c\n/);
  assert.match(lost.out, /the count dropped: 3 listed, 1 ran/);
  assert.match(lost.err, /not writing the inventory: a listed test is missing or newly skipped, or the count dropped/);
  assert.equal(readFileSync(inventory, "utf8"), before, "the inventory is untouched");
});

test("inventory: --write over an inventory is refused for a newly skipped test, and a new test does not make up for a lost one", () => {
  const { dir, results, inventory } = setup([rec("a"), rec("b")]);
  first(["--results", results], { inventory });
  const before = readFileSync(inventory, "utf8");
  const skipped = call(["--write", "--results", resultsFile(dir, [rec("a"), rec("b", "skip")])], { inventory });
  assert.equal(skipped.code, 1);
  assert.match(skipped.out, /newly skipped \(1\):\n  b\n/);
  const swapped = call(["--write", "--results", resultsFile(dir, [rec("a"), rec("z")])], { inventory });
  assert.equal(swapped.code, 1, "a new test does not make up for a lost one");
  assert.equal(readFileSync(inventory, "utf8"), before);
});

test("inventory: --write with --allow-removals prints the removals loudly and writes; new tests alone need no flag", () => {
  const { dir, results, inventory } = setup([rec("a"), rec("b")]);
  first(["--results", results], { inventory });
  const added = call(["--write", "--results", resultsFile(dir, [rec("a"), rec("b"), rec("c")])], { inventory });
  assert.deepEqual([added.code, added.out], [0, "inventory written: 3 tests (0 skipped)\n"]);
  const removed = call(["--write", "--allow-removals", "--results", resultsFile(dir, [rec("a")])], { inventory });
  assert.equal(removed.code, 0, removed.err);
  assert.match(removed.out, /missing from this run \(2\)/);
  assert.match(removed.out, /REMOVALS ALLOWED: 2 missing and 0 newly skipped/);
  assert.match(readFileSync(inventory, "utf8"), /\n# tests: 1\n/);
  assert.equal(call(["--check", "--allow-removals", "--results", results], { inventory }).code, 2, "--allow-removals is for --write only");
});

test("inventory: --write with no inventory to compare with (absent, empty, or only comments) is refused, and accepted with --allow-removals", () => {
  const { dir, results } = setup([rec("a"), rec("b")]);
  const cases = [
    ["absent", null],
    ["empty", ""],
    ["blank lines only", "\n\n  \n"],
    ["comments only", "# Test inventory.\n# tests: 0\n"],
  ];
  for (const [label, content] of cases) {
    const inventory = join(dir, `inventory-${label.replace(/ /g, "-")}.txt`);
    if (content !== null) writeFileSync(inventory, content);
    const refused = call(["--write", "--results", results], { inventory });
    assert.equal(refused.code, 1, label);
    assert.match(refused.err, /there is no inventory to compare with \(the file is missing, empty or holds only comments\)/, label);
    assert.match(refused.err, /--write --allow-removals/, label);
    if (content === null) assert.throws(() => readFileSync(inventory), /ENOENT/, "nothing was written");
    else assert.equal(readFileSync(inventory, "utf8"), content, `${label}: the file is untouched`);
    const accepted = call(["--write", "--allow-removals", "--results", results], { inventory });
    assert.equal(accepted.code, 0, `${label}: ${accepted.err}`);
    assert.match(accepted.out, /NO INVENTORY TO COMPARE WITH: writing a new one/, label);
    assert.match(readFileSync(inventory, "utf8"), /\n# tests: 2\n/, label);
  }
});

test("inventory: --write refuses to write over a damaged inventory", () => {
  const { results, inventory } = setup([rec("a")]);
  writeFileSync(inventory, "perhaps\tx\n");
  const r = call(["--write", "--results", results], { inventory });
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot read the inventory/);
  assert.equal(readFileSync(inventory, "utf8"), "perhaps\tx\n");
});

test("inventory: a test run that exits non-zero, ends by a signal, or reports no tests is not written or checked, whatever its records say", () => {
  const { inventory } = setup([rec("a")]);
  const ran = (extra) => ({ inventory, runTests: () => ({ records: [rec("a"), rec("b")], status: 0, signal: null, ...extra }) });
  for (const mode of ["--write", "--check"]) {
    const bad = call([mode], ran({ status: 1 }));
    assert.equal(bad.code, 1, mode);
    assert.match(bad.err, /did not end cleanly \(exit status 1\)/);
    const killed = call([mode], ran({ status: null, signal: "SIGKILL" }));
    assert.equal(killed.code, 1, mode);
    assert.match(killed.err, /signal SIGKILL/);
  }
  assert.throws(() => readFileSync(inventory), /ENOENT/, "nothing was written");
  const none = call(["--write"], { inventory, runTests: () => ({ records: [], status: 0, signal: null }) });
  assert.equal(none.code, 1);
  assert.match(none.err, /holds no tests/);
  assert.equal(first([], ran({})).code, 0, "a clean run is written");
});

test("inventory: usage errors, a results file that is missing or damaged, and an inventory that is damaged", () => {
  assert.equal(call([]).code, 2);
  assert.equal(call(["--check", "--write"]).code, 2);
  assert.equal(call(["--bogus"]).code, 2);
  assert.match(call(["--check", "--results"]).err, /--results needs a file/);
  const { dir, results, inventory } = setup([rec("a")]);
  const none = call(["--check", "--results", join(dir, "nope.jsonl")], { inventory });
  assert.equal(none.code, 2);
  assert.match(none.err, /cannot read the test results/);
  writeFileSync(join(dir, "bad.jsonl"), "{not json\n");
  assert.equal(call(["--check", "--results", join(dir, "bad.jsonl")], { inventory }).code, 2);
  assert.match(call(["--check", "--results", results], { inventory: join(dir, "missing.txt") }).err, /cannot read the inventory/);
  writeFileSync(inventory, "perhaps\tx\n");
  assert.equal(call(["--check", "--results", results], { inventory }).code, 2);
});

test("inventory: with no --results the tests are run through the runTests seam, once", () => {
  const { inventory } = setup([rec("a")]);
  let runs = 0;
  const io = { inventory, runTests: () => { runs++; return [rec("a"), rec("b")]; } };
  assert.equal(first([], io).code, 0);
  assert.equal(runs, 1);
  assert.equal(call(["--check"], io).code, 0);
  assert.equal(runs, 2);
});

test("inventory: the real tests/inventory.txt is well formed, and its header count is its number of lines", () => {
  const text = readFileSync(INVENTORY, "utf8");
  assert.equal(INVENTORY, join(HERE, "inventory.txt"));
  const items = parseInventory(text);
  const header = text.match(/^# tests: (\d+)$/m);
  assert.ok(header, "the header holds the count");
  assert.equal(Number(header[1]), items.length);
  const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(lines, [...lines].sort(), "sorted, so a diff shows only what changed");
  // Before phase 7p HEAD had 795 tests (794 run, 1 skip); the inventory has grown since and keeps growing, so no number is pinned here (a floor
  // would go stale, and the check that no listed test disappears is `--check` in the full verify). Nothing from HEAD was removed, except that
  // two version-bump tests in tests/phased-shipping-docs.test.mjs (the phase 7d3 What's new 0.10.0 test and the plugin-at-0.10.0 test) were
  // replaced by their 0.11.0 successors. A sample of HEAD's tests from different files must still be listed, as run.
  const listed = new Map(items.map((i) => [i.name, i.status]));
  for (const name of [
    "every deny rule fires on every sample, and the reason names the rule (in process)",
    "the hook scripts import only node: built-ins and their own files, and never write or reach the network",
    "a file with an allowlisted name that holds binary bytes or is not text is skipped and never printed",
    "the last check is its own safety net: with the file scan removed, a secret in a workflow name still stops the run",
  ]) assert.equal(listed.get(name), "run", name);
  assert.ok(items.filter((i) => i.status === "skip").length <= 1, "at most the one test that was skipped before");
});

test("inventory: the regression pack's tests are listed by name (they moved from the dashboard tests, so no name is new)", () => {
  const names = new Set(parseInventory(readFileSync(INVENTORY, "utf8")).map((i) => i.name));
  for (const name of [
    "page: the hostile string is cleaned and escaped in a project name, a phase title, a session label, a phase id and an error file name",
    "csp: a script with CRLF line ends is inlined with LF and the policy hash is the hash of that text",
    "trail: nothing is written while the dashboard is off",
  ]) assert.ok(names.has(name), name);
});
