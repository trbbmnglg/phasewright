---
description: "E15: a material change after approval increments the revision and reopens approval"
tags: [business-analyst, approval]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

/phasewright:business-analyst Here is the approved revision 2 of our spec.

# Feature Specification: Copy link button

**Status:** Approved
**Revision:** 2
**Depth:** Lean

## Outcome and Scope

- **Story:** As a document viewer, I want to copy a document's link so that I can share it quickly.
- **Included:** a Copy link button on each shared document, for signed-in viewers.
- **Excluded:** link permissions and link expiry.

## Requirements and Acceptance

- FR-01: The system shall copy the document URL to the clipboard when a viewer selects Copy link.
- FR-02: The system shall show "Link copied" for 2 seconds after a successful copy.

    Scenario: AC-01 Viewer copies a link
      Given Ana can view document D-12
      When Ana selects Copy link
      Then the clipboard holds the URL of D-12
      And Ana sees "Link copied" for 2 seconds

## Material Risks and Questions

- Non-blocking: the browser can deny clipboard access; fallback text TBD (owner: requester).

## Approval

- **Readiness:** Ready for approval
- **Approval record:** Approved by the requester, revision 2, no conditions
- **Implementation authorization:** Not granted

Change: people who open a view-only share link without an account should get the Copy link button too.
