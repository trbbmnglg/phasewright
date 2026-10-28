#!/usr/bin/env node
// Validates every item (root and plugin) and scans for personal or internal data.
//   node scripts/lint.mjs      lint the repo (LIBRARY_ROOT=<dir> lints a fixture instead)
// Frontmatter rules live in scripts/lint-rules.mjs.
// Local-only extra check: scripts/denylist.local.txt (git-ignored, one term per line).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as lib from "./lib.mjs";
import { NAME_RE, makeRules } from "./lint-rules.mjs";

const ROOT = lib.ROOT;
const errors = [];
const warnings = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);
const { checkYaml, checkMeta, checkAgent, checkSkill, checkHooksJson } = makeRules({ fail, warn });

const PII = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "email address", (m) => /noreply\.github\.com$|@example\.(com|org)$/.test(m)],
  [/(?<!\d)(\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}(?!\d)/g, "phone number"],
  // Left boundary: a key starts a token, so "risk-deadlines" or "task-AKIA..." don't match.
  [/(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, "API key or token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "private key"],
  [/[A-Za-z]:\\Users\\|\/Users\/[a-z]|\/home\/[a-z]/g, "machine path"],
  [/\b[0-9a-f]{64}\b/g, "64-char hex (token or AUD tag?)"],
];

const badName = (n) => !NAME_RE.test(n) || n.length > 64;
const NAME_RULE = "lowercase letters, digits and single hyphens, max 64";

// One skill folder. Root skills also need the metadata block and license; plugin skills don't.
function lintSkill(skillsDir, slug, whereBase, { plugin }) {
  const file = join(skillsDir, slug, "SKILL.md");
  const where = `${whereBase}/${slug}`;
  if (!existsSync(file)) return fail(where, "SKILL.md is missing");
  const raw = readFileSync(file, "utf8");
  checkYaml(where, raw);
  const { data, body } = lib.parseFrontmatter(raw);
  if (!plugin) checkMeta(where, data, true);
  else if (!data) fail(where, "missing frontmatter");
  if (!data) return;
  checkSkill(where, data, slug);
  if (badName(slug)) fail(where, `folder name must be ${NAME_RULE}`);
  const lines = body.split("\n").length;
  if (lines > 500) warn(where, `body is ${lines} lines (spec recommends under 500)`);
  const prose = body.replace(/```[\s\S]*?```/g, "");
  for (const [, target] of prose.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
    if (!existsSync(join(skillsDir, slug, target.split("#")[0]))) fail(where, `broken link: ${target}`);
  }
}

// One agent file, same rules as above.
function lintAgent(agentsDir, f, whereBase, { plugin }) {
  const where = `${whereBase}/${f}`;
  const raw = readFileSync(join(agentsDir, f), "utf8");
  checkYaml(where, raw);
  const { data } = lib.parseFrontmatter(raw);
  if (!plugin) checkMeta(where, data, false);
  else if (!data) fail(where, "missing frontmatter");
  const aslug = f.replace(/\.md$/, "");
  if (badName(aslug)) fail(where, `file name must be ${NAME_RULE}`);
  if (data) checkAgent(where, data, aslug, { plugin });
}

const mdFiles = (dir) => readdirSync(dir).filter((x) => x.endsWith(".md")).sort();

const skillsDir = join(ROOT, "skills");
for (const slug of readdirSync(skillsDir).sort()) lintSkill(skillsDir, slug, "skills", { plugin: false });

const agentsDir = join(ROOT, "agents", "claude");
for (const f of mdFiles(agentsDir)) lintAgent(agentsDir, f, "agents/claude", { plugin: false });

const pluginsDir = join(ROOT, "plugins");
if (existsSync(pluginsDir)) {
  for (const slug of readdirSync(pluginsDir).sort()) {
    const base = `plugins/${slug}`;
    if (badName(slug)) fail(base, `folder name must be ${NAME_RULE}`);
    const manifest = join(pluginsDir, slug, ".claude-plugin", "plugin.json");
    if (!existsSync(manifest)) { fail(base, "missing .claude-plugin/plugin.json"); continue; }
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    if (m.name !== slug) fail(base, `plugin name "${m.name}" must match the folder`);
    if (!m.version || !m.description) fail(base, "plugin.json needs version and description");
    const pSkills = join(pluginsDir, slug, "skills");
    if (existsSync(pSkills)) for (const s of readdirSync(pSkills).sort()) lintSkill(pSkills, s, `${base}/skills`, { plugin: true });
    const pAgents = join(pluginsDir, slug, "agents");
    if (existsSync(pAgents)) for (const f of mdFiles(pAgents)) lintAgent(pAgents, f, `${base}/agents`, { plugin: true });
    const pHooks = join(pluginsDir, slug, "hooks", "hooks.json");
    if (existsSync(pHooks)) checkHooksJson(`${base}/hooks/hooks.json`, readFileSync(pHooks, "utf8"));
  }
}

// Personal and internal data scan over every text file in the published tree.
const deny = [];
const denyFile = process.env.LIBRARY_DENYLIST ?? join(lib.SCRIPTS, "denylist.local.txt");
if (existsSync(denyFile)) {
  for (const line of readFileSync(denyFile, "utf8").split(/\r?\n/)) if (line.trim()) deny.push(line.trim().toLowerCase());
} else {
  warn("denylist", "scripts/denylist.local.txt not found: internal-term scan skipped (generic patterns still run)");
}
// Whole-word, case-insensitive: a term must not sit inside a longer word.
const denyRes = deny.map((t) => [t, new RegExp(`(?<![A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&")}(?![A-Za-z0-9])`, "i")]);
// The files git would publish (tracked, plus untracked and not ignored), so git-excluded local
// folders such as .plans/ aren't scanned. Outside a git work tree (test fixtures) walk the folder.
function publishedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean).map((p) => join(ROOT, p)).filter((f) => existsSync(f)).sort();
  } catch (e) {
    // Exit 128 is "not a git repository"; anything else (git missing, other error) gets one warning.
    if (e.status !== 128) warn("scan", `git file listing failed (${e.code ?? e.status}); scanning every file on disk`);
    return lib.listFiles(ROOT);
  }
}
const SKIP = /(^|\/)(\.git|node_modules|dist|evals\/results)\/|\.(png|jpg|webp|zip|woff2)$|(^|\/)scripts\/denylist\.local\.txt$|\.local\.[^/]+$/;
for (const file of publishedFiles()) {
  const path = lib.rel(file);
  if (SKIP.test(path)) continue;
  const text = readFileSync(file, "utf8");
  for (const [re, label, allow] of PII) {
    for (const m of text.matchAll(re)) if (!(allow && allow(m[0]))) fail(path, `${label} found: "${m[0].slice(0, 40)}"`);
  }
  for (const [term, re] of denyRes) if (re.test(text)) fail(path, `internal term from the local denylist found: "${term}"`);
}

for (const w of warnings) console.log(`warning  ${w}`);
for (const e of errors) console.log(`error    ${e}`);
console.log(errors.length ? `\nlint failed: ${errors.length} error(s)` : "\nlint passed");
process.exit(errors.length ? 1 : 0);
