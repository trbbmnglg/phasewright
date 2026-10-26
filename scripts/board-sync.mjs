// Keeps the GitHub Project in step with what ships. Reads commit messages for a
// short convention and updates the matching issues and Project items:
//
//   Ships #17        closes the issue; Status=Shipped; Actual hours, Deploy, Commit filled in
//   Fixes #44        the same, for a bug (also "Closes #N")
//   Opens #18        Status=In progress (a phase is starting)
//   Hours: 3.1       applied to every issue the commit ships or fixes
//   Deploy: 4f2a9c1e the same
//
// It runs in GitHub Actions on every push (see .github/workflows/board-sync.yml)
// and by hand:
//
//   node scripts/board-sync.mjs --message "Ships #17\nHours: 3\nDeploy: abc" --sha 1234567 [--dry-run]
//   node scripts/board-sync.mjs --range <before>..<after> [--dry-run]
//
// The token (env GH_TOKEN) needs the `project` and `repo` scopes: the token
// GitHub gives an Action can't edit a personal Project. The script never prints it.
// Commit messages are read as data and never put into a shell command.

import { execFileSync } from "node:child_process";
import { commitShas } from "./board-range.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const DRY = args.includes("--dry-run");
const REPO = process.env.BOARD_REPO || process.env.GITHUB_REPOSITORY || "trbbmnglg/phasewright";
const OWNER = process.env.BOARD_OWNER || REPO.split("/")[0];
const NUM = Number(process.env.BOARD_PROJECT || 2);

const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const gql = (query, vars = {}) => {
  const a = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) a.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  return JSON.parse(gh(...a)).data;
};
const git = (...a) => execFileSync("git", a, { encoding: "utf8" });

// ── The commits to read ─────────────────────────────────────────────────────
function commits() {
  if (opt("message")) return [{ sha: opt("sha", "0000000"), message: opt("message").replace(/\\n/g, "\n") }];
  const range = opt("range") || (process.env.BEFORE && process.env.AFTER ? `${process.env.BEFORE}..${process.env.AFTER}` : "HEAD~1..HEAD");
  return commitShas(range, git).map((sha) => ({ sha, message: git("log", "-1", "--format=%B", sha) }));
}

function parse(message) {
  const ships = new Set(), opens = new Set();
  for (const m of message.matchAll(/^\s*(ships|fixes|closes|opens)\s+((?:#\d+\s*[,&]?\s*)+)/gim)) {
    const nums = [...m[2].matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
    for (const n of nums) (m[1].toLowerCase() === "opens" ? opens : ships).add(n);
  }
  const hours = message.match(/^\s*hours\s*:\s*([\d.]+)/im);
  const deploy = message.match(/^\s*deploy\s*:\s*(\S.*?)\s*$/im);
  return { ships: [...ships], opens: [...opens], hours: hours ? Number(hours[1]) : null, deploy: deploy ? deploy[1].slice(0, 80) : "" };
}

// ── The Project ─────────────────────────────────────────────────────────────
const project = gql(`query($o:String!,$n:Int!){ user(login:$o){ projectV2(number:$n){ id fields(first:40){ nodes{
  ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name options{ id name } } } } } } }`, { o: OWNER, n: NUM }).user.projectV2;
const field = (name) => project.fields.nodes.find((f) => f.name === name);
const optionId = (fname, oname) => field(fname)?.options?.find((o) => o.name === oname)?.id;

function itemOf(issue) {
  let d;
  try {
    d = gql(`query($o:String!,$r:String!,$i:Int!){ repository(owner:$o,name:$r){ issue(number:$i){ id state title projectItems(first:10){ nodes{ id project{ id } } } } } }`,
      { o: REPO.split("/")[0], r: REPO.split("/")[1], i: issue }).repository.issue;
  } catch (e) {
    // A number that isn't an issue here (a typo, or a pull request) is skipped, so the other issues
    // in the same commit are still updated. Anything else (auth, network) still fails the run.
    if (/NOT_FOUND|Could not resolve to an Issue/.test(`${e.stdout ?? ""}${e.stderr ?? ""}`)) return { title: undefined, state: undefined, item: null };
    throw e;
  }
  const item = d?.projectItems.nodes.find((n) => n.project.id === project.id);
  return { title: d?.title, state: d?.state, item: item?.id ?? null };
}

function setField(item, fname, value, kind) {
  const f = field(fname);
  if (!f) return;
  const v = kind === "select" ? `{singleSelectOptionId:"${optionId(fname, value)}"}` : kind === "number" ? `{number:${value}}` : `{text:${JSON.stringify(value)}}`;
  if (kind === "select" && !optionId(fname, value)) return;
  if (DRY) return;
  gql(`mutation($p:ID!,$i:ID!,$f:ID!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:${v}}){ projectV2Item{ id } } }`, { p: project.id, i: item, f: f.id });
}

const log = [];
for (const c of commits()) {
  const p = parse(c.message);
  const short = c.sha.slice(0, 7);
  for (const n of p.opens) {
    const { item, title } = itemOf(n);
    if (!item) { log.push(`#${n}: not on the board, skipped`); continue; }
    setField(item, "Status", "In progress", "select"); setField(item, "Stage", "In progress", "select");
    log.push(`#${n} ${title}: In progress`);
  }
  for (const n of p.ships) {
    const { item, state, title } = itemOf(n);
    if (state === undefined || title === undefined) { log.push(`#${n}: not found, skipped`); continue; }
    if (state === "OPEN" && !DRY) gh("issue", "close", String(n), "-R", REPO, "--reason", "completed", "--comment", `Shipped in ${short}${p.deploy ? ` (deploy ${p.deploy})` : ""}.`);
    if (!item) { log.push(`#${n} ${title}: closed; not on the board`); continue; }
    setField(item, "Status", "Shipped", "select"); setField(item, "Stage", "Shipped", "select");
    if (p.hours != null) setField(item, "Actual hours", p.hours, "number");
    if (p.deploy) setField(item, "Deploy", p.deploy, "text");
    setField(item, "Commit", short, "text");
    log.push(`#${n} ${title}: Shipped${p.hours != null ? `, ${p.hours} h` : ""}${p.deploy ? `, deploy ${p.deploy}` : ""}, commit ${short}`);
  }
}

if (!log.length) { console.log("Board sync: no Ships, Fixes or Opens lines in these commits."); process.exit(0); }
console.log(`Board sync${DRY ? " (dry run, nothing written)" : ""}:\n  ${log.join("\n  ")}`);
