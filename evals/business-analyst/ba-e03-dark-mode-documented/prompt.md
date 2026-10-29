---
description: "E03: documented theme behavior is reused; no requirements interview"
tags: [business-analyst, selection]
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---

Add a dark-mode toggle to the settings page. Our theme system is documented in `docs/theming.md`: themes are CSS variables switched by a `data-theme` attribute on `<html>`, the choice is saved in `localStorage` under `theme`, and the default follows the OS setting. Settings already has an Appearance section with a font-size control.
