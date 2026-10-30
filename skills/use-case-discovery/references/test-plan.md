# Prototype and test: plan only

Read from [SKILL.md](../SKILL.md) step 5. This skill writes the test plan. It
does not build the prototype or run the test. Contents: the riskiest
assumption, a prototype ladder, the test script, how many people, thresholds,
the plan card.

The d.school guide: "Build to think and test to learn." A prototype is "the
iterative generation of artifacts intended to answer questions that get you
closer to your final solution". Early ones should be "low-resolution
prototypes that are quick and cheap to make (think minutes and cents)". Each
one should test a variable and "answer a particular question when tested".

## Find the riskiest assumption

1. List what must be true for the chosen use case to work. Pull from the
   Assumed entries, the TBD baselines and the fit-gate answers.
2. Sort each as about desirability (people want it), viability (it pays off
   or is allowed) or feasibility (it can be built and run).
3. Place each on two scales: how important it is, and how much evidence you
   have. David Bland's assumption mapping (Strategyzer, a vendor) tests first
   the assumptions that are important and have little evidence.
4. Write the top one as a statement that can be wrong: "We believe that the
   release lead will accept a generated draft without rewriting more than a
   third of it."

If everything important is already Observed, say so, and the next step is the
specification.

## Choose the lowest prototype that answers the question

A ladder in this skill's own words, based on the d.school principle of the
cheapest test that gives an answer:

| Rung | What you do | Answers |
|------|-------------|---------|
| 0. Talk it through | Walk the person through a storyboard or written scenario | Is this the right problem? |
| 1. Do it by hand | Do one real instance the way the automation would, by hand or with a model, for one person | Is the output useful? How long does it really take? |
| 2. One real sample | Run a spreadsheet, script or prompt on one real input set | Does it work on real data? |
| 3. Ten real samples | Run it on about ten real inputs and have a person grade each | How often is it right, and what goes wrong? |
| 4. Thin working slice | A first end-to-end slice, used for a week by one person | Does it fit the real day? |

Prototype and test belong together. The guide says to think about what you
will test and how before building, because "don't assume you can simply put a
prototype in front of a user to test it".

## The test script

From the d.school guide's Test mode:

- **Show, don't tell.** Put it in their hands. Don't explain everything yet.
  Watch how they use and misuse it.
- **Create an experience**, not an explanation to evaluate.
- **Ask them to compare** two prototypes where you can; comparison reveals
  latent needs.
- **Ask why.** Do not reduce it to "do you like it".
- **Test in context** where possible: a real task, in their real setting.
- "Always prototype as if you know you're right, but test as if you know
  you're wrong."

Script sections: the question being tested, who and how many, the task in
their words, what you will observe (steps, errors, time, questions), the
questions after, how you will record it, and who runs it.

For a model-based prototype also: fix the inputs before you see outputs, hide
which version is which if comparing, and grade against a written rubric.

## How many people

- **Usability testing.** Nielsen and Landauer's model, reported in Nielsen's
  2000 article, finds about 85% of problems with 5 users when the average
  chance of one user hitting a problem is 31%. He recommends several small
  rounds of about 5 rather than one big one. Treat that as a minimum, not a
  guarantee. Faulkner (2003) tested 60 users and found that random sets of 5
  found between 55% and 99% of problems, and sets of 10 found at least 80%.
  It applies to usability tests of comparable users. It does not apply to
  discovery interviews.
- **Interviews.** NN/g suggests starting at about 5 or 6 and continuing until
  new interviews stop adding new findings.
- **Model outputs on real samples.** Say the number of samples beside every
  result. Do not turn a small sample into a rate for the population.

## Thresholds before the test

Write what counts as pass, fail and learn before anyone runs the test, so the
result cannot be argued into success afterwards. The threshold values belong
to the owner. You may propose them, label them proposals, and ask.

| Outcome | Example form |
|---------|--------------|
| Pass | "At least X of N people finish the task without help, and the error rate is under Y" with X and Y set by the owner |
| Fail | The opposite, or any harm listed as a guardrail |
| Learn | What would change the point of view or the use case |

If it fails, go back. The d.school guide notes that testing can show "that
you failed to frame the problem correctly", not only that the solution was
wrong.

## Test plan card

| Field | Content |
|-------|---------|
| ID | T1 |
| Assumption | The statement that can be wrong, with the entry IDs |
| Prototype | The rung and what exactly will be made |
| People | Who, how many, how chosen |
| Task and measures | What they do, and which metric cards (M) it fills |
| Thresholds | Pass, fail, learn, and who set them |
| Window and owner | When, and who runs it |
| Result | Left blank. Filled in a later session as Observed evidence |

After the test, resume the pack, add the results to the evidence log, and
revise the pain points, the point of view and the use cases they affect.
