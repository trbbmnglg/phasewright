#!/usr/bin/env node
// Generates library.json: the catalogue of every item, with its install steps per tool.
//   node scripts/build-manifest.mjs           write library.json
//   node scripts/build-manifest.mjs --check   exit 1 if library.json is out of date
// Deterministic: no timestamps, stable ordering.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, ROOT, loadItems, rel } from "./lib.mjs";

const SCHEMA_VERSION = 1;
const BLOB = `https://github.com/${REPO}/tree/main`;
const BLOB_FILE = `https://github.com/${REPO}/blob/main`; // agents are single files

const firstSentence = (text) => {
  const clean = text.replace(/\s+/g, " ").trim();
  const m = clean.match(/^(.{20,200}?[.!?])(\s|$)/);
  return (m ? m[1] : clean.slice(0, 160)).trim();
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

function skillTools(slug) {
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
    "agent-skills": {
      ...support("partial", "Any tool that loads skills from a folder; check where it keeps them"),
      install: copyTo(".agents/skills", null, slug),
    },
  };
}

function agentTools(slug) {
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
    "agent-skills": { ...support("none", "Agents are tool-specific"), install: [] },
  };
}

function pluginTools(slug) {
  return {
    "claude-code": {
      ...support("full"),
      install: [`claude plugin marketplace add ${REPO}`, `claude plugin install ${slug}@phasewright`],
    },
    copilot: { ...support("partial", "Skills load; model pinning and agents are Claude Code features"), install: [`Copy plugins/${slug}/skills/* into .github/skills/`] },
    cursor: { ...support("partial", "Skills load; model pinning and agents are Claude Code features"), install: [`Copy plugins/${slug}/skills/* into .cursor/skills/`] },
    "agent-skills": { ...support("none"), install: [] },
  };
}

export function build() {
  const { skills, agents, plugins } = loadItems();
  const items = [
    ...skills.map((s) => common(s, s.data, s.data.metadata, { zip: `skill-${s.slug}.zip`, tools: skillTools(s.slug) })),
    ...agents.map((a) => common(a, a.data, a.data.metadata, {
      license: "MIT", zip: `agent-${a.slug}.zip`, model: a.data.model, tools: agentTools(a.slug),
    })),
    ...plugins.map((p) => {
      const metadata = { title: p.slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "), tags: (p.manifest.keywords ?? []).join(","), featured: "true", order: "1", version: p.manifest.version };
      return common(p, { description: p.manifest.description, license: "MIT" }, metadata, { zip: `plugin-${p.slug}.zip`, tools: pluginTools(p.slug) });
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
    if (!existsSync(target) || readFileSync(target, "utf8") !== out) {
      console.log("library.json is out of date. Run: node scripts/build-manifest.mjs");
      process.exit(1);
    }
    console.log("library.json is up to date");
  } else {
    writeFileSync(target, out);
    console.log(`library.json written (${JSON.parse(out).items.length} items)`);
  }
}
