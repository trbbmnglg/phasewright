# Free resources

## What it is

A skill, shipped as a Claude Code plugin, that tells you how pressured your machine is (Windows, macOS or Linux), which processes use the most memory and CPU, and which ones look safe to consider closing, with an analysis of each: what it is, why it is heavy and what closing it would give. It can also run one of your own commands and record what that command really needed, then compare that with what is free now, and it can stop the left-over dev tools of yours that you pick ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md)). The current plugin version is 0.3.0 ([plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/.claude-plugin/plugin.json)).

**It reads, and it stops only what you pick.** The scan, the measurer and the headroom check only read. `free.mjs` stops only recognised dev tools of yours that you pick one by one, each checked again right before anything is done; never system, security, managed or other users' processes, the editor or assistant session it runs in, or anything it does not recognise. It refuses to run elevated or as root. It runs on demand only, so nothing happens unless you invoke it ([Stopping](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#stopping)).

| Command | What it does |
|---|---|
| `processes.mjs` | A scan: a pressure verdict (memory, paging, CPU), the top consumers, three tables (Suggest closing, Your call, Keep) and an analysis. Protected processes and anything unrecognised are always Keep. `--explain <pid>` says which rule put one process where it is ([processes.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/skills/free-resources/scripts/processes.mjs)). |
| `measure.mjs -- <command>` | Runs your command as given, watches it and everything it starts, and stores the peak memory and CPU cores ([measure.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/skills/free-resources/scripts/measure.mjs)). |
| `headroom.mjs --task <name>` | Compares what a measured task needs with what is free now, memory and CPU separately ([headroom.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/skills/free-resources/scripts/headroom.mjs)). |
| `free.mjs plan`, `stop`, `force` | Plans which left-over dev tools of yours may be stopped and why the others may not, then stops the ones you pick, each checked again first ([free.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/skills/free-resources/scripts/free.mjs)). |

## How to use it

Install in Claude Code, then invoke it as `/free-resources:free-resources` ([Install](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#install)):

```bash
claude plugin marketplace add trbbmnglg/phasewright
claude plugin install free-resources@phasewright
```

By hand, run the scripts from your project folder, by their full path ([Use](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#use)):

```bash
node "<skill folder>/scripts/processes.mjs"
node "<skill folder>/scripts/measure.mjs" --task tests -- npm test
node "<skill folder>/scripts/headroom.mjs" --task tests
```

To add your own tools or agents to the protected processes, or to deploy a list for a team or an organization, see [Using it in your organization](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#using-it-in-your-organization): the places the files go on each system, the format, and the rule that a list can only add protection. What the analysis prints is described under [What the analysis says](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-the-analysis-says).

For Copilot and Cursor, copy the skill folder into your tool's skills folder. Without plugin marketplaces, [sync-personal.mjs](https://github.com/trbbmnglg/phasewright/blob/main/scripts/sync-personal.mjs) installs a personal copy. What the scripts run on your machine is listed under [What this runs on your machine](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-this-runs-on-your-machine).

## What shipped when

- Plugin version 0.3.0 is on main and not in a release yet. `free.mjs` stops the left-over dev tools of yours that you pick: it plans first, stopping nothing, then checks each picked process again with a stop gate where anything it cannot read refuses, and acts only on a yes (on Windows with `taskkill` while it holds the process pinned, elsewhere with SIGTERM, and with a second yes `taskkill /F` or SIGKILL). It refuses to run elevated, as root or outside your own session, and an organization's `"stop": false` switches it off ([Stopping](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#stopping)).
- Plugin version 0.2.0, also on main and not in a release yet: the scan, measure and headroom now run on Linux as well, reading `/proc` ([What this runs on your machine](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-this-runs-on-your-machine)). The report has an analysis of every listed group, a summary of what is off limits and why, and, for virtual machines and background programs that have their own stop command, that command for you to run yourself ([What the analysis says](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-the-analysis-says)). A machine that gives no reading is reported as "not measured" instead of "no pressure". Process names are cleaned before they are printed. Protected lists can come from an organization policy file or your own file, and can only add protection ([Using it in your organization](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#using-it-in-your-organization)). A guard test follows every import of the entry scripts.
- Plugin version 0.1.2, also on main and not in a release yet, is what 0.2.0 builds on: every helper program is started from its absolute system path, from that folder and not your project, so a file with a helper's name in a project folder can no longer run instead of it; and `peaks.jsonl` is never written through a link or inside the project ([What this runs on your machine](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-this-runs-on-your-machine)).
- Plugin version 0.1.1 is part of [v1.1.0](Release-1.1.0-Baggao), which shipped on 2026-10-30 ([plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/.claude-plugin/plugin.json)).
- This plugin has no changelog, so its [README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md) is the source for what it does today.

## Limits

- Windows is tested. Linux is supported and checked by automated tests on a real Linux, but nobody has tried it by hand. macOS is untested; the automated tests also run on it. Copilot and Cursor are untested until tried ([Compatibility](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#compatibility)).
- Inside a Linux container the memory figures are the host's, and a dev server started on purpose with `nohup` or `setsid` can look orphaned ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#limits)).
- Stopping refuses where its checks cannot hold: an elevated or root session, a container, a Linux session outside your own user slice (most CI runners, WSL without systemd), or a tool started detached that cannot see its own session ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#limits)).
- On a busy machine the first process-tree sample can arrive late, and a short run may have too few samples to trust ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#limits)).
- CPU is a lower bound, because processes that start and end between two samples are missed.
- A process's working set counts pages it shares with other processes, so freed-memory figures are "up to".
- The thresholds are starting values, not tuned.
- Security software may flag the read-only PowerShell script that declares native functions in memory; check with your security team first if your organization monitors that ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-this-runs-on-your-machine)).

## Source

- [plugins/free-resources/README.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md)
- [plugins/free-resources/.claude-plugin/plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/.claude-plugin/plugin.json)
- [plugins/free-resources](https://github.com/trbbmnglg/phasewright/tree/main/plugins/free-resources)
