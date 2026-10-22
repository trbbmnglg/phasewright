---
name: planner
description: "Multi-perspective implementation planner. MANDATORY for every enhancement or new feature that touches a schema, API route, or UI page — regardless of size. Produces a full §1–16 plan covering overview, data model, backend, frontend, reuse checklist, out-of-scope, Tech Architecture (§8), QA (§9), Security (§10), execution plan (§11), E2E spec (§12), Definition of Done (§13), evidence report template (§14), and UX/UI/responsive/a11y checklist (§15). TRIGGER on: any new feature, enhancement, \"plan this\", \"go\", \"let's start\", \"build\", or any user story that will ship to production. Do NOT fire for typo fixes, copy tweaks, or single-file bug fixes touching < 3 files."
argument-hint: "[feature name or description]"
disable-model-invocation: true
license: MIT
metadata:
  title: "Implementation Planner"
  tags: "planning,architecture,qa,security"
  featured: "true"
  order: "2"
  version: "1.0.0"
---

# Skill: Planner — Multi-Perspective Implementation Plan

You are producing an implementation plan that goes beyond the BA spec. Every non-trivial feature MUST pass through this skill so nothing ships without evidence.

**Golden rules**

1. **No ExitPlanMode until §13 Definition of Done is populated** with a real evidence checklist and §14 report template is in the plan file.
2. **Every gate in §13 has a linked file** (stdout, screenshot, HTML report).
3. **Reuse before creating** — §5 of the plan MUST list pre-existing functions, primitives, tables, and helpers the implementation will reuse.
4. **Deploy workflow always in §11** — must include: pre-deploy checks → migration (if any) → API deploy → web deploy → smoke → E2E → screenshots → commit+push.
5. **Evidence required before commit** — never commit until all §13 gates have linked evidence files. Commit is the LAST step, not an intermediate step.
6. **Post-deploy test loop** — after deploying to prod, run E2E again against prod. Fix any failures → redeploy → re-test. Only push when prod tests green.
7. **Ask before anything irreversible**: get the user's explicit OK before any migration, deploy or push. Checks against production are read-only unless the user says a flow is safe to run there.
8. **BA is always §7** — User Stories + AC + data-driven constraints + scope + open questions are mandatory. Never skip even for "small" features.
9. **No hardcoding** — enum values, thresholds, labels MUST come from DB columns or config. Flag every hardcode temptation in §8 Tech Arch.
10. **Refactoring check** — before implementation, check if any file the feature touches is already > 250 lines. If yes, plan the extraction first using `/refactoring`. Include this check in §11 step 1.

---

## Phase 0 — Intake

The BA spec (from `/business-analyst`) is input. If none exists, a BA Plan agent (§7) is run as part of Phase 2 alongside Tech Arch, QA, Security.

Sections 1–6 come from exploration (overview, data model, backend, frontend, reuse checklist, out-of-scope). **§7 is always the BA perspective**. This skill produces §8–16 (Tech Arch, QA, Security, execution, E2E, DoD, report, UX/UI).

---

## Phase 1 — Exploration (parallel, ≤3 Explore agents)

Launch up to 3 `Explore` sub-agents in parallel to read the codebase:

- Agent A — existing patterns around the feature's domain (schemas, tables, auth flow)
- Agent B — existing UI primitives and page patterns to reuse
- Agent C — existing test patterns, harness, and integration-test conventions

Use the minimum number of agents. 1 agent is fine for small changes.

---

## Phase 2 — Perspective review (parallel, up to 4 Plan agents)

Launch **4** `Plan` sub-agents in parallel, one per perspective.
**BA is always required** — do not skip even for "small" features.

### Agent: Business Analyst (BA)
- User stories (AS A / I WANT / SO THAT) — min 5, one per major user action
- Acceptance criteria (Given/When/Then) — 2-3 per story
- Data-driven constraints: **no hardcoding** of enum values, amounts, thresholds, or labels — call out every hardcode temptation
- Scope table: what IS in v1 vs explicitly NOT in v1
- Success metrics (functional, not business KPIs)
- Open questions resolved (list assumptions made)

Output → §7 of plan.

### Agent: Tech Architect
- Migration strategy (additive vs rebuild) — call out any NOT-NULL-drop constraints
- Performance plan (index hits, N+1 avoidance, caching with TTL)
- Concurrency (optimistic locking, idempotent bulk writes, batch cap)
- Backwards-compat defensive checks for in-flight rows with NULL new columns
- Data-driven design: confirm no enum/category values hardcoded in routes
- Refactoring risks: flag any file approaching 300 lines; reference `/refactoring`
- Two risks the spec missed from an architecture angle

Output → §8 of plan.

### Agent: QA Engineer
- Test pyramid allocation (unit vs integration vs E2E counts)
- Concrete new test files + one-line case list mapped to story IDs
- Test data strategy (`[TEST]` prefix, afterEach cleanup, fixture snapshot + restore)
- Flaky / easy-to-miss edge cases specific to the feature
- Post-deploy smoke additions (append, not replace, existing smoke)
- Regression risks — which existing tests MUST stay green post-change
- Severity rubric (P0/P1/P2/P3 with concrete examples from this feature)

Output → §9 of plan.

### Agent: Security Reviewer
- New attack surfaces (table: Surface / Risk / Mitigation)
- Zod schema snippets for the 2 most sensitive new inputs (≤10 lines each)
- LLM / PII data-exposure — confirm where raw values are/aren't logged or sent externally
- Rate limit recommendations per new endpoint
- Cross-user isolation test (always add one — ownership filter on every DB query)
- Audit trail extensions
- Migration safety (additive? rollback path?)

Output → §10 of plan.

---

## Phase 3 — Execution plan (§11)

Stepwise, copy-pastable commands:

1. **Pre-deploy sanity** — unit, type-check, lint. Must be green.
2. **Deploy** — migration first (if schema changed), then API, then web.
3. **Unauth smoke** — every new route returns 401 without auth.
4. **Authed integration** — run API test suite.
5. **Prod manual smoke** — ≤5 flows matching the BA user stories.
6. **Adjacent regression** — navigate to neighbouring pages, verify no console errors.
7. **Green-light commit + push** — only when every check is ✅.
8. **Fix-forward loop** — if anything fails, commit per-fix (no batching).

---

## Phase 4 — E2E spec (§12)

Required for every feature that touches the UI.

### Spec files (always three)
- `tests/e2e/feat-<feature>.spec.ts` — main suite (positive + negative)
- `tests/e2e/feat-<feature>-responsive.spec.ts` — 375 / 768 / 1440 sweep
- `tests/e2e/feat-<feature>-a11y.spec.ts` — axe scan per surface

### Selector strategy
- `getByRole` / `getByLabel` first
- `data-testid` only when semantic fails. List every new testid in §12.

### REQUIRED — POSITIVE test case matrix

| ID | Story | Given | When | Then |
|---|---|---|---|---|
| `<FEAT>-P-01` | US-1 | precondition | action | observable + toast/state |

Coverage floor: every AC in §7 maps to ≥1 positive row.

### REQUIRED — NEGATIVE test case matrix (14 categories)

| Category | What to assert |
|---|---|
| Field validation — boundary | Min/max length, numeric range |
| Field validation — required | Empty submit names the missing field |
| Field validation — date logic | end<start, out-of-window |
| Cross-entity invariant | Parent shrink leaves orphan children → 409 |
| Optimistic lock / two-tab edit | Stale `If-Match` → 409, no clobber |
| Cross-user isolation | User B GET/PUT/DELETE User A's row → 404 (not 403) |
| Unauth | Direct fetch w/o cookie → 401 |
| Rate limit | Nth+1 call → specific toast naming the window |
| Prompt injection (if AI) | User text trying to exfiltrate system prompt → response stays expected shape |
| LLM hallucinated enum (if AI) | Unknown key in output → stripped silently |
| XSS — text fields | `<script>` in name/notes renders escaped |
| Unsafe URL | `javascript:` → field error, blocked submit |
| Network offline | Mutation during offline → error toast, modal stays open |
| Cascade delete | Parent delete → children 404 on next fetch |

Skip a row only with a written justification.

### REQUIRED — Responsive sweep

Per surface, for each of (375 / 768 / 1440):
1. Set viewport, login, navigate.
2. Assert primary CTA `boundingBox()` ≥ 48×48 dp.
3. Assert no horizontal scroll (`scrollWidth ≤ clientWidth`).
4. On 375: assert modals render as bottom-sheet or full-screen.
5. Capture screenshot.

### REQUIRED — Accessibility spec

Per surface:
- 0 critical, 0 serious axe violations
- `aria-label` on icon-only buttons
- `aria-live="polite"` on async result regions
- Modal focus trap (Tab 20× stays inside)

---

## Phase 5 — Definition of Done (§13)

```
- [ ] Unit tests passing. Evidence: vitest-unit-report.txt
- [ ] API integration tests passing (authed, post-deploy). Evidence: vitest-integration-report.txt
- [ ] E2E passing across 3 viewports. Evidence: playwright-report/index.html + screenshots
- [ ] Unauth smoke (every new route returns 401). Evidence: unauth-smoke.txt
- [ ] Type-check green. Evidence: type-check.txt
- [ ] Responsive screenshots at 375 / 768 / 1440 for every new/changed surface
- [ ] Accessibility: axe audit with 0 critical violations. Evidence: axe-report.html
- [ ] Prod manual smoke flows — each has a screenshot
- [ ] Regression — all prior feature-family tests still green
- [ ] Docs updated (CHANGELOG, specs, API docs)
- [ ] Migration proven on dev + prod without error
- [ ] Summary report docs/evidence/<feature>/REPORT.md written + linked from PR
```

---

## Phase 6 — Evidence report template (§14)

```markdown
# <Feature Name> — Test Execution Report
**Date**: YYYY-MM-DD · **Branch**: <branch> · **Deploy version**: <id>

## 1. Gates summary
| Gate | Result | Evidence |
|---|---|---|
| Unit | ✅ N/N | [report.txt](./report.txt) |
| ... | ... | ... |

## 2. Responsive evidence (screenshots)
Grid: surface rows × viewport columns.

## 3. Manual smoke flows
| # | Flow | Result | Screenshot |
|---|---|---|---|

## 4. Known issues
P2/P3 tracked in bugs file.

## 5. Sign-off
- Developer: <name> <ISO-date>
- QA: <name> <ISO-date>
```

---

## Phase 7 — UX / Responsive / a11y (§15)

Always include this section.

**UX**
- Every multi-step flow has a visible state at every step.
- Mutations emit success + failure toasts.
- Validation errors name the specific conflict, not a generic message.
- Destructive actions require a danger-confirm modal.

**Responsive**
- `<sm` (≤640px): modals full-screen or bottom-sheet; single-column lists.
- Every action button ≥ 48×48dp (WCAG).
- **Surface audit (NON-NEGOTIABLE):** when a new feature surfaces value on existing pages, the plan MUST list every such page and audit its responsive behavior end-to-end in §12.

**Accessibility**
- `aria-label` on every icon-only button.
- `aria-live="polite"` on regions that update after async actions.
- `aria-expanded` on collapsible cards.
- Axe audit with 0 critical violations.
- Focus trap inside modals.

### REQUIRED — §15.1 Error message catalogue

Every plan MUST list every user-facing error message it introduces:

| Surface | Trigger | Message |
|---|---|---|
| `<Form>` | `<specific condition>` | `<exact string with {placeholders}>` |
| `<Server 409>` | `<invariant violated>` | `<exact string naming the conflict>` |
| `<Network>` | offline | `Couldn't save — check your connection` |
| `<Auth>` | session expired | `Your session expired — sign in again` |

Coverage floor: every negative test case in §12 maps to a row here.

---

## Phase 8 — Exit

Call `ExitPlanMode` only after:
1. Plan file contains §1–16 complete.
2. §12 has BOTH positive AND negative matrices populated (negative covers all 14 categories or each skip is justified), PLUS responsive sweep and a11y spec.
3. §13 DoD checklist is concrete (enumerates real evidence files).
4. §14 report template is copy-paste ready.
5. §15.1 error message catalogue populated.
6. User has explicitly approved.

---

## When NOT to use this skill

- Typo fixes / copy tweaks
- Pure refactors with zero behaviour change
- Bug fixes that touch < 3 files
- Infrastructure-only changes (CI, build scripts)

For those, a one-liner plan or direct implementation is fine.
