#!/usr/bin/env node
// The repository's checks.
//   npm run verify        node scripts/verify.mjs          lint, manifest check, every tests/*.test.mjs,
//                                                          the test inventory, then the 10 slowest tests
//   npm run verify:fast   node scripts/verify.mjs --fast   lint, manifest check, and only the files named in
//                                                          tests/fast-list.json (the regression pack and the fast core)
// CI runs `npm run verify`, so the full run is the one that can't be skipped. Steps are spawned with argument
// arrays and no shell. A failing step makes the exit code non-zero; lint and the manifest stop the run early,
// because the tests are not worth running on a repository that fails them.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main as inventoryMain } from "./test-inventory.mjs";
import { readResults, slowest } from "./test-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const FAST_LIST = "tests/fast-list.json";
const REPORTER = pathToFileURL(join(HERE, "test-report.mjs")).href;
export const PACK_FILE = "regression-pack.test.mjs";
const TEST_FILE = /^tests\/[A-Za-z0-9._-]+\.test\.mjs$/;

// The slowest test files, measured, which start first: node runs the files it is given a few at a time in the order given, so starting the long ones
// first keeps them from being the tail of the run. This only orders the run: every test file still runs, and a file missing from this list
// (or a name here with no file) changes nothing but the order.
export const SLOW_FIRST = [
  "plugin-split-guard", "dashboard-page-sweeps-6b", "dashboard-page-sweeps", "free-resources-measure", "wiki-publish", "tree-state-process", "dashboard-page-rounds",
  "dashboard", "scripts", "plugin-split", "dashboard-page", "dashboard-page-sweeps-6", "tree-state", "guard",
].map((n) => `tests/${n}.test.mjs`);

// Every test file, found at run time so a new file is picked up (CI included): the slow ones first, then the rest by name.
export const allTestFiles = (root) => {
  const all = readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `tests/${f}`);
  return [...SLOW_FIRST.filter((f) => all.includes(f)), ...all.filter((f) => !SLOW_FIRST.includes(f))];
};

// The fast list: { "files": ["tests/x.test.mjs", ...] }. It must name only existing test files, once each.
export function readFastList(root, read = (f) => readFileSync(f, "utf8")) {
  let list;
  try {
    list = JSON.parse(read(join(root, FAST_LIST)));
  } catch (e) {
    throw new Error(`cannot read ${FAST_LIST}: ${e.message}`);
  }
  const files = list?.files;
  if (!Array.isArray(files) || !files.length) throw new Error(`${FAST_LIST} needs a non-empty "files" list`);
  const seen = new Set();
  for (const f of files) {
    if (typeof f !== "string" || !TEST_FILE.test(f)) throw new Error(`${FAST_LIST}: "${String(f)}" is not a tests/<name>.test.mjs path`);
    if (seen.has(f)) throw new Error(`${FAST_LIST}: "${f}" is listed twice`);
    seen.add(f);
    if (!existsSync(join(root, f))) throw new Error(`${FAST_LIST}: listed file is missing: ${f}`);
  }
  return files;
}

const nodeStep = (name, args) => ({ name, cmd: process.execPath, args });

// The ordered steps. The test step gets the results file where the reporter writes its JSON lines.
export function buildSteps({ files, resultsFile, concurrency }) {
  const c = concurrency ? [`--test-concurrency=${concurrency}`] : [];
  return [
    nodeStep("lint", ["scripts/lint.mjs"]),
    nodeStep("manifest check", ["scripts/build-manifest.mjs", "--check"]),
    nodeStep("tests", ["--test", ...c, "--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${REPORTER}`, `--test-reporter-destination=${resultsFile}`, ...files]),
  ];
}

const realRun = (step, root) =>
  new Promise((res) => {
    const p = spawn(step.cmd, step.args, { cwd: root, stdio: "inherit" });
    p.on("error", () => res(1));
    p.on("close", (code) => res(code ?? 1));
  });

export const slowestTable = (records, n = 10) =>
  slowest(records, n).map((r, i) => `${String(i + 1).padStart(2)}. ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.file}  ${r.name.length > 100 ? r.name.slice(0, 97) + "..." : r.name}`);

export async function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s + "\n"));
  const err = io.stderr ?? ((s) => process.stderr.write(s + "\n"));
  const root = io.root ?? ROOT;
  const run = io.run ?? ((step) => realRun(step, root));
  const fast = argv.includes("--fast");
  const unknown = argv.filter((a) => a !== "--fast" && !a.startsWith("--test-concurrency="));
  if (unknown.length) {
    err(`usage: node scripts/verify.mjs [--fast] [--test-concurrency=N]  (unknown: ${unknown.join(" ")})`);
    return 2;
  }
  const cArg = argv.find((a) => a.startsWith("--test-concurrency="));
  const concurrency = cArg === undefined ? "" : cArg.slice("--test-concurrency=".length);
  if (cArg !== undefined && !/^[1-9]\d{0,2}$/.test(concurrency)) {
    err("--test-concurrency needs a whole number of at least 1");
    return 2;
  }
  let files;
  try {
    files = fast ? readFastList(root, io.read) : allTestFiles(root);
  } catch (e) {
    err(e.message);
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  const resultsFile = join(dir, "results.jsonl");
  try {
    const [lint, manifest, tests] = buildSteps({ files, resultsFile, concurrency });
    const t0 = Date.now();
    for (const step of [lint, manifest]) {
      out(`== ${step.name}`);
      if ((await run(step)) !== 0) {
        err(`verify FAILED at: ${step.name}`);
        return 1;
      }
    }
    out(`== ${fast ? "tests (fast list: " + files.length + " files)" : "tests (" + files.length + " files)"}`);
    const testCode = await run(tests);
    let records = [];
    try {
      records = existsSync(resultsFile) ? readResults(resultsFile) : [];
    } catch (e) {
      err(`cannot read the test results: ${e.message}`);
      return 1;
    }
    let code = testCode === 0 ? 0 : 1;
    if (testCode !== 0) err("verify FAILED at: tests");
    else if (!records.length) {
      err("verify FAILED at: tests (the run recorded no tests)");
      code = 1;
    } else if (!fast) {
      out("== test inventory");
      const inv = io.inventory ?? ((a) => inventoryMain(a, { stdout: out, stderr: err, root }));
      if (inv(["--check", "--results", resultsFile]) !== 0) {
        err("verify FAILED at: test inventory");
        code = 1;
      }
    } else {
      out("(the test inventory is checked by the full verify, not the fast one)");
    }
    if (records.length) {
      const failed = records.filter((r) => r.fail).length;
      out(`== ${records.length} tests ran${failed ? `, ${failed} failed` : ""}; the 10 slowest`);
      for (const l of slowestTable(records)) out(l);
    }
    const pack = records.filter((r) => r.file === PACK_FILE);
    if (pack.length) out(`regression pack: ${pack.filter((r) => !r.fail).length} of ${pack.length} tests passed`);
    out(`== ${fast ? "verify:fast" : "verify"} ${code === 0 ? "passed" : "FAILED"} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return code;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
