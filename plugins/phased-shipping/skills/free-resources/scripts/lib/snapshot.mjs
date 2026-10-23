// Collects and normalizes the process list. Read-only: it only runs queries that Task Manager
// and Activity Monitor also run. Nothing here closes, signals or changes a process.
//
// Normalized record: { pid, ppid, name, exe, owner, cmd_summary, rss_mb, cpu_s_total, start_iso }
// plus two internal fields the classifier uses and the report never prints:
//   cmd_full  the command line with secrets masked (absolute paths kept, to find project folders)
//   cpu_pct   % of the whole machine over the sample, or null when it was not sampled
import { execFile } from "node:child_process";
import { homedir, cpus } from "node:os";
import { basename } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (n) => Math.round(n * 10) / 10;

// ---------- masking and summaries ----------

const SECRET_FLAG = /(--?[\w-]*(?:token|password|passwd|secret|key))(=|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_ASSIGN = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)=)("[^"]*"|'[^']*'|[^\s&]+)/gi;
const BEARER = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi;

// Masks the values of secret-looking flags and assignments. Used on every command line before
// anything is stored, so a secret never reaches the report, the JSON or a test failure message.
export function maskSecrets(text) {
  if (!text) return text;
  return text.replace(SECRET_FLAG, "$1$2***").replace(SECRET_ASSIGN, "$1***").replace(BEARER, "$1***");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Shows paths inside the user's profile folder as ~ so a report can be shared without the account name.
export function relativizePaths(text, home = homedir()) {
  if (!text || !home) return text;
  const variants = new Set([home, home.split("\\").join("/"), home.split("/").join("\\")]);
  let out = text;
  for (const v of variants) out = out.replace(new RegExp(escapeRe(v), "gi"), "~");
  return out;
}

export function baseName(p) {
  return p ? p.split(/[\\/]/).pop() : p;
}

// The executable name plus its arguments, masked, profile paths relative, cut to 120 characters.
export function summarizeCmd(cmd, { name = "", exe = "", home = homedir(), max = 120 } = {}) {
  if (!cmd || !cmd.trim()) return name || baseName(exe) || "";
  let rest;
  let head;
  const c = cmd.trim();
  if (exe && c.toLowerCase().startsWith(exe.toLowerCase())) {
    head = baseName(exe);
    rest = c.slice(exe.length);
  } else if (exe && c.toLowerCase().startsWith(`"${exe.toLowerCase()}"`)) {
    head = baseName(exe);
    rest = c.slice(exe.length + 2);
  } else if (c.startsWith('"') && c.indexOf('"', 1) > 0) {
    const end = c.indexOf('"', 1);
    head = baseName(c.slice(1, end));
    rest = c.slice(end + 1);
  } else {
    const m = c.match(/^(\S+)([\s\S]*)$/);
    head = baseName(m[1]);
    rest = m[2];
  }
  const text = relativizePaths(maskSecrets(`${head}${rest}`.replace(/\s+/g, " ").trim()), home);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

// ---------- Windows ----------

// One fixed PowerShell script. It takes no user input: the mode comes from a fixed list set by this
// file, and it receives no data at all. Read-only queries only:
//   procs     Win32_Process rows (what Task Manager shows), as JSON. If FR_AT (a clock time in ms, set by
//             this file) is given it then waits for that moment and takes a quick CPU sample too.
//   baseline  CPU time and start time per process, plus the account that owns each (a read-only process
//             token query through P/Invoke built in memory: nothing is compiled or written to disk)
//   sample    the quick CPU sample alone, used only to retry when the first one landed too early
export const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$mode = $env:FR_MODE
$script:FrNative = $null
$script:SidNames = @{}
function Initialize-FrNative {
  $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName('FrDyn')), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
  $tb = $ab.DefineDynamicModule('FrDyn').DefineType('FrNative', 'Public,Class')
  $defs = @(
    @('kernel32.dll', 'OpenProcess', [IntPtr], @([uint32], [bool], [int])),
    @('kernel32.dll', 'CloseHandle', [bool], @([IntPtr])),
    @('advapi32.dll', 'OpenProcessToken', [bool], @([IntPtr], [uint32], [IntPtr].MakeByRefType())),
    @('advapi32.dll', 'GetTokenInformation', [bool], @([IntPtr], [int], [IntPtr], [int], [int].MakeByRefType()))
  )
  foreach ($d in $defs) {
    $m = $tb.DefinePInvokeMethod($d[1], $d[0], 'Public,Static,PinvokeImpl', [System.Reflection.CallingConventions]::Standard, $d[2], $d[3], [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Auto)
    $m.SetImplementationFlags($m.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig)
  }
  $script:FrNative = $tb.CreateType()
}
function Get-FrOwner([int]$id) {
  $api = $script:FrNative
  $h = $api::OpenProcess(0x1000, $false, $id)
  if ($h -eq [IntPtr]::Zero) { return $null }
  try {
    $t = [IntPtr]::Zero
    if (-not $api::OpenProcessToken($h, 8, [ref]$t)) { return $null }
    try {
      $len = 0
      [void]$api::GetTokenInformation($t, 1, [IntPtr]::Zero, 0, [ref]$len)
      $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($len)
      try {
        if (-not $api::GetTokenInformation($t, 1, $buf, $len, [ref]$len)) { return $null }
        $sid = New-Object System.Security.Principal.SecurityIdentifier([System.Runtime.InteropServices.Marshal]::ReadIntPtr($buf))
        $key = $sid.Value
        if (-not $script:SidNames.ContainsKey($key)) {
          $name = $null
          try { $name = $sid.Translate([System.Security.Principal.NTAccount]).Value } catch { }
          $script:SidNames[$key] = $name
        }
        return $script:SidNames[$key]
      } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
    } finally { [void]$api::CloseHandle($t) }
  } finally { [void]$api::CloseHandle($h) }
}
function Wait-FrUntil {
  if ($env:FR_AT) {
    $wait = [int64]$env:FR_AT - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
  }
}
function Get-FrSample([bool]$owners) {
  $all = [System.Diagnostics.Process]::GetProcesses()
  $cpus = @{}
  foreach ($p in $all) {
    $cpu = $null
    try { $cpu = $p.TotalProcessorTime.TotalSeconds } catch { }
    $cpus[$p.Id] = $cpu
  }
  $taken = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($owners) { Initialize-FrNative }
  $rows = foreach ($p in $all) {
    $start = $null; $owner = $null
    try { $start = $p.StartTime.ToUniversalTime().ToString('o') } catch { }
    if ($owners) { $owner = Get-FrOwner ([int]$p.Id) }
    [pscustomobject]@{ id = $p.Id; name = $p.ProcessName; cpu_s = $cpus[$p.Id]; start = $start; owner = $owner }
  }
  return [pscustomobject]@{ taken_ms = $taken; processes = @($rows) }
}
if ($mode -eq 'procs') {
  $rows = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime
  $taken = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $list = $rows | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime
  $second = $null
  if ($env:FR_AT) { Wait-FrUntil; $second = Get-FrSample $false }
  [pscustomobject]@{ taken_ms = $taken; processes = @($list); second = $second } | ConvertTo-Json -Compress -Depth 5
}
elseif ($mode -eq 'sample') {
  Wait-FrUntil
  Get-FrSample $false | ConvertTo-Json -Compress -Depth 4
}
elseif ($mode -eq 'baseline') {
  Get-FrSample $true | ConvertTo-Json -Compress -Depth 4
}
`;

const MODES = new Set(["procs", "sample", "baseline"]);

// Runs the fixed script as the -Command argument (no -EncodedCommand, no temp file and no
// execution-policy change, which endpoint tools tend to flag). Resolves to the parsed JSON.
export function runPowerShell(mode, env = {}, { timeoutMs = 60000, exec = execFile } = {}) {
  if (!MODES.has(mode)) throw new Error(`unknown mode ${mode}`);
  return new Promise((resolve, reject) => {
    exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT],
      { env: { ...process.env, ...env, FR_MODE: mode }, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`PowerShell ${mode} failed: ${String(stderr || err.message).split(/\r?\n/)[0]}`));
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error(`PowerShell ${mode} returned something that is not JSON`));
        }
      },
    );
  });
}

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

export function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function listeningPids(platform) {
  if (platform === "win32") return parseNetstat((await run("netstat", ["-ano", "-p", "tcp"])) ?? "");
  if (platform === "darwin") return parseLsof((await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fp"])) ?? "");
  return new Set();
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
  throw new Error(`Platform ${platform} is not supported. Windows and macOS only.`);
}
