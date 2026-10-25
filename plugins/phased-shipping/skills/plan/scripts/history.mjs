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
// Optional: tokens { builder, checker, shipper, model_scout }, each a non-negative integer:
// the agent tokens used for the phase. The main session's own tokens aren't counted.
// Optional: guard (active|inactive|unknown): whether the guard hook was active in that run, from the
// checker's probe. An organization policy can turn hooks off, so "inactive" is a normal answer.
// Optional: caught_by, an array with one entry per fix round or rollback, in order. Each entry is one of
// builder-self, compare, own-review, security-review, browser-check, prod-check (the check that found the
// problem). Its length must equal check_rounds plus 1 if rolled_back is true. Old records without it stay valid.
// actual_h is computed as agent time: (previewed - started) + (shipped - approved),
// so time spent waiting for the user's approval doesn't count.

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [cmd, file, ...rest] = process.argv.slice(2);
const json = rest[0] === "--from" ? (rest[1] && existsSync(rest[1]) ? readFileSync(rest[1], "utf8") : undefined) : rest[0];

const hours = (a, b) => (Date.parse(b) - Date.parse(a)) / 36e5;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const TOKEN_KEYS = ["builder", "checker", "shipper", "model_scout"];
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

if (cmd === "record") {
  if (!file || !json) { console.error("usage: history.mjs record <file> '<json>' | record <file> --from <json-file>"); process.exit(1); }
  const r = JSON.parse(json);
  for (const k of ["project", "phase", "est_h", "build_model"]) {
    if (r[k] === undefined) { console.error(`missing field: ${k}`); process.exit(1); }
  }
  if (r.tokens !== undefined) {
    const t = r.tokens;
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      console.error(`invalid field: tokens must be an object like { "builder": 120000 }, allowed keys: ${TOKEN_KEYS.join(", ")}`);
      process.exit(1);
    }
    for (const [k, v] of Object.entries(t)) {
      if (!TOKEN_KEYS.includes(k)) { console.error(`invalid field: tokens.${k} is not a known agent (allowed: ${TOKEN_KEYS.join(", ")})`); process.exit(1); }
      if (!Number.isInteger(v) || v < 0) { console.error(`invalid field: tokens.${k} must be a non-negative integer (got ${JSON.stringify(v)})`); process.exit(1); }
    }
  }
  if (r.guard !== undefined && !GUARD_VALUES.includes(r.guard)) {
    console.error(`invalid field: guard must be one of ${GUARD_VALUES.join(", ")} (got ${JSON.stringify(r.guard)})`);
    process.exit(1);
  }
  if (r.caught_by !== undefined) {
    const want = (Number.isInteger(r.check_rounds) ? r.check_rounds : 0) + (r.rolled_back === true ? 1 : 0);
    const allowed = `allowed: ${CAUGHT_BY.join(", ")}`;
    if (!Array.isArray(r.caught_by)) {
      console.error(`invalid field: caught_by must be an array like ["compare"], one entry per fix round or rollback (${allowed})`);
      process.exit(1);
    }
    const at = r.caught_by.findIndex((v) => !CAUGHT_BY.includes(v));
    if (at >= 0) {
      console.error(`invalid field: caught_by has an unknown value ${JSON.stringify(r.caught_by[at])} (${allowed})`);
      process.exit(1);
    }
    if (r.caught_by.length !== want) {
      console.error(`invalid field: caught_by has ${r.caught_by.length} entries but check_rounds plus rollback is ${want}`);
      process.exit(1);
    }
  }
  if (r.actual_h === undefined && r.started && r.previewed && r.approved && r.shipped) {
    r.actual_h = +(hours(r.started, r.previewed) + hours(r.approved, r.shipped)).toFixed(2);
  }
  r.date ??= new Date().toISOString().slice(0, 10);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(r) + "\n");
  console.log(`recorded ${r.project} phase ${r.phase}: est ${r.est_h} h, actual ${r.actual_h ?? "?"} h`);
} else if (cmd === "stats") {
  const rows = load(file ?? "");
  const timed = rows.filter((r) => r.est_h > 0 && r.actual_h > 0);
  if (!timed.length) {
    console.log("No phase history yet: estimates are uncalibrated. Say so in the roadmap.");
    process.exit(0);
  }
  const ratio = (rs) => median(rs.map((r) => r.actual_h / r.est_h)).toFixed(2);
  console.log(`Phases recorded: ${rows.length} (${timed.length} timed)`);
  console.log(`Estimate multiplier (median actual/estimate): x${ratio(timed)}`);
  const kinds = [...new Set(timed.map((r) => r.kind).filter(Boolean))];
  for (const k of kinds) {
    const rs = timed.filter((r) => r.kind === k);
    if (rs.length >= 2) console.log(`  ${k}: x${ratio(rs)} over ${rs.length} phases`);
  }
  console.log("Build model outcomes (first-pass checks / first-pass prod / rollbacks):");
  const combos = [...new Set(rows.map((r) => `${r.build_model} (${r.build_effort ?? "?"}) as ${r.runs_as ?? "?"}`))];
  for (const c of combos) {
    const rs = rows.filter((r) => `${r.build_model} (${r.build_effort ?? "?"}) as ${r.runs_as ?? "?"}` === c);
    const first = rs.filter((r) => (r.check_rounds ?? 0) === 0).length;
    const prod = rs.filter((r) => r.prod_first_pass === true).length;
    const back = rs.filter((r) => r.rolled_back === true).length;
    console.log(`  ${c}: ${pct(first, rs.length)} / ${pct(prod, rs.length)} / ${back} over ${rs.length}`);
  }
  const withTokens = rows.filter((r) => r.tokens && typeof r.tokens === "object");
  if (withTokens.length) {
    const totals = withTokens.map((r) => TOKEN_KEYS.reduce((sum, k) => sum + (Number.isInteger(r.tokens[k]) ? r.tokens[k] : 0), 0));
    console.log(`Agent tokens per phase: median ${Math.round(median(totals))} (tokens recorded on ${withTokens.length} of ${rows.length} phases; main session not counted)`);
  }
  const withGuard = rows.filter((r) => GUARD_VALUES.includes(r.guard));
  if (withGuard.length) console.log(`Guard active on ${withGuard.filter((r) => r.guard === "active").length} of ${withGuard.length} phases`);
  const withCaught = rows.filter((r) => Array.isArray(r.caught_by));
  if (withCaught.length) {
    const counts = CAUGHT_BY.map((k) => `${k} ${withCaught.reduce((n, r) => n + r.caught_by.filter((v) => v === k).length, 0)}`);
    const clean = withCaught.filter((r) => r.caught_by.length === 0).length;
    console.log(`Caught by (phases with caught_by recorded: ${withCaught.length} of ${rows.length}; ${clean} needed no fix): ${counts.join(", ")}`);
    console.log(`Conditional compare needs ${COMPARE_NEEDS} phases with caught_by recorded (${withCaught.length} so far)`);
  }
  console.log("Use the multiplier on raw estimates (show raw -> calibrated). Prefer the cheapest build model with a strong first-pass rate for that kind of work.");
} else {
  console.error("usage: history.mjs stats <file> | record <file> '<json>' | record <file> --from <json-file>");
  process.exit(1);
}
