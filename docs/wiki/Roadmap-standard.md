# Roadmap standard

## What it is

One format for a project's roadmap, so a single reader can tell what is planned, in progress, shipped or parked ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#the-roadmap-format)). A roadmap is one or more Markdown tables in `PHASES.md`. A table is a **standard** table when the line above its header is exactly `<!-- phased-shipping:roadmap v1 -->`. It needs the columns `#`, `Phase` and `Status`, and `Status` is one of `planned`, `in progress`, `shipped` or `parked`. A table without that line is **legacy**: it is read as well as possible and reported with a notice, never rejected. The format is written down in [format.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/references/format.md).

The reader, the checker and the editor are one script, [roadmap.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs). It has no dependencies, uses no network and prints only the file's base name. The `/phased-shipping:roadmap` skill ([skill](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/SKILL.md)) is the way to run it by hand, and only the owner can start it. Related pages: [Phased shipping](Phased-shipping), [Phase history and estimates](Phase-history-and-estimates).

## How to use it

Check a roadmap. This only reads:

```text
/phased-shipping:roadmap check
```

Standardize an older roadmap. It shows what would change, asks you, makes a backup next to the file and only then writes:

```text
/phased-shipping:roadmap standardize
```

- `check` lists each problem with its line number. Errors are only reported for standard tables; a legacy table gives a notice.
- `standardize` adds the marker line, changes the header cells it knows, pads short rows and rewrites each Status cell to one of the four values. A Status it cannot place, such as a stray symbol, is never guessed: you choose one of the four. A table without a Status column gets one, with every row set to `planned`.
- `plan` writes the marker and runs `check` on the roadmap it writes. `run` marks a phase `in progress` and, at close, `shipped` with the commit and the hours, one row at a time, on a standard table only ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#the-roadmap-format)).

## What shipped when

- Plugin version 0.7.0 added the format, the script, the skill, the two evals and the `v` field in the phase history ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)). See [Phase history and estimates](Phase-history-and-estimates).
- These are part of [v1.1.0](Release-1.1.0-Baggao), which is in progress.
- Tests: [roadmap.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/roadmap.test.mjs).

## Limits

- Tables only, read line by line: it is not a full Markdown parser, and it does not read the prose around the tables ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#limits)).
- It works on one roadmap file in one project. `--root` makes the script refuse a file outside the project folder, and the skill always passes it.
- `standardize` cannot know that you said yes. The skill asks you before it writes, and only you start the skill. The two evals that check this have not been run against a model yet.
- `standardize --write` writes `<file>.bak-<timestamp>` next to the file, and refuses if that name already exists. `set` rewrites one row and makes no backup.
- A legacy roadmap is left alone by `run`, which says so once: standardize it first.

## Source

- [plugins/phased-shipping/skills/roadmap/references/format.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/references/format.md)
- [plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs)
- [plugins/phased-shipping/skills/roadmap/SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/SKILL.md)
- [plugins/phased-shipping/CHANGELOG.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)
