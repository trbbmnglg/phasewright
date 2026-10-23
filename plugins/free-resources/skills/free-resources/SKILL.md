---
name: free-resources
description: "Reports how pressured this machine is (memory, paging, CPU), which processes use the most, and which look safe to consider closing, with the reason for each. Can also measure what a task really needs (peak memory and CPU cores) and compare it with what is free now. Report only: it never closes anything. Invoke manually."
license: MIT
disable-model-invocation: true
---

# Free resources (report only)

This skill measures the machine and reports. It never closes, kills or signals a process, and you must not close anything either, even if the report suggests it. Closing is the user's decision, made outside this skill.

## Where to run the scripts

Run every script from the user's project folder (the current folder), calling it by its full path. The scripts treat the current folder as the project, and `measure.mjs` runs the user's command there, so running them from inside this skill's folder would scan and measure the wrong place. In Claude Code the full path is `${CLAUDE_SKILL_DIR}/scripts/<script>.mjs`; in other tools use the full path to the `scripts/` folder next to this file. If a script prints a warning that the current folder is inside the skill's folder, stop, change to the project folder and run it again.

## Run the scan

From the project folder, run:

```
node "${CLAUDE_SKILL_DIR}/scripts/processes.mjs"
```

It takes about 10 to 35 seconds, depending on how busy the machine is. Useful options:
- `--json` prints the report as JSON instead of tables.
- `--all` also lists processes owned by other users (hidden by default).
- `--top N` sets the rows in the top-consumer tables.
- `--project <dir>` names the project folder whose processes count as in use (default: the current folder).

## Show the result

1. Show the full report, including the numbered tables (Suggest closing, Your call, Keep) and the pressure verdict with its numbers and thresholds.
2. Say plainly that this is report-only and that nothing was closed.
3. Say that the thresholds are starting values. If the verdict is "no pressure", say so; do not invent a problem. The scan alone carries no task need: to judge a specific task, measure it and check headroom (next two sections).
4. If the user wants a process closed, tell them to close it themselves. Do not offer a command to do it.

## Measure a task

Run the user's own command through the measurer. It runs the command exactly as given, watches the command and everything it starts, and records the peak memory and the CPU cores used:

```
node "${CLAUDE_SKILL_DIR}/scripts/measure.mjs" [--task <name>] [--interval-ms N] [--json] -- <command...>
```

- The command keeps the terminal, and its exit code becomes the script's. A failed command is still recorded, marked with its `exit_code`.
- The one summary line goes to stderr, so the command's own output stays clean.
- The result is stored in `peaks.jsonl` in `FREE_RESOURCES_DATA` if set, else `%LOCALAPPDATA%\free-resources\` on Windows and `~/.local/state/free-resources/` elsewhere. The command line is stored masked.
- The task name defaults to the command's first two words plus the project folder (for example `npm test @ phasewright`); `--task` sets it.
- The first Ctrl+C reaches the command itself and the measurer records the run and exits with the command's exit code; a second Ctrl+C leaves at once.
- Say how many tree samples there were and from how long into the run the first one came (`sampled_from_s`): on a busy machine the sampler can start late, and a short run may have too few samples to trust. Never present a thin measurement as firm.

## Check headroom

Compare what the task needs with what is free now:

```
node "${CLAUDE_SKILL_DIR}/scripts/headroom.mjs" --task <name> [--json] [--project <dir>]
```

(or give the same command after `--` and the name is worked out the way `measure.mjs` does it). It runs the scan, then prints memory and CPU separately, each with the need, the available amount, the verdict (`fits` or `short by X`) and the source of every number. Exit code 0 whether it fits or not; 3 when there is no data yet.

Show the whole output, then follow these honesty rules:
- **No data yet means no recommendation.** If it says "No data yet for this task. Run it once through measure.mjs.", say exactly that and recommend nothing. Do not estimate a need.
- **Memory.** If it fits, say nothing needs closing for memory. If it is short, the picks come only from Suggest closing, largest first, and each figure is "up to" because shared pages are counted in a working set. If Suggest closing is not enough, say so, and present the Your call items only as "you could also consider", never as picks.
- **CPU.** Suggest closing candidates are idle by definition, so when CPU is short say plainly that closing them frees no CPU. Name the busy Your call processes with their measured CPU instead, and leave the choice to the user. Do not suggest that closing idle leftovers fixes a CPU shortfall.
- Low-confidence notes (fewer than 3 tree samples, a late first sample, CPU as a lower bound because very short processes fall between samples) must be passed on, not dropped.
- Say that the margin (15%), the memory reserve (10% of total) and the 5-run window are starting values, not tuned.
- It is report-only: say that nothing was closed. If the user wants something closed, tell them to close it themselves. Do not offer a command to do it.

## Notes

- Windows is tested. macOS support is untested: it was written from documented commands and checked against sample data only.
- On Windows the sampler runs one streaming `typeperf` and one persistent PowerShell for the whole run (no launch per tick). Both are the sampler's own helper processes and are ended when measuring stops; nothing else is ever touched.
- Protected processes (system, security, shells, editors, git, VPN, coding tools) and anything unrecognised are always Keep. A local list, `scripts/protected.local.json` (`{"names":[...],"paths":[...]}`), adds more; the `FREE_RESOURCES_PROTECTED` environment variable can point to a different file.
