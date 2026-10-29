---
description: "E05: a routine bug with clear expected behavior is not turned into a spec"
tags: [business-analyst, selection]
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---

Bug: on the profile form, the Save button stays disabled after I fix a validation error. Steps: 1. Clear the Name field (an error appears and Save disables). 2. Type a name again (the error clears). Expected: Save is enabled again. Actual: it stays disabled until I reload. The form is in `src/components/ProfileForm.tsx`.
