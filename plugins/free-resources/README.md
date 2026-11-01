# free-resources

A skill that tells you how pressured your machine is (Windows, macOS or Linux), which processes use the most memory and CPU, and which ones look safe to consider closing, with an analysis of each: what it is, why it is heavy and what closing it would give. It can also run one of your own commands and record what that command really needed (peak memory and CPU cores), then compare that with what is free now. And it can stop left-over dev tools of yours that you pick.

**It reads, and it stops only what you pick.** The scan, the measurer and the headroom check only read. One script, `free.mjs`, can stop processes, and only recognised dev tools of yours (left-over dev servers, watchers, test browsers) that you pick one by one, each checked again right before anything is done. It never stops system, security, managed or other users' processes, the editor or assistant session it runs in, or anything it does not recognise, and it refuses to run elevated or as root. See [Stopping](#stopping).

It runs on demand only (`disable-model-invocation: true`): nothing happens unless you invoke it.

## What you get

| Command | What it does |
|---|---|
| `processes.mjs` | A scan: pressure verdict (memory, paging, CPU), top consumers, three tables (Suggest closing, Your call, Keep) and an analysis. Protected processes (system, security, shells, editors, git, VPN, coding tools) and anything unrecognised are always Keep. `--explain <pid>` says which rule put one process where it is. |
| `measure.mjs -- <command>` | Runs your command exactly as given, watches it and everything it starts, and stores the peak tree memory and CPU cores in `peaks.jsonl`. |
| `headroom.mjs --task <name>` | Compares what a measured task needs with what is free now, memory and CPU separately, each with its source. |
| `free.mjs plan`, `stop`, `force` | Plans which of your left-over dev tools may be stopped and why the others may not, then stops the ones you pick. See [Stopping](#stopping). |

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

## Stopping

```bash
node "<skill folder>/scripts/free.mjs" plan --json
node "<skill folder>/scripts/free.mjs" stop --plan <plan id> --pid <pid> [--pid <pid> ...] --json
node "<skill folder>/scripts/free.mjs" force --plan <plan id> --pid <pid> --json
```

In Claude Code the skill runs these for you and asks you first: which processes to stop (at most four per question, none picked for you), and once more for each one that can only be ended at once.

- **`plan`** stops nothing. It scans, takes the recognised dev tools of yours that the scan put under Suggest closing (left over) or that are busy right now (the 20 largest), checks each against the stop gate, and lists what passed, with how it would be stopped, and what did not, with the reason. It saves the plan for 10 minutes; only the newest plan counts.
- **`stop`** takes pids from the plan. For each one, one after another, it checks itself, scans again, reads the process again and runs the gate again against what the plan recorded (its number, exact start time, program, owner, and on Linux the boot). Only if every check still passes does it ask the process to stop: on macOS and Linux with SIGTERM, on Windows with `taskkill /PID <pid>` for a windowed program, which is what clicking its X does. It then waits up to 10 seconds and says whether it ended.
- **`force`** ends one process at once: `taskkill /PID <pid> /F` on Windows, SIGKILL elsewhere, after the same checks. On Windows a console program (a dev server in a terminal) can only be ended this way: asking it to close would close its console window, and with it every other program attached to that console. The skill runs `force` only after a second yes for that one process.

**The stop gate.** A process may be stopped only when every one of these says yes; anything that cannot be read is "unknown", and unknown refuses:

- it is a recognised dev tool the classifier put under Suggest closing, or a busy one; the tool is worked out again from the program actually running, and it is still the process the scan saw;
- it is not protected by name, by any protected list, or by running from a system or program-install folder (a Node in Program Files running a dev server from your own home folder is allowed; the home folder comes from your account, not from `HOME` or `USERPROFILE`);
- it is yours: the same Windows account (by its security identifier, never its name), or on macOS and Linux the same real, effective and saved user and group ids;
- it is not this tool, a process that started it or one it started, and not inside the session this runs in: the nearest editor or assistant above it, and the nearest process above it that is not a shell or terminal, however many shells are between (an assistant installed with npm runs as plain `node`, and Git Bash on Windows nests three shells). Started detached, so that it cannot see what started it or its chain ends in shells with no terminal window, it refuses everything;
- it was started from a shell or terminal, or was left behind (its parent is gone), never started by an editor, an assistant, a security or remote-access tool or the system;
- it is not managed: on Windows not in session 0 or another sign-in session, not critical, not protected, not elevated, at the normal integrity level, and not started by a process of another account; on Linux in your own user slice (cgroup v2), inside no systemd service or session service, not in another PID namespace, not traced, with no capabilities, no negative out-of-memory setting and not leading a terminal session; on macOS not signed by Apple (`codesign --verify -R="anchor apple"` must answer exactly "not Apple"), and neither a job launchd runs (`launchctl list`) nor started by one;
- on a stop, everything that pins it matches the plan, and how it would be stopped, worked out again, matches what the plan said.

**Refusing on purpose.** `free.mjs` checks itself first and stops nothing when it runs elevated, as root, through sudo, with capabilities, in a container, outside your own user session on Linux (CI runners and some remote shells), outside a desktop login on macOS (an SSH login, where launchd's job list leaves the desktop's jobs out), or on a macOS where the Apple signature check does not answer as expected. It says why, and exits with code 4. There is nothing to work around: run it as yourself, in a normal terminal.

**Where it acts.** On Windows the process is pinned for the whole stop: a handle opened with query and synchronize rights only is held from the check, through `taskkill`, to the wait, so its number cannot pass to another process in between, and the pin is asked right before `taskkill` whether it still holds the process. On macOS and Linux the start time is read once more right before the signal; a process that changed is left alone. An access-denied answer ends that attempt: nothing is retried, and no other way is tried.

**What it records.** Each action is two lines in `actions.jsonl` in the data folder, one before acting and one with what happened: when, which plan, which pid, the cleaned name and tool, and what was done. Never a command line. If the first line cannot be written, nothing is done.

**The plan file is not trusted.** It lasts exactly 10 minutes, it is never read from inside a project folder or from another user's file, and a stop takes nothing from it but the process numbers and what pins each one: whether a process may be stopped, and how, is decided again from what is read at that moment, and the names printed come from the fresh scan.

**Exit codes.** 0 every picked process ended; 1 one or more did not; 2 a usage error; 4 refused before anything was done.

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
- **A file that cannot be used is ignored and reported.** If one is not valid JSON, is not an object, is too large or cannot be read, the report says which list and why, and takes nothing from it. The same holds when `FREE_RESOURCES_PROTECTED` names a file that is not there. A list with some entries that cannot be used (not text, empty, too long, too many, or `names` that is not a list) gives its good entries, and switches stopping off until it is fixed.
- **The environment cannot hide a list.** The organization policy and your list are read at the places the variables name (`%ProgramData%`, `%APPDATA%`, `$XDG_CONFIG_HOME`) and also at the system's own places (the Windows drive's `ProgramData`, `C:\ProgramData` itself, your account's own profile folder), so pointing a variable elsewhere only adds a place to look.
- The report prints how many names and paths each list gave (`Protected lists loaded: ...`), never the entries.
- `processes.mjs --explain <pid>` names the rule that decided one process, for example `in the local protected list (name example-agent*)`, so an administrator can check a rule does what was meant.
- A list may also hold `"stop": false`, which switches stopping off: `free.mjs` then refuses every plan and stop, and says which list did it. The scan, measure and headroom still work. A list that cannot be used switches stopping off too, so a broken policy never lets more be stopped. Other keys are ignored.
- To keep an assistant from even running `free.mjs stop` or `force`, an administrator can also deny that command in the assistant's own managed permission settings.

The lists are for your own tools and agents. Security and endpoint software that this skill already recognises is protected without any list.

## What this runs on your machine

This skill reads process and performance information through operating system tools. Everything below only reads, except `taskkill` and the signals that `free.mjs` sends to a process you picked. Nothing is installed, compiled to disk or sent anywhere.

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
| Windows | `System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <fixed pin script>` | Only `free.mjs`: reads who and what a process is through a handle it opens on it (see the native calls below), and holds that handle while the process is stopped. The script is fixed text inside `scripts/lib/pin-windows.mjs`; it gets only process numbers that `free.mjs` checked. |
| Windows | `System32\taskkill.exe /PID <pid>` or `/PID <pid> /F` | Only `free.mjs stop` and `force`, for one process you picked that passed every check. Never `/IM`, `/T`, `/FI` or `/S`, never two processes in one call. Its text (in the system's language) is not read; only its exit code. |
| macOS | `/usr/bin/codesign --verify -R="anchor apple" <program>` | Only `free.mjs`: tells Apple's own programs apart, so no part of macOS is stopped. |
| macOS | `/usr/sbin/lsof -a -p <pid> -d txt -Fn`, `/bin/launchctl list`, `/bin/launchctl managername` | Only `free.mjs`: the program a process really runs (not the name it was started with), the jobs launchd runs for you, so a job it would start again (or a process one started) is never stopped, and whether this is a desktop login. Both `launchctl` commands only read. |

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

`free.mjs`'s pin script uses the same calls, plus these, all on a handle opened with `OpenProcess` access `0x101000` (query-limited information and synchronize, which lets it wait for the process to end and still cannot end, change or read its memory):

| Call | Used for |
|---|---|
| `GetProcessId` | Checks the handle is for the number asked. |
| `GetProcessTimes` | The exact creation time, part of what pins the process. |
| `QueryFullProcessImageName` | The program's full path. |
| `GetTokenInformation` (`TokenElevation`, `TokenIntegrityLevel`, `TokenPrivileges`) | Whether the process, and `free.mjs` itself, runs elevated, at which integrity level, and with the debug privilege. |
| `ProcessIdToSessionId` | The sign-in session (0 is where services run). |
| `IsProcessCritical` | Whether Windows treats it as critical. |
| `NtQueryInformationProcess` (`ProcessProtectionInformation`) | Whether it is a protected process, as antimalware services are. |
| `WaitForSingleObject` | Waits up to 10 seconds for a stopped process to end. |

The rest is ordinary .NET: process list, CPU time, start time, working set, and whether a process has a main window. macOS and Linux use no native calls: macOS only the programs above, Linux only file reads (for stopping, also `/proc/<pid>/oom_score_adj` and `/proc/sys/kernel/random/boot_id`).

**What it ends.** Only what you picked through `free.mjs`, as described under [Stopping](#stopping). Apart from that, no process other than its own helpers is ever ended. On Windows, `measure.mjs` starts two helpers (one streaming `typeperf`, one persistent PowerShell) and ends them when measuring stops, through the handles Node gave it, never by name or number; `free.mjs` does the same with its pin script if it hangs. If one of the scan's helper programs runs past its time limit, Node ends that helper through its own handle. On macOS and Linux there are no persistent helpers. It does not send any signal to your command; Ctrl+C is handled by the terminal.

**What it writes.** `peaks.jsonl`, by `measure.mjs`; `plan.json` and `actions.jsonl`, by `free.mjs`; and the data folder holding them. The scan and headroom check write nothing. It reads the protected lists, `peaks.jsonl` and `plan.json`. It writes nothing when the data folder is inside the project folder (your home folder, or a folder above it, does not count as a project: the default data folder is inside it), or when `peaks.jsonl` or `actions.jsonl` is a link or a second name for another file, so a repository cannot point a record at another file of yours. A new plan replaces `plan.json` by renaming a new file over it, which replaces a link itself, never the file it points to.

**Network.** None. It makes no connection of its own. (The Windows account lookup above is an operating system call, not this skill's.)

**Endpoint security tools.** Security software may flag a PowerShell script that declares native functions in memory, even a read-only one like this. If your organization monitors that, check with your security team before installing. A mode that avoids native calls is a parked follow-up, not built yet.

## Compatibility

- **Windows:** tested.
- **Linux:** supported. The scan, measure and headroom run against a real Linux in the project's automated tests, and the `/proc` readers are tested on sample files. Nobody has tried it by hand yet.
- **macOS:** untested. It was written from documented commands and checked against sample data; the project's automated tests also run on macOS, which is not the same as trying it by hand.
- **Copilot and Cursor:** untested until tried. Both read `SKILL.md`; the skill uses no Claude Code-only features.
- **Stopping:** the stop gate is tested on made-up processes for each system, including a test that sets every fact it reads to missing or wrong and checks each one refuses. The end-to-end test starts its own stub dev server and stops it where this tool may stop things, and checks that it refuses and leaves the stub alone where it may not (the Windows CI runner is elevated, and the Linux one runs outside a user session).

## Limits

- On a busy machine the first process-tree sample can arrive late (the run records how long into the run it came). A short run may have too few samples to trust, and the report says so.
- CPU is a lower bound: processes that start and end between two samples are missed.
- A process's working set counts pages it shares with other processes, so freed-memory figures are "up to".
- The thresholds (15% margin, 10% memory reserve, 5-run window) are starting values, not tuned.
- On Linux, inside a container, `/proc/meminfo` shows the host's memory, not the container's limit, so the memory figures are the host's.
- On Linux, the memory-stall figure appears only when the kernel provides `/proc/pressure/memory`; without it that reading is "not measured".
- On Windows, if the machine does not let you read its performance counters (the Performance Log Users group controls this, and a non-English Windows names them differently), paging is "not measured" and memory and CPU come from Node's own readings; the report warns when this happens.
- A process counts as orphaned when the process that started it is gone. On Linux and macOS, a process whose parent is the system's first process counts too, so a dev server you started on purpose with `nohup` or `setsid` looks the same. The report lists the signals behind every suggestion, so you can judge it.
- Stopping: on macOS, `launchctl list` shows the jobs of your own desktop login; a process that no listed job started counts as left behind. In a terminal app missing from this skill's list of terminals, or over SSH, the whole terminal or connection counts as this tool's session, so only processes left behind elsewhere can be stopped from there. On Windows, `SystemRoot` is trusted when it looks like `X:\Windows`, so a drive made with `subst` could point it elsewhere; that needs someone who can already run programs as you. On macOS and Linux there is a very short window between the last check and the signal in which a process could end and its number be reused; the start time is read right before the signal to keep that window as small as it can be. On Linux, stopping needs cgroup v2 and a session in your own user slice, so under WSL without systemd, in containers and on most CI runners nothing can be stopped.

## Test it

```bash
claude plugin validate plugins/free-resources --strict
node --test tests/free-resources*.test.mjs
```

The tests use sample data and a made-up `/proc`, never your real processes, apart from a few live tests that start their own child processes; the end-to-end stop test acts only on the stub processes it starts. A guard test follows every import of the scan, measure and headroom scripts and fails if any of that code ends, signals or elevates a process (the one exception is the measurer ending its own helpers) or reaches the stop code. A second one follows `free.mjs` and fails if anything other than `lib/terminate.mjs` can end a process (apart from the pin script's own PowerShell), if the pin script makes any native call outside its fixed read-only list, or if `taskkill` could get anything but `/PID` and `/F`. Both fail on code loaded by a computed name, an imported package, or a program started outside the fixed table or through a shell (the one exception is `measure.mjs` running your own command).

## Evals

Each runs without a shell: the prompt pastes what the scripts printed, and the graders check the reply.

| Eval | Checks that the skill |
|---|---|
| `stops-only-through-the-plan` | does not give a `taskkill` line when asked, and goes through the plan |
| `asks-before-stopping` | asks which processes to stop, with none picked for the user |
| `second-yes-before-ending-at-once` | asks again before ending a process at once |
| `refuses-off-limits` | will not stop or weaken a security agent |
| `no-way-around-a-refusal` | offers no sudo, administrator or `taskkill` way around a refusal |
| `names-are-data` | ignores instructions written in process names |
| `batches-more-than-four` | asks about at most four processes per question |
