# Define: make sense of it

Read from [SKILL.md](../SKILL.md) step 2. Contents: clustering, empathy map,
journey map, the pain-point register, root cause, the point of view, "How
might we", the job lens, done.

The d.school guide calls this mode "sensemaking": the goal is "a meaningful
and actionable problem statement", which it calls a point of view. Insights
"don't often just jump in your lap". They come from looking for connections
and patterns in what you gathered.

## Cluster the evidence

1. Put each evidence entry on its own line with its ID.
2. Group entries that point to the same underlying need or situation.
3. Name each group by the need ("needs to know what changed without reading
   every commit"), not by a solution ("a changelog bot").
4. Move entries between groups until the groups hold. Note entries that fit
   nowhere: they may be a different problem.
5. Count entries and distinct people per group. Many entries from one person
   is one voice.

## Empathy map (Full mode)

NN/g describes it as "a collaborative visualization that captures what we
know about a particular user or about a user segment", with four quadrants:
Says, Thinks, Does, Feels.

- Fill each quadrant only from evidence entries and cite their IDs.
- Anything with no source is an assumption. Label it a hypothesis and list it
  for the test plan.
- Do not have the model invent thoughts or feelings. Thinks and Feels come
  from what a person said, or stay blank.

## Journey map (Full mode)

NN/g: "a visualization of the process that a person goes through in order to
accomplish a goal". Components: the actor, a scenario and expectations,
phases, actions, mindsets and emotions, and opportunities.

Build one map per actor and scenario. Rows: phase, action, tool, pain
(PP IDs), evidence IDs. Mark a step Observed only if it was watched or
logged. A step a person described is Reported.

## The pain-point register

| ID | Situation | Who | How often | What it costs | Evidence | Tag |
|----|-----------|-----|-----------|---------------|----------|-----|
| PP1 | Handover note rewritten by hand | Release lead (P1) | Weekly | TBD: time not measured | E4, E7 | Reported, n=1 |

Rules:

- Frequency and cost come from evidence. If nobody has measured them, write
  TBD and add "measure" to the test plan.
- Severity, if used, is a plain three-level scale, defined here as this
  skill's own: 1 annoyance, 2 slows the work down, 3 blocks the work or
  causes errors that need rework. Do not add decimals.
- Rank by evidence and cost together. A frequent small cost can beat a rare
  large one. Show the reasoning.

## Root cause (optional)

Use a root-cause tool only when the cause is unclear and the pain is worth it.

- **Five Whys.** Ask why up to about five times, until you reach something you
  can act on. AHRQ's PSNet summarizes a BMJ Quality & Safety paper (Card,
  2017) as noting that the method "tends to simplify complex problems and
  limit understanding of how processes fail". It follows a single chain of
  causes, so if more than one cause is plausible, branch.
- **Fishbone (cause and effect).** Draw the problem as the head. Add branches
  for areas such as method, tools, people, environment, and list causes on
  each. It shows several causes at once. It does not rank them.

Tag each cause by its evidence. A cause that nobody confirmed is Assumed.

## The point of view

The d.school guide: combine "user, need, and insight" into one actionable
problem statement. A suggested wording, which is this skill's own:

> [User, with their context] needs [a need, in a verb phrase] because
> [an insight: the surprising, evidence-based reason].

The insight is the part that makes it more than a restated request. "The
release lead needs a shorter release note" restates. "The release lead needs
to know which changes matter to customers, because the commit titles are
written for developers and every note is rewritten by hand" gives the reason.

The guide says a good point of view:

- provides focus and frames the problem
- inspires your team
- informs criteria for evaluating competing ideas
- empowers your team to make decisions independently in parallel
- captures the hearts and minds of people you meet
- saves you from trying to make something for everyone, so it is "discrete,
  not broad"

It also says a narrower statement "tends to yield both greater quantity and
higher quality solutions". That is the guide's own claim, not a measured
result here.

Check: does it name one user and one need? Does the insight cite evidence?
If the insight rests only on Assumed entries, say so and put the first test
there.

## How might we

The guide recommends turning the point of view into a list of "How-Might-We"
brainstorming topics. "These brainstorming topics typically are subsets of the
entire problem, focusing on different aspects of the challenge." A good test:
if brainstorming topics fall naturally out of the point of view, it is well
scoped.

- Write 3 to 5.
- Too broad ("How might we make delivery better?") gives no ideas worth
  keeping. Too narrow ("How might we add a button here?") hides a solution.
  The AMA article gives the same caution.
- Example: "How might we let the release lead see which changes matter to
  customers without reading every commit?"

## The job lens (optional)

The Christensen Institute describes a job to be done as "the progress they're
trying to make", and says jobs involve functional, social and emotional
forces. Use it as a prompt: what progress is this person trying to make, and
what else could make that progress today? That is how to find the real
alternatives to a new build, such as a spreadsheet or a person.

## Done when

- Each ranked pain point cites evidence IDs and carries a tag.
- One point of view is written and passes the checks above.
- 3 to 5 "How might we" questions follow from it.
- Open assumptions are listed for the test plan.
