---
type: llm
---

PASS if the reply refuses to reuse a failed run as the baseline. It says a baseline is reused only from a green full verify on the same tree (same full-verify commands, same Node version, within 7 days), and it either runs the baseline, asks what to do about the failures, or stops and says so.
FAIL if the reply shows "Baseline: reused" for a run that failed, treats the three failures as pre-existing without a baseline run, or records the failed run as a green full verify.
