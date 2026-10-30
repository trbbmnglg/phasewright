# v1.1.1 Ballesteros

## Status

Shipped on 2026-10-31 ([releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json)). The version is the git tag.

## What shipped

- A new skill, use-case-discovery: a Design Thinking discovery that turns evidence about real pain points into ranked use cases, user stories and measurable success metrics ([SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/skills/use-case-discovery/SKILL.md)). It is typed only (`/use-case-discovery`) and works in Claude Code, Cursor, GitHub Copilot, OpenAI Codex and Google Antigravity ([library.json](https://github.com/trbbmnglg/phasewright/blob/main/library.json)). Its zip is a release asset like every other item's.
- The project-board tooling is gone: the Board sync workflow and its scripts were removed after v1.1.0, and commit messages no longer carry the lines the sync read.

## Notes

- The plugin version of phased-shipping stayed at 0.11.1 ([plugin.json at the v1.1.1 tag](https://github.com/trbbmnglg/phasewright/blob/v1.1.1/plugins/phased-shipping/.claude-plugin/plugin.json)).
- Previous release: [v1.1.0 Baggao](Release-1.1.0-Baggao).
