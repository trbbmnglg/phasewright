# Roadmap standard

## What it is

One format for a project's roadmap, so a single reader can tell what is planned, in progress, shipped or parked ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#the-roadmap-format)). A roadmap is one or more Markdown tables in `PHASES.md`. A table is a **standard** table when the line above its header is exactly `<!-- phased-shipping:roadmap v1 -->`. It needs the columns `#`, `Phase` and `Status`, and `Status` is one of `planned`, `in progress`, `shipped` or `parked`. A table without that line is **legacy**: it is read as well as possible and reported with a notice, never rejected. The format is written down in [format.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/references/format.md).

The reader, the checker and the editor are one script, [roadmap.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs). It has no dependencies, uses no network and prints only the file's base name. The `/phased-shipping:roadmap` skill ([skill](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/SKILL.md)) is the way to run it by hand, and only the owner can start it. Related pages: [Phased shipping](Phased-shipping), [Phase history and estimates](Phase-history-and-estimates).

## How to use it

Check a roadmap. This only reads:

```text
/phased-shipping:roadmap check
```

Standardize an older roadmap. It shows what would change, asks you, keeps copies in a `.roadmap-backups/` folder next to the file and only then writes:

```text
/phased-shipping:roadmap standardize
```

Put a kept copy back. It lists the copies, shows what would change, asks you, saves the current file first and only then restores:

```text
/phased-shipping:roadmap restore
```

Adopt a project's existing plan files (`phase-*.md`) into a roadmap. It shows the proposed table first and, only after you say yes, appends it as a new table (never over an existing roadmap), with the same copies kept first:

```text
/phased-shipping:roadmap adopt
```

- `check` lists each problem with its line number. Errors are only reported for standard tables; a legacy table gives a notice.
- `standardize` adds the marker line, changes the header cells it knows, pads short rows and rewrites each Status cell to one of the four values. A Status it cannot place, such as a stray symbol, is never guessed: you choose one of the four. A table without a Status column gets one, with every row set to `planned`.
- `restore` takes `original` (the first version the script ever saw), `prev` (the file before the last `set`) or one name from its list. It never takes a path. A restore saves the file as it was first, so a restore can itself be undone.
- `adopt` takes the id and title from each plan file's first heading and a status only from its `**Timestamps:**` line: shipped when a real shipped time is there, in progress when only a started time is, otherwise undecided. A plan file with no real timestamps (a code-map note, for example) is never given a status unless you confirm one, and two files with one id are listed and left out.
- `plan` writes the marker and runs `check` on the roadmap it writes. `run` marks a phase `in progress` and, at close, `shipped` with the commit and the hours, one row at a time, on a standard table only ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#the-roadmap-format)).

## What shipped when

- Plugin version 0.11.1 changed nothing in the format, and neither did 0.11.0, 0.10.0 or 0.9.0. The dashboard data script reads a roadmap through the same reader, only for the roadmap files you list for a project (see [Phased shipping](Phased-shipping)).
- Plugin version 0.8.0 added `adopt` (proposes roadmap rows from a project's existing plan files), the real-world status forms (`shipped 2026-10-24`, `shipped 2026-10-25 (2nd attempt)` and a bold word followed by `(plan: <path>)`) and the [Onboarding](Onboarding) skill that points to it ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)).
- Version 0.7.1 moved every backup into `.roadmap-backups/` next to the file, which git ignores, keeps the first version of a roadmap as `.original` for good, keeps the version before each `set` as `.prev`, and added `restore` and a check that the file did not change while it was being written ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)).
- Version 0.7.0 added the format, the script, the skill, the two evals and the `v` field in the phase history. See [Phase history and estimates](Phase-history-and-estimates).
- These are part of [v1.1.0](Release-1.1.0-Baggao), which is in progress.
- Tests: [roadmap.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/roadmap.test.mjs).

## Limits

- Tables only, read line by line: it is not a full Markdown parser, and it does not read the prose around the tables ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#limits)).
- It works on one roadmap file in one project. `--root` makes the script refuse a file outside the project folder, and the skill always passes it.
- `standardize` cannot know that you said yes. The skill asks you before it writes, and only you start the skill. `restore` asks the same way.
- Every write keeps copies first, in `.roadmap-backups/` next to the file: `<file>.original` once (the script never overwrites, renames or deletes it), `<file>.prev` for `set`, `<file>.bak-<timestamp>` for `standardize --write`, and `<file>.before-restore-<timestamp>` for `restore --write`. If a copy cannot be made, nothing is written. Each copy is written whole and flushed to disk before it gets its final name, so a name never holds half a file; if a `.incomplete` marker is left in the folder, writes refuse until you have looked. The folder's `.gitignore` holds only `*` (the script warns if it finds something else), and the folder holds copies of your roadmap text, so do not share it.
- The copies are local files on the same disk, not an off-machine backup, and the script never prunes them. You may delete the dated copies, and `.original` is the one to keep, unless an `.incomplete` marker says it may be cut short.
- Just before it replaces the file, the script reads it again and stops if it changed since the command read it. That narrows the window when two sessions write one file; it is not a lock.
- `adopt` proves only what a plan file says: Priority, Urgency, Kind and the estimates stay empty, and the Note column names where each value came from. With several roadmap files in one project it works on the one you pick with `--into`; nothing is merged across files. `--into` takes only a regular `.md` file outside `node_modules`, `.git`, build output, `.roadmap-backups` and `.phased-shipping`, and a title from a plan file is written as plain text (control, line-separator, bidirectional, zero-width, tag and other Unicode format characters become spaces). `adopt` skips a plan or roadmap file with more than one hard link, and a file or folder whose name holds one of those characters, and counts what it skipped.
- The evals that check the yes rule have not been run against a model yet.
- A legacy roadmap is left alone by `run`, which says so once: standardize it first.

## Source

- [plugins/phased-shipping/skills/roadmap/references/format.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/references/format.md)
- [plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/scripts/roadmap.mjs)
- [plugins/phased-shipping/skills/roadmap/SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/roadmap/SKILL.md)
- [plugins/phased-shipping/CHANGELOG.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)
