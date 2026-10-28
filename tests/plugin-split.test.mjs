// Run with: node --test tests/plugin-split.test.mjs
// Phase 3: free-resources as its own plugin. Covers the manifest support rule, the generalised
// personal sync (always against a temp home, never the real ~/.claude) and the folder warning.
// The guard part of the personal sync is in plugin-split-guard.test.mjs.
// This file is one of 2 (plugin-split.test.mjs, plugin-split-guard.test.mjs) that came from one file; the helpers they share are in tests/helpers/plugin-split.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { HERE, REPO, tmp, sync, marker, put, read } from "./helpers/plugin-split.mjs";

const FR = join(REPO, "plugins", "free-resources", "skills", "free-resources");
const FIX = join(HERE, "fixtures");

// ---------- manifest: support level per plugin ----------

const META = 'metadata:\n  title: "T"\n  tags: "a,b"\n  featured: "false"\n  order: "1"\n  version: "1.0.0"';
const skillMd = (name, extra = "") => `---\nname: ${name}\ndescription: Does a thing. Use when asked.\nlicense: MIT\n${extra}${META}\n---\n\n# Skill\n`;
const agentMd = (name) => `---\nname: ${name}\ndescription: "An agent."\nmodel: sonnet\n${META}\n---\n\nBody\n`;
const manifestJson = (slug) => JSON.stringify({ name: slug, description: "A plugin for tests.", version: "0.1.0" });
function libraryFixture() {
  const root = tmp("plugin-split-lib");
  const files = {
    "skills/base/SKILL.md": skillMd("base"),
    "agents/claude/helper.md": agentMd("helper"),
    "plugins/plain/.claude-plugin/plugin.json": manifestJson("plain"),
    "plugins/plain/skills/one/SKILL.md": skillMd("one"),
    "plugins/pinned/.claude-plugin/plugin.json": manifestJson("pinned"),
    "plugins/pinned/skills/one/SKILL.md": skillMd("one", "model: opus\n"),
    "plugins/crew/.claude-plugin/plugin.json": manifestJson("crew"),
    "plugins/crew/skills/one/SKILL.md": skillMd("one"),
    "plugins/crew/agents/worker.md": agentMd("worker"),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
test("manifest: a plugin with no agents and no model pins is full for Copilot and Cursor; others stay partial", () => {
  const root = libraryFixture();
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "build-manifest.mjs")], { encoding: "utf8", env: { ...process.env, LIBRARY_ROOT: root } });
  assert.equal(r.status, 0, r.stderr);
  const items = JSON.parse(readFileSync(join(root, "library.json"), "utf8")).items;
  const tools = (slug) => items.find((i) => i.type === "plugin" && i.slug === slug).tools;
  for (const tool of ["copilot", "cursor"]) {
    assert.equal(tools("plain")[tool].support, "full", `plain ${tool}`);
    assert.equal(tools("plain")[tool].note, undefined);
    assert.equal(tools("pinned")[tool].support, "partial", `pinned ${tool}`);
    assert.match(tools("pinned")[tool].note, /model pinning and agents are Claude Code features/);
    assert.equal(tools("crew")[tool].support, "partial", `crew ${tool}`);
  }
  assert.equal(tools("plain")["claude-code"].support, "full");
  rmSync(root, { recursive: true });
});
test("library.json: free-resources is its own plugin, phased-shipping stays partial and no longer lists it", () => {
  const items = JSON.parse(readFileSync(join(REPO, "library.json"), "utf8")).items;
  const fr = items.find((i) => i.type === "plugin" && i.slug === "free-resources");
  assert.ok(fr, "plugin free-resources is in library.json");
  assert.equal(fr.tools.copilot.support, "full");
  assert.equal(fr.tools.cursor.support, "full");
  assert.ok(fr.files.includes("plugins/free-resources/skills/free-resources/SKILL.md"));
  assert.ok(fr.files.includes("plugins/free-resources/README.md"));
  const ps = items.find((i) => i.type === "plugin" && i.slug === "phased-shipping");
  assert.equal(ps.tools.copilot.support, "partial");
  assert.equal(ps.tools.cursor.support, "partial");
  assert.ok(ps.files.length > 0 && !ps.files.some((f) => f.includes("free-resources")));
});
test("no *.local.* file is tracked by git or listed in library.json", () => {
  const tracked = spawnSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" });
  if (tracked.status === 0) assert.deepEqual(tracked.stdout.split(/\r?\n/).filter((f) => /\.local\./.test(f)), []);
  assert.ok(!JSON.parse(readFileSync(join(REPO, "library.json"), "utf8")).items.some((i) => i.files.some((f) => /\.local\./.test(f))));
});
test("the marketplace files list free-resources", () => {
  for (const file of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    const entry = JSON.parse(readFileSync(join(REPO, file), "utf8")).plugins.find((p) => p.name === "free-resources");
    assert.ok(entry, `${file} has a free-resources entry`);
    assert.equal(entry.source, "./plugins/free-resources");
  }
});
test("both marketplace files list phased-shipping, and the Cursor entry says what is Claude Code only", () => {
  for (const file of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    const entry = JSON.parse(readFileSync(join(REPO, file), "utf8")).plugins.find((p) => p.name === "phased-shipping");
    assert.ok(entry, `${file} has a phased-shipping entry`);
    assert.equal(entry.source, "./plugins/phased-shipping");
    if (file.startsWith(".cursor")) assert.match(entry.description, /Claude Code/);
  }
});
test("sync: installs free-resources with no prefix and its own marker, and keeps phased-shipping's ps- names", () => {
  const home = tmp("sync-home");
  const r = sync(home);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const fr = read(home, "skills/free-resources/SKILL.md");
  assert.ok(fr.includes(marker("free-resources")));
  assert.ok(!fr.includes(marker("phased-shipping")));
  assert.match(fr, /^name: free-resources$/m);
  assert.ok(existsSync(join(home, "skills/free-resources/scripts/processes.mjs")));
  assert.ok(existsSync(join(home, "skills/free-resources/scripts/lib/skilldir.mjs")));
  assert.match(read(home, "skills/ps-plan/SKILL.md"), /^name: ps-plan$/m);
  assert.ok(read(home, "skills/ps-plan/SKILL.md").includes(marker("phased-shipping")));
  assert.ok(existsSync(join(home, "skills/ps-run/SKILL.md")));
  assert.ok(existsSync(join(home, "agents/ps-builder.md")));
  assert.ok(!existsSync(join(home, "skills/ps-free-resources")));
  assert.ok(!existsSync(join(home, "free-resources")), "free-resources has no data folder of its own here");
  rmSync(home, { recursive: true });
});
test("sync: phased-shipping's history folder still points at <home>/phased-shipping", () => {
  const home = tmp("sync-home");
  assert.equal(sync(home).status, 0);
  const plan = read(home, "skills/ps-plan/SKILL.md");
  assert.ok(!plan.includes("${CLAUDE_PLUGIN_DATA}"));
  assert.ok(plan.includes(join(home, "phased-shipping").split("\\").join("/")));
  rmSync(home, { recursive: true });
});
test("sync: a marked ps-free-resources copy is pruned; unmarked and foreign-marked folders are left alone", () => {
  const home = tmp("sync-home");
  put(home, "skills/ps-free-resources/SKILL.md", `---\nname: ps-free-resources\n---\n\n${marker("phased-shipping")}\n\nold copy\n`);
  put(home, "skills/ps-free-resources/scripts/old.mjs", "// old");
  put(home, "skills/mine/SKILL.md", "---\nname: mine\n---\n\nmy own skill\n");
  put(home, "skills/foreign/SKILL.md", `---\nname: foreign\n---\n\n${marker("some-other-plugin")}\n\nnot ours\n`);
  put(home, "agents/mine.md", "my own agent\n");
  put(home, "agents/ps-gone.md", `---\nname: ps-gone\n---\n\n${marker("phased-shipping")}\n\nsource removed\n`);
  const r = sync(home);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!existsSync(join(home, "skills/ps-free-resources")), "marked copy pruned");
  assert.ok(!existsSync(join(home, "agents/ps-gone.md")), "marked agent with no source pruned");
  assert.match(r.stdout, /pruned skill ps-free-resources/);
  assert.equal(read(home, "skills/mine/SKILL.md"), "---\nname: mine\n---\n\nmy own skill\n");
  assert.ok(existsSync(join(home, "skills/foreign/SKILL.md")));
  assert.equal(read(home, "agents/mine.md"), "my own agent\n");
  assert.ok(existsSync(join(home, "skills/free-resources/SKILL.md")), "the new copy is still written");
  rmSync(home, { recursive: true });
});
test("sync: an unmarked skills/free-resources is refused, not overwritten, and nothing else is written", () => {
  const home = tmp("sync-home");
  put(home, "skills/free-resources/SKILL.md", "---\nname: free-resources\n---\n\nmy own version\n");
  const r = sync(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to overwrite .*free-resources/);
  assert.equal(read(home, "skills/free-resources/SKILL.md"), "---\nname: free-resources\n---\n\nmy own version\n");
  assert.ok(!existsSync(join(home, "skills/ps-plan")), "the guard runs before anything is written");
  rmSync(home, { recursive: true });
});
test("sync: a skill carrying another plugin's marker is also refused", () => {
  const home = tmp("sync-home");
  put(home, "skills/free-resources/SKILL.md", `---\nname: free-resources\n---\n\n${marker("phased-shipping")}\n`);
  const r = sync(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to overwrite/);
  rmSync(home, { recursive: true });
});
test("sync --check: exits 1 when missing or stale and 0 after an install; it writes nothing", () => {
  const home = tmp("sync-home");
  const empty = sync(home, "--check");
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /out of date/);
  assert.ok(!existsSync(join(home, "skills")), "--check writes nothing");
  assert.equal(sync(home).status, 0);
  const ok = sync(home, "--check");
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /up to date/);
  put(home, "skills/ps-free-resources/SKILL.md", `---\nname: ps-free-resources\n---\n\n${marker("phased-shipping")}\n`);
  const stale = sync(home, "--check");
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /stale copy \(source is gone\)/);
  assert.ok(existsSync(join(home, "skills/ps-free-resources/SKILL.md")), "--check does not prune");
  writeFileSync(join(home, "skills/free-resources/SKILL.md"), "changed");
  assert.equal(sync(home, "--check").status, 1);
  rmSync(home, { recursive: true });
});
test("sync --remove: removes only generated copies", () => {
  const home = tmp("sync-home");
  assert.equal(sync(home).status, 0);
  put(home, "skills/mine/SKILL.md", "---\nname: mine\n---\n\nmy own skill\n");
  const r = sync(home, "--remove");
  assert.equal(r.status, 0, r.stderr);
  for (const gone of ["skills/free-resources", "skills/ps-plan", "skills/ps-run", "agents/ps-builder.md"]) assert.ok(!existsSync(join(home, gone)), gone);
  assert.ok(existsSync(join(home, "skills/mine/SKILL.md")));
  rmSync(home, { recursive: true });
});

// ---------- folder warning ----------

const skilldir = await import(pathToFileURL(join(FR, "scripts", "lib", "skilldir.mjs")).href);
const WARN = /inside this skill's own folder/;
test("insideSkillDir: the skill folder and its subfolders count; a sibling with the same prefix and the parent do not", () => {
  const dir = join(tmp("skilldir"), "free-resources");
  assert.equal(skilldir.insideSkillDir(dir, dir), true);
  assert.equal(skilldir.insideSkillDir(join(dir, "scripts", "lib"), dir), true);
  assert.equal(skilldir.insideSkillDir(`${dir}-other`, dir), false);
  assert.equal(skilldir.insideSkillDir(dirname(dir), dir), false);
  assert.equal(skilldir.insideSkillDir(REPO, FR), false);
  assert.equal(skilldir.insideSkillDir(join(FR, "scripts"), FR), true);
});
test("folder warning: each CLI warns on stderr when run from inside the skill folder, and not from elsewhere", () => {
  const data = tmp("fr-data");
  const env = { ...process.env, FREE_RESOURCES_DATA: data };
  const cli = (script, args, cwd) => spawnSync(process.execPath, [join(FR, "scripts", script), ...args], { encoding: "utf8", env, cwd });
  const scanArgs = ["--fixture", join(FIX, "scan-win.json"), "--json"];

  const inside = cli("processes.mjs", scanArgs, FR);
  assert.equal(inside.status, 0, inside.stderr);
  assert.match(inside.stderr, WARN);
  assert.equal((inside.stderr.match(WARN) ?? []).length, 1, "one warning only");
  JSON.parse(inside.stdout); // the warning stays off stdout
  assert.doesNotMatch(inside.stdout, WARN);

  const nested = cli("processes.mjs", scanArgs, join(FR, "scripts", "lib"));
  assert.match(nested.stderr, WARN);

  const outside = cli("processes.mjs", scanArgs, REPO);
  assert.equal(outside.status, 0, outside.stderr);
  assert.doesNotMatch(outside.stderr, WARN);

  const headroomArgs = ["--task", "no-such-task", "--fixture", join(FIX, "scan-win.json")];
  assert.match(cli("headroom.mjs", headroomArgs, FR).stderr, WARN);
  assert.doesNotMatch(cli("headroom.mjs", headroomArgs, REPO).stderr, WARN);

  // measure with no command exits 2 before starting anything, which is enough to see the warning.
  const m = cli("measure.mjs", [], FR);
  assert.equal(m.status, 2);
  assert.match(m.stderr, WARN);
  assert.doesNotMatch(cli("measure.mjs", [], REPO).stderr, WARN);
  rmSync(data, { recursive: true });
});
test("SKILL.md calls every script by full path, not from the skill folder", () => {
  const text = readFileSync(join(FR, "SKILL.md"), "utf8");
  assert.ok(!/^node scripts\//m.test(text), "no bare relative call");
  for (const script of ["processes", "measure", "headroom"]) assert.ok(text.includes(`node "\${CLAUDE_SKILL_DIR}/scripts/${script}.mjs"`), script);
  assert.ok(!/From this skill's folder/.test(text));
});
