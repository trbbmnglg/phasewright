# Speed

## What it is

A set of defaults in the phased-shipping plugin that make a run faster without lowering any check. The plugin cannot make your project's own test suite faster. It runs that suite fewer times and in a better order ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#speed)).

- **Two verify sets.** A plan names a Full verify set (everything the project has) and a Fast verify set (lint, typecheck, the tests for the area the phase changes and the project's regression pack). It may also name parallel groups of full-verify commands that write no shared files.
- **Fast between rounds, full once at the end.** The fast set runs after the build and after each fix round. The full set runs once on the final tree, right before the preview.
- **The preview needs a full run.** It is never shown on a fast result alone, and its gates table always has a Full verify row with the tree id it ran on.
- **A reusable baseline, from green runs only.** A script gives the working tree an id and keeps a short list of green full verifies. The next phase skips its baseline only when the tree id, the full-verify commands and the Node version all match and the record is at most 7 days old. A failure that is not in a green baseline is new and blocks.
- **Security reviews with a brief.** The first review of a phase is full depth. Later reviews cover the files changed since the last reviewed tree. A very large surface is split across two reviewers. The tier and effort are never lowered.
- **The time is shown.** The preview has a "Where the time went" table, and the history record keeps the timings.

## How to use it

Nothing to turn on: it is how `run` works from version 0.11.0. When `plan` writes a phase, it asks for both verify sets and proposes them from the project survey, if there is one. You confirm each command. A plan with the older single `Baseline and verify (same commands)` line is read as full = fast, so the same commands run at every step. The other rules here (a reused baseline, the Full verify row, review depth, timings) apply to it as well, and a green fast compare on such a plan counts as a full verify. The Full verify always includes the project's browser check, if it has one.

You can ask `run` for the full set at any round. To see the tree id of your project and whether a baseline would be reused, run the script yourself ([tree-state.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/run/scripts/tree-state.mjs)):

```text
node tree-state.mjs id --root <repo>
node tree-state.mjs check --root <repo> --plan <plan file> --data <absolute data folder>
```

`stats` in the [phase history](Phase-history-and-estimates) shows the median seconds per kind, the median full runs per phase and how many baselines were reused.

## In this repository

The repository's own checks run on Node 20 or newer with no dependencies.

- `npm run verify` is the full run, and the one CI runs: lint, the manifest check, every `tests/*.test.mjs`, then the test inventory. It prints the 10 slowest tests.
- `npm run verify:fast` is lint, the manifest check and only the files named in `tests/fast-list.json`: the regression pack and the fast core files. It prints the regression pack's test count, so a reviewer can be told "the regression pack passed (N tests)". Use it between fix rounds. It never replaces the full run before a release.
- `tests/inventory.txt` lists every test by name and status. The full run fails when a listed test is missing, a test is newly skipped, the count drops, or a test is not listed yet. After you add or rename a test, run `node scripts/test-inventory.mjs --write` (it runs every test file once) and read the diff. `--write` refuses to write over a test that is missing or newly skipped, or a lower count, and it refuses a run that failed, ended by a signal or found no tests. `--write --allow-removals` is for a test removed on purpose: it prints the removals and then writes. It also refuses when there is no inventory to compare with (the file is missing, empty or holds only comments), because then a lost test could not be seen; the first inventory is written with `--allow-removals`.
- A test that runs on only some platforms (a Windows-only live test, a test that needs `jq`) has one status per platform, such as `linux:skip,win32:run`, and each platform checks its own: CI checks the Linux status, a Windows machine the Windows one. `--write` changes only the status of the platform it runs on, so the other platform's status of a new platform-dependent test is written by hand, and the git diff shows it.
- What the inventory does not catch:
  - It records names only. A test whose body was emptied still passes and keeps its line.
  - A test inside a `describe.skip` block is not reported by the runner, so a new one is neither listed nor counted as skipped.
  - A failing `todo` test does not fail the run.
  - `npm run verify:fast` cannot see a test that vanished from a file it runs. Only the full verify's inventory check does.
  - A hand-edited `tests/inventory.txt` that still has valid lines is not caught by `--write`: the git diff is the trace, so read it.
  - The workflow-file test (the gating check) is a tripwire, not a proof. It does not look at `shell:`, `env:` or trigger filters such as branches or paths.
  - There is no timeout per test, so a test that hangs hangs `npm run verify`. Stop it by hand and fix the test.
  - Statuses are recorded for Linux and Windows only. On another platform, such as macOS, the inventory check fails while any test has a status per platform, and `--write` refuses.

## What shipped when

- Plugin version 0.11.0 added the two verify sets, parallel groups, the tree-state script, baseline reuse, the review brief, the timings table and the new history fields ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)). No guard rule changed. The shipper's turn limit went from 20 to 40.
- This is part of [v1.1.0](Release-1.1.0-Baggao), which is in progress.
- Tests: [tree-state.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/tree-state.test.mjs), [tree-state-process.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/tree-state-process.test.mjs) and [history.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/history.test.mjs).

## Limits

- It cannot make a project's own suite faster. A slow suite stays slow each time it runs.
- A weak fast set is still caught by the final full compare and by CI, at the cost of a late fix round. Choose the fast set to find most failures early.
- The tree-state script writes git blob and tree objects into the repository's object store. No branch or tag points at them, and they stay until `git gc` removes them. It never changes your index, HEAD, refs or working files.
- The script runs git with every hook switched off, but a filter driver set in the repository's own configuration still runs, as it does with `git add`. Every tree id re-reads and re-filters every file (nothing is cached), so on a large repository it takes as long as `git add -A` on a fresh index. The temporary index folder is removed on every path except when the process is killed.
- It refuses a tree that holds a submodule or a nested repository, and a temp folder inside the repository.
- The tree id does not change for an edit to a git-ignored file, for `node_modules`, for the contents of a submodule, or for a change of line endings alone when the repository converts them. After any such change, or when unsure, the final full verify is never skipped.
- A reused baseline also cannot see a change that the tree does not show, such as a global tool or an operating system update. That can only appear as a new failure in a later compare, which blocks.
- Two runs that record at the same moment can lose one record, which only means one less reuse. A record file that exists but cannot be read is never overwritten.
- The records are tree ids and hashes only, in `verify-records.json` in the plugin's data folder. They hold no command text and no file content.
- The skill evals for these rules have not been run against a model yet.

## Source

- [plugins/phased-shipping/skills/run/SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/run/SKILL.md)
- [plugins/phased-shipping/skills/run/scripts/tree-state.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/run/scripts/tree-state.mjs)
- [plugins/phased-shipping/skills/run/references/review-brief.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/run/references/review-brief.md)
- [plugins/phased-shipping/README.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md)
- [plugins/phased-shipping/CHANGELOG.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)
