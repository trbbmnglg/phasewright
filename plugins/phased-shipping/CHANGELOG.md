# Changelog

Newest first. Each version starts with a `Date:` and a `Summary:` line; the README's What's new list is written from the newest three. Older entries have none.

## 0.8.0

Date: 2026-10-27
Summary: Onboarding: survey a project with your consent first, then standardize, adopt or start a roadmap.

### Added
- The `/phased-shipping:onboard` skill (owner-invoked only; sonnet, low): the first run in a project. It says what will happen and what is never read, runs `survey list`, asks the owner which files with AskUserQuestion, runs `survey run` with the digest of the confirmed list, shows the findings and how the plan will adapt, runs `survey classify`, asks which path to take (standardize, adopt, both or fresh) and ends with a first-run checklist (survey, roadmap, dashboard shown as "arrives with the dashboard phase"). It never writes a roadmap.
- The survey script, `skills/onboard/scripts/survey.mjs` (node built-ins only, no network): `list [--json]`, `run --confirm <list.json> | --all-listed --list-digest <digest> [--exclude <path>]...`, `show`, `classify`, `decline` and `leftovers`. An allowlist says what may be opened (README, CONTRIBUTING, CLAUDE.md, AGENTS.md, `docs/` Markdown, manifests, CI workflows, deploy config, plan files and roadmap tables) and a never-list says what may not (source code, `.env*`, keys, `.npmrc` and other credential files, databases, `.git`, `node_modules`, build output, lockfiles, files over 256 KB, binary files). `list` reads only folder entries and sizes. `run` reads only the confirmed files and exits 1 with nothing read when it is not given the owner's confirmation. A file whose text matches a known secret shape (token and key formats, private keys, passwords, `Bearer` and `Authorization` values, URL credentials, cloud keys, and a secret-looking name followed by a value; checked as written, with escapes decoded and as parsed JSON values) is skipped whole and counted, never printed; as a last check the finished survey and every printed line are scanned again and a match exits 1 with nothing saved or printed. The patterns catch known shapes, not every secret. No command body is kept anywhere: a script is its name and the command that invokes it, and a workflow is job, action and secret names plus a count of run steps (no run line and no word of one). The summary holds no script body, no run line and no line of any file; the project name, workflow and job names and a package's name are text from the files, cleaned to one line of plain text and cut short. A locked file is skipped once and never retried. Caps: 200 files, 64 KB per file, 400 KB in total. Symbolic links and junctions are never followed. No absolute path is printed or saved.
- The survey is saved in `.phased-shipping/` inside the project (`survey.json` with `v: 1`, `state.json`, and a `.gitignore` whose only line is `*`). The folder is created fail closed: if it is a file or a link, or its `.gitignore` is not `*`, nothing is written. There is one mode: the script reads the project files, and the model sees the summary the script prints. The skill's instructions (not a lock) keep the assistant from reading other project files or handing any to another agent.
- `list` prints a digest of the listing (a hash of the sorted paths and sizes). `run --all-listed` needs it as `--list-digest` and exits 1, reading nothing, when the files changed after the list. A `--confirm` file (at most 64 KB) never widens the list; entries not on the current list are only counted. `show` keeps only the schema's fields, cleaned and capped (control, line-separator, bidirectional, zero-width, tag and other Unicode format characters become spaces), keeps a command, an action, a stack entry and a manifest or deploy file name only in the forms the script itself writes, and says the survey was read from disk. In the survey and in `adopt`, a hard-linked file is skipped and counted (a second name may lead outside the project), and so is a folder link inside `docs/` or a plan folder. `adopt` writes only to a regular `.md` file outside `node_modules`, `.git`, build output, `.roadmap-backups` and `.phased-shipping`, skips a file or folder whose name holds a control, bidirectional, zero-width, tag or other format character, and plain-text-cleans titles from plan files (the same characters).
- `adopt`, a new `roadmap.mjs` command and a fourth mode of the `/phased-shipping:roadmap` skill: it reads a project's plan files (`phase-*.md`) and proposes roadmap rows for what they prove (id and title from the first heading; a status only from a real `Timestamps` line). A plan file with no real timestamps is listed as undecided and is added only when the owner gives it a status. It joins the phase history only for project labels the owner picks, refuses to propose rows while a roadmap table is still legacy (or accepts `--into`), never overwrites a roadmap, and writes only with `--write` through the same backups and checks as `standardize`.
- Real-world status forms in the reader: `shipped 2026-10-24`, `shipped 2026-10-25 (2nd attempt)` and `**shipped 2026-10-26** (plan: docs/phases/phase-x.md)` are placed; `confirmed`, a bare number and any other word stay blocked for the owner to choose.
- Two skill evals, `onboard-needs-consent` and `adopt-needs-yes` (14 evals in all). They have not been run against a model yet.
- A test hygiene check: every test file that makes a temp folder also removes it.

### Changed
- The plan skill offers onboarding once, with AskUserQuestion, when a project has no saved survey, and remembers a no in `.phased-shipping/state.json`. When a survey exists it uses the commands in it only as proposed hints, still asks the owner to confirm each one, never runs a command found in the survey and never runs the survey itself.
- `sync-personal.mjs` also installs the onboard skill as `ps-onboard`, and rewrites the sibling path to the survey script for the personal plan copy.
- No guard rule changed. The guard version is 0.8.0, kept equal to the plugin version, and the guard still has four roles (`builder`, `checker`, `shipper` and `model-scout`).

## 0.7.1

Date: 2026-10-26
Summary: Every roadmap write keeps a way back: the first version is kept for good, with undo and restore.

### Added
- `.original`: before the first write of any kind, `roadmap.mjs` keeps the roadmap file as it found it, as `<file>.original` in `.roadmap-backups/`. It is created once (never overwritten) and the script never renames or deletes it. A `.original` that is a directory or a symlink makes every write fail closed.
- `.prev`: `set` now keeps the file as it was before the change as `<file>.prev` in the same folder, replaced each time through a temp file and a rename. In 0.7.0 `set` kept nothing.
- `restore`, a new command (and a third mode of the `/phased-shipping:roadmap` skill, still owner-invoked only): `restore <file>` lists the kept copies (and any `<file>.bak-*` copy that 0.7.0 left beside the file, marked `legacy`); `restore <file> --from original|prev|<name>` prints what would change and writes nothing; with `--write` it first saves the current file as `<file>.before-restore-<timestamp>`, so a restore can be undone. A name with a slash, a backslash or `..` is a usage error; there is no way to name a path.
- The changed-while-writing check: just before each rename the script reads the roadmap file again, and if it changed since the command read it, it stops with exit 1 and changes nothing (`the roadmap changed while it was being written; nothing was changed, run again`). It narrows the window when two sessions write one file; it is not a lock.
- Copies fail closed: if a copy cannot be made, nothing is written to the roadmap and the exit code is 1. Every copy is written from the bytes the command read, with no overwrite.
- Copies are whole or absent: each is written under a temporary name, flushed to disk, then given its final name with a hard link, so `.original` (and the dated copies and the folder's `.gitignore`) never exist half written. Where a link is not possible (FAT, exFAT, some network drives) a `<copy>.incomplete` marker is made first and removed last; a marker left behind makes every later write refuse (exit 1, nothing written) until the owner has looked: for an `.original` marker, compare `.original` with the roadmap and delete it too if it is shorter, different or in doubt (it is made again), then delete the marker. A failed in-place copy keeps its marker whenever anything is left at the final name.
- On Windows a rename that is refused for a moment (a scanner or indexer holding the file) is retried up to 10 times, each time after the same changed-while-writing check.
- File modes: on systems that have them the roadmap file keeps its own mode, copies are `0600` and the backup folder `0700`.
- A BOM in front of the marker on the first line of the file is allowed.
- A skill eval, `roadmap-restore-needs-yes`. It has not been run against a model yet.

### Changed
- Backups moved: `standardize --write` now writes `<file>.bak-<timestamp>` into `.roadmap-backups/` next to the roadmap file instead of beside it. The folder has a `.gitignore` that holds only `*`, so git never lists or commits anything in it. The folder must be a real folder inside the roadmap file's own folder; a symlink or a file in its place is refused. These are local copies on the same disk, not an off-machine backup, and the script never prunes them.
- A cell that has a backslash directly before a pipe is now written so that this script reads it back exactly (the backslash is doubled), and the reader undoes that: a round trip with the script's own reader. Any other backslash, such as in a Windows path, is written and read as typed. The only text that reads differently from 0.7.0 is an odd run of three or more backslashes right before a pipe in a cell. Nothing is claimed about how a Markdown renderer shows such a cell.
- The new roadmap text is written to `.roadmap-backups/<file>.tmp` instead of `<file>.tmp` beside the file, so nothing that git could list is ever made next to the roadmap; if that name exists the script says another write may be in progress and, if none is, to delete it.
- Every backup name is the real file's name (letter case, links and short names are resolved), so one roadmap has one set of copies. A file that sits inside a `.roadmap-backups` folder is refused (exit 2), and so is a file name with a colon on Windows.
- A `.gitignore` in the backup folder that is a folder or a link is refused (exit 1, nothing written); one whose content is not exactly `*` is left as it is and the script prints a warning that git may list the backups.
- `restore` exits 1, not 2, when the backup folder cannot be used, like `set` and `standardize`. `standardize --write` and `restore --write` print the "first version kept" line when they make the `.original`, as `set` does.
- The guard version is 0.7.1, kept equal to the plugin version. No guard rule changed.

## 0.7.0

Date: 2026-10-26
Summary: A roadmap standard, and a script to check, standardize and update a roadmap.

### Added
- The roadmap format, version 1 (described in `skills/roadmap/references/format.md`). A roadmap table is a standard table when the line above its header is `<!-- phased-shipping:roadmap v1 -->`; it needs the columns `#`, `Phase` and `Status`, and `Status` is one of `planned`, `in progress`, `shipped` or `parked`. A table without the marker is legacy: it is read as well as possible and reported with a notice, never rejected.
- `skills/roadmap/scripts/roadmap.mjs`, one script with no dependencies and four commands: `read` (JSON), `check` (a report with line numbers and exit codes), `standardize` (a plan that writes nothing; with `--write` it makes a backup next to the file, refuses to overwrite one, and writes through a `.tmp` file) and `set` (one row of one standard table, atomic). `--root` makes it refuse a file outside the project folder. Line endings and the last-newline state are kept, and lines outside the chosen tables are never touched. It prints only the file's base name.
- The `/phased-shipping:roadmap` skill (`check` and `standardize`), owner-invoked only. It never runs `--write` without asking you first.
- A `v` field (schema version, a positive integer) on every history record. `record` adds `v: 1` when it is missing; `stats` and the loader ignore it, so older records read as before.
- Two evals: `roadmap-check-is-read-only` and `roadmap-standardize-needs-yes`. They have not been run against a model yet.

### Changed
- The plan template shows the marker line above the roadmap table, and the plan skill runs `check` on the roadmap it writes. The run skill marks a phase `in progress` and, at close, `shipped` with the commit and the hours, using `set`; a legacy roadmap is left alone and the old manual update is the fallback. Gate 8 now reads "shipped or parked (skipped)": a skipped phase is `parked`, with a note.
- The guard version is 0.7.0, kept equal to the plugin version. No guard rule changed.

## 0.6.3

### Changed
- The README's Limits no longer say the guard has never been seen firing in a real run. They now say what was seen (the self-test probe blocked at the start of recent runs, and one shipper command outside its git list denied, on one Windows setup with Claude Code 2.1.310) and what has not been checked (other platforms and Claude Code versions).
- The guard version is 0.6.3, kept equal to the plugin version. No guard rule changed. Documentation only.

## 0.6.2

### Changed
- The checker times each command with the shell's own counter and reads the exit code and the duration from one line. The brief asks for each command to run as `SECONDS=0; <command>; echo "exit=$? seconds=$SECONDS"`, so neither value is inferred or taken from the clock.
- The guard version is 0.6.2, kept equal to the plugin version. No guard rule changed.

## 0.6.1

### Changed
- The checker reports each command's duration and takes each exit code from a captured `exit=` line. The brief asks for each command to run as `<command>; echo "exit=$?"`, and the checker never infers an exit code from the output or from the tool saying it finished.
- The Windows notes are reworded: the agents don't read the clock to make timestamps (the caller records them), instead of "don't read the clock or report times", which the checker read too broadly. `run` now says "Agents never make timestamps."
- The guard version is 0.6.1, kept equal to the plugin version. No guard rule changed.

## 0.6.0

### Added
- `caught_by` in the phase history (issue #83). An optional array with one entry per fix round or rollback, in order, each one of `builder-self`, `compare`, `own-review`, `security-review`, `browser-check` or `prod-check`. Its length must equal `check_rounds` plus 1 if `rolled_back` (`invalid field: caught_by ...` and exit 1 otherwise); records without it stay valid and nothing is backfilled. `history.mjs stats` prints "Caught by (phases with caught_by recorded: X of Y; Z needed no fix): ..." and "Conditional compare needs 15 phases with caught_by recorded (X so far)", only when at least one record has the field. `run` notes the source of each fix round as it happens and writes the list into the history record.
- A "Long commands" rule for the checker: each command in the foreground, one at a time, with the Bash tool's `timeout` set to 600000 on every call and never background mode; if the tool still moves a command to the background it reads the output file at most 5 times, then reports `UNFINISHED` with the output path. A command over 10 minutes is `TIMED OUT after 10 min`. The result table says `pass`, `fail` or `unfinished`, and the last line says `overall: not complete` if any command is unfinished. `run` treats `UNFINISHED`, `TIMED OUT` or a missing exit code as not a pass, runs that command itself in the foreground and marks the row "(re-run in main)".
- A `NO SHELL:` rule for the builder, checker and shipper: with no working shell, or one that stops responding, the agent stops at once and starts its report with `NO SHELL:`, what is done and what is left. The builder edits only when it can run that step's test afterwards and lists the files edited since its last passing test run; the shipper doesn't retry; the checker and shipper list the commands that did not run. `run` treats such a result as partial and unverified, marks the build "unverified", runs the verify commands in its own shell, and stops if it has none.
- A short "Windows and Git Bash" block in the three agent files: run `npm`, `node` and `git` directly (in Git Bash `cmd /c npm ...` prints only the cmd banner and runs nothing), don't use `cmd` or `powershell`, and don't read the clock or report times.
- An eval, `run-no-shell-not-verified` (authored and shape-checked; not yet run against a model).
- README: a "Windows and Git Bash" note and two lines in Limits.

### Changed
- The guard version is 0.6.0 (the probe message names it, and a test keeps it equal to the plugin version). No guard rule changed.
- `run` records timestamps in the main session only: PowerShell `(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')` on Windows when a PowerShell tool exists, otherwise `date -u`. Agents never read the clock.
- The compare check is unchanged. Whether it should become conditional waits for 15 phases with `caught_by` recorded.
- The long-command rule is a prompt change, so it is probabilistic: the bounded wait and the `UNFINISHED` result exist so that a failure to follow it is still reported honestly.

## 0.5.0

### Added
- Approval is bound to the commands you saw at preview (audit AL-04, issue #15). `skills/run/scripts/commands-hash.mjs` (no dependencies, no network) hashes the phase plan's `## Commands` section (SHA-256, after CRLF, trailing spaces and trailing blank lines are normalized) and keeps `planned` and `previewed` records under `<data folder>/previews/`, keyed by the plan's real path (symlinks and short Windows names resolved):
  - `plan` records `planned` when it writes a phase plan, and adds a `**Commands hash:**` line under the Timestamps line;
  - `run` checks `planned` at the preview (a change is a warning with the diff, a missing record is a note, never a stop), records `previewed`, and shows `Commands hash: <12 hex>` beside the verbatim commands;
  - `--record` and a matching `--check` print the normalized section after the status line (`recorded <stage> <12 hex>` or `match <12 hex>`). The preview shows that printed section, and the shipper brief takes the deploy, prod-check and rollback commands only from the section `--check previewed` printed, never from a fresh read of the plan, the preview turn or memory, so what was hashed, shown and run are the same text;
  - `approve` and `push` check `previewed` before briefing the shipper. A mismatch is a hard stop that shows the diff and says to run `/phased-shipping:run N` again to preview the current commands; no record, any other exit code or no `match` line is also a stop. The hash goes into the shipper's brief, and the shipper repeats it in its report;
  - a plan with two headings that look like "Commands", or one that isn't exactly `## Commands`, is refused (exit 2); a `--record`, `--check` or `--data` with no value is a usage error (exit 1);
  - a fix-forward round that changes the plan's commands needs a new preview (Preview steps 1 and 2 again, then end the turn) before the fresh `approve`;
  - a `previewed` record is not used up: an `approve` in a later session still matches an old preview of an unchanged plan (the commands are unchanged, so this is accepted);
  - an option whose value starts with `--` (`--record previewed --data --short`) is a usage error (exit 1), and nothing is created.
- Two guard rules for the builder only: it can't write `PHASES.md` or a `phase-*.md` file inside a folder named `phases` (Write, Edit and NotebookEdit; an NTFS stream suffix counts as the same file; `.` and `..` segments, doubled slashes and a trailing `/.` are resolved first), nor from the shell in the common write forms (`>` and `>>`, also glued to a word as in `echo x>PHASES.md`, `tee`, `sed -i`, `mv`, `cp`, `install` or `rsync` onto them or into the `phases` folder (also with `-t` or `--target-directory`), `git apply`, `git mv`, `Set-Content`, `Out-File`, `git checkout` and `git restore` onto them, except `git restore --staged` alone, which only unstages, and a few more); and it can't write the approval records (`previews/<key>.planned.json`, `.previewed.json`), anything under `.claude/phased-shipping/`, `.claude/skills/ps-run`, `.claude/skills/ps-plan` or `.claude/agents/ps-*`, or the installed plugin folders for phased-shipping (`.claude/plugins/cache`, `marketplaces` and `data`, any path there with `phased-shipping` in it), and it can't run `commands-hash.mjs` with `--record` (`--check` and `--short` stay allowed) or `node -e` text that writes into a `previews` folder (rule `protected-plugin-files`). Reading stays allowed. The shell rules are best effort: they don't see a variable-built path or a glob, `git stash pop`, a whole-folder `git checkout`, subshell or brace-group redirects, `>|`, other in-place editors or scripts, and they deny a quoted literal such as `echo "a>PHASES.md"`. The builder can still forge a record by running the script from its own `node -e` or a script file it writes.
- README: a "How approval works" section, the new guard row and the new files the plugin writes.

### Changed
- The guard version is 0.5.0 (the probe message names it).
- This binds the approval against accidental and model-made drift. It does not protect against a malicious local process that can rewrite both the plan and the record in the data folder. It needs no hook, so it also works where hooks are disabled.
- Plans written before 0.5.0 have no planning record: the preview says so and carries on.
- The first approve that can use the check is the one after the release that ships it: this release was itself shipped by the 0.4.0 `run` skill.

## 0.4.0

### Added
- A guard hook (`hooks/guard.mjs`, wired by `hooks/hooks.json`) that stops each agent from running commands outside its job:
  - the builder and checker use `git` only to read, inspect and stage, and `gh` only to read (`git` and `gh` are allowlists: anything not listed is denied, with a reason that says what is allowed); they can't set a request method other than GET, a body, a form or an upload (including attached short options such as `-d@file`) with `curl`, `wget` or `Invoke-WebRequest`, and can't `git fetch` with `--force` or a `+` refspec, can't publish or deploy (including task runners given a deploy, release or publish target such as `turbo run deploy` and `run-s deploy`, `node node_modules/.bin/wrangler deploy`, `wrangler workflows trigger`, `npm version patch`, `jsr publish` and `goreleaser release`), and use Bash rather than PowerShell or cmd;
  - the shipper may commit, push, revert, tag and look, and use a short list of `gh` commands; it can't force-push (any spelling, including abbreviated options like `--force-w`), skip hooks or signing, or rewrite history; it also can't send a network write with `curl` or `wget` (a method other than GET, a body, a form or an upload, including attached short options such as `-d@file`), run `xargs`, use `powershell`, `pwsh`, `cmd` or the PowerShell tool (every role is refused them rather than having their text parsed), or put a variable, `$(...)` or backticks in an argument of `git push`, `commit`, `revert` or `tag` (the text after `-m`, `--message`, `-F` or `--file` is exempt);
  - every role is denied environment that changes git or skips hooks or moves git's config (assignments, `export` and the targets of `read`, `printf -v`, `mapfile` and `getopts` are checked for any `GIT_*` variable, `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `HOMEDRIVE`, `HOMEPATH`, `HUSKY` and similar) and git's `--git-dir` and `--work-tree`, any word with a `.git` or `.husky` folder in it, or naming git's global or system config file (`.gitconfig`, `.config/git/config`, `etc/gitconfig`, `ProgramData/Git/config`) (and a Write, Edit or NotebookEdit to one), syntax the guard can't read (`$'..'` quoting, brace expansion, function definitions, a Windows path with single backslashes outside quotes), `eval`, `Invoke-Expression`, `trap`, `alias`, `hash`, `coproc` style launchers, a shell that reads commands from stdin (`... | bash`, `bash <<< '...'`, a bare `bash`, `bash -s`, also behind `nohup`, `timeout`, `sudo` and similar), `gh auth status -t` and `--show-token`, and any command over 32768 characters;
  - model-scout can write only `PHASES.md` in the project folder (the hook input's working folder), never inside a `.claude` folder.

  It restricts only a call made inside one of the four agents (the plugin names `phased-shipping:builder` and so on, or `--agent <role>` in a personal copy), so the main session and other agents are never affected, and it does not load its rules for them. It splits commands before matching, so `cd x && git push`, `bash -c "git push"`, `npx wrangler@latest deploy` and `echo $(git push)` are all seen; PowerShell and cmd are not parsed for the agents (every role is refused them), though `hooks/lib/shell.mjs` still reads their text for other hook plugins that copy it. Inside a known agent it fails closed: unreadable input, a missing or half-copied rules file and any error deny. With no readable role and unreadable input it allows. It reads only the call, writes nothing and makes no network calls. It over-denies on purpose: a false deny costs one retry. It is an extra layer on top of the agents' own rules and `run`'s gates, and it is not a sandbox: a script an agent writes and runs (`bash script.sh`, `source script.sh`), a variable that holds a program name, a flag hidden in a variable for `gh api`, `curl` and the builder's deploy tools, and a `.git` path built from a variable, glob or command substitution (for example `"$(git rev-parse --git-path hooks)/pre-commit"`), or text piped into `xargs` for the builder and checker (`echo deploy | xargs npx wrangler`), stay open. The lists are an extra layer, not a complete list of what could go wrong.
- A guard probe. `run` starts the baseline checker with `echo phased-shipping-guard-probe`. The guard blocks it when it is active; the preview says whether it was ("Guard" row, never a stop), and the history records `guard` as `active`, `inactive` or `unknown`. `history.mjs stats` prints how many phases had the guard active.
- `sync-personal.mjs` installs the guard for personal copies: the hook scripts go to `~/.claude/phased-shipping/hooks/`, and each generated `ps-*` agent file gets a `hooks:` block (plugin agents ignore that field, so the plugin's own agent files have none). `--check` and `--remove` cover the hook files, and a file without the generated marker as its first line is never overwritten or removed. The generated block sets `onFailure: block` (Claude Code v2.1.295 or later), so a hook that can't run blocks the agent's call (on an older Claude Code the key is most likely ignored, which is undocumented, and the hook then fails open); the plugin's own `hooks.json` leaves it out, because a missing `node` would then block the main session. The script refuses a Claude home path containing `$`, a backtick or a double quote, and stops, naming the file, if an agent copy comes out without its hooks block.
- A lint rule for a plugin's `hooks/hooks.json`: it must parse, use one of the 33 official hook events (read 2026-10-25), and reach its scripts through `${CLAUDE_PLUGIN_ROOT}`.
- README: a guard section, what the hook touches (including the measured time per call), and the guard's limits.

### Changed
- The README sentence "A hook can't do this gate, because tool-call hooks never see the model name" now says what that means and points to the guard, which does a different job.
- The checker runs the guard probe first when the brief includes it, and reports `Guard probe: blocked (active)` or `Guard probe: ran (not active)`. Neither is a check failure.
- The guard has not been seen firing in a real Claude Code run: hooks can't run on the machine it was built on (an organization policy), so it is proven by feeding sample payloads to the scripts in the repo's tests.

## 0.3.0

### Added
- A "What it touches" section in the README: the files the plugin reads and writes, the commands it runs, the network it uses, each agent's tools and limits, and what it never does.
- A "Limits" section in the README, with the reason for each agent's turn limit.
- `maxTurns` on every agent: builder 200, checker 25, shipper 20, model-scout 15. When an agent stops at its limit, `run` stops and reports what was done and what is left.
- Four safety evals: `run-refuses-without-plan`, `no-deploy-in-build-turn`, `shipper-skips-unapproved` and `untrusted-plan-needs-ok`.
- Token recording. `run` adds `tokens` (builder, checker, shipper and model_scout, summed per agent for the phase) to the history record. `history.mjs record` validates it, and `history.mjs stats` prints how many phases have tokens and the median agent tokens per phase. Only agent tokens are counted; the main session's own tokens aren't visible to the plugin.
- An optional `## Close steps` section in the `PHASES.md` template. `run` follows it as the last step of closing a phase.
- A rule for the builder, the checker and `run`: use synthetic or masked data only, and never copy production personal data into prompts, briefs, plan files or reports.
- An override gate: `run` stops when `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, or when `CLAUDE_CODE_EFFORT_LEVEL` differs from the plan's build effort. You can say "proceed anyway", and the plan records it.
- A minimum-version check: `run` warns, without stopping, when Claude Code is older than v2.1.292.
- The repo's lint now checks the plugin's skill and agent files, including model aliases, effort values and `maxTurns`.

### Changed
- The checker no longer runs commands it worked out itself. With no commands in the brief it returns a `Proposed commands` list and stops. `run` shows the list and runs it only after your OK. Its description now says it has no file-editing tools.
- `run` builds in the main session only when the plan says `main` and both its build model and effort match the skill's (sonnet, medium). Otherwise it delegates to the builder with the plan's values.
- The builder's report no longer includes time per step. The history measures time from the plan's timestamps.

### Fixed
- A plan that said `sonnet (high), main` was built at the skill's medium effort. It now goes to the builder at high effort.
- The plugin is now listed in the Cursor marketplace file.
