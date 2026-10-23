# free-resources

A skill that tells you how pressured your machine is, which processes use the most memory and CPU, and which ones look safe to consider closing, with the reason for each. It can also run one of your own commands and record what that command really needed (peak memory and CPU cores), then compare that with what is free now.

**It is report-only.** It never closes, kills or signals a process, and it tells the assistant not to either. Closing is your decision, made outside the skill.

It runs on demand only (`disable-model-invocation: true`): nothing happens unless you invoke it.

## What you get

| Command | What it does |
|---|---|
| `processes.mjs` | A scan: pressure verdict (memory, paging, CPU), top consumers, and three tables: Suggest closing, Your call, Keep. Protected processes (system, security, shells, editors, git, VPN, coding tools) and anything unrecognised are always Keep. |
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

To add your own protected names or paths, put `{"names":[...],"paths":[...]}` in `scripts/protected.local.json` (git-ignored, never published), or point `FREE_RESOURCES_PROTECTED` at another file.

## What this runs on your machine

This skill reads process and performance information through operating system tools. Everything below is read-only. Nothing is installed, compiled to disk or sent anywhere.

**Programs it starts**

| Platform | Program | Why |
|---|---|---|
| Windows | `powershell.exe -NoProfile -NonInteractive -Command <fixed script>` | Lists processes, their CPU time, start time and owner, and (for `measure.mjs`) walks the process tree of your command. The script is fixed text inside `scripts/lib/powershell.mjs`; it takes no user input. No `-EncodedCommand`, no temp file, no execution-policy change. It also makes one WMI query (`Get-CimInstance Win32_Process`) for the process list, command lines and working sets. |
| Windows | `typeperf` | Reads three performance counters that ship with Windows: available memory, pages per second, total processor time. |
| Windows | `netstat -ano -p tcp` | Finds which processes are listening on a port, so they are not suggested for closing. |
| Windows | `cmd.exe` | Only for `measure.mjs`: your own command runs through it so `npm` and other `.cmd` files resolve. Each argument is quoted separately, and nothing is added. |
| macOS | `ps`, `vm_stat`, `sysctl`, `memory_pressure`, `top` | Process list with memory and CPU time, available memory, page size and swap, memory pressure, and CPU use. |
| macOS | `lsof -nP -iTCP -sTCP:LISTEN` | Finds which processes are listening on a port. |

With `measure.mjs` your own command is also started, by you, as typed.

**Native calls.** On Windows, the PowerShell script builds five native function declarations in memory (`System.Reflection.Emit`; nothing is compiled or written to disk) and calls them:

| Call | Used for |
|---|---|
| `OpenProcess` with access `0x1000` (query-limited information) | Opens a read-only handle to a process, to read its owner or its parent. This access right cannot end, change or read the memory of a process. |
| `OpenProcessToken` with `TOKEN_QUERY` | Reads which account owns the process. |
| `GetTokenInformation` (`TokenUser`) | Gets that account's identifier. It is then turned into a name with the .NET account lookup, which Windows normally answers locally and may ask a domain controller for a domain account. |
| `NtQueryInformationProcess` (`ProcessBasicInformation`) | Reads a process's parent number once, when `measure.mjs` first sees the process, so it can tell which processes belong to your command. A WMI query for this costs several seconds of CPU on a busy machine. |
| `CloseHandle` | Closes the handles above. |

The rest is ordinary .NET: process list, CPU time, start time, working set. macOS uses no native calls, only the programs above.

**What it ends.** No process other than its own helpers is ever ended. On Windows, `measure.mjs` starts two helpers (one streaming `typeperf`, one persistent PowerShell) and ends them when measuring stops, through the handles Node gave it, never by name or number. If one of the scan's helper programs runs past its time limit, Node ends that helper through its own handle. On macOS there are no persistent helpers. It does not send any signal to your command; Ctrl+C is handled by the terminal.

**What it writes.** Only `peaks.jsonl` (and the data folder holding it), by `measure.mjs`. The scan and headroom check write nothing. It reads your protected-process list and `peaks.jsonl`.

**Network.** None. It makes no connection of its own. (The Windows account lookup above is an operating system call, not this skill's.)

**Endpoint security tools.** Security software may flag a PowerShell script that declares native functions in memory, even a read-only one like this. If your organization monitors that, check with your security team before installing. A mode that avoids native calls is a parked follow-up, not built yet.

## Compatibility

- **Windows:** tested.
- **macOS:** untested. It was written from documented commands and checked against sample data only.
- **Copilot and Cursor:** untested until tried. Both read `SKILL.md`; the skill uses no Claude Code-only features.
- **Linux:** not supported.

## Limits

- On a busy machine the first process-tree sample can arrive late (the run records how long into the run it came). A short run may have too few samples to trust, and the report says so.
- CPU is a lower bound: processes that start and end between two samples are missed.
- A process's working set counts pages it shares with other processes, so freed-memory figures are "up to".
- The thresholds (15% margin, 10% memory reserve, 5-run window) are starting values, not tuned.

## Test it

```bash
claude plugin validate plugins/free-resources --strict
node --test tests/free-resources.test.mjs tests/free-resources-headroom.test.mjs
```

The tests use sample data, never your real processes. A guard test fails if any script gains a call that ends or signals a process.

## Eval

`evals/never-offers-close` checks that, asked to close a suggested process, the skill refuses and offers no command.
