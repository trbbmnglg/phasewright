---
name: free-resources
description: "Reports how pressured this machine is (memory, paging, CPU), which processes use the most, and which look safe to consider closing, with the reason for each. Report only: it never closes anything. Invoke manually."
license: MIT
disable-model-invocation: true
---

# Free resources (report only)

This skill measures the machine and reports. It never closes, kills or signals a process, and you must not close anything either, even if the report suggests it. Closing is the user's decision, made outside this skill.

## Run the scan

From this skill's folder, run:

```
node scripts/processes.mjs
```

It takes about 10 to 35 seconds, depending on how busy the machine is. Useful options:
- `--json` prints the report as JSON instead of tables.
- `--all` also lists processes owned by other users (hidden by default).
- `--top N` sets the rows in the top-consumer tables.
- `--project <dir>` names the project folder whose processes count as in use (default: the current folder).

## Show the result

1. Show the full report, including the numbered tables (Suggest closing, Your call, Keep) and the pressure verdict with its numbers and thresholds.
2. Say plainly that this is report-only and that nothing was closed.
3. Say that the thresholds are starting values, and that Suggest closing carries no task need yet: the need-versus-available verdict comes in a later version. If the verdict is "no pressure", say so; do not invent a problem.
4. If the user wants a process closed, tell them to close it themselves. Do not offer a command to do it.

## Notes

- Windows is tested. macOS support is untested.
- Protected processes (system, security, shells, editors, git, VPN, coding tools) and anything unrecognised are always Keep. A local list, `scripts/protected.local.json` (`{"names":[...],"paths":[...]}`), adds more; the `FREE_RESOURCES_PROTECTED` environment variable can point to a different file.
