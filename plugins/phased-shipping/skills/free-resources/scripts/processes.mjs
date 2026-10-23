#!/usr/bin/env node
// Read-only scan: how pressured is this machine, who is using it, and what is safe to consider closing.
// It never closes, kills or signals anything.
//
//   node processes.mjs [--json] [--all] [--top N] [--project <dir>] [--sample-ms N] [--fixture <file>]
//
//   --json            print the report as JSON (schema_version 1) instead of tables
//   --all             also list processes owned by other users (hidden by default)
//   --top N           rows in the top-consumer tables (default 8)
//   --project <dir>   the project folder whose processes count as in use (default: the current folder)
//   --sample-ms N     how long to sample per-process CPU (default 3000, 500 to 30000)
//   --fixture <file>  classify a recorded snapshot (JSON) instead of scanning this machine
import { resolve } from "node:path";
import { scan, UsageError } from "./lib/scan.mjs";
import { renderHuman } from "./lib/report.mjs";
import { DEFAULT_SAMPLE_MS, MIN_SAMPLE_MS, MAX_SAMPLE_MS } from "./lib/rules.mjs";

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node processes.mjs [--json] [--all] [--top N] [--project <dir>] [--sample-ms N] [--fixture <file>]");
  process.exit(2);
}

function parseArgs(argv) {
  const o = { json: false, all: false, top: undefined, project: process.cwd(), sampleMs: DEFAULT_SAMPLE_MS, fixture: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
    if (a === "--json") o.json = true;
    else if (a === "--all") o.all = true;
    else if (a === "--top") o.top = Number(value());
    else if (a === "--project") o.project = resolve(value());
    else if (a === "--sample-ms") o.sampleMs = Number(value());
    else if (a === "--fixture") o.fixture = resolve(value());
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown option ${a}`);
  }
  if (o.top !== undefined && !(Number.isInteger(o.top) && o.top > 0 && o.top <= 100)) usage("--top must be a whole number from 1 to 100");
  if (!Number.isFinite(o.sampleMs) || o.sampleMs < MIN_SAMPLE_MS || o.sampleMs > MAX_SAMPLE_MS) usage(`--sample-ms must be from ${MIN_SAMPLE_MS} to ${MAX_SAMPLE_MS}`);
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let report;
  try {
    report = await scan({ project: opts.project, sampleMs: opts.sampleMs, all: opts.all, top: opts.top, fixture: opts.fixture });
  } catch (e) {
    if (e instanceof UsageError) usage(e.message);
    throw e;
  }
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderHuman(report));
}

main().catch((e) => {
  console.error(`Scan failed: ${e.message}`);
  console.error("Nothing was closed. This scan is read-only.");
  process.exit(1);
});
