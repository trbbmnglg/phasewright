---
name: planner
description: "Multi-perspective implementation planner. Produces a full §1–15 plan covering overview, data model, backend, frontend, reuse checklist, out-of-scope, Tech Architecture (§8), QA (§9), Security (§10), execution plan (§11), E2E spec (§12), Definition of Done (§13), evidence report template (§14), and UX/UI/responsive/a11y checklist (§15). Run /planner for a new feature or enhancement that touches a schema, API route or UI page. Not for typo and copy fixes, bug fixes touching fewer than 3 files, behavior-preserving refactors, or infrastructure-only work (CI, build scripts)."
argument-hint: "[feature name or description]"
disable-model-invocation: true
license: MIT
metadata:
  title: "Implementation Planner"
  tags: "planning,architecture,qa,security"
  featured: "true"
  order: "2"
  version: "1.1.0"
---

# Skill: Planner — Multi-Perspective Implementation Plan

You are producing an implementation plan that goes beyond the BA spec. Every non-trivial feature MUST pass through this skill so nothing ships without evidence.

**Golden rules**

1. **No ExitPlanMode until §13 Definition of Done is populated** with a real evidence checklist and §14 report template is in the plan file.
2. **Every gate in §13 has a linked file** (stdout, screenshot, HTML report).
3. **Reuse before creating** — §5 of the plan MUST list pre-existing functions, primitives, tables, and helpers the implementation will reuse.
4. **Deploy workflow always in §11** — one order: size check → implement → local gates → commit → migration (if any) → API deploy → web deploy → smoke → E2E → screenshots → push.
5. **Evidence required before commit** — never commit until the local gates (unit, type-check, lint, local E2E) have linked evidence files. The post-deploy gates in §13 are filled in after deploy; push only when every §13 gate is ✅.
6. **Post-deploy test loop** — after deploying to prod, run E2E again against prod (the negative/destructive matrix only for flows the user marked safe there; otherwise run it against local or preview). Fix any failures as separate commits → redeploy → re-test. Only push when prod tests green.
7. **Ask before anything irreversible**: get the user's explicit OK before any migration, commit, deploy or push (fix-forward commits and redeploys included). Checks against production are read-only unless the user says a flow is safe to run there.
8. **BA is always §7** — User Stories + AC + data-driven constraints + scope + open questions are mandatory. Never skip even for "small" features.
9. **No hardcoding** — enum values, thresholds, labels MUST come from DB columns or config. Flag every hardcode temptation in §8 Tech Arch.
10. **Refactoring check** — before implementation, check whether any file the feature touches is already at or above 300 lines. If yes, review its responsibilities with `/refactoring` and plan an extraction only where that review finds a cohesive boundary; splitting is not required before adding a feature. This check is step 0 of §11.

---

## Phase 0 — Intake

The BA spec (from `/business-analyst`) is input. If none exists, a BA Plan agent (§7) is run as part of Phase 2 alongside Tech Arch, QA, Security.

Sections 1–6 come from exploration (overview, data model, backend, frontend, reuse checklist, out-of-scope). **§7 is always the BA perspective**. This skill produces §8–15 (Tech Arch, QA, Security, execution, E2E, DoD, report, UX/UI).

---

## Phase 1 — Exploration (parallel, ≤3 Explore agents)

Launch up to 3 `Explore` sub-agents in parallel to read the codebase:

- Agent A — existing patterns around the feature's domain (schemas, tables, auth flow)
- Agent B — existing UI primitives and page patterns to reuse
- Agent C — existing test patterns, harness, and integration-test conventions

Use the minimum number of agents. 1 agent is fine for small changes.

---

## Phase 2 — Perspective review (parallel, 4 Plan agents)

Launch **4** `Plan` sub-agents in parallel, one per perspective.
**BA is always required** — do not skip even for "small" features. If a business-analyst spec already exists, reuse it as §7 instead of running the BA agent again (then launch the other 3).

### Agent: Business Analyst (BA)
- User stories (AS A / I WANT / SO THAT) — one per major user action; if a BA spec exists, at least the stories it lists
- Acceptance criteria (Given/When/Then) — 2-3 per story
- Data-driven constraints: **no hardcoding** of enum values, amounts, thresholds, or labels — call out every hardcode temptation
- Scope table: what IS in v1 vs explicitly NOT in v1
- Success metrics (functional, not business KPIs)
- Open questions resolved (list assumptions made)

Output → §7 of plan.

### Agent: Tech Architect
- Migration strategy (additive vs rebuild) — call out any constraint change the database cannot apply in place, such as dropping NOT NULL (if applicable)
- Performance plan (index hits, N+1 avoidance, caching with TTL)
- Concurrency (optimistic locking, idempotent bulk writes, batch cap)
- Backwards-compat defensive checks for in-flight rows with NULL new columns
- Data-driven design: confirm no enum/category values hardcoded in routes
- Refactoring risks: flag any file at or above 300 lines (responsibility review, not a required split); reference `/refactoring`
- Two risks the spec missed from an architecture angle

Output → §8 of plan.

### Agent: QA Engineer
- Test pyramid allocation (unit vs integration vs E2E counts)
- Concrete new test files + one-line case list mapped to story IDs
- Test data strategy (records created by tests carry a `[TEST]` prefix, are removed in afterEach cleanup, and shared fixtures are snapshotted and restored)
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

Stepwise, copy-pastable commands. Order: implement → local gates → commit → deploy → prod checks → push. Every commit, push, deploy and migration needs the user's OK (golden rule 7).

0. **Size check (before implementation)** — for every file the feature touches, check the line count; at or above 300 lines, do the `/refactoring` responsibility review first (golden rule 10). A split is not required before adding a feature.
1. **Pre-deploy sanity** — unit, type-check, lint, local E2E. Must be green, with evidence files linked.
2. **Commit, then deploy** — with the local gates green and the user's OK: commit locally, then deploy the committed code. Migration first (if schema changed), then API, then web. Do not push yet.
3. **Unauth smoke** — every new route returns 401 without auth.
4. **Authed integration** — run API test suite.
5. **Prod manual smoke** — ≤5 flows matching the BA user stories.
6. **Adjacent regression** — navigate to neighbouring pages, verify no console errors.
7. **Green-light push** — only when every check is ✅ and the user has approved the push (golden rule 7).
8. **Fix-forward loop** — if anything fails, fix → separate commit per fix (no batching) → redeploy → re-test. Each commit, deploy and migration needs the user's OK (golden rule 7).

---

## Phase 4 — E2E spec (§12)

Required for every feature that touches the UI. API-only features: the UI rows, the responsive sweep and the a11y spec may be `n/a: <reason>`; the API rows of the matrices still apply.

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
| Optimistic lock / two-tab edit | Stale `If-Match` → 412, no clobber |
| Cross-user isolation | User B GET/PUT/DELETE User A's row → 404 (not 403) |
| Unauth | Direct request without credentials (session cookie or token, if applicable) → 401 |
| Rate limit | Nth+1 call → specific toast naming the window |
| Prompt injection (if AI) | User text trying to exfiltrate system prompt → response stays expected shape |
| LLM hallucinated enum (if AI) | Unknown key in output → stripped silently |
| XSS — text fields | `<script>` in name/notes renders escaped |
| Unsafe URL | `javascript:` → field error, blocked submit |
| Network offline | Mutation during offline → error toast, modal stays open |
| Cascade delete | Parent delete → a list endpoint returns an empty list for the children; fetching one by id returns 404 |

Skip a row only with a written justification.

Run this negative/destructive matrix against production only for flows the user marked safe to run there; otherwise run it against local or preview.

### REQUIRED — Responsive sweep

Per surface, for each of (375 / 768 / 1440):
1. Set viewport, login, navigate.
2. Assert primary CTA `boundingBox()` width and height are each ≥ 48 px. This is this skill's own target, stricter than WCAG 2.2: SC 2.5.8 (AA) asks for at least 24 by 24 CSS pixels and SC 2.5.5 (AAA) for 44 by 44.
3. Assert no horizontal scroll (`scrollWidth ≤ clientWidth`).
4. On 375: assert modals render as bottom-sheet or full-screen.
5. Capture screenshot.

### REQUIRED — Accessibility spec

Per surface:
- 0 critical, 0 serious axe violations (this skill's gate; see Limitations)
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
- [ ] Responsive screenshots at 375 / 768 / 1440 for every new/changed surface. Evidence: screenshots/responsive/<surface>-<viewport>.png
- [ ] Accessibility: axe audit with 0 critical and 0 serious violations (this skill's gate). Evidence: axe-report.html
- [ ] Prod manual smoke flows — each has a screenshot. Evidence: screenshots/prod-smoke/<flow>.png
- [ ] Regression — all prior feature-family tests still green. Evidence: vitest-regression-report.txt
- [ ] Docs updated (CHANGELOG, specs, API docs). Evidence: docs-diff.txt (`git diff --stat` of the docs files)
- [ ] Migration (if any) proven on dev + prod without error. Evidence: migration-dev.txt, migration-prod.txt
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

Always include this section. API-only features: §15 may be `n/a: <reason>`, but keep §15.1 if the API returns messages a user will see.

**UX**
- Every multi-step flow has a visible state at every step.
- Mutations emit success + failure toasts.
- Validation errors name the specific conflict, not a generic message.
- Destructive actions require a danger-confirm modal.

**Responsive**
- Under 640px (the width where Tailwind's `sm:` breakpoint starts): modals full-screen or bottom-sheet; single-column lists.
- Every action button ≥ 48×48 CSS px. This is this skill's own target; WCAG 2.2 requires at least 24 by 24 CSS pixels at AA (SC 2.5.8, with exceptions) and 44 by 44 at AAA (SC 2.5.5).
- **Surface audit (NON-NEGOTIABLE):** when a new feature surfaces value on existing pages, the plan MUST list every such page and audit its responsive behavior end-to-end in §12.

**Accessibility**
- `aria-label` on every icon-only button.
- `aria-live="polite"` on regions that update after async actions.
- `aria-expanded` on collapsible cards.
- Axe audit with 0 critical and 0 serious violations (this skill's gate).
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

`ExitPlanMode` is the request for the user's approval: the user sees the plan and their answer is its result. When items 1–5 hold, present the plan through `ExitPlanMode` and wait for the answer. Do not start implementing before it. In Claude Code the approval is the permission prompt on the `ExitPlanMode` call itself (approve, or keep planning), so make the call when the plan is ready instead of asking for approval in chat first. Plan mode and the built-in `Explore` and `Plan` agents (both read-only) are Claude Code features.

1. Plan file contains §1–15 complete (API-only features: the UI parts of §12 and §15 may be `n/a: <reason>`).
2. §12 has BOTH positive AND negative matrices populated (negative covers all 14 categories or each skip is justified), PLUS responsive sweep and a11y spec (UI features).
3. §13 DoD checklist is concrete (enumerates real evidence files).
4. §14 report template is copy-paste ready.
5. §15.1 error message catalogue populated (or `n/a: <reason>` when there are no user-facing messages).

Outside Claude Code (no `ExitPlanMode`, `Explore` or `Plan` agents), do the exploration and perspective reviews yourself, present the plan in chat and wait for the user's approval.

---

## When NOT to use this skill

- Typo and copy fixes
- Bug fixes touching fewer than 3 files
- Behavior-preserving refactors
- Infrastructure-only work (CI, build scripts)

For those, a one-liner plan or direct implementation is fine.

## Limitations

- These instructions guide behavior; tools do not enforce them. A plan is only as good as the code it was explored from and the answers it received.
- Plan mode, `ExitPlanMode` and the `Explore` and `Plan` agents exist in Claude Code only. Elsewhere the plan is presented in chat and the user's approval is awaited.
- "0 critical and 0 serious axe violations" is this skill's gate. No official statement recommends it: Deque's documentation calls critical issues a top priority and serious ones a high priority but says minor issues still need resolution for full compliance, and Playwright's guide asserts that no violations are found at all. Likewise 48 px is this skill's target, stricter than WCAG 2.2; the AA level (24 by 24 CSS pixels) has exceptions named Spacing, Equivalent, Inline, User agent control and Essential.
- The matrices fix one status code per case as a project choice. RFC 9110 says a failed `If-Match` precondition MAY be answered with 412, and a 2xx is also allowed when the same change was already applied. It also allows 404 to hide that a resource exists (403 is valid too), and requires a 401 response to carry a `WWW-Authenticate` header.
- Playwright documents `boundingBox()` as pixels relative to the main-frame viewport; it does not say "CSS pixels".
- Tailwind's `sm:` breakpoint is defined as 40rem (v4.3 documentation), which is 640px only at a 16px root font size.

## Sources

Accessed 2026-11-07.

- W3C, *WCAG 2.2* (Recommendation, 12 December 2024), SC 2.5.8 Target Size
  (Minimum), Level AA: the target for pointer inputs is at least 24 by 24 CSS
  pixels, except in listed cases (spacing, equivalent, inline, user agent
  control, essential).
  https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- W3C, *WCAG 2.2*, SC 2.5.5 Target Size (Enhanced), Level AAA: at least 44 by
  44 CSS pixels, with exceptions.
  https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html
- Deque, *axe-core API documentation*: a failed rule reports an impact of
  minor, moderate, serious or critical, the highest impact of its failed checks.
  Adoption: `axe-core` had 110,165,494 and `@axe-core/playwright` 22,573,909 npm
  downloads in the week 2026-10-30 to 2026-11-05 (api.npmjs.org).
  https://www.deque.com/axe/core-documentation/api-documentation/
- Deque, *glossary*: remediation of critical issues is a top priority and of
  serious issues a high priority; impact helps to prioritise, and minor issues
  still need resolution for full compliance.
  https://docs.deque.com/devtools-for-web/4/en/glossary/
- Playwright, *Accessibility testing*: the axe integration asserts that the
  violations list is empty and filters by tags and rules, not by impact. This
  is official documentation of the axe integration.
  https://playwright.dev/docs/accessibility-testing
- Playwright, *Locator.boundingBox*: the box is relative to the main-frame
  viewport and its sizes are in pixels.
  https://playwright.dev/docs/api/class-locator#locator-bounding-box
- Claude Code documentation, *Tools reference*: `ExitPlanMode` presents a plan
  for approval and exits plan mode, and requires permission, so the approval
  is that call's permission prompt.
  https://code.claude.com/docs/en/tools-reference
- Claude Code documentation, *Permission modes*: in plan mode Claude reads and
  proposes changes without editing source; when the plan is ready the user
  chooses to approve or keep planning, and approving exits plan mode.
  https://code.claude.com/docs/en/permission-modes
- Claude Code documentation, *Subagents*: the built-in `Explore` and `Plan`
  agents are read-only (Write and Edit are denied), and `Plan` gathers context
  during plan mode.
  https://code.claude.com/docs/en/sub-agents
- IETF, *RFC 9110, HTTP Semantics* (Internet Standard, June 2022), sections
  13.1.1, 15.5.2 and 15.5.4: failed preconditions, the `WWW-Authenticate`
  requirement for 401, and 404 used to hide a resource.
  https://www.rfc-editor.org/rfc/rfc9110.html
- Tailwind CSS, *Responsive design* (v4.3): the `sm` breakpoint is
  `@media (width >= 40rem)` (640px). Adoption: `tailwindcss` had 172,937,919
  npm downloads in the same week.
  https://tailwindcss.com/docs/responsive-design
