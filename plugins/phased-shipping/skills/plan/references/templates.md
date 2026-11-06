# Templates

## Contents
- PHASES.md (roadmap and resume file)
- Phase plan
- Phase report
- Handover prompt

## PHASES.md

Keep it at the repo root. A fresh session resumes from it without exploring the code again.

```markdown
# <Release or goal>
Status as of <YYYY-MM-DD>. Current phase: N.

## Model check (<YYYY-MM-DD>; refresh on provider change, retirement within 60 days, or after 30 days)
- Provider: <Anthropic API | Bedrock | Vertex | Foundry>
- Session model: <id> · Pinned: <env vars / settings keys found, or none>
- Available: <aliases and the ids they resolve to>
- Overrides: <none | variable, value and effect>
- Sources: <URLs>
- Picks: plan <alias (effort)> · risky build <...> · routine build <...> · tests <...> · checks and ship <...> · security review <...>
- From history: <multiplier, notable model outcomes, or "no history yet">
- Differs from project convention: <none | what and why>

## Roadmap
<!-- phased-shipping:roadmap v1 -->
| # | Phase | Kind | Priority | Urgency | Est. (raw → cal.) | Plan | Build | Runs as | Checks and ship | Review | Cost | Blocked by | Status | Commit / deploy | Actual |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ... | backend | P0 | Now | 1 h → 1.3 h | sonnet (medium) | sonnet (medium) | builder | haiku (low) | standard | $ | none | planned | | |

## Open items
- <blocked input, follow-up, known issue>

## Close steps
<optional: steps the run skill follows after every phase, for example "update the issue board" or "post a status note". Delete the section if there are none.>
```

The marker line directly above the roadmap table makes it a standard table ([the format](../../roadmap/references/format.md)). Status is one of `planned`, `in progress`, `shipped` or `parked`; a skipped phase is `parked`, with a note.

`run` follows `## Close steps` as the last step of closing a phase. If the file didn't come from the plan skill in this session or from the user's own repo history, `run` shows the steps and waits for the user's OK first.

## Phase plan

The outer fence has four backticks because the plan holds a fenced `ship` block.

````markdown
# Phase N: <one-line outcome>

**Models:** plan <alias (effort)> · build <alias (effort)>, runs as <main | builder> · checks and ship <alias (effort)> · review <standard | security>
**Kind:** <ui | backend | data | infra | docs | mixed> · **Priority:** P# · **Urgency:** <Now | Soon | Later> · **Est.:** <raw> h → <calibrated> h build + <M> min review · **Migration:** <none | id>
**Timestamps:** started <ISO> · previewed <ISO> · approved <ISO> · shipped <ISO>
**Commands hash:** <12 hex> (planned)

## Context
What was asked. What reading the code found (defects and gaps, not only missing features).
**Decided:** choices already made, so they aren't reopened.

## Design
A. <area>: files touched, what is reused, what is new.

## Build order
1. <step> (<h>)
2. ...
N. Docs, typecheck, full test run (<h>)

## Tests
- <concrete case>; a regression test for every defect found.

## Commands
- **Full verify** (baseline and final compare): `<typecheck>` · `<lint>` · `<test>` · `<build>` · browser: `<cmd or none>`
- **Fast verify** (after the build and after each fix round): `<lint>` · `<typecheck>` · `<tests for the area this phase changes>` · `<the regression pack, if the project has one>` (or `same as full`)
- **Parallel groups** (optional; groups of Full verify commands that write no shared files and may run at the same time): group 1 = `<cmds>`; group 2 = `<cmds>`. The groups must cover every Full verify command exactly once, the browser check included. Leave this line out when none of the commands are independent. Write each of these as one top-level bullet, with its commands in backticks: `run` reads one Full verify bullet, one Fast verify bullet and one Parallel groups bullet,; a second Full verify bullet, a fenced block or a bullet with no command means a baseline cannot be reused.
- Deploy, in order: `<migration>` → `<backend>` → `<frontend>` · window: <restriction or none>
- Prod check: `<cmd or flows>`
- Rollback (required before deploy): `<cmd that restores the previous version>`

```ship
branch: <branch>
step: git add -A -- <paths>
step: git diff --quiet
step: test -z "$(git status --porcelain --untracked-files=all | grep '^??')"
step: git commit -F '<commit message file>'
step: git push origin <branch>
step: <deploy command>
check: <prod check command, exit 0 when it passes>
check: for i in 1 2 3 4 5 6; do ids=$(gh run list --commit "$(git rev-parse HEAD)" --json databaseId --jq '.[].databaseId'); test -n "$ids" && break; sleep 10; done; test -n "$ids" && for id in $ids; do gh run watch "$id" --exit-status || exit 1; done
check: test -z "$(git status --short)"
rollback: <cmd that restores the previous version>
timeout: 900
```

## Risks
- <honest, short>
````

The `ship` block is the deploy, prod-check and rollback commands again, one `key: value` entry per line, for `run` to run on approve with `ship.mjs` in one go (one permission prompt):
- `branch:` once; `step:`, `check:` and `rollback:` at least once each, in order; `timeout:` optional, in seconds (default 900, at most 1800). Any other key, an empty block or a second block is refused at approve.
- Every expectation is a command whose exit code decides: write "the tree is clean" as the `test -z` check in the block above, not as prose. Before the commit, the tree is not clean yet (the `git add` step staged the phase's files, and `git status --short` lists staged files too), so the two steps after `git add` check only what would be left out: `git diff --quiet` fails on a tracked file changed but not staged, and the `grep` step fails on an untracked file. A stray change stops the ship before anything is committed.
- A `git commit -F '<file>'` step names its message file in single quotes; the preview binds that file's SHA-256 as well. A step with the word commit must be exactly `git commit` with `-q`, `-s`, `--no-edit` and one `-F` naming the message file (stage with a `git add` step before it; no `-a`, pathspec, `-m` or `&&`), and a check or a rollback never commits (undo with `git revert`), or the block is refused at approve. The same for a push: a step with `git push` is exactly `git push origin` and the block's branch (`-q` allowed), on its own, with no refspec, tag or other option; a check never pushes; a rollback line pushes only that way after `&&`, as in `git revert --no-edit HEAD && git push origin main`. `ship.mjs` then checks that origin's branch is HEAD.
- The second check line is a CI watch: it fails when GitHub lists no run for the commit yet (right after a push the list can be empty), retrying six times, 10 seconds apart, and then watches every run. Keep that shape for any CI watch, and drop the line when a push starts no CI.
- Every command must be one the shipper may run (the guard's shipper rules): `ship.mjs` checks them all before it runs any.
- The block is inside `## Commands`, so the commands hash binds it like every other line. Leave it out and `run` briefs the shipper, which stays the fallback.

## Phase report

```markdown
## Phase N shipped
- Commit: ... · Deploy id: ... · Migration: ...
- Gates: baseline <ok | reused | N pre-existing> · full verify <ok, tree id> · tests N/N (new failures 0) · typecheck ok · build ok · browser ok · prod check ok · rollback <not needed | ran>
- Estimate vs actual (agent time, approval wait excluded): ~3 h vs 3.5 h (why, if off by more than 30%)
- Models used: build <alias (effort)> · checks <...> · ship <...> · review <...>
- Next: Phase N+1 (<name>); waiting on <input, if any>
```

Recording estimate against actual, and the models used, is what makes the next roadmap's numbers and picks believable.

## Handover prompt

Use this when the phase runs in another repo's session. It must work when pasted into a fresh session that has none of this conversation. Keep it short: point at files rather than repeating them, and add only what the files don't say.

```text
Continue the "<release or goal>" release in this repo, phase <N>: <one-line outcome>.

State and plan (read these first; don't re-explore what they cover):
- PHASES.md (roadmap, Model check, decisions)
- <plan folder>/phase-<N>-<slug>.md (this phase's plan)

Decided already (don't reopen): <3-6 bullets of decisions that affect this phase>
Inputs from earlier phases: <URLs, ids, schemas, file paths produced upstream>
Constraints for this repo: <deploy trigger, auth, no-deploy window, files not to grow, personal-data rules>

Run: /<run skill> <N>
Stop at the preview for my OK. Don't push or deploy without it.
```
