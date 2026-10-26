# Phase history and estimates

## What it is

A record of every shipped phase that the plugin uses to calibrate the next estimate and to back its model picks with your own results ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md)). The history is `history.jsonl` in the plugin's data directory, shared by all your projects. Each phase records the estimate against the actual agent time (approval waits excluded), the build model and effort, fix rounds, prod first-pass, rollbacks and the agent tokens used. `plan` turns this into an estimate multiplier per kind of work, and into model picks backed by your own results.

The script is [history.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/plan/scripts/history.mjs); it has `stats` and `record` commands. The record holds no code and no project text beyond the project name ([What it touches](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#what-it-touches)).

Optional fields on a record, from [the CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md):

- `tokens`: the agent tokens per phase (builder, checker, shipper and model scout).
- `guard`: whether the guard hook was active in that run, from the checker's probe. See [The guard](The-guard).
- `caught_by`: which check caught each fix round or rollback, in order.
- `v`: the record's schema version, a positive integer. `record` adds `v: 1` when it is missing, and `stats` ignores it, so older records read as before.

## How to use it

`run` writes the record when a phase ships, and `plan` reads the history when it sizes the next phase. You can read the summary yourself ([history.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/plan/scripts/history.mjs)):

```text
node history.mjs stats <history.jsonl>
```

`stats` prints the estimate multiplier per kind of work, how many phases had tokens recorded and the median agent tokens per phase, how many phases had the guard active, and, when records have it, the `caught_by` summary ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)). The history lives at `${CLAUDE_PLUGIN_DATA}/history.jsonl` for a plugin install and `~/.claude/phased-shipping/history.jsonl` for personal copies. See [Phased shipping](Phased-shipping).

## What shipped when

- Plugin version 0.3.0 added token recording to the history record ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)).
- Version 0.4.0 added the `guard` field.
- Version 0.6.0 added `caught_by`.
- Version 0.7.0 added `v`.
- These versions are part of [v1.1.0](Release-1.1.0-Baggao), which is in progress.
- Tests: [history.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/history.test.mjs).

## Limits

- `caught_by` is only as good as the main session's attribution of each fix round or rollback to a check. An unclear source is recorded as the check that first reported it. Records made before 0.6.0 have no `caught_by` and are not backfilled ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#limits)).
- Only agent tokens are counted; the main session's own tokens are not visible to the plugin ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)).
- The conditional compare check waits for enough phases with `caught_by` recorded; the compare check itself is unchanged ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)).
- The guard field can be `inactive` as a normal answer, because an organization policy can turn hooks off.

## Source

- [plugins/phased-shipping/skills/plan/scripts/history.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/plan/scripts/history.mjs)
- [plugins/phased-shipping/README.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md)
- [plugins/phased-shipping/CHANGELOG.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)
