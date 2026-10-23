#!/usr/bin/env node
// Validates every item and scans for personal or internal data.
//   node scripts/lint.mjs      lint the repo (LIBRARY_ROOT=<dir> lints a fixture instead)
// Local-only extra check: scripts/denylist.local.txt (git-ignored, one term per line).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as lib from "./lib.mjs";

const ROOT = lib.ROOT;
const errors = [];
const warnings = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MODELS = new Set(["opus", "sonnet", "haiku", "inherit", "best"]);
const META_KEYS = ["title", "tags", "featured", "order", "version"];

const PII = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "email address", (m) => /noreply\.github\.com$|@example\.(com|org)$/.test(m)],
  [/(?<!\d)(\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}(?!\d)/g, "phone number"],
  [/sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}/g, "API key or token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "private key"],
  [/[A-Za-z]:\\Users\\|\/Users\/[a-z]|\/home\/[a-z]/g, "machine path"],
  [/\b[0-9a-f]{64}\b/g, "64-char hex (token or AUD tag?)"],
];

// Real YAML rejects some plain scalars that the lenient parser accepts, and Claude Code then
// drops every frontmatter field silently. Catch the common causes: ": " or " #" inside an
// unquoted value, or a value that starts with a YAML indicator.
function checkYaml(where, text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z][\w-]*):\s+(.+)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    if (/^["'[{|>]/.test(v)) continue;
    if (/^[*&!%@`]/.test(v)) fail(where, `frontmatter "${kv[1]}" starts with a YAML indicator; quote the value`);
    else if (/: |\s#/.test(v)) fail(where, `frontmatter "${kv[1]}" has an unquoted ": " or " #"; wrap the value in double quotes`);
  }
}

function checkMeta(where, data, withLicense) {
  if (!data) return fail(where, "missing frontmatter");
  const md = data.metadata;
  if (!md || typeof md !== "object") fail(where, "missing metadata block");
  else for (const k of META_KEYS) if (!md[k]) fail(where, `metadata.${k} is missing`);
  if (md?.featured && !["true", "false"].includes(md.featured)) fail(where, 'metadata.featured must be "true" or "false"');
  if (md?.order && !/^\d+$/.test(md.order)) fail(where, "metadata.order must be a whole number");
  if (withLicense && data.license !== "MIT") fail(where, "license must be MIT");
}

function checkDescription(where, d) {
  if (!d) return fail(where, "description is missing");
  if (d.length > 1024) fail(where, `description is ${d.length} characters (max 1024)`);
}

const skillsDir = join(ROOT, "skills");
for (const slug of readdirSync(skillsDir).sort()) {
  const file = join(skillsDir, slug, "SKILL.md");
  const where = `skills/${slug}`;
  if (!existsSync(file)) { fail(where, "SKILL.md is missing"); continue; }
  const raw = readFileSync(file, "utf8");
  checkYaml(where, raw);
  const { data, body } = lib.parseFrontmatter(raw);
  checkMeta(where, data, true);
  if (!data) continue;
  if (data.name !== slug) fail(where, `name "${data.name}" must match the folder "${slug}"`);
  if (!NAME_RE.test(slug) || slug.length > 64) fail(where, "folder name must be lowercase letters, digits and single hyphens, max 64");
  checkDescription(where, data.description);
  const lines = body.split("\n").length;
  if (lines > 500) warn(where, `body is ${lines} lines (spec recommends under 500)`);
  const prose = body.replace(/```[\s\S]*?```/g, "");
  for (const [, target] of prose.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
    if (!existsSync(join(skillsDir, slug, target.split("#")[0]))) fail(where, `broken link: ${target}`);
  }
}

const agentsDir = join(ROOT, "agents", "claude");
for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md")).sort()) {
  const where = `agents/claude/${f}`;
  const raw = readFileSync(join(agentsDir, f), "utf8");
  checkYaml(where, raw);
  const { data } = lib.parseFrontmatter(raw);
  checkMeta(where, data, false);
  const aslug = f.replace(/\.md$/, "");
  if (!NAME_RE.test(aslug) || aslug.length > 64) fail(where, "file name must be lowercase letters, digits and single hyphens, max 64");
  if (!data) continue;
  if (data.name !== aslug) fail(where, `name "${data.name}" must match the file name`);
  checkDescription(where, data.description);
  if (!MODELS.has(data.model)) fail(where, `model "${data.model}" must be an alias (opus, sonnet, haiku, inherit)`);
}

const pluginsDir = join(ROOT, "plugins");
if (existsSync(pluginsDir)) {
  for (const slug of readdirSync(pluginsDir).sort()) {
    if (!NAME_RE.test(slug) || slug.length > 64) fail(`plugins/${slug}`, "folder name must be lowercase letters, digits and single hyphens, max 64");
    const manifest = join(pluginsDir, slug, ".claude-plugin", "plugin.json");
    if (!existsSync(manifest)) { fail(`plugins/${slug}`, "missing .claude-plugin/plugin.json"); continue; }
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    if (m.name !== slug) fail(`plugins/${slug}`, `plugin name "${m.name}" must match the folder`);
    if (!m.version || !m.description) fail(`plugins/${slug}`, "plugin.json needs version and description");
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
const SKIP = /(^|\/)(\.git|node_modules|dist|evals\/results)\/|\.(png|jpg|webp|zip)$|(^|\/)scripts\/denylist\.local\.txt$|\.local\.[^/]+$/;
for (const file of lib.listFiles(ROOT)) {
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
