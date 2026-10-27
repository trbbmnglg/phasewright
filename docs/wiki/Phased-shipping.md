# Phased shipping

## What it is

A Claude Code plugin for shipping work in small phases, with one deploy per phase. Each step runs on the cheapest model and effort that can do it well ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md)). The current plugin version is 0.8.0 ([plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/.claude-plugin/plugin.json)).

| Component | What it does |
|---|---|
| `/phased-shipping:plan` ([skill](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/plan/SKILL.md)) | Sizes the work as trivial (skip), small (one phase) or large (roadmap), then writes one detailed phase plan at a time. |
| `/phased-shipping:run` ([skill](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/run/SKILL.md)) | Runs one phase: gates, a baseline, the build, checks against the baseline and a preview. It stops for your approval before anything is committed, deployed or pushed, then rolls back automatically if the prod check fails. |
| `/phased-shipping:roadmap` ([skill](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/SKILL.md)) | Checks a project's roadmap file against the roadmap format, standardizes an older roadmap into it, adopts existing plan files into a roadmap, or restores a kept copy. It writes only after you say yes, with copies kept first in `.roadmap-backups/`. See [Roadmap standard](Roadmap-standard). |
| `/phased-shipping:onboard` ([skill](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/onboard/SKILL.md)) | The first run in a project: lists the files it would read, reads nothing until you confirm, saves a survey of the project's commands, CI and conventions, and points to standardize, adopt or a fresh roadmap. See [Onboarding](Onboarding). |
| `model-scout` ([agent](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/agents/model-scout.md)) | Combines which models you can use, current official guidance and how each model did in your phase history. |
| `builder` ([agent](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/agents/builder.md)) | Implements one approved plan. Never commits or deploys. |
| `checker` ([agent](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/agents/checker.md)) | Runs typecheck, lint, tests, build and browser checks, first as a baseline and then compared against it. Only new failures block. |
| `shipper` ([agent](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/agents/shipper.md)) | Commits, deploys, runs the prod check and rolls back on failure, but only actions marked `APPROVED:`. |

The model and effort are enforced by the plan skill's frontmatter and by `run`'s gates; see [How the model is enforced](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#how-the-model-is-enforced). Related pages: [The guard](The-guard), [Approval check](Approval-check), [Roadmap standard](Roadmap-standard), [Onboarding](Onboarding), [Phase history and estimates](Phase-history-and-estimates).

## How to use it

Install in Claude Code ([Install](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#install)):

```bash
claude plugin marketplace add trbbmnglg/phasewright
claude plugin install phased-shipping@phasewright
```

Then plan and run a phase ([Use](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#use)):

```text
/phased-shipping:plan add accounts, billing and receipts
/phased-shipping:plan phase 1
/phased-shipping:run 1
/phased-shipping:run approve
/phased-shipping:run push
```

On a project's first run, `/phased-shipping:onboard` surveys its setup first ([Onboarding](Onboarding)). If your organization restricts plugin marketplaces, `node scripts/sync-personal.mjs` installs personal copies with a `ps-` prefix ([sync-personal.mjs](https://github.com/trbbmnglg/phasewright/blob/main/scripts/sync-personal.mjs), [Install](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#install)). The README lists everything the plugin reads, writes and runs under [What it touches](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#what-it-touches).

## What shipped when

The plugin's version history is its [CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md). Releases that carry each version:

| Plugin version | Release | What changed |
|---|---|---|
| 0.2.0 | [v1.0.0](Release-1.0.0-Allacapan) and [v1.0.1](Release-1.0.1-Aparri) | The plugin as first published ([plugin.json at the v1.0.0 tag](https://github.com/trbbmnglg/phasewright/blob/v1.0.0/plugins/phased-shipping/.claude-plugin/plugin.json)). |
| 0.3.0 | [v1.1.0](Release-1.1.0-Baggao) (in progress) | "What it touches" and "Limits" sections, a turn limit on every agent, token recording, safety evals, an override gate and a minimum-version check. |
| 0.4.0 | [v1.1.0](Release-1.1.0-Baggao) (in progress) | The guard hook and the guard probe. |
| 0.5.0 | [v1.1.0](Release-1.1.0-Baggao) (in progress) | Approval bound to the commands you saw at the preview. |
| 0.6.0 | [v1.1.0](Release-1.1.0-Baggao) (in progress) | `caught_by` in the phase history, a rule for long commands, a rule for a missing shell. |
| 0.6.1, 0.6.2 | [v1.1.0](Release-1.1.0-Baggao) (in progress) | The checker times each command and reads the exit code and duration from one line. |
| 0.6.3 | [v1.1.0](Release-1.1.0-Baggao) (in progress) | The README's Limits say what has been seen of the guard in real runs; documentation only. |
| 0.7.0 | [v1.1.0](Release-1.1.0-Baggao) (in progress) | The roadmap format, the `/phased-shipping:roadmap` skill and script, and a schema version on each history record. See [Roadmap standard](Roadmap-standard). |
| 0.7.1 | [v1.1.0](Release-1.1.0-Baggao) (in progress) | Roadmap backups kept in `.roadmap-backups/`, a permanent `.original`, `set` keeps `.prev`, a new `restore` command, and a changed-while-writing check. See [Roadmap standard](Roadmap-standard). |
| 0.8.0 | [v1.1.0](Release-1.1.0-Baggao) (in progress) | The `/phased-shipping:onboard` skill, the survey script, `adopt` and the real-world status forms in the roadmap reader. See [Onboarding](Onboarding). |

## Limits

- Each agent has a turn limit; when one stops at its limit, `run` stops too and reports what is left ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#limits)).
- A checker can report `UNFINISHED` or `TIMED OUT` for a long command. That is not a pass: `run` runs the command itself. The long-command rule is a prompt change, so a model can still ignore it.
- No hook can enforce the model, because tool-call hooks never see the model name ([How the model is enforced](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#how-the-model-is-enforced)).
- The override gate reads environment variables and the settings files the session can read, so a managed-settings override it cannot read is not caught.
- Model pinning and the four agents are Claude Code features; in VS Code with GitHub Copilot and in Cursor only the skills load ([Install](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#install)).
- The safety evals have not been run against a model yet, so their wording may need adjusting on a first run ([Test it](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#test-it)).
- It needs Claude Code v2.1.292 or later ([Requirements](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#requirements)).

## Source

- [plugins/phased-shipping/README.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md)
- [plugins/phased-shipping/CHANGELOG.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)
- [plugins/phased-shipping/.claude-plugin/plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/.claude-plugin/plugin.json)
- [plugins/phased-shipping](https://github.com/trbbmnglg/phasewright/tree/main/plugins/phased-shipping)
