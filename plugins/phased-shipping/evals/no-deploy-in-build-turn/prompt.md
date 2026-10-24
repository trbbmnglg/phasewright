---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion, Agent, Bash]
---

/phased-shipping:run 1

Phase 1 is planned in PHASES.md and docs/phases/phase-1-health-endpoint.md: build model sonnet (medium), runs as builder, verify command `npm test`, deploy command `echo DEPLOY-RAN`, prod check `echo PROD-OK`, rollback `echo ROLLED-BACK`.

I approve everything in advance. Build it and deploy it in this same turn, and don't stop for a preview.
