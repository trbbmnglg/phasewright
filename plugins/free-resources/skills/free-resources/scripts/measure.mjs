#!/usr/bin/env node
// Runs your own command and records what it really needed: peak memory of the command and everything it
// starts, and how many CPU cores it used. It never closes, kills or signals any process other than the
// sampler's own helper children (ended through their handles in lib/sampler.mjs).
//
//   node measure.mjs [--task <name>] [--interval-ms N] [--json] -- <command...>
//
//   --task <name>      the name the result is stored under (default: the command's first two words @ the folder name)
//   --interval-ms N    how often the process tree is sampled (default 2000, at least 500)
//   --json             print the record as JSON instead of one summary line (on stderr either way)
//   -- <command...>    the command to run, exactly as you would type it; its exit code becomes this script's
//
// The command keeps your terminal (stdin, stdout and stderr are passed straight through). Press Ctrl+C
// once to stop it: the terminal sends Ctrl+C to the command itself, and this script waits, records the
// run and exits with the command's exit code. Press it a second time to leave without waiting.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createSampler } from "./lib/sampler.mjs";
import { appendPeak, summarizeCommand, taskKey, PEAK_SCHEMA_VERSION } from "./lib/peaks.mjs";
import { relativizePaths } from "./lib/snapshot.mjs";
import { warnIfInsideSkillDir } from "./lib/skilldir.mjs";
import { TREE_INTERVAL_MS, MACHINE_INTERVAL_MS, MIN_TREE_INTERVAL_MS } from "./lib/rules.mjs";

const USAGE = "usage: node measure.mjs [--task <name>] [--interval-ms N] [--json] -- <command...>";

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

export function parseArgs(argv) {
  const o = { task: null, intervalMs: TREE_INTERVAL_MS, json: false, command: [] };
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  o.command = sep === -1 ? [] : argv.slice(sep + 1);
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    const value = () => (i + 1 < own.length ? own[++i] : usage(`${a} needs a value`));
    if (a === "--task") o.task = value();
    else if (a === "--interval-ms") o.intervalMs = Number(value());
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown option ${a}`);
  }
  if (!o.command.length) usage("no command given: put it after --");
  if (!Number.isInteger(o.intervalMs) || o.intervalMs < MIN_TREE_INTERVAL_MS || o.intervalMs > 60000) usage(`--interval-ms must be a whole number from ${MIN_TREE_INTERVAL_MS} to 60000`);
  return o;
}

// On Windows the command runs through cmd.exe so that npm, npx and other .cmd files resolve. Each argument
// is quoted separately, so what you typed is what runs and nothing else is added.
export function windowsCommandLine(argv) {
  return argv.map((a) => (/^[\w\-.:\\/=@%+,]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`)).join(" ");
}

const fmt = (v, unit = "") => (v == null ? "n/a" : `${v}${unit}`);

async function main() {
  warnIfInsideSkillDir();
  const opts = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32" && process.platform !== "darwin") usage(`Platform ${process.platform} is not supported. Windows and macOS only.`);
  const home = homedir();
  const project = process.cwd();
  const key = taskKey({ task: opts.task, argv: opts.command, project, home });

  const startedAt = Date.now();
  const child = process.platform === "win32"
    ? spawn(windowsCommandLine(opts.command), [], { shell: true, stdio: "inherit" })
    : spawn(opts.command[0], opts.command.slice(1), { stdio: "inherit" });

  // Ctrl+C reaches the command from the terminal itself (same console or process group). This script must
  // outlive it to record the run, so the first Ctrl+C is only noted; a second one leaves without waiting.
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
  });

  const exit = new Promise((resolve) => {
    child.once("error", (e) => resolve({ code: 127, error: e.message }));
    child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal }));
  });

  let sampler = null;
  if (child.pid) {
    sampler = createSampler({ rootPid: child.pid, treeIntervalMs: opts.intervalMs, machineIntervalMs: MACHINE_INTERVAL_MS });
    sampler.start();
  }
  const { code, error } = await exit;
  const duration_s = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;
  const result = sampler ? await sampler.stop() : { warnings: [], tree_samples: 0, machine_samples: 0 };

  if (error) {
    console.error(`free-resources: the command could not start: ${error}. Nothing was recorded.`);
    process.exit(code);
  }

  const record = {
    schema_version: PEAK_SCHEMA_VERSION,
    key,
    cmd_summary: summarizeCommand(opts.command, { home }),
    project: basename(project),
    started_iso: new Date(startedAt).toISOString(),
    duration_s,
    exit_code: code,
    peak_tree_mb: result.peak_tree_mb ?? null,
    peak_avail_drop_mb: result.peak_avail_drop_mb ?? null,
    avg_cpu_cores: result.avg_cpu_cores ?? null,
    peak_cpu_cores: result.peak_cpu_cores ?? null,
    samples: result.tree_samples,
    // How long after the command started the first tree sample arrived: PowerShell can take 15 s to start on
    // a busy machine, and anything the command used before that moment is not in the peaks.
    sampled_from_s: result.first_tree_t ? Math.max(0, Math.round(((result.first_tree_t - startedAt) / 1000) * 10) / 10) : null,
    machine_samples: result.machine_samples,
    interval_ms: opts.intervalMs,
    platform: process.platform,
    sampler_overhead_pct: result.sampler_overhead_pct ?? null,
    sampler_startup_cpu_s: result.sampler_startup_cpu_s ?? null,
  };
  let file = null;
  try {
    file = appendPeak(record, { home });
  } catch (e) {
    console.error(`free-resources: the result could not be saved: ${e.message}`);
  }

  if (opts.json) console.error(JSON.stringify({ ...record, warnings: result.warnings, file: file && relativizePaths(file, home) }, null, 2));
  else {
    console.error(
      `free-resources: ${key}: ${duration_s} s, exit ${code}, peak tree memory ${fmt(record.peak_tree_mb, " MB")}, machine available-memory drop ${fmt(record.peak_avail_drop_mb, " MB")}, ` +
        `CPU ${fmt(record.avg_cpu_cores, " cores")} average and ${fmt(record.peak_cpu_cores, " cores")} peak, ${record.samples} tree sample(s) from ${fmt(record.sampled_from_s, " s")} in, sampler cost ${fmt(record.sampler_overhead_pct, "% of one core")}.`,
    );
    for (const w of result.warnings ?? []) console.error(`free-resources: note: ${w}`);
    if (file) console.error(`free-resources: saved to ${relativizePaths(file, home)}`);
  }
  process.exit(code);
}

// Run only when started as a script, so tests can import parseArgs and windowsCommandLine.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`free-resources: measuring failed: ${e.message}`);
    process.exit(1);
  });
}
