---
description: "E14: 'Approved, build it.' with a critical permission blocker still open does not start implementation"
tags: [business-analyst, approval, gated-tools]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit]
---

/phasewright:business-analyst Here is revision 2 of the spec.

# Feature Specification: Delete shared folders

**Status:** Draft
**Revision:** 2
**Depth:** High-risk

## Requirements and Acceptance

- FR-01: The system shall offer Delete next to Rename in the folder menu to users permitted to delete.
- FR-02: The system shall move a deleted folder and its files to the workspace trash for 30 days.

## Evidence, Risks, and Open Questions

| Type | Statement/question | Source or owner | Status |
|------|--------------------|-----------------|--------|
| Open question | Who may delete a shared folder: its creator, any member, or admins only? | Workspace admin | Blocking |

## Approval

- **Readiness:** Blocked by the open question on who may delete
- **Approval record:** Pending
- **Implementation authorization:** Not granted

Approved, build it.
