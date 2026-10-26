# Messy sample

Synthetic test data shaped like a long-lived roadmap. Nothing here is real.

## Model check (2026-01-10)
| Provider | Session model | Pinned |
|---|---|---|
| example | alpha | none |

## Roadmap
| # | Phase | Kind | Priority | Urgency | Est. (raw → cal.) | Plan | Build | Runs as | Checks and ship | Review | Cost | Blocked by | Status | Commit / deploy | Actual |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Set up the project | infra | P0 | Now | 1 h → 1.3 h | opus (high) | sonnet (high) | builder | haiku (low) | standard | $ | none | shipped | abc1234 | 1.2 h |
| 2 | Add sign-in | backend | P1 | Soon | 2 h → 2.6 h | opus (high) | sonnet (high) | builder | haiku (low) | standard | $$ | 1 | planned | | |
| 3 | Add the report page | ui | P2 | Soon | 2 h → 2.6 h | opus (high) | sonnet (medium) | main | haiku (low) | standard | $$ | 2 | planned (docs/phases/phase-3-report.md) | | |
| 4 | Import old data | data | P2 | Later | 3 h → 3.9 h | opus (high) | sonnet (high) | builder | haiku (low) | security | $$$ | none | to plan | | |
| 5 | Email digest | backend | P3 | Later | 1 h → 1.3 h | opus (medium) | sonnet (medium) | builder | haiku (low) | standard | $ | none | backlog | | |
| 6 | An old idea | docs | P3 | Parked | 1 h → 1.3 h | opus (low) | sonnet (low) | main | haiku (low) | standard | $ | none | moved to phase 9 | | |
| 7 | A stray cost cell | mixed | P2 | Soon | 2 h → 2.6 h | opus (high) | sonnet (high) | builder | haiku (low) | standard | $$ | none | $$ | | |
| 8 | A short row | ui | P3
| 9 | Waiting row | data | P2 | Soon | 1 h → 1.3 h | opus (low) | sonnet (low) | main | haiku (low) | standard | $ | none | planned (waiting on review) | | |
| 10 | Capital letters | backend | P1 | Now | 1 h → 1.3 h | opus (low) | sonnet (low) | main | haiku (low) | standard | $ | none | Planned | | |
| 11 | Work in progress | backend | P1 | Now | 1 h → 1.3 h | opus (low) | sonnet (low) | main | haiku (low) | standard | $ | none | WIP | | |

More rows were added later, in a second table under the same heading.

| # | Phase | Kind | Priority | Urgency | Est. (raw → cal.) | Plan | Build | Runs as | Checks and ship | Review | Cost | Blocked by | Status | Commit / deploy | Actual |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Second table row | ui | P2 | Later | 1 h → 1.3 h | opus (low) | sonnet (low) | main | haiku (low) | standard | $ | none | planned | | |
| 12 | A cell with a \| pipe | backend | P2 | Later | 2 h → 2.6 h | opus (low) | sonnet (low) | main | haiku (low) | standard | $ | none | shipped | def5678 | 2 h |
| 13 | A long row | ui | P3 | Later | 1 h → 1.3 h | opus (low) | sonnet (low) | main | haiku (low) | standard | $ | none | planned | | | extra cell |

## Backlog
| # | Phase | Kind | Priority | Urgency | Est. | Plan | Blocked by |
|---|---|---|---|---|---|---|---|
| b1 | Backlog item one | docs | P3 | Later | 1 h → 1.3 h | none | none |
| b2 | Backlog item two | infra | P3 | Later | 2 h → 2.6 h | none | b1 |

## Later
| # | Phase | State |
|---|---|---|
| a1 | Tidy the folder | done |
| a2 | Polish the text | wip |

## Notes

A fenced block with a table is skipped:

```text
| # | Phase | Status |
|---|---|---|
| 99 | Not a real row | shipped |
```

The end.
