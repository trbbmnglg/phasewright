// Collects and normalizes the process list. Read-only: it only runs queries that Task Manager
// and Activity Monitor also run. Nothing here closes, signals or changes a process.
//
// Normalized record: { pid, ppid, name, exe, owner, cmd_summary, rss_mb, cpu_s_total, start_iso }
// plus two internal fields the classifier uses and the report never prints:
//   cmd_full  the command line with secrets masked (absolute paths kept, to find project folders)
//   cpu_pct   % of the whole machine over the sample, or null when it was not sampled
import { execFile } from "node:child_process";
import { homedir, cpus, userInfo } from "node:os";
import { runPowerShell } from "./powershell.mjs";
import { bin, helperOptions } from "./bin.mjs";
import { CLK_TCK_DEFAULT, applyLaterCpu, readListeningPids, readPasswd, readProcStat, readProcessTable } from "./linux.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (n) => Math.round(n * 10) / 10;

// ---------- masking and summaries ----------

// Moved to text.mjs (so the Linux collector can use them without a circular import); re-exported so older imports keep working.
export { maskSecrets, relativizePaths, baseName, summarizeCmd } from "./text.mjs";
import { maskSecrets, baseName, summarizeCmd } from "./text.mjs";

// ---------- Windows ----------

// The fixed PowerShell script and its runner live in powershell.mjs (the measure sampler uses a second
// mode of the same script). They are re-exported here so older imports keep working.
export { POWERSHELL_SCRIPT, runPowerShell } from "./powershell.mjs";

const FILETIME_100NS = 1e7;

// Accepts ISO text (what the script emits), the "/Date(ms)/" form that ConvertTo-Json gives for
// dates, and the CIM text form 20261023103000.000000+480. Returns an ISO string or null.
export function parseCimDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString();
  const s = String(v);
  let m = s.match(/\/Date\((-?\d+)\)\//);
  if (m) return new Date(Number(m[1])).toISOString();
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/);
  if (m) {
    const [, y, mo, d, h, mi, se, us, off] = m;
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, Math.floor(+us / 1000)) - Number(off) * 60000;
    return new Date(utc).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// CIM JSON (string or object) -> { taken_ms, records }. Missing fields never throw.
export function parseCim(input, { home = homedir() } = {}) {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  const rows = Array.isArray(data) ? data : data?.processes == null ? [] : [].concat(data.processes);
  const records = [];
  for (const r of rows) {
    if (r == null || r.ProcessId == null) continue;
    const exe = r.ExecutablePath || null;
    const name = r.Name || baseName(exe) || `pid-${r.ProcessId}`;
    const cmd = r.CommandLine ? maskSecrets(String(r.CommandLine)) : null;
    records.push({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId ?? 0),
      name,
      exe,
      owner: null,
      cmd_summary: summarizeCmd(r.CommandLine, { name, exe: exe || "", home }),
      rss_mb: round1(Number(r.WorkingSetSize || 0) / 1048576),
      cpu_s_total: (Number(r.KernelModeTime || 0) + Number(r.UserModeTime || 0)) / FILETIME_100NS,
      start_iso: parseCimDate(r.CreationDate),
      cmd_full: cmd,
      cpu_pct: null,
    });
  }
  return { taken_ms: Number(data?.taken_ms) || Date.now(), records };
}

// ---------- macOS (written from documented commands; not tested on a real Mac) ----------

// Reads "[[H:]M:]S[.ss]" CPU time as seconds.
export function parseCpuTime(text) {
  const parts = String(text).trim().split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// `ps -axo pid=,ppid=,user=,rss=,cputime=,lstart=,command=` plus `ps -axo pid=,comm=` for the
// executable path (command lines can hold spaces, so the two are joined on the pid).
export function parseMacPs(psText, commText = "", { home = homedir() } = {}) {
  const comm = new Map();
  for (const line of String(commText).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m) comm.set(Number(m[1]), m[2]);
  }
  const records = [];
  for (const line of String(psText).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, user, rssKb, cpuTime, lstart, command] = m;
    const exe = comm.get(Number(pid)) || null;
    const name = baseName(exe) || baseName(command.split(/\s+/)[0]);
    const started = new Date(lstart);
    records.push({
      pid: Number(pid),
      ppid: Number(ppid),
      name,
      exe,
      owner: user,
      cmd_summary: summarizeCmd(command, { name, exe: exe || "", home }),
      rss_mb: round1(Number(rssKb) / 1024),
      cpu_s_total: parseCpuTime(cpuTime),
      start_iso: Number.isNaN(started.getTime()) ? null : started.toISOString(),
      cmd_full: maskSecrets(command),
      cpu_pct: null,
    });
  }
  return records;
}

// ---------- listening ports ----------

// Windows `netstat -ano -p tcp`: a TCP row whose foreign address ends in :0 is listening
// (matching on the address, not the word LISTENING, so it also works on other languages).
export function parseNetstat(text) {
  const pids = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:\d+\s+\S+:0\s+\S+\s+(\d+)\s*$/i);
    if (m) pids.add(Number(m[1]));
  }
  return pids;
}

// macOS `lsof -nP -iTCP -sTCP:LISTEN -Fp`: one "p<pid>" line per process.
export function parseLsof(text) {
  const pids = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^p(\d+)$/);
    if (m) pids.add(Number(m[1]));
  }
  return pids;
}

// Runs a helper by its table name (lib/bin.mjs), from its absolute path and a fixed working folder; a missing
// helper or any error resolves to null, which callers treat as "not readable".
export function run(name, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const file = bin(name);
    if (!file) return resolve(null);
    execFile(file, args, { ...helperOptions(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function listeningPids(platform) {
  if (platform === "win32") return parseNetstat((await run("netstat", ["-ano", "-p", "tcp"])) ?? "");
  if (platform === "darwin") return parseLsof((await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fp"])) ?? "");
  if (platform === "linux") return readListeningPids();
  return new Set();
}

// The ticks per second of the times in /proc/<pid>/stat, from `getconf CLK_TCK`; 100 (the value on every common
// Linux architecture) when that cannot be read. Asked once per run.
let linuxConstantsPromise = null;
export function linuxConstants() {
  linuxConstantsPromise ??= (async () => {
    const n = Number(String((await run("getconf", ["CLK_TCK"])) ?? "").trim());
    return Number.isInteger(n) && n > 0 ? { clkTck: n, assumed: false } : { clkTck: CLK_TCK_DEFAULT, assumed: true };
  })();
  return linuxConstantsPromise;
}

// ---------- collection with a CPU sample ----------

// Matches two snapshots by pid and start time, so a reused pid is never mistaken for the old process.
export function applyCpuSample(before, after, intervalS, logicalCpus) {
  const prior = new Map(before.map((r) => [`${r.pid}|${r.start_iso}`, r]));
  for (const r of after) {
    const p = prior.get(`${r.pid}|${r.start_iso}`);
    if (!p || !(intervalS > 0)) continue;
    const delta = Math.max(0, r.cpu_s_total - p.cpu_s_total);
    r.cpu_pct = round1((delta / (intervalS * logicalCpus)) * 100);
  }
  return after;
}

const stripExe = (s) => String(s ?? "").toLowerCase().replace(/\.exe$/, "");

// Fills cpu_pct and owner on the CIM records from two quick samples ({ taken_ms, processes:[{id,name,cpu_s,start,owner}] }).
// A sample row is used only when its name matches and, if both start times are known, they agree within
// 3 s, so a reused pid is never mistaken for the process that used to have it.
export function mergeWindowsSamples(records, s0, s1, intervalS, logicalCpus) {
  const rows = (s) => new Map([].concat(s?.processes ?? []).map((p) => [Number(p.id), p]));
  const m0 = rows(s0);
  const m1 = rows(s1);
  const same = (r, p) => {
    if (!p || stripExe(p.name) !== stripExe(r.name)) return false;
    if (p.start && r.start_iso) return Math.abs(Date.parse(p.start) - Date.parse(r.start_iso)) < 3000;
    return true;
  };
  for (const r of records) {
    const p0 = m0.get(r.pid);
    const p1 = m1.get(r.pid);
    if (same(r, p0) && p0.owner) r.owner = p0.owner;
    if (same(r, p0) && same(r, p1) && p0.cpu_s != null && p1.cpu_s != null && intervalS > 0) {
      r.cpu_pct = round1((Math.max(0, p1.cpu_s - p0.cpu_s) / (intervalS * logicalCpus)) * 100);
    }
  }
  return records;
}

export const logicalCpus = () => (typeof cpus === "function" ? Math.max(1, cpus().length) : 1);

// PowerShell can take about 3 s to start on a busy machine; the second sample is scheduled this much later.
const START_ALLOWANCE_MS = 3500;
// A CPU interval shorter than this is too noisy to use.
const MIN_INTERVAL_MS = 1500;

// Takes two snapshots sampleMs apart and returns the second with per-process CPU filled in.
export async function collect({ platform, sampleMs, home = homedir() }) {
  const n = logicalCpus();
  if (platform === "win32") {
    // Two PowerShell calls run side by side (PowerShell can take 2 to 4 s just to start on a busy
    // machine, so fewer calls is faster): the first takes a CPU sample with owners; the second lists
    // processes with CIM, then waits for its moment and takes the second CPU sample.
    const wakeAt = Date.now() + sampleMs + START_ALLOWANCE_MS;
    const baselineP = runPowerShell("baseline").catch(() => null);
    const procsRaw = await runPowerShell("procs", { FR_AT: String(wakeAt) });
    const cim = parseCim(procsRaw, { home });
    const s0 = await baselineP;
    let s1 = procsRaw.second ?? null;
    const failed = { records: cim.records, interval_s: null, logical_cpus: n, warning: "the CPU sample failed, so per-process CPU was not measured" };
    if (!s0 || !s1) return failed;
    // If the first sample was slow to start, the second can land too early: take it again, later.
    if (s1.taken_ms - s0.taken_ms < Math.min(sampleMs, MIN_INTERVAL_MS)) {
      s1 = await runPowerShell("sample", { FR_AT: String(s0.taken_ms + sampleMs) }).catch(() => null);
      if (!s1) return failed;
    }
    const interval = (s1.taken_ms - s0.taken_ms) / 1000;
    return { records: mergeWindowsSamples(cim.records, s0, s1, interval, n), interval_s: interval, logical_cpus: n };
  }
  if (platform === "darwin") {
    const grab = async () => {
      const ps = await run("ps", ["-axo", "pid=,ppid=,user=,rss=,cputime=,lstart=,command="]);
      const comm = await run("ps", ["-axo", "pid=,comm="]);
      return { at: Date.now(), records: parseMacPs(ps ?? "", comm ?? "", { home }) };
    };
    const a = await grab();
    await sleep(sampleMs);
    const b = await grab();
    const interval = (b.at - a.at) / 1000;
    return { records: applyCpuSample(a.records, b.records, interval, n), interval_s: interval, logical_cpus: n };
  }
  if (platform === "linux") {
    const { clkTck, assumed } = await linuxConstants();
    const { btime_s } = readProcStat();
    const opts = { clkTck, btimeS: btime_s, passwd: readPasswd(), self: { uid: process.getuid?.(), user: userInfo().username }, home };
    const first = readProcessTable(opts);
    const t0 = Date.now();
    await sleep(sampleMs);
    const second = readProcessTable({ ...opts, light: true });
    const interval = (Date.now() - t0) / 1000;
    const out = { records: applyLaterCpu(first, second, interval, n), interval_s: interval, logical_cpus: n };
    if (assumed) out.warning = `getconf CLK_TCK could not be read, so ${CLK_TCK_DEFAULT} ticks per second was assumed for process start times and CPU`;
    if (!first.length) out.warning = "no process could be read from /proc";
    return out;
  }
  throw new Error(`Platform ${platform} is not supported. Windows, macOS and Linux only.`);
}
