// Machine pressure: memory, paging and CPU, plus the verdict with its visible thresholds.
// Windows reads performance counters through the fixed PowerShell script in snapshot.mjs.
// macOS uses vm_stat, sysctl, memory_pressure and top (documented commands; untested on a real Mac).
import { totalmem, freemem, cpus } from "node:os";
import { run } from "./snapshot.mjs";
import { MEM_AVAILABLE_PCT_LOW, PAGING_PER_S_HIGH, CPU_AVG_PCT_HIGH } from "./rules.mjs";

export const THRESHOLDS = {
  memory_available_pct_below: MEM_AVAILABLE_PCT_LOW,
  paging_per_s_above: PAGING_PER_S_HIGH,
  cpu_avg_pct_at_least: CPU_AVG_PCT_HIGH,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// Pure. measures: { avail_pct, paging_per_s, cpu_pct }, each a number or null (not measured).
// Memory pressure: available below the threshold, or paging above it. A boundary value is not pressure
// for memory (15% free, 200 pages/s) and is pressure for CPU (85%), as the thresholds are worded.
export function verdict({ avail_pct = null, paging_per_s = null, cpu_pct = null } = {}) {
  const reasons = [];
  const memory = avail_pct != null && avail_pct < THRESHOLDS.memory_available_pct_below;
  const paging = paging_per_s != null && paging_per_s > THRESHOLDS.paging_per_s_above;
  const cpu = cpu_pct != null && cpu_pct >= THRESHOLDS.cpu_avg_pct_at_least;
  if (memory) reasons.push(`available memory ${round1(avail_pct)}% is below ${THRESHOLDS.memory_available_pct_below}%`);
  if (paging) reasons.push(`paging ${round1(paging_per_s)} pages/s is above ${THRESHOLDS.paging_per_s_above}`);
  if (cpu) reasons.push(`CPU average ${round1(cpu_pct)}% is at least ${THRESHOLDS.cpu_avg_pct_at_least}%`);
  const mem = memory || paging;
  const value = mem && cpu ? "memory+cpu" : mem ? "memory" : cpu ? "cpu" : "none";
  return { verdict: value, reasons, thresholds: { ...THRESHOLDS } };
}

// ---------- macOS parsers ----------

// vm_stat: header "page size of N bytes", then "Name: value." lines (counts in pages).
export function parseVmStat(text, pageSizeOverride) {
  const t = String(text);
  const header = t.match(/page size of (\d+) bytes/i);
  const pageSize = Number(pageSizeOverride) || (header ? Number(header[1]) : 4096);
  const get = (label) => {
    const m = t.match(new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "im"));
    return m ? Number(m[1]) : 0;
  };
  const free = get("Pages free");
  const inactive = get("Pages inactive");
  const speculative = get("Pages speculative");
  const purgeable = get("Pages purgeable");
  const toMb = (pages) => (pages * pageSize) / 1048576;
  return {
    page_size: pageSize,
    free_mb: toMb(free),
    // Available = memory the system can hand out without paging: free, inactive, speculative and purgeable.
    avail_mb: toMb(free + inactive + speculative + purgeable),
    swapins: get("Swapins"),
    swapouts: get("Swapouts"),
    pageins: get("Pageins"),
  };
}

// `sysctl vm.swapusage`: "total = 2048.00M  used = 1024.00M  free = 1024.00M".
export function parseSwapUsage(text) {
  const num = (k) => {
    const m = String(text).match(new RegExp(`${k}\\s*=\\s*([\\d.]+)([MGK])`, "i"));
    if (!m) return null;
    return Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024 }[m[2].toUpperCase()]);
  };
  return { total_mb: num("total"), used_mb: num("used") };
}

// `memory_pressure` ends with "System-wide memory free percentage: 62%".
export function parseMemoryPressure(text) {
  const m = String(text).match(/free percentage:\s*(\d+(?:\.\d+)?)%/i);
  return m ? Number(m[1]) : null;
}

// `top -l 2 -n 0 -s 1`: the second "CPU usage:" line is the live one. Returns used % (100 - idle).
export function parseTopCpu(text) {
  const lines = [...String(text).matchAll(/CPU usage:.*?([\d.]+)% idle/gi)];
  if (!lines.length) return null;
  return round1(100 - Number(lines[lines.length - 1][1]));
}

// ---------- measurement ----------

// Fallback when counters are unavailable (for example a non-English Windows): Node's own numbers.
async function cpuFromNode(ms = 1000) {
  const snap = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
  const a = snap();
  await sleep(ms);
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? round1(100 * (1 - (b.idle - a.idle) / total)) : null;
}

// Windows `typeperf` CSV: a header row of counter paths, then one row per one-second sample.
// Returns { avail_mb:[], paging_per_s:[], cpu_pct:[] }. Counters are matched by their English names,
// so another language gives empty lists and the caller falls back to Node's numbers.
export function parseTypeperf(text) {
  const out = { avail_mb: [], paging_per_s: [], cpu_pct: [] };
  const rows = String(text).split(/\r?\n/).filter((l) => l.startsWith('"')).map((l) => l.slice(1, -1).split('","'));
  if (rows.length < 2) return out;
  const header = rows[0].map((h) => h.toLowerCase());
  const col = (suffix) => header.findIndex((h) => h.endsWith(suffix));
  const [ia, ip, ic] = [col("available mbytes"), col("pages/sec"), col("% processor time")];
  for (const r of rows.slice(1)) {
    const num = (i) => (i > 0 && r[i] != null && r[i].trim() !== "" ? Number(r[i]) : NaN);
    for (const [key, i] of [["avail_mb", ia], ["paging_per_s", ip], ["cpu_pct", ic]]) {
      const v = num(i);
      if (!Number.isNaN(v)) out[key].push(v);
    }
  }
  return out;
}

// macOS runs its own commands; Windows reads typeperf (a read-only counter reader that ships with Windows).
export async function measure(platform) {
  const total_mb = totalmem() / 1048576;
  const warnings = [];
  let avail_mb = freemem() / 1048576;
  let paging_per_s = null;
  let cpu_pct = null;
  let samples = 0;
  if (platform === "win32") {
    const text = await run("typeperf", ["\\Memory\\Available MBytes", "\\Memory\\Pages/sec", "\\Processor(_Total)\\% Processor Time", "-sc", "3"], { timeoutMs: 40000 });
    const counters = parseTypeperf(text ?? "");
    const [a, p, u] = [counters.avail_mb, counters.paging_per_s, counters.cpu_pct];
    if (a.length && u.length) {
      avail_mb = avg(a);
      paging_per_s = avg(p);
      cpu_pct = avg(u);
      samples = u.length;
    } else {
      warnings.push("performance counters were not readable (for example a non-English Windows); paging was not measured, and memory and CPU come from Node");
      cpu_pct = await cpuFromNode();
    }
  } else if (platform === "darwin") {
    const startedAt = Date.now();
    const [pageSizeText, swapText, mpText, topText, vm1] = await Promise.all([
      run("sysctl", ["-n", "hw.pagesize"]),
      run("sysctl", ["vm.swapusage"]),
      run("memory_pressure", []),
      run("top", ["-l", "2", "-n", "0", "-s", "1"], { timeoutMs: 30000 }),
      run("vm_stat", []),
    ]);
    const vm2text = await run("vm_stat", []);
    const pageSize = Number(String(pageSizeText ?? "").trim()) || undefined;
    if (vm1) {
      const v1 = parseVmStat(vm1, pageSize);
      avail_mb = v1.avail_mb;
      if (vm2text) {
        // Swap-ins between the two vm_stat reads, per second of the time between them.
        const v2 = parseVmStat(vm2text, pageSize);
        const seconds = Math.max(0.5, (Date.now() - startedAt) / 1000);
        paging_per_s = Math.max(0, v2.swapins - v1.swapins) / seconds;
      }
    } else warnings.push("vm_stat was not readable; memory comes from Node");
    const freePct = parseMemoryPressure(mpText ?? "");
    if (freePct != null) avail_mb = (freePct / 100) * total_mb;
    cpu_pct = parseTopCpu(topText ?? "");
    if (cpu_pct == null) cpu_pct = await cpuFromNode();
    samples = 1;
    const swap = parseSwapUsage(swapText ?? "");
    if (swap.used_mb != null) warnings.push(`swap used: ${Math.round(swap.used_mb)} MB`);
  }
  const avail_pct = total_mb > 0 ? (avail_mb / total_mb) * 100 : null;
  const measures = { total_mb: round1(total_mb), avail_mb: round1(avail_mb), avail_pct: round1(avail_pct), paging_per_s: round1(paging_per_s), cpu_pct: round1(cpu_pct), samples };
  return { ...measures, ...verdict(measures), warnings };
}
