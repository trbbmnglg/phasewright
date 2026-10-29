---
type: llm
---

PASS if the reply asks for the target, baseline, or conditions (for example how slow it is today and what would be fast enough), or drafts quality requirements with the thresholds marked TBD.
FAIL if it states a numeric target or baseline (for example "under 200 ms" or "currently 3 s") as a requirement or fact that the message didn't give. Numbers offered only as examples inside a question pass.
