# Onboarding

## What it is

The first run in a project. `/phased-shipping:onboard` looks at the project's setup (its commands, CI, convention docs and plan files) so planning can fit it, and then points to the right way to get a roadmap: standardize an older one, adopt existing plan files, or start fresh ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#onboarding)). Installing the plugin runs nothing; onboarding is recommended, never forced, and the plan skill offers it once and remembers a no.

Privacy comes first. The survey script lists the files it intends to read and reads nothing until you confirm. It never opens source code, `.env*`, keys, `.npmrc` and other credential files, databases, `.git`, `node_modules`, build output, lockfiles, files over 256 KB or binary files. A file whose text matches a known secret shape is skipped whole and never printed, and a last check scans the finished survey and every printed line again (it exits 1 with nothing saved if one matches). No command body is kept: a script is its name and the command that invokes it, and a workflow is job, action and secret names plus a count of run steps. The survey is saved inside the project, in `.phased-shipping/`, which has its own `.gitignore` (`*`) so git never lists it. The script is [survey.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/onboard/scripts/survey.mjs); it uses node built-ins only and makes no network calls. Related pages: [Phased shipping](Phased-shipping), [Roadmap standard](Roadmap-standard).

## How to use it

```text
/phased-shipping:onboard
```

1. It says what will happen and what is never read, then lists the files (category, relative path, size).
2. You confirm the files and remove any you do not want read. The list prints a digest; the run needs it and reads nothing if the project's files changed after the list.
3. The script reads the confirmed files, saves the survey and prints a summary of what it found.
4. It says whether the project has a roadmap table, plan files, both or neither, and you choose: standardize, adopt, both in order, or fresh. The roadmap skill writes only after its own yes.
5. It ends with a checklist: survey, roadmap, and the dashboard data (turn it on with `/phased-shipping:dashboard enable`; then open the page with `/phased-shipping:dashboard page`).

There is one mode: the script reads your files, and the assistant sees the summary it prints (script names and the commands that invoke them, CI job, action and secret names and a count of run steps, which convention docs exist, plan counts and skipped counts; no script body, no run line, no line of any file, no absolute path). The project name, workflow and job names and a package's name are text from your files, cleaned to one line of plain text and cut short, and they are in it. The skill tells the assistant to hand no project file to another agent. That summary goes to your model provider like any tool output ([What it touches](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#what-it-touches)).

## What shipped when

- Plugin version 0.8.0 added the skill, the survey script, `adopt` and two evals, `onboard-needs-consent` and `adopt-needs-yes` ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)). No guard rule changed.
- This is part of [v1.1.0](Release-1.1.0-Baggao), which shipped on 2026-10-30.
- Tests: [survey.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/survey.test.mjs).

## Limits

- The script catches known secret shapes, not every secret, and it cannot tell whether a sentence in a README or a plan file is confidential. The list you confirm is the control ([Limits](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#limits)).
- The script reads only the allowlist. The onboard skill, like any skill, runs in your assistant session, where the assistant keeps its normal tools; it is held back from reading other files by the skill's instructions, not by a lock (a skill's `allowed-tools` pre-approves tools, it does not remove any). Consent is an instruction the skill follows, backed by the digest, which proves the confirmed list is unchanged, not that you saw it. No guard rule enforces either. A team that cannot accept that should not run onboarding in an assistant session on client material.
- The `.gitignore` inside `.phased-shipping/` protects git users only. In a Perforce, Subversion, Mercurial or similar workspace, ignore the folder in that tool yourself before you run the survey.
- Endpoint-security behaviour is unverified: a script that lists and reads many files might trigger an alert on a managed laptop.
- A monorepo is one project: the survey reads the root folder's files, `docs/` and the plan folders, not each package's own manifest.
- Symbolic links, junctions and hard-linked files are skipped, even ones that point inside the project. The survey is a snapshot; run onboarding again after the project changes.
- A survey that came with a cloned repository is untrusted: the folder's `.gitignore` keeps an honest survey out of git, so a tracked `survey.json` was not made on your machine. Its commands are only proposals and nothing runs them; `show` keeps only the known fields, cleaned and capped, and says it was read from disk.
- The two evals have not been run against a model yet.

## Source

- [plugins/phased-shipping/skills/onboard/SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/onboard/SKILL.md)
- [plugins/phased-shipping/skills/onboard/scripts/survey.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/onboard/scripts/survey.mjs)
- [plugins/phased-shipping/skills/onboard/references/survey.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/onboard/references/survey.md)
- [plugins/phased-shipping/CHANGELOG.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)
