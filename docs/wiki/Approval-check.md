# Approval check

## What it is

A check that binds your approval to the exact commands you saw at the preview. At the preview, `run` shows the plan's deploy, prod-check and rollback commands verbatim, with a `Commands hash` of 12 hex characters, and records that hash and the text in the plugin's data folder ([How approval works](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#how-approval-works)). On `approve` and on `push`, `run` checks the plan against that record before it briefs the shipper. If a command changed in between, it stops, shows the diff and tells you to preview again.

The script is [commands-hash.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/run/scripts/commands-hash.mjs). It has no dependencies and makes no network calls. It needs `node` but, unlike the guard, does not depend on hooks, so it works where an organization policy turns hooks off. Related pages: [The guard](The-guard), [Phased shipping](Phased-shipping).

## How to use it

You do not run it yourself in normal use; the skills do ([How approval works](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#how-approval-works)):

1. `/phased-shipping:plan` records a `planned` fingerprint when it writes a phase plan, and adds a `Commands hash` line to the plan.
2. `/phased-shipping:run N` shows the commands and the hash at the preview, and records a `previewed` fingerprint. If the commands changed since planning, the preview shows the diff as a warning.
3. `/phased-shipping:run approve` (or `push`) checks the `previewed` record first. A mismatch is a hard stop.

The shipper takes the deploy, prod-check and rollback commands only from the section the check printed, so what was hashed, shown and run are the same text. The plan's commands must sit under exactly one `## Commands` heading; a plan with two headings that look like "Commands" is refused as ambiguous ([How approval works](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#how-approval-works)).

## What shipped when

- Plugin version 0.5.0 added the approval check, the two builder-only guard rules that protect the plan files and the records, and the README section ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)).
- Version 0.5.0 is part of [v1.1.0](Release-1.1.0-Baggao), which is in progress.
- Tests for the hashing and the records: [commands-hash.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/commands-hash.test.mjs).

## Limits

This protects against accidental and model-made drift. It does not protect against a malicious local process that can rewrite both the plan and the record ([How approval works](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#how-approval-works)).

- The builder can still forge a record by running the script from its own `node -e` or from a script file it writes: the guard denies the plain forms, not every way to run node.
- The builder's shell rules are best effort. They read literal paths in the common write forms, not a path built from a variable or a glob.
- A `previewed` record is not used up: an `approve` in a later session still matches an old preview of an unchanged plan. The commands are unchanged, so this is accepted.
- The `Commands hash` line in the plan file is a convenience that anyone can edit; the record in the data folder is the one that counts.
- A plan made before 0.5.0 has no planning record, and the preview says so.

## Source

- [plugins/phased-shipping/README.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md)
- [plugins/phased-shipping/CHANGELOG.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)
- [plugins/phased-shipping/skills/run/scripts/commands-hash.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/run/scripts/commands-hash.mjs)
