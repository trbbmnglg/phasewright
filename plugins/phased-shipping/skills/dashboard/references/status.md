# Dashboard data: files, JSON and thresholds

All files are in the phased-shipping data folder (`${CLAUDE_PLUGIN_DATA}` in the plugin, `~/.claude/phased-shipping` for the personal copies). `--data` must be an absolute path: an empty or relative `--data` is a usage error (exit 2) and nothing is read or written. They are created on the first write. The folder, `sessions/` and each file must be a real folder or a regular file with one name: a link, a junction or a hard link makes the script stop and write nothing.

The status and list files go to the data folder only. `collect --out` writes the one file you name, and is refused when that file would be inside the data folder, or when a real path is already there that is not a regular file; nothing else is written. Do not point `--data` at a folder that git tracks: `projects.json` holds the absolute paths of your projects.

## Off by default

`status.mjs set`, `clear` and the automatic registration done by `set` do nothing, and print `dashboard is off; nothing written`, while the dashboard is off or was never turned on. Only `enable`, `disable`, `asked` and `unregister` write while it is off. An explicit `register` while it is off exits 1, says to run `enable` first and writes nothing. `unregister <id>` works while it is off: it only removes that entry from the list, exits 0, says what it removed and writes nothing else. `state` and `list` only read.

## The three files

`dashboard.json`: `{ "v": 1, "enabled": false, "asked": null, "warnMin": 90, "idleMin": 180 }`. `asked` is the date the question was answered (`enable`, `disable` and `asked` all set it).

`projects.json`: `{ "v": 1, "projects": [{ "id", "path", "name", "labels", "roadmaps", "added" }] }`, at most 100 projects.
- `id`: the first 12 hex digits of the SHA-256 of the project's real path (lower-cased on Windows).
- `path`: the absolute path. This file is the only place an absolute path is written. `list` prints it only with `--paths`, and the merged JSON never holds it.
- `name`: the folder's base name. `labels`: the `project` values this project's history records use (history is joined by these labels, never by folder name). `roadmaps`: relative paths of roadmap files, `PHASES.md` by default.

`sessions/<id>-<phase>.json`: `{ "v": 1, "project": "<id>", "phase", "phase_name", "step", "state", "step_started", "updated" }`, times in epoch milliseconds, at most 16 KB.
- `step`: `baseline`, `build`, `compare`, `review`, `preview`, `approve`, `ship` or `prod-check`.
- `state`: `working`, `waiting` or `done`.
- The file name is built only from the id and a phase id matching `[A-Za-z0-9._-]{1,40}` that is not only dots, lower-cased (so `7a` and `7A` are one file on every system; collect compares phase ids without regard to case). One file per project and phase: two sessions on the same phase of one project share a file (the last write wins).
- `phase_name` is empty unless `set` was given `--name`. The run never passes `--name` (a title from a file must not reach a command line), so a page takes the title from the roadmap row with the same phase id.

Text fields are cleaned: control, bidirectional, zero-width, tag and other format characters become spaces, one line, at most 200 characters (names and labels 80).

## The merged JSON (`collect.mjs`, schema `v: 1`)

```
{ "v": 1, "generatedAt": "<ISO>", "thresholds": { "warnMin", "idleMin" },
  "projects": [{ "id", "name", "status": "ok" | "not found" | "unreadable",
    "roadmaps": [{ "file", "tables", "phases": [{ "id", "phase", "status", "kind", "priority", "urgency",
      "estRaw", "estCal", "actual", "commit", "planFile",
      "timestamps": { "started", "previewed", "approved", "shipped" } }] }],
    "history": [{ "phase", "est_h", "actual_h", "check_rounds", "caught_by", "prod_first_pass", "rolled_back", "tokens" }],
    "errors": [{ "file", "reason" }] }],
  "sessions": [{ "project", "phase", "phase_name", "step", "state", "shown", "noUpdate", "updated", "step_started" }],
  "warnings": [{ "kind": "same project, more than one open session" | "clock skew", "project" }],
  "errors": [{ "file", "reason" }] }
```

- No path the tool builds appears in it: files are relative to their project, or base names. Text copied from your files (a phase title, a note) is shown as written, cleaned, with the known forms of this machine's project, data and home folder paths replaced by `[path]` (in string values only, never in a key). The known forms are those paths in any mix of `\`, `/`, a doubled backslash and the URL-encoded `%5C` and `%2F`, any `<drive>:\Users\<name>` (also the 8.3 short name), and `/c/Users/<name>`, `/Users/<name>` and `/home/<name>`; only the part up to and including the name is replaced. Invisible characters are taken out first when that reveals a path. Other spellings of a path may remain, so do not put a path in plan text.
- **Every string is untrusted plain text.** A page must render it with `textContent` only: no Markdown, no URL attribute (`href`, `src`), no `innerHTML`. As a second layer, `collect` writes `<`, `>`, `&`, U+2028 and U+2029 in the JSON as the escapes `\u003c`, `\u003e`, `\u0026`, `\u2028` and `\u2029`, so the text is safe to inline in a script and parses to the same values (on stdout and in `--out`).
- A roadmap or plan file is read only when its real path is inside the project, it is a regular file (not a link, not a hard link) and it is at most 256 KB. A plan file whose resolved path has a `.git`, `node_modules` or `.roadmap-backups` folder in it is refused. A file that fails is reported in `errors` by base name and reason, and the rest still loads. A folder that moved is `not found` and stays listed.
- A bad session file is skipped and reported by base name only. Its contents are never copied.
- Caps: 100 projects, 200 sessions, 300 phases and 500 history records per project, 2 MB of output, and 64 MB of project files read in one run (a file past that is skipped and reported).

## Thresholds

- `shown` is `Idle` when `updated` is `idleMin` minutes or more ago (default 180). Otherwise it is the state's word: `Working`, `Waiting for you` or `Done`.
- `noUpdate` is true for a working session with no update for `warnMin` minutes or more (default 90).
- A project with more than one open session (shown `Working` or `Waiting for you`) gets the warning.
- A session whose `updated` is more than 5 minutes ahead of the clock, or whose `step_started` is after its `updated`, is clock-skewed: it is shown as `Idle` with `noUpdate: true`, its project gets a `clock skew` warning, and it never counts as an open session.

## Limits

- A crashed run leaves its session file. It shows as `Idle` after `idleMin`; nothing deletes it. `clear` removes one, and `unregister` removes a project from the list (its session files stay).
- Opening the file by hand and changing it is allowed; a file that no longer has the expected shape makes the scripts stop and report it instead of guessing.
