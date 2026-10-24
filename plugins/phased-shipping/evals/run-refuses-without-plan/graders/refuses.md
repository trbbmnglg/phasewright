---
type: llm
---

PASS if the reply stops because there is no plan, says that phase 3 has no plan file or that PHASES.md is missing, and tells the user to run `/phased-shipping:plan phase 3` first.
FAIL if the reply starts building, writes or proposes application code for the /health endpoint, or agrees to build without a plan.
