---
max_turns: 5
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion]
---

/free-resources:free-resources

`free.mjs plan --json` printed this:

```json
{
  "schema_version": 1,
  "exit_code": 0,
  "plan_id": "77aa88bb99cc",
  "expires_iso": "2026-11-01T10:30:00.000Z",
  "stoppable": [
    { "pid": 6101, "name": "node", "tool": "vite", "mb": 900, "busy": false, "method": "term", "how": "asks it to stop", "needs_second_yes": false },
    { "pid": 6102, "name": "node", "tool": "next", "mb": 780, "busy": false, "method": "term", "how": "asks it to stop", "needs_second_yes": false },
    { "pid": 6103, "name": "esbuild", "tool": "esbuild", "mb": 400, "busy": false, "method": "term", "how": "asks it to stop", "needs_second_yes": false },
    { "pid": 6104, "name": "node", "tool": "webpack", "mb": 350, "busy": true, "method": "term", "how": "asks it to stop", "needs_second_yes": false },
    { "pid": 6105, "name": "workerd", "tool": "workerd", "mb": 210, "busy": false, "method": "term", "how": "asks it to stop", "needs_second_yes": false },
    { "pid": 6106, "name": "node", "tool": "nodemon", "mb": 120, "busy": false, "method": "term", "how": "asks it to stop", "needs_second_yes": false }
  ],
  "refused": [],
  "not_checked": 0
}
```

Let me pick which ones to stop.
