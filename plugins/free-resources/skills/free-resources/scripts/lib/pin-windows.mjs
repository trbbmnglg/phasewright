// Windows: reads who and what a process is through a handle opened on it, and can keep that handle open (pin it) while
// free.mjs acts. Read-only: the script asks for query and synchronize rights only, which cannot end, change or read the
// memory of a process, and it never calls anything that ends one. While the handle is open Windows cannot give the
// process's number to another process, so what was checked is what the caller acts on. Used by free.mjs only, never by
// the read-only scan.
//
// Two modes, both started with a fixed script and numbers this file has validated:
//   pin    one process (FR_PIN_PID). Prints "FRPIN <json>" with its facts (or { ok: false } when it cannot be opened), then
//          reads lines on standard input: "ping" prints "FRPIN {"alive": true|false}" (the handle is held and the process
//          still runs) and waits for the next line; "wait" waits up to FR_PIN_WAIT_MS for the process to end and prints
//          "FRPIN {"exited": true|false}"; anything else, or the input closing, closes the handle and exits.
//   read   several processes (FR_PIN_PIDS, comma-separated): one "FRPIN <json>" line each, holding nothing. For a plan,
//          which only assesses; the stop pins each process again.
import { spawn } from "node:child_process";
import { bin, helperOptions, powershellModulePath } from "./bin.mjs";

// What the script reads, all through the one handle (and, for the parent, a second query-only handle):
//   creation, start_iso  GetProcessTimes: the creation time, in 100 ns units since 1601, and as an ISO time
//   image_path           QueryFullProcessImageName: the program's full path
//   sid                  the owner, from the process token (TokenUser)
//   elevated             TokenElevation         integrity_rid   TokenIntegrityLevel (0x2000 is medium)
//   debug_privilege      SeDebugPrivilege is in the token (its LUID is the constant 20)
//   session              ProcessIdToSessionId   critical        IsProcessCritical
//   protection           the protection level (NtQueryInformationProcess, ProcessProtectionInformation): 0 is none
//   has_window           the process has a main window (.NET Process.MainWindowHandle)
//   parent_pid, parent_state  "gone" (not running, or started after this one), "same_owner", "other_owner", "unreadable"
// Any value that cannot be read is null, and the stop gate refuses on null.
export const PIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName('FrPin')), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
$tb = $ab.DefineDynamicModule('FrPin').DefineType('FrPinNative', 'Public,Class')
$defs = @(
  @('kernel32.dll', 'OpenProcess', [IntPtr], @([uint32], [bool], [int])),
  @('kernel32.dll', 'CloseHandle', [bool], @([IntPtr])),
  @('kernel32.dll', 'GetProcessId', [uint32], @([IntPtr])),
  @('kernel32.dll', 'GetProcessTimes', [bool], @([IntPtr], [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType())),
  @('kernel32.dll', 'QueryFullProcessImageName', [bool], @([IntPtr], [uint32], [System.Text.StringBuilder], [uint32].MakeByRefType())),
  @('kernel32.dll', 'ProcessIdToSessionId', [bool], @([uint32], [uint32].MakeByRefType())),
  @('kernel32.dll', 'IsProcessCritical', [bool], @([IntPtr], [bool].MakeByRefType())),
  @('kernel32.dll', 'WaitForSingleObject', [uint32], @([IntPtr], [uint32])),
  @('advapi32.dll', 'OpenProcessToken', [bool], @([IntPtr], [uint32], [IntPtr].MakeByRefType())),
  @('advapi32.dll', 'GetTokenInformation', [bool], @([IntPtr], [int], [IntPtr], [int], [int].MakeByRefType())),
  @('ntdll.dll', 'NtQueryInformationProcess', [int], @([IntPtr], [int], [IntPtr], [int], [int].MakeByRefType()))
)
foreach ($d in $defs) {
  $m = $tb.DefinePInvokeMethod($d[1], $d[0], 'Public,Static,PinvokeImpl', [System.Reflection.CallingConventions]::Standard, $d[2], $d[3], [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Auto)
  $m.SetImplementationFlags($m.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig)
}
$api = $tb.CreateType()
$M = [System.Runtime.InteropServices.Marshal]
$live = @{}
foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { $live[$p.Id] = $true }
function Out-Pin($o) { [Console]::Out.WriteLine('FRPIN ' + ($o | ConvertTo-Json -Compress -Depth 3)); [Console]::Out.Flush() }
# Reads one token information class into a buffer and hands it to $parse while the buffer is alive.
function Read-Token([IntPtr]$tok, [int]$class, [scriptblock]$parse) {
  $len = 0
  [void]$api::GetTokenInformation($tok, $class, [IntPtr]::Zero, 0, [ref]$len)
  if ($len -le 0) { return $null }
  $buf = $M::AllocHGlobal($len)
  try {
    if (-not $api::GetTokenInformation($tok, $class, $buf, $len, [ref]$len)) { return $null }
    return (& $parse $buf)
  } finally { $M::FreeHGlobal($buf) }
}
$SidOf = { param($b) (New-Object System.Security.Principal.SecurityIdentifier($M::ReadIntPtr($b))).Value }
function Get-Sid([IntPtr]$h) {
  $tok = [IntPtr]::Zero
  if (-not $api::OpenProcessToken($h, 8, [ref]$tok)) { return $null }
  try { return (Read-Token $tok 1 $SidOf) } finally { [void]$api::CloseHandle($tok) }
}
function Get-Creation([IntPtr]$h) {
  $c = [long]0; $e = [long]0; $k = [long]0; $u = [long]0
  if ($api::GetProcessTimes($h, [ref]$c, [ref]$e, [ref]$k, [ref]$u)) { return $c }
  return $null
}
# Opens one process with query-limited-information and synchronize rights (0x00101000) and checks the handle is for it.
function Open-Target([int]$target) {
  $h = $api::OpenProcess(0x00101000, $false, $target)
  if ($h -ne [IntPtr]::Zero -and $api::GetProcessId($h) -ne $target) { [void]$api::CloseHandle($h); $h = [IntPtr]::Zero }
  return $h
}
function Read-Facts([int]$target, [IntPtr]$h) {
  $out = [ordered]@{ ok = $true; pid = $target; creation = $null; start_iso = $null; image_path = $null; sid = $null; elevated = $null; integrity_rid = $null; debug_privilege = $null; session = $null; critical = $null; protection = $null; parent_pid = $null; parent_state = 'unreadable'; has_window = $null }
  $creation = $null
  try { $creation = Get-Creation $h } catch { }
  if ($creation -ne $null) { $out.creation = [string]$creation; $out.start_iso = [DateTime]::FromFileTimeUtc($creation).ToString('o') }
  try {
    $sb = New-Object System.Text.StringBuilder 1024
    $size = [uint32]1024
    if ($api::QueryFullProcessImageName($h, 0, $sb, [ref]$size)) { $out.image_path = $sb.ToString() }
  } catch { }
  $tok = [IntPtr]::Zero
  try {
    if ($api::OpenProcessToken($h, 8, [ref]$tok)) {
      $out.sid = Read-Token $tok 1 $SidOf
      $el = Read-Token $tok 20 { param($b) $M::ReadInt32($b) }
      if ($el -ne $null) { $out.elevated = ($el -ne 0) }
      $il = Read-Token $tok 25 $SidOf
      if ($il -match '^S-1-16-(\\d+)$') { $out.integrity_rid = [int]$matches[1] }
      $out.debug_privilege = Read-Token $tok 3 { param($b)
        $n = $M::ReadInt32($b)
        $found = $false
        for ($i = 0; $i -lt $n; $i++) {
          $low = $M::ReadInt32($b, 4 + 12 * $i); $high = $M::ReadInt32($b, 8 + 12 * $i)
          if ($low -eq 20 -and $high -eq 0) { $found = $true }
        }
        $found
      }
    }
  } catch { } finally { if ($tok -ne [IntPtr]::Zero) { [void]$api::CloseHandle($tok) } }
  try { $s = [uint32]0; if ($api::ProcessIdToSessionId([uint32]$target, [ref]$s)) { $out.session = [int]$s } } catch { }
  try { $c = $false; if ($api::IsProcessCritical($h, [ref]$c)) { $out.critical = [bool]$c } } catch { }
  $buf = $M::AllocHGlobal(64)
  try {
    $len = 0
    if ($api::NtQueryInformationProcess($h, 61, $buf, 1, [ref]$len) -eq 0) { $out.protection = [int]$M::ReadByte($buf) }
    if ($api::NtQueryInformationProcess($h, 0, $buf, 48, [ref]$len) -eq 0) {
      $ppid = [int]$M::ReadIntPtr($buf, 5 * [IntPtr]::Size)
      $out.parent_pid = $ppid
      if ($ppid -le 0 -or -not $live.ContainsKey($ppid)) { $out.parent_state = 'gone' }
      else {
        $ph = $api::OpenProcess(0x1000, $false, $ppid)
        if ($ph -ne [IntPtr]::Zero) {
          try {
            $pc = Get-Creation $ph
            $psid = Get-Sid $ph
            if ($pc -ne $null -and $creation -ne $null -and $pc -gt $creation) { $out.parent_state = 'gone' }
            elseif ($psid -ne $null -and $out.sid -ne $null) { if ($psid -eq $out.sid) { $out.parent_state = 'same_owner' } else { $out.parent_state = 'other_owner' } }
          } finally { [void]$api::CloseHandle($ph) }
        }
      }
    }
  } catch { } finally { $M::FreeHGlobal($buf) }
  try { $out.has_window = ([System.Diagnostics.Process]::GetProcessById($target).MainWindowHandle -ne [IntPtr]::Zero) } catch { }
  return $out
}
if ($env:FR_PIN_PIDS) {
  foreach ($t in ($env:FR_PIN_PIDS -split ',')) {
    $id = [int]$t
    $h = Open-Target $id
    if ($h -eq [IntPtr]::Zero) { Out-Pin ([ordered]@{ ok = $false; pid = $id }); continue }
    try { Out-Pin (Read-Facts $id $h) } finally { [void]$api::CloseHandle($h) }
  }
  exit 0
}
$target = [int]$env:FR_PIN_PID
$waitMs = [uint32]$env:FR_PIN_WAIT_MS
$h = Open-Target $target
if ($h -eq [IntPtr]::Zero) { Out-Pin ([ordered]@{ ok = $false; pid = $target }); exit 0 }
try {
  Out-Pin (Read-Facts $target $h)
  while ($true) {
    $cmd = [Console]::In.ReadLine()
    if ($cmd -eq 'ping') { Out-Pin ([ordered]@{ alive = ($api::WaitForSingleObject($h, 0) -eq 258) }); continue }
    if ($cmd -eq 'wait') { Out-Pin ([ordered]@{ exited = ($api::WaitForSingleObject($h, $waitMs) -eq 0) }) }
    break
  }
} finally { [void]$api::CloseHandle($h) }
`;

const SCRIPT_ARGS = ["-NoProfile", "-NonInteractive", "-Command", PIN_SCRIPT];
const powershellPath = () => bin("powershell", { platform: "win32" });
const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid < 2 ** 32;

function start(env, { spawnFn, path }) {
  return spawnFn(path, SCRIPT_ARGS, { ...helperOptions({ ...env, PSModulePath: powershellModulePath() }, { platform: "win32" }), stdio: ["pipe", "pipe", "ignore"] });
}

// Collects the "FRPIN" lines a child prints, and hands them out one by one.
function lineReader(child) {
  let buffer = "";
  const lines = [];
  const waiters = [];
  const deliver = () => { while (lines.length && waiters.length) waiters.shift()(lines.shift()); };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line.startsWith("FRPIN ")) lines.push(line.slice(6));
    }
    deliver();
  });
  const closed = new Promise((resolve) => {
    const done = () => { while (waiters.length) waiters.shift()(null); resolve(); };
    child.on("close", done);
    child.on("error", done);
  });
  const next = (ms) => new Promise((resolve) => {
    let settled = false;
    const w = (v) => { if (!settled) { settled = true; resolve(v); } };
    waiters.push(w);
    deliver();
    setTimeout(() => { const at = waiters.indexOf(w); if (at >= 0) waiters.splice(at, 1); w(null); }, ms).unref();
  });
  return { next, closed, all: () => lines.splice(0) };
}

const parse = (line) => { try { return line ? JSON.parse(line) : null; } catch { return null; } };

// Ends this module's own PowerShell child through the handle Node gave it, when it does not exit by itself in time.
function endOwnHelper(child) {
  try { child.kill(); } catch { /* already gone */ }
}

// Pins one process. Resolves to { facts, alive(), wait(), release() }:
//   facts     what the script read (facts.ok is false when the process could not be opened: gone, or not ours to query)
//   alive()   true when the pin still holds the process and it still runs (asked right before acting)
//   wait()    waits up to waitMs for the process to end; resolves to { exited: true | false | null } and lets go
//   release() lets go without waiting
// The caller calls one of the two; until then the process's number cannot change hands.
export async function pinWindows(pid, { spawnFn = spawn, path = powershellPath(), waitMs = 10000, readTimeoutMs = 45000 } = {}) {
  if (!validPid(pid)) throw new RangeError("not a process number");
  if (!path) throw new Error("Windows PowerShell was not found in the Windows folder");
  const child = start({ FR_PIN_PID: String(pid), FR_PIN_WAIT_MS: String(Math.max(0, Math.floor(waitMs))) }, { spawnFn, path });
  const reader = lineReader(child);
  const finish = async (command) => {
    try { child.stdin.end(command ? `${command}\n` : ""); } catch { /* already closed */ }
    const timer = setTimeout(() => endOwnHelper(child), 5000);
    timer.unref();
    await reader.closed;
    clearTimeout(timer);
  };
  const facts = parse(await reader.next(readTimeoutMs));
  if (!facts || facts.pid !== pid) {
    await finish(null);
    return { facts: { ok: false, pid }, wait: async () => ({ exited: null }), release: async () => {}, alive: async () => false };
  }
  let done = false;
  return {
    facts,
    // True only when the pin's PowerShell is still running, still holds the handle, and the process has not ended.
    alive: async () => {
      if (done || child.exitCode !== null || child.signalCode !== null) return false;
      try { child.stdin.write("ping\n"); } catch { return false; }
      const r = parse(await reader.next(15000));
      return r?.alive === true;
    },
    wait: async () => {
      if (done) return { exited: null };
      done = true;
      try { child.stdin.write("wait\n"); } catch { /* closed */ }
      const r = parse(await reader.next(waitMs + 15000));
      await finish(null);
      return { exited: typeof r?.exited === "boolean" ? r.exited : null };
    },
    release: async () => {
      if (done) return;
      done = true;
      await finish("done");
    },
  };
}

// Reads several processes in one PowerShell run, holding nothing. Resolves to a Map from pid to facts ({ ok: false } for
// one that could not be opened). For a plan only.
export async function readWindowsFacts(pids, { spawnFn = spawn, path = powershellPath(), timeoutMs = 60000 } = {}) {
  const list = [...new Set(pids)];
  if (!list.every(validPid)) throw new RangeError("not a process number");
  const out = new Map();
  if (!list.length) return out;
  if (!path) throw new Error("Windows PowerShell was not found in the Windows folder");
  const child = start({ FR_PIN_PIDS: list.join(",") }, { spawnFn, path });
  const reader = lineReader(child);
  try { child.stdin.end(); } catch { /* closed */ }
  const timer = setTimeout(() => endOwnHelper(child), timeoutMs);
  timer.unref();
  await reader.closed;
  clearTimeout(timer);
  for (const f of reader.all().map(parse)) if (f && list.includes(f.pid)) out.set(f.pid, f);
  return out;
}
