# Security policy

## What it is

The project's policy for reporting a vulnerability, what is in scope, and what to expect. It covers the skills and agents and the two Claude Code plugins, `phased-shipping` and `free-resources`, whose scripts and hook run on your own machine. The full text is [SECURITY.md](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md); this page does not repeat it.

## How to use it

Do not put the details of a vulnerability in a public issue, pull request or discussion. Report it privately through the repository's [Report a vulnerability](https://github.com/trbbmnglg/phasewright/security/advisories/new) form. If that form is not available to you, the policy says how to ask for a private contact without an email address ([Report a vulnerability](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md#report-a-vulnerability)). Use made-up data, never real secrets or the contents of anyone's files ([What to include](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md#what-to-include)).

## What shipped when

- The policy was added during [v1.1.0](Release-1.1.0-Baggao), which shipped on 2026-10-30.
- A test keeps its headings and its promises in step with what one maintainer can keep: [security-policy.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/security-policy.test.mjs).
- It also says how releases are built: a version tag starts a workflow that runs the lint, the manifest check and the tests, zips each item and attaches the zips and `library.json`. Its actions are pinned to full commit SHAs ([How releases are built](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md#how-releases-are-built), [release.yml](https://github.com/trbbmnglg/phasewright/blob/main/.github/workflows/release.yml)).

## Limits

- One person maintains the project, so every time in the policy is a best-effort target, not a guarantee ([SECURITY.md](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md)).
- Security fixes go to the latest release and the `main` branch only; older releases are not patched ([Supported versions](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md#supported-versions)).
- Limits the READMEs already document are out of scope, such as scripts an agent writes and then runs. The guard is an extra layer, not a sandbox ([Out of scope](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md#out-of-scope)). See [The guard](The-guard).
- Releases are not signed and have no build provenance attestation yet ([How releases are built](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md#how-releases-are-built)).

## Source

- [SECURITY.md](https://github.com/trbbmnglg/phasewright/blob/main/SECURITY.md)
- [tests/security-policy.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/security-policy.test.mjs)
- [.github/workflows/release.yml](https://github.com/trbbmnglg/phasewright/blob/main/.github/workflows/release.yml)
