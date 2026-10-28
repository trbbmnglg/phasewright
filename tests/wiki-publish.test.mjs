// Run with: node --test tests/wiki-publish.test.mjs
// Publishing the wiki pages to a local bare repository (never the real wiki): one commit as the repository's identity, and the history reset with both flags.
// The script is pointed at a local repository through the test-only variables.
// This file is one of 2 (wiki.test.mjs, wiki-publish.test.mjs) that came from one file; the helpers they share are in tests/helpers/wiki.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, WIKI, scratch, tmp, git, read, repoIdentity, publish } from "./helpers/wiki.mjs";


// ── publishing to a local bare repository ───────────────────────────────────
// The script is pointed at a local repository through the test-only variables. It is never given the real wiki.
// The three publishing tests below share one fixture, made on first use (it takes eight git calls, and git is slow where this runs). They run in
// this order and none depends on an earlier one's result except the first, which needs the fixture as it was made: it publishes, and the
// later two work from whatever the remote then holds (the refusal leaves it alone; the reset replaces its whole history either way).
let sharedWiki = null;
const fixtureWiki = () => (sharedWiki ??= makeFixtureWiki());
function makeFixtureWiki() {
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
// Puts one more page on the remote, from a clone of it, as a second author. The reset test does this first: the pages are already published by
// then, so without a page the pages do not have, "the remote holds exactly the pages" would also be true of a reset that changed nothing.
function addRemotePage(bare) {
  const base = tmp("extra");
  const who = { GIT_AUTHOR_NAME: "Extra Author", GIT_AUTHOR_EMAIL: "extra-author@example.org", GIT_COMMITTER_NAME: "Extra Author", GIT_COMMITTER_EMAIL: "extra-author@example.org" };
  git(base, ["clone", "--quiet", bare, "work"]);
  const work = join(base, "work");
  writeFileSync(join(work, "Extra-page.md"), "# A page the pages do not have\n");
  git(work, ["add", "-A"]);
  git(work, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Add a page that is not one of ours"], who);
  git(work, ["push", "--quiet", "origin", "HEAD:refs/heads/master"]);
}
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
  addRemotePage(bare);
  const listing = () => git(bare, ["ls-tree", "--name-only", "master"]).trim().split("\n").sort();
  assert.ok(listing().includes("Extra-page.md"), "before the reset the remote holds a page that is not one of ours");
  assert.notDeepEqual(listing(), wikiPages(), "so the remote does not already hold exactly the pages");
  const before = git(bare, ["rev-parse", "master"]).trim();
  const r = publish(bare, "--reset-history", "--yes-force-push-wiki");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(commitCount(bare), 1);
  assert.equal(git(bare, ["log", "--format=%an|%ae|%cn|%ce|%s", "master"]).trim(), `${name}|${email}|${name}|${email}|Publish wiki pages`);
  assert.ok(!git(bare, ["log", "--format=%an %cn", "master"]).includes(firstAuthor), "the first author is still in the history");
  assert.deepEqual(listing(), wikiPages(), "the reset replaced the tree: the extra page is gone");
  assert.ok(!listing().includes("Extra-page.md"));
  const bundle = r.stdout.match(/^backup bundle: (.+)$/m)?.[1];
  assert.ok(bundle && existsSync(bundle), "a backup bundle path is printed and the file exists");
  scratch.push(dirname(bundle));
  assert.match(git(ROOT, ["bundle", "list-heads", bundle]), new RegExp(`^${before} refs/heads/master$`, "m"), "the bundle holds the old head");
  assert.ok(!r.stdout.includes("synthetic-value") && !r.stderr.includes("synthetic-value"), "a token was printed");
});
