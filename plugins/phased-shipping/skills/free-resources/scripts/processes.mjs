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
import { readFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { collect, listeningPids, logicalCpus } from "./lib/snapshot.mjs";
import { measure, verdict } from "./lib/pressure.mjs";
import { classify } from "./lib/classify.mjs";
import { buildReport, renderHuman } from "./lib/report.mjs";
import { loadLocalProtected, DEFAULT_SAMPLE_MS, MIN_SAMPLE_MS, MAX_SAMPLE_MS } from "./lib/rules.mjs";

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

// A fixture is a recorded snapshot: { platform, me, home, logical_cpus, now_iso, pressure, listening, gone_paths, records }.
// Records need pid, ppid, name; everything else has a default.
function loadFixture(file) {
  if (!existsSync(file)) usage(`fixture not found: ${file}`);
  const f = JSON.parse(readFileSync(file, "utf8"));
  const records = (f.records ?? []).map((r) => ({
    pid: r.pid, ppid: r.ppid ?? 0, name: r.name, exe: r.exe ?? null, owner: r.owner ?? null,
    cmd_summary: r.cmd_summary ?? r.name, rss_mb: r.rss_mb ?? 0, cpu_s_total: r.cpu_s_total ?? 0, start_iso: r.start_iso ?? null,
    cmd_full: r.cmd_full ?? r.cmd_summary ?? null, cpu_pct: r.cpu_pct ?? null,
  }));
  const pr = f.pressure ?? {};
  const avail_pct = pr.total_mb ? (pr.avail_mb / pr.total_mb) * 100 : null;
  const measures = { total_mb: pr.total_mb ?? null, avail_mb: pr.avail_mb ?? null, avail_pct: avail_pct == null ? null : Math.round(avail_pct * 10) / 10, paging_per_s: pr.paging_per_s ?? null, cpu_pct: pr.cpu_pct ?? null, samples: pr.samples ?? 1 };
  return {
    platform: f.platform ?? "win32",
    me: f.me ?? { user: "tester", pid: -1 },
    home: f.home ?? homedir(),
    logical_cpus: f.logical_cpus ?? 8,
    now_ms: Date.parse(f.now_iso ?? "2026-01-01T00:00:00Z"),
    records,
    pressure: { ...measures, ...verdict(measures), warnings: [] },
    listening: f.listening ?? [],
    gone: new Set(f.gone_paths ?? []),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const localProtected = loadLocalProtected();
  let platform, me, home, records, pressure, listening, logical_cpus, interval_s, now_ms, pathExists;

  if (opts.fixture) {
    const f = loadFixture(opts.fixture);
    ({ platform, me, home, records, pressure, listening, logical_cpus } = f);
    now_ms = f.now_ms;
    interval_s = null;
    pathExists = (p) => !f.gone.has(p);
  } else {
    platform = process.platform;
    if (platform !== "win32" && platform !== "darwin") usage(`Platform ${platform} is not supported. Windows and macOS only.`);
    me = { user: userInfo().username, pid: process.pid };
    home = homedir();
    // Pressure counters and the two process snapshots run side by side to keep the scan short.
    // Pressure counters and the listening-port list are read side by side with the process snapshots.
    const pressureP = measure(platform);
    const listeningP = listeningPids(platform);
    const snap = await collect({ platform, sampleMs: opts.sampleMs, home });
    records = snap.records;
    logical_cpus = snap.logical_cpus || logicalCpus();
    interval_s = snap.interval_s;
    pressure = await pressureP;
    if (snap.warning) pressure.warnings = [...(pressure.warnings ?? []), snap.warning];
    listening = [...(await listeningP)];
    now_ms = Date.now();
    pathExists = (p) => existsSync(p);
  }

  const classification = classify(records, { me, home, platform, logical_cpus, now_ms, localProtected, projectDir: opts.project, listening, pathExists, all: opts.all });
  const report = buildReport({
    platform, records, classification, pressure, me, opts: { all: opts.all, top: opts.top },
    meta: { now_iso: new Date(now_ms).toISOString(), scan_seconds: Math.round((Date.now() - started) / 100) / 10, interval_s, logical_cpus, local_protected: localProtected, project_dir: opts.project },
  });
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderHuman(report));
}

main().catch((e) => {
  console.error(`Scan failed: ${e.message}`);
  console.error("Nothing was closed. This scan is read-only.");
  process.exit(1);
});
