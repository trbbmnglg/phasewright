# Dashboard

## What it is

A progress sheet for your phased-shipping work: one local HTML file, `dashboard.html`, that shows each project, its running sessions and where each session is in the eight gates of a phase ([README](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/README.md#dashboard-page)). The dashboard data is off until you say yes, and everything the page shows is read from files on your machine. While it is off nothing rebuilds the page by itself; the `page` command is your own and still builds the page then.

Each project is one row, closed, with a one-line summary. Open it to see its sessions (each with the eight gates and any loops back), its roadmap, its estimate against actual time, and its archived sessions. A project with a working or waiting session starts open. A loop back, such as Compare back to Build, is drawn as a right-angled arrow under the gates with its count and the two step names written beside it; only the loop that is active right now moves. In progress is drawn as the logo's salmon with its diagonal hatch, which drifts slowly while a session is working (and stops with reduced motion, in print and when you pause); the header rule is a salmon stripe that flows only while a session is working. Each project row has a slim bar of its roadmap phases (shipped, in progress, planned) with a label, and the title block at the foot shows real figures: when the page was written, projects, phases shipped of all phases, sessions active and waiting, and archived sessions.

The page is built from the dashboard data ([Phased shipping](Phased-shipping) has the data layer): the status files the run writes at each step, a local list of projects, the roadmaps and the phase history. It makes no network request.

## Only standardized roadmaps are drawn

The page draws a roadmap only when it is standardized: the file has at least one table and every table has the `<!-- phased-shipping:roadmap v1 -->` marker line. Phase counts, the roadmap bar, the Roadmap figure in the title block and the Roadmaps figure of a project row count those files only. A file that is not standard (a legacy table, a file with two tables of which one has no marker, a file with no table) is not drawn. The project shows one note naming it, `N roadmap files not standardized: <names> (not drawn). Standardize them with the roadmap skill, mode standardize.`, with at most 10 names, and its row says `(N not standardized)`. A project with no standard file also says `No standardized roadmap yet.` in its Roadmap part and has no roadmap bar.

To fix it, run the roadmap skill in standardize mode on each named file ([Roadmap standard](Roadmap-standard)). The Estimate against actual part still shows, because it is built from the history; a phase that is in no standard roadmap shows its id alone. The merged JSON still holds the data of the other files, with `standard: false`.

## How to use it

```text
/phased-shipping:dashboard enable
/phased-shipping:dashboard page
```

1. `enable` is your yes. From then on, each status call the run makes at a step also rebuilds the page, and so does `unregister`, so a project you remove leaves the page. `disable` stops the rebuilds and leaves the page as it was last written.
2. `page` builds it on demand and tells you where the file is: `dashboard.html` inside the phased-shipping data folder. Open it in a browser.
3. The page reloads itself every 10 seconds by default (`page [refresh seconds]` takes 5 to 300). It holds while you select text or hover a cut-off title, and a Pause button stops the refresh.
4. A session shows Working, Waiting for you, Done or Idle. By default a working session with no update for 90 minutes gets a warning, and no update for 180 minutes shows as Idle.

A failed rebuild never fails a status call: it prints one line, `page not rebuilt (<reason>)`, and the run goes on.

## What shipped when

- Plugin version 0.10.0 added the page script, its style and client script, the fonts, the `page` mode and the rebuild at each status call ([CHANGELOG](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)). No guard rule changed.
- Session files gained an optional trail of step and state changes (at most 40), and the merged JSON gained loops, rounds, visits, time worked, estimates and a summary for each project.
- This is part of [v1.1.0](Release-1.1.0-Baggao), which is in progress.
- Tests: [dashboard-page.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/dashboard-page.test.mjs) and [dashboard.test.mjs](https://github.com/trbbmnglg/phasewright/blob/main/tests/dashboard.test.mjs).

## Limits

- A project is the repository around the folder that holds `PHASES.md` (the nearest folder up to 40 levels above that has a `.git` entry, never one at your home folder or above), so a roadmap in `docs/roadmap` is one project with its repository; with no repository the folder itself is the project. Where the system has user ids, a `.git` that another user owns is not trusted and the folder itself is the project. Two roadmap folders in one repository are one project, and their sessions are kept per roadmap and phase, so the same phase id in both does not overwrite; a folder whose roadmap path is not usable (too deep, or a folder name with a character that is not allowed) keeps a session file of its own, with a `u` in its name and no roadmap, title or estimate. Existing entries in the project list are never migrated: a command that does not change the list leaves the file as it is, a stored roadmap that is not a usable path is ignored when the list is read, and a command that writes the list drops such entries (and repeats of the same path).
- Session files of an earlier version (`<id>-<phase>.json`) are read, and are never written, taken over or removed by `set` or `clear`; they age out as Idle and are then archived like any session. When one of them and a newer file of the same project and phase both exist, only the newer is shown (with two or more files of different roadmaps for that phase, all of those are shown and the older-form file is the one left out). The page shows at most 100 sessions (the newest by last update, a clock-skewed one counting as the oldest); only the newest 250 session files by modified time are opened, and a quiet note says how many older files were not opened.
- The Estimate against actual table is built from the history log (the actual hours come from timestamps, so they include any time the run waited for you), plus shipped rows of a standard roadmap that have an Actual and no history record.
- The salmon is used only on borders, strokes and hatching; on the light page it is the light logo's `#B33A0B`, because the pale `#FFB28F` is 1.6:1 against the light page. "Waiting for you" has its own accent, a different tone, and keeps its square stamp.
- The page is tested by reading its text and by running its script's source through checks. Nobody has run it in a real browser as part of the tests, so the look, the animation and the script's behaviour in a browser are not covered by them.
- Text from your files (a project name, a phase title) is untrusted. The page cleans it, escapes it and puts it only in element text or a quoted attribute. That is checked for the cases the tests try, not for every possible string.
- The page holds the policy `default-src 'none'`, with no outward link and no request made by its script. A browser extension or a browser setting is outside it.
- Archived means a session that is done and more than 7 days old. It is this tool's own word; it is not Claude Code's own archive, which this tool cannot read.
- The fonts are subsets of IBM Plex under the SIL Open Font License 1.1, given new names (PW Sans and PW Mono, with PostScript names starting `PWSans-` and `PWMono-`) because the licence reserves the name "Plex"; only the copyright and licence records of each font keep the Plex notice, as the licence requires. The licence text is `assets/OFL.txt`. `--no-fonts` leaves them out and the page falls back to system fonts.
- On a narrow screen the phase flow scrolls sideways instead of wrapping, so the loop arrows keep their shape; a hint above it says so.
- The page has a soft limit of 256 KB and a hard limit of 1 MB. Over the soft limit the Roadmap and Estimate tables of projects with no working or waiting session become one note line ("left out to keep the page small: N rows; the dashboard JSON still has them"), the largest saving first; if it is still over, the tables of projects with a running session go the same way, and a visible line at the top says so. A project's row, its sessions (a waiting one always) and its archived sessions always stay. A page still over the hard limit of 1 MB is not written, and the data folder is never created by the page script.
- The refresh, the Pause button, the clocks and the 90-minute stale banner need JavaScript. With it off the page shows the times as written, hides the Pause button and the refresh text (in the header and the footer), and a notice says nothing refreshes.
- No path the tool builds appears in the page. Text copied from your files is shown as written (known path forms of this machine are replaced), so do not put paths in plan text.
- The page is only as current as the last write. If the run stops, a banner appears after 90 minutes without a rewrite (the same time as the per-session "No update" warning) and says how long it has been.

## Source

- [plugins/phased-shipping/skills/dashboard/SKILL.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/dashboard/SKILL.md)
- [plugins/phased-shipping/skills/dashboard/scripts/page.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/dashboard/scripts/page.mjs)
- [plugins/phased-shipping/skills/dashboard/scripts/status.mjs](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/dashboard/scripts/status.mjs)
- [plugins/phased-shipping/skills/dashboard/references/status.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/skills/dashboard/references/status.md)
- [plugins/phased-shipping/CHANGELOG.md](https://github.com/trbbmnglg/phasewright/blob/main/plugins/phased-shipping/CHANGELOG.md)
