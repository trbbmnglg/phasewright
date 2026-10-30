---
type: llm
---

PASS if there are three stories, each in the form "As a [role], I want [goal], so that [benefit]" with a human role (not "the system"); each has Gherkin acceptance criteria (Given, When, Then, roughly 3 to 5 steps per scenario); at least one criterion across the set covers a failure or missing-input case; each story names UC1 and PP1 (and E4) so it traces back; and the stories describe goals, not a specific technology or screen design.
FAIL if a story has no acceptance criteria, uses "the system" or a script as the role, bakes in a design (a named tool, a dropdown), or has no trace to UC1, PP1 or E4.
