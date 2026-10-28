// Run with: node --test tests/wiki.test.mjs
// Checks the wiki pages in docs/wiki and the script that checks and publishes them: the author, the wiki address,
// every validation rule, the generated pages.
// Publishing to a local bare repository is in wiki-publish.test.mjs.
// This file is one of 2 (wiki.test.mjs, wiki-publish.test.mjs) that came from one file; the helpers they share are in tests/helpers/wiki.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { deriveAuthor, wikiUrl, renderReleases, renderSidebar, validatePages, releasePageName, FEATURE_PAGES, escapeRe, REPO_URL } from "../scripts/publish-wiki.mjs";
import { ROOT, WIKI, SCRIPT, tmp, git, read, repoIdentity, publish } from "./helpers/wiki.mjs";

const releases = JSON.parse(readFileSync(join(ROOT, "releases.json"), "utf8")).releases;
const NOREPLY = "users.noreply.github.com";
const pagesCopy = () => { const d = join(tmp("pages"), "wiki"); cpSync(WIKI, d, { recursive: true }); return d; };
const problems = (dir, options) => validatePages(dir, { denyTerms: [], ...options });

// ── the author ──────────────────────────────────────────────────────────────
test("deriveAuthor returns a no-reply identity and throws for anything else", () => {
  assert.deepEqual(deriveAuthor("someaccount", `1234+someaccount@${NOREPLY}`), { name: "someaccount", email: `1234+someaccount@${NOREPLY}` });
  assert.throws(() => deriveAuthor("someaccount", "someone" + "@" + "example.org"), /no-reply/);
  assert.throws(() => deriveAuthor("someaccount", ""), /no-reply/);
  assert.throws(() => deriveAuthor("two words", `1234+x@${NOREPLY}`), /single-word/);
  assert.throws(() => deriveAuthor("", `1234+x@${NOREPLY}`), /single-word/);
});
test("the repository's own latest commit passes, and its author name has no space", () => {
  const [name, email] = repoIdentity();
  assert.ok(!/\s/.test(name), "the author name looks like a full name");
  assert.deepEqual(deriveAuthor(name, email), { name, email });
});

// ── the wiki address ────────────────────────────────────────────────────────
test("wikiUrl maps the repository to its wiki and refuses any other host, owner or repository", () => {
  const wiki = "https://github.com/trbbmnglg/phasewright.wiki.git";
  assert.equal(wikiUrl("https://github.com/trbbmnglg/phasewright.git"), wiki);
  assert.equal(wikiUrl("https://github.com/trbbmnglg/phasewright"), wiki);
  const sshUser = "git" + "@github.com";
  assert.equal(wikiUrl(`${sshUser}:trbbmnglg/phasewright.git`), `${sshUser}:trbbmnglg/phasewright.wiki.git`);
  // A user name or token in the address is dropped, never returned.
  const withUser = "https://" + "someuser" + "@github.com/trbbmnglg/phasewright.git";
  assert.equal(wikiUrl(withUser), wiki);
  assert.throws(() => wikiUrl("https://example.org/trbbmnglg/phasewright.git"), /github\.com/);
  assert.throws(() => wikiUrl("https://github.com/someone-else/phasewright.git"), /not github\.com/);
  assert.throws(() => wikiUrl("https://github.com/trbbmnglg/another-repo.git"), /not github\.com/);
  assert.throws(() => wikiUrl("https://github.com.example.org/trbbmnglg/phasewright.git"), /github\.com/);
  assert.throws(() => wikiUrl("not a url"), /github\.com/);
});

// ── the real pages ──────────────────────────────────────────────────────────
test("the real docs/wiki passes every rule", () => {
  assert.deepEqual(validatePages(WIKI), []);
});
test("the generated pages match what the renderers produce", () => {
  assert.equal(read(WIKI, "Releases.md"), renderReleases(releases));
  const names = readdirSync(WIKI).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  assert.equal(read(WIKI, "_Sidebar.md"), renderSidebar(names, releases));
});
test("the release table lists only releases that are shipped or in progress", () => {
  const table = renderReleases(releases);
  for (const r of releases) {
    assert.equal(table.includes(`| [${r.version}](`), r.status !== "planned", `${r.version} (${r.status})`);
  }
  assert.ok(table.includes("| [v1.0.0](Release-1.0.0-Allacapan) | Allacapan | shipped | 2026-10-22 |"));
});
test("every shipped or in-progress release has a page, and the in-progress one says so", () => {
  for (const r of releases.filter((x) => x.status !== "planned")) assert.ok(existsSync(join(WIKI, `${releasePageName(r)}.md`)), r.version);
  const baggao = releases.find((r) => r.status === "in progress");
  assert.match(read(WIKI, `${releasePageName(baggao)}.md`), /^## Status\n\nIn progress/m);
});
test("the pages make no claim that drifts or that the plugins cannot keep", () => {
  for (const f of readdirSync(WIKI)) {
    const text = read(WIKI, f);
    const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*\n?/gm, "");
    assert.doesNotMatch(prose, /\b\d[\d,]*\s+(tests?|tokens?|checks|evals?)\b/i, `${f}: a count in prose will drift`);
    assert.doesNotMatch(text, /nothing leaves|nothing is sent|sends nothing|never leaves/i, `${f}: the model scout runs a web search`);
  }
  assert.match(read(WIKI, "_Footer.md"), /Local-first: your files stay on your machine\./);
});
test("the page versions follow plugin.json, and no page says the guard has not been seen firing", () => {
  const version = JSON.parse(readFileSync(join(ROOT, "plugins", "phased-shipping", ".claude-plugin", "plugin.json"), "utf8")).version;
  assert.ok(read(WIKI, "Phased-shipping.md").includes(`The current plugin version is ${version}`));
  assert.ok(read(WIKI, "Release-1.1.0-Baggao.md").includes(`plugin version ${version}`));
  for (const f of readdirSync(WIKI)) assert.doesNotMatch(read(WIKI, f), /(has not|not yet) been seen firing/i, f);
});

// ── each rule fails on a broken copy ────────────────────────────────────────
const fails = (dir, pattern, options) => {
  const found = problems(dir, options);
  assert.ok(found.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got: ${found.join(" | ") || "none"}`);
};
test("a stray file name fails", () => {
  const d = pagesCopy();
  writeFileSync(join(d, "notes.txt"), "x");
  fails(d, /notes\.txt: not an allowed file/);
  rmSync(join(d, "notes.txt"));
  writeFileSync(join(d, "Scratch.md"), "# x\n");
  fails(d, /Scratch\.md: not an allowed page name/);
});
test("publish-wiki.mjs imports cell from releases-table.mjs and defines none of its own", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /import \{[^}]*\bcell\b[^}]*\} from "\.\/releases-table\.mjs";/);
  assert.doesNotMatch(src, /(const|let|var|function)\s+cell\b/);
  const table = readFileSync(join(ROOT, "scripts", "releases-table.mjs"), "utf8");
  assert.doesNotMatch(table, /publish-wiki/, "no import cycle");
});
test("escapeRe escapes every special character, so the text matches itself and a near miss does not", () => {
  const all = ".*+?^${}()|[]\\/-";
  assert.equal(new RegExp("^" + escapeRe(all) + "$").test(all), true);
  for (const ch of all) assert.equal(new RegExp("^" + escapeRe(ch) + "$").test(ch), true, `matches ${ch} itself`);
  assert.equal(new RegExp("^" + escapeRe("a.b") + "$").test("axb"), false, "a dot is not a wildcard");
  assert.equal(new RegExp("^" + escapeRe("a|b") + "$").test("a"), false, "a pipe is not an alternation");
  assert.equal(new RegExp("^" + escapeRe(all) + "$").test(all.slice(0, -1) + "x"), false);
  assert.equal(escapeRe("plain 123"), "plain 123");
  const url = new RegExp(`^${escapeRe(REPO_URL)}/(blob|tree)/`);
  assert.ok(url.test(`${REPO_URL}/blob/main/README.md`));
  assert.ok(url.test(`${REPO_URL}/tree/main/docs`));
  assert.equal(url.test(REPO_URL.replace("github.com", "githubXcom") + "/blob/main/README.md"), false);
});
test("the link validator still accepts the repository's own blob and tree links", () => {
  const d = pagesCopy();
  appendFileSync(join(d, "Home.md"), `\n[a](${REPO_URL}/blob/main/README.md) [b](${REPO_URL}/tree/main/docs)\n`);
  assert.deepEqual(problems(d), []);
});
test("a broken wiki link fails", () => {
  const d = pagesCopy();
  appendFileSync(join(d, "Home.md"), "\n[gone](No-Such-Page)\n");
  fails(d, /Home\.md: link to a wiki page that does not exist: No-Such-Page/);
});
test("a broken repo link fails, and so does a link to a heading that does not exist", () => {
  const d = pagesCopy();
  appendFileSync(join(d, "Home.md"), "\n[gone](https://github.com/trbbmnglg/phasewright/blob/main/no/such/file.md)\n");
  fails(d, /path that does not exist: no\/such\/file\.md/);
  const e = pagesCopy();
  appendFileSync(join(e, "Home.md"), "\n[x](https://github.com/trbbmnglg/phasewright/blob/main/README.md#no-such-heading)\n");
  fails(e, /heading that does not exist/);
  const f = pagesCopy();
  appendFileSync(join(f, "Home.md"), "\n[x](https://example.org/somewhere)\n");
  fails(f, /link outside the repository/);
});
test("an email address or a mailto link fails", () => {
  const d = pagesCopy();
  appendFileSync(join(d, "Home.md"), `\nwrite to ${"someone" + "@" + "example.org"}\n`);
  fails(d, /Home\.md: an email address/);
  const e = pagesCopy();
  appendFileSync(join(e, "Home.md"), `\n[mail](${"mailto" + ":x"})\n`);
  fails(e, /Home\.md: a mailto: link/);
});
test("a forbidden word fails, without printing a denylist term", () => {
  for (const word of ["Formerly", "was renamed", "the real name"]) {
    const d = pagesCopy();
    appendFileSync(join(d, "Home.md"), `\n${word}\n`);
    fails(d, /Home\.md: forbidden word/);
  }
  const d = pagesCopy();
  appendFileSync(join(d, "Home.md"), "\nA Zork appears here.\n");
  const found = problems(d, { denyTerms: ["zork"] });
  assert.ok(found.some((p) => /local denylist/.test(p)));
  assert.ok(found.every((p) => !/zork/i.test(p)), "a denylist term was printed");
  // Whole words only: a term inside a longer word is not a match.
  assert.deepEqual(problems(d, { denyTerms: ["zor"] }), []);
});
test("a missing heading fails on a feature page and on a release page", () => {
  const d = pagesCopy();
  writeFileSync(join(d, "The-guard.md"), read(d, "The-guard.md").replace(/^## Limits$/m, "## Edges"));
  fails(d, /The-guard\.md: missing heading "## Limits"/);
  const e = pagesCopy();
  writeFileSync(join(e, "Release-1.0.1-Aparri.md"), read(e, "Release-1.0.1-Aparri.md").replace(/^## Notes$/m, "## Misc"));
  fails(e, /Release-1\.0\.1-Aparri\.md: missing heading "## Notes"/);
});
test("a drifted generated page fails", () => {
  const d = pagesCopy();
  appendFileSync(join(d, "Releases.md"), "\nan extra line\n");
  fails(d, /Releases\.md: out of date/);
  const e = pagesCopy();
  appendFileSync(join(e, "_Sidebar.md"), "- [Home again](Home)\n");
  fails(e, /_Sidebar\.md: out of date/);
});
test("a shipped release without a page fails, and so does a release page without an entry", () => {
  const d = pagesCopy();
  rmSync(join(d, "Release-1.0.0-Allacapan.md"));
  fails(d, /Release-1\.0\.0-Allacapan\.md: v1\.0\.0 is shipped and needs a page/);
  const e = pagesCopy();
  writeFileSync(join(e, "Release-9.9.9-Nowhere.md"), "# x\n\n## Status\n\n## What shipped\n\n## Notes\n");
  fails(e, /Release-9\.9\.9-Nowhere\.md: no matching entry in releases\.json/);
});
test("a page that is empty or over 300 lines fails, and so does a missing required page", () => {
  const d = pagesCopy();
  writeFileSync(join(d, "Home.md"), "\n");
  fails(d, /Home\.md: page is empty/);
  const e = pagesCopy();
  appendFileSync(join(e, "Home.md"), "line\n".repeat(301));
  fails(e, /Home\.md: page has \d+ lines/);
  const f = pagesCopy();
  rmSync(join(f, "_Footer.md"));
  fails(f, /_Footer\.md: page is missing/);
});
test("the feature pages listed in the script all exist", () => {
  for (const f of FEATURE_PAGES) assert.ok(existsSync(join(WIKI, `${f.page}.md`)), f.page);
});
test("the roadmap standard page is in the feature list, has the five feature headings, and is linked from Home and the sidebar", () => {
  assert.ok(FEATURE_PAGES.some((f) => f.page === "Roadmap-standard" && f.title === "Roadmap standard"));
  const page = read(WIKI, "Roadmap-standard.md");
  for (const heading of ["## What it is", "## How to use it", "## What shipped when", "## Limits", "## Source"]) {
    assert.ok(new RegExp(`^${heading}$`, "m").test(page), heading);
  }
  assert.ok(read(WIKI, "Home.md").includes("(Roadmap-standard)"));
  assert.ok(read(WIKI, "_Sidebar.md").includes("[Roadmap standard](Roadmap-standard)"));
  const version = JSON.parse(readFileSync(join(ROOT, "plugins", "phased-shipping", ".claude-plugin", "plugin.json"), "utf8")).version;
  assert.ok(page.includes(`Plugin version ${version}`), "the page names the plugin version that shipped it");
  assert.ok(read(WIKI, "The-guard.md").includes(`Versions 0.6.0 to ${version} changed no guard rule`));
  assert.ok(read(WIKI, "Phased-shipping.md").includes(`| ${version} | [v1.1.0]`), "the version table has a row for the current version");
});
