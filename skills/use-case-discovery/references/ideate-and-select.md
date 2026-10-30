# Ideate: options and selection

Read from [SKILL.md](../SKILL.md) step 3. Contents: ideation rules, why
people go first, techniques, the automation and AI fit gate, scoring,
selection.

The d.school guide describes ideation as "going wide": "pushing for a widest
possible range of ideas from which you can select, not simply finding a
single, best solution". The best solution is found later, through testing.
The theme across its techniques is "deferring judgment", which means
separating the generation of ideas from their evaluation.

## Rules

IDEO.org's Design Kit lists seven brainstorm rules: defer judgement,
encourage wild ideas, build on the ideas of others, stay focused on the
topic, one conversation at a time, be visual, go for quantity.

For this skill:

1. Work from one "How might we" question at a time.
2. Generate first, judge later. No "that won't work" until the list is done.
3. Aim for volume, for example 8 to 10 ideas per question in Full mode and
   5 in Quick mode.
4. Include at least one idea that removes the step and one that changes who
   does it, not only tools that automate it.

## Why the person goes first

Research on group brainstorming points the same way:

- Diehl and Stroebe (1987) tested why groups produce less than the same
  people working alone, and found that "production blocking" (waiting for a
  turn while others talk) accounted for most of the loss.
- A meta-analysis by Mullen, Johnson and Salas (1991) found that
  brainstorming groups did worse than the same number of people working
  alone, on both quantity and quality of ideas. The loss grew with group size
  and was larger when ideas were spoken than when they were written.
- Paulus and Yang (2000) found that groups that wrote ideas and shared them
  did better than groups that did not share.

So ask the user to write their ideas for each question before you offer any,
then add yours and combine. This also stops the model's ideas from anchoring
theirs. These studies are of human groups. They have not been tested for a
person working with an AI, so treat this as a sensible practice, not a proven
one.

## Techniques

Use one or two, not all.

| Technique | How | Source |
|-----------|-----|--------|
| Crazy 8s | Fold a page into 8 boxes and sketch or write 8 distinct ideas in 8 minutes. Here: 8 one-line ideas | Google Design Sprint Kit |
| SCAMPER | Substitute, Combine, Adapt, Modify, Put to other uses, Eliminate, Reverse or rearrange: ask each about the current process | Osborn's checklist, as listed by Cambridge IfM |
| Worst possible idea | List ideas that would make it worse, then invert them | Listed in the AMA article |
| Build to think | Prototype a rough version to expose the decisions you skipped | d.school guide |

## The automation and AI fit gate

Run every candidate through these four checks before scoring it. Write the
answers in a table: candidate, toil traits met, lowest rung that works, why
not lower, why not higher, payback, risks, oversight.

### 1. Is it toil?

Google's SRE book defines toil as work that is "manual, repetitive,
automatable, tactical, devoid of enduring value, and that scales linearly as
a service grows". Count how many of the six traits the task has. Few traits
means the pain may be something else, such as a missing tool or an unclear
process. The book sets a goal of keeping toil below 50% of an SRE's time.
That is Google's goal for its own role, not a general standard.

### 2. Is it worth building?

The SRE Workbook advises ranking toil "according to the cost to fix it and the
time saved by doing so", and weighing the time saved against the time
"invested in first developing and then maintaining an automated solution".

Payback in plain arithmetic:

- Time saved per run: from a measured baseline (Observed) or a reported one.
- Runs per period: count them. Do not estimate from "often".
- Cost to build, plus upkeep over the same horizon.
- Break-even is when the saved time equals build plus upkeep. State the
  horizon you used.

Leave any unknown as TBD and say how to measure it. The SRE Workbook also
warns: "Make sure your automation doesn't create new toil", and "Repair
automation is not fire and forget". Include upkeep.

As a sanity check only, the comic "Is It Worth the Time?" (xkcd 1205) tabulates
how long you can spend on a fix over five years before it costs more than it
saves. It is a heuristic, not evidence.

### 3. What is the lowest rung that works?

Go up the ladder only when the rung below fails, and say why it fails.

| Rung | What it is | Choose it when |
|------|------------|----------------|
| 1. Change the process | Remove or merge the step | The step creates no value for the person it serves |
| 2. Checklist or template | A written standard | The pain is forgetting or inconsistency |
| 3. Script or scheduled job | Fixed rules, no judgment | Inputs are structured and the rules are stable |
| 4. One model call | One prompt, with retrieved context or examples | Language input, one clear output, a person reviews it |
| 5. Workflow | Several model calls and tools in a fixed path | The path is known but needs language or judgment at some steps |
| 6. Agent | The model chooses its own steps | Steps cannot be predicted in advance |

Rung 1 draws on lean thinking: the Lean Enterprise Institute defines waste
("muda") as "any activity that consumes resources without creating value for
the customer", and lists seven kinds after Taiichi Ohno: overproduction,
waiting, conveyance, processing, inventory, motion and correction.

Rungs 4 to 6 follow Anthropic's guidance in *Building effective agents*:
"we recommend finding the simplest solution possible, and only increasing
complexity when needed. This might mean not building agentic systems at all."
It adds that "optimizing single LLM calls with retrieval and in-context
examples is usually enough", that workflows "offer predictability and
consistency for well-defined tasks", and that agents suit open-ended problems
where the number of steps cannot be predicted, at the price of "higher costs,
and the potential for compounding errors".

### 4. Is AI the right tool here?

Google's PAIR Guidebook lists where AI is probably not better:

- maintaining predictability
- providing static or limited information
- minimizing costly errors
- complete transparency
- optimizing for high speed and low cost
- automating high-value tasks

and where it probably is: prediction of future events, natural language
understanding, and detection of low-occurrence events that change over time.
It suggests automating tasks that are "boring, repetitive, awkward, or
dangerous", and augmenting when stakes are high or people enjoy the task.

Treat each item on the first list as a red flag to explain. For any AI
candidate also record, as NIST AI RMF 1.0 "Map" asks, the intended purpose,
the users and context, and the expected benefits and costs "compared with
appropriate benchmarks". The benchmark is the current manual process,
measured. Then carry these into the stories as acceptance criteria: say how
well it works (Microsoft's HAX guideline G2), make correction easy (G9), and
narrow or gracefully degrade the service when it is unsure of the user's goal
(G10).

## Score with RICE

Intercom's RICE score is Reach times Impact times Confidence, divided by
Effort. Its author says RICE scores "shouldn't be used as a hard and fast
rule".

| Factor | How to fill it here |
|--------|---------------------|
| Reach | People or runs per period. Use one period for all candidates |
| Impact | Intercom's scale: 3, 2, 1, 0.5, 0.25, from massive to minimal. A judgment: name who made it and why |
| Confidence | Set from the evidence tag, see below |
| Effort | Person-months in Intercom's original. For small automations use person-days, the same unit for every candidate |

Confidence mapping (this skill's own, not Intercom's): Observed 100%.
Reported by two or more independent people 80%. Reported by one person, or
Assumed, 50%.

Illustration with made-up numbers, not data:

| Candidate | Reach | Impact | Confidence | Effort (days) | Score |
|-----------|-------|--------|------------|---------------|-------|
| Scheduled report script | 40 | 1 | 100% | 2 | 20 |
| Report-writing agent | 40 | 2 | 50% | 15 | 2.7 |

Alternatives, only when the team already uses them:

- **WSJF**: SAFe defines it as the "relative cost of delay divided by the
  relative job duration". It quotes Reinertsen: "If you only quantify one
  thing, quantify the Cost of Delay."
- **MoSCoW**: the Agile Business Consortium advises no more than about 60%
  of effort as Must Have, and about 20% as Could Have, to protect delivery.
- **Kano** (Kano et al., 1984): sorts features into must-be, one-dimensional
  and attractive using a customer questionnaire. It needs real respondents,
  so it rarely suits an internal automation.

## Select

The d.school guide's "considered selection": agree on three voting criteria
(it suggests "the most likely to delight", "the rational choice" and "the most
unexpected"), vote, and carry the two or three top ideas forward rather than
settle on the single idea that at least the majority of the team can agree on.
That keeps innovation
potential alive for the prototype step.

Check each survivor against IDEO's three lenses: desirable for people, viable
for the organization, feasible with technology.

Outcomes that are valid: build a script, change the process, run the test
plan before deciding, or do nothing for now. Say which one the evidence
supports.
