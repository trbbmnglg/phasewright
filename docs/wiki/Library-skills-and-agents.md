# Library skills and agents

## What it is

Plain Markdown skills and agents you can read, copy and adapt ([README](https://github.com/trbbmnglg/phasewright/blob/main/README.md#whats-inside)). Each skill is a folder containing a `SKILL.md` ([skills](https://github.com/trbbmnglg/phasewright/tree/main/skills)); each agent is a single Markdown file ([agents/claude](https://github.com/trbbmnglg/phasewright/tree/main/agents/claude)).

| Skill | What it does |
|---|---|
| `prompt-engineering` | Prompt techniques, an 8-part anatomy, a robustness checklist and a maturity rubric ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/prompt-engineering/SKILL.md)) |
| `planner` | Multi-perspective implementation plans: business analysis, architecture, QA, security, definition of done ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/planner/SKILL.md)) |
| `docs-generator` | Flowcharts, design docs, API docs, ERDs, changelogs and release notes ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/docs-generator/SKILL.md)) |
| `business-analyst` | Clarifies requirements and writes a testable feature spec, sized to the risk (Lean, Standard or High-risk) ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/business-analyst/SKILL.md)) |
| `refactoring` | Risk-based refactoring: classify each change, keep behavior the same and prove it; 300 lines starts a review, not a forced split ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/refactoring/SKILL.md)) |
| `error-handling` | API response shapes, validation, database errors and loading and empty states ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/error-handling/SKILL.md)) |
| `performance` | Render, fetch and query patterns for web apps ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/performance/SKILL.md)) |
| `commits` | Conventional Commits types, scopes and splitting rules ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/commits/SKILL.md)) |
| `use-case-discovery` | Design Thinking discovery: evidence to pain points, ranked use cases, user stories and metrics, with Jira and Azure DevOps import files ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/use-case-discovery/SKILL.md)) |

| Agent | File |
|---|---|
| `debugger` | [debugger.md](https://github.com/trbbmnglg/phasewright/blob/main/agents/claude/debugger.md) |
| `prompt-engineer` | [prompt-engineer.md](https://github.com/trbbmnglg/phasewright/blob/main/agents/claude/prompt-engineer.md) |
| `docs-writer` | [docs-writer.md](https://github.com/trbbmnglg/phasewright/blob/main/agents/claude/docs-writer.md) |

[library.json](https://github.com/trbbmnglg/phasewright/blob/main/library.json) is generated from these files and lists every item with its install steps per tool ([build-manifest.mjs](https://github.com/trbbmnglg/phasewright/blob/main/scripts/build-manifest.mjs)). The two plugins are on their own pages: [Phased shipping](Phased-shipping) and [Free resources](Free-resources).

## How to use it

In Claude Code ([Install in your tool](https://github.com/trbbmnglg/phasewright/blob/main/README.md#install-in-your-tool)):

```bash
claude plugin marketplace add trbbmnglg/phasewright
claude plugin install phasewright@phasewright
```

Or copy a skill folder into `.claude/skills/` (project) or `~/.claude/skills/` (personal), and an agent file into `.claude/agents/` or `~/.claude/agents/`. For VS Code with GitHub Copilot and for Cursor, copy a skill folder into the folder your tool reads; the README lists the paths. Every release attaches one zip per item ([Download a single item](https://github.com/trbbmnglg/phasewright/blob/main/README.md#download-a-single-item)).

## What shipped when

- [v1.0.0 Allacapan](Release-1.0.0-Allacapan), 2026-10-22: the skills and agents above, and the catalogue.
- [v1.0.1 Aparri](Release-1.0.1-Aparri), 2026-10-23: fixes item summaries that were cut off mid-word ([releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json)).

## Limits

- Cursor has no documented custom-agent file format, so there the agents are not used; use the matching skill ([What works where](https://github.com/trbbmnglg/phasewright/blob/main/README.md#what-works-where)).
- VS Code with GitHub Copilot and Cursor are not yet tried by the maintainer; Claude Code is, on Windows. macOS is untested.
- The Cursor marketplace files follow Cursor's published layout but are untested end to end; copying skill folders is the supported path ([cursor marketplace file](https://github.com/trbbmnglg/phasewright/blob/main/.cursor-plugin/marketplace.json)).
- Settings such as `model:` and `disable-model-invocation:` are Claude Code and Copilot features. Tools that do not know them ignore them.
- The plugins do not run in Copilot or Cursor, only the skills do ([What it will not do](https://github.com/trbbmnglg/phasewright/blob/main/README.md#what-it-will-not-do)).

## Source

- [README.md](https://github.com/trbbmnglg/phasewright/blob/main/README.md)
- [library.json](https://github.com/trbbmnglg/phasewright/blob/main/library.json)
- [skills](https://github.com/trbbmnglg/phasewright/tree/main/skills)
- [agents/claude](https://github.com/trbbmnglg/phasewright/tree/main/agents/claude)
