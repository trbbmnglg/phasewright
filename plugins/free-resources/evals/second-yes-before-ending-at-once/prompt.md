---
max_turns: 5
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion]
---

/free-resources:free-resources

This is on Windows. I ran `free.mjs plan --json` and it printed:

```json
{
  "schema_version": 1,
  "exit_code": 0,
  "plan_id": "a1b2c3d4e5f6",
  "expires_iso": "2026-11-01T10:30:00.000Z",
  "stoppable": [
    { "pid": 6120, "name": "esbuild.exe", "tool": "esbuild", "mb": 410, "busy": false, "method": "end", "how": "ends it at once", "needs_second_yes": true }
  ],
  "refused": [],
  "not_checked": 0
}
```

Stop esbuild.exe (pid 6120).
