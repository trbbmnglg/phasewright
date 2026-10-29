#!/usr/bin/env node
// Generates library.json: the catalogue of every item, with its install steps per tool.
//   node scripts/build-manifest.mjs           write library.json
//   node scripts/build-manifest.mjs --check   exit 1 if library.json, or an agent's Codex or Antigravity version, is out of date
// Deterministic: no timestamps, stable ordering.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentToolLimit, versionProblems, writeVersions } from "./build-agent-versions.mjs";
import { REPO, ROOT, loadItems, parseFrontmatter, rel } from "./lib.mjs";

const SCHEMA_VERSION = 1;
const BLOB = `https://github.com/${REPO}/tree/main`;
const BLOB_FILE = `https://github.com/${REPO}/blob/main`; // agents are single files

const SUMMARY_FALLBACK_AT = 160; // no sentence end within 200: text up to this length is used whole
const SUMMARY_CUT = 157; // longer text is cut at a word boundary at or before this, plus an ellipsis

export const firstSentence = (text) => {
  const clean = text.replace(/\s+/g, " ").trim();
  const m = clean.match(/^(.{20,200}?[.!?])(\s|$)/);
  if (m) return m[1].trim();
  if (clean.length <= SUMMARY_FALLBACK_AT) return clean;
  // A single word longer than the limit has no boundary to cut at, so it is cut hard.
  const space = clean.lastIndexOf(" ", SUMMARY_CUT);
  const cut = clean.slice(0, space > 0 ? space : SUMMARY_CUT);
  return cut.replace(/[\s.,;:!?\-\u2013\u2014([]+$/, "") + "\u2026";
};

const tags = (s) => s.split(",").map((t) => t.trim()).filter(Boolean);
const common = (item, d, md, extra) => ({
  slug: item.slug,
  type: item.type,
  title: md.title,
  summary: firstSentence(d.description),
  description: d.description.replace(/\s+/g, " ").trim(),
  tags: tags(md.tags),
  featured: md.featured === "true",
  order: Number(md.order),
  version: md.version,
  license: d.license ?? "MIT",
  path: rel(item.dir),
  files: item.files,
  source_url: `${item.type === "agent" ? BLOB_FILE : BLOB}/${rel(item.dir)}`,
  ...extra,
});

const support = (level, note) => (note ? { support: level, note } : { support: level });
const copyTo = (project, personal, slug) => [
  `Copy skills/${slug} into ${project}/ (project)${personal ? ` or ${personal}/ (personal)` : ""}`,
];

// OpenAI Codex and Google Antigravity both load skills from SKILL.md folders, so a skill folder works there as it is. Two Claude Code
// fields don't carry over, and a skill that uses one is partial there: a pinned `model`, and `disable-model-invocation` (manual only).
const CODEX_SKILLS = "Codex reads .agents/skills in the project and its parent folders up to the repo root, ~/.agents/skills and /etc/codex/skills";
const ANTIGRAVITY_SKILLS = "Antigravity reads .agents/skills (the older .agent/skills still works); its CLI reads ~/.gemini/antigravity-cli/skills";
function skillLosses(data, manualOnly) {
  const out = [];
  if (data?.model) out.push("the pinned model is not carried over");
  if (data?.["disable-model-invocation"] === "true") out.push(manualOnly);
  return out;
}
function otherSkillTools(slug, data) {
  const codexLoss = skillLosses(data, "for manual only, add agents/openai.yaml with policy.allow_implicit_invocation: false");
  const agyLoss = skillLosses(data, "manual only is a Claude Code field, so Antigravity may use it unasked");
  return {
    codex: {
      ...(codexLoss.length ? support("partial", `Skills load; ${codexLoss.join("; ")}`) : support("full", CODEX_SKILLS)),
      install: copyTo(".agents/skills", "~/.agents/skills", slug),
    },
    antigravity: {
      ...(agyLoss.length ? support("partial", `Skills load; ${agyLoss.join("; ")}`) : support("full", ANTIGRAVITY_SKILLS)),
      install: [`Copy skills/${slug} into .agents/skills/ (project) or ~/.gemini/config/skills/ (personal, App and IDE)`, `For the CLI, copy it into ~/.gemini/antigravity-cli/skills/`],
    },
  };
}

function skillTools(slug, data) {
  return {
    "claude-code": {
      ...support("full"),
      install: [
        `claude plugin marketplace add ${REPO}`,
        "claude plugin install phasewright@phasewright",
        `Or copy skills/${slug} into .claude/skills/ (project) or ~/.claude/skills/ (personal)`,
      ],
    },
    copilot: {
      ...support("full", "VS Code reads .github/skills, .claude/skills and .agents/skills"),
      install: copyTo(".github/skills", "~/.copilot/skills", slug),
    },
    cursor: {
      ...support("full", "Cursor reads .cursor/skills and .agents/skills"),
      install: copyTo(".cursor/skills", "~/.cursor/skills", slug),
    },
    ...otherSkillTools(slug, data),
  };
}

// An agent's Codex and Antigravity versions are generated from its Claude version (build-agent-versions.mjs), and inherit the model and
// the tool list from the tool's own settings: partial when the Claude version limits the tools to fewer than the full set.
function agentVersionTool(tool, file, folders, limit) {
  const inherited = `The model and the tool list come from your ${tool} settings`;
  return {
    ...(limit ? support("partial", `${inherited}; the Claude version's limit to ${limit} is not kept`) : support("full", `${inherited}`)),
    install: [`Copy ${file} into ${folders}`],
  };
}

function agentTools(slug, data) {
  const limit = agentToolLimit(data?.tools);
  return {
    "claude-code": {
      ...support("full"),
      install: [`Copy agents/claude/${slug}.md into .claude/agents/ (project) or ~/.claude/agents/ (personal)`],
    },
    copilot: {
      ...support("full", "VS Code also reads Claude-format agents from .claude/agents"),
      install: [`Copy agents/claude/${slug}.md into .claude/agents/ (project) or ~/.claude/agents/ (personal)`],
    },
    cursor: { ...support("none", "No documented custom-agent file format; use the matching skill instead"), install: [] },
    codex: agentVersionTool("Codex", `agents/codex/${slug}.toml`, ".codex/agents/ (project) or ~/.codex/agents/ (personal)", limit),
    antigravity: agentVersionTool("Antigravity", `agents/antigravity/${slug}.md`, ".agents/agents/ (project) or ~/.gemini/config/agents/ (personal, App and CLI)", limit),
  };
}

// A plugin loses something outside Claude Code only if it has agents or pins a model in a skill.
// Without either, its skills are plain SKILL.md files that Copilot and Cursor read in full.
export function pluginNeedsClaudeCode(dir) {
  if (existsSync(join(dir, "agents"))) return true;
  const skillsDir = join(dir, "skills");
  if (!existsSync(skillsDir)) return false;
  return readdirSync(skillsDir).some((slug) => {
    const file = join(skillsDir, slug, "SKILL.md");
    if (!existsSync(file)) return false;
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    return Boolean(data && data.model);
  });
}

function pluginTools(slug, needsClaudeCode) {
  const other = needsClaudeCode ? support("partial", "Skills load; model pinning and agents are Claude Code features") : support("full");
  return {
    "claude-code": {
      ...support("full"),
      install: [`claude plugin marketplace add ${REPO}`, `claude plugin install ${slug}@phasewright`],
    },
    copilot: { ...other, install: [`Copy plugins/${slug}/skills/* into .github/skills/`] },
    cursor: { ...other, install: [`Copy plugins/${slug}/skills/* into .cursor/skills/`] },
    // Neither tool's own plugin format is supported yet: the skills are what carries over.
    codex: { ...support("partial", NO_NATIVE_PLUGIN), install: [`Copy plugins/${slug}/skills/* into .agents/skills/`] },
    antigravity: { ...support("partial", NO_NATIVE_PLUGIN), install: [`Copy plugins/${slug}/skills/* into .agents/skills/`] },
  };
}
const NO_NATIVE_PLUGIN = "No native plugin package yet: copy the plugin's skills; its hooks, agents and model pins don't carry over";

export function build() {
  const { skills, agents, plugins } = loadItems();
  const items = [
    ...skills.map((s) => common(s, s.data, s.data.metadata, { zip: `skill-${s.slug}.zip`, tools: skillTools(s.slug, s.data) })),
    // An agent's zip and files also hold its generated Codex and Antigravity versions, which its install steps name.
    ...agents.map((a) => common({ ...a, files: [...a.files, `agents/codex/${a.slug}.toml`, `agents/antigravity/${a.slug}.md`] }, a.data, a.data.metadata, {
      license: "MIT", zip: `agent-${a.slug}.zip`, model: a.data.model, tools: agentTools(a.slug, a.data),
    })),
    ...plugins.map((p) => {
      const metadata = { title: p.slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "), tags: (p.manifest.keywords ?? []).join(","), featured: "true", order: "1", version: p.manifest.version };
      return common(p, { description: p.manifest.description, license: "MIT" }, metadata, { zip: `plugin-${p.slug}.zip`, tools: pluginTools(p.slug, pluginNeedsClaudeCode(p.dir)) });
    }),
  ];
  items.sort((a, b) => a.type.localeCompare(b.type) || a.order - b.order || a.slug.localeCompare(b.slug));
  const slugs = new Set();
  for (const i of items) {
    const key = `${i.type}/${i.slug}`;
    if (slugs.has(key)) throw new Error(`duplicate item ${key}`);
    slugs.add(key);
  }
  return { schema_version: SCHEMA_VERSION, repo: REPO, license: "MIT", items };
}

if (process.argv[1]?.endsWith("build-manifest.mjs")) {
  const out = JSON.stringify(build(), null, 2) + "\n";
  const target = join(ROOT, "library.json");
  if (process.argv.includes("--check")) {
    const versions = versionProblems();
    for (const [path, why] of versions) console.log(`${path} ${why}`);
    if (versions.length) console.log("The agent versions are out of date. Run: node scripts/build-agent-versions.mjs");
    const stale = !existsSync(target) || readFileSync(target, "utf8") !== out;
    if (stale) console.log("library.json is out of date. Run: node scripts/build-manifest.mjs");
    if (stale || versions.length) process.exit(1);
    console.log("library.json and the agent versions are up to date");
  } else {
    // the agent versions first: library.json names their files, so the two are always written together
    const versions = writeVersions();
    writeFileSync(target, out);
    console.log(`library.json written (${JSON.parse(out).items.length} items); agent versions written (${versions} files)`);
  }
}
