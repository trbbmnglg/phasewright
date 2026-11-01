// Reads what the stop gate asks about one process, right before it decides. Read-only: it reads /proc on Linux, runs
// `ps`, `lsof`, `launchctl list` and `codesign --verify` on macOS, and pins the process with a query-only handle on
// Windows (lib/pin-windows.mjs). It never signals anything. Every value that cannot be read is null, and the gate refuses
// on null.
import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { bin, helperOptions } from "./bin.mjs";
import { pinWindows, readWindowsFacts } from "./pin-windows.mjs";
import { readLinuxFacts, readProcStat } from "./linux.mjs";
import { linuxConstants } from "./snapshot.mjs";

// A path on a local drive letter ("C:\..."). A share or device path ("\\server\...", "\\?\...", "\\.\...") is never
// opened: opening one can make Windows sign in to another machine with your account.
export const isLocalDrivePath = (p) => typeof p === "string" && /^[A-Za-z]:\\/.test(p) && !p.includes("\0");

// The program's canonical long path: Windows can report a short (8.3) name or another spelling of the same file, and
// the protected lists and the system-folder rules compare paths. Null when it is not a local path or cannot be resolved.
export function canonicalWindowsPath(p, { realpath = realpathSync.native } = {}) {
  if (!isLocalDrivePath(p)) return null;
  try {
    const r = String(realpath(p)).replace(/^\\\\\?\\/, "");
    return isLocalDrivePath(r) ? r : null;
  } catch {
    return null;
  }
}

// The Windows subsystem a program was built for, from its PE header: 2 is a windowed (GUI) program, 3 a console one.
// Only a windowed program can be asked to close; closing a console window would end every program attached to it.
// Null when the file cannot be read as a program, or is not on a local drive.
export function peSubsystem(path, { open = openSync, read = readSync, close = closeSync, local = isLocalDrivePath } = {}) {
  if (!local(path)) return null;
  let fd = null;
  try {
    fd = open(path, "r");
    const head = Buffer.alloc(4096);
    const n = read(fd, head, 0, head.length, 0);
    if (n < 0x40 || head.toString("latin1", 0, 2) !== "MZ") return null;
    const pe = head.readUInt32LE(0x3c);
    if (pe + 24 + 70 > n || head.toString("latin1", pe, pe + 4) !== "PE\0\0") return null;
    return head.readUInt16LE(pe + 24 + 68);
  } catch {
    return null;
  } finally {
    if (fd != null) try { close(fd); } catch { /* ignore */ }
  }
}

// Windows facts as read through the handle, with the program's path made canonical and its subsystem read.
function windowsFacts(raw) {
  if (raw?.ok !== true) return null;
  const image = canonicalWindowsPath(raw.image_path);
  return { ...raw, image_path: image, subsystem: image ? peSubsystem(image) : null };
}

// One helper run that resolves to { code, stdout }: code is the exit code, or null when it timed out or could not start.
function runHelper(name, args, { timeoutMs = 15000, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    const file = bin(name, { platform });
    if (!file) return resolve({ code: null, stdout: "" });
    execFile(file, args, { ...helperOptions({}, { platform }), encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout });
      resolve({ code: Number.isInteger(err.code) ? err.code : null, stdout: stdout ?? "" });
    });
  });
}

// macOS: `ps -o pid=,ppid=,uid=,ruid=,svuid=,gid=,rgid=,svgid=,stat=,lstart=` for one pid.
const MAC_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*$/;
export function parseMacFacts(row) {
  const m = String(row ?? "").trim().match(MAC_ROW);
  if (!m) return null;
  const [, pid, ppid, uid, ruid, svuid, gid, rgid, svgid, state, lstart] = m;
  const started = new Date(lstart);
  return {
    pid: Number(pid), ppid: Number(ppid), uid: Number(uid), ruid: Number(ruid), svuid: Number(svuid), gid: Number(gid), rgid: Number(rgid), svgid: Number(svgid),
    state, lstart: lstart.replace(/\s+/g, " "), start_iso: Number.isNaN(started.getTime()) ? null : started.toISOString(),
  };
}

// The program a macOS process runs, from `lsof -a -p <pid> -d txt -Fn`: the first text-file entry is the executable the
// kernel mapped. (`ps -o comm` gives the name the process was started with, which it chooses.)
export function parseLsofProgram(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) if (line.startsWith("n/")) return line.slice(1);
  return null;
}

// `launchctl list`: "PID<TAB>Status<TAB>Label" rows for the jobs launchd runs for you. A Map from pid to label, or null when
// it could not be read.
export function parseLaunchctlList(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter(Boolean);
  if (!lines.length || !/^PID\s+Status\s+Label/.test(lines[0])) return null;
  const jobs = new Map();
  for (const l of lines.slice(1)) {
    const m = l.match(/^(\d+)\s+\S+\s+(.+)$/);
    if (m) jobs.set(Number(m[1]), m[2].trim());
  }
  return jobs;
}
// "job" for a launchd job, "application" for an app the Finder or the Dock opened, "none" when launchd does not run it,
// null when that cannot be told.
export const launchdKind = (jobs, pid) => (!jobs ? null : !jobs.has(pid) ? "none" : jobs.get(pid).startsWith("application.") ? "application" : "job");
// The pids of the jobs that are not apps, so the gate can refuse a process that one of them started; null when unknown.
export const launchdJobPids = (jobs) => (!jobs ? null : [...jobs].filter(([, label]) => !label.startsWith("application.")).map(([pid]) => pid));
export async function launchdJobs() {
  const r = await runHelper("launchctl", ["list"], { platform: "darwin" });
  return r.code === 0 ? parseLaunchctlList(r.stdout) : null;
}
// The kind of session launchd serves this process in: "Aqua" for a desktop login. Outside one (an SSH login) its job list
// does not show the desktop's jobs, so the self-check refuses. Null when it cannot be read.
export async function launchdManager() {
  const r = await runHelper("launchctl", ["managername"], { platform: "darwin" });
  return r.code === 0 ? String(r.stdout).trim() : null;
}

export async function codesignExit(path, opts = {}) {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  return (await runHelper("codesign", ["--verify", "-R=anchor apple", path], { platform: "darwin", ...opts })).code;
}

async function macFacts(pid, { withSignature = true, jobs } = {}) {
  const row = await runHelper("ps", ["-o", "pid=,ppid=,uid=,ruid=,svuid=,gid=,rgid=,svgid=,stat=,lstart=", "-p", String(pid)], { platform: "darwin" });
  const facts = row.code === 0 ? parseMacFacts(row.stdout) : null;
  if (!facts || facts.pid !== pid) return null;
  const lsof = await runHelper("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { platform: "darwin" });
  facts.exe = parseLsofProgram(lsof.stdout);
  facts.codesign_exit = withSignature ? await codesignExit(facts.exe) : null;
  const list = withSignature ? (jobs === undefined ? await launchdJobs() : jobs) : null;
  facts.launchd = withSignature ? launchdKind(list, pid) : null;
  facts.launchd_jobs = withSignature ? launchdJobPids(list) : null;
  return facts;
}

async function linuxFacts(pid, { procRoot, fsApi } = {}) {
  const facts = readLinuxFacts(pid, { procRoot, fsApi });
  if (!facts) return null;
  const { clkTck } = await linuxConstants();
  const btime = readProcStat({ procRoot, fsApi }).btime_s;
  facts.start_iso = Number.isFinite(btime) ? new Date((btime + facts.starttime / clkTck) * 1000).toISOString() : null;
  return facts;
}

// The facts for one pid, with a way to let go. On Windows the process stays pinned until release() or waitForExit(), and
// alive() asks the pin whether it still holds the process and the process still runs.
// Resolves to { facts, release(), waitForExit(), alive() }; facts is null when the process is gone or cannot be read.
export async function factsFor(platform, pid, opts = {}) {
  if (platform === "win32") {
    const pin = await (opts.pin ?? pinWindows)(pid, opts);
    return { facts: windowsFacts(pin.facts), release: pin.release, waitForExit: pin.wait, alive: pin.alive };
  }
  const facts = platform === "linux" ? await linuxFacts(pid, opts) : platform === "darwin" ? await macFacts(pid, opts) : null;
  return { facts, release: async () => {}, waitForExit: async () => ({ exited: null }), alive: async () => facts != null };
}

// The facts for several pids, holding nothing (for a plan, which only assesses). A Map from pid to facts or null.
export async function factsForMany(platform, pids, opts = {}) {
  const out = new Map();
  if (platform === "win32") {
    const read = await (opts.read ?? readWindowsFacts)(pids, opts);
    for (const pid of pids) out.set(pid, windowsFacts(read.get(pid)));
    return out;
  }
  const jobs = platform === "darwin" ? await launchdJobs() : undefined;
  for (const pid of pids) out.set(pid, (await factsFor(platform, pid, { ...opts, jobs })).facts);
  return out;
}
