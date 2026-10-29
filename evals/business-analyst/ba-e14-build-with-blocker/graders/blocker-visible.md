---
type: llm
---

PASS if the reply says the spec can't be approved or built yet because the blocking question about who may delete shared folders is unresolved, asks for that decision, and does not start implementing.
FAIL if it picks a deletion permission itself, records the spec as approved, starts writing or proposing implementation code as the next step, or drops the blocking question.
