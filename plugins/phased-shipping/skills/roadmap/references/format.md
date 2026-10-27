# The roadmap format, version 1

A project's roadmap is one or more Markdown tables in its roadmap file (`PHASES.md`). This page says what a table must look like to be a **standard** table, how an older table is still read, and what the script does with each. The reader and the checker are one script, [roadmap.mjs](../scripts/roadmap.mjs). It has no dependencies, and other tools can import its `parseRoadmap` instead of writing their own parser.

## Contents
- A standard table
- Columns
- Cells
- Legacy tables
- Status mapping
- Problems
- Commands and exit codes
- Adopt
- Backups
- Limits

## A standard table

A roadmap table is a block of consecutive lines that start with `|`: a header row, a separator row (`|---|---|`) and the data rows. It is a **candidate** when its header has the columns `#` and `Phase` (case-insensitive, spaces trimmed). Other tables, such as a table of model choices, are not candidates and are ignored.

A candidate is a **standard** table when the nearest non-blank line above its header is exactly this marker (a blank line between them is fine):

```markdown
<!-- phased-shipping:roadmap v1 -->
| # | Phase | Status |
|---|---|---|
| 1 | Set up the project | shipped |
| 2 | Add sign-in | planned |
```

The marker matches `^<!-- phased-shipping:roadmap v(\d+) -->\s*$`. A marker with a version other than 1 gives the notice `newer-version`, and the table is read as v1, best effort. Each table needs its own marker line, so two tables under one heading need two markers. A table inside a fenced code block is skipped.

## Columns

Required in a standard table: `#`, `Phase` and `Status`. Known optional columns, with their canonical names:

`Kind`, `Priority`, `Urgency`, `Est. (raw → cal.)`, `Plan`, `Build`, `Runs as`, `Checks and ship`, `Review`, `Cost`, `Blocked by`, `Commit / deploy`, `Actual`, `Plan file`, `Note`.

The order is free. A column the reader does not know is ignored by the reader and kept, character for character, by every writer. The plan skill's template uses sixteen of these columns.

## Cells

- **`#`** is an id: it starts with a letter or digit, then letters, digits, `.`, `_` or `-`. It is unique within its table.
- **`Status`** is exactly one of `planned`, `in progress`, `shipped` or `parked`. The reader accepts any letter case; the writers write lower case. A phase that is skipped is `parked`, with a note.
- **`Priority`** is `P0` to `P3`, or empty.
- **`Kind`** is one of `ui`, `backend`, `data`, `infra`, `docs`, `mixed`, or empty.
- **`Actual`** is a number of hours, with an optional ` h`, or empty.
- **`Est. (raw → cal.)`** is free text. When it starts like `<a> h → <b> h`, the reader also gives `a` and `b` as numbers.
- A pipe inside a cell is written `\|`. The reader treats it as cell text, not as a separator.

## Legacy tables

A candidate without the marker is **legacy**. It is never rejected: it is read as well as possible and reported with the notice `legacy-table`. A `State` column is read as the status. A Status cell the reader does not know gives the notice `unmapped-status`, and that row is counted in no status. Only a table that carries the marker is held to the format.

`standardize` turns a legacy table into a standard one. It inserts the marker line, renames the header cells it knows (`Est.` and `Est. (raw → calibrated)` to `Est. (raw → cal.)`, `State` to `Status`, `ID` or `No` to `#`, `Name` to `Phase`), pads short rows with empty cells, and rewrites each Status cell to one of the four values. A table with no Status column gets one, with every row set to `planned`. The `Plan file` and `Note` columns are added only when a row needs them.

## Status mapping

The whole cell is looked up, ignoring letter case and surrounding spaces.

| Cell | Becomes |
|---|---|
| `planned`, `to plan`, `backlog`, `next`, `todo`, `queued` | `planned` |
| `in progress`, `in-progress`, `wip`, `building`, `started`, `previewed` | `in progress` |
| `shipped`, `done`, `complete`, `completed`, `released` | `shipped` |
| `parked`, `dropped`, `skipped`, `deferred`, `on hold`, `blocked` | `parked` |
| `<word> (<text>)` | the status of `<word>`; `<text>` moves to `Plan file` when it is `plan: <path>` or a path ending `.md`, otherwise to `Note` |
| `<word> <date>`, for example `shipped 2026-10-24` | the status of `<word>`; the date moves to `Note` |
| `<word> <date> (<text>)`, for example `shipped 2026-10-25 (2nd attempt)` | the status of `<word>`; the date and the text move to `Note` (`2026-10-25 (2nd attempt)`), or the date to `Note` and `plan: <path>` to `Plan file` |
| `**<word> <date>** (plan: <path>)` | the status of `<word>`; the date to `Note`, the path to `Plan file` |
| `<word> plan: <path>` or `<word> <path>.md` | the status of `<word>`; the path to `Plan file` |
| `moved to ...` | `parked`, with the whole text as the note |
| anything else, including `confirmed`, a bare number and `<word> later` | **blocked**: never guessed |

Real-world forms: the marks `*`, `_` and backticks around the leading word (and around the date) are stripped, and the longest leading status word wins (`in progress` before any shorter word). The word must end at a space, a parenthesis or the end of the cell, so `plannedish` is not `planned`. A date is `YYYY-MM-DD`, with an optional time. Any other text after the word blocks the row.

A blocked row is shown with the exact `--set-status <id>=<status>` the owner can choose. `standardize --write` refuses while any chosen table still has a blocked row.

## Problems

Each problem has a line number and a code. A malformed table never throws; it is reported.

| Code | Level | When |
|---|---|---|
| `missing-column` | error | a standard table lacks `#`, `Phase` or `Status` |
| `bad-status` | error | a Status cell is not one of the four |
| `duplicate-id` | error | an id is used twice in one table |
| `empty-id` | error | a `#` cell is empty |
| `bad-id` | error | an id has characters the format does not allow |
| `bad-priority` | error | a Priority cell is not `P0` to `P3` or empty |
| `bad-kind` | error | a Kind cell is not one of the six or empty |
| `row-width` | error | a row has more or fewer cells than the header |
| `legacy-table` | notice | a candidate has no marker |
| `unmapped-status` | notice | a legacy table has a Status the mapper does not know |
| `no-roadmap-table` | notice | the file has no candidate table |
| `newer-version` | notice | the marker names a version other than 1 |

Errors are reported only for standard tables.

## Commands and exit codes

Run the script with `node roadmap.mjs <command> <file> ...`. Pass `--root <folder>` to make it refuse a file outside that folder. It prints only the file's base name, never an absolute path.

| Command | What it does |
|---|---|
| `read <file>` | prints JSON: every candidate table, its phases (`id`, `phase`, `status`, `statusRaw`, `kind`, `priority`, `urgency`, `estRaw`, `estCal`, `actual`, `commit`, `blockedBy`, `planFile`, `note`, `line`), its problems, and a summary |
| `check <file> [--strict]` | one line per problem, then a summary line. Read-only |
| `standardize <file> [--table <index>]... [--set-status <id>=<status>]...` | prints a plan and writes nothing |
| `standardize ... --write` | keeps `<file>.original` (first write only) and `<file>.bak-<YYYYMMDD-HHMMSS>` in `.roadmap-backups/` next to the file (it refuses if that dated name exists), writes the new text to `.roadmap-backups/<file>.tmp` and renames it over the file |
| `set <file> <id> [--status s] [--commit text] [--actual hours] [--plan-file p] [--note t]` | changes cells of one row of one standard table and nothing else; `--actual 2` writes `2 h`, and `--commit` writes to `Commit / deploy` |
| `restore <file>` | lists the kept copies (name, size, lines, time, newest first; a `<file>.bak-*` copy beside the file, made by 0.7.0, is marked `legacy`); `no backups yet` when there are none. Read-only |
| `restore <file> --from original\|prev\|<name>` | prints what putting that copy back would change and writes nothing. `<name>` is exactly one name from the listing; a value with a slash, a backslash or `..` is a usage error |
| `restore <file> --from <x> --write` | keeps `<file>.original` if it is not there yet, saves the current file as `<file>.before-restore-<YYYYMMDD-HHMMSS>`, then replaces the roadmap file with the chosen copy. `nothing to restore` when the copy is identical to the file |
| `adopt <project folder> [--plans <dir>]... [--history <file>] [--project <label>]... [--no-history] [--into <roadmap file>] [--set-status <id>=<status>]...` | reads the project's plan files and prints the roadmap rows they prove (a proposed standard table), and writes nothing. See Adopt below |
| `adopt ... --write` | appends the proposed rows as a new standard table at the end of `--into`, or creates a new file; never overwrites |

Table indexes start at 0, in file order, and count candidate tables only. `<table>:<id>=<status>` picks a table when an id is in two tables.

- **Exit 0:** done, or the check found no errors. Notices, including legacy tables, are allowed.
- **Exit 1:** the check found errors (or notices, with `--strict`); a write was refused (for `adopt`: also a legacy table with no `--into`, or a name that exists); `set` could not apply (an id in no standard table, in several, or in a legacy table; a column the table does not have); a copy could not be made (nothing is then written to the roadmap); or the file changed while it was being written (`the roadmap changed while it was being written; nothing was changed, run again`).
- **Exit 2:** the file cannot be read or is not valid UTF-8, it is outside `--root`, it is a kept copy (it sits in a `.roadmap-backups` folder), its name has a colon on Windows, a `restore` name is unknown or not allowed, or the arguments are wrong (including a bad status or hours value).

The backup folder being unusable (a file or a link in its place, or a `.gitignore` that is a folder or a link) is exit 1 for `set`, `standardize --write` and `restore` alike, and nothing is written.

`standardize` is idempotent: on a standard table it says `nothing to change` and writes nothing. Line endings (LF or CRLF, line by line) and the last-newline state are kept, and every line outside the chosen tables is untouched.

## Adopt

`adopt` is for a project that has plan files but no roadmap table (or a roadmap that does not list them all). It proves only what a plan file says, and it leaves out everything else.

**Which files.** Files named `phase-*.md`, up to three folders below `docs/`, `.plans/`, `plans/` and `phases/` in the project folder, plus every folder given with `--plans` (a path relative to the project folder, or inside it). Never under `node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `target`, `.roadmap-backups` or `.phased-shipping`. A symbolic link or junction is counted and not followed, and every file's real path must stay inside the project folder. A file over 256 KB, or one that is not valid UTF-8, is listed as skipped. Roadmap files are the files named `PHASES.md` in the project folder and in the same places.

**What each file gives.** The first heading must match `# Phase <id>[ (<qualifier>)]: <title>` (a `-` may replace the `:`). The id starts with a letter or digit and may hold letters, digits, `.`, `_` and `-` (`1`, `7b`, `I1a`). A file with another first heading is reported as `no-heading` and left out. The `**Timestamps:**` line (in the first 60 lines) holds `started`, `previewed`, `approved` and `shipped`, each a real ISO time (or date) or the placeholder `<ISO>`.

| The plan file says | Status |
|---|---|
| `shipped` is a real time | `shipped` |
| `started` is a real time, `shipped` is not | `in progress` |
| anything else: placeholders only, or **no Timestamps line** (a code-map note, for example) | **undecided**: no status |
| two files with one id | `duplicate-id`: both undecided, left out until one has a new id in its heading |

An undecided file is listed with the exact `--set-status <id>=<status>` choices and is written only when the owner gives it one; `--set-status` is refused for a file that already has a status from its Timestamps, for a duplicate id, and for an id that is not a plan file still to be added. Nothing else is ever guessed: a date, a history record or the file's age does not give a status.

**The proposed table** is a standard table with the columns `#`, `Phase` (the title), `Kind`, `Priority`, `Urgency`, `Est. (raw → cal.)`, `Status`, `Commit / deploy`, `Actual`, `Plan file` (the path relative to the project folder) and `Note`. Kind, Priority, Urgency and the estimate stay empty. `Note` says where each value came from (`from plan file, shipped 2026-10-24`, the qualifier, a history join, or `status chosen by the owner`). Rows are ordered by id, with numbers in numeric order (`2`, `7b`, `10`).

**History join.** `--history <file>` (default: `history.jsonl` in the folder named by `CLAUDE_PLUGIN_DATA`, when it exists) holds one JSON record per line with `project`, `phase`, `actual_h`, a `date` or `shipped` time and, when present, `deploy` (or `commit`) text. The `project` field is a label chosen when the record was written, not a folder name, so it is never assumed to match. Without `--project` the command lists the labels whose phase ids are also plan-file ids, with how many ids overlap, and stops (exit 0; with `--write` exit 1 and nothing is written). `--project <label>` (repeatable) joins the records of those labels: `actual_h` becomes `Actual` (`2.5 h`) and the deploy text becomes `Commit / deploy`; for two records of one id the newest wins and the Note says `newest of N records`. History never decides a status. `--no-history` skips the join.

**A roadmap that already exists.** If a roadmap table exists in the project, standard or legacy:
- Without `--into`, a legacy table makes `adopt` refuse to propose (exit 1): run `standardize` first, or pass `--into <file>`.
- With standard tables only, it lists the plan files whose ids are in no table of any roadmap file, and a write needs `--into`.
- `--into` takes a regular `.md` file (existing or new), never one inside `node_modules`, `.git`, build output, `.roadmap-backups` or `.phased-shipping`, and never a link or a folder. Text taken from a plan file (title, qualifier, note) is one line of plain text: control, line-separator, bidirectional, zero-width, tag and other Unicode format characters become spaces. A plan or roadmap file with more than one hard link is skipped (reported as `hard link`), and so is a file or folder whose name holds one of those characters.
- With `--into <file>`, only that file's tables count as listed; the other roadmap files are listed but never read for ids and never touched. Nothing is merged across files.

**Writing (`--write`)** never overwrites a roadmap. It either appends `## Roadmap`, a blank line and the new standard table at the end of `--into` (an existing file: the text before is kept byte for byte, the new lines use the file's own line ending, and a missing last newline is added), or creates a new file when the name is new (the default is `PHASES.md` in the project folder; `--into <new name>.md` names another, in an existing folder inside the project), and refuses a name that exists. An append keeps `<file>.original` and a dated `<file>.bak-<stamp>` in `.roadmap-backups/`, and writes the new text through a temp file and a rename after the changed-while-writing check, like `standardize`; a new file is published whole under a name that must not exist, so there is nothing to back up. If any step fails, nothing is written (exit 1). Before writing, the script parses its own result and refuses unless the new table is standard with no errors and holds exactly the proposed ids. Undecided files without a `--set-status` are listed and skipped, and `--write` still adds the decided ones. A second `adopt` proposes nothing new (the ids are listed now).

Every path adopt prints is relative to the project folder, never absolute.

## Backups

Every write (`standardize --write`, `set`, `restore --write`, and an `adopt --write` that appends to a file) keeps a way back first. All copies live in one folder, `.roadmap-backups/`, next to the roadmap file. The script creates it on first use, with a `.gitignore` that holds only `*`, so git never lists or commits anything in it. The folder must be a real folder (not a symlink) inside the roadmap file's own folder, or the script refuses and writes nothing.

| Copy | Made by | Kept |
|---|---|---|
| `<file>.original` | the first write of any kind | forever: created once from the bytes read, never overwritten, renamed or deleted by the script |
| `<file>.prev` | `set` | the file as it was before the latest `set`; replaced each time (through a temp file and a rename) |
| `<file>.bak-<YYYYMMDD-HHMMSS>` | `standardize --write`, `adopt --write` (append) | until you delete it |
| `<file>.before-restore-<YYYYMMDD-HHMMSS>` | `restore --write` | until you delete it; restoring from it undoes the restore |

Each copy is written from the bytes the command read, not by reading the file again, and every copy carries the real file's name (letter case, links and short names are resolved first, so one roadmap has one set of copies). If a copy cannot be made, nothing is written to the roadmap and the exit code is 1. A copy is written whole under a temporary name, flushed to disk, and then given its final name with a hard link (which fails when the name is taken), so a final name never holds half a file. Where links are not possible (FAT, exFAT, some network drives) the copy is written under its final name between a `<copy>.incomplete` marker and its removal; a marker that is still there means a copy was cut short, and every write refuses (exit 1, nothing written) until you have looked: for a `<file>.original.incomplete` marker, compare `<file>.original` with the roadmap and, if it is shorter, different or you are unsure, delete `<file>.original` too (it is made again from the current roadmap), then delete the marker; for any other marker, delete the copy it names and then the marker. Copies are owner-only (`0600`) and the folder `0700` where the system has file permissions; the roadmap file keeps its own mode. If the folder's `.gitignore` is not exactly `*` the script warns on stderr and goes on; if it is a folder or a link it refuses. The new roadmap text is written to `.roadmap-backups/<file>.tmp` first; if that name already exists the script says another write may be in progress and, if none is, to delete it. On Windows a rename that is refused for a moment is retried up to 10 times, after the same check. Just before it replaces the roadmap file, the script reads the file again; if it changed since the command read it, it stops with exit 1 and changes nothing. That narrows the window when two sessions write the same file; it is not a lock. The copies are local files on the same disk, not an off-machine backup, and the script never prunes them: you may delete the dated copies, and `.original` is the one to keep, unless an `.incomplete` marker says it may be cut short. Version 0.7.0 wrote `<file>.bak-<timestamp>` beside the file; `restore` still lists and restores those, marked `legacy`, and never moves or deletes them.

## Limits

- Tables only: the reader does not look at the prose around them.
- Line-based: it is not a full Markdown parser. A table needs a separator row, and tables nested in lists are not handled.
- Cells are split on unescaped pipes, including pipes inside code spans. In a cell, `\|` is a pipe. When the script writes a cell, a backslash that sits directly before a pipe (or before a run of backslashes that ends in a pipe) is doubled, so what the script writes, it reads back unchanged: that is a round trip with this script's own reader. Any other backslash, such as in a Windows path, is written as typed. The script makes no claim about how any Markdown renderer shows a cell.
- The script cannot know whether the owner said yes: the roadmap skill is the gate, and it is started only by the owner.
