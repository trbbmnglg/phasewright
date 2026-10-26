# Security policy

Phasewright is a library of Markdown skills and agents, plus two Claude Code plugins (`phased-shipping` and `free-resources`) whose Node.js scripts and hook run on your own machine. This page says how to report a vulnerability in any of them and what you can expect. One person maintains this project, so every time below is a best-effort target, not a guarantee.

## Report a vulnerability

Please don't put the details in a public issue, pull request or discussion.

- **Preferred:** report it privately on GitHub: [Report a vulnerability](https://github.com/trbbmnglg/phasewright/security/advisories/new) (or open the repository's Security and quality tab and choose "Report a vulnerability"). Only you and the repository's maintainers can see the report.
- **If that form isn't available to you:** [open an issue](https://github.com/trbbmnglg/phasewright/issues/new) titled "Security contact request" and write nothing else. The maintainer will open a private draft security advisory, add you to it and continue there. You don't need an email address.

## What to include

- the item and its version or commit (`library.json` lists the items; each plugin's version is in its `plugin.json`)
- your operating system, shell and Claude Code version, when they matter
- the steps to reproduce, ideally the hook payload or command that shows the problem
- what an attacker gains, and what they must already control
- whether you want credit, and under which name

Use made-up data. Never send real secrets, tokens or the contents of anyone's files.

## In scope

- **The phased-shipping guard** (`plugins/phased-shipping/hooks/`): a way for one of its four agents to run a command or write a file the guard should deny, beyond the limits its README lists.
- **Silent fail-open:** a hook or script that allows a call it should deny, or fails open in a case the README doesn't document.
- **The approval check** (`commands-hash.mjs` and the run skill): a way to run commands other than the ones shown at the preview, beyond the documented limits.
- **Scripts that run on your machine:** the phased-shipping and free-resources scripts and `scripts/sync-personal.mjs`, for example command injection, writing outside the paths their README lists, or ending a process.
- **Leaks:** anything here that could expose the contents of your files, your environment or your secrets, through output, reports, the phase history, `peaks.jsonl` or the network.
- **Supply chain:** the workflows in `.github/workflows/`, the release zips, `library.json`, and the plugin and marketplace manifests.
- **Skill and agent text** that on its own steers an assistant into an unsafe action, such as hidden instructions.

## Out of scope

- Limits the READMEs already document, such as program names built from variables, scripts an agent writes and then runs, and interpreters that run text (`node -e`, `python -`). The guard is an extra layer, not a sandbox.
- A hook that an organization policy switches off, or that fails open because `node` is missing or the hook timed out in the plugin install, as documented.
- Vulnerabilities in other tools, including Claude Code, GitHub, Node.js and the operating system. Please report those to their owners.
- Slowness or heavy local resource use by the free-resources scan or measure.
- Social engineering, attacks that need an already compromised machine, and reports with no security impact.

## Supported versions

Security fixes go to the latest release and the `main` branch only. A fix lands on `main` and ships in the next release; older releases are not patched. Update to the latest release, or update the plugin, to get a fix.

## What to expect

- **Acknowledgement:** best effort within 14 days.
- **Assessment:** whether the report is accepted and a rough plan, best effort within 45 days, with an update whenever something changes.
- **Coordinated disclosure:** the target is a fix and a published GitHub security advisory within 90 days of the report, sooner when the fix is ready. We can agree on another date. If you hear nothing for 90 days, you may disclose.
- **Credit:** in the advisory and the release notes, under the name you choose, or none if you prefer.
- **CVE:** requested through GitHub when the vulnerability qualifies.

A declined report gets a short reason.

## Safe harbour

If you research in good faith, on your own machine and your own copies, and follow this policy, the maintainer will not take or support legal action against you; this covers this project only, not GitHub or anyone else.

## How releases are built

Pushing a version tag starts a GitHub Actions workflow that runs the lint, the manifest check and the tests on Node.js 22, zips each item, and attaches the zips and `library.json` to the release. Its actions are pinned to full commit SHAs, its one job gets only the token permission it needs (`contents: write`, to publish the release), and the library has no npm dependencies. Releases are not signed and have no build provenance attestation yet.
