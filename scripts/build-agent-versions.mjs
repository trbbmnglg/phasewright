#!/usr/bin/env node
// Generates the OpenAI Codex and Google Antigravity versions of every agent from its Claude version, agents/claude/<slug>.md:
//   agents/codex/<slug>.toml        a Codex custom agent: name, description and developer_instructions (the Markdown body)
//   agents/antigravity/<slug>.md    an Antigravity agent: the same body, with name and description in its frontmatter
//   node scripts/build-agent-versions.mjs           write them
//   node scripts/build-agent-versions.mjs --check   exit 1 if one is missing, out of date, or left over with no Claude version
// The generated files are never edited by hand: edit the Claude version and run this script. `build-manifest.mjs --check` (and so
// `npm run verify`) fails until they match.
// Both versions leave out the Claude version's `model` and `tools`: opus and sonnet are not model names either tool takes, and each
// tool names its tools its own way, so a version inherits the model and the tool list from the tool's own settings. The manifest
// says so in each tool's note, and marks a version partial when that drops a limit the Claude version has (agentToolLimit).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, parseFrontmatter } from "./lib.mjs";

export const VERSIONS = [
  { tool: "codex", dir: "codex", ext: ".toml" },
  { tool: "antigravity", dir: "antigravity", ext: ".md" },
];

// The tools that, together, are everything a coding agent does: an agent whose Claude version lists all of them (or no list at all) loses
// nothing when its version inherits the tool's own list. An agent limited to fewer keeps that limit only in Claude Code.
export const FULL_TOOLSET = ["Read", "Edit", "Write", "Grep", "Glob", "Bash"];
export function agentToolLimit(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const missing = FULL_TOOLSET.filter((t) => !tools.includes(t));
  return missing.length ? tools.join(", ") : null;
}

const header = (slug) => `Generated from agents/claude/${slug}.md by scripts/build-agent-versions.mjs. Edit that file, then run: node scripts/build-agent-versions.mjs`;

// TOML basic strings: a backslash, a quote and every control character but newline and tab are escaped (a multi-line one keeps its
// newlines and escapes a run of three quotes, so the text can never close the string early).
const control = (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
export const tomlString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, control)}"`;
export const tomlMultiline = (s) => {
  const text = String(s).replace(/\r\n?/g, "\n").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, control);
  return `"""\n${text.endsWith("\n") ? text : `${text}\n`}"""`;
};

export function codexVersion(slug, data, body) {
  return [`# ${header(slug)}`, `name = ${tomlString(data.name)}`, `description = ${tomlString(data.description)}`, `developer_instructions = ${tomlMultiline(body.replace(/^\s+/, ""))}`, ""].join("\n");
}

export function antigravityVersion(slug, data, body) {
  return ["---", `# ${header(slug)}`, `name: ${data.name}`, `description: ${JSON.stringify(data.description)}`, "---", "", body.replace(/^\s+/, "").replace(/\r\n?/g, "\n")].join("\n");
}

// Every generated file, keyed by its path from the repo root.
export function agentVersions(root = ROOT) {
  const dir = join(root, "agents", "claude");
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    const slug = f.replace(/\.md$/, "");
    const { data, body } = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
    if (!data?.name || !data?.description) throw new Error(`agents/claude/${f}: name and description are needed to build its versions`);
    out.set(`agents/codex/${slug}.toml`, codexVersion(slug, data, body));
    out.set(`agents/antigravity/${slug}.md`, antigravityVersion(slug, data, body));
  }
  return out;
}

// What --check finds: [path, reason] for every file that is missing, different or left over.
export function versionProblems(root = ROOT) {
  const want = agentVersions(root);
  const problems = [];
  for (const [path, text] of want) {
    const file = join(root, path);
    if (!existsSync(file)) problems.push([path, "missing"]);
    else if (readFileSync(file, "utf8") !== text) problems.push([path, "out of date"]);
  }
  for (const { dir, ext } of VERSIONS) {
    const folder = join(root, "agents", dir);
    if (!existsSync(folder)) continue;
    for (const f of readdirSync(folder)) if (!want.has(`agents/${dir}/${f}`)) problems.push([`agents/${dir}/${f}`, f.endsWith(ext) ? "has no Claude version" : "is not a generated file"]);
  }
  return problems;
}

export function writeVersions(root = ROOT) {
  const want = agentVersions(root);
  for (const { dir } of VERSIONS) {
    const folder = join(root, "agents", dir);
    if (existsSync(folder)) for (const f of readdirSync(folder)) if (!want.has(`agents/${dir}/${f}`)) rmSync(join(folder, f));
  }
  for (const [path, text] of want) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return want.size;
}

if (process.argv[1]?.endsWith("build-agent-versions.mjs")) {
  if (process.argv.includes("--check")) {
    const problems = versionProblems();
    for (const [path, why] of problems) console.log(`${path} ${why}`);
    if (problems.length) {
      console.log("The agent versions are out of date. Run: node scripts/build-agent-versions.mjs");
      process.exit(1);
    }
    console.log("agent versions are up to date");
  } else {
    console.log(`agent versions written (${writeVersions()} files)`);
  }
}
