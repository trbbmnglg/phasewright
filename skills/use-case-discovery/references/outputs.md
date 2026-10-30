# Outputs: the pack, the summary, the import files

Read from [SKILL.md](../SKILL.md) steps 6 and 7. Contents: consent, layout,
file templates, the summary, `backlog.json`, importing.

## Before writing anything

1. Confirm the folder with the user, even if step 0 proposed one.
2. List the files you will create. Create only these.
3. If the folder or any file already exists, read `00-brief.md` and resume.
   Do not overwrite a file this run did not create. Ask first.
4. If the topic is sensitive, suggest adding the folder to `.gitignore` and
   keep the detail low.
5. Report a path only after the write succeeded.

## Layout

```
docs/discovery/<topic-slug>/
  00-brief.md      topic, audience, mode, sources, status by step
  01-evidence.md   the evidence log (E1...)
  02-insights.md   clusters, maps, pain points (PP1...), POV, HMW
  03-options.md    ideas, fit gate table, RICE, what moves forward
  04-use-cases.md  use cases (UC1...)
  05-stories.md    stories (US1...) with acceptance criteria
  06-metrics.md    metric cards (M1...)
  07-test-plan.md  test plan cards (T1...)
  summary.md       the one-page brief
  export/          backlog.json, jira.csv, azure-devops.csv
```

The topic slug is lower case letters, digits and hyphens, starting with a
letter or digit and at most 60 characters long.

Quick mode writes the same files with shorter content.

## Templates

`00-brief.md`:

```markdown
# <Topic>

| Field | Value |
|-------|-------|
| Audience | delivery automation / solo developer / team / AI prompts |
| Mode | Quick or Full |
| Evidence sources | interview, notes, repository, tickets |
| Provisional | yes or no, and why |
| Date started | YYYY-MM-DD |
| Revision | 1 |

| Step | Status | Notes |
|------|--------|-------|
| Empathize | done / in progress / not started | |
| Define | | |
| Ideate | | |
| Specify | | |
| Test plan | | |
| Export | | |
```

Update the status table at the end of each step. To upgrade Quick to Full,
change the mode, keep every ID, and add what Full requires.

`01-evidence.md`:

```markdown
| ID | Statement or measurement | Source | Tag | Date | Note |
|----|--------------------------|--------|-----|------|------|
| E1 | The handover note is rewritten by hand each Friday | P1 interview | Reported, n=1 | YYYY-MM-DD | Not yet confirmed |
```

The other numbered files use the tables in the matching reference:
`02-insights.md` the pain-point register and POV from
[define.md](define.md), `03-options.md` the fit gate and RICE tables from
[ideate-and-select.md](ideate-and-select.md), `04-use-cases.md`,
`05-stories.md` and `06-metrics.md` from [specify.md](specify.md), and
`07-test-plan.md` the cards from [test-plan.md](test-plan.md).

## The one-page summary

`summary.md` fits one page, about 300 words, for someone who was not in the
room:

1. **Problem:** the point of view in two sentences.
2. **Evidence:** how many sources, what kind, and the weak points. Say "one
   person" when it is one person.
3. **Top use cases:** up to three, ranked, each with the fit-gate rung and
   score.
4. **Measures:** the primary metric for each, with baseline and target or TBD.
5. **Next test:** the riskiest assumption and the test.
6. **Decisions needed:** who must decide what.
7. **Limits:** what this pack does not show.

## backlog.json

The exporter reads this file, version 1. It checks the file and stops with a
message on any error: a missing field, a duplicate ID, an unknown field, a
parent that is not an epic, an over-long value. Epics group stories; they do
not carry acceptance criteria.

```json
{
  "version": 1,
  "topic": "Weekly release note",
  "items": [
    {
      "id": "EP1",
      "type": "epic",
      "title": "Produce the weekly release note",
      "description": "Use case UC1. Pain point PP1."
    },
    {
      "id": "US1",
      "type": "story",
      "parent": "EP1",
      "title": "Flag changes that have no customer description",
      "description": "As a release lead, I want changes without a customer description to be flagged, so that I can write one before sending.",
      "acceptanceCriteria": [
        "Scenario: A change with no description is flagged\nGiven a merged change has no description\nWhen the note is built\nThen the change is listed under Needs a description"
      ],
      "priority": 2,
      "tags": ["release-note", "automation"],
      "trace": ["UC1", "PP1", "E4"]
    }
  ]
}
```

Fields: `id` (letters, digits, `_`, `-`, up to 32, unique), `type` (`epic` or
`story`), `title` (1 to 255 characters), `description` (optional text),
`acceptanceCriteria` (stories only, a list of text), `priority` (1 to 4,
optional), `tags` (optional, no commas or semicolons), `parent` (a story's
epic, optional), `trace` (IDs, optional). Leave out a field rather than
filling it with a guess.

## Importing

Run the exporter as step 7 of [SKILL.md](../SKILL.md) says. It writes the
files next to `backlog.json`. Tell the user what each file is, then advise
a trial import of three rows into a scratch project before the real one.

**Azure Boards** (Microsoft Learn, page metadata dated 2026-07-23):

- The file must have Work Item Type and Title. Microsoft says to leave out
  Assigned To, Changed Date, Created By and State for new items, and to give
  new items no ID (assigning one causes an error).
- Up to 1,000 work items per import. The exporter splits larger sets into
  numbered files and keeps each epic with its stories.
- Parent and child rows use indented title columns (Title 1, Title 2).
  Microsoft's parent-child example adds children under an existing epic: it
  has an ID column, with the epic's ID and empty IDs on the new child rows. It
  does not show a file where the parent is new too, and elsewhere Microsoft
  says to leave the ID out for new items. The exporter writes an empty ID
  column, as the example does for new rows. The `--flat` option leaves out the
  ID column and the hierarchy, and puts the epic's title in each story's
  description. Use it if the hierarchy import fails.
- State is New after import. Area and Iteration default to the top level.
- Work item types and fields depend on the process (Agile, Scrum, CMMI).
  Pick the matching `--process`. A custom process needs the names edited.
- Import from Boards, then Queries, then Import work items. Items arrive
  unsaved: review them, fix any in red, then save.

**Jira** (Atlassian, *Prepare a CSV file for import*):

- Summary is always required. The importer uses the header row to map the
  columns to fields.
- Fields containing commas or line breaks are quoted, and a literal double
  quote is doubled. The exporter does both for every field.
- Repeated Label columns hold several labels. The exporter turns spaces in a
  label into hyphens, a cautious choice: the page does not say how spaces are
  handled.
- Hierarchies use Work item ID and Parent columns, where Parent is the work
  item ID of the parent. The exporter writes plain numbers so that IDs are
  unique. The discovery ID is in the description.
- This skill's own choice: Priority is left out of the Jira file, because the
  page does not cover it.

**Spreadsheet safety.** OWASP's CSV injection page warns that a cell starting
with `=`, `+`, `-` or `@`, a tab, a carriage return or a line feed, or the
full-width forms of the four symbols, can run as a formula when the file is
opened in a spreadsheet. The exporter puts a single quote in front of such a
cell, which shows as an apostrophe after import. OWASP also warns: "There is
no universal CSV sanitization strategy that is safe for all spreadsheet
applications and all downstream consumers." It adds that Excel may remove
quotes or escape characters when a CSV is saved and re-opened. Import the CSV
file directly. Do not open it and save it in a spreadsheet first.
