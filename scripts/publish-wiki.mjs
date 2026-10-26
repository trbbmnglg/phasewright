#!/usr/bin/env node
// Keeps the repository's wiki in step with docs/wiki/. The pages live in this repo, so they are
// reviewed, linted and tested like code; this script checks them and publishes them. No dependencies.
//
//   node scripts/publish-wiki.mjs --write      regenerate Releases.md and _Sidebar.md from releases.json
//   node scripts/publish-wiki.mjs --check      validate docs/wiki/ (no network); exit 0 or 1
//   node scripts/publish-wiki.mjs --publish    run --check, clone the wiki, replace its pages, commit and push
//   node scripts/publish-wiki.mjs --publish --reset-history --yes-force-push-wiki
//                                              back the wiki up to a bundle, then replace its whole history
//                                              with one commit and force-push it (both flags are required)
//
// The commit author is derived from this repository's latest commit and must be the GitHub no-reply
// identity; it is never read from git config or a profile. The script only talks to the wiki of
// github.com/trbbmnglg/phasewright, takes its address from `git remote get-url origin`, and never
// prints a token or any text with credentials in it.
//
// Test-only: with PUBLISH_WIKI_TEST=1, PUBLISH_WIKI_TEST_REMOTE names a local repository to use
// instead of the wiki. Without PUBLISH_WIKI_TEST=1 the variable is ignored.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WIKI_DIR = join(ROOT, "docs", "wiki");

export const OWNER = "trbbmnglg";
export const REPO_NAME = "phasewright";
export const REPO_URL = `https://github.com/${OWNER}/${REPO_NAME}`;
export const BLOB = `${REPO_URL}/blob/main`;
export const MAX_LINES = 300;

// The feature pages, in sidebar order. Each needs the five headings below.
export const FEATURE_PAGES = [
  { page: "Phased-shipping", title: "Phased shipping" },
  { page: "Free-resources", title: "Free resources" },
  { page: "The-guard", title: "The guard" },
  { page: "Approval-check", title: "Approval check" },
  { page: "Phase-history-and-estimates", title: "Phase history and estimates" },
  { page: "Library-skills-and-agents", title: "Library skills and agents" },
  { page: "Security-policy", title: "Security policy" },
];
export const FEATURE_HEADINGS = ["## What it is", "## How to use it", "## What shipped when", "## Limits", "## Source"];
export const RELEASE_HEADINGS = ["## Status", "## What shipped", "## Notes"];
export const GENERATED_PAGES = ["Releases", "_Sidebar"];
const FIXED_PAGES = ["Home", "Releases", "_Sidebar", "_Footer"];

// Words no page may contain. The earlier id is built at run time so it never sits in this file as one string.
const STALE_ID = ["agent", "library"].join("-");
const FORBIDDEN = ["formerly", "renamed", STALE_ID, "real name"];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Links that leave the repository but are still allowed: the profile, the repository and its private-report form.
const EXTRA_URLS = new Set([`https://github.com/${OWNER}`, REPO_URL, `${REPO_URL}/security/advisories/new`]);

const readText = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const loadReleases = (root = ROOT) => JSON.parse(readFileSync(join(root, "releases.json"), "utf8")).releases;
const shown = (releases) => releases.filter((r) => r.status !== "planned");
const outsideFences = (md) => md.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*\n?/gm, "");
const cell = (s) => String(s).replace(/\|/g, "\\|");

// GitHub's heading anchor: lower case, markup and punctuation dropped, spaces to hyphens.
const slug = (heading) => heading.toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
const anchorsOf = (md) => new Set([...outsideFences(md).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));

export const releasePageName = (r) =>
  `Release-${r.version.replace(/^v/, "")}-${r.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

// ── The author ──────────────────────────────────────────────────────────────
// Only the GitHub no-reply identity is accepted, and a name with a space (a full name) never is.
export function deriveAuthor(name, email) {
  const n = typeof name === "string" ? name.trim() : "";
  const e = typeof email === "string" ? email.trim() : "";
  if (!n || /\s/.test(n)) throw new Error("the author name must be a single-word account name");
  if (!/^[^\s@]+@users\.noreply\.github\.com$/i.test(e)) throw new Error("the author email must be a GitHub no-reply address");
  return { name: n, email: e };
}

// ── The wiki address ────────────────────────────────────────────────────────
// Takes the origin address of this repository and returns the address of its wiki. Any other host,
// owner or repository throws. A user name or token in the address is dropped, never returned.
export function wikiUrl(originUrl) {
  const s = String(originUrl).trim();
  const web = s.match(/^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const ssh = s.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const m = web ?? ssh;
  if (!m) throw new Error("the origin is not a github.com address");
  if (m[1].toLowerCase() !== OWNER || m[2].toLowerCase() !== REPO_NAME) throw new Error(`the origin is not github.com/${OWNER}/${REPO_NAME}`);
  return web ? `https://github.com/${OWNER}/${REPO_NAME}.wiki.git` : "git" + `@github.com:${OWNER}/${REPO_NAME}.wiki.git`;
}

// ── The generated pages ─────────────────────────────────────────────────────
// Only releases that are shipped or in progress appear; a release that is not started is not listed.
export function renderReleases(releases) {
  const rows = shown(releases).map((r) =>
    `| [${r.version}](${releasePageName(r)}) | ${cell(r.name)} | ${r.status} | ${r.date ?? "-"} |`);
  return [
    "# Releases",
    "",
    `Releases are numbered by version and named. The version is the git tag. Names, statuses and dates come from [releases.json](${BLOB}/releases.json).`,
    "",
    "| Release | Name | Status | Date |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export function renderSidebar(pages, releases) {
  const have = new Set(pages);
  const lines = ["**[Home](Home)**", "", "**Releases**", "", "- [All releases](Releases)"];
  for (const r of shown(releases)) if (have.has(releasePageName(r))) lines.push(`- [${r.version} ${r.name}](${releasePageName(r)})`);
  lines.push("", "**Features**", "");
  for (const f of FEATURE_PAGES) if (have.has(f.page)) lines.push(`- [${f.title}](${f.page})`);
  lines.push("");
  return lines.join("\n");
}

// ── The check ───────────────────────────────────────────────────────────────
function denyTerms(root) {
  const file = join(root, "scripts", "denylist.local.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

// Returns a list of problems (empty when the pages are fine). Never includes a term from the local denylist.
// options: root (the repository, default this one), releases, denyTerms.
export function validatePages(dir, options = {}) {
  const root = options.root ?? ROOT;
  const releases = options.releases ?? loadReleases(root);
  const terms = options.denyTerms ?? denyTerms(root);
  const errors = [];
  const err = (file, msg) => errors.push(`${file}: ${msg}`);
  if (!existsSync(dir)) return [`${dir}: the wiki folder is missing`];

  const releaseByPage = new Map(releases.map((r) => [releasePageName(r), r]));
  const featureNames = new Set(FEATURE_PAGES.map((f) => f.page));
  const pages = new Map(); // page name -> text
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const page = e.name.replace(/\.md$/, "");
    if (!e.isFile() || !e.name.endsWith(".md")) { err(e.name, "not an allowed file (only .md pages are allowed)"); continue; }
    if (FIXED_PAGES.includes(page) || featureNames.has(page)) { pages.set(page, readText(join(dir, e.name))); continue; }
    if (page.startsWith("Release-")) {
      const r = releaseByPage.get(page);
      if (!r) err(e.name, "no matching entry in releases.json");
      else if (r.status === "planned") err(e.name, "a release that is not started has no page");
      else pages.set(page, readText(join(dir, e.name)));
      continue;
    }
    err(e.name, "not an allowed page name");
  }

  for (const need of [...FIXED_PAGES, ...featureNames]) if (!pages.has(need)) err(`${need}.md`, "page is missing");
  for (const r of shown(releases)) if (!pages.has(releasePageName(r))) err(`${releasePageName(r)}.md`, `${r.version} is ${r.status} and needs a page`);

  const denyRes = terms.map((t) => new RegExp(`(?<![A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}(?![A-Za-z0-9])`, "i"));
  const releaseVersions = new Set(releases.map((r) => r.version));
  const anchorCache = new Map();

  for (const [page, text] of pages) {
    const f = `${page}.md`;
    const lines = text.replace(/\n$/, "").split("\n").length;
    if (!text.trim()) { err(f, "page is empty"); continue; }
    if (lines > MAX_LINES) err(f, `page has ${lines} lines (the limit is ${MAX_LINES})`);

    if (EMAIL.test(text)) err(f, "an email address is on the page");
    if (/mailto:/i.test(text)) err(f, "a mailto: link is on the page");
    const lower = text.toLowerCase();
    for (const w of FORBIDDEN) if (lower.includes(w)) err(f, `forbidden word: "${w}"`);
    if (denyRes.some((re) => re.test(text))) err(f, "a term from the local denylist is on the page");

    for (const m of outsideFences(text).matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^mailto:/i.test(target)) continue; // already reported above
      if (/^https?:\/\//i.test(target)) {
        const repo = target.match(new RegExp(`^${REPO_URL.replace(/[.]/g, "\\.")}/(blob|tree)/([^/]+)/([^#]*)(?:#(.*))?$`));
        if (repo) {
          const [, kind, ref, rawPath, anchor] = repo;
          if (ref !== "main" && !releaseVersions.has(ref)) { err(f, `link to an unknown ref: ${target}`); continue; }
          const rel = decodeURIComponent(rawPath).replace(/\/+$/, "");
          const abs = join(root, rel);
          if (!existsSync(abs)) { err(f, `link to a path that does not exist: ${rel}`); continue; }
          if (kind === "blob" && !statSync(abs).isFile()) { err(f, `blob link to a folder: ${rel}`); continue; }
          if (anchor && abs.endsWith(".md")) {
            if (!anchorCache.has(abs)) anchorCache.set(abs, anchorsOf(readText(abs)));
            if (!anchorCache.get(abs).has(anchor)) err(f, `link to a heading that does not exist: ${rel}#${anchor}`);
          }
        } else if (!EXTRA_URLS.has(target)) err(f, `link outside the repository: ${target}`);
        continue;
      }
      if (target.startsWith("#")) continue;
      const to = target.split("#")[0];
      if (!pages.has(to)) err(f, `link to a wiki page that does not exist: ${to}`);
    }

    if (featureNames.has(page)) for (const h of FEATURE_HEADINGS) if (!new RegExp(`^${h}$`, "m").test(text)) err(f, `missing heading "${h}"`);
    if (page.startsWith("Release-")) for (const h of RELEASE_HEADINGS) if (!new RegExp(`^${h}$`, "m").test(text)) err(f, `missing heading "${h}"`);
  }

  const names = [...pages.keys()];
  if (pages.has("Releases") && pages.get("Releases") !== renderReleases(releases)) err("Releases.md", "out of date; run: node scripts/publish-wiki.mjs --write");
  if (pages.has("_Sidebar") && pages.get("_Sidebar") !== renderSidebar(names, releases)) err("_Sidebar.md", "out of date; run: node scripts/publish-wiki.mjs --write");
  return errors;
}

// ── Git helpers ─────────────────────────────────────────────────────────────
// Any user name or token in an address is removed before text is shown.
const redact = (s) => String(s).replace(/(https?:\/\/)[^@/\s]+@/g, "$1");

function git(args, { cwd, env } = {}) {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  if (r.error) throw new Error(`git could not run: ${r.error.code ?? "error"}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${redact((r.stderr || r.stdout).trim().split("\n")[0])}`);
  return r.stdout;
}

function repoAuthor(root) {
  const [name, email] = git(["log", "-1", "--format=%an%x00%ae"], { cwd: root }).trim().split("\0");
  return deriveAuthor(name, email);
}

function remoteAddress(root, env) {
  if (env.PUBLISH_WIKI_TEST === "1" && env.PUBLISH_WIKI_TEST_REMOTE) return env.PUBLISH_WIKI_TEST_REMOTE;
  return wikiUrl(git(["remote", "get-url", "origin"], { cwd: root }).trim());
}

const identityEnv = (a) => ({ GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_NAME: a.name, GIT_COMMITTER_EMAIL: a.email });
const COMMIT_FLAGS = ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify"];

// Replaces the .md pages in a work tree with the pages in dir.
function copyPages(dir, work) {
  for (const f of readdirSync(work)) if (f.endsWith(".md")) rmSync(join(work, f));
  for (const f of readdirSync(dir)) if (f.endsWith(".md")) copyFileSync(join(dir, f), join(work, f));
}

function publish({ dir, root, env, reset }) {
  const problems = validatePages(dir, { root });
  if (problems.length) { for (const p of problems) console.error(p); console.error(`wiki check failed: ${problems.length} problem(s)`); return 1; }
  const author = repoAuthor(root);
  const url = remoteAddress(root, env);
  const scratch = mkdtempSync(join(tmpdir(), "phasewright-wiki-"));
  try {
    if (!reset) {
      const work = join(scratch, "wiki");
      git(["clone", "--quiet", url, work]);
      copyPages(dir, work);
      git(["add", "-A"], { cwd: work });
      if (!git(["status", "--porcelain"], { cwd: work }).trim()) { console.log("no changes"); return 0; }
      git([...COMMIT_FLAGS, "-m", "Update wiki pages"], { cwd: work, env: identityEnv(author) });
      git(["push", "--quiet", "origin", "HEAD"], { cwd: work });
      console.log(`published the wiki pages as ${author.name}`);
      return 0;
    }
    const head = git(["ls-remote", "--symref", url, "HEAD"]).match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
    if (!head) throw new Error("could not find the wiki's default branch");
    const branch = head[1];
    // The backup comes first: a bundle holds every branch and commit of the wiki as it is now.
    const backup = join(mkdtempSync(join(tmpdir(), "phasewright-wiki-backup-")), "wiki.bundle");
    const old = join(scratch, "old");
    git(["clone", "--quiet", url, old]);
    git(["bundle", "create", backup, "--all"], { cwd: old });
    console.log(`backup bundle: ${backup}`);
    const fresh = join(scratch, "fresh");
    git(["init", "--quiet", fresh]);
    git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: fresh });
    copyPages(dir, fresh);
    git(["add", "-A"], { cwd: fresh });
    git([...COMMIT_FLAGS, "-m", "Publish wiki pages"], { cwd: fresh, env: identityEnv(author) });
    git(["push", "--quiet", "--force", url, `HEAD:refs/heads/${branch}`], { cwd: fresh });
    console.log(`wiki history replaced with one commit by ${author.name}`);
    return 0;
  } catch (e) {
    console.error(redact(e.message));
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ── The command line ────────────────────────────────────────────────────────
export function main(argv, { root = ROOT, env = process.env } = {}) {
  const dir = join(root, "docs", "wiki");
  const has = (f) => argv.includes(f);
  if (has("--write")) {
    const releases = loadReleases(root);
    writeFileSync(join(dir, "Releases.md"), renderReleases(releases));
    const names = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
    writeFileSync(join(dir, "_Sidebar.md"), renderSidebar(names, releases));
    console.log("wrote docs/wiki/Releases.md and docs/wiki/_Sidebar.md");
    return 0;
  }
  if (has("--check")) {
    const problems = validatePages(dir, { root });
    for (const p of problems) console.error(p);
    if (problems.length) { console.error(`wiki check failed: ${problems.length} problem(s)`); return 1; }
    console.log("wiki pages are valid");
    return 0;
  }
  if (has("--publish")) {
    const reset = has("--reset-history");
    if (reset !== has("--yes-force-push-wiki")) {
      console.error("replacing the wiki history needs both --reset-history and --yes-force-push-wiki; nothing was done");
      return 1;
    }
    return publish({ dir, root, env, reset });
  }
  console.error("usage: node scripts/publish-wiki.mjs --write | --check | --publish [--reset-history --yes-force-push-wiki]");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
