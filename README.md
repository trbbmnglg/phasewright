# Phasewright

Formerly `phasewright`. The Claude Code marketplace and plugin names are still `phasewright`, so existing installs keep working and updating, and old links to this repo redirect here.

Reusable skills, agents and plugins for AI coding assistants. Each one is a plain Markdown file or folder you can read, copy and adapt. They work in Claude Code, VS Code (GitHub Copilot) and Cursor, and in any other tool that reads skills from a folder.

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

**Plugins** (`plugins/`): [`phased-shipping`](plugins/phased-shipping/README.md) plans work as small phases with one deploy each, and picks the model and effort for every kind of task.

`library.json` is generated from these files and lists every item with its install steps per tool.

## Install

### Claude Code

```bash
claude plugin marketplace add trbbmnglg/phasewright
claude plugin install phasewright@phasewright       # all skills and agents
claude plugin install phased-shipping@phasewright     # the phased-shipping plugin
```

Or copy a skill folder into `.claude/skills/` (project) or `~/.claude/skills/` (personal), and an agent file into `.claude/agents/` or `~/.claude/agents/`.

The phased-shipping plugin needs Claude Code v2.1.292 or later, because it sets effort per call; older versions run subagents at their file's effort.

### VS Code with GitHub Copilot

Copy a skill folder into `.github/skills/`, `.claude/skills/` or `.agents/skills/` in your project, or into `~/.copilot/skills/` for all projects. VS Code also reads Claude-format agents from `.claude/agents/`, so the agent files work there unchanged.

### Cursor

Copy a skill folder into `.cursor/skills/` or `.agents/skills/` (project), or `~/.cursor/skills/` (personal). Cursor has no documented custom-agent file format, so use the matching skill instead of an agent.

### Other tools

Copy a skill folder into your tool's skills folder, or `.agents/skills/` if it follows the shared convention.

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

## Develop

```bash
npm run verify     # lint + manifest check + tests (Node 20 or newer, no dependencies)
npm run manifest   # regenerate library.json after changing an item
```

- **Each skill** needs `name` (the folder name), `description` (max 1024 characters), `license: MIT` and a `metadata` block (`title`, `tags`, `featured`, `order`, `version`). Quote any description that contains `: ` or double quotes.
- **The lint** also scans every file for emails, phone numbers, keys, machine paths and any term listed in a local `scripts/denylist.local.txt` (git-ignored).
- **Releases:** push a tag like `v1.0.1`. The release workflow verifies the repo, zips every item and attaches the zips and `library.json`.
