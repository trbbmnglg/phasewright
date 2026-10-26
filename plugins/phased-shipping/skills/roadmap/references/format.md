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
| `<word> (<text>)` | the status of `<word>`; `<text>` moves to `Plan file` when it looks like a path to a `.md` file, otherwise to `Note` |
| `moved to ...` | `parked`, with the whole text as the note |
| anything else | **blocked**: never guessed |

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
| `standardize ... --write` | copies the file to `<file>.bak-<YYYYMMDD-HHMMSS>` (it refuses if that name exists), writes the new text to `<file>.tmp` and renames it over the file |
| `set <file> <id> [--status s] [--commit text] [--actual hours] [--plan-file p] [--note t]` | changes cells of one row of one standard table and nothing else; `--actual 2` writes `2 h`, and `--commit` writes to `Commit / deploy` |

Table indexes start at 0, in file order, and count candidate tables only. `<table>:<id>=<status>` picks a table when an id is in two tables.

- **Exit 0:** done, or the check found no errors. Notices, including legacy tables, are allowed.
- **Exit 1:** the check found errors (or notices, with `--strict`); a write was refused; or `set` could not apply (an id in no standard table, in several, or in a legacy table; a column the table does not have).
- **Exit 2:** the file cannot be read or is not valid UTF-8, it is outside `--root`, or the arguments are wrong (including a bad status or hours value).

`standardize` is idempotent: on a standard table it says `nothing to change` and writes nothing. Line endings (LF or CRLF, line by line) and the last-newline state are kept, and every line outside the chosen tables is untouched. `set` writes atomically and makes no backup, because it changes one row.

## Limits

- Tables only: the reader does not look at the prose around them.
- Line-based: it is not a full Markdown parser. A table needs a separator row, and tables nested in lists are not handled.
- Cells are split on unescaped pipes, including pipes inside code spans.
- The script cannot know whether the owner said yes: the roadmap skill is the gate, and it is started only by the owner.
