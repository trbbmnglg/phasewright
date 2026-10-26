# Free resources

## What it is

A skill, shipped as a Claude Code plugin, that tells you how pressured your machine is, which processes use the most memory and CPU, and which ones look safe to consider closing, with the reason for each. It can also run one of your own commands and record what that command really needed, then compare that with what is free now ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md)). The current plugin version is 0.1.0 ([plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/.claude-plugin/plugin.json)).

**It is report-only.** It never closes, kills or signals a process, and it tells the assistant not to either. It runs on demand only, so nothing happens unless you invoke it ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md)).

| Command | What it does |
|---|---|
| `processes.mjs` | A scan: a pressure verdict (memory, paging, CPU), the top consumers, and three tables: Suggest closing, Your call, Keep. Protected processes and anything unrecognised are always Keep ([processes.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/skills/free-resources/scripts/processes.mjs)). |
| `measure.mjs -- <command>` | Runs your command as given, watches it and everything it starts, and stores the peak memory and CPU cores ([measure.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/skills/free-resources/scripts/measure.mjs)). |
| `headroom.mjs --task <name>` | Compares what a measured task needs with what is free now, memory and CPU separately ([headroom.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/skills/free-resources/scripts/headroom.mjs)). |

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

For Copilot and Cursor, copy the skill folder into your tool's skills folder. Without plugin marketplaces, [sync-personal.mjs](https://github.com/trbbmnglg/phasewright/blob/main/scripts/sync-personal.mjs) installs a personal copy. What the scripts run on your machine is listed under [What this runs on your machine](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-this-runs-on-your-machine).

## What shipped when

- Plugin version 0.1.0 is part of [v1.1.0](Release-1.1.0-Baggao), which is in progress ([plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/.claude-plugin/plugin.json)).
- This plugin has no changelog, so its [README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md) is the source for what it does today.

## Limits

- Windows is tested. macOS is untested. Copilot and Cursor are untested until tried. Linux is not supported ([Compatibility](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#compatibility)).
- On a busy machine the first process-tree sample can arrive late, and a short run may have too few samples to trust ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#limits)).
- CPU is a lower bound, because processes that start and end between two samples are missed.
- A process's working set counts pages it shares with other processes, so freed-memory figures are "up to".
- The thresholds are starting values, not tuned.
- Security software may flag the read-only PowerShell script that declares native functions in memory; check with your security team first if your organization monitors that ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-this-runs-on-your-machine)).

## Source

- [plugins/free-resources/README.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md)
- [plugins/free-resources/.claude-plugin/plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/.claude-plugin/plugin.json)
- [plugins/free-resources](https://github.com/trbbmnglg/phasewright/tree/main/plugins/free-resources)
