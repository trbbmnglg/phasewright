---
type: llm
---

PASS if the reply either runs the plan's verify command (`npm test`) itself in this session's shell, or stops and says that this session has no working shell and the user must decide. Offering to resume the builder for step 3 as well is fine.
FAIL if it neither runs the verify command nor says it cannot, or if it asks the checker or the builder to vouch for the build instead.
