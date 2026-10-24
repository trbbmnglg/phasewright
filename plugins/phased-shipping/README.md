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
- **The phase history** (`history.jsonl` in the plugin's data directory, shared by all your projects). Every shipped phase records estimate against actual agent time (approval waits excluded), the build model and effort, fix rounds, prod first-pass and rollbacks. `plan` turns this into an estimate multiplier per kind of work, and into model picks backed by your own results.

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

A hook can't do this gate, because tool-call hooks never see the model name.

## Requirements

- Claude Code v2.1.292 or later (per-call effort; older versions run subagents at their file's effort).

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

Personal skills and agents aren't namespaced, so the copies get a `ps-` prefix. The script only overwrites or removes files it generated. History goes to `~/.claude/phased-shipping/`.

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

The four cases check that:
1. a multi-part request produces a phased roadmap with model and effort for each phase;
2. a typo fix doesn't trigger the plan skill;
3. tests, browser checks, commit and deploy are routed to the cheap tier;
4. a small feature becomes one phase with no roadmap round-trip.

Evals make real model calls on your account. Use `--ablation none` while you're iterating, to halve the cost.

## Cost notes

- **`plan`** has to be listed so Claude can invoke it on its own, so its short description is in context on every turn.
- **`run`** is manual-only, so it adds nothing to context until you invoke it.
- **Agents:** their descriptions cost a little on every turn. Their full text loads only when they run.
- **Model check:** it refreshes only on events or after 30 days, so the web isn't searched on every phase.
- **Baseline:** this is one extra cheap check run, and it saves the fix rounds spent chasing failures that were already there.
