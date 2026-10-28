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

```markdown
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
- Baseline and verify (same commands): `<typecheck>` · `<lint>` · `<test>` · `<build>` · browser: `<cmd or none>`
- Deploy, in order: `<migration>` → `<backend>` → `<frontend>` · window: <restriction or none>
- Prod check: `<cmd or flows>`
- Rollback (required before deploy): `<cmd that restores the previous version>`

## Risks
- <honest, short>
```

## Phase report

```markdown
## Phase N shipped
- Commit: ... · Deploy id: ... · Migration: ...
- Gates: baseline <ok | N pre-existing> · tests N/N (new failures 0) · typecheck ok · build ok · browser ok · prod check ok · rollback <not needed | ran>
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
