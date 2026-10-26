# v1.1.0 Baggao

## Status

In progress ([releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json)). It has no date yet and no git tag. This page lists only what has shipped on the main branch so far; it grows as work ships.

## What shipped

- **phased-shipping, plugin version 0.7.0** ([plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/.claude-plugin/plugin.json)). The versions since 0.2.0, each described in the [CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md):
  - 0.3.0: a "What it touches" section and a "Limits" section in the README, a turn limit on every agent, token recording, safety evals, an override gate and a minimum-version check. See [Phased shipping](Phased-shipping).
  - 0.4.0: the guard hook and the guard probe. See [The guard](The-guard).
  - 0.5.0: approval bound to the commands you saw at the preview. See [Approval check](Approval-check).
  - 0.6.0: `caught_by` in the phase history, a rule for long commands, and a rule for a missing shell. See [Phase history and estimates](Phase-history-and-estimates).
  - 0.6.1 to 0.6.3: the checker reports each command's duration and takes the exit code and the duration from one line; the README's Limits say what has been seen of the guard in real runs (documentation only).
  - 0.7.0: the roadmap format, the `/phased-shipping:roadmap` skill and script, and a `v` field on each history record. See [Roadmap standard](Roadmap-standard).
- **free-resources, plugin version 0.1.0** ([plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/.claude-plugin/plugin.json)): a report-only check of how pressured your machine is. It has no changelog, so see its [README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md). See [Free resources](Free-resources).
- **A security policy**: [SECURITY.md](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md) says how to report a vulnerability, what is in scope, and how releases are built. See [Security policy](Security-policy).
- **A rewritten README** built around the problem, how it helps and a two-command start, with the logo files in [docs/brand](https://github.com/trbbmnglg/phasewright/tree/main/docs/brand) ([README](https://github.com/trbbmnglg/phasewright/blob/main/README.md)).
- **A releases table generated from one file**: the table in the README is written from [releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json) by [releases-table.mjs](https://github.com/trbbmnglg/phasewright/blob/main/scripts/releases-table.mjs).
- **Personal copies without a marketplace**: [sync-personal.mjs](https://github.com/trbbmnglg/phasewright/blob/main/scripts/sync-personal.mjs) installs both plugins as personal skills and agents, for setups that do not use plugin marketplaces.
- **A project-board dashboard**: [board-dashboard.mjs](https://github.com/trbbmnglg/phasewright/blob/main/scripts/board-dashboard.mjs) reads a GitHub Project through the `gh` command line and writes one self-contained page.

## Notes

- Install ids for Claude Code: `phased-shipping@phasewright`, `free-resources@phasewright` and `phasewright@phasewright` ([README](https://github.com/trbbmnglg/phasewright/blob/main/README.md#claude-code)).
- phased-shipping needs Claude Code v2.1.292 or later; the personal copies' `onFailure: block` needs v2.1.295 or later ([Requirements](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#requirements)).
- Releases are not signed and have no build provenance yet ([SECURITY.md](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md#how-releases-are-built)).
- Previous release: [v1.0.1 Aparri](Release-1.0.1-Aparri).
