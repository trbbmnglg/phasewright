# Feature Specification Templates

Select the template matching the depth chosen in [SKILL.md](../SKILL.md).
Replace placeholders; do not fill unknowns with plausible inventions.
Omit irrelevant conditional sections rather than adding empty ceremony.
Each template sits in a fence so its headings stay separate from this file's;
copy the content inside the fence, not the fence itself.

## Lean Template

````markdown
# Feature Specification: {Feature Name}

**Status:** Draft | Awaiting Approval | Approved | Superseded
**Revision:** {revision}
**Depth:** Lean

## Outcome and Scope

- **Story:** As a {role}, I want {capability} so that {outcome}.
- **Problem and user:** ...
- **Intended outcome:** ...
- **Included:** ...
- **Excluded:** ...

## Requirements and Acceptance

- FR-01: The system shall {observable behavior}.

```gherkin
Scenario: AC-01 {observable behavior}
  Given {relevant initial state}
  When {one meaningful action or event}
  Then {observable expected result}
```

Add applicable failure, permission, boundary, or recovery scenarios.
Keep each scenario to about 3–5 steps.

## Material Risks and Questions

Include only material risks, assumptions, decisions, and questions.
Use the compact register from SKILL.md when useful.

Identify blockers and their owner, or owner TBD.
If none were identified, say so without claiming exhaustive assurance.

## Approval

- **Readiness:** Ready for approval | Blocked by {questions}
- **Approval record:** Pending, or {approver, revision, decision, conditions}
- **Implementation authorization:** Not granted | Explicitly granted

Approval requires clear scope, testable acceptance, acknowledged material
risks, and resolved blockers.
````

## Standard and High-risk Template

````markdown
# Feature Specification: {Feature Name}

**Status:** Draft | Awaiting Approval | Approved | Superseded
**Revision:** {revision}
**Depth:** Standard | High-risk
**Business owner:** {name or TBD}
**Approver:** {name or TBD}
**Techniques used:** {actually performed}
**Evidence limitations:** {limitations or none identified}

## Decision Summary

Briefly state the intended outcome, recommended release scope, principal
trade-off, and blockers. Do not repeat this summary after the specification.

## Problem, Users, and Outcomes

Describe the current problem, affected roles, supporting evidence, and
desired future state.

| Outcome | Baseline | Target | Measurement | Owner |
|---------|----------|--------|-------------|-------|
| ... | Known or TBD | Agreed or TBD | ... | ... |

Explain how metrics relate to business value.
Do not invent targets or assume usage alone demonstrates success.

## Scope and Priorities

Include a simpler or no-build alternative when meaningful.

| Priority | Outcomes or requirement IDs | Rationale |
|----------|-----------------------------|-----------|
| Must | ... | Initial outcome fails without these |
| Should | ... | Valuable; workable fallback exists |
| Could | ... | Optional within available capacity |
| Won't this release | ... | Explicitly excluded |

Record capacity as confirmed, estimated, or unknown.
When capacity is estimated, keep Must-haves to about 60% of the effort so
Should and Could items leave contingency.

## Stories, Requirements, and Acceptance

### {Story Title}

**As a** {role}
**I want** {capability}
**So that** {outcome}

- FR-01: The system shall {observable behavior}.

```gherkin
Scenario: AC-01 {observable behavior}
  Given {relevant initial state}
  When {one meaningful action or event}
  Then {observable expected result}
```

Cover applicable negative, permission, boundary, retry, concurrency,
and recovery behavior. Use concrete values when they clarify a rule.
Keep each scenario to about 3–5 steps.

Scenarios are acceptance definitions, not proof of automated or passing tests.

## Flows and Dependencies

Describe the main sequence, relevant alternate flows, and dependency
owners/readiness. Identify consequences of dependency unavailability.

Add a Mermaid diagram only when it improves understanding.
Avoid repeating identical content in prose, tables, and diagrams.

## Quality Requirements

| Requirement | Measure/threshold | Conditions | Verification |
|-------------|-------------------|------------|--------------|
| ... | Agreed or TBD | ... | ... |

Include applicable accessibility, performance, reliability, security,
privacy, and operational requirements.

## Evidence, Risks, and Open Questions

Include the compact register from SKILL.md.

| Risk | Impact | Mitigation/validation | Owner |
|------|--------|-----------------------|-------|
| ... | ... | ... | Named owner or TBD |

Identify each blocking question and the consequence if unresolved.

## Conditional Technical and Operational Details

Include only relevant subsections:

- **UI:** placement, interactions, feedback, accessibility, localization.
- **Data:** entities, source of truth, ownership, validation, retention,
  deletion, and proposed model changes.
- **Integrations:** contracts, permissions, errors, compatibility, retries,
  and reconciliation.
- **Transition/operations:** migration, rollout, monitoring, support,
  rollback, and recovery verification.

For High-risk, explicitly address applicable permissions, data lifecycle,
recovery, transition, audit, and operational validation. Explain exclusions
that could otherwise look like missing risk analysis.

Label unconfirmed technical details as proposals.

## Validation and Approval

| Requirement | Acceptance scenario | Planned verification |
|-------------|---------------------|----------------------|
| FR-01 | AC-01 | Manual or automated plan |

Use test paths only when verified.
Do not claim tests exist or pass without evidence.

### Ready for Approval

- [ ] Problem, users, outcome, and scope are clear.
- [ ] Must-have requirements have testable acceptance coverage.
- [ ] Applicable quality requirements are measurable.
- [ ] Material dependencies and risks are acknowledged.
- [ ] Blocking questions are resolved.

### Delivery Acceptance

- [ ] Must-have scenarios and applicable quality checks are verified.
- [ ] Relevant regression, transition, and recovery checks pass.
- [ ] Required documentation and support changes are complete.
- [ ] Agreed success measurement is available.
- [ ] Remaining limitations are recorded and accepted.

**Approval record:** {approver, revision, decision, date if known, conditions}
**Implementation authorization:** Not granted | Explicitly granted
````

## Examples

**Requirements**

- Avoid: "The search should be fast." It has no measure, threshold, or
  conditions, so nobody can test it.
- Avoid: "FR-04: Users can filter and export results and get an email." It
  bundles three behaviors; split it into one requirement each.
- Prefer: "FR-03: The search page shall show the first results within 2 s at
  the 95th percentile for a catalog of 10,000 items." Use this only when the
  owner agreed those numbers.
- Prefer when the threshold is not agreed: "FR-03: The search page shall show
  the first results within {TBD} at the {TBD} percentile. Open question:
  target and catalog size, owner: product lead."

**Scenarios**

- Avoid: "Then a row is inserted in the notifications table." It describes
  the implementation, not what a user can observe.
- Prefer:

```gherkin
Scenario: AC-02 Owner is told when a watched record changes
  Given Ana watches invoice INV-104
  When Ben changes the invoice due date
  Then Ana sees a notification naming INV-104 and the new due date
```
