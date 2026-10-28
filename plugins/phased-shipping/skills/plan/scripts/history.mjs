#!/usr/bin/env node
// Phase history: calibrates estimates and model picks from what actually happened.
//
//   node history.mjs stats  <history.jsonl>          summary for planning (always exits 0)
//   node history.mjs record <history.jsonl> '<json>' append one shipped phase
//   node history.mjs record <history.jsonl> --from <json-file>  same, JSON read from a file
//
// Record fields: project, phase, kind (ui|backend|data|infra|docs|mixed), est_h,
// started, previewed, approved, shipped (ISO times), build_model, build_effort,
// runs_as (main|builder), check_rounds, prod_first_pass, rolled_back.
// Optional: tokens { builder, checker, shipper, model_scout, reviewer }, each a non-negative integer:
// the agent tokens used for the phase (reviewer: every security-review agent). The main session's own tokens aren't counted.
// Optional: timings { baseline_s, checks_s, review_s, ship_s, full_runs, fast_runs, reviews }, each a non-negative
// safe integer (seconds, or a count of runs), and no other key. The same holds for every tokens value. baseline_s is 0 for a reused baseline; full_runs
// counts every full verify run, including a baseline that ran. Optional: baseline_reused, a boolean: the
// baseline was skipped because a green full verify on the same tree was reused. Old records without these stay valid.
// stats prints, over the phases that have timings: the median seconds per kind (baseline, checks, review, ship), the median full runs per
// phase, and "baselines reused k of m".
// Optional: guard (active|inactive|unknown): whether the guard hook was active in that run, from the
// checker's probe. An organization policy can turn hooks off, so "inactive" is a normal answer.
// Optional: caught_by, an array with one entry per fix round or rollback, in order. Each entry is one of
// builder-self, compare, own-review, security-review, browser-check, prod-check (the check that found the
// problem). Its length must equal check_rounds plus 1 if rolled_back is true. Old records without it stay valid.
// v: the record's schema version, a positive integer. `record` adds v: 1 when it is missing. `stats` and the
// loader don't read it, so records written before it existed are read as before.
// actual_h is computed as agent time: (previewed - started) + (shipped - approved),
// so time spent waiting for the user's approval doesn't count.

import { readFileSync, appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hours = (a, b) => (Date.parse(b) - Date.parse(a)) / 36e5;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const TOKEN_KEYS = ["builder", "checker", "shipper", "model_scout", "reviewer"];
const TIMING_KEYS = ["baseline_s", "checks_s", "review_s", "full_runs", "fast_runs", "reviews", "ship_s"];
const GUARD_VALUES = ["active", "inactive", "unknown"];
const CAUGHT_BY = ["builder-self", "compare", "own-review", "security-review", "browser-check", "prod-check"];
const COMPARE_NEEDS = 15;
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

function load(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// main(argv, io) is the command: argv is the arguments after the script name, io.out and io.err print a line (default: the
// console), and the return value is the exit code. Tests call it in this process; running the file as a script does the same.
export function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  const [cmd, file, ...rest] = argv;
  const json = rest[0] === "--from" ? (rest[1] && existsSync(rest[1]) ? readFileSync(rest[1], "utf8") : undefined) : rest[0];
  if (cmd === "record") {
    if (!file || !json) { err("usage: history.mjs record <file> '<json>' | record <file> --from <json-file> (optional fields: tokens, guard, caught_by, timings, baseline_reused)"); return 1; }
    const r = JSON.parse(json);
    for (const k of ["project", "phase", "est_h", "build_model"]) {
      if (r[k] === undefined) { err(`missing field: ${k}`); return 1; }
    }
    if (r.tokens !== undefined) {
      const t = r.tokens;
      if (t === null || typeof t !== "object" || Array.isArray(t)) {
        err(`invalid field: tokens must be an object like { "builder": 120000 }, allowed keys: ${TOKEN_KEYS.join(", ")}`);
        return 1;
      }
      for (const [k, v] of Object.entries(t)) {
        if (!TOKEN_KEYS.includes(k)) { err(`invalid field: tokens.${k} is not a known agent (allowed: ${TOKEN_KEYS.join(", ")})`); return 1; }
        if (!Number.isSafeInteger(v) || v < 0) { err(`invalid field: tokens.${k} must be a non-negative integer (got ${JSON.stringify(v)})`); return 1; }
      }
    }
    if (r.timings !== undefined) {
      const t = r.timings;
      if (t === null || typeof t !== "object" || Array.isArray(t)) {
        err(`invalid field: timings must be an object like { "baseline_s": 120 }, allowed keys: ${TIMING_KEYS.join(", ")}`);
        return 1;
      }
      for (const [k, v] of Object.entries(t)) {
        if (!TIMING_KEYS.includes(k)) { err(`invalid field: timings.${k} is not a known key (allowed: ${TIMING_KEYS.join(", ")})`); return 1; }
        if (!Number.isSafeInteger(v) || v < 0) { err(`invalid field: timings.${k} must be a non-negative integer (got ${JSON.stringify(v)})`); return 1; }
      }
    }
    if (r.baseline_reused !== undefined && typeof r.baseline_reused !== "boolean") {
      err(`invalid field: baseline_reused must be true or false (got ${JSON.stringify(r.baseline_reused)})`);
      return 1;
    }
    if (r.guard !== undefined && !GUARD_VALUES.includes(r.guard)) {
      err(`invalid field: guard must be one of ${GUARD_VALUES.join(", ")} (got ${JSON.stringify(r.guard)})`);
      return 1;
    }
    if (r.caught_by !== undefined) {
      const want = (Number.isInteger(r.check_rounds) ? r.check_rounds : 0) + (r.rolled_back === true ? 1 : 0);
      const allowed = `allowed: ${CAUGHT_BY.join(", ")}`;
      if (!Array.isArray(r.caught_by)) {
        err(`invalid field: caught_by must be an array like ["compare"], one entry per fix round or rollback (${allowed})`);
        return 1;
      }
      const at = r.caught_by.findIndex((v) => !CAUGHT_BY.includes(v));
      if (at >= 0) {
        err(`invalid field: caught_by has an unknown value ${JSON.stringify(r.caught_by[at])} (${allowed})`);
        return 1;
      }
      if (r.caught_by.length !== want) {
        err(`invalid field: caught_by has ${r.caught_by.length} entries but check_rounds plus rollback is ${want}`);
        return 1;
      }
    }
    r.v ??= 1;
    if (!Number.isInteger(r.v) || r.v < 1) {
      err("invalid field: v must be a positive integer");
      return 1;
    }
    if (r.actual_h === undefined && r.started && r.previewed && r.approved && r.shipped) {
      r.actual_h = +(hours(r.started, r.previewed) + hours(r.approved, r.shipped)).toFixed(2);
    }
    r.date ??= new Date().toISOString().slice(0, 10);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(r) + "\n");
    out(`recorded ${r.project} phase ${r.phase}: est ${r.est_h} h, actual ${r.actual_h ?? "?"} h`);
  } else if (cmd === "stats") {
    const rows = load(file ?? "");
    const timed = rows.filter((r) => r.est_h > 0 && r.actual_h > 0);
    if (!timed.length) {
      out("No phase history yet: estimates are uncalibrated. Say so in the roadmap.");
      return 0;
    }
    const ratio = (rs) => median(rs.map((r) => r.actual_h / r.est_h)).toFixed(2);
    out(`Phases recorded: ${rows.length} (${timed.length} timed)`);
    out(`Estimate multiplier (median actual/estimate): x${ratio(timed)}`);
    const kinds = [...new Set(timed.map((r) => r.kind).filter(Boolean))];
    for (const k of kinds) {
      const rs = timed.filter((r) => r.kind === k);
      if (rs.length >= 2) out(`  ${k}: x${ratio(rs)} over ${rs.length} phases`);
    }
    out("Build model outcomes (first-pass checks / first-pass prod / rollbacks):");
    const combos = [...new Set(rows.map((r) => `${r.build_model} (${r.build_effort ?? "?"}) as ${r.runs_as ?? "?"}`))];
    for (const c of combos) {
      const rs = rows.filter((r) => `${r.build_model} (${r.build_effort ?? "?"}) as ${r.runs_as ?? "?"}` === c);
      const first = rs.filter((r) => (r.check_rounds ?? 0) === 0).length;
      const prod = rs.filter((r) => r.prod_first_pass === true).length;
      const back = rs.filter((r) => r.rolled_back === true).length;
      out(`  ${c}: ${pct(first, rs.length)} / ${pct(prod, rs.length)} / ${back} over ${rs.length}`);
    }
    const withTokens = rows.filter((r) => r.tokens && typeof r.tokens === "object");
    if (withTokens.length) {
      const totals = withTokens.map((r) => TOKEN_KEYS.reduce((sum, k) => sum + (Number.isSafeInteger(r.tokens[k]) ? r.tokens[k] : 0), 0));
      out(`Agent tokens per phase: median ${Math.round(median(totals))} (tokens recorded on ${withTokens.length} of ${rows.length} phases; main session not counted)`);
    }
    const withGuard = rows.filter((r) => GUARD_VALUES.includes(r.guard));
    if (withGuard.length) out(`Guard active on ${withGuard.filter((r) => r.guard === "active").length} of ${withGuard.length} phases`);
    const withCaught = rows.filter((r) => Array.isArray(r.caught_by));
    if (withCaught.length) {
      const counts = CAUGHT_BY.map((k) => `${k} ${withCaught.reduce((n, r) => n + r.caught_by.filter((v) => v === k).length, 0)}`);
      const clean = withCaught.filter((r) => r.caught_by.length === 0).length;
      out(`Caught by (phases with caught_by recorded: ${withCaught.length} of ${rows.length}; ${clean} needed no fix): ${counts.join(", ")}`);
      out(`Conditional compare needs ${COMPARE_NEEDS} phases with caught_by recorded (${withCaught.length} so far)`);
    }
    // A record counts only if it has at least one valid timings value (a known key holding a non-negative safe integer).
    const withTimings = rows.filter((r) => r.timings !== null && typeof r.timings === "object" && !Array.isArray(r.timings)
      && TIMING_KEYS.some((k) => Number.isSafeInteger(r.timings[k]) && r.timings[k] >= 0));
    if (withTimings.length) {
      const nums = (key) => withTimings.map((r) => r.timings[key]).filter((v) => Number.isSafeInteger(v) && v >= 0);
      const kinds = [["baseline", "baseline_s"], ["checks", "checks_s"], ["review", "review_s"], ["ship", "ship_s"]]
        .map(([label, key]) => [label, nums(key)])
        .filter(([, xs]) => xs.length)
        .map(([label, xs]) => `${label} ${Math.round(median(xs))} s`);
      out(`Timings (phases with timings recorded: ${withTimings.length} of ${rows.length}): median ${kinds.length ? kinds.join(", ") : "none recorded"}`);
      const fulls = nums("full_runs");
      if (fulls.length) out(`Full runs per phase: median ${median(fulls)} (over ${fulls.length} phases with timings)`);
      out(`Baselines reused ${withTimings.filter((r) => r.baseline_reused === true).length} of ${withTimings.length}`);
    }
    out("Use the multiplier on raw estimates (show raw -> calibrated). Prefer the cheapest build model with a strong first-pass rate for that kind of work.");
  } else {
    err("usage: history.mjs stats <file> | record <file> '<json>' | record <file> --from <json-file> (stats also prints timings, full runs and reused baselines when records have them)");
    return 1;
  }

  return 0;
}

// Run as a script, not when a test imports it. Both paths are resolved through links (a symbolic link or a
// junction to this folder gives a different argv[1] than the module's own path), so the script still runs.
const realOf = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
