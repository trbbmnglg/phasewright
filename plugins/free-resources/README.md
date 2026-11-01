# free-resources

A skill that tells you how pressured your machine is (Windows, macOS or Linux), which processes use the most memory and CPU, and which ones look safe to consider closing, with an analysis of each: what it is, why it is heavy and what closing it would give. It can also run one of your own commands and record what that command really needed (peak memory and CPU cores), then compare that with what is free now.

**It is report-only.** It never closes, kills or signals a process, and it tells the assistant not to either. Closing is your decision, made outside the skill.

It runs on demand only (`disable-model-invocation: true`): nothing happens unless you invoke it.

## What you get

| Command | What it does |
|---|---|
| `processes.mjs` | A scan: pressure verdict (memory, paging, CPU), top consumers, three tables (Suggest closing, Your call, Keep) and an analysis. Protected processes (system, security, shells, editors, git, VPN, coding tools) and anything unrecognised are always Keep. `--explain <pid>` says which rule put one process where it is. |
| `measure.mjs -- <command>` | Runs your command exactly as given, watches it and everything it starts, and stores the peak tree memory and CPU cores in `peaks.jsonl`. |
| `headroom.mjs --task <name>` | Compares what a measured task needs with what is free now, memory and CPU separately, each with its source. |

## Install

**Claude Code (marketplace):**

```bash
claude plugin marketplace add trbbmnglg/phasewright
claude plugin install free-resources@phasewright
```

Then invoke it as `/free-resources:free-resources`.

**Copilot and Cursor:** copy `skills/free-resources` into `.github/skills/` (Copilot) or `.cursor/skills/` (Cursor), in your project or your home folder. The skill has no agents and no model pinning, so nothing is lost. See Compatibility for what has been tried.

**Without plugin marketplaces** (for example, your organization restricts them; check its policy first), from the repo root:

```bash
node scripts/sync-personal.mjs           # writes the skill into ~/.claude/skills/free-resources
node scripts/sync-personal.mjs --check   # reports drift
node scripts/sync-personal.mjs --remove  # removes the generated copies
```

The personal copy is named `free-resources` (no prefix). The script only overwrites or removes files it generated, and it refuses to touch a skill of the same name that it did not write. If you keep a local protected-process list (see below), the sync copies it into the personal copy too.

## Use

Run the scripts **from your project folder**, by their full path. The scan treats the current folder as your project, and `measure.mjs` runs your command there. Running them from inside the skill's own folder would scan and measure the wrong place, so each script prints a warning on stderr if you do that.

In Claude Code the skill does this for you. By hand:

```bash
node "<skill folder>/scripts/processes.mjs"
node "<skill folder>/scripts/measure.mjs" --task tests -- npm test
node "<skill folder>/scripts/headroom.mjs" --task tests
```

A scan takes about 10 to 35 seconds, depending on how busy the machine is. `--json` prints JSON instead of tables.

Measured results are stored in `peaks.jsonl` in `FREE_RESOURCES_DATA` if that is set, else in `%LOCALAPPDATA%\free-resources\` on Windows and `~/.local/state/free-resources/` elsewhere. The stored command line is masked for secrets.

To add your own protected names or paths, see [Using it in your organization](#using-it-in-your-organization).

## What the analysis says

Under the tables, the report has an Analysis section:

- **For each listed group:** what it is (from a fixed table of recognised tools, never from text the process supplies about itself), why it is heavy (processes, memory and its share of the machine, CPU, and the reasons it was listed), what to do, and what closing it would give: "up to" N MB of memory and the CPU it uses (none, for the idle ones in Suggest closing).
- **Pressure:** one sentence on the verdict. When a machine gives no reading at all, the verdict is "not measured", never "no pressure"; when one reading is missing, the report names it.
- **Freeable total:** the most that closing everything under Suggest closing would give. It is "up to", because a process's working set counts pages it shares with others.
- **Off limits:** how many processes are protected or belong to other accounts and how much memory they use, with the heaviest of your own protected processes and of the system and service accounts named and the reason each is never offered (a security agent says so). Other people's processes are counted, and named only with `--all`. If one of them is the problem, ask whoever manages the machine.
- **Virtual machines and background programs with their own way to stop:** when the WSL 2 virtual machine, Docker Desktop, Podman, the Gradle or Kotlin daemons or the Android emulator use 300 MB or more together, the report prints that tool's own stop command (`wsl --shutdown`, `docker desktop stop`, `podman machine stop`, `gradle --stop`; for the emulator, only the advice to close its window) and what its documentation says it ends, with the documentation link and the date it was read. **You run these yourself.** This skill never does.

Every process name the report prints is cleaned first: control and formatting characters are removed, anything outside letters, digits and a few plain symbols becomes `?`, and a name is cut at 40 characters, so a process cannot make a table row break or put text in the report that looks like something else.

## Using it in your organization

The protection lists are plain JSON files, so a team or an organization can deploy its own. All of them are read, and their entries are added together:

| List | Windows | macOS | Linux |
|---|---|---|---|
| Organization policy | `%ProgramData%\free-resources\policy.json` | `/Library/Application Support/free-resources/policy.json` | `/etc/free-resources/policy.json` |
| Your list | `%APPDATA%\free-resources\protected.json` | `$XDG_CONFIG_HOME/free-resources/protected.json`, else `~/.config/free-resources/protected.json` | the same |
| A file you name | the file `FREE_RESOURCES_PROTECTED` points to | the same | the same |
| The plugin folder | `scripts/protected.local.json` (git-ignored, never published) | the same | the same |

The format, with a copy in [`scripts/protected.example.json`](skills/free-resources/scripts/protected.example.json):

```json
{
  "names": ["example-agent*", "example-vpn"],
  "paths": ["d:/example-corp-tools/", "/opt/example-corp/"]
}
```

- `names` are process names, compared without case and without `.exe`; a trailing or inner `*` matches anything. `paths` match anywhere in a program's path or command line. Each list holds up to 500 entries of up to 200 characters, and a file may be up to 256 KB.
- **A list can only add protection.** Nothing in a file can remove a built-in protection or put a process in Suggest closing, so it does not matter who can write a policy file or point `FREE_RESOURCES_PROTECTED` at one.
- **A file that cannot be used is ignored and reported.** If one is not valid JSON, is not an object, is too large or cannot be read, the report says which list and why, and takes nothing from it. The same holds when `FREE_RESOURCES_PROTECTED` names a file that is not there.
- The report prints how many names and paths each list gave (`Protected lists loaded: ...`), never the entries.
- `processes.mjs --explain <pid>` names the rule that decided one process, for example `in the local protected list (name example-agent*)`, so an administrator can check a rule does what was meant.
- A list may also hold `"stop": false`. This version only reports and ends nothing, so the setting changes nothing; it is read and shown in the JSON report (`protection.stop_allowed_by_settings`) so that a policy file written today keeps its meaning. Other keys are ignored.

The lists are for your own tools and agents. Security and endpoint software that this skill already recognises is protected without any list.

## What this runs on your machine

This skill reads process and performance information through operating system tools. Everything below is read-only. Nothing is installed, compiled to disk or sent anywhere.

**Programs it starts**

| Platform | Program | Why |
|---|---|---|
| Windows | `System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <fixed script>` | Lists processes, their CPU time, start time and owner, and (for `measure.mjs`) walks the process tree of your command. The script is fixed text inside `scripts/lib/powershell.mjs`; it takes no user input. No `-EncodedCommand`, no temp file, no execution-policy change. It also makes one WMI query (`Get-CimInstance Win32_Process`) for the process list, command lines and working sets. |
| Windows | `System32\typeperf.exe` | Reads three performance counters that ship with Windows: available memory, pages per second, total processor time. |
| Windows | `System32\netstat.exe -ano -p tcp` | Finds which processes are listening on a port, so they are not suggested for closing. |
| Windows | `System32\cmd.exe` | Only for `measure.mjs`: your own command runs through it so `npm` and other `.cmd` files resolve. Each argument is quoted separately, and nothing is added. |
| macOS | `/bin/ps`, `/usr/bin/vm_stat`, `/usr/sbin/sysctl`, `/usr/bin/memory_pressure`, `/usr/bin/top` | Process list with memory and CPU time, available memory, page size and swap, memory pressure, and CPU use. |
| macOS | `/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN` | Finds which processes are listening on a port. |
| Linux | `/usr/bin/getconf CLK_TCK` (or `/bin/getconf`) | The unit of the CPU times in `/proc`. If it cannot be run, the scripts assume 100, which every common Linux architecture uses, and say so. |

Every program above is started from its absolute path (on Windows, below the Windows folder: `SystemRoot` when it looks like `X:\Windows`, else `C:\Windows`), from that folder or `/` rather than your project, with no shell, and never found through `PATH`. Windows PowerShell gets only its own module folder, so a module folder added to `PSModulePath` is not used. macOS programs run in the C locale, so dates and numbers come out in one format. Before 0.1.2 the programs were started by name, and on Windows a file with the same name in the project folder would have run instead of the real one.

With `measure.mjs` your own command is also started, by you, as typed.

**Files it reads on Linux.** Linux needs no other program: the scripts read `/proc` themselves, with plain file reads. For every process they try `/proc/<pid>/stat`, `status`, `cmdline`, `cgroup` and the `exe` link, and they skip what the system does not let them read (usually another user's process). For listening ports they read `/proc/net/tcp` and `tcp6`, and then the `fd` links of processes they can read, to match a socket to its process. They also read `/proc/meminfo`, `/proc/vmstat`, `/proc/stat`, `/proc/pressure/memory` when the kernel has it, and `/etc/passwd` to turn user ids into names. They never read a process's environment or memory.

**Native calls.** On Windows, the PowerShell script builds five native function declarations in memory (`System.Reflection.Emit`; nothing is compiled or written to disk) and calls them:

| Call | Used for |
|---|---|
| `OpenProcess` with access `0x1000` (query-limited information) | Opens a read-only handle to a process, to read its owner or its parent. This access right cannot end, change or read the memory of a process. |
| `OpenProcessToken` with `TOKEN_QUERY` | Reads which account owns the process. |
| `GetTokenInformation` (`TokenUser`) | Gets that account's identifier. It is then turned into a name with the .NET account lookup, which Windows normally answers locally and may ask a domain controller for a domain account. |
| `NtQueryInformationProcess` (`ProcessBasicInformation`) | Reads a process's parent number once, when `measure.mjs` first sees the process, so it can tell which processes belong to your command. A WMI query for this costs several seconds of CPU on a busy machine. |
| `CloseHandle` | Closes the handles above. |

The rest is ordinary .NET: process list, CPU time, start time, working set. macOS and Linux use no native calls: macOS only the programs above, Linux only file reads.

**What it ends.** No process other than its own helpers is ever ended. On Windows, `measure.mjs` starts two helpers (one streaming `typeperf`, one persistent PowerShell) and ends them when measuring stops, through the handles Node gave it, never by name or number. If one of the scan's helper programs runs past its time limit, Node ends that helper through its own handle. On macOS and Linux there are no persistent helpers. It does not send any signal to your command; Ctrl+C is handled by the terminal.

**What it writes.** Only `peaks.jsonl` (and the data folder holding it), by `measure.mjs`. The scan and headroom check write nothing. It reads the protected lists and `peaks.jsonl`. It writes nothing when the data folder is inside the project being measured, or when `peaks.jsonl` is a link or a second name for another file, so a repository cannot point the record at another file of yours.

**Network.** None. It makes no connection of its own. (The Windows account lookup above is an operating system call, not this skill's.)

**Endpoint security tools.** Security software may flag a PowerShell script that declares native functions in memory, even a read-only one like this. If your organization monitors that, check with your security team before installing. A mode that avoids native calls is a parked follow-up, not built yet.

## Compatibility

- **Windows:** tested.
- **Linux:** supported. The scan, measure and headroom run against a real Linux in the project's automated tests, and the `/proc` readers are tested on sample files. Nobody has tried it by hand yet.
- **macOS:** untested. It was written from documented commands and checked against sample data; the project's automated tests also run on macOS, which is not the same as trying it by hand.
- **Copilot and Cursor:** untested until tried. Both read `SKILL.md`; the skill uses no Claude Code-only features.

## Limits

- On a busy machine the first process-tree sample can arrive late (the run records how long into the run it came). A short run may have too few samples to trust, and the report says so.
- CPU is a lower bound: processes that start and end between two samples are missed.
- A process's working set counts pages it shares with other processes, so freed-memory figures are "up to".
- The thresholds (15% margin, 10% memory reserve, 5-run window) are starting values, not tuned.
- On Linux, inside a container, `/proc/meminfo` shows the host's memory, not the container's limit, so the memory figures are the host's.
- On Linux, the memory-stall figure appears only when the kernel provides `/proc/pressure/memory`; without it that reading is "not measured".
- On Windows, if the machine does not let you read its performance counters (the Performance Log Users group controls this, and a non-English Windows names them differently), paging is "not measured" and memory and CPU come from Node's own readings; the report warns when this happens.
- A process counts as orphaned when the process that started it is gone. On Linux and macOS, a process whose parent is the system's first process counts too, so a dev server you started on purpose with `nohup` or `setsid` looks the same. The report lists the signals behind every suggestion, so you can judge it.

## Test it

```bash
claude plugin validate plugins/free-resources --strict
node --test tests/free-resources*.test.mjs
```

The tests use sample data and a made-up `/proc`, never your real processes, apart from a few live tests that start their own child processes. A guard test follows every import of the three entry scripts and fails if any of that code ends, signals or elevates a process (the one exception is the measurer ending its own helpers), loads code by a computed name, imports a package, starts a program outside the fixed table or through a shell (the one exception is `measure.mjs` running your own command).

## Eval

`evals/never-offers-close` checks that, asked to close a suggested process, the skill refuses and offers no command.
