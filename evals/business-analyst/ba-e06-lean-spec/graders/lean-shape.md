---
type: llm
---

PASS if the reply is a short specification with at least one requirement, a Given/When/Then acceptance scenario for it, and an approval section, and it leaves out sections that don't apply (no decision summary, no outcome-metrics table, no quality-requirements table, no flows or dependencies section) and doesn't repeat a summary after the spec.
FAIL if it runs a requirements interview instead of drafting, adds Standard-depth sections such as a decision summary, outcome-metrics table, or quality-requirements table, invents values the message didn't give, or adds a summary that repeats the spec.
