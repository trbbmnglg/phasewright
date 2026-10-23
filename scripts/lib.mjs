// Shared helpers for the library scripts. No dependencies.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS = dirname(fileURLToPath(import.meta.url));
// LIBRARY_ROOT lets tests point the scripts at a fixture repo.
export const ROOT = process.env.LIBRARY_ROOT ?? join(SCRIPTS, "..");
export const REPO = "trbbmnglg/phasewright";

const unquote = (v) => {
  const s = v.trim();
  if (/^".*"$/.test(s)) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return /^'.*'$/.test(s) ? s.slice(1, -1).replace(/''/g, "'") : s;
};

// Parses the small YAML subset these files use: scalars, one level of map, simple lists.
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: null, body: text };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (top) {
      key = top[1];
      data[key] = top[2] === "" ? null : unquote(top[2]);
      continue;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(unquote(item[1]));
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z][\w-]*):\s*(.*)$/);
    if (nested && key) {
      if (data[key] === null || typeof data[key] !== "object" || Array.isArray(data[key])) data[key] = {};
      data[key][nested[1]] = unquote(nested[2]);
    }
  }
  return { data, body: text.slice(m[0].length) };
}

export const read = (path) => readFileSync(path, "utf8");

// Files named *.local.* hold machine-specific data (for example a protected-process list). They never
// belong in library.json or a release zip, so listing skips them.
const LOCAL_FILE = /\.local\./;

export function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    if (LOCAL_FILE.test(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

export const rel = (path) => relative(ROOT, path).split("\\").join("/");

export function loadItems() {
  const skills = readdirSync(join(ROOT, "skills")).sort().map((slug) => {
    const dir = join(ROOT, "skills", slug);
    const { data, body } = parseFrontmatter(read(join(dir, "SKILL.md")));
    return { type: "skill", slug, dir, data, body, files: listFiles(dir).map(rel) };
  });
  const agents = readdirSync(join(ROOT, "agents", "claude")).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const file = join(ROOT, "agents", "claude", f);
    const { data, body } = parseFrontmatter(read(file));
    return { type: "agent", slug: f.replace(/\.md$/, ""), dir: file, data, body, files: [rel(file)] };
  });
  const plugins = existsSync(join(ROOT, "plugins")) ? readdirSync(join(ROOT, "plugins")).sort().map((slug) => {
    const dir = join(ROOT, "plugins", slug);
    const manifest = JSON.parse(read(join(dir, ".claude-plugin", "plugin.json")));
    return { type: "plugin", slug, dir, manifest, files: listFiles(dir).map(rel) };
  }) : [];
  return { skills, agents, plugins };
}
