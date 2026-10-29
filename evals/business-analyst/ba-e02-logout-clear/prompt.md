---
description: "E02: a clear change with established conventions gets no requirements interview"
tags: [business-analyst, selection]
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---

Add a logout button to the user menu. We already have `logout()` in `src/auth/session.ts`, which clears the session and redirects to `/login`, and the user menu in `src/components/UserMenu.tsx` lists Profile and Settings as plain menu items. Put Log out last, styled like the others.
