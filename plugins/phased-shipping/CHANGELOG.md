# Changelog

Newest first.

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
