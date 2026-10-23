// The read-only scan as one function, shared by processes.mjs and headroom.mjs. It never closes,
// kills or signals anything. Returns the report object (buildReport) ready to print or to compare.
import { readFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { collect, listeningPids, logicalCpus } from "./snapshot.mjs";
import { measure, verdict } from "./pressure.mjs";
import { classify } from "./classify.mjs";
import { buildReport } from "./report.mjs";
import { loadLocalProtected, DEFAULT_SAMPLE_MS } from "./rules.mjs";

// An error the CLI should print as a usage problem (exit 2) rather than a failed scan.
export class UsageError extends Error {}

// A fixture is a recorded snapshot: { platform, me, home, logical_cpus, now_iso, pressure, listening, gone_paths, records }.
// Records need pid, ppid, name; everything else has a default.
export function loadFixture(file) {
  if (!existsSync(file)) throw new UsageError(`fixture not found: ${file}`);
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

// opts: { project, sampleMs, all, top, fixture }. Throws UsageError for a missing fixture or an unsupported platform.
export async function scan({ project = process.cwd(), sampleMs = DEFAULT_SAMPLE_MS, all = false, top, fixture = null } = {}) {
  const started = Date.now();
  const localProtected = loadLocalProtected();
  let platform, me, home, records, pressure, listening, logical_cpus, interval_s, now_ms, pathExists;

  if (fixture) {
    const f = loadFixture(fixture);
    ({ platform, me, home, records, pressure, listening, logical_cpus } = f);
    now_ms = f.now_ms;
    interval_s = null;
    pathExists = (p) => !f.gone.has(p);
  } else {
    platform = process.platform;
    if (platform !== "win32" && platform !== "darwin") throw new UsageError(`Platform ${platform} is not supported. Windows and macOS only.`);
    me = { user: userInfo().username, pid: process.pid };
    home = homedir();
    // Pressure counters and the listening-port list are read side by side with the process snapshots
    // to keep the scan short.
    const pressureP = measure(platform);
    const listeningP = listeningPids(platform);
    const snap = await collect({ platform, sampleMs, home });
    records = snap.records;
    logical_cpus = snap.logical_cpus || logicalCpus();
    interval_s = snap.interval_s;
    pressure = await pressureP;
    if (snap.warning) pressure.warnings = [...(pressure.warnings ?? []), snap.warning];
    listening = [...(await listeningP)];
    now_ms = Date.now();
    pathExists = (p) => existsSync(p);
  }

  const classification = classify(records, { me, home, platform, logical_cpus, now_ms, localProtected, projectDir: project, listening, pathExists, all });
  return buildReport({
    platform, records, classification, pressure, me, opts: { all, top },
    meta: { now_iso: new Date(now_ms).toISOString(), scan_seconds: Math.round((Date.now() - started) / 100) / 10, interval_s, logical_cpus, local_protected: localProtected, project_dir: project },
  });
}
