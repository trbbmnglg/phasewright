#!/usr/bin/env node
// Installs the plugins as personal skills and agents (~/.claude/skills, ~/.claude/agents),
// for setups that don't use plugin marketplaces. phased-shipping names get a "ps-" prefix because
// personal skills and agents aren't namespaced like plugin ones; free-resources has no prefix.
//
//   node scripts/sync-personal.mjs           install or update (and prune copies whose source is gone)
//   node scripts/sync-personal.mjs --remove  remove the generated copies
//   node scripts/sync-personal.mjs --check   exit 1 if the copies are missing, out of date or stale
//
// Only files carrying a generated marker are ever overwritten or removed, and each plugin has its own
// marker. A file or skill without the right marker is refused, never overwritten.
//
// phased-shipping also installs its guard hook: the .mjs files of plugins/phased-shipping/hooks go to
// <claude home>/phased-shipping/hooks (each starts with a marker comment), and every ps-* agent copy
// gets a frontmatter `hooks:` block that runs the guard for that agent. Plugin agents ignore a
// `hooks` field, so the block exists only in these generated copies. The block sets
// `onFailure: block` (Claude Code v2.1.295 or later; on an older version the key is most likely
// ignored, which is undocumented, and the hook then fails open): if the hook can't run (node missing,
// the script gone), the call is blocked instead of going ahead. The plugin's own hooks.json can't do
// that safely, because there a missing node would block the main session too.
//
// SYNC_PERSONAL_CLAUDE_HOME points the script at another folder instead of ~/.claude (the tests use it).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, rmdirSync, statSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins");
const CLAUDE = process.env.SYNC_PERSONAL_CLAUDE_HOME || join(homedir(), ".claude");

const markerFor = (name) => `<!-- Generated from the ${name} plugin by scripts/sync-personal.mjs. Edit the plugin, then re-run the script. -->`;
// The same sentence as a first-line comment, for the hook scripts.
const jsMarkerFor = (name) => `// Generated from the ${name} plugin by scripts/sync-personal.mjs. Edit the plugin, then re-run the script.`;

// The tools each phased-shipping agent's guard is attached to (model-scout has no shell).
const SHELL_AND_FILES = "Bash|PowerShell|Write|Edit|NotebookEdit";
const GUARD_MATCHERS = { builder: SHELL_AND_FILES, checker: SHELL_AND_FILES, shipper: SHELL_AND_FILES, "model-scout": "Write|Edit|NotebookEdit" };

const PLUGINS = [
  {
    name: "phased-shipping",
    prefix: "ps-",
    components: /phased-shipping:(plan|run|model-scout|builder|checker|shipper)\b/g,
    // ${CLAUDE_PLUGIN_DATA} only exists for installed plugins; personal copies keep their history here.
    data: join(CLAUDE, "phased-shipping").split("\\").join("/"),
    siblings: /\.\.\/(plan|run)\//g,
  },
  { name: "free-resources", prefix: "", components: null, data: null, siblings: null },
].map((p) => {
  const hooksSrc = join(PLUGINS_DIR, p.name, "hooks");
  return {
    ...p,
    dir: join(PLUGINS_DIR, p.name),
    marker: markerFor(p.name),
    jsMarker: jsMarkerFor(p.name),
    // The guard hook scripts: where they come from and where the personal copy puts them.
    hooks: p.data && existsSync(hooksSrc) ? { src: hooksSrc, dest: join(CLAUDE, p.name, "hooks") } : null,
  };
});

const remove = process.argv.includes("--remove");
const check = process.argv.includes("--check");
let stale = 0;

// The hook command is written as shell text with the path inside double quotes. A path with a $,
// a backtick or a double quote would change what that text means, so refuse it before writing anything.
if (!remove && /[$`"]/.test(CLAUDE)) {
  console.error(`Refusing to install: the Claude home path ${CLAUDE} contains a $, a backtick or a double quote, which would break the hook command. Use a folder without them.`);
  process.exit(1);
}

// The frontmatter `hooks:` block that runs the guard for one agent.
function hooksBlock(plugin, role, eol) {
  const command = `node "${plugin.hooks.dest.split("\\").join("/")}/guard.mjs" --agent ${role}`;
  // Plain YAML unless the text needs quoting.
  const value = /: | #|^[-?:,[\]{}#&*!|>'"%@`]/.test(command) ? `'${command.replace(/'/g, "''")}'` : command;
  return [
    "hooks:",
    "  PreToolUse:",
    `    - matcher: "${GUARD_MATCHERS[role]}"`,
    "      hooks:",
    "        - type: command",
    `          command: ${value}`,
    "          onFailure: block",
  ].join(eol);
}

// `role` is set for an agent that gets the guard block.
function transform(plugin, text, role) {
  let out = text;
  if (role && plugin.hooks) {
    // Function replacers: a path or command may contain "$".
    out = out.replace(/^(---(\r?\n)[\s\S]*?)(\r?\n---\r?\n)/, (_, head, eol, fence) => `${head}${eol}${hooksBlock(plugin, role, eol)}${fence}`);
  }
  if (plugin.components) out = out.replace(plugin.components, `${plugin.prefix}$1`);
  if (plugin.data) out = out.split("${CLAUDE_PLUGIN_DATA}").join(plugin.data);
  if (plugin.siblings) out = out.replace(plugin.siblings, `../${plugin.prefix}$1/`);
  if (plugin.prefix) out = out.replace(/^(---\r?\n[\s\S]*?^)name: (\S+)/m, `$1name: ${plugin.prefix}$2`);
  // Put the marker right after the closing frontmatter fence.
  return out.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/, (_, head) => `${head}\n${plugin.marker}\n`);
}

// The agent copy must hold the guard's hooks block for its role; otherwise stop and name the file.
function verifyBlock(file, text, role) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? "";
  if (!/^hooks:\r?$/m.test(fm) || !fm.includes('guard.mjs" --agent ' + role) || !/^\s+onFailure: block\r?$/m.test(fm)) {
    console.error("The guard hooks block is missing from the generated copy of " + file + " (check the agent's frontmatter). Nothing was written for it.");
    process.exit(1);
  }
}

function render(plugin, path, role) {
  return path.endsWith(".md") ? Buffer.from(transform(plugin, readFileSync(path, "utf8"), role)) : readFileSync(path);
}

// A hook script with the marker comment as its first line.
const renderHook = (plugin, path) => Buffer.from(`${plugin.jsMarker}\n${readFileSync(path, "utf8")}`);

function put(to, content) {
  if (check) {
    if (!existsSync(to) || Buffer.compare(readFileSync(to), content) !== 0) {
      stale++;
      console.log(`out of date: ${to}`);
    }
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, content);
}

const isOurs = (plugin, path) => existsSync(path) && readFileSync(path, "utf8").includes(plugin.marker);
const isOurHook = (plugin, path) => existsSync(path) && readFileSync(path, "utf8").startsWith(plugin.jsMarker);

// The plugin whose marker a file carries, or null for any file this script didn't generate.
const ownerOf = (path) => (existsSync(path) ? PLUGINS.find((p) => readFileSync(path, "utf8").includes(p.marker)) ?? null : null);

function refuse(path) {
  console.error(`Refusing to overwrite ${path}: it wasn't generated by this script.`);
  process.exit(1);
}

function guard(plugin, path) {
  if (existsSync(path) && !isOurs(plugin, path)) refuse(path);
}

function copyTree(plugin, src, dest) {
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dest, entry);
    if (statSync(from).isDirectory()) copyTree(plugin, from, to);
    else put(to, render(plugin, from));
  }
}

// Every .mjs file under dir, as paths relative to it ("guard.mjs", "lib/shell.mjs").
const mjsFiles = (dir, base = "") => (existsSync(dir)
  ? readdirSync(dir).sort().flatMap((e) => {
    const full = join(dir, e);
    if (lstatSync(full).isDirectory()) return mjsFiles(full, `${base}${e}/`);
    return e.endsWith(".mjs") ? [`${base}${e}`] : [];
  })
  : []);

const mdFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : []);
const dirs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => lstatSync(join(dir, f)).isDirectory()) : []);

// What each plugin installs: [{ plugin, skills: [name], agents: [file], hookFiles: [relative path] }]
const plan = PLUGINS.map((plugin) => ({
  plugin,
  skills: dirs(join(plugin.dir, "skills")),
  agents: mdFiles(join(plugin.dir, "agents")),
  hookFiles: plugin.hooks ? mjsFiles(plugin.hooks.src) : [],
}));

// Refuse before writing anything if a target exists but isn't ours.
if (!remove) {
  for (const { plugin, skills, agents, hookFiles } of plan) {
    for (const skill of skills) guard(plugin, join(CLAUDE, "skills", plugin.prefix + skill, "SKILL.md"));
    for (const file of agents) guard(plugin, join(CLAUDE, "agents", plugin.prefix + file));
    for (const rel of hookFiles) {
      const path = join(plugin.hooks.dest, rel);
      if (existsSync(path) && !isOurHook(plugin, path)) refuse(path);
    }
    // Every agent that should carry the guard block must come out with it (nothing is written yet).
    if (plugin.hooks) {
      for (const file of agents) {
        const name = file.replace(/\.md$/, "");
        if (GUARD_MATCHERS[name]) verifyBlock(file, render(plugin, join(plugin.dir, "agents", file), name).toString(), name);
      }
    }
  }
}

for (const { plugin, skills, agents, hookFiles } of plan) {
  for (const skill of skills) {
    const dest = join(CLAUDE, "skills", plugin.prefix + skill);
    const main = join(dest, "SKILL.md");
    if (remove) {
      if (isOurs(plugin, main)) { rmSync(dest, { recursive: true }); console.log(`removed skill ${plugin.prefix}${skill}`); }
      continue;
    }
    copyTree(plugin, join(plugin.dir, "skills", skill), dest);
    if (!check) console.log(`skill  /${plugin.prefix}${skill}  -> ${dest}`);
  }

  for (const file of agents) {
    const dest = join(CLAUDE, "agents", plugin.prefix + file);
    const name = file.replace(/\.md$/, "");
    if (remove) {
      if (isOurs(plugin, dest)) { rmSync(dest); console.log(`removed agent ${plugin.prefix}${name}`); }
      continue;
    }
    put(dest, render(plugin, join(plugin.dir, "agents", file), plugin.hooks && GUARD_MATCHERS[name] ? name : undefined));
    if (!check) console.log(`agent  ${plugin.prefix}${name}  -> ${dest}`);
  }

  for (const rel of hookFiles) {
    const dest = join(plugin.hooks.dest, rel);
    if (remove) {
      if (isOurHook(plugin, dest)) { rmSync(dest); console.log(`removed hook ${rel}`); }
      continue;
    }
    put(dest, renderHook(plugin, join(plugin.hooks.src, rel)));
    if (!check) console.log(`hook   ${rel}  -> ${dest}`);
  }
  // Leave no empty hooks folders behind after a remove.
  if (remove && plugin.hooks) {
    for (const dir of [join(plugin.hooks.dest, "lib"), plugin.hooks.dest]) {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    }
  }
}

// Prune: a generated copy (it carries one of our markers) whose source no longer exists. Anything
// without a marker is never touched.
const wantedSkills = new Set(plan.flatMap(({ plugin, skills }) => skills.map((s) => plugin.prefix + s)));
const wantedAgents = new Set(plan.flatMap(({ plugin, agents }) => agents.map((a) => plugin.prefix + a)));

for (const name of dirs(join(CLAUDE, "skills"))) {
  if (wantedSkills.has(name)) continue;
  const dir = join(CLAUDE, "skills", name);
  if (!ownerOf(join(dir, "SKILL.md"))) continue;
  if (check) { stale++; console.log(`stale copy (source is gone): ${dir}`); continue; }
  rmSync(dir, { recursive: true });
  console.log(`pruned skill ${name}`);
}
for (const file of mdFiles(join(CLAUDE, "agents"))) {
  if (wantedAgents.has(file)) continue;
  const path = join(CLAUDE, "agents", file);
  if (!ownerOf(path)) continue;
  if (check) { stale++; console.log(`stale copy (source is gone): ${path}`); continue; }
  rmSync(path);
  console.log(`pruned agent ${file.replace(/\.md$/, "")}`);
}
// Hook scripts we generated whose source is gone. A file without the marker is never touched.
if (!remove) {
  for (const { plugin, hookFiles } of plan) {
    if (!plugin.hooks) continue;
    const wanted = new Set(hookFiles);
    for (const rel of mjsFiles(plugin.hooks.dest)) {
      const path = join(plugin.hooks.dest, rel);
      if (wanted.has(rel) || !isOurHook(plugin, path)) continue;
      if (check) { stale++; console.log(`stale copy (source is gone): ${path}`); continue; }
      rmSync(path);
      console.log(`pruned hook ${rel}`);
    }
  }
}

if (check) {
  console.log(stale ? `${stale} file(s) out of date. Run: node scripts/sync-personal.mjs` : "Personal copies are up to date.");
  process.exit(stale ? 1 : 0);
}
if (!remove) console.log("Done. Restart Claude Code (or start a new session) to load them.");
