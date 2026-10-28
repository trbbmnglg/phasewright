#!/usr/bin/env node
// The test inventory: tests/inventory.txt lists every test by its full name (suite > test) and its status,
// one line each, so a test can't disappear or be skipped without anyone noticing.
//   node scripts/test-inventory.mjs --check [--results <file>]   compare a test run with the inventory
//   node scripts/test-inventory.mjs --write [--results <file>]   regenerate the inventory from a test run
// --results takes the file written by scripts/test-report.mjs. Without it, this script runs every
// tests/*.test.mjs itself (slow), so `npm run verify` passes the results of its own run instead.
// The names are a multiset: a test that moves from one file to another keeps its line.
// --check fails when a listed name is missing, a test is newly skipped, the count drops, or a test is not
// listed yet (run --write and read the diff). It prints exactly what changed.
// --write refuses to record a run that has a failing test, holds no tests, or did not end cleanly (non-zero exit, a signal), and it
// refuses to write over an inventory that has a test the run lost, a test that is newly skipped, or a higher count: it prints those
// and exits 1, unless --allow-removals is given (then it prints the removals loudly and writes). New tests are always fine to add. With no
// inventory to compare with (missing, empty, comments only) it refuses too, so the first inventory is written with --allow-removals.
// --check also fails when the run it started did not end cleanly.
// Some tests run on one platform and skip on another (a Windows-only live test, a test that needs jq). Their line holds one status per
// platform, "linux:skip,win32:run", for the platforms in PLATFORMS (CI runs on Linux). --check compares the status for the platform it runs
// on; names, the count and missing tests are compared the same way everywhere. On a platform outside PLATFORMS, --check fails when any line
// has a status per platform (it has nothing to compare with), and --write refuses. --write changes only this platform's status: the status
// recorded for another platform is kept, and a new test gets this run's status on every platform.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readResults } from "./test-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const INVENTORY = join(ROOT, "tests", "inventory.txt");
const REPORTER = pathToFileURL(join(HERE, "test-report.mjs")).href;
const MAX_LINES = 40;
// The platforms a status can be recorded for, in the order a per-platform status lists them.
export const PLATFORMS = ["linux", "win32"];

const HEADER = [
  "# Test inventory. One line per test: the status, a tab, then the full name (suite > test).",
  "# The status is run or skip on every platform, or one per platform for a test that runs on only some (linux:skip,win32:run).",
  "# Written by `node scripts/test-inventory.mjs --write` (it changes only this platform's status) and checked by `npm run verify`.",
  "# Edit by hand only to record another platform's status: a test that disappears, or is newly skipped, fails the full verify.",
];

// A status as { platform: "run" | "skip" } for every platform in PLATFORMS, or null when it is not a valid status. "run" and "skip" hold
// on every platform. A per-platform status names each platform once, in the order of PLATFORMS, and differs between them (when it is the
// same everywhere it is written "run" or "skip", so each status has one spelling).
export function platformStatuses(status) {
  if (status === "run" || status === "skip") return Object.fromEntries(PLATFORMS.map((p) => [p, status]));
  const parts = String(status).split(",").map((p) => p.split(":"));
  const valid =
    parts.length === PLATFORMS.length &&
    parts.every((part, i) => part.length === 2 && part[0] === PLATFORMS[i] && (part[1] === "run" || part[1] === "skip")) &&
    new Set(parts.map((part) => part[1])).size > 1;
  return valid ? Object.fromEntries(parts) : null;
}

// The status a line expects on one platform, or null when the line has a status per platform and none for this one.
export const statusOn = (status, platform) =>
  status === "run" || status === "skip" ? status : PLATFORMS.includes(platform) ? platformStatuses(status)?.[platform] ?? null : null;

const joinStatus = (byPlatform) => {
  const all = new Set(PLATFORMS.map((p) => byPlatform[p]));
  return all.size === 1 ? [...all][0] : PLATFORMS.map((p) => `${p}:${byPlatform[p]}`).join(",");
};

const perPlatform = (items) => items.filter((i) => i.status !== "run" && i.status !== "skip");

// Records (from test-report.mjs) or inventory items to inventory lines, sorted so the diff shows only what changed.
const lineStatus = (s) => (s !== "run" && platformStatuses(s) ? s : "run");
export const toLines = (records) => records.map((r) => `${lineStatus(r.status)}\t${r.name}`).sort();

export function parseInventory(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    const status = tab < 0 ? "" : line.slice(0, tab);
    if (!platformStatuses(status)) {
      throw new Error(`inventory line is not "run<TAB>name", "skip<TAB>name" or a status per platform (${PLATFORMS.map((p, i) => `${p}:${i ? "run" : "skip"}`).join(",")}<TAB>name, every platform once, in that order, not all the same): ${line.slice(0, 80)}`);
    }
    out.push({ status, name: line.slice(tab + 1) });
  }
  return out;
}

// The inventory --write leaves behind: for each test in the run, the line it had with this platform's status replaced by the run's, and
// for a test that is new, the run's status on every platform. Tests the run lost are dropped (main refuses that without --allow-removals).
// A name can be listed more than once, so the lines of one name are matched with its runs in order, run before skip, to change the fewest.
export function merge(before, records, platform) {
  const rank = (s) => (s === "run" ? 0 : 1);
  const listed = new Map();
  for (const { status, name } of before) listed.set(name, [...(listed.get(name) ?? []), status]);
  const ran = new Map();
  for (const r of records) ran.set(r.name, [...(ran.get(r.name) ?? []), r.status === "skip" ? "skip" : "run"]);
  const out = [];
  for (const [name, now] of ran) {
    const old = (listed.get(name) ?? []).sort((a, b) => rank(statusOn(a, platform)) - rank(statusOn(b, platform)));
    now.sort((a, b) => rank(a) - rank(b)).forEach((s, i) => {
      out.push({ status: i < old.length ? joinStatus({ ...platformStatuses(old[i]), [platform]: s }) : s, name });
    });
  }
  return out;
}

const tally = (items) => {
  const m = new Map();
  for (const { status, name } of items) {
    const t = m.get(name) ?? { run: 0, skip: 0 };
    t[status === "skip" ? "skip" : "run"]++;
    m.set(name, t);
  }
  return m;
};

// What changed between the inventory (expected) and a run (actual) on one platform. Both are lists of { status, name }. A line with a
// status per platform and none for this platform is in noStatus, which fails the check; it still counts for the names and the count.
export function compare(expected, actual, platform = process.platform) {
  const noStatus = [];
  const here = expected.map(({ status, name }) => {
    const s = statusOn(status, platform);
    if (s === null) noStatus.push(name);
    return { status: s ?? "skip", name };
  });
  const e = tally(here);
  const a = tally(actual);
  const missing = [];
  const newlySkipped = [];
  const unlisted = [];
  const nowRuns = [];
  for (const [name, te] of e) {
    const ta = a.get(name) ?? { run: 0, skip: 0 };
    const total = te.run + te.skip;
    const got = ta.run + ta.skip;
    for (let i = got; i < total; i++) missing.push(name);
    if (ta.skip > te.skip) for (let i = te.skip; i < Math.min(ta.skip, got); i++) newlySkipped.push(name);
    if (ta.skip < te.skip && got >= total) for (let i = ta.skip; i < te.skip; i++) nowRuns.push(name);
  }
  for (const [name, ta] of a) {
    const te = e.get(name) ?? { run: 0, skip: 0 };
    for (let i = te.run + te.skip; i < ta.run + ta.skip; i++) unlisted.push(name);
  }
  const unchecked = new Set(noStatus);
  return {
    missing,
    newlySkipped,
    unlisted,
    nowRuns: nowRuns.filter((n) => !unchecked.has(n)),
    noStatus,
    expectedCount: expected.length,
    actualCount: actual.length,
    ok: !missing.length && !newlySkipped.length && !unlisted.length && !noStatus.length && actual.length >= expected.length,
  };
}

const show = (title, names, out) => {
  if (!names.length) return;
  out(`${title} (${names.length}):`);
  for (const n of names.slice(0, MAX_LINES)) out(`  ${n}`);
  if (names.length > MAX_LINES) out(`  ... and ${names.length - MAX_LINES} more`);
};

// Runs every test file once, reporting only to a results file; returns that file's records and how node ended (exit status, signal).
function runAllTests(root) {
  const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
  try {
    const file = join(dir, "results.jsonl");
    const tests = readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join("tests", f));
    const r = spawnSync(process.execPath, ["--test", `--test-reporter=${REPORTER}`, `--test-reporter-destination=${file}`, ...tests], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    if (r.error) throw r.error;
    return { records: existsSync(file) ? readResults(file) : [], status: r.status, signal: r.signal };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s + "\n"));
  const err = io.stderr ?? ((s) => process.stderr.write(s + "\n"));
  const root = io.root ?? ROOT;
  const inventoryFile = io.inventory ?? INVENTORY;
  const mode = argv.includes("--check") ? "check" : argv.includes("--write") ? "write" : "";
  const allowRemovals = argv.includes("--allow-removals");
  if (!mode || (argv.includes("--check") && argv.includes("--write")) || (allowRemovals && mode !== "write")) {
    err("usage: node scripts/test-inventory.mjs --check | --write [--allow-removals] [--results <file>]");
    return 2;
  }
  const ri = argv.indexOf("--results");
  if (ri >= 0 && !argv[ri + 1]) {
    err("--results needs a file");
    return 2;
  }
  const platform = io.platform ?? process.platform;
  if (mode === "write" && !PLATFORMS.includes(platform)) {
    err(`not writing the inventory: it records statuses for ${PLATFORMS.join(" and ")}, and this platform is ${platform}`);
    return 1;
  }
  let records;
  let ended = { status: 0, signal: null }; // how the node --test run ended, when this script ran it
  try {
    if (ri >= 0) records = readResults(argv[ri + 1]);
    else {
      const ran = (io.runTests ?? runAllTests)(root);
      records = Array.isArray(ran) ? ran : ran.records;
      if (!Array.isArray(ran)) ended = { status: ran.status, signal: ran.signal ?? null };
    }
  } catch (e) {
    err(`cannot read the test results: ${e.message}`);
    return 2;
  }
  if (ended.status !== 0 || ended.signal) {
    err(`the test run did not end cleanly (${ended.signal ? `signal ${ended.signal}` : `exit status ${ended.status}`}), so its list of tests cannot be trusted: nothing was ${mode === "write" ? "written" : "checked"}`);
    return 1;
  }
  const failed = records.filter((r) => r.fail);
  if (mode === "write") {
    if (failed.length) {
      err(`not writing the inventory: ${failed.length} test(s) failed in this run`);
      return 1;
    }
    if (!records.length) {
      err("not writing the inventory: the run holds no tests");
      return 1;
    }
    // Compare with the inventory that is there: a test that is gone or newly skipped, or a lower count, is not written over silently. With no
    // inventory to compare with (the file is missing, empty or holds only comments) nothing can be compared, so that needs --allow-removals too.
    let before = [];
    if (existsSync(inventoryFile)) {
      try {
        before = parseInventory(readFileSync(inventoryFile, "utf8"));
      } catch (e) {
        err(`cannot read the inventory: ${e.message}`);
        return 2;
      }
    }
    if (!before.length) {
      if (!allowRemovals) {
        err("not writing the inventory: there is no inventory to compare with (the file is missing, empty or holds only comments). If this is the first one, run --write --allow-removals");
        return 1;
      }
      out("NO INVENTORY TO COMPARE WITH: writing a new one (--allow-removals)");
    } else {
      const c = compare(before, records.map((r) => ({ status: r.status, name: r.name })), platform);
      const removed = c.missing.length + c.newlySkipped.length;
      if (removed || records.length < before.length) {
        show("missing from this run", c.missing, out);
        show("newly skipped", c.newlySkipped, out);
        if (records.length < before.length) out(`the count dropped: ${before.length} listed, ${records.length} ran`);
        if (!allowRemovals) {
          err("not writing the inventory: a listed test is missing or newly skipped, or the count dropped. If the removal is on purpose, run --write --allow-removals");
          return 1;
        }
        out(`REMOVALS ALLOWED: ${c.missing.length} missing and ${c.newlySkipped.length} newly skipped test(s) are dropped from the inventory (--allow-removals)`);
      }
    }
    const items = merge(before, records, platform);
    const lines = toLines(items);
    writeFileSync(inventoryFile, [...HEADER, `# tests: ${lines.length}`, ...lines, ""].join("\n"));
    const split = perPlatform(items).length;
    out(`inventory written: ${lines.length} tests (${items.filter((i) => statusOn(i.status, platform) === "skip").length} skipped${split ? ` on ${platform}, ${split} with a status per platform` : ""})`);
    return 0;
  }
  let expected;
  try {
    expected = parseInventory(readFileSync(inventoryFile, "utf8"));
  } catch (e) {
    err(`cannot read the inventory: ${e.message}`);
    return 2;
  }
  const actual = records.map((r) => ({ status: r.status, name: r.name }));
  const c = compare(expected, actual, platform);
  show("missing from this run", c.missing, out);
  show("newly skipped", c.newlySkipped, out);
  show("not in the inventory (run --write and read the diff)", c.unlisted, out);
  show("now run, listed as skipped (run --write to record it)", c.nowRuns, out);
  show(`no status for ${platform}: these have a status per platform, for ${PLATFORMS.join(" and ")} only`, c.noStatus, out);
  if (actual.length < expected.length) out(`the count dropped: ${expected.length} listed, ${actual.length} ran`);
  const split = perPlatform(expected).length;
  if (c.ok) out(`inventory ok: ${actual.length} tests, none missing, none newly skipped${split ? ` (${split} with a status per platform, checked for ${platform})` : ""}`);
  else err("inventory check FAILED");
  return c.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
