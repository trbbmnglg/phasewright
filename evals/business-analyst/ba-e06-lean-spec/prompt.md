---
description: "E06: an explicit request for one small, conventional behavior gets a Lean spec; E16: the template is read first"
tags: [business-analyst, invoked]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

/phasewright:business-analyst Write a spec for showing the last-updated date on each invoice card. You have everything you need, so draft it now: it's for the account owner (the only role that sees invoices), the date comes from the invoice's existing `updated_at` field, it uses our standard date format ("12 Oct 2026"), and it appears under the amount the same way the due date does. Nothing else changes.
