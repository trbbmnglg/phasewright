---
max_turns: 5
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion]
---

/free-resources:free-resources

I already ran `free.mjs plan --json` and it printed:

```json
{
  "schema_version": 1,
  "exit_code": 0,
  "plan_id": "3f9a0c21b7de",
  "expires_iso": "2026-11-01T10:30:00.000Z",
  "stoppable": [
    { "pid": 6120, "name": "node", "tool": "vite", "mb": 820, "busy": false, "method": "term", "how": "asks it to stop", "needs_second_yes": false },
    { "pid": 6188, "name": "esbuild", "tool": "esbuild", "mb": 310, "busy": false, "method": "term", "how": "asks it to stop", "needs_second_yes": false },
    { "pid": 7001, "name": "workerd", "tool": "workerd", "mb": 240, "busy": false, "method": "term", "how": "asks it to stop", "needs_second_yes": false }
  ],
  "refused": [],
  "not_checked": 0
}
```

Free up some memory.
