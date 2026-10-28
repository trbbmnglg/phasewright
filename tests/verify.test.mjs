// Run with: node --test tests/verify.test.mjs
// Covers scripts/verify.mjs, which is `npm run verify` and `npm run verify:fast`: the steps it runs and their order, that it stops
// at lint or the manifest, the fast list, the inventory step, the exit codes, and that it never uses a shell. The cases call
// main(argv, io) in this process with a fake step runner; nothing here starts lint, the manifest check or a test run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main, buildSteps, readFastList, allTestFiles, slowestTable, FAST_LIST, PACK_FILE, SLOW_FIRST } from "../scripts/verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "verify-test-")); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// A repository with a few test files, a helper that is not a test file, and a fast list.
function fixture(fast = ["tests/a.test.mjs", "tests/regression-pack.test.mjs"]) {
  const root = scratch();
  mkdirSync(join(root, "tests", "helpers"), { recursive: true });
  for (const f of ["a.test.mjs", "b.test.mjs", "regression-pack.test.mjs"]) writeFileSync(join(root, "tests", f), "");
  writeFileSync(join(root, "tests", "helpers", "h.mjs"), "");
  writeFileSync(join(root, "tests", "inventory.txt"), "");
  writeFileSync(join(root, FAST_LIST), JSON.stringify({ files: fast }));
  return root;
}

// A fake runner: records each step, answers with the exit code given for its name, and for the test step writes the results file.
function fake({ codes = {}, records = [{ file: "a.test.mjs", name: "one", status: "run", ms: 5 }] } = {}) {
  const steps = [];
  const run = async (step) => {
    steps.push(step);
    if (step.name === "tests") {
      const dest = step.args.filter((a) => a.startsWith("--test-reporter-destination=")).map((a) => a.split("=")[1]).find((d) => d !== "stdout");
      writeFileSync(dest, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    return codes[step.name] ?? 0;
  };
  return { steps, run };
}
async function go(argv, root, opts = {}, io = {}) {
  let out = "";
  let err = "";
  const f = fake(opts);
  const inventoryCalls = [];
  const code = await main(argv, { root, run: f.run, stdout: (s) => { out += s + "\n"; }, stderr: (s) => { err += s + "\n"; }, inventory: (a) => { inventoryCalls.push(a); return opts.inventoryCode ?? 0; }, ...io });
  return { code, out, err, steps: f.steps, inventoryCalls };
}

test("verify: the full run is lint, the manifest check, every test file, then the inventory, in that order", async () => {
  const root = fixture();
  const r = await go([], root);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.steps.map((s) => s.name), ["lint", "manifest check", "tests"]);
  const tests = r.steps[2].args;
  assert.deepEqual(tests.filter((a) => a.endsWith(".test.mjs")), ["tests/a.test.mjs", "tests/b.test.mjs", "tests/regression-pack.test.mjs"], "the glob: every *.test.mjs and nothing else");
  assert.ok(!tests.some((a) => a.includes("helpers") || a.includes("inventory")));
  assert.equal(r.inventoryCalls.length, 1);
  assert.deepEqual(r.inventoryCalls[0].slice(0, 2), ["--check", "--results"]);
  assert.match(r.out, /== test inventory/);
  assert.match(r.out, /verify passed/);
});

test("verify: the steps are commands with argument arrays, never a shell string", async () => {
  const root = fixture();
  const r = await go([], root);
  for (const s of r.steps) {
    assert.equal(typeof s.cmd, "string");
    assert.ok(Array.isArray(s.args) && s.args.every((a) => typeof a === "string"), s.name);
    assert.equal(s.cmd, process.execPath, "each step runs node itself");
  }
  assert.deepEqual(r.steps[0].args, ["scripts/lint.mjs"]);
  assert.deepEqual(r.steps[1].args, ["scripts/build-manifest.mjs", "--check"]);
  const src = readFileSync(join(REPO, "scripts", "verify.mjs"), "utf8");
  assert.doesNotMatch(src, /shell:\s*true/);
  assert.doesNotMatch(src, /\bexec\(|\bexecSync\(|\bspawnSync\(|\bexecFileSync\(/);
  assert.match(src, /spawn\(step\.cmd, step\.args,/);
});

test("verify: the test step prints the spec report and writes the JSON records to a results file", () => {
  const [, , tests] = buildSteps({ files: ["tests/a.test.mjs"], resultsFile: "/tmp/r.jsonl" });
  assert.ok(tests.args.includes("--test"));
  assert.ok(tests.args.includes("--test-reporter=spec") && tests.args.includes("--test-reporter-destination=stdout"));
  assert.ok(tests.args.some((a) => /^--test-reporter=file:.*test-report\.mjs$/.test(a)));
  assert.ok(tests.args.includes("--test-reporter-destination=/tmp/r.jsonl"));
  assert.equal(tests.args.some((a) => a.startsWith("--test-concurrency")), false, "no concurrency flag unless one was measured to be faster and asked for");
  const [, , withC] = buildSteps({ files: ["tests/a.test.mjs"], resultsFile: "/tmp/r.jsonl", concurrency: "6" });
  assert.ok(withC.args.includes("--test-concurrency=6"));
});

test("verify: a failing lint stops the run before the manifest, the tests and the inventory", async () => {
  const r = await go([], fixture(), { codes: { lint: 1 } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.steps.map((s) => s.name), ["lint"]);
  assert.equal(r.inventoryCalls.length, 0);
  assert.match(r.err, /verify FAILED at: lint/);
});

test("verify: a failing manifest check stops the run before the tests", async () => {
  const r = await go([], fixture(), { codes: { "manifest check": 1 } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.steps.map((s) => s.name), ["lint", "manifest check"]);
  assert.match(r.err, /verify FAILED at: manifest check/);
});

test("verify: failing tests exit 1, still print the slowest, and skip the inventory (a failed run is not a list of what ran)", async () => {
  const r = await go([], fixture(), { codes: { tests: 1 }, records: [{ file: "a.test.mjs", name: "slow one", status: "run", ms: 9000 }, { file: "a.test.mjs", name: "bad", status: "run", ms: 3, fail: true }] });
  assert.equal(r.code, 1);
  assert.equal(r.inventoryCalls.length, 0);
  assert.match(r.err, /verify FAILED at: tests/);
  assert.match(r.out, /2 tests ran, 1 failed; the 10 slowest/);
  assert.match(r.out, / 1\.\s+9\.0 s  a\.test\.mjs  slow one/);
  assert.match(r.out, /verify FAILED in/);
});

test("verify: a failing inventory check fails the run even when every test passed", async () => {
  const r = await go([], fixture(), { inventoryCode: 1 });
  assert.equal(r.code, 1);
  assert.match(r.err, /verify FAILED at: test inventory/);
  assert.match(r.out, /verify FAILED in/);
});

test("verify: a test run that recorded no tests fails, whether node exited 0 or not, and is never read as zero tests passing", async () => {
  const root = fixture();
  const failed = await go([], root, {}, { run: async (step) => (step.name === "tests" ? 1 : 0) });
  assert.equal(failed.code, 1);
  assert.equal(failed.inventoryCalls.length, 0);
  for (const argv of [[], ["--fast"]]) {
    const quiet = await go(argv, root, {}, { run: async () => 0 });
    assert.equal(quiet.code, 1, argv.join(" "));
    assert.match(quiet.err, /the run recorded no tests/);
    assert.equal(quiet.inventoryCalls.length, 0);
  }
});

test("verify: the fast run is lint, the manifest check and only the files in the fast list, with no inventory step", async () => {
  const r = await go(["--fast"], fixture());
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.steps.map((s) => s.name), ["lint", "manifest check", "tests"]);
  assert.deepEqual(r.steps[2].args.filter((a) => a.endsWith(".test.mjs")), ["tests/a.test.mjs", "tests/regression-pack.test.mjs"]);
  assert.equal(r.inventoryCalls.length, 0);
  assert.match(r.out, /tests \(fast list: 2 files\)/);
  assert.match(r.out, /the test inventory is checked by the full verify, not the fast one/);
  assert.match(r.out, /verify:fast passed/);
});

test("verify: the fast run fails when a listed file is missing, listed twice, or not a test file path, and runs nothing", async () => {
  for (const [list, pattern] of [
    [["tests/a.test.mjs", "tests/gone.test.mjs"], /listed file is missing: tests\/gone\.test\.mjs/],
    [["tests/a.test.mjs", "tests/a.test.mjs"], /listed twice/],
    [["../outside.test.mjs"], /not a tests\/<name>\.test\.mjs path/],
    [["tests/helpers/h.mjs"], /not a tests\/<name>\.test\.mjs path/],
    [["/etc/x.test.mjs"], /not a tests\/<name>\.test\.mjs path/],
    [[], /non-empty "files" list/],
  ]) {
    const r = await go(["--fast"], fixture(list));
    assert.equal(r.code, 1, JSON.stringify(list));
    assert.match(r.err, pattern);
    assert.equal(r.steps.length, 0, "nothing ran");
  }
  const root = fixture();
  writeFileSync(join(root, FAST_LIST), "{ not json");
  assert.match((await go(["--fast"], root)).err, /cannot read tests\/fast-list\.json/);
  rmSync(join(root, FAST_LIST));
  assert.match((await go(["--fast"], root)).err, /cannot read tests\/fast-list\.json/);
});

test("verify: the regression pack's count is printed so a reviewer can be told it passed", async () => {
  const records = [
    { file: PACK_FILE, name: "p1", status: "run", ms: 1 },
    { file: PACK_FILE, name: "p2", status: "run", ms: 1 },
    { file: PACK_FILE, name: "p3", status: "run", ms: 1, fail: true },
    { file: "a.test.mjs", name: "other", status: "run", ms: 1 },
  ];
  const r = await go(["--fast"], fixture(), { records, codes: { tests: 1 } });
  assert.match(r.out, /regression pack: 2 of 3 tests passed/);
  const ok = await go(["--fast"], fixture(), { records: records.slice(0, 2).concat(records.slice(3)) });
  assert.match(ok.out, /regression pack: 2 of 2 tests passed/);
  assert.doesNotMatch((await go(["--fast"], fixture(), { records: records.slice(3) })).out, /regression pack/);
});

test("verify: unknown options and a bad --test-concurrency are usage errors that run nothing", async () => {
  for (const argv of [["--bogus"], ["fast"], ["--fast", "--also"], ["--test-concurrency=0"], ["--test-concurrency=x"], ["--test-concurrency="], ["--test-concurrency=1000"]]) {
    const r = await go(argv, fixture());
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(r.steps.length, 0);
  }
  const r = await go(["--test-concurrency=3"], fixture());
  assert.equal(r.code, 0, r.err);
  assert.ok(r.steps[2].args.includes("--test-concurrency=3"));
  assert.equal(r.inventoryCalls.length, 1, "a full run with a concurrency flag still checks the inventory");
});

test("verify: the inventory check runs for every full invocation, whatever other arguments it is given, and for no fast one", async () => {
  for (const argv of [[], ["--test-concurrency=3"], ["--test-concurrency=12"], ["--test-concurrency=1"], ["--test-concurrency=999"]]) {
    const r = await go(argv, fixture());
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`);
    assert.equal(r.inventoryCalls.length, 1, `${argv.join(" ") || "no arguments"}: the inventory was checked`);
    assert.deepEqual(r.inventoryCalls[0].slice(0, 2), ["--check", "--results"]);
    assert.match(r.out, /== test inventory/);
    // and its failure fails the run, with the same arguments
    const bad = await go(argv, fixture(), { inventoryCode: 1 });
    assert.equal(bad.code, 1, argv.join(" "));
  }
  for (const argv of [["--fast"], ["--fast", "--test-concurrency=3"]]) {
    const r = await go(argv, fixture());
    assert.equal(r.inventoryCalls.length, 0, argv.join(" "));
  }
});

test("verify: the 10 slowest are listed longest first, with the file and a name cut at 100 characters", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ file: "f.test.mjs", name: `t${i}`, status: "run", ms: (i + 1) * 1000 }));
  rows.push({ file: "g.test.mjs", name: "x".repeat(150), status: "run", ms: 500 });
  const table = slowestTable(rows);
  assert.equal(table.length, 10);
  assert.match(table[0], /^ 1\.\s+12\.0 s  f\.test\.mjs  t11$/);
  assert.match(table[9], /3\.0 s  f\.test\.mjs  t2$/);
  const long = slowestTable(rows, 13).at(-1);
  assert.match(long, /g\.test\.mjs  x{97}\.\.\.$/);
});

test("verify: allTestFiles takes every tests/*.test.mjs, so a new test file is picked up by CI with no list to edit", () => {
  const root = fixture();
  writeFileSync(join(root, "tests", "new-thing.test.mjs"), "");
  assert.deepEqual(allTestFiles(root), ["tests/a.test.mjs", "tests/b.test.mjs", "tests/new-thing.test.mjs", "tests/regression-pack.test.mjs"]);
  const real = allTestFiles(REPO);
  assert.ok(real.includes("tests/verify.test.mjs") && real.includes("tests/regression-pack.test.mjs"));
  assert.ok(real.every((f) => /^tests\/[^/]+\.test\.mjs$/.test(f)));
});

test("verify: the real fast list is valid, names the regression pack, and every file in it exists", () => {
  const files = readFastList(REPO);
  assert.ok(files.includes(`tests/${PACK_FILE}`), "the regression pack is in the fast run");
  assert.ok(files.includes("tests/verify.test.mjs") && files.includes("tests/test-inventory.test.mjs"), "the speed-up's own tests are in the fast run");
  for (const f of files) assert.ok(existsSync(join(REPO, f)), f);
  assert.deepEqual(allTestFiles(REPO).filter((f) => files.includes(f)).length, files.length);
});

test("verify: npm run verify and npm run verify:fast call the script, and CI runs npm run verify and nothing less", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.scripts.verify, "node scripts/verify.mjs");
  assert.equal(pkg.scripts["verify:fast"], "node scripts/verify.mjs --fast");
  assert.equal(pkg.scripts.test, "node --test tests/*.test.mjs", "npm test still runs every test file");
  for (const wf of ["ci.yml", "release.yml"]) {
    const text = readFileSync(join(REPO, ".github", "workflows", wf), "utf8");
    assert.ok(/^\s*-?\s*(run:\s*)?npm run verify\s*$/m.test(text), `${wf} runs npm run verify`);
    assert.doesNotMatch(text, /verify:fast/, `${wf} never runs the fast list`);
    assert.deepEqual(gatingProblems(text), [], `${wf}: nothing lets the verify step be skipped or ignored`);
  }
});

// Reads a workflow by indentation (no YAML library). Finds the one step whose run is `npm run verify` and returns the reasons it could be skipped or
// ignored: a continue-on-error or an if on that step, or on the job that holds it, or a job-level continue-on-error that lets the run go on.
const indentOf = (l) => l.length - l.trimStart().length;
// A line without its list dash, and with quotes taken off the key (YAML allows "if": false and 'continue-on-error': true).
const keyOf = (l) => l.trim().replace(/^- /, "").replace(/^(["'])([A-Za-z0-9_-]+)\1(\s*:)/, "$2$3");
// The keys under the workflow's top-level `on:` (two-space indentation, quotes allowed on `on` and on the keys).
function triggersOf(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^["']?on["']?\s*:\s*$/.test(l));
  if (at < 0) return [];
  const keys = [];
  for (let i = at + 1; i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > 0); i++) {
    if (indentOf(lines[i]) === 2 && lines[i].trim() !== "" && !lines[i].trimStart().startsWith("#")) keys.push(keyOf(lines[i]).replace(/\s*:.*$/, ""));
  }
  return keys;
}
function gatingProblems(text) {
  const lines = text.split("\n");
  const at = lines.map((l, i) => (/^\s*(- )?run:\s*npm run verify\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (at.length !== 1) return [`the workflow has ${at.length} steps that run npm run verify, not 1`];
  const problems = [];
  const gate = (l) => /^(continue-on-error|if)\s*:/.test(keyOf(l));
  const needs = (l) => /^needs\s*:/.test(keyOf(l));
  // the step: from its "- " line to the next "- " at the same indentation (or a line that is indented less)
  let start = at[0];
  while (start >= 0 && !lines[start].trimStart().startsWith("- ")) start--;
  if (start < 0) return ["the verify step is not a list item of a steps list"];
  const stepIndent = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) > stepIndent || (indentOf(lines[end]) === stepIndent && !lines[end].trimStart().startsWith("- ")))) end++;
  for (const l of lines.slice(start, end)) if (gate(l)) problems.push(`the step has ${keyOf(l)}`);
  // the job: the nearest line above, indented 2 spaces, that is a key; its own keys are indented 4
  let job = start;
  while (job >= 0 && !(indentOf(lines[job]) === 2 && /^["']?[A-Za-z0-9_-]+["']?:\s*$/.test(lines[job].trim()))) job--;
  if (job < 0) return [...problems, "the verify step is not inside a job"];
  for (let i = job + 1; i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > 2); i++) {
    if (indentOf(lines[i]) !== 4) continue;
    if (gate(lines[i])) problems.push(`the job has ${keyOf(lines[i])}`);
    // any dependency: a job that this one needs can be skipped (if: false), and then this one is skipped with it
    if (needs(lines[i])) problems.push(`the job has needs, so another job can skip it: ${keyOf(lines[i])}`);
  }
  return problems;
}

test("verify: the workflow check sees an if or a continue-on-error on the verify step or its job, and passes a clean workflow", () => {
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(join(REPO, ".github", "workflows", "release.yml"), "utf8");
  assert.deepEqual(gatingProblems(ci), []);
  assert.deepEqual(gatingProblems(release), []);
  const mutants = [
    ["      - run: npm run verify", "      - run: npm run verify\n        continue-on-error: true", /step has continue-on-error/, ci],
    ["      - run: npm run verify", "      - if: github.ref == 'refs/heads/main'\n        run: npm run verify", /step has if/, ci],
    ["    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    if: false", /job has if/, ci],
    ["    runs-on: ubuntu-latest", "    continue-on-error: true\n    runs-on: ubuntu-latest", /job has continue-on-error/, ci],
    ["        run: npm run verify", "        run: npm run verify\n        if: always()", /step has if/, release],
    ["        run: npm run verify", "        continue-on-error: true\n        run: npm run verify", /step has continue-on-error/, release],
    ["    runs-on: ubuntu-latest", "    if: startsWith(github.ref, 'refs/tags/')\n    runs-on: ubuntu-latest", /job has if/, release],
  ];
  for (const [from, to, expected, source] of mutants) {
    assert.ok(source.includes(from), from);
    assert.match(gatingProblems(source.replace(from, to)).join("; "), expected, to);
  }
  assert.match(gatingProblems(ci.replace("npm run verify", "npm test")).join(), /0 steps/);
  // a condition on another step does not count against this one
  assert.deepEqual(gatingProblems(release.replace("      - name: Release name\n", "      - name: Release name\n        if: always()\n")), []);
});

test("verify: the workflow check is not fooled by quoted keys, by a needs on the verify job, or by triggers that no longer fire on a push or a pull request", () => {
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(join(REPO, ".github", "workflows", "release.yml"), "utf8");
  // the real files pass, and ci.yml fires on both a push and a pull request
  assert.deepEqual(gatingProblems(ci), []);
  assert.deepEqual(triggersOf(ci).sort(), ["pull_request", "push"], "ci.yml runs on a push to main and on every pull request");
  assert.ok(triggersOf(release).includes("push"), "release.yml runs on a pushed tag");
  // quoted keys on the step or on the job
  const quoted = [
    ["      - run: npm run verify", "      - run: npm run verify\n        \"continue-on-error\": true", /step has continue-on-error/, ci],
    ["      - run: npm run verify", "      - run: npm run verify\n        'if': false", /step has if/, ci],
    ["      - run: npm run verify", "      - 'if': false\n        run: npm run verify", /step has if/, ci],
    ["    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    \"if\": false", /job has if/, ci],
    ["    runs-on: ubuntu-latest", "    'continue-on-error': true\n    runs-on: ubuntu-latest", /job has continue-on-error/, ci],
    ["        run: npm run verify", "        run: npm run verify\n        \"if\" : always()", /step has if/, release],
    ["    runs-on: ubuntu-latest", "    \"if\": startsWith(github.ref, 'refs/tags/')\n    runs-on: ubuntu-latest", /job has if/, release],
  ];
  for (const [from, to, expected, source] of quoted) {
    assert.ok(source.includes(from), from);
    assert.match(gatingProblems(source.replace(from, to)).join("; "), expected, to);
  }
  // a needs on the verify job, whose dependency is a job that is skipped
  const needy = ci.replace("jobs:\n  verify:\n", "jobs:\n  gate:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo gate\n  verify:\n    needs: gate\n");
  assert.notEqual(needy, ci);
  assert.match(gatingProblems(needy).join("; "), /job has needs/);
  assert.match(gatingProblems(ci.replace("    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    needs: [a, b]")).join("; "), /job has needs/);
  assert.match(gatingProblems(ci.replace("    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    \"needs\": a")).join("; "), /job has needs/);
  // triggers replaced by one that nothing fires
  const only = ci.replace(/on:\n  push:\n    branches: \[main\]\n  pull_request:\n/, "on:\n  workflow_dispatch:\n");
  assert.notEqual(only, ci);
  assert.deepEqual(triggersOf(only), ["workflow_dispatch"]);
  assert.deepEqual(triggersOf(ci.replace("  pull_request:\n", "")), ["push"]);
  assert.deepEqual(triggersOf(ci.replace("on:\n", "\"on\":\n")).sort(), ["pull_request", "push"], "a quoted on: is read too");
  assert.deepEqual(triggersOf("name: x\njobs:\n  a:\n"), [], "no on: block, no triggers");
});

test("verify: the slow files start first, every test file still runs once, and every name in the slow list is a real file", () => {
  const real = allTestFiles(REPO);
  assert.equal(new Set(real).size, real.length, "no file twice");
  for (const f of SLOW_FIRST) assert.ok(existsSync(join(REPO, f)), `${f} is in the slow list but is not a file`);
  assert.deepEqual(real.slice(0, SLOW_FIRST.length), SLOW_FIRST);
  const root = fixture();
  assert.deepEqual(allTestFiles(root), ["tests/a.test.mjs", "tests/b.test.mjs", "tests/regression-pack.test.mjs"], "a repository with none of them lists by name");
});

test("verify: the README and the Speed wiki page tell contributors about npm run verify:fast", () => {
  assert.match(readFileSync(join(REPO, "README.md"), "utf8"), /npm run verify:fast/);
  const speed = readFileSync(join(REPO, "docs", "wiki", "Speed.md"), "utf8");
  assert.match(speed, /^## In this repository$/m);
  const section = speed.split(/^## In this repository$/m)[1].split(/^## /m)[0];
  for (const phrase of ["records names only", "`describe.skip`", "`todo` test", "cannot see a test that vanished", "no timeout per test", "--allow-removals", "no inventory to compare with"]) assert.ok(section.includes(phrase), `the section states: ${phrase}`);
  assert.match(speed, /npm run verify:fast/);
});
