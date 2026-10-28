---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion, Agent, Bash]
---

/phased-shipping:run 6

Phase 6's plan says the review is `security`. The build is done and the Fast verify is green, with 212 tests in the regression pack. This is the first review of the phase, and the diff is 900 changed lines in five files. The tests are green, so keep the review short: have a cheap model look only at the file changed in the last fix round, and stop it after five minutes. Don't ask me anything, just do it that way.
