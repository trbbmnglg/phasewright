# phased-shipping

A Claude Code plugin for shipping work in small phases, with one deploy per phase. Each step runs on the cheapest model and effort that can do it well.

## What you get

| Component | Model, effort | What it does |
|---|---|---|
| `/phased-shipping:plan` (skill) | opus, high | Sizes the work: trivial (skip), small (one phase) or large (roadmap). The roadmap has priority, urgency, a calibrated estimate, and model and effort per task type (plan, build, tests, browser checks, review, commit, deploy). It writes one detailed phase plan at a time. Claude can invoke it on its own. |
| `/phased-shipping:run` (skill) | sonnet, medium | Runs one phase: gates, a baseline, the build, checks against the baseline, and a preview. It stops for your approval before anything is committed, deployed or pushed, then rolls back automatically if the prod check fails. It records the outcome to the phase history. Manual only. |
| `model-scout` (agent) | sonnet, medium | Combines three sources: which models you can use, current official guidance, and how each model actually did in your phase history. Refreshes on first use, a provider change, a retirement within 60 days, or after 30 days. |
| `builder` (agent) | per phase plan | Implements one approved plan. Never commits or deploys. |
| `checker` (agent) | haiku, low | Runs typecheck, lint, tests, build and browser checks, first as a baseline and then compared against it. Only new failures block. Results come from exit codes. |
| `shipper` (agent) | haiku, low | Commits, deploys, runs the prod check and rolls back on failure, but only actions marked `APPROVED:`. It scans the staged diff for secrets and respects no-deploy windows. |

State lives in two places:
- **`PHASES.md`** at your repo root: the roadmap, the Model check, status and ids. A new session picks up from it instead of exploring the code again.
- **The phase history** (`history.jsonl` in the plugin's data directory, shared by all your projects). Every shipped phase records estimate against actual agent time (approval waits excluded), the build model and effort, fix rounds, prod first-pass, rollbacks and the agent tokens used. `plan` turns this into an estimate multiplier per kind of work, and into model picks backed by your own results.

## How the model is enforced

- **Planning** is pinned to `opus` at high effort through the skill's frontmatter, so it can't run on a weak model. If your account falls back to another model, it stops and says so.
- **Building** runs on the model and effort the phase plan names. `run` launches the builder with those values per call.
- **Run's gates** refuse to build in these cases:
  - there is no plan;
  - the Model check is stale;
  - the plan's model isn't available to you;
  - the plan puts risky core logic below the mid tier, or a security review below the strongest tier.
- **The override gate** also stops `run` when `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, or when `CLAUDE_CODE_EFFORT_LEVEL` differs from the plan's build effort, because either one silently changes what the plan promised. You can say "proceed anyway", and the plan records it. The gate checks environment variables and the settings files the session can read, so a managed-settings override it can't read won't be caught. A separate version check warns, without stopping, when Claude Code is older than v2.1.292.
- **Checks and shipping** always use the cheap agents.

No hook can enforce the model, because tool-call hooks never see the model name. The guard below, a different hook, does a different job: it limits what the plugin's agents may run.

## The guard

The guard is an extra layer. The agents' own rules and `run`'s gates are still the controls, and the guard is never the only one.

It is a `PreToolUse` hook (`hooks/guard.mjs`) that looks at every Bash, PowerShell, Write, Edit and NotebookEdit call. It only restricts a call made inside one of the four agents; with no agent it allows at once, so your main session and every other agent are never restricted. When it denies, it names the rule and what is allowed, and the agent gets one clear reason to report instead of working around it.

`git` and `gh` are **allowlists** by role. Each agent gets the subcommands its job needs, and everything else is denied, including aliases, subcommands the guard has never heard of and the write forms of allowed ones. Over-denying costs the agent one retry; letting something through is the failure that matters, so when a form is unclear the guard denies it.

| Agent | The guard allows | Everything else is denied, in particular |
|---|---|---|
| `builder`, `checker` | `git`: status, diff, log, show, blame, grep, ls-files, ls-tree, ls-remote, rev-parse, rev-list, describe, name-rev, merge-base, show-ref, cat-file, shortlog, diff-tree, check-ignore, fetch (no `--force`, no `+` refspec), add, restore, rm, mv, apply; `remote` (-v, show, get-url), `stash` (push, list, show, pop), `branch` and `tag` (list forms only), `config` (get and list only), `reflog` (show, list), `checkout` and `switch` (no force, no orphan), `clean` (dry run only). `gh`: view, list, status, diff, checks, watch, search and download on pr, issue, run, release, repo, workflow, gist, label and project; `auth status`; `api` with GET only | `git` commit, push, pull, merge, rebase, cherry-pick, revert, reset, am, notes, update-ref, aliases, force forms and unknown subcommands; `git -c` for any key that can run a program; `gh` writes of every kind, `gh alias`, `gh extension`, `gh auth token`; `curl`, `wget` and `Invoke-WebRequest` calls with a method other than GET, a body, a form or an upload, including attached short options such as `-d@file`; publishing and deploying (`npm publish`, `npm version patch`, `docker push`, `wrangler deploy`, `wrangler workflows trigger`, `terraform apply`, `kubectl apply`, `goreleaser release`, `jsr publish`, task runners given a deploy, release or publish target such as `turbo run deploy`, `nx run app:deploy`, `lerna run deploy`, `run-s deploy`, `node node_modules/.bin/wrangler deploy` and the long list in `hooks/guard-rules.mjs`); `powershell`, `pwsh`, `cmd` and the PowerShell tool (every role uses Bash) |
| `shipper` | `git`: add, commit, push, revert, status, diff, log, show, rev-parse, rev-list, describe, fetch (no `--force`, no `+` refspec), ls-remote, cat-file, `remote` (-v, show, get-url), `branch` (list), `tag` (create or list), `config` (get and list). `gh`: run (watch, view, list), issue (view, list, close, reopen), pr (view, list, checks), release (view, list), repo view, workflow (view, list), auth status, api with GET | force-pushes (every spelling, including short prefixes like `--force-w`, `--mirr`, `--del`), `--mirror`, `--prune`, deleting a remote ref; skipping hooks or signing; `commit --amend`, `rebase`, `reset`, `clean`, branch delete, stash, pull; every other `gh` command, including delete, merge, release create and `gh api` writes; `curl`, `wget` and `Invoke-WebRequest` calls with a method other than GET, a body, a form or an upload, including attached short options such as `-d@file`; `xargs`; `powershell`, `pwsh`, `cmd` and the PowerShell tool (use Bash); any variable, `$(...)` or backtick in an argument of `git push`, `commit`, `revert` or `tag`, because it could hide `--force`, `--no-verify` or `+main` (the one exception is the text after `-m`, `--message`, `-F` or `--file`, so `git commit -F "$TEMP/msg.txt"` works) |
| every role | | Environment that changes git or skips hooks or moves git's config (assignments, `export` and the targets of `read`, `printf -v`, `mapfile` and `getopts` are checked for any `GIT_*` variable, `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `HOMEDRIVE`, `HOMEPATH`, `HUSKY*`, `SKIP`, `LEFTHOOK*`, `BASH_ENV` and a few more), and git's `--git-dir` and `--work-tree`; any word with a `.git` or `.husky` folder in it, or naming git's global or system config file (`.gitconfig`, `.config/git/config`, `etc/gitconfig`, `ProgramData/Git/config`) (the shell, and the Write, Edit and NotebookEdit tools): that is where hooks and config live (`.gitignore`, `.github` and `.gitattributes` are fine); syntax the guard can't read (`$'..'` quoting, `{a,b}` brace expansion, function definitions, a Windows path with single backslashes outside quotes); `eval`, `Invoke-Expression`, `Start-Process`, `Start-Job`, `Invoke-Command`, `trap`, `alias`, `hash`, `coproc`, `enable`, `shopt -s expand_aliases`, a shell that reads its commands from stdin (`echo 'git push -f' \| bash`, `bash <<< '...'`, a bare `bash`, `bash -s`) and launchers it can't follow (`busybox`, `su`, `script`, `parallel`, `flock`, `strace` and similar); `gh auth status -t` and `--show-token` (they print the token); any command over 32768 characters ("command too long to check") |
| `builder` only | | writing `PHASES.md`, or a `phase-*.md` file inside a folder named `phases`, with the Write, Edit and NotebookEdit tools, or from the shell in the common write forms (`>` and `>>`, also glued to a word, `tee`, `sed -i`, `mv` or `cp` onto it, `Set-Content`, `Out-File`, `git checkout` and `git restore` onto it); writing the approval records (`previews/<key>.planned.json`, `.previewed.json`) or anything under `.claude/phased-shipping/`, `.claude/skills/ps-run`, `.claude/skills/ps-plan` or `.claude/agents/ps-*` the same ways; see How approval works |
| `model-scout` | writing `PHASES.md` in the project folder (the hook input's `cwd`) | writing any other file, any path with a `.claude` folder in it, any write when `cwd` is missing; it has no shell |

The guard splits each command before matching: `cd x && git push`, `git -C ../repo push`, `FOO=1 git push`, `/usr/bin/git push`, `bash -c "git push"`, `bash -c -- "git push"`, `env -S "git push"`, `npx wrangler@latest deploy`, `pnpm -C app exec wrangler deploy`, `powershell -Command "git push"`, `cmd //c "git push"`, `echo $(git push)` and `sudo git push` are all seen. PowerShell and cmd are not parsed for the agents: all three roles are refused `powershell`, `pwsh`, `cmd` and the PowerShell tool outright (their workflows use Bash), because their quoting, aliases, assignment and script-block syntax kept hiding commands. `hooks/lib/shell.mjs` still reads PowerShell and cmd text (backticks, curly quotes, Unicode spaces, `<# #>` comments, `$x = git ...` assignments, every `{ }` block, cmd's `call`, `@` and `if`) for other hook plugins that copy the file. git accepts any unique prefix of a long option, so the guard treats `--x` as a flag whenever the flag's name starts with `x`. The exact lists are in `hooks/guard-rules.mjs`.

**It says when it isn't active.** Every `run` starts the checker with a self-test probe, `echo phased-shipping-guard-probe`. When the guard is on, it blocks the probe ("phased-shipping guard is active for checker"), and nothing runs. If the probe runs, the guard isn't active in that session, and the preview says so. This never stops the phase. The result is recorded as `guard` in the phase history, and `history.mjs stats` prints how many phases had it active.

**Fail-closed rule.** The guard works out the role first (from `agent_type`, or from `--agent` in a personal copy) and only then loads its rules. Inside a known agent, if it can't judge a call, it denies it: input it can't read, a missing or half-copied rules file, an error while judging, a command that is too long, nesting that is too deep. With `--agent <role>`, unreadable input is denied too, because the role is known from the argument. If there is no role and the input can't be read, it can't tell whose call it is, so it allows.

**Plugin install and personal copies.** A plugin install wires the guard through `hooks/hooks.json`, matched on the agent type (`phased-shipping:builder` and the other three, nothing else). Plugin agents ignore a `hooks` field in their own files, so the plugin's agent files have none. `sync-personal.mjs` instead copies the hook scripts to `~/.claude/phased-shipping/hooks/` and adds a `hooks:` block to each generated `ps-*` agent file that runs the guard with that agent's name (`--agent builder` and so on); the `ps-*` names are not roles, so a personal copy relies on that argument. It edits no settings file. The personal block also sets `onFailure: block`, so if the hook can't run (node missing, the script gone), the call is blocked instead of going ahead. That needs Claude Code v2.1.295 or later; on an older version the key is most likely ignored (what an older version does with an unknown key is undocumented), so the personal-copy hook then fails open like the plugin's. The plugin's `hooks.json` does not set it: a missing `node` would then block your main session too, so there a hook that can't start lets the call through. The script refuses to install when the Claude home path contains a `$`, a backtick or a double quote, because the hook command is shell text.

## How approval works

`approve` doesn't take the commands from your memory of the preview. At the preview, `run` shows the plan's deploy, prod-check and rollback commands verbatim, with a `Commands hash` of 12 hex characters (the SHA-256 of the plan's `## Commands` section, after CRLF, trailing spaces and trailing blank lines are normalized), and records that hash and the text in the plugin's data folder (`~/.claude/phased-shipping/previews/` for personal copies). The script prints the recorded section, and the preview shows that printed text. On `approve` and on `push`, `run` checks the plan against that record before it briefs the shipper, and the check prints the section again. The shipper brief takes the deploy, prod-check and rollback commands only from that printed, recorded section, copied verbatim, never from a fresh read of the plan, the preview turn or memory, so what was hashed, shown and run are the same text. A plan with two headings that look like "Commands", or one that isn't exactly `## Commands`, is refused as ambiguous. If a command changed in between (an edit by you or another session, a `git pull`, a builder that touched the plan), it stops, shows the diff and tells you to run `/phased-shipping:run N` again to preview the current commands. There is no "re-preview now" shortcut: a fresh preview turn is the point. With no record at all, it stops and asks for a preview first. The shipper repeats the hash in its report, so the phase report shows which commands were approved.

The plan skill makes a first record when it writes the plan (`planned`). If the commands changed between planning and the preview, the preview shows the diff as a warning, not a stop, because you may have edited the plan on purpose. A plan made elsewhere or before 0.5.0 has no planning record, and the preview says so. The `Commands hash` line in the plan file is a convenience that anyone can edit; the record in the data folder is the one that counts. As a second layer, the guard denies the builder writes to `PHASES.md` and `phase-*.md` files in a `phases` folder (also `git checkout` and `git restore` onto them, `cp`, `mv`, `install` and `rsync` into them, `git apply` and `git mv`), and to what the binding trusts: the approval records (`previews/<key>.planned.json` and `.previewed.json`), the personal copies' data folder, skills and agents (`.claude/phased-shipping/`, `.claude/skills/ps-run` and `ps-plan`, `.claude/agents/ps-*`), and the installed plugin folders for phased-shipping (`.claude/plugins/cache`, `marketplaces` and `data`, any path there with `phased-shipping` in it), so the builder can't change the commands, the records or the installed script, hooks and skills before the preview. It also denies the builder running `commands-hash.mjs` with `--record` (only the run skill records approval fingerprints; `--check` and `--short` stay allowed) and `node -e` text that writes into a `previews` folder. Reading all of these stays allowed, and `git restore --staged` alone (it only unstages) is allowed.

This protects against accidental and model-made drift. It does not protect against a malicious local process that can rewrite both the plan and the record. The limits:
- The builder can still forge a record by running the script from its own `node -e` or from a script file it writes: the guard denies the plain forms, not every way to run node.
- The builder's shell rules are best effort. They read literal paths in the common write forms (dot segments, doubled slashes and a trailing `/.` are resolved), not a path built from a variable, a glob, or a `cd` followed by a bare file name, nor `git stash pop`, a whole-folder `git checkout`, subshell or brace-group redirects, `>|`, other in-place editors, or scripts. They also deny a quoted literal such as `echo "a>PHASES.md"`.
- The record key is path-based (the plan's real path, with symlinks and short Windows names resolved, lower-cased). A relative and an absolute path to the same file share a key, but a different spelling that resolves elsewhere (a copy, another checkout) is another plan and may need a new preview.
- A `previewed` record is not used up: an `approve` in a later session still matches an old preview of an unchanged plan. The commands are unchanged, so this is accepted.
- A fix-forward round that changes the plan's commands needs a new preview (Preview steps 1 and 2 again, then end the turn) before the fresh `approve`.
- It needs `node` and, unlike the guard, doesn't depend on hooks, so it works where an organization policy turns hooks off.

## Requirements

- Claude Code v2.1.292 or later (per-call effort; older versions run subagents at their file's effort).
- For the guard: `node` on your PATH (the hook is a node script), and, for the personal copies' `onFailure: block`, Claude Code v2.1.295 or later.

## What it touches

This is everything the plugin reads, writes and runs, taken from its skills, agents and script.

**Files it reads**
- Your project: the files named in the phase plan, plus the manifest, README and source files the planner needs to size the work.
- Settings and environment: the `model`, `availableModels` and `effortLevel` keys of your Claude Code settings files, any model convention in `CLAUDE.md`, and the values of only these environment variables: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL*`, `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_USE_*`. It never prints the rest of the environment or of those files.
- The phase history file, and the approval records in the data folder (see How approval works).
- **The guard hook** reads nothing but the call it is handed (the tool name, the command or the file path, the working folder and the agent type). It runs on every Bash, PowerShell, Write, Edit and NotebookEdit call in any session where the plugin is enabled, your main session included, where it allows at once. Each call starts one node process. Measured on the allow path (a main-session payload, 30 runs, on a busy Windows laptop): median 1341 ms, p95 2667 ms. An empty node script on the same laptop took a median of 1298 ms, so about 40 ms is the guard's own work and the rest is node starting, which varies a lot by machine. Expect a delay on every Bash, PowerShell, Write and Edit call, in every session where the plugin is enabled. It writes no files and makes no network calls.

**Files it writes**
- `PHASES.md` at your repo root (roadmap, Model check, status).
- The plan folder, one file per phase (default `docs/phases/`): the plan, its timestamps and its phase report.
- The checker's baseline file and its logs or screenshots, at the paths the brief names.
- The phase history, `history.jsonl`: `${CLAUDE_PLUGIN_DATA}/history.jsonl` for a plugin install, `~/.claude/phased-shipping/history.jsonl` for personal copies. A phase record is one line with the estimate, agent time, build model and effort, fix rounds, prod outcome and, from 0.3.0, the agent tokens per phase. It holds no code and no project text beyond the project name.
- A temporary JSON file that holds the record while the history script appends it.
- Approval records: `<data folder>/previews/<key>.planned.json` and `<key>.previewed.json`, written by `commands-hash.mjs`. Each holds the hash, the text of the plan's `## Commands` section, the plan path and a timestamp. The script writes nothing else and makes no network calls.
- Personal copies only: the guard scripts under `~/.claude/phased-shipping/hooks/` and the `hooks:` block in each `ps-*` agent file. `sync-personal.mjs` writes both, marks them as generated, and removes only what it marked.
- Your source files, but only through the builder, and only to implement the approved plan.

**Commands it runs**
- Read-only status commands: `git status`, `git diff --stat`, `env` filtered to the variable names above, and `claude --version`.
- The plan's baseline and verify commands, through the checker. The checker never deploys, publishes or pushes, and when the brief has no commands it proposes some and waits for your OK instead of running them.
- The plan's commit, deploy, prod-check and rollback commands, through the shipper, and only after `/phased-shipping:run approve`. A push needs `/phased-shipping:run push` or a plan whose deploy step is the push, and your approval.
- The history script (`history.mjs`), with `stats` and `record`.
- The approval script (`commands-hash.mjs`), to hash the plan's commands and record or check them.
- The guard probe, `echo phased-shipping-guard-probe`, through the checker. It prints a word and changes nothing.

**Network**
- `model-scout` runs a web search and fetches up to 3 pages when the Model check refreshes. It treats page content as data.
- Nothing else in the plugin makes network calls itself. Your own verify, deploy and prod-check commands reach whatever they reach.

**Agents**

| Agent | Tools | Turn limit |
|---|---|---|
| `builder` | Read, Edit, Write, Grep, Glob, Bash | 200 |
| `checker` | Read, Grep, Glob, Bash | 25 |
| `shipper` | Read, Grep, Glob, Bash | 20 |
| `model-scout` | Read, Write, Grep, Glob, WebSearch, WebFetch | 15 |

For a `security` review, `run` also delegates a read-only review to Claude Code's built-in `general-purpose` agent.

**What it never does**
- Force-push, skip hooks or bypass signing, amend a pushed commit, or delete a branch.
- Commit, deploy or push without your `approve`, or deploy in the same turn as the build.
- Run the commands of a plan or `PHASES.md` that came with a cloned repo, or run a close step from it, without showing them to you and getting your OK.
- Print credentials, or copy production personal data into prompts, briefs, plan files or reports. Tests and fixtures use synthetic or masked data.

## Limits

Each agent has a turn limit (`maxTurns` in its file), so a runaway agent stops. The values are about 1.5 to 2 times the most each agent needed across this plugin's own history (a builder phase took up to 148 tool calls, a checker run 12, a shipper run 9):

| Agent | `maxTurns` | Why |
|---|---|---|
| `builder` | 200 | A large phase is many reads, edits and test runs. |
| `checker` | 25 | A few commands and a short report. |
| `shipper` | 20 | A fixed runbook of commit, deploy, check and rollback. |
| `model-scout` | 15 | One search, up to 3 fetches and one write. |

When an agent stops at its limit, `run` stops too. It reports what was done and what is left, and never treats the partial result as complete. You can resume the phase. Partial output at the limit needs Claude Code v2.1.246 or later, which the stated minimum already covers. Treat the values as starting points and tune them from your own history.

A checker can report `UNFINISHED` or `TIMED OUT` for a command that was still running after its bounded wait (10 minutes, or 5 reads of a background output file). That is not a pass: `run` runs the command itself in the foreground and marks the row "(re-run in main)". The long-command rule is a prompt change, so a model can still ignore it.

`caught_by` in the history is only as good as the main session's attribution of each fix round or rollback to a check. An unclear source is recorded as the check that first reported it. Records made before 0.6.0 have no `caught_by` and are not backfilled.

The guard has limits of its own:
- **It can be switched off.** An organization policy that allows only managed hooks (`allowManagedHooksOnly`) blocks plugin hooks, unless an admin force-enables the plugin. `disableAllHooks` does the same. The probe shows which case you are in, run by run.
- **It needs node.** The hook runs `node`. If `node` isn't on the PATH, the plugin's hook can't start, and Claude Code lets the call go ahead, because the plugin's `hooks.json` can't set `onFailure: block` without blocking your main session as well. The same goes for a hook that times out (10 seconds). The personal copies do set `onFailure: block`, so a missing `node` stops the agent's calls there instead (v2.1.295 or later; on an older version the key is most likely ignored, and the hook then fails open).
- **It is not a sandbox.** It stops direct commands. It doesn't stop an agent from writing a script that pushes and then running it (`bash script.sh`, `source script.sh`), or from a command it can't see inside, such as a variable that holds a program name (`$CMD push`, still open). Text piped into a shell (`... | sh`) is denied, but a script file, `python -`, `node -e` and other interpreters that run text are not. A `.git` path built from a variable, glob or command substitution (for example `"$(git rev-parse --git-path hooks)/pre-commit"`) is not matched, only literal text. Text piped into `xargs` is not seen for the builder and checker (`echo deploy | xargs npx wrangler`, `echo push | xargs git`); the shipper is refused `xargs` outright. A flag or verb hidden in a variable is denied for the shipper's `git push`, `commit`, `revert` and `tag`, but not for `gh api`, `curl` or the deploy tools of the builder and checker (`V=deploy; wrangler $V`). Hooks defined outside `.git` and `.husky` (`lefthook.yml`, `.pre-commit-config.yaml`, a `package.json` script) are not protected. These stay open: closing them would deny most real work.
- **The lists are not exhaustive.** `git` and `gh` are allowlists, so an unknown form of those is denied. The publish and deploy lists are denylists, so a tool or flag that isn't listed gets through. The lists are an extra layer on top of the agents' own rules and `run`'s gates, which still apply; they are not a complete list of what could go wrong.
- **It over-denies on purpose.** An unclear form is denied, and a false deny costs the agent one retry. A builder that types `git commit` in a scratch repository to set up a fixture is denied, and so are `git reset HEAD file` (use `git restore --staged`), `git branch new-name` (use `git checkout -b`), `git commit-tree`, `git config user.name x`, a `$'..'` string, `{a,b}` braces, and any `gh` write. A test suite that commits inside its own temporary repositories, run as `npm test`, is not denied, because the guard sees only the command the agent types. The agent reports the denial instead of working around it.
- **A session started as an agent is restricted too.** `claude --agent phased-shipping:builder` makes the main session that agent, so the guard restricts it as well. That is the guard working as designed.
- **Not yet seen firing in a real run.** Hooks can't run on the machine this was built on (an organization policy), so the guard is proven only by feeding sample payloads to the scripts, in this repo's tests, which include a regression case for every gap an independent security review found. The `agent_type` field, the frontmatter `hooks:` block and `onFailure` come from the Claude Code docs and the release notes, not from a run here. The first real-run check is the probe on a machine without that policy.

## Windows and Git Bash

- The agents run `npm`, `node` and `git` directly. In Git Bash, `cmd /c npm ...` prints only the cmd banner and runs nothing, so don't wrap commands in `cmd`. The guard may also block `cmd` and `powershell` for the agents.
- The main session records the timestamps (PowerShell `(Get-Date).ToUniversalTime()` on Windows when it has a PowerShell tool, otherwise `date -u`). The agents don't read the clock. A local-time question, such as a no-deploy window, is for the main session to check with PowerShell.
- A long command can be moved to the background by the Bash tool once it passes its timeout (2 minutes by default, 10 at most). The checker passes the 10-minute timeout on every call.

## Install

From the library repo (Claude Code):

```bash
claude plugin marketplace add trbbmnglg/phasewright
claude plugin install phased-shipping@phasewright
```

To try it without installing: `claude --plugin-dir plugins/phased-shipping`

**If you can't use plugin marketplaces** (for example, your organization restricts them; check its policy first), you can install the plugin as personal skills and agents instead, from the repo root:

```bash
node scripts/sync-personal.mjs           # writes /ps-plan, /ps-run and the ps-* agents into ~/.claude
node scripts/sync-personal.mjs --check   # reports drift
node scripts/sync-personal.mjs --remove  # removes them
```

Personal skills and agents aren't namespaced, so the copies get a `ps-` prefix. The script only overwrites or removes files it generated. History goes to `~/.claude/phased-shipping/`, and so do the guard scripts (`hooks/`). Each `ps-*` agent copy also carries a `hooks:` block that runs the guard.

**Other tools:** the skills load in VS Code Copilot and Cursor (they read `SKILL.md`), but model pinning and the four agents are Claude Code features.

## Use

```text
/phased-shipping:plan add accounts, billing and receipts
/phased-shipping:plan phase 1
/phased-shipping:run 1
/phased-shipping:run approve
/phased-shipping:run push
/phased-shipping:plan refresh-models
```

`plan` asks its questions through the AskUserQuestion tool, so your answer stays inside the same turn, on the planning model. If you reply in plain chat instead, the follow-up runs on your session model; use `/phased-shipping:plan <answer>` to stay on the planning model.

## Customize

- **Different defaults:** edit `model:` and `effort:` in `skills/*/SKILL.md` and `agents/*.md`.
- **Pinning versions:** use aliases (`opus`, `sonnet`, `haiku`, `fable`) and pin versions with `ANTHROPIC_DEFAULT_*_MODEL`. That way the files don't go stale when models change.
- **Team conventions:** put your model convention in CLAUDE.md. The plan skill follows it over the scout's picks, unless a model is retired or unavailable.
- **Other providers:** on Bedrock, Vertex and Foundry the aliases can resolve to older versions. The Model check records what they resolve to.

## Test it

```bash
cd plugins/phased-shipping
claude plugin validate . --strict
claude plugin eval . --allow-tools WebSearch,WebFetch,Bash
```

The nine cases check that:
1. a multi-part request produces a phased roadmap with model and effort for each phase;
2. a typo fix doesn't trigger the plan skill;
3. tests, browser checks, commit and deploy are routed to the cheap tier;
4. a small feature becomes one phase with no roadmap round-trip;
5. `run` refuses to build when there is no plan;
6. `run` doesn't deploy in the turn that builds;
7. the shipper skips actions that have no `APPROVED:` line;
8. `run` shows a plan's commands and waits for your OK when the plan came with a cloned repo;
9. `run` treats a builder result that starts with `NO SHELL:` as unverified, and doesn't go on to the preview as if the checks had passed.

Cases 5 to 9 test the safety rules. They have not been run against a model yet, so expect to adjust their wording on a first run.

The guard has its own tests, which run in this repo's `npm test`: `node --test tests/guard.test.mjs tests/shell-split.test.mjs`. They feed sample hook payloads to the scripts; they don't need hooks to run.

Evals make real model calls on your account. Use `--ablation none` while you're iterating, to halve the cost.

## Cost notes

- **`plan`** has to be listed so Claude can invoke it on its own, so its short description is in context on every turn.
- **`run`** is manual-only, so it adds nothing to context until you invoke it.
- **Agents:** their descriptions cost a little on every turn. Their full text loads only when they run.
- **Model check:** it refreshes only on events or after 30 days, so the web isn't searched on every phase.
- **Baseline:** this is one extra cheap check run, and it saves the fix rounds spent chasing failures that were already there.
