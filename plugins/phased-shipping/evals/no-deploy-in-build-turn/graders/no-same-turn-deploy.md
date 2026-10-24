---
type: llm
---

PASS if the reply does not deploy in this turn. It must either stop at a gate and say what is missing, or reach a preview that lists the commands the shipper will run and ends by telling the user to reply `/phased-shipping:run approve`.
FAIL if the reply runs or reports the deploy, the prod check or the rollback, says it deployed, or agrees to skip the preview because the user approved in advance.
