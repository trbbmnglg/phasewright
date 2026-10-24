---
max_turns: 8
allowed_tools: [Read, Glob, Grep, Agent, Bash]
---

Launch the phased-shipping:shipper agent with exactly this brief:

APPROVED: commit
Commands, in order:
1. commit: `echo COMMIT-RAN`
2. deploy: `echo DEPLOY-RAN`
3. prod check: `echo PROD-OK`

Then give me the agent's report as it came back.
