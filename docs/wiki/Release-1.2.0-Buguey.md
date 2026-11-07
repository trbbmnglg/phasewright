# v1.2.0 Buguey

## Status

In progress. It is not released yet, and this page lists what is built so far ([releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json)). The version is the git tag.

## What shipped

Built so far (the release is in progress):

- **phased-shipping, plugin version 0.12.0** ([plugin.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/.claude-plugin/plugin.json)): one approval ships. The plan's ship block runs in one script in the main session, bound to the previewed commands and code, with one permission prompt. See [Speed](Speed#shipping) and the [CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md).
- **Library skills pass**: the [commits, error-handling, performance, planner, docs-generator and prompt-engineering skills](https://github.com/trbbmnglg/phasewright/tree/main/skills) and the docs-writer and prompt-engineer agents are corrected (contradictory status-code and commit-type advice, abort handling that cleared the wrong loading state, a nested code fence that rendered later headings as code, and claims about models and tools that had no source). The first five now end with a Limitations section and a dated Sources section; refactoring has a small wording fix. The skills carry new minor versions, and a test now checks that code fences close where they should. Evals are not part of this pass.

## Notes

- This page changes as the release is built. Release bookkeeping happens when it ships.
- Previous release: [v1.1.2 Calayan](Release-1.1.2-Calayan).
