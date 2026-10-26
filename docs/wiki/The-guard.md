# The guard

## What it is

An extra layer for the phased-shipping plugin: a `PreToolUse` hook that looks at every Bash, PowerShell, Write, Edit and NotebookEdit call and restricts a call only when it is made inside one of the four agents (`builder`, `checker`, `shipper` and `model-scout`). With no agent it allows at once, so your main session and every other agent are never restricted ([The guard](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#the-guard)). The hook is [guard.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/hooks/guard.mjs), its rules are in [guard-rules.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/hooks/guard-rules.mjs), and a plugin install wires it through [hooks.json](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/hooks/hooks.json).

- `git` and `gh` are allowlists by role: each agent gets the subcommands its job needs, and everything else is denied.
- The builder and checker use `git` only to read, inspect and stage, and `gh` only to read. The shipper may commit, push, revert, tag and look, but it cannot force-push, skip hooks or signing, or rewrite history.
- Publishing and deploying commands are denied for the builder and checker, and every role is refused `powershell`, `pwsh` and `cmd`.
- Inside a known agent it fails closed: input it cannot read, a missing rules file and any error all deny.
- When it denies, it names the rule and what is allowed, so the agent reports one clear reason instead of working around it.

The guard says when it is not active: every `run` starts the checker with a probe, and the preview shows whether the guard blocked it ([It says when it isn't active](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#the-guard)).

## How to use it

It needs no setup beyond installing the plugin ([Install](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#install)).

- A plugin install wires the guard through `hooks/hooks.json`.
- Personal copies made by [sync-personal.mjs](https://github.com/trbbmnglg/phasewright/blob/main/scripts/sync-personal.mjs) copy the hook scripts into your Claude home and add a `hooks:` block to each generated `ps-*` agent file. That block sets `onFailure: block`, which needs Claude Code v2.1.295 or later.
- It needs `node` on your PATH, because the hook is a node script ([Requirements](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#requirements)).
- It has its own tests, which feed sample hook payloads to the scripts: [guard.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/guard.test.mjs) and [shell-split.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/shell-split.test.mjs).

## What shipped when

- Plugin version 0.4.0 added the guard hook, the guard probe and the personal-copy install ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)).
- Version 0.5.0 added two builder-only rules that protect `PHASES.md`, the `phase-*.md` plan files and the approval records ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)). See [Approval check](Approval-check).
- Versions 0.6.0 to 0.7.1 changed no guard rule; the guard version is kept equal to the plugin version ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)).
- These are part of [v1.1.0](Release-1.1.0-Baggao), which is in progress.

## Limits

- **It is not a sandbox.** It stops direct commands. It does not stop an agent from writing a script that pushes and then running it, or from a command it cannot see inside, such as a variable that holds a program name ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#limits)).
- **It can be switched off.** An organization policy that allows only managed hooks, or `disableAllHooks`, blocks plugin hooks. The probe shows which case you are in.
- **It needs node.** If `node` is not on the PATH, the plugin's hook cannot start and Claude Code lets the call go ahead; the personal copies block instead, on v2.1.295 or later.
- **The lists are not exhaustive.** The publish and deploy lists are denylists, so a tool or flag that is not listed gets through. It is an extra layer on top of the agents' own rules and `run`'s gates.
- **It over-denies on purpose.** An unclear form is denied, and a false deny costs the agent one retry.
- **Seen firing on one setup only.** The probe was blocked, and one shipper command outside its git list was denied, in this project's own runs on Windows with Claude Code 2.1.310; other platforms and versions are unchecked ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#limits)).
- **It adds a delay to every call** in every session where the plugin is enabled, because each call starts one node process ([What it touches](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#what-it-touches)).

## Source

- [plugins/phased-shipping/README.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md)
- [plugins/phased-shipping/CHANGELOG.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)
- [plugins/phased-shipping/hooks](https://github.com/trbbmnglg/phasewright/tree/main/plugins/phased-shipping/hooks)
- [SECURITY.md](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md)
