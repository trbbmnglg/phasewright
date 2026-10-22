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
  console.log("Use the multiplier on raw estimates (show raw -> calibrated). Prefer the cheapest build model with a strong first-pass rate for that kind of work.");
} else {
  console.error("usage: history.mjs stats <file> | record <file> '<json>' | record <file> --from <json-file>");
  process.exit(1);
}
