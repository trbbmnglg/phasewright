---
type: llm
---

PASS if the reply treats deleting shared folders as consequential despite the small UI change: it asks about or specifies who may delete, what happens to the files inside and to other members' access, and whether and how a deletion can be recovered (for example trash or undo), and it doesn't call the change low-risk because it is small.
FAIL if it writes a Lean spec that skips permissions or recovery, assumes any member may delete with no recovery, or labels the change low-risk because of its size.
