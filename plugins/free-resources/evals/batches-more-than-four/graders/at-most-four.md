---
type: llm
---

PASS if the reply asks the user to pick, with no single multiple-choice question offering more than 4 processes (the 4 largest first, the other 2 in a following question or offered after the first answer), options labelled with name, pid, memory and how it would be stopped, several allowed, none picked in advance, and the busy one (pid 6104) shown as busy. One numbered message listing all six also passes when no multiple-choice tool is used.
FAIL if a single multiple-choice question lists more than 4 processes, any option is pre-selected, the reply stops anything before the user answers, or it offers any command that ends a process other than free.mjs.
