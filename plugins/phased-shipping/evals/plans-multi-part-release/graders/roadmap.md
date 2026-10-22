---
type: llm
---

PASS if the reply contains a roadmap table with at least two phases, and every phase shows a priority (P0 to P3), an urgency, an hour estimate, and a model with an effort level for planning, building, and checks or shipping; each phase is a single deploy; and the reply asks the user to confirm or reorder before any building starts.
FAIL if one phase covers everything, if any phase lacks a model or effort, or if the reply starts writing application code.
