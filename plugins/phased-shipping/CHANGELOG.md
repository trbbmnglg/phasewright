# Changelog

Newest first.

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
