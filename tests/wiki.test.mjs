// Run with: node --test tests/wiki.test.mjs
// Checks the wiki pages in docs/wiki and the script that checks and publishes them: the author, the wiki address,
// every validation rule, the generated pages, and publishing to a local bare repository (never the real wiki).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveAuthor, wikiUrl, renderReleases, renderSidebar, validatePages, releasePageName, FEATURE_PAGES,
} from "../scripts/publish-wiki.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = join(ROOT, "docs", "wiki");
const SCRIPT = join(ROOT, "scripts", "publish-wiki.mjs");
const releases = JSON.parse(readFileSync(join(ROOT, "releases.json"), "utf8")).releases;
// Built at run time so the earlier id never appears as one string in the repo.
const STALE_ID = ["agent", "library"].join("-");
const NOREPLY = "users.noreply.github.com";

const scratch = [];
const tmp = (label) => { const d = mkdtempSync(join(tmpdir(), `wiki-test-${label}-`)); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const git = (cwd, args, env = {}) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
};
const pagesCopy = () => { const d = join(tmp("pages"), "wiki"); cpSync(WIKI, d, { recursive: true }); return d; };
const read = (dir, name) => readFileSync(join(dir, name), "utf8");
const problems = (dir, options) => validatePages(dir, { denyTerms: [], ...options });
const repoIdentity = () => git(ROOT, ["log", "-1", "--format=%an%x00%ae"]).trim().split("\0");

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
    assert.ok(!text.toLowerCase().includes(STALE_ID), `${f}: earlier id`);
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
  for (const word of ["Formerly", "was renamed", STALE_ID, "the real name"]) {
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

// ── publishing to a local bare repository ───────────────────────────────────
// The script is pointed at a local repository through the test-only variables. It is never given the real wiki.
function fixtureWiki() {
  const base = tmp("remote");
  const bare = join(base, "wiki.git");
  git(base, ["init", "--quiet", "--bare", bare]);
  git(bare, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  const seed = join(base, "seed");
  git(base, ["init", "--quiet", seed]);
  git(seed, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  writeFileSync(join(seed, "Home.md"), "# Seed page\n");
  writeFileSync(join(seed, "Old-page.md"), "# An old page\n");
  const who = { GIT_AUTHOR_NAME: "Seed Author", GIT_AUTHOR_EMAIL: "seed-author@example.org", GIT_COMMITTER_NAME: "Seed Author", GIT_COMMITTER_EMAIL: "seed-author@example.org" };
  git(seed, ["add", "-A"]);
  git(seed, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial Home page"], who);
  git(seed, ["push", "--quiet", bare, "HEAD:refs/heads/master"]);
  return { bare, firstAuthor: git(bare, ["log", "--reverse", "--format=%an", "master"]).split("\n")[0] };
}
const publish = (bare, ...flags) => spawnSync(process.execPath, [SCRIPT, "--publish", ...flags], {
  cwd: ROOT, encoding: "utf8",
  env: { ...process.env, PUBLISH_WIKI_TEST: "1", PUBLISH_WIKI_TEST_REMOTE: bare, GH_TOKEN: "synthetic-value-for-the-leak-check" },
});
const commitCount = (bare) => Number(git(bare, ["rev-list", "--count", "master"]).trim());
const wikiPages = () => readdirSync(WIKI).filter((f) => f.endsWith(".md")).sort();

test("--publish adds one commit as the repository's identity, and a second run finds no changes", () => {
  const { bare, firstAuthor } = fixtureWiki();
  const [name, email] = repoIdentity();
  const a = publish(bare);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(commitCount(bare), 2);
  assert.equal(git(bare, ["log", "-1", "--format=%an|%ae|%cn|%ce|%s", "master"]).trim(), `${name}|${email}|${name}|${email}|Update wiki pages`);
  assert.deepEqual(git(bare, ["ls-tree", "--name-only", "master"]).trim().split("\n").sort(), wikiPages(), "the old page is replaced by the pages");
  assert.ok(!a.stdout.includes("synthetic-value") && !a.stderr.includes("synthetic-value"), "a token was printed");
  const b = publish(bare);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /no changes/);
  assert.equal(commitCount(bare), 2);
  // No page carries the name the wiki's first commit was made under.
  for (const f of wikiPages()) assert.ok(!read(WIKI, f).includes(firstAuthor), `${f} has the first author's name`);
  assert.notEqual(firstAuthor, name);
});

test("--reset-history needs both flags and leaves the remote alone without them", () => {
  const { bare } = fixtureWiki();
  const before = git(bare, ["rev-parse", "master"]).trim();
  for (const flags of [["--reset-history"], ["--yes-force-push-wiki"]]) {
    const r = publish(bare, ...flags);
    assert.equal(r.status, 1, flags.join(" "));
    assert.match(r.stderr, /needs both/);
    assert.equal(git(bare, ["rev-parse", "master"]).trim(), before);
  }
});

test("--reset-history with both flags leaves one commit by the repository's identity and writes a backup bundle", () => {
  const { bare, firstAuthor } = fixtureWiki();
  const [name, email] = repoIdentity();
  const before = git(bare, ["rev-parse", "master"]).trim();
  const r = publish(bare, "--reset-history", "--yes-force-push-wiki");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(commitCount(bare), 1);
  assert.equal(git(bare, ["log", "--format=%an|%ae|%cn|%ce|%s", "master"]).trim(), `${name}|${email}|${name}|${email}|Publish wiki pages`);
  assert.ok(!git(bare, ["log", "--format=%an %cn", "master"]).includes(firstAuthor), "the first author is still in the history");
  assert.deepEqual(git(bare, ["ls-tree", "--name-only", "master"]).trim().split("\n").sort(), wikiPages());
  const bundle = r.stdout.match(/^backup bundle: (.+)$/m)?.[1];
  assert.ok(bundle && existsSync(bundle), "a backup bundle path is printed and the file exists");
  scratch.push(dirname(bundle));
  assert.match(git(ROOT, ["bundle", "list-heads", bundle]), new RegExp(`^${before} refs/heads/master$`, "m"), "the bundle holds the old head");
  assert.ok(!r.stdout.includes("synthetic-value") && !r.stderr.includes("synthetic-value"), "a token was printed");
});

test("the feature pages listed in the script all exist", () => {
  for (const f of FEATURE_PAGES) assert.ok(existsSync(join(WIKI, `${f.page}.md`)), f.page);
});
