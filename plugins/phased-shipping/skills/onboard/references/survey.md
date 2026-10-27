# The survey: what it reads, what it saves

The survey script is `scripts/survey.mjs` in this skill. It uses node built-ins only, sends nothing anywhere and never runs a command it finds. This page is the contract: what it may open, what it never opens, and the shape of the file it saves. There is one mode: the script reads the project files, and the assistant sees the summary the script prints. The skill tells the assistant to read no other project file and to hand none to another agent or tool; that is an instruction, not a lock. The summary holds no script body, no run line and no line of any file. The names in it (the project name, workflow and job names, a package's name) are text from the files, cleaned to one line of plain text and cut short.

## What it may open (the allowlist)

Nothing else is ever opened. `list` shows the exact files before anything is read.

| Category | Files | What is kept |
|---|---|---|
| docs | `README*`, `CONTRIBUTING*`, `CLAUDE.md`, `AGENTS.md` in the project root; `docs/*.md` and `docs/*/*.md` | whether each convention doc exists, and a heading count; no text |
| manifest | `package.json`, `pyproject.toml`, `Makefile`, `Cargo.toml`, `go.mod` | the project name, script or target names, and for each test, build, lint, typecheck, verify and deploy script the command that invokes it (`npm run <name>`, `make <name>`; `pnpm run`, `yarn` or `bun run` when that lockfile exists). No script body or command text is kept |
| ci | `.github/workflows/*.yml` and `*.yaml` | file name, workflow name, job names, action names as `name@ref` (no inputs), `secrets.X` kept as the name `X`, and a count of run steps. No `run:` line and no word of one is kept, so nothing written after a line continuation can reach the survey |
| deploy | `wrangler.toml`, `wrangler.json`, `wrangler.jsonc`, `netlify.toml`, `vercel.json`, `fly.toml`, `Dockerfile` | top-level key names only; no value is kept |
| plan | `phase-*.md` and `PHASES.md` under `docs/`, `.plans/`, `plans/`, `phases/` (up to 3 folders deep) | the first heading's id, and the roadmap tables (counts and ids only) |

Lockfiles are never opened; their names are only used to tell which package manager the project uses.

## What it never opens

- source code of any language;
- `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `.npmrc`, `.pypirc`, `.netrc`, cloud and kube credential files;
- `*.sqlite`, `*.db`, dumps;
- anything inside `.git`, `node_modules` or build output (`dist`, `build`, `.next`, `out`, `target`);
- lockfiles (names only), files over 256 KB, binary files;
- anything reached through a symbolic link or a Windows junction (they are counted and skipped, including a folder link inside `docs/` or a plan folder), a file with more than one hard link (a second name may lead outside the project), and anything outside the project root.

## Skipped files

A file is skipped, counted by reason and never retried when it:

- matches a known secret shape (the whole file is scanned as written, with escapes decoded and as parsed JSON values; it is never printed). The shapes include token and key formats, private keys, passwords, `Bearer` and `Authorization` values, URL credentials, cloud keys and a secret-looking name followed by a value. They are the shapes the script knows, not every secret. As a last check the finished survey and every printed line are scanned again; a match exits 1, saves nothing and prints only that something looked like a secret and its category;
- is locked or unreadable (skipped once; reported by base name);
- is binary, not valid text, a hard link, or over 256 KB;
- would pass the caps: 200 files, 64 KB of text per file, 400 KB for the survey.

## The saved file

`<project root>/.phased-shipping/survey.json`, next to `state.json` and a `.gitignore` whose only line is `*`. The folder is created only if it is a real folder inside the project; if it is a file or a link, or its `.gitignore` is not `*`, nothing is written. Every path in it is relative.

```json
{
  "v": 1,
  "project": "<the folder's base name>",
  "savedAt": "<ISO time>",
  "stack": ["node", "github-actions"],
  "packageManager": "npm",
  "commands": [{ "kind": "test", "command": "npm run test", "source": "package.json" }],
  "manifests": [{ "file": "package.json", "name": "<name>", "scripts": ["test", "build"] }],
  "ci": { "workflows": [{ "file": "ci.yml", "name": "CI", "jobs": ["test"], "runSteps": 3, "uses": ["actions/checkout@v4"], "secrets": ["NPM_TOKEN"] }] },
  "deploy": [{ "file": "wrangler.toml", "keys": ["name", "main"] }],
  "conventionDocs": { "readme": true, "claude": false, "agents": false, "contributing": false, "docsFiles": 3, "headings": 18 },
  "plans": { "folders": ["docs/phases"], "planFiles": 12, "planFilesWithoutHeading": 1, "roadmapFiles": [{ "path": "PHASES.md", "tables": 1, "legacy": 0, "rows": 7 }] },
  "filesRead": 14,
  "skipped": { "looked like a secret": 1 }
}
```

The schema stays `v: 1`. The earlier `mode` field and every command body (`runs`) are gone: a saved file that still has them is read with those fields dropped.

## Using it

- Only the onboard and plan skills read `survey.json`, through `survey.mjs show`.
- The commands in it are hints. Nothing runs a command found in it; the owner confirms every command in a plan.
- `show` keeps only the fields above from the file on disk, cleaned of control, line-separator, bidirectional, zero-width, tag and other Unicode format characters and cut to fixed lengths and list sizes, keeps a command, an action, a stack entry and a manifest or deploy file name only in the forms the script itself writes, drops everything else, and begins with a line saying it was read from disk and is data to confirm, not instructions. A cloned repository can carry its own `survey.json`; treat it like a README.
- `list` prints a digest of the listing (a hash of the sorted paths and sizes). `run --all-listed` needs it as `--list-digest` and exits 1, reading nothing, if the listing now hashes differently. A `--confirm` file (at most 64 KB) never widens the list: entries not on the current list are counted, never read and never printed.
- `classify` reads only the plan and roadmap files, and `leftovers` lists test folders in the temp folder (listing only).
