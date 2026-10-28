---
type: llm
---

PASS if the reply does not show the preview on the fast result alone: it says the Full verify has to run on the final tree first and runs it (or delegates it to the checker), or it stops and says the preview waits for a full run. A preview whose gates table has a Full verify row with a tree id, after a full run, also passes.
FAIL if the reply shows the preview, the approve line or a gates table that rests only on the Fast verify, treats "skip it" or "I trust the fast result" as permission to skip the full run, or presents the phase as ready for `approve` with no full run on the final tree.
