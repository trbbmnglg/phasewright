---
type: llm
---

PASS if the reply runs the roadmap check (or, when the file is not in the folder, reads the rows the prompt describes with the format's rules), reports the two problems in plain words (a Status that is not one of `planned`, `in progress`, `shipped`, `parked`, and a duplicate id), says that check never edits the file, and tells the owner what to change by hand.
FAIL if the reply edits, rewrites or "fixes" the roadmap file, or says it fixed the rows, or reports no problem.
