// Samples the machine and one process tree while a task runs. Read-only towards other processes: it
// only reads the same numbers Task Manager reads.
//
// The only processes this file ever ends are its own children, the ones Node returned from spawn(),
// and it ends them through those handles (endOwnChild), never by process number or by name.
//
//   Windows  one streaming `typeperf` (available MB, pages/s, % processor time) and one persistent
//            PowerShell in `tree` mode (see powershell.mjs). No PowerShell launch per tick.
//   macOS    `ps` each tick and `vm_stat` for available memory. Written from documented commands and
//            checked against sample data only: untested on a real Mac.
import { spawn } from "node:child_process";
import { logicalCpus as countCpus, run, parseCpuTime } from "./snapshot.mjs";
import { parseTypeperf, parseVmStat } from "./pressure.mjs";
import { startTreeLoop } from "./powershell.mjs";
import { MACHINE_INTERVAL_MS, TREE_INTERVAL_MS } from "./rules.mjs";

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// ---------- parsers (pure) ----------

// "FR1 <unix ms> <self cpu seconds> <pid,ppid,workingSetBytes,cpu100ns;...>" -> a tick, or null for any other line.
export function parseTreeLine(line) {
  const m = String(line).trim().match(/^FR1\s+(\d+)\s+([\d.]+)\s*(.*)$/);
  if (!m) return null;
  const rows = [];
  for (const part of m[3].split(";")) {
    const f = part.split(",");
    if (f.length !== 4) continue;
    const [pid, ppid, ws, cpu] = f.map(Number);
    if ([pid, ppid, ws, cpu].some((v) => !Number.isFinite(v))) continue;
    rows.push({ pid, ppid, ws_bytes: ws, cpu_s: cpu / 1e7 });
  }
  return { t: Number(m[1]), self_cpu_s: Number(m[2]), rows };
}

// `ps -axo pid=,ppid=,rss=,cputime=` -> a tick with every process on the machine (the walk happens in descendants()).
export function parseMacTree(text, t = Date.now()) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), ws_bytes: Number(m[3]) * 1024, cpu_s: parseCpuTime(m[4]) });
  }
  return { t, self_cpu_s: null, rows };
}

// The root and every process below it. A sibling of the root is never included. Cycles cannot loop.
export function descendants(rows, rootPid) {
  const byParent = new Map();
  const byPid = new Map();
  for (const r of rows) {
    byPid.set(r.pid, r);
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const root = byPid.get(rootPid);
  if (!root) return [];
  const out = [root];
  const seen = new Set([rootPid]);
  for (let i = 0; i < out.length; i++) {
    for (const child of byParent.get(out[i].pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
    }
  }
  return out;
}

// Splits a stream into complete lines, keeping a partial last line until the rest arrives.
export function lineSplitter(onLine) {
  let rest = "";
  return {
    feed(chunk) {
      rest += String(chunk);
      const lines = rest.split(/\r?\n/);
      rest = lines.pop();
      for (const l of lines) onLine(l);
    },
    flush() {
      if (rest.trim()) onLine(rest);
      rest = "";
    },
  };
}

// A streaming typeperf reader: feed it chunks, it calls onSample({ avail_mb, paging_per_s, cpu_pct }) per complete data row.
// The row parsing is phase 1's parseTypeperf, so the counter matching (English names) is the same.
export function createTypeperfStream(onSample) {
  let header = null;
  const splitter = lineSplitter((line) => {
    if (!line.startsWith('"')) return;
    if (header === null) {
      header = line;
      return;
    }
    const c = parseTypeperf(`${header}\n${line}`);
    if (!c.avail_mb.length && !c.cpu_pct.length) return;
    onSample({ avail_mb: c.avail_mb[0] ?? null, paging_per_s: c.paging_per_s[0] ?? null, cpu_pct: c.cpu_pct[0] ?? null });
  });
  return splitter;
}

// ---------- the arithmetic (pure) ----------

// Collects machine samples and tree ticks and turns them into the numbers a record stores.
//   peak tree MB       the largest sum of working sets of the root and its descendants over any tick
//   avail drop MB      available memory at the first machine sample minus the lowest one
//   CPU cores          CPU seconds the tree used between ticks over the wall seconds between them
//                      (a process that exits between ticks loses its last stretch, so this can under-count)
export class Aggregator {
  constructor() {
    this.machineFirst = null;
    this.machineMin = null;
    this.machineSamples = 0;
    this.treeSamples = 0;
    this.peakTreeBytes = 0;
    this.prev = null; // { t, cpu: Map(pid -> cpu_s) }
    this.firstT = null;
    this.lastT = null;
    this.cpuTotal = 0;
    this.peakCores = null;
    this.selfFirst = null; // { t, cpu }
    this.selfLast = null;
  }

  addMachine({ avail_mb }) {
    if (avail_mb == null || !Number.isFinite(avail_mb)) return;
    this.machineSamples += 1;
    if (this.machineFirst == null) this.machineFirst = avail_mb;
    this.machineMin = this.machineMin == null ? avail_mb : Math.min(this.machineMin, avail_mb);
  }

  addTree(tick, rootPid) {
    const members = descendants(tick.rows, rootPid);
    if (!members.length) return; // the root is gone: nothing to count
    this.treeSamples += 1;
    this.peakTreeBytes = Math.max(this.peakTreeBytes, members.reduce((a, r) => a + r.ws_bytes, 0));
    const cpu = new Map(members.map((r) => [r.pid, r.cpu_s]));
    if (this.firstT == null) this.firstT = tick.t;
    this.lastT = tick.t;
    if (this.prev && tick.t > this.prev.t) {
      let delta = 0;
      for (const [pid, c] of cpu) {
        const before = this.prev.cpu.get(pid);
        delta += before === undefined ? c : Math.max(0, c - before); // a new process counts from its own start
      }
      this.cpuTotal += delta;
      const cores = delta / ((tick.t - this.prev.t) / 1000);
      this.peakCores = this.peakCores == null ? cores : Math.max(this.peakCores, cores);
    }
    this.prev = { t: tick.t, cpu };
    if (tick.self_cpu_s != null) {
      if (!this.selfFirst) this.selfFirst = { t: tick.t, cpu: tick.self_cpu_s };
      this.selfLast = { t: tick.t, cpu: tick.self_cpu_s };
    }
  }

  result() {
    const span = this.firstT != null && this.lastT > this.firstT ? (this.lastT - this.firstT) / 1000 : null;
    let overhead = null;
    if (this.selfFirst && this.selfLast && this.selfLast.t > this.selfFirst.t) {
      overhead = (Math.max(0, this.selfLast.cpu - this.selfFirst.cpu) / ((this.selfLast.t - this.selfFirst.t) / 1000)) * 100;
    }
    return {
      peak_tree_mb: this.treeSamples ? round1(this.peakTreeBytes / 1048576) : null,
      peak_avail_drop_mb: this.machineFirst == null ? null : round1(Math.max(0, this.machineFirst - this.machineMin)),
      avg_cpu_cores: span ? round2(this.cpuTotal / span) : null,
      peak_cpu_cores: round2(this.peakCores),
      tree_samples: this.treeSamples,
      first_tree_t: this.firstT,
      machine_samples: this.machineSamples,
      // Steady-state cost of the sampler's own children (PowerShell and typeperf), as % of one core.
      // It leaves out their start-up and the Windows WMI host that answers the query.
      sampler_overhead_pct: round2(overhead),
      sampler_startup_cpu_s: this.selfFirst ? round2(this.selfFirst.cpu) : null,
    };
  }
}

// ---------- the sampler ----------

// Ends one of the sampler's own children through the handle Node gave us, and waits for it to exit.
// This is the only place in the skill that ends a process, and it only ever receives our own handles.
function endOwnChild(child, waitMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.stdin?.end();
    } catch {
      // the pipe is already closed
    }
    child.kill(); // ends our own child through its handle
  });
}

// createSampler({ platform, rootPid, treeIntervalMs, machineIntervalMs, spawnFn, runFn })
//   start()    begins sampling; returns at once
//   stop()     ends the sampler's own children, waits for them to exit, resolves to the result numbers
//   children() the sampler's own child handles (tests check they have exited)
export function createSampler({ platform = process.platform, rootPid, treeIntervalMs = TREE_INTERVAL_MS, machineIntervalMs = MACHINE_INTERVAL_MS, spawnFn = spawn, runFn = run } = {}) {
  const agg = new Aggregator();
  const owned = [];
  const warnings = [];
  const timers = [];
  let stopped = false;
  let started = false;

  function startWindows() {
    const counters = ["\\Memory\\Available MBytes", "\\Memory\\Pages/sec", "\\Processor(_Total)\\% Processor Time"];
    const typeperf = spawnFn("typeperf", [...counters, "-si", String(Math.max(1, Math.round(machineIntervalMs / 1000)))], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    owned.push(typeperf);
    typeperf.on("error", (e) => warnings.push(`typeperf could not start: ${e.message}`));
    const stream = createTypeperfStream((s) => agg.addMachine(s));
    typeperf.stdout?.setEncoding?.("utf8");
    typeperf.stdout?.on("data", (d) => stream.feed(d));

    const tree = startTreeLoop({ rootPid, auxPid: typeperf.pid ?? 0, intervalMs: treeIntervalMs, spawnFn });
    owned.push(tree);
    tree.on("error", (e) => warnings.push(`the process-tree sampler could not start: ${e.message}`));
    const lines = lineSplitter((line) => {
      const tick = parseTreeLine(line);
      if (tick) agg.addTree(tick, rootPid);
    });
    tree.stdout?.setEncoding?.("utf8");
    tree.stdout?.on("data", (d) => lines.feed(d));
    let firstErr = null;
    tree.stderr?.setEncoding?.("utf8");
    tree.stderr?.on("data", (d) => {
      if (firstErr == null) firstErr = String(d).split(/\r?\n/).find((l) => l.trim()) ?? "";
    });
    tree.on("exit", () => {
      if (firstErr && !stopped) warnings.push(`the process-tree sampler stopped: ${firstErr}`);
    });
  }

  function startMac() {
    const loop = (fn, ms) => {
      const tick = async () => {
        if (stopped) return;
        await fn().catch(() => {});
        if (!stopped) timers.push(setTimeout(tick, ms));
      };
      tick();
    };
    loop(async () => {
      const text = await runFn("ps", ["-axo", "pid=,ppid=,rss=,cputime="], { timeoutMs: 10000 });
      if (text && !stopped) agg.addTree(parseMacTree(text, Date.now()), rootPid);
    }, treeIntervalMs);
    loop(async () => {
      const text = await runFn("vm_stat", [], { timeoutMs: 10000 });
      if (text && !stopped) agg.addMachine({ avail_mb: parseVmStat(text).avail_mb });
    }, machineIntervalMs);
  }

  return {
    start() {
      if (started) return;
      started = true;
      if (platform === "win32") startWindows();
      else if (platform === "darwin") startMac();
      else warnings.push(`sampling is not supported on ${platform}`);
    },
    async stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      await Promise.all(owned.map((c) => endOwnChild(c)));
      const r = agg.result();
      if (started && platform === "win32" && !r.tree_samples) warnings.push("no process-tree sample arrived before the task ended (PowerShell can take a few seconds to start on a busy machine)");
      return { ...r, logical_cpus: countCpus(), warnings };
    },
    children: () => owned.slice(),
  };
}
