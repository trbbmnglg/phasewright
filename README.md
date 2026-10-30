<h1 align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/phasewright-lockup-dark.svg"><source media="(prefers-color-scheme: light)" srcset="docs/brand/phasewright-lockup-light.svg"><img alt="Phasewright" src="docs/brand/phasewright-lockup-light.svg" width="560"></picture></h1>

Skills, agents and plugins that keep AI-assisted coding work small, checked and reversible.

<!-- whats-new:start -->
> **Under active development.** Interfaces and file formats may still change; see [Releases](#releases).

## What's new

- **phased-shipping 0.11.1** (2026-10-29): Every script command line in every skill now writes its paths in single quotes, and a call whose path holds an unsafe character is not run.
- **phased-shipping 0.11.0** (2026-10-28): Faster runs without a lower bar: fast and full verify sets, reusable green baselines, review briefs and visible timings.
- **phased-shipping 0.10.0** (2026-10-27): The dashboard page: projects, sessions and current phase with its loops, one local file rebuilt at every step, no network.

Full history: [phased-shipping changelog](plugins/phased-shipping/CHANGELOG.md).
<!-- whats-new:end -->

## The problem

Ask an AI coding assistant for a big change and it tends to build it all in one go, skip checks, lose the plan between sessions and ship with no way back. Nobody can see what it was allowed to do. Phasewright keeps the work small, checked and reversible.

## How it helps

- Small phases with one deploy each, and the plan kept on disk. See the [phased-shipping README](plugins/phased-shipping/README.md).
- A baseline before the build and a comparison after it, so only new failures block. See [What you get](plugins/phased-shipping/README.md#what-you-get).
- A preview you approve, bound to the exact commands you saw, then a production check and an automatic rollback. See [How approval works](plugins/phased-shipping/README.md#how-approval-works).
- The model and effort that fit each kind of task, with estimates calibrated from your own history. See [How the model is enforced](plugins/phased-shipping/README.md#how-the-model-is-enforced).

## Quick start

```bash
claude plugin marketplace add trbbmnglg/phasewright
claude plugin install phased-shipping@phasewright
```

Then ask for a feature and run the plan skill, `/phased-shipping:plan`. Other tools and single downloads are under [Install in your tool](#install-in-your-tool).

## What a phase looks like

Abridged from a real run of this project's own tooling:

```
Phase 7b preview
  Gates       baseline pass (285 tests) · compare pass, 0 new failures (294 tests)
              review standard · fix rounds 0
  Models      builder sonnet (high) · checks haiku (low)
  Time        0.66 h so far, 1.3 h estimated
  Commands    1. git add -A -- library.json plugins tests
              2. git commit -F <message file>
              3. git push origin main
  Hash        Commands hash: 79a48e698d6b
  Prod check  CI green · issue closed · remote file matches · copies synced
  Rollback    git revert --no-edit HEAD && git push origin main

Reply /phased-shipping:run approve to run the commands listed above.
```

## What's inside

Everything here is a plain Markdown file or folder you can read, copy and adapt.

**Skills** (`skills/`), each a folder containing a `SKILL.md`:

| Skill | What it does |
|---|---|
| `prompt-engineering` | 24 prompt techniques, an 8-part anatomy, a robustness checklist and a maturity rubric |
| `planner` | Multi-perspective implementation plans: business analysis, architecture, QA, security, definition of done |
| `docs-generator` | Flowcharts, design docs, API docs, ERDs, changelogs and release notes |
| `business-analyst` | Clarifies requirements and writes a testable feature spec, sized to the risk (Lean, Standard or High-risk) |
| `refactoring` | Risk-based refactoring: classify each change, keep behavior the same and prove it; 300 lines starts a review, not a forced split |
| `error-handling` | API response shapes, validation, database errors and loading and empty states |
| `performance` | Render, fetch and query patterns for web apps |
| `commits` | Conventional Commits types, scopes and splitting rules |
| `use-case-discovery` | Design Thinking discovery: evidence to pain points, ranked use cases, user stories and metrics, with Jira and Azure DevOps import files |

**Agents** (`agents/claude/`), each a single Markdown file: `debugger`, `prompt-engineer`, `docs-writer`.

**Plugins** (`plugins/`):
- [`phased-shipping`](plugins/phased-shipping/README.md) plans work as small phases with one deploy each, and picks the model and effort for every kind of task.
- [`free-resources`](plugins/free-resources/README.md) reports how pressured your machine is, which processes use the most, and what a task really needs. It never closes anything.

`library.json` is generated from these files and lists every item with its install steps per tool.

## Install in your tool

### Claude Code

```bash
claude plugin marketplace add trbbmnglg/phasewright
claude plugin install phasewright@phasewright        # all skills and agents
claude plugin install phased-shipping@phasewright    # the phased-shipping plugin
claude plugin install free-resources@phasewright     # the free-resources plugin
```

Or copy a skill folder into `.claude/skills/` (project) or `~/.claude/skills/` (personal), and an agent file into `.claude/agents/` or `~/.claude/agents/`.

The phased-shipping plugin needs Claude Code v2.1.292 or later, because it sets effort per call. Older versions run subagents at their file's effort.

### VS Code with GitHub Copilot

Copy a skill folder into `.github/skills/`, `.claude/skills/` or `.agents/skills/` in your project, or into `~/.copilot/skills/` for all projects. VS Code also reads Claude-format agents from `.claude/agents/`, so the agent files work there unchanged.

### Cursor

Copy a skill folder into `.cursor/skills/` or `.agents/skills/` (project), or `~/.cursor/skills/` (personal). Cursor has no documented custom-agent file format, so use the matching skill instead of an agent.

### OpenAI Codex

Copy a skill folder into `.agents/skills/` (project; Codex also looks in the parent folders up to the repository root) or `~/.agents/skills/` (personal). Each agent has a Codex version, `agents/codex/<name>.toml`: copy it into `.codex/agents/` (project) or `~/.codex/agents/` (personal). It takes the model and the tool list from your Codex settings. The skills marked manual only in Claude Code (`disable-model-invocation`) need an `agents/openai.yaml` with `policy.allow_implicit_invocation: false` to stay manual. For a plugin, copy its skills; its hooks, agents and model pins don't carry over.

### Google Antigravity

Copy a skill folder into `.agents/skills/` (project) or `~/.gemini/config/skills/` (personal, App and IDE); the CLI reads `~/.gemini/antigravity-cli/skills/`, and the older `.agent/skills/` still works. Each agent has an Antigravity version, `agents/antigravity/<name>.md`: copy it into `.agents/agents/` (project) or `~/.gemini/config/agents/` (personal, App and CLI). It takes the model and the tool list from your Antigravity settings. For a plugin, copy its skills; its hooks, agents and model pins don't carry over.

The Codex and Antigravity agent files are generated from the Claude ones by `node scripts/build-agent-versions.mjs` (also run by `node scripts/build-manifest.mjs`), so edit the Claude file and regenerate.

### Other tools

Copy a skill folder into your tool's skills folder.

### Download a single item

Every release attaches one zip per item (`skill-planner.zip`, `agent-debugger.zip`, ...). Each zip holds the item in its own folder: unzip it into your skills or agents folder. An agent's zip also holds its Codex and Antigravity versions, in `codex/` and `antigravity/`.

## What works where

| Tool | Skills | Agents | Plugins | Tried by the maintainer |
|---|---|---|---|---|
| Claude Code | full | full | full | yes, on Windows |
| VS Code with GitHub Copilot | full | full (reads `.claude/agents`) | skills only | not yet |
| Cursor | full | none | skills only | not yet |

- macOS is untested. The [free-resources README](plugins/free-resources/README.md#compatibility) says what was and was not tried.
- The Cursor marketplace files (`.cursor-plugin/`) follow Cursor's published layout, but they are untested end to end. Copying skill folders is the supported path.
- Settings such as `model:` and `disable-model-invocation:` are Claude Code and Copilot features. Tools that don't know them ignore them.

## What it will not do

- It is not a sandbox. The guard is an extra layer on top of the agents' own rules, and it has known gaps: see [The guard](plugins/phased-shipping/README.md#the-guard) and [Limits](plugins/phased-shipping/README.md#limits).
- It never commits, pushes or deploys without your approval: see [How approval works](plugins/phased-shipping/README.md#how-approval-works).
- It never closes your processes. `free-resources` only reports: see [What this runs on your machine](plugins/free-resources/README.md#what-this-runs-on-your-machine).
- It sends none of your files anywhere. The one network use is a web search for current model guidance: see [What it touches](plugins/phased-shipping/README.md#what-it-touches).
- The plugins do not run in Copilot or Cursor, only the skills do: see [Compatibility](plugins/free-resources/README.md#compatibility).
- Releases are not signed and have no build provenance yet: see [SECURITY.md](SECURITY.md#how-releases-are-built).

## Releases

Releases are numbered by version and named. The version is the git tag.

<!-- releases:start -->
| Release | Name | Status | What it is |
|---|---|---|---|
| v1.0.0 | Allacapan | shipped | First public release: skills, agents and the phased-shipping plugin. |
| v1.0.1 | Aparri | shipped | Fixes item summaries that were cut off mid-word. |
| v1.1.0 | Baggao | shipped | Trust and guardrails, the free-resources plugin, a local dashboard, the README, the footprint budget, supply-chain signals, rewritten refactoring and business-analyst skills, and OpenAI Codex and Google Antigravity install support. |
| v1.1.1 | Ballesteros | shipped | Adds the use-case-discovery skill, a Design Thinking discovery from evidence to use cases, user stories and metrics, and removes the project-board tooling. |
| v1.2.0 | Buguey | planned | Evals, reviewer agents, security checks by default, trustworthy history, operate and rollout, plan import, a test-first gate, more harnesses and new skills. |
| v1.3.0 | Camalaniugan | planned | Privacy and governance packs. |
| v1.4.0 | $\color{#D4AF37}{\textbf{Gattaran}}$ | planned | The sensitive-information guard and the loop-guard plugin. |
| v1.5.0 | Gonzaga | planned | The dependency upkeep plugin. |
| v1.6.0 | Lal-lo | planned | Tech-stack packs and deployment platform packs. |
| v1.7.0 | Lasam | planned | Learning from your own data, model watch, regression fixtures and the measurement tools behind them. |
| v1.8.0 | Piat | planned | A verified compatibility matrix for more editors. |
| v1.9.0 | Sta. Ana | planned | Enterprise platform packs. |
| v1.10.0 | Tuguegarao | planned | Parked work and ideas that are not scheduled. |
<!-- releases:end -->

## Security

To report a vulnerability, or to see how releases are built, read [SECURITY.md](SECURITY.md).

## Develop

```bash
npm run verify       # lint + manifest check + every test + the test inventory (Node 20 or newer, no dependencies)
npm run verify:fast  # lint + manifest check + the files in tests/fast-list.json (the regression pack and the fast core); for use between fixes
npm run manifest     # regenerate library.json after changing an item
```

- **The test inventory** (`tests/inventory.txt`) lists test names and whether each runs or is skipped, with one status per platform for a test that runs on only Linux or only Windows (CI runs on Linux). It catches a test that vanishes or is newly skipped in a full `npm run verify`; it does not look inside a test, and `verify:fast` does not check it. A hand-edited `tests/inventory.txt` that still has valid lines is not caught by `--write` (the git diff is the trace), and the workflow-file test is a tripwire, not a proof: it does not look at `shell:`, `env:` or trigger filters such as branches or paths. See the Speed page of the wiki for more limits.
- **Each skill** needs `name` (the folder name), `description` (max 1024 characters), `license: MIT` and a `metadata` block (`title`, `tags`, `featured`, `order`, `version`). Quote any description that contains `: ` or double quotes.
- **The lint** also scans every file for emails, phone numbers, keys, machine paths and any term listed in a local `scripts/denylist.local.txt` (git-ignored).
- **What's new** at the top is written from the plugin CHANGELOG: `node scripts/whats-new.mjs --write`.
- **Releases:** push a tag like `v1.0.1`. The release workflow verifies the repo, zips every item and attaches the zips and `library.json`.

## License

MIT licensed. Made by [trbbmnglg](https://github.com/trbbmnglg).
