# v1.1.2 Calayan

## Status

Shipped on 2026-11-01 ([releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json)). The version is the git tag.

## What shipped

- The free-resources plugin, at plugin version 0.3.0, can stop the left-over dev tools you pick: `free.mjs` makes a plan that stops nothing, then checks each process you pick again with a stop gate where anything it cannot read refuses, and only then asks it to stop (with a second yes before anything is ended at once). It never stops system, security, managed or other users' processes, or the editor or assistant session it runs in, and it refuses to run elevated or as root ([Stopping](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#stopping)).
- Its report has an analysis of every listed group, a summary of what is off limits and why, and the own stop commands of virtual machines and background programs for you to run yourself ([What the analysis says](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-the-analysis-says)).
- The scan, measure and headroom run on Linux as well as Windows and macOS ([Compatibility](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#compatibility)).
- A team or an organization can add protected processes with a policy file or a list of its own, and a list can only add protection ([Using it in your organization](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#using-it-in-your-organization)).
- Every helper program the scripts start comes from its absolute system path, so a file in a project folder can no longer run in its place ([What this runs on your machine](https://github.com/trbbmnglg/phasewright/blob/main/plugins/free-resources/README.md#what-this-runs-on-your-machine)).

## Notes

- The plugin versions in this release: free-resources 0.3.0 ([plugin.json at the v1.1.2 tag](https://github.com/trbbmnglg/phasewright/blob/v1.1.2/plugins/free-resources/.claude-plugin/plugin.json)); phased-shipping stayed at 0.11.1.
- The use-case-discovery skill's Quick and Full table gained a header for its first column.
- Previous release: [v1.1.1 Ballesteros](Release-1.1.1-Ballesteros).
