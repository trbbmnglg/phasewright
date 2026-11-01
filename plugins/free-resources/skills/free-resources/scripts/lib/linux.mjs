// Linux: reads /proc directly (no helper program for the process table). Read-only: it only reads files, it
// never writes, signals or changes anything. Every function that touches the file system takes an `fsApi`
// ({ readFileSync, readdirSync, readlinkSync }) and a `procRoot`, so the tests run it against a made-up /proc
// on any machine, and a live test runs it against the real one on Linux.
//
// Formats are those of proc(5): proc_pid_stat(5), proc_pid_status(5), proc_meminfo(5), proc_stat(5),
// proc_pid_cmdline(5), proc_pid_exe(5), and the kernel's PSI document (/proc/pressure/memory).
import * as realFs from "node:fs";
import { maskSecrets, baseName, summarizeCmd } from "./text.mjs";

const round1 = (n) => Math.round(n * 10) / 10;

// USER_HZ: the unit of the times in /proc/<pid>/stat. 100 on every common Linux architecture; the collector asks
// `getconf CLK_TCK` and falls back to this value only when that fails.
export const CLK_TCK_DEFAULT = 100;
// The memory page size in bytes, used only when a process has no VmRSS line (a kernel thread has none: rss 0).
export const PAGE_SIZE_DEFAULT = 4096;

const tryRead = (fsApi, path) => {
  try {
    return fsApi.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const tryLink = (fsApi, path) => {
  try {
    return fsApi.readlinkSync(path);
  } catch {
    return null;
  }
};

// ---------- parsers (pure) ----------

// /proc/<pid>/stat: "pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime
// cutime cstime priority nice num_threads itrealvalue starttime vsize rss ...". The command name sits in parentheses
// and may itself contain spaces and parentheses, so the fields after it are counted from the LAST ")".
export function parseStat(text) {
  const t = String(text ?? "");
  const open = t.indexOf("(");
  const close = t.lastIndexOf(")");
  if (open < 1 || close < open) return null;
  const rest = t.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 22) return null;
  const n = (i) => Number(rest[i]);
  const st = {
    pid: Number(t.slice(0, open).trim()),
    comm: t.slice(open + 1, close),
    state: rest[0],
    ppid: n(1),
    flags: n(6),
    utime: n(11),
    stime: n(12),
    starttime: n(19),
    rss_pages: n(21),
  };
  return [st.pid, st.ppid, st.flags, st.utime, st.stime, st.starttime, st.rss_pages].every(Number.isFinite) ? st : null;
}

// /proc/<pid>/status: "Key:\tvalue" lines. Uid and Gid hold real, effective, saved and filesystem ids.
export function parseStatus(text) {
  const t = String(text ?? "");
  const field = (key) => {
    const m = t.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const ids = (key) => {
    const v = field(key);
    const parts = v ? v.split(/\s+/).map(Number) : [];
    return parts.length === 4 && parts.every(Number.isInteger) ? { real: parts[0], effective: parts[1], saved: parts[2], fs: parts[3] } : null;
  };
  const kb = field("VmRSS");
  const rssKb = kb ? Number(kb.split(/\s+/)[0]) : null;
  const nspid = field("NSpid");
  return {
    name: field("Name"),
    state: field("State"),
    uid: ids("Uid"),
    gid: ids("Gid"),
    vmrss_kb: Number.isFinite(rssKb) ? rssKb : null,
    nspid: nspid ? nspid.split(/\s+/).map(Number).filter(Number.isInteger) : null,
    cap_eff: field("CapEff"),
    cap_prm: field("CapPrm"),
    tracer_pid: field("TracerPid") == null ? null : Number(field("TracerPid")),
  };
}

// /proc/meminfo: "MemTotal:   16384000 kB".
export function parseMeminfo(text) {
  const t = String(text ?? "");
  const kb = (key) => {
    const m = t.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) : null;
  };
  return { total_kb: kb("MemTotal"), available_kb: kb("MemAvailable"), free_kb: kb("MemFree"), swap_total_kb: kb("SwapTotal"), swap_free_kb: kb("SwapFree") };
}

// /proc/vmstat: "name value" lines. pswpin and pswpout are pages swapped in and out since boot.
export function parseVmstat(text) {
  const t = String(text ?? "");
  const get = (key) => {
    const m = t.match(new RegExp(`^${key}\\s+(\\d+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  return { pswpin: get("pswpin"), pswpout: get("pswpout"), pgmajfault: get("pgmajfault") };
}

// /proc/stat: "btime <seconds since the epoch at boot>" and the first "cpu ..." line (user nice system idle iowait irq softirq steal ...).
export function parseProcStat(text) {
  const t = String(text ?? "");
  const b = t.match(/^btime\s+(\d+)\s*$/m);
  const c = t.match(/^cpu\s+(.+)$/m);
  const j = c ? c[1].trim().split(/\s+/).map(Number) : [];
  const idle = (j[3] ?? 0) + (j[4] ?? 0);
  const total = j.slice(0, 8).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
  return { btime_s: b ? Number(b[1]) : null, cpu: c ? { idle, total } : null };
}

// /proc/pressure/memory: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0" and a "full" line. Null when the file is absent.
export function parsePressure(text) {
  const t = String(text ?? "");
  const line = (kind) => {
    const m = t.match(new RegExp(`^${kind}\\s+avg10=([\\d.]+)\\s+avg60=([\\d.]+)\\s+avg300=([\\d.]+)`, "m"));
    return m ? { avg10: Number(m[1]), avg60: Number(m[2]), avg300: Number(m[3]) } : null;
  };
  const some = line("some");
  return some ? { some, full: line("full") } : null;
}

// /proc/<pid>/cgroup on a cgroup v2 system is one line: "0::/user.slice/user-1000.slice/user@<uid>.service/app.slice/app-foo.service".
// The unit is the last part of the path ("app-foo.service", "vte-spawn-1234.scope", "session-2.scope"), or null at the
// root, on cgroup v1 (several lines) or when the file is unreadable. cgroup(7) says the path-to-unit mapping is not a
// public interface, so this is used to tell a service from a scope, never to look anything up.
export function parseCgroupUnit(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith("0::")) return null;
  return lines[0].slice(3).split("/").filter(Boolean).pop() ?? null;
}

// /etc/passwd: "name:x:uid:gid:...". A map from uid to name.
export function parsePasswd(text) {
  const map = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const f = line.split(":");
    const uid = Number(f[2]);
    if (f.length >= 3 && f[0] && Number.isInteger(uid) && !map.has(uid)) map.set(uid, f[0]);
  }
  return map;
}

// /proc/net/tcp and tcp6: the inode of every socket in state 0A (listening).
export function parseNetTcp(text) {
  const inodes = new Set();
  for (const line of String(text ?? "").split(/\r?\n/).slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 10 && f[3] === "0A" && /^\d+$/.test(f[9]) && f[9] !== "0") inodes.add(f[9]);
  }
  return inodes;
}

// The path a /proc/<pid>/exe link gave, without the " (deleted)" Linux appends when the file was replaced.
export const cleanExe = (link) => (link ? String(link).replace(/ \(deleted\)$/, "") : null);

// ---------- reading /proc ----------

const PID = /^[1-9]\d{0,9}$/;

// Seconds since the epoch at which a process started: boot time plus its start offset in ticks.
const startIso = (btimeS, starttime, clkTck) => (Number.isFinite(btimeS) ? new Date((btimeS + starttime / clkTck) * 1000).toISOString() : null);

// Every process as a normalized record (see snapshot.mjs). Anything that cannot be read (another user's /proc files,
// a process that exited while we looked) becomes null for that field, or skips the process, and never throws.
// light: only pid, start time and CPU seconds (the second sample of a CPU measurement).
export function readProcessTable({ procRoot = "/proc", fsApi = realFs, clkTck = CLK_TCK_DEFAULT, btimeS = null, pageSize = PAGE_SIZE_DEFAULT, passwd = new Map(), self = {}, home = "", light = false } = {}) {
  const out = [];
  let names;
  try {
    names = fsApi.readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const entry of names) {
    if (!PID.test(String(entry))) continue;
    const dir = `${procRoot}/${entry}`;
    const st = parseStat(tryRead(fsApi, `${dir}/stat`));
    if (!st) continue;
    const base = { pid: Number(entry), start_iso: startIso(btimeS, st.starttime, clkTck), cpu_s_total: (st.utime + st.stime) / clkTck };
    if (light) {
      out.push(base);
      continue;
    }
    const status = parseStatus(tryRead(fsApi, `${dir}/status`));
    const exe = cleanExe(tryLink(fsApi, `${dir}/exe`));
    const cmdline = (tryRead(fsApi, `${dir}/cmdline`) ?? "").split("\0").filter((p) => p !== "").join(" ");
    const name = baseName(exe) || status.name || st.comm;
    const uid = status.uid?.real;
    const rssKb = status.vmrss_kb ?? (st.rss_pages * pageSize) / 1024;
    out.push({
      ...base,
      ppid: st.ppid,
      name,
      exe,
      owner: uid == null ? null : uid === self.uid ? self.user : passwd.get(uid) ?? `uid-${uid}`,
      cmd_summary: summarizeCmd(cmdline, { name, exe: exe || "", home }),
      rss_mb: round1(rssKb / 1024),
      cmd_full: cmdline ? maskSecrets(cmdline) : null,
      cpu_pct: null,
      unit: parseCgroupUnit(tryRead(fsApi, `${dir}/cgroup`)),
    });
  }
  return out;
}

// Fills cpu_pct on `first` (a full table) from `second` (a light table read `intervalS` later): percent of the whole
// machine. A process is matched by pid and start time, so a reused pid is never mistaken for the old process.
export function applyLaterCpu(first, second, intervalS, logicalCpus) {
  const later = new Map(second.map((r) => [`${r.pid}|${r.start_iso}`, r.cpu_s_total]));
  for (const r of first) {
    const t = later.get(`${r.pid}|${r.start_iso}`);
    if (t != null && intervalS > 0) r.cpu_pct = round1((Math.max(0, t - r.cpu_s_total) / (intervalS * logicalCpus)) * 100);
  }
  return first;
}

// The rows the measure sampler needs: the root process and everything below it, with resident memory in bytes and
// CPU seconds. Only processes in that tree have their status file read.
export function readTreeRows({ procRoot = "/proc", fsApi = realFs, clkTck = CLK_TCK_DEFAULT, rootPid } = {}) {
  const stats = new Map();
  let names;
  try {
    names = fsApi.readdirSync(procRoot);
  } catch {
    return [];
  }
  for (const entry of names) {
    if (!PID.test(String(entry))) continue;
    const st = parseStat(tryRead(fsApi, `${procRoot}/${entry}/stat`));
    if (st) stats.set(Number(entry), st);
  }
  const children = new Map();
  for (const [pid, st] of stats) children.set(st.ppid, [...(children.get(st.ppid) ?? []), pid]);
  const tree = [];
  const seen = new Set();
  const queue = stats.has(rootPid) ? [rootPid] : [];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    tree.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree.map((pid) => {
    const st = stats.get(pid);
    const kb = parseStatus(tryRead(fsApi, `${procRoot}/${pid}/status`)).vmrss_kb ?? 0;
    return { pid, ppid: st.ppid, ws_bytes: kb * 1024, cpu_s: (st.utime + st.stime) / clkTck };
  });
}

// The pids that have a TCP socket in the listening state. The socket's inode comes from /proc/net/tcp and tcp6;
// the owner is found by matching it with a process's open files, which only your own processes allow.
export function readListeningPids({ procRoot = "/proc", fsApi = realFs } = {}) {
  const inodes = new Set();
  for (const f of ["net/tcp", "net/tcp6"]) for (const i of parseNetTcp(tryRead(fsApi, `${procRoot}/${f}`))) inodes.add(i);
  const pids = new Set();
  if (!inodes.size) return pids;
  let names;
  try {
    names = fsApi.readdirSync(procRoot);
  } catch {
    return pids;
  }
  const found = new Set();
  for (const entry of names) {
    if (!PID.test(String(entry))) continue;
    let fds;
    try {
      fds = fsApi.readdirSync(`${procRoot}/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      const m = String(tryLink(fsApi, `${procRoot}/${entry}/fd/${fd}`) ?? "").match(/^socket:\[(\d+)\]$/);
      if (m && inodes.has(m[1])) {
        pids.add(Number(entry));
        found.add(m[1]);
      }
    }
    if (found.size === inodes.size) break;
  }
  return pids;
}

// Memory, swap and boot time from /proc, for the pressure reading and the measure sampler.
export function readMeminfo({ procRoot = "/proc", fsApi = realFs } = {}) {
  return parseMeminfo(tryRead(fsApi, `${procRoot}/meminfo`));
}
export function readVmstat({ procRoot = "/proc", fsApi = realFs } = {}) {
  return parseVmstat(tryRead(fsApi, `${procRoot}/vmstat`));
}
export function readProcStat({ procRoot = "/proc", fsApi = realFs } = {}) {
  return parseProcStat(tryRead(fsApi, `${procRoot}/stat`));
}
export function readPressure({ procRoot = "/proc", fsApi = realFs } = {}) {
  return parsePressure(tryRead(fsApi, `${procRoot}/pressure/memory`));
}
export function readPasswd({ fsApi = realFs, path = "/etc/passwd" } = {}) {
  return parsePasswd(tryRead(fsApi, path));
}
