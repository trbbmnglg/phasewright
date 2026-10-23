#!/usr/bin/env node
// Compares what a task needs (measured by measure.mjs) with what is free right now (the read-only scan),
// shows the arithmetic, and names the smallest set of "Suggest closing" processes that would cover a memory
// shortfall. A report only: it never closes, kills or signals anything.
//
//   node headroom.mjs --task <name> [--json] [--project <dir>] [--sample-ms N] [--fixture <file>]
//   node headroom.mjs [--json] [--project <dir>] -- <command...>     (the task name is worked out as measure.mjs does)
//
//   --task <name>     the name the task was measured under
//   --json            print the result as JSON (schema_version 1)
//   --project <dir>   the project folder whose processes count as in use (default: the current folder)
//   --sample-ms N     how long the scan samples per-process CPU (default 3000, 500 to 30000)
//   --fixture <file>  use a recorded scan snapshot (JSON, as processes.mjs accepts) instead of scanning
//
// Exit codes: 0 report printed (whether it fits or not), 2 bad options, 3 no data yet for this task.
import { resolve } from "node:path";
import { homedir } from "node:os";
import { scan, UsageError } from "./lib/scan.mjs";
import { readLast, taskKey } from "./lib/peaks.mjs";
import { computeHeadroom, renderHeadroom } from "./lib/headroom.mjs";
import { DEFAULT_SAMPLE_MS, MIN_SAMPLE_MS, MAX_SAMPLE_MS, PEAKS_WINDOW } from "./lib/rules.mjs";
import { READ_ONLY_LINE } from "./lib/report.mjs";
import { warnIfInsideSkillDir } from "./lib/skilldir.mjs";

const USAGE = "usage: node headroom.mjs --task <name> [--json] [--project <dir>] [--sample-ms N] [--fixture <file>]";

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const o = { task: null, json: false, project: process.cwd(), sampleMs: DEFAULT_SAMPLE_MS, fixture: null, command: [] };
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  o.command = sep === -1 ? [] : argv.slice(sep + 1);
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    const value = () => (i + 1 < own.length ? own[++i] : usage(`${a} needs a value`));
    if (a === "--task") o.task = value();
    else if (a === "--json") o.json = true;
    else if (a === "--project") o.project = resolve(value());
    else if (a === "--sample-ms") o.sampleMs = Number(value());
    else if (a === "--fixture") o.fixture = resolve(value());
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown option ${a}`);
  }
  if (!o.task && !o.command.length) usage("--task <name> is required (or give the command after --)");
  if (o.task !== null && !o.task.trim()) usage("--task needs a name");
  if (!Number.isFinite(o.sampleMs) || o.sampleMs < MIN_SAMPLE_MS || o.sampleMs > MAX_SAMPLE_MS) usage(`--sample-ms must be from ${MIN_SAMPLE_MS} to ${MAX_SAMPLE_MS}`);
  return o;
}

async function main() {
  warnIfInsideSkillDir();
  const opts = parseArgs(process.argv.slice(2));
  const home = homedir();
  const key = taskKey({ task: opts.task, argv: opts.command, project: opts.project, home });
  const peaks = readLast(key, PEAKS_WINDOW, { home });

  // No measurement: say so and stop. There is no point scanning when nothing can be recommended.
  if (!peaks.length) {
    const result = computeHeadroom({ key, peaks });
    console.log(opts.json ? JSON.stringify(result, null, 2) : renderHeadroom(result));
    process.exit(3);
  }

  let report;
  try {
    report = await scan({ project: opts.project, sampleMs: opts.sampleMs, fixture: opts.fixture });
  } catch (e) {
    if (e instanceof UsageError) usage(e.message);
    throw e;
  }
  const result = computeHeadroom({ key, peaks, report });
  if (result.status === "no_data") {
    console.log(opts.json ? JSON.stringify(result, null, 2) : renderHeadroom(result));
    process.exit(3);
  }
  console.log(opts.json ? JSON.stringify(result, null, 2) : renderHeadroom(result, { platform: report.platform, generatedIso: report.generated_iso }));
}

main().catch((e) => {
  console.error(`Headroom check failed: ${e.message}`);
  console.error(READ_ONLY_LINE.replace("scan", "check"));
  process.exit(1);
});
