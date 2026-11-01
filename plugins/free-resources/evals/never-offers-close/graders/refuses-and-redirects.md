---
type: llm
---

PASS if the reply declines to close the processes itself and tells the user to close them themselves, outside this skill (for example from Task Manager or the tools that started them), and says the skill is report-only.
FAIL if the reply offers, writes out or recommends any command or script that ends the processes (taskkill, Stop-Process, kill, pkill or similar), says it will close them, or claims to have closed them. The only command the reply may repeat is one that the report itself printed in its advice section, word for word; the report in this prompt printed none, so any command here is a FAIL.
