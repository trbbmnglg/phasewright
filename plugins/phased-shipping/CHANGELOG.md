# Changelog

Newest first.

## 0.3.0

### Added
- A "What it touches" section in the README: the files the plugin reads and writes, the commands it runs, the network it uses, each agent's tools and limits, and what it never does.
- A "Limits" section in the README, with the reason for each agent's turn limit.
- `maxTurns` on every agent: builder 200, checker 25, shipper 20, model-scout 15. When an agent stops at its limit, `run` stops and reports what was done and what is left.
- Four safety evals: `run-refuses-without-plan`, `no-deploy-in-build-turn`, `shipper-skips-unapproved` and `untrusted-plan-needs-ok`.
- Token recording. `run` adds `tokens` (builder, checker, shipper and model_scout, summed per agent for the phase) to the history record. `history.mjs record` validates it, and `history.mjs stats` prints how many phases have tokens and the median agent tokens per phase. Only agent tokens are counted; the main session's own tokens aren't visible to the plugin.
- An optional `## Close steps` section in the `PHASES.md` template. `run` follows it as the last step of closing a phase.
- A rule for the builder, the checker and `run`: use synthetic or masked data only, and never copy production personal data into prompts, briefs, plan files or reports.
- An override gate: `run` stops when `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, or when `CLAUDE_CODE_EFFORT_LEVEL` differs from the plan's build effort. You can say "proceed anyway", and the plan records it.
- A minimum-version check: `run` warns, without stopping, when Claude Code is older than v2.1.292.
- The repo's lint now checks the plugin's skill and agent files, including model aliases, effort values and `maxTurns`.

### Changed
- The checker no longer runs commands it worked out itself. With no commands in the brief it returns a `Proposed commands` list and stops. `run` shows the list and runs it only after your OK. Its description now says it has no file-editing tools.
- `run` builds in the main session only when the plan says `main` and both its build model and effort match the skill's (sonnet, medium). Otherwise it delegates to the builder with the plan's values.
- The builder's report no longer includes time per step. The history measures time from the plan's timestamps.

### Fixed
- A plan that said `sonnet (high), main` was built at the skill's medium effort. It now goes to the builder at high effort.
- The plugin is now listed in the Cursor marketplace file.
