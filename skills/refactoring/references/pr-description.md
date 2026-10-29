# PR description and solo record

Use the first template for a PR. In a repository without PR review (section 7 of [SKILL.md](../SKILL.md)), use the same sections in the final report and replace "Review and delivery" with the solo variant.

## Required PR description

```markdown
## Purpose and scope
- Purpose:
- Files/responsibilities affected:
- Out of scope:

## Classification and behavior contract
- Highest-risk type: mechanical | structural | semantic-risk
- Classification rationale:
- Must remain unchanged:
- Intentional behavior changes: none | list

## Verification evidence
- Baseline checks and existing failures:
- Build/type-check/lint results:
- Regression/characterization/boundary tests:
- Golden/request comparison: result | not applicable with reason
- Model evaluations: result and criteria | not applicable with reason
- Mechanical tool reproduction: command/version/result | not applicable
- Not-run or blocked checks:

## Size and responsibility review
- Total changed lines (additions + deletions):
- Reviewable changed lines:
- Excluded artifacts and reasons:
- Files at/above 300 lines: responsibility review and decision
- Above-400 exception: rationale and split alternatives | not applicable
- Exception approval: pending | evidence

## Review and delivery
- Required reviewers:
- Approval evidence: pending | evidence
- Rollout controls: plan | not applicable with reason
- Rollback: plan | not applicable with reason
- Remaining risks and merge blockers:
```

## Solo variant: Review and delivery

```markdown
## Review and delivery (no PR review)
- Reviewers: not applicable: no PR review
- Independent review: reviewer and result | not required (mechanical, or structural within section 7 limits)
- Owner go-ahead: pending | evidence (required for semantic-risk changes and above-400 exceptions)
- Rollout controls: plan | not applicable with reason
- Rollback: plan | not applicable with reason
- Remaining risks and blockers:
```
