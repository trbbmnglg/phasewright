// Run with: node --test tests/readme.test.mjs
// Keeps the README's structure from drifting: the headings, the short first screen, the two-command quick start,
// working links and anchors, a link behind every claim, the compatibility table, the Releases markers and the wording rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { START, END, renderTable } from "../scripts/releases-table.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const readme = read("README.md");

// The README without fenced code blocks (the fences and what is inside them).
const outsideFences = (md) => md.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*\n?/gm, "");
// The text of one "## " section, or the lines before the first one when name is null.
const section = (md, name) => {
  const parts = md.split(/^(?=## )/m);
  const found = parts.find((s) => s.startsWith(`## ${name}\n`));
  assert.ok(found, `section ${name} exists`);
  return found;
};
// GitHub's heading anchor: lower case, markup and punctuation dropped, spaces to hyphens.
const slug = (heading) => heading.toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
const headingsOf = (md) => [...outsideFences(md).matchAll(/^(#{1,6}) (.+)$/gm)].map((m) => ({ level: m[1].length, text: m[2] }));
const anchorsOf = (md) => new Set(headingsOf(md).map((h) => slug(h.text)));

const EXPECTED = [
  [2, "The problem"], [2, "How it helps"], [2, "Quick start"], [2, "What a phase looks like"], [2, "What's inside"],
  [2, "Install in your tool"], [3, "Claude Code"], [3, "VS Code with GitHub Copilot"], [3, "Cursor"],
  [3, "Other tools"], [3, "Download a single item"],
  [2, "What works where"], [2, "What it will not do"], [2, "Releases"], [2, "Security"], [2, "Develop"], [2, "License"],
];

test("the logo is the H1: a picture with a dark source and an image that has the project name as alt text", () => {
  const first = readme.split("\n")[0];
  assert.match(first, /^<h1 align="center"><picture>/);
  assert.match(first, /<source media="\(prefers-color-scheme: dark\)" srcset="docs\/brand\/phasewright-lockup-dark\.svg">/);
  assert.match(first, /<source media="\(prefers-color-scheme: light\)" srcset="docs\/brand\/phasewright-lockup-light\.svg">/);
  assert.match(first, /<img alt="Phasewright" src="docs\/brand\/phasewright-lockup-light\.svg" width="560">/);
  assert.match(first, /<\/picture><\/h1>$/);
});

test("the headings are exactly the agreed list, in order, with their levels", () => {
  const found = headingsOf(readme.replace(/^<h1[^\n]*\n/, "")).map((h) => [h.level, h.text]);
  assert.deepEqual(found, EXPECTED);
  assert.equal(headingsOf(readme).filter((h) => h.level === 1).length, 0, "the H1 is the logo line only");
});

// Words outside HTML tags and URLs. A link counts as its text; tokens with no letter or digit are not words.
const words = (md) => outsideFences(md)
  .replace(/<[^>]*>/g, " ")
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/https?:\/\/\S+/g, " ")
  .split(/\s+/)
  .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

test("the first screen (tagline to the end of Quick start) is at most 250 words", () => {
  const body = readme.replace(/^<h1[^\n]*\n/, "");
  const start = body.search(/\S/);
  const end = body.indexOf("\n## What a phase looks like");
  assert.ok(end > start);
  const n = words(body.slice(start, end));
  assert.ok(n <= 250, `first screen is ${n} words`);
  assert.ok(n >= 60, `first screen is ${n} words, which is too thin to say the goal`);
});

test("Quick start has exactly two commands, in one code fence", () => {
  const q = section(readme, "Quick start");
  const fences = [...q.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)];
  assert.equal(fences.length, 1);
  const lines = fences[0][1].split("\n").map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines, [
    "claude plugin marketplace add trbbmnglg/phasewright",
    "claude plugin install phased-shipping@phasewright",
  ]);
  assert.match(q, /`\/phased-shipping:plan`/);
});

const links = () => {
  const text = outsideFences(readme).replace(/`[^`\n]*`/g, "");
  const out = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  for (const m of readme.split("\n")[0].matchAll(/(?:src|srcset)="([^"]+)"/g)) out.push(m[1]);
  return out.filter((l) => !/^(https?:|mailto:)/.test(l));
};

test("every relative link and image points at a file that exists, and every anchor at a heading in the target", () => {
  const all = links();
  assert.ok(all.length >= 10);
  for (const l of all) {
    const [file, frag] = l.split("#");
    const target = file === "" ? "README.md" : file;
    assert.ok(existsSync(resolve(ROOT, target)), `${l}: ${target} does not exist`);
    if (frag !== undefined) {
      assert.ok(target.endsWith(".md"), `${l}: an anchor needs a Markdown file`);
      assert.ok(anchorsOf(read(target)).has(frag), `${l}: no heading with that anchor in ${target}`);
    }
  }
});

test("every bullet under How it helps and What it will not do carries a relative link, and the helps bullets stay short", () => {
  for (const name of ["How it helps", "What it will not do"]) {
    const bullets = section(readme, name).split("\n").filter((l) => l.startsWith("- "));
    assert.ok(bullets.length >= 4, `${name} has bullets`);
    for (const b of bullets) {
      assert.match(b, /\]\((?!https?:)[^)]+\)/, `${name}: a bullet has no relative link: ${b.slice(0, 40)}`);
      if (name === "How it helps") assert.ok(words(b.slice(2)) <= 25, `a How it helps bullet is over 25 words: ${b.slice(0, 40)}`);
    }
  }
  assert.equal(section(readme, "How it helps").split("\n").filter((l) => l.startsWith("- ")).length, 4);
});

test("the compatibility table has the five columns and the three tool rows, macOS is said to be untested, and the plugin READMEs agree", () => {
  const s = section(readme, "What works where");
  const rows = s.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  assert.deepEqual(rows[0], ["Tool", "Skills", "Agents", "Plugins", "Tried by the maintainer"]);
  assert.deepEqual(rows.slice(2), [
    ["Claude Code", "full", "full", "full", "yes, on Windows"],
    ["VS Code with GitHub Copilot", "full", "full (reads `.claude/agents`)", "skills only", "not yet"],
    ["Cursor", "full", "none", "skills only", "not yet"],
  ]);
  assert.match(s, /macOS is untested/);
  assert.match(s, /untested end to end/);
  const free = read("plugins", "free-resources", "README.md");
  assert.match(free, /\*\*Windows:\*\* tested/);
  assert.match(free, /\*\*macOS:\*\* untested/);
  assert.match(free, /\*\*Copilot and Cursor:\*\* untested/);
});

test("Security links SECURITY.md, and the provenance line matches what the release workflow does", () => {
  assert.match(section(readme, "Security"), /\]\(SECURITY\.md\)/);
  const attests = /actions\/attest/.test(read(".github", "workflows", "release.yml"));
  const claimsNone = /have no build provenance/.test(section(readme, "What it will not do"));
  assert.equal(claimsNone, !attests, "the README's provenance line is out of step with release.yml");
});

test("the Releases markers are intact, the table equals the one rendered from releases.json, and the drift check passes", () => {
  assert.equal(readme.split(START).length, 2);
  assert.equal(readme.split(END).length, 2);
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  assert.ok(a < b);
  const releases = JSON.parse(read("releases.json")).releases;
  assert.equal(readme.slice(a + START.length, b).replace(/^\n+|\n+$/g, ""), renderTable(releases));
  const releasesSection = section(readme, "Releases");
  assert.ok(releasesSection.includes(START) && releasesSection.includes(END), "the markers sit inside Releases");
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "releases-table.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("no rename wording, no listed local term, and no numbers in prose that would drift", () => {
  const lower = readme.toLowerCase();
  for (const w of ["formerly", "renamed"]) assert.ok(!lower.includes(w), `the README contains "${w}"`);
  const deny = join(ROOT, "scripts", "denylist.local.txt");
  if (existsSync(deny)) {
    const terms = readFileSync(deny, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    for (const t of terms) {
      // Never print the term: a failure in CI must not leak it.
      // Whole word, case-insensitive, like the lint: a term must not match inside a longer word.
      const escaped = t.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
      const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
      assert.ok(!re.test(readme), "a local denylist term is in the README");
    }
  }
  const prose = outsideFences(readme).replace(/<[^>]*>/g, "");
  assert.doesNotMatch(prose, /\b\d[\d,]*\s+(tests?|tokens?|checks|evals?)\b/i, "a count in prose will drift");
  assert.doesNotMatch(readme, /@[\w.-]+\.[a-z]{2,}\b/i, "no email address");
  assert.ok(readme.trimEnd().endsWith("MIT licensed. Made by [trbbmnglg](https://github.com/trbbmnglg)."));
});

test("What's inside says each skill is a folder with a SKILL.md, and every skill folder has one", () => {
  assert.match(section(readme, "What's inside"), /each a folder containing a `SKILL\.md`/);
  const dirs = readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.ok(dirs.length > 0);
  for (const d of dirs) assert.ok(existsSync(join(ROOT, "skills", d.name, "SKILL.md")), `skills/${d.name}/SKILL.md exists`);
});

test("the excerpt of a phase at preview is present, in a code fence, and labelled as abridged", () => {
  const excerpt = [
    "Phase 7b preview",
    "  Gates       baseline pass (285 tests) · compare pass, 0 new failures (294 tests)",
    "              review standard · fix rounds 0",
    "  Models      builder sonnet (high) · checks haiku (low)",
    "  Time        0.66 h so far, 1.3 h estimated",
    "  Commands    1. git add -A -- library.json plugins tests",
    "              2. git commit -F <message file>",
    "              3. git push origin main",
    "  Hash        Commands hash: 79a48e698d6b",
    "  Prod check  CI green · issue closed · remote file matches · copies synced",
    "  Rollback    git revert --no-edit HEAD && git push origin main",
    "",
    "Reply /phased-shipping:run approve to run the commands listed above.",
  ].join("\n");
  const s = section(readme, "What a phase looks like");
  const at = s.indexOf("```\n");
  assert.ok(at > 0);
  assert.equal(s.slice(at + 4, s.indexOf("\n```", at + 4)), excerpt);
  const before = s.slice(0, at).trim().split("\n").pop();
  assert.match(before, /^Abridged from a real run/);
});
