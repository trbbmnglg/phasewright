---
name: refactoring
description: "Risk-based code refactoring guide for frontend components, hooks, modals, tabs, constants, API routes, and LLM request builders. Use when asked to refactor or extract these elements, or when a maintained source file approaches or exceeds 300 lines and needs a responsibility review. Classify changes, preserve behavior contracts, require verification evidence, and document size exceptions instead of splitting solely to satisfy line counts."
argument-hint: "[optional: file path or area to refactor]"
license: MIT
metadata:
  title: "Refactoring Guide"
  tags: "refactoring,code-quality"
  featured: "false"
  order: "5"
  version: "2.0.0"
---

# Refactoring Guide

## Non-negotiable rules

- Classify every proposed change before editing. Apply the highest-risk category present.
- Treat 300 lines per maintained source file as a responsibility-review trigger, not a hard limit or a requirement to split before adding a feature.
- Never split solely to reduce line count, hook count, handler count, or tab count.
- Keep one coherent purpose per PR. Isolate mechanical changes from structural or semantic changes.
- Preserve independently buildable and testable steps. Keep genuinely atomic changes together and explain why.
- Treat intentional behavior changes as semantic changes, not behavior-preserving refactoring. Separate them where practical.
- Never claim tests passed, approvals were obtained, or rollout succeeded without evidence. Report unavailable checks as blocked or not run.
- Do not merge, deploy, publish a PR, or commit unless the user authorizes that action. Prepare the code and PR description otherwise.
- In a repository without PR review, use the substitutes in section 7. Do not invent approvals, and do not leave every change blocked on reviewers who do not exist.

## 1. Inspect and establish the baseline

1. Read repository instructions, architecture conventions, affected callers, exports, and existing tests.
2. Identify the actual build, lint, type-check, and test commands from the repository. Do not invent commands.
3. Run applicable baseline checks when available. Record existing failures separately from regressions.
4. State the behavior contract: inputs, outputs, side effects, errors, lifecycle, and externally consumed interfaces that must remain unchanged.
5. Identify gaps in tests for the affected behavior. Do not use coverage percentage alone as proof of safety.
6. Select a dependency-safe extraction boundary and verification method before changing code.
7. Determine how changes are reviewed: through PRs, or committed straight to the main branch with no review (section 7). Ask once if repository instructions do not say.

## 2. Classify the change and require evidence

| Type | Classification | Required verification | Required review |
|---|---|---|---|
| Mechanical | Tool-generated rename, move, or formatting with no observable contract change | Build/type-check and applicable full test suite; record tool version, command, and configuration; reproduce the diff from the same clean baseline; inspect for unintended edits | Isolated PR; one reviewer; PR size gate waived with documented mechanical classification |
| Structural | Extract component/hook/service, introduce interface, or reorganize internals while preserving behavior | Build/type-check, lint, relevant tests, and characterization tests at affected deterministic boundaries; compare baseline and refactored outputs or requests where applicable | One reviewer; size exception required above 400 reviewable changed lines |
| Semantic-risk | Change observable behavior or affect concurrency, transactions, retries, timeouts, streaming, cancellation, auth, externally consumed contracts, prompts, model settings, or provider behavior | Build/type-check, lint, relevant regression tests, and affected failure/boundary-path tests; model evaluations when model inputs or model/provider behavior change; rollout and rollback controls or an explicit non-applicability rationale | Two reviewers, or pairing plus independent reviewer approval; line count never substitutes for these requirements |

The review column assumes PR review. Repositories without it use section 7; the verification column applies everywhere.

Apply verification by relevance, not by blindly accumulating requirements from other rows. Do not demand unchanged golden outputs when outputs intentionally change; test the new contract instead.

Treat a rename or move as higher risk when it affects reflection, dynamic imports, configuration, persisted identifiers, public exports, route registration, or externally consumed names. Tool generation alone does not prove a change is mechanical.

If classification is uncertain, use the higher-risk category until evidence resolves it.

## 3. Apply size gates without artificial fragmentation

Use these numbers as adopted policy defaults, not research-backed safety boundaries. Follow explicit repository policy when it differs and record the override.

### File responsibility gate: 300 lines

For each maintained source file at or above 300 physical lines, document:

- Its responsibilities and coupling.
- Whether a cohesive extraction boundary exists.
- The chosen extraction, or why keeping the file intact is clearer and safer.

Do not fail a refactor merely because a cohesive file remains above 300 lines. Exclude generated/vendor files from this gate and identify exclusions.

### PR review gate: 400 changed lines

Count additions plus deletions against the PR base, not resulting file length. Report both total and reviewable changed lines. Exclude generated files, lockfiles, snapshots, and purely mechanical formatting from the reviewable count only when listed and justified; still verify those artifacts as applicable.

For structural or semantic-risk PRs above 400 reviewable changed lines, require:

1. A written size-exception rationale.
2. An explanation of why dependency-safe splitting is worse or not feasible.
3. Reviewer approval of the exception before merge (without PR review: the owner's go-ahead, section 7).

For isolated mechanical PRs, waive this gate only after recording the reproducible transformation and verification evidence.

Never treat a PR below 400 lines as approved, low-risk, or adequately tested by default.

## 4. Choose what to extract

Review responsibilities first. Use counts only to prompt inspection.

| Signal | Extraction decision |
|---|---|
| Inline modal/dialog with form, validation, or submission lifecycle | Extract when it owns a cohesive interaction or obscures the parent; do not extract trivial local state automatically |
| More than five state hooks or two effects | Inspect cohesion and lifecycle coupling; extract a focused hook only when the states/effects implement one reusable or independently testable responsibility |
| Multiple inline tab panels | Extract substantial, independently understandable panels; keep trivial panels inline when that is clearer |
| Large static maps, arrays, or configuration | Move outside the component function; use a co-located constants file only when it improves ownership or reuse |
| More than five route handlers or a large route module | Split by resource/sub-domain when route contracts and middleware ordering can be preserved |
| Handler longer than 60 lines | Inspect for separable business logic; extract a service/helper when it provides a meaningful testable boundary |
| JSX repeated three or more times | Extract only when instances share meaning and behavior, not merely similar markup |

### Custom hooks

- Keep data loading, related state, cleanup, and derived behavior together when they share one lifecycle.
- Keep presentation decisions and notifications in the UI by default. Allow interaction hooks to own modal state or notifications only when that is their explicit responsibility.
- Preserve effect dependencies, request ordering, cancellation, stale-response handling, error propagation, and loading transitions.
- Do not introduce a reducer, caching layer, new data library, or new cancellation behavior merely as part of extraction. Separate intentional changes.
- Test success, failure, refetch, unmount, and overlapping requests where applicable.

### Modals and dialogs

- Co-locate section-specific dialogs; promote to shared components only when actually shared.
- Preserve controlled/uncontrolled ownership, mount/unmount behavior, field reset timing, validation, submission, focus, keyboard dismissal, and accessibility.
- Preserve dismissal rules while saving, duplicate-submit protection, notification behavior, and callback ordering.
- Do not change error handling or close/reset behavior silently while extracting.

### Tabs

- Keep the page responsible for navigation and shared layout; let substantial panels own their cohesive content.
- Preserve tab identifiers, URL/deep-link behavior, permissions, lazy loading, and whether inactive panels stay mounted.
- Avoid prop drilling or unnecessary cross-tab state relocation solely to meet a file-size target.

### Constants

- Hoist only genuinely static values. Keep values depending on props, locale, permissions, theme, or request context in the correct scope.
- Preserve mutability, object identity assumptions, initialization timing, and server/client boundaries.
- Prefer module-local constants before creating a separate file. Avoid generic dumping-ground modules.

### API routes and business logic

- Follow the framework's existing routing and service conventions; do not assume a particular folder layout.
- Extract cohesive domain logic into the repository's service/helper layer, not automatically into a generic `lib/` folder.
- Preserve paths, methods, middleware order, auth, validation, status codes, response schemas, and error mapping.
- Preserve transaction scope, dependency lifetimes, side-effect ordering, idempotency, and retry semantics.
- Reclassify affected operational semantics as semantic-risk even if the stated intent is only moving code.

## 5. Verify LLM boundaries when applicable

When the refactor touches code that builds model requests (prompts, messages, tool schemas, model settings, structured-output configuration) or parses model responses, read [references/llm-boundaries.md](references/llm-boundaries.md) before editing.

In short: prove complete request equivalence across a sanitized corpus plus boundary cases, and verify streaming, retries, and cancellation separately. Intentional prompt, model, parameter, tool-contract, or provider changes are semantic-risk and need an evaluation set before editing.

## 6. Execute and report

1. Add missing characterization tests without changing production behavior where practical.
2. Make one cohesive change at a time and run the relevant checks after each step.
3. Inspect the final diff for accidental formatting, changed exports, dependency changes, and unrelated edits.
4. Prepare the PR description from [references/pr-description.md](references/pr-description.md). Leave human approvals pending unless actual approval evidence is available. Without PR review, use the record in section 7 instead.
5. Report changed files, classification, checks run and results, exclusions, exceptions, and remaining risks.
6. Use `refactor(scope): description` only for behavior-preserving changes. Keep feature/fix commits separate when commits are authorized.

## 7. Repositories without PR review

Use this section when changes are committed straight to the main branch with no PR review, typically a solo project. The verification rules do not relax; only the review column of section 2 is replaced.

- Record reviewers as `not applicable: no PR review`, never as pending or approved, and name the substitute used below.
- **Mechanical:** the reproducible transformation and verification evidence are the gate.
- **Structural:** verification evidence is the gate. Add an independent review when the change exceeds 400 reviewable lines or when tests do not cover an affected boundary.
- **Semantic-risk:** before asking to commit or deploy, get an independent review, then show the owner the intentional behavior changes, the review result, and the rollback plan, and wait for an explicit go-ahead.
- **Above-400 exceptions:** write the rationale and split alternatives in the report; the owner's go-ahead counts as the exception approval.
- An independent review comes from a reviewer that did not write the change, starting from the diff and the behavior contract rather than your conclusions: a separate code-review agent or a person. Self-review in the same session does not count.
- Put the full record in the final report, using the solo variant in [references/pr-description.md](references/pr-description.md). When a commit is authorized, summarize classification, checks, and exceptions in the commit body.
- Missing verification remains a blocker. Report it; do not commit around it.

## Completion checklist

- [ ] Classify by the highest-risk affected behavior.
- [ ] Preserve the stated contract or explicitly classify intentional changes.
- [ ] Extract at cohesive, dependency-safe boundaries, not arbitrary counts.
- [ ] Document responsibility reviews for files at/above 300 lines.
- [ ] Record line counts, exclusions, and required size exceptions.
- [ ] Run applicable verification and report actual evidence.
- [ ] Document required reviews, or the section 7 substitutes in a repository without PR review; do not fabricate approval.
- [ ] Document rollout/rollback controls or non-applicability.
- [ ] Mark missing verification as a blocker everywhere, and missing approval as a merge blocker where review applies.
- [ ] Keep unrelated feature, fix, dependency, and formatting work separate.
