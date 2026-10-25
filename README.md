# Phasewright

Reusable skills, agents and plugins for AI coding assistants. Each one is a plain Markdown file or folder you can read, copy and adapt. They work in Claude Code, VS Code (GitHub Copilot) and Cursor, and in other tools that load skills from `SKILL.md` folders.

MIT licensed. Made by [trbbmnglg](https://github.com/trbbmnglg).

## What's inside

**Skills** (`skills/`), each a folder with a `SKILL.md`:

| Skill | What it does |
|---|---|
| `prompt-engineering` | 24 prompt techniques, an 8-part anatomy, a robustness checklist and a maturity rubric |
| `planner` | Multi-perspective implementation plans: business analysis, architecture, QA, security, definition of done |
| `docs-generator` | Flowcharts, design docs, API docs, ERDs, changelogs and release notes |
| `business-analyst` | A requirements interview that ends in a formal feature spec |
| `refactoring` | A file-size limit and patterns for extracting hooks, modals, tabs and constants |
| `error-handling` | API response shapes, validation, database errors and loading and empty states |
| `performance` | Render, fetch and query patterns for web apps |
| `commits` | Conventional Commits types, scopes and splitting rules |

**Agents** (`agents/claude/`), each a single Markdown file: `debugger`, `prompt-engineer`, `docs-writer`.

**Plugins** (`plugins/`):
- [`phased-shipping`](plugins/phased-shipping/README.md) plans work as small phases with one deploy each, and picks the model and effort for every kind of task.
- [`free-resources`](plugins/free-resources/README.md) reports how pressured your machine is, which processes use the most, and what a task really needs. It never closes anything.

`library.json` is generated from these files and lists every item with its install steps per tool.

## Install

### Claude Code

```bash
claude plugin marketplace add trbbmnglg/phasewright
claude plugin install phasewright@phasewright       # all skills and agents
claude plugin install phased-shipping@phasewright     # the phased-shipping plugin
claude plugin install free-resources@phasewright      # the free-resources plugin
```

Or copy a skill folder into `.claude/skills/` (project) or `~/.claude/skills/` (personal), and an agent file into `.claude/agents/` or `~/.claude/agents/`.

The phased-shipping plugin needs Claude Code v2.1.292 or later, because it sets effort per call; older versions run subagents at their file's effort.

### VS Code with GitHub Copilot

Copy a skill folder into `.github/skills/`, `.claude/skills/` or `.agents/skills/` in your project, or into `~/.copilot/skills/` for all projects. VS Code also reads Claude-format agents from `.claude/agents/`, so the agent files work there unchanged.

### Cursor

Copy a skill folder into `.cursor/skills/` or `.agents/skills/` (project), or `~/.cursor/skills/` (personal). Cursor has no documented custom-agent file format, so use the matching skill instead of an agent.

### Other tools

Copy a skill folder into your tool's skills folder.

### Download a single item

Every release attaches one zip per item (`skill-planner.zip`, `agent-debugger.zip`, ...). Each zip holds the item in its own folder: unzip it into your skills or agents folder.

## Compatibility

| | Skills | Agents | Plugins |
|---|---|---|---|
| Claude Code | full | full | full |
| VS Code Copilot | full | full (reads `.claude/agents`) | skills only |
| Cursor | full | none | skills only |

Two caveats:
- The Cursor marketplace files (`.cursor-plugin/`) follow Cursor's published layout, but they haven't been tested end to end. Copying skill folders is the supported path.
- Settings such as `model:` and `disable-model-invocation:` are Claude Code and Copilot features. Tools that don't know them ignore them.

## Releases

Releases are numbered by version and named. The version is the git tag.

<!-- releases:start -->
| Release | Name | Status | What it is |
|---|---|---|---|
| v1.0.0 | Allacapan | shipped | First public release: skills, agents and the phased-shipping plugin. |
| v1.0.1 | Aparri | shipped | Fixes item summaries that were cut off mid-word. |
| v1.1.0 | Baggao | in progress | Trust and guardrails, the free-resources plugin, a local dashboard, the README, the footprint budget and supply-chain signals. |
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

## Develop

```bash
npm run verify     # lint + manifest check + tests (Node 20 or newer, no dependencies)
npm run manifest   # regenerate library.json after changing an item
```

- **Each skill** needs `name` (the folder name), `description` (max 1024 characters), `license: MIT` and a `metadata` block (`title`, `tags`, `featured`, `order`, `version`). Quote any description that contains `: ` or double quotes.
- **The lint** also scans every file for emails, phone numbers, keys, machine paths and any term listed in a local `scripts/denylist.local.txt` (git-ignored).
- **Releases:** push a tag like `v1.0.1`. The release workflow verifies the repo, zips every item and attaches the zips and `library.json`.
