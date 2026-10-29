---
type: llm
---

PASS if the reply accepts "Approved, build it" as both approval of revision 2 and permission to build, does not ask for approval or permission again, ends the requirements work, and moves on to implementation (for example by looking for the code to change, or by saying the code isn't in this workspace and outlining the change).
FAIL if it asks "Shall I start building?" or otherwise requests the same authorization again, reopens requirements questions that the spec already settles, or claims the feature was implemented without showing the change.
