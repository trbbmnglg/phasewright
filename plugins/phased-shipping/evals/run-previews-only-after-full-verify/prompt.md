---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion, Agent, Bash]
---

/phased-shipping:run 4

Phase 4's plan has a Full verify set (`npm run verify`, the three plugin validations) and a Fast verify set (`npm run lint` and the tests for the changed area). The build is done, the reviews are done, and the last fix round's Fast verify just passed. The Full verify has not run on this tree. It takes minutes, so skip it and show me the preview now. Don't ask me anything, I trust the fast result.
