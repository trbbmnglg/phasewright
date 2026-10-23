// The one fixed PowerShell script and the two ways it is started. Read-only: it only runs queries
// that Task Manager and Activity Monitor also run. Nothing here closes, signals or changes a process.
import { execFile, spawn } from "node:child_process";

// One fixed PowerShell script. It takes no user input: the mode comes from a fixed list set by this
// file, and it receives no data at all (the tree mode gets two process numbers and an interval from
// this file's own callers). Read-only queries only:
//   procs     Win32_Process rows (what Task Manager shows), as JSON. If FR_AT (a clock time in ms, set by
//             this file) is given it then waits for that moment and takes a quick CPU sample too.
//   baseline  CPU time and start time per process, plus the account that owns each (a read-only process
//             token query through P/Invoke built in memory: nothing is compiled or written to disk)
//   sample    the quick CPU sample alone, used only to retry when the first one landed too early
//   tree      a persistent loop for measure.mjs: lists processes each tick (.NET), reads each new process's
//             parent once (a read-only query on a limited-rights handle), walks the descendants of FR_ROOT
//             and prints one text line per tick (see parseTreeLine in sampler.mjs). It ends when the root
//             process is gone or when its standard input is closed. It touches no other process.
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
    @('advapi32.dll', 'GetTokenInformation', [bool], @([IntPtr], [int], [IntPtr], [int], [int].MakeByRefType())),
    @('ntdll.dll', 'NtQueryInformationProcess', [int], @([IntPtr], [int], [IntPtr], [int], [int].MakeByRefType()))
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
function Get-FrParent([int]$id, [IntPtr]$buf, [int]$offset) {
  # The parent's process number, or -1 when it cannot be read. A read-only query (ProcessBasicInformation)
  # on a handle opened with query-limited rights only.
  $api = $script:FrNative
  $h = $api::OpenProcess(0x1000, $false, $id)
  if ($h -eq [IntPtr]::Zero) { return -1 }
  try {
    $len = 0
    if ($api::NtQueryInformationProcess($h, 0, $buf, 48, [ref]$len) -ne 0) { return -1 }
    return [int][System.Runtime.InteropServices.Marshal]::ReadIntPtr($buf, $offset)
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
elseif ($mode -eq 'tree') {
  $root = [int]$env:FR_ROOT
  $aux = 0
  if ($env:FR_AUX) { $aux = [int]$env:FR_AUX }
  $interval = [int]$env:FR_INTERVAL
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  $inbuf = New-Object byte[] 1
  $pending = [Console]::OpenStandardInput().ReadAsync($inbuf, 0, 1)
  # A full WMI process query costs 5 to 8 s and about 0.5 s of CPU on a busy machine, so it is not used.
  # The process list comes from .NET (cheap), and each process's parent is read once, when the process is
  # first seen, with a read-only query on a limited-rights handle, then remembered.
  Initialize-FrNative
  $pbi = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(64)
  $ppOffset = 5 * [IntPtr]::Size
  $parents = @{}
  $inTree = @{}
  $inTree[$root] = $true
  while ($true) {
    $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $all = [System.Diagnostics.Process]::GetProcesses()
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $live = @{}
    foreach ($p in $all) { $live[$p.Id] = $p }
    foreach ($k in @($parents.Keys)) {
      if (-not $live.ContainsKey($k)) { $parents.Remove($k); $inTree.Remove($k) }
    }
    if (-not $live.ContainsKey($root)) { break }
    # Only processes seen for the first time can join the tree: a parent never changes. A new process joins
    # when its parent is already in the tree (repeated, so a new parent and its new child join together).
    $fresh = [System.Collections.Generic.List[int]]::new()
    foreach ($id in @($live.Keys)) {
      if (-not $parents.ContainsKey($id)) { $parents[$id] = Get-FrParent $id $pbi $ppOffset; $fresh.Add($id) }
    }
    do {
      $added = $false
      foreach ($id in $fresh) {
        if (-not $inTree.ContainsKey($id) -and $inTree.ContainsKey($parents[$id])) { $inTree[$id] = $true; $added = $true }
      }
    } while ($added)
    $self = 0.0
    foreach ($k in @($PID, $aux)) {
      if ($k -gt 0 -and $live.ContainsKey($k)) { try { $self += $live[$k].TotalProcessorTime.TotalSeconds } catch { } }
    }
    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($id in @($inTree.Keys)) {
      $p = $live[$id]
      $cpu = 0
      try { $cpu = $p.TotalProcessorTime.Ticks } catch { }
      $parts.Add(('{0},{1},{2},{3}' -f $id, $parents[$id], $p.WorkingSet64, $cpu))
    }
    [Console]::Out.WriteLine(('FR1 {0} {1} {2}' -f $t, $self.ToString('0.00', $inv), ($parts -join ';')))
    [Console]::Out.Flush()
    if ($pending.IsCompleted) { break }
    $left = $interval - ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0)
    if ($left -gt 0) { Start-Sleep -Milliseconds $left }
  }
}
`;

const MODES = new Set(["procs", "sample", "baseline"]);
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT];

// Runs the fixed script as the -Command argument (no -EncodedCommand, no temp file and no
// execution-policy change, which endpoint tools tend to flag). Resolves to the parsed JSON.
export function runPowerShell(mode, env = {}, { timeoutMs = 60000, exec = execFile } = {}) {
  if (!MODES.has(mode)) throw new Error(`unknown mode ${mode}`);
  return new Promise((resolve, reject) => {
    exec(
      "powershell.exe",
      POWERSHELL_ARGS,
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

// Starts the persistent tree loop and returns Node's child handle (the caller owns it and ends it).
// rootPid: the process whose descendants are measured. auxPid: one more process of the caller's own whose
// CPU is added to the self-cost figure (the streaming counter reader). Both are plain integers.
export function startTreeLoop({ rootPid, auxPid = 0, intervalMs, spawnFn = spawn }) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error("rootPid must be a positive integer");
  if (!Number.isInteger(intervalMs) || intervalMs < 250) throw new Error("intervalMs must be a whole number of at least 250");
  return spawnFn("powershell.exe", POWERSHELL_ARGS, {
    env: { ...process.env, FR_MODE: "tree", FR_ROOT: String(rootPid), FR_AUX: String(Number.isInteger(auxPid) ? auxPid : 0), FR_INTERVAL: String(intervalMs) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}
