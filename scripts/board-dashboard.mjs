// A dashboard for a GitHub Project: releases, phases and sub-phases with progress,
// hours, deploys and open bugs, read live from GitHub through the gh CLI and
// written to one self-contained page (no network, no scripts).
//
//   node scripts/board-dashboard.mjs [--owner trbbmnglg] [--project 2] [--out .board/dashboard.html] [--plans "where plans live"]
//
// Needs `gh` signed in with the project scope. The page is for the owner's eyes
// and is git-ignored (.board/); regenerate it at every phase close.
// The project needs the fields Status, Release, Kind, Priority, Level, Est hours,
// Actual hours, Deploy and Commit, and uses sub-issues for the hierarchy.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const OWNER = opt("owner", "trbbmnglg");
const NUM = Number(opt("project", 2));
const OUT = resolve(opt("out", ".board/dashboard.html"));
const PLANS = opt("plans", "");

const QUERY = `query($o:String!,$n:Int!,$after:String){ user(login:$o){ projectV2(number:$n){ title url shortDescription items(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{ id
  content{ ... on Issue { number title url state closedAt labels(first:10){nodes{name}} parent{number} subIssuesSummary{total completed} } }
  fieldValues(first:20){ nodes{
    ... on ProjectV2ItemFieldSingleSelectValue { name field{ ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldNumberValue { number field{ ... on ProjectV2FieldCommon { name } } }
    ... on ProjectV2ItemFieldTextValue { text field{ ... on ProjectV2FieldCommon { name } } } } } } } } } }`;

function gql(after) {
  const a = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `o=${OWNER}`, "-F", `n=${NUM}`];
  if (after) a.push("-f", `after=${after}`);
  return JSON.parse(execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).data.user.projectV2;
}

let project = gql(null);
const nodes = [...project.items.nodes];
let page = project.items.pageInfo;
while (page.hasNextPage) { const next = gql(page.endCursor); nodes.push(...next.items.nodes); page = next.items.pageInfo; }

const items = nodes.filter((n) => n.content?.number).map((n) => {
  const f = {};
  for (const v of n.fieldValues.nodes) if (v?.field?.name) f[v.field.name] = v.name ?? v.number ?? v.text;
  return {
    number: n.content.number, title: n.content.title, url: n.content.url, open: n.content.state === "OPEN",
    labels: n.content.labels.nodes.map((l) => l.name), parent: n.content.parent?.number ?? null,
    subs: n.content.subIssuesSummary, stage: f.Status ?? f.Stage ?? "Backlog", release: f.Release ?? "", kind: f.Kind ?? "",
    priority: f.Priority ?? "", level: f.Level ?? "Task", est: f["Est hours"] ?? null, actual: f["Actual hours"] ?? null,
    deploy: f.Deploy ?? "", commit: f.Commit ?? "",
  };
});
const byNum = new Map(items.map((i) => [i.number, i]));
const kids = (n) => items.filter((i) => i.parent === n).sort((a, b) => a.number - b.number);
const releases = items.filter((i) => i.level === "Release").sort((a, b) => a.number - b.number);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const h = (n) => (n == null ? "" : `${Number(n).toFixed(Number(n) % 1 ? 1 : 0)} h`);
const leaves = (i) => { const k = kids(i.number); return k.length ? k.flatMap(leaves) : [i]; };
const work = items.filter((i) => i.level !== "Release" && !kids(i.number).length);   // every leaf issue
const count = (st) => work.filter((i) => i.stage === st).length;
const estShipped = work.filter((i) => i.stage === "Shipped" && i.est != null && i.actual != null);
const sum = (xs, k) => xs.reduce((n, i) => n + i[k], 0);
const bugs = work.filter((i) => i.labels.some((l) => l === "bug" || l === "security") && !i.labels.includes("idea"));
const openBugs = bugs.filter((i) => i.open);
const active = work.filter((i) => i.stage === "In progress" || i.stage === "Planned").sort((a, b) => (a.stage === b.stage ? a.number - b.number : a.stage === "In progress" ? -1 : 1));

const chip = (st) => `<span class="chip s-${st.replace(/\s+/g, "-").toLowerCase()}">${esc(st)}</span>`;
const bar = (done, total) => `<span class="bar" role="img" aria-label="${done} of ${total} done"><i style="width:${total ? Math.round((100 * done) / total) : 0}%"></i></span><span class="pct">${done}/${total}</span>`;
function node(i, depth) {
  const k = kids(i.number);
  const ls = leaves(i);
  const done = ls.filter((x) => x.stage === "Shipped").length;
  const meta = [i.priority, i.kind, i.est != null ? `est ${h(i.est)}` : "", i.actual != null ? `actual ${h(i.actual)}` : "", i.deploy && `deploy ${i.deploy}`, i.commit && `commit ${i.commit}`].filter(Boolean).map(esc).join(" · ");
  const head = `<a href="${esc(i.url)}">#${i.number} ${esc(i.title)}</a> ${chip(i.stage)} ${k.length ? bar(done, ls.length) : ""}<div class="meta">${meta}</div>`;
  return k.length
    ? `<details ${depth === 0 && i.stage !== "Shipped" ? "open" : ""}><summary>${head}</summary><div class="kids">${k.map((c) => node(c, depth + 1)).join("")}</div></details>`
    : `<div class="leaf">${head}</div>`;
}

const now = new Date().toISOString().replace("T", " ").slice(0, 16);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(project.title)}: project dashboard</title><style>
:root{--ink:#17140f;--muted:#5f574a;--paper:#f5f0e6;--panel:#ebe4d4;--rule:#cfc6b2;--accent:#8f1d1d;--ok:#1f6b3a;--warn:#8a5a00;--info:#1d4f8c}
@media (prefers-color-scheme:dark){:root{--ink:#eee7d8;--muted:#a39a85;--paper:#14110d;--panel:#1d1913;--rule:#3a3328;--accent:#e08a7a;--ok:#6fcf8e;--warn:#e3b341;--info:#7db4ec}}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 Georgia,serif}main{max-width:70rem;margin:0 auto;padding:1.5rem}
h1{font-size:2rem;margin:.2rem 0}h2{font-size:1.1rem;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);border-top:2px solid var(--ink);padding-top:.5rem;margin-top:2rem;font-family:Arial,sans-serif}
a{color:inherit}.sub{color:var(--muted);font-size:.9rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.75rem;margin-top:1rem}
.card{background:var(--panel);border:1px solid var(--rule);padding:.75rem 1rem}.card b{display:block;font-size:1.8rem;line-height:1.1}.card span{color:var(--muted);font-size:.85rem}
.chip{font:600 .68rem/1 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:.2rem .4rem;border:1px solid currentColor;margin-left:.4rem}
.s-shipped{color:var(--ok)}.s-planned{color:var(--info)}.s-in-progress{color:var(--warn)}.s-backlog{color:var(--muted)}
.bar{display:inline-block;width:6rem;height:.55rem;background:var(--rule);vertical-align:middle;margin-left:.6rem}.bar i{display:block;height:100%;background:var(--ok)}.pct{font:.8rem Arial,sans-serif;color:var(--muted);margin-left:.4rem}
details{border-left:3px solid var(--rule);margin:.4rem 0;padding-left:.75rem}summary{cursor:pointer;padding:.25rem 0}.kids{margin-left:.5rem}.leaf{border-left:3px solid var(--rule);margin:.3rem 0 .3rem .5rem;padding:.15rem 0 .15rem .75rem}
.meta{color:var(--muted);font:.78rem Arial,sans-serif}table{border-collapse:collapse;width:100%;font-size:.92rem}td,th{border-bottom:1px solid var(--rule);padding:.35rem .5rem;text-align:left;vertical-align:top}th{font:600 .72rem Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
footer{margin:2.5rem 0 1rem;color:var(--muted);font-size:.85rem}
</style></head><body><main>
<h1>${esc(project.title)}</h1><div class="sub">Project dashboard · generated ${esc(now)} UTC from <a href="${esc(project.url)}">the GitHub Project</a>${PLANS ? ` · ${esc(PLANS)}` : ""}</div>
<div class="cards">
<div class="card"><b>${count("Shipped")}</b><span>shipped or fixed</span></div>
<div class="card"><b>${count("In progress")}</b><span>in progress</span></div>
<div class="card"><b>${count("Planned")}</b><span>planned</span></div>
<div class="card"><b>${count("Backlog")}</b><span>backlog and ideas</span></div>
<div class="card"><b>${openBugs.length}</b><span>open bugs and security items (${bugs.length - openBugs.length} closed)</span></div>
<div class="card"><b>${h(sum(estShipped, "actual"))}</b><span>actual on ${estShipped.length} timed phases (estimated ${h(sum(estShipped, "est"))})</span></div>
</div>
<h2>Releases, phases and sub-phases</h2>
${releases.map((r) => node(r, 0)).join("") || "<p>No releases found.</p>"}
<h2>Now and next</h2>
<table><tr><th>Item</th><th>Stage</th><th>Release</th><th>Est</th></tr>${active.map((i) => `<tr><td><a href="${esc(i.url)}">#${i.number} ${esc(i.title)}</a></td><td>${chip(i.stage)}</td><td>${esc(i.release)}</td><td>${esc(h(i.est))}</td></tr>`).join("") || "<tr><td colspan=4>Nothing planned.</td></tr>"}</table>
<h2>Bugs, fixes and security</h2>
<table><tr><th>Item</th><th>State</th><th>Fixed in</th></tr>${bugs.map((i) => `<tr><td><a href="${esc(i.url)}">#${i.number} ${esc(i.title)}</a></td><td>${i.open ? chip("In progress").replace("In progress", "Open") : chip("Shipped").replace("Shipped", "Closed")}</td><td>${esc([i.deploy && `deploy ${i.deploy}`, i.commit && `commit ${i.commit}`].filter(Boolean).join(" · "))}</td></tr>`).join("")}</table>
<footer>Hours: estimates are the planner's raw numbers where the issue lists one; actuals come from the phased-shipping history. Regenerate: <code>npm run board</code></footer>
</main></body></html>`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, "utf8");
console.log(`Dashboard written to ${OUT}: ${items.length} items, ${releases.length} releases, ${count("Shipped")} shipped, ${count("In progress")} in progress, ${count("Planned")} planned, ${count("Backlog")} backlog, ${openBugs.length} open bugs`);
