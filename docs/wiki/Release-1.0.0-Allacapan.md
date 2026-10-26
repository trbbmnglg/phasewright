# v1.0.0 Allacapan

## Status

Shipped on 2026-10-22 ([releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json)). The version is the git tag.

## What shipped

First public release: skills, agents and the phased-shipping plugin ([releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json)).

- The skills `business-analyst`, `commits`, `docs-generator`, `error-handling`, `performance`, `planner`, `prompt-engineering` and `refactoring`, each a folder with a `SKILL.md` ([skills](https://github.com/trbbmnglg/phasewright/tree/main/skills)).
- The agents `debugger`, `docs-writer` and `prompt-engineer`, each a single Markdown file ([agents/claude](https://github.com/trbbmnglg/phasewright/tree/main/agents/claude)).
- The phased-shipping plugin, at plugin version 0.2.0 ([plugin.json at the v1.0.0 tag](https://github.com/trbbmnglg/phasewright/blob/v1.0.0/plugins/phased-shipping/.claude-plugin/plugin.json)). See [Phased shipping](Phased-shipping).
- A catalogue of the items, [library.json](https://github.com/trbbmnglg/phasewright/blob/main/library.json). See [Library skills and agents](Library-skills-and-agents).

## Notes

- Install for Claude Code: `claude plugin marketplace add trbbmnglg/phasewright`, then `claude plugin install phasewright@phasewright` for the skills and agents or `claude plugin install phased-shipping@phasewright` for the plugin ([README](https://github.com/trbbmnglg/phasewright/blob/main/README.md#claude-code)).
- The phased-shipping plugin needs Claude Code v2.1.292 or later, because it sets effort per call ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#requirements)).
- Every release attaches one zip per item and `library.json` ([README](https://github.com/trbbmnglg/phasewright/blob/main/README.md#download-a-single-item)).
