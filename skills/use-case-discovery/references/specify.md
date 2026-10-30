# Specify: use cases, stories, metrics

Read from [SKILL.md](../SKILL.md) step 4. Contents: use cases, user stories,
acceptance criteria, stories for AI-written code, the story map, metric
cards, choosing measures, hand-off.

Every item traces upward: story to use case to pain point to evidence. Use
IDs (UC1, US1, PP1, E1, M1) and keep them stable across revisions.

## Use cases

Alistair Cockburn's *Writing Effective Use Cases* (2000 draft) gives three
goal levels:

- **Summary:** takes "multiple user-goal sessions to complete, possibly
  weeks, months or years".
- **User goal ("sea level"):** "a particular and immediate goal of value to
  the primary actor", typically "one person, one sitting (2-20 minutes)".
- **Subfunction:** a partial goal of another use case.

Write at user-goal level. Cockburn gives three tests: can the primary actor
"go away happy after having done this?", does it pass the coffee-break test
("After I get done with this, I can take a coffee break."), and is it one
person in one sitting. Jacobson and Cockburn's *Use-Case Foundation* (2024)
defines a use case as "all the ways of using a system to achieve a particular
goal for a particular user", and advises starting with "a sketch of the
sequence of events" and adding detail as needed.

Cockburn says to keep two templates: a casual one for low-ceremony work and a
fully dressed one for higher ceremony.

**Casual** (all use cases): a short paragraph.

> UC1 Produce the weekly release note (user goal). The release lead starts
> from the list of merged changes. The note is built, they edit it, and send
> it. If a change has no customer-facing description, it is flagged and the
> lead writes one. Pain: PP1. Evidence: E4, E7.

**Fully dressed** (top use cases in Full mode). Fields follow Cockburn's
template; the draft and the published book may label some differently.

| Field | Content |
|-------|---------|
| ID, name, level | UC1, a verb phrase, user goal |
| Scope | The system under discussion |
| Primary actor | A person or role, not "the script" |
| Stakeholders and interests | Who cares, and about what |
| Preconditions | What is already true |
| Minimal guarantee | What is protected even if it fails |
| Success guarantee | The state of the world when it succeeds |
| Trigger | What starts it |
| Main success scenario | About 3 to 9 numbered steps |
| Extensions | Step number, the condition, the handling |
| Variations | Technology or data variations |
| This skill's additions | Pain points (PP), evidence (E), metric (M), fit-gate rung |

Cockburn's pass test for a requirement: "Will you be able to tell, upon
delivery, whether you got this?" If not, add the metric that tells you.

For an automation, the primary actor is still the person who benefits. The
automation is part of the system. Write the steps from the actor's view, then
mark which steps the automation performs.

## User stories

The common form is "As a role, I want a goal, so that a benefit". The
Mountain Goat Software page on the template credits Rachel Davies at Connextra
in the early 2000s. Ron Jeffries describes a story as three parts: a Card,
the Conversation, and the Confirmation, which "is the acceptance test".

Check each story against INVEST (Bill Wake, 2003): Independent, Negotiable,
Valuable, Estimable, Small, Testable. Quick checks, in this skill's wording:

| Letter | Ask |
|--------|-----|
| Independent | Can it be built and shipped without another story first? |
| Negotiable | Is it a goal, not a fixed design? |
| Valuable | Does a person get something they can name? |
| Estimable | Is it clear enough to size? |
| Small | Does it fit one working session or iteration? |
| Testable | Can you say how to tell it is done? |

Common faults: the role is "the system"; the goal is a design ("a dropdown");
the benefit repeats the goal; the story is too large to test.

## Acceptance criteria

Use Gherkin from the Cucumber reference. Given describes "the initial context
of the system", When "an event, or an action", Then "an expected outcome, or
result". Cucumber recommends 3 to 5 steps per example.

```gherkin
Scenario: A change with no customer description is flagged
  Given a merged change has no customer-facing description
  When the release note is built
  Then the change is listed under "Needs a description"
  And the note is not marked ready
```

Write at least: the main success case, one failure or missing-input case, and
a permission or data edge when it applies. Each criterion is observable and
has no design in it.

For a use case that includes a model, add scenarios for a wrong or uncertain
answer. Microsoft's guidelines for human-AI interaction (Amershi et al.,
CHI 2019) give prompts: make clear how well the system can do what it can
do (G2), support efficient correction (G9), scope services when in doubt (G10),
encourage granular feedback (G15), and provide global controls (G17).

## Stories for code that AI will write

When the person building is relying on AI to write the code, add a standard
block to every story, because wrong or unsafe output is common:

- In the Stack Overflow 2025 Developer Survey, 66% of developers reported
  frustration with "AI solutions that are almost right", and 46% said they
  distrust the accuracy of AI output, against 33% who trust it.
- Veracode's 2025 GenAI Code Security report (a vendor study of synthetic
  tasks, not production code) found AI-generated code introduced security
  flaws in 45% of cases.
- Google Cloud's announcement of DORA's 2025 report says AI adoption "does
  continue to have a negative relationship with software delivery stability".

The block, in the user's plain words where needed:

1. There is a check that proves it works: a test, or a step anyone can run.
2. Bad or missing input is refused with a clear message, not accepted.
3. No password, key or token is written into the code or the repository.
4. Only the right people can see or change the data.
5. Someone other than the author has looked at the change before it is used.

## Story map (Full mode)

Jeff Patton's story map arranges stories "into a helpful shape" instead of a
flat list. Lay the user's activities left to right as the backbone, with
stories below each in priority order. The first row across is the "walking
skeleton": "the smallest possible system you could build that would give you
end to end functionality". Show it as a table.

## Metric cards

The chain comes from Google's HEART paper (Rodden, Hutchinson and Fu, CHI
2010): state the goal, identify the signals that show success, then build the
metrics. It says to avoid worrying early "about whether or how it will be
possible to find relevant signals", and that raw counts "need to be
normalized; ratios, percentages, or averages per user are often more useful".
GOV.UK adds baselines and targets: set the purpose, the measures, a baseline,
then targets. DevEx research (Noda et al., 2023) adds that perceptions and
workflow measures should be read together, because "neither alone can tell the
full picture".

The fields below combine those three. The combination is this skill's own and
not a published standard.

| Field | Content |
|-------|---------|
| ID, linked use case or story | M1, UC1 |
| Goal | What success means, in words |
| Signal | What would show it |
| Metric | Name, formula and unit, as a ratio or average |
| Category | A HEART category, or ISO 9241-11 effectiveness, efficiency or satisfaction |
| Role | Primary or guardrail |
| Baseline | A measured value, with source and date. Otherwise TBD and how to measure |
| Target | Set by the owner, with a date. Otherwise TBD |
| Method | Where the data comes from and who collects it |
| Owner | A named role |
| Cadence | How often it is reviewed |
| Guardrail | What must not get worse |
| Decision rule | What happens if the target is hit or missed |

Rules:

- Never fill a baseline or target that nobody gave you. You may propose a
  target, label it a proposal, and ask the owner.
- Always pair a primary metric with a guardrail, so that speed is not bought
  with errors.
- Use two to four per use case. HEART says it is "not always appropriate to
  employ metrics from every category".
- Time and error measures need the same method before and after.

### Choosing measures

| Question | Measure | Note |
|----------|---------|------|
| Does it work? | Task success rate; error rate; rework | HEART task success lists effectiveness (percent of tasks completed) and error rate as separate measures |
| Is it faster? | Time on task; handle time; minutes per run | HEART: efficiency is time to complete a task |
| Is it easy? | Single Ease Question: "Overall, how difficult or easy was the task to complete?" (7 points) | MeasuringU reports an average near 5.5 |
| Is it usable overall? | System Usability Scale, 10 items | MeasuringU reports an average of 68 across 500 studies |
| Quick usability check | UMUX-Lite, 2 items | MeasuringU reports r = .83 with SUS |
| Is it used? | Share of eligible runs that use it | HEART adoption and retention |
| Cost | Cost per transaction; hours per month saved | GOV.UK lists cost per transaction among its required measures |
| Toil | Share of time on the task | Google's SRE book gives a goal of keeping toil below 50% of each SRE's time |

For delivery pipelines, DORA's current software delivery metrics are change
lead time, deployment frequency, failed deployment recovery time, change fail
rate and deployment rework rate. DORA's guide lists pitfalls: setting the
metrics as a goal "increases the likelihood that teams will try to game the
metrics", and competing with other teams, since "the goal is to improve your
team's performance over time, not to compete against other teams or
organizations". It says the metrics are "meant to be applied at the
application or service level". Use them to watch one application or service
over time. Check dora.dev for the current definitions.

Survey measures need enough respondents to mean something. State the number
of respondents beside every score.

## Prioritize the stories

For a first release, MoSCoW works within a use case: Must is the minimum
usable subset, and the Agile Business Consortium advises keeping Must Have to
no more than about 60% of the effort. Say which stories are in the walking
skeleton.

## Hand off

The chosen use case, its stories and its metric cards are the input to
business-analyst, which turns one feature into an approved specification.
Pass on the open questions and the assumptions with their owners.
