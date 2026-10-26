# v1.0.1 Aparri

## Status

Shipped on 2026-10-23 ([releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json)). The version is the git tag.

## What shipped

Fixes item summaries that were cut off mid-word ([releases.json](https://github.com/trbbmnglg/phasewright/blob/main/releases.json)). The catalogue generator now ends a long summary at a word boundary ([build-manifest.mjs](https://github.com/trbbmnglg/phasewright/blob/main/scripts/build-manifest.mjs)), and a test keeps it that way ([summary.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/summary.test.mjs)). The summaries are the ones in [library.json](https://github.com/trbbmnglg/phasewright/blob/main/library.json).

## Notes

- The plugin version of phased-shipping stayed at 0.2.0 ([plugin.json at the v1.0.1 tag](https://github.com/trbbmnglg/phasewright/blob/v1.0.1/plugins/phased-shipping/.claude-plugin/plugin.json)).
- Previous release: [v1.0.0 Allacapan](Release-1.0.0-Allacapan).
