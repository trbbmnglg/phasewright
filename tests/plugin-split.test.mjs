// Run with: node --test tests/plugin-split.test.mjs
// Phase 3: free-resources as its own plugin. Covers the manifest support rule, the generalised
// personal sync (always against a temp home, never the real ~/.claude) and the folder warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const FR = join(REPO, "plugins", "free-resources", "skills", "free-resources");
const FIX = join(HERE, "fixtures");
// Each test removes what it made; the after hook removes whatever a failing or careless test leaves behind.
const scratch = [];
const tmp = (label) => { const d = mkdtempSync(join(tmpdir(), `${label}-`)); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

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

// ---------- personal sync, against a temp home ----------

const SYNC = join(REPO, "scripts", "sync-personal.mjs");
const sync = (home, ...args) => spawnSync(process.execPath, [SYNC, ...args], { encoding: "utf8", env: { ...process.env, SYNC_PERSONAL_CLAUDE_HOME: home } });
const marker = (name) => `<!-- Generated from the ${name} plugin by scripts/sync-personal.mjs. Edit the plugin, then re-run the script. -->`;
const put = (home, rel, text) => {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const read = (home, rel) => readFileSync(join(home, rel), "utf8");

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

// ---------- phased-shipping guard hook in the personal copies ----------

const PS = join(REPO, "plugins", "phased-shipping");
const jsMarker = "// Generated from the phased-shipping plugin by scripts/sync-personal.mjs. Edit the plugin, then re-run the script.";
const fwd = (p) => p.split("\\").join("/");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GUARD_FILES = ["guard.mjs", "guard-rules.mjs", "lib/shell.mjs"];
const ROLE_MATCHERS = {
  builder: "Bash|PowerShell|Write|Edit|NotebookEdit",
  checker: "Bash|PowerShell|Write|Edit|NotebookEdit",
  shipper: "Bash|PowerShell|Write|Edit|NotebookEdit",
  "model-scout": "Write|Edit|NotebookEdit",
};

test("guard: plugin agent sources have no hooks field; only the generated copies get the block", () => {
  for (const role of Object.keys(ROLE_MATCHERS)) {
    const source = readFileSync(join(PS, "agents", `${role}.md`), "utf8");
    assert.doesNotMatch(source, /^hooks:/m, `${role} source`);
  }
});

test("guard: every ps-* agent copy gets the hooks block with the right matcher and --agent, and keeps the rest", () => {
  const home = tmp("sync-home");
  const r = sync(home);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const [role, matcher] of Object.entries(ROLE_MATCHERS)) {
    const copy = read(home, `agents/ps-${role}.md`);
    const fm = copy.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)[1];
    const block = [
      "hooks:",
      "  PreToolUse:",
      `    - matcher: "${matcher}"`,
      "      hooks:",
      "        - type: command",
      `          command: node "${fwd(join(home, "phased-shipping", "hooks"))}/guard.mjs" --agent ${role}`,
      "          onFailure: block",
    ].join("\n");
    assert.ok(fm.endsWith(block), `${role}: the block is the last thing in the frontmatter\n${fm}`);
    assert.match(fm, new RegExp(`^name: ps-${role}$`, "m"));
    assert.equal((copy.match(/guard\.mjs" --agent /g) ?? []).length, 1, `${role}: one guard command`);
    // The rest of the file is what it always was: marker after the fence, body intact.
    const source = readFileSync(join(PS, "agents", `${role}.md`), "utf8");
    assert.ok(copy.includes(source.split(/\r?\n---\r?\n/)[1]), `${role}: body unchanged`);
    assert.match(copy, new RegExp(`--agent ${role}\\n          onFailure: block\\n---\\n\\n${esc(marker("phased-shipping"))}\\n`));
  }
  assert.doesNotMatch(read(home, "skills/ps-run/SKILL.md"), /guard\.mjs" --agent/);
  rmSync(home, { recursive: true });
});

test("guard: the hook scripts land in <home>/phased-shipping/hooks, each starting with the marker, and hooks.json stays behind", () => {
  const home = tmp("sync-home");
  assert.equal(sync(home).status, 0);
  for (const rel of GUARD_FILES) {
    const copy = read(home, `phased-shipping/hooks/${rel}`);
    assert.equal(copy.split("\n")[0], jsMarker, rel);
    assert.equal(copy, `${jsMarker}\n${readFileSync(join(PS, "hooks", rel), "utf8")}`, rel);
  }
  assert.ok(!existsSync(join(home, "phased-shipping/hooks/hooks.json")), "hooks.json uses CLAUDE_PLUGIN_ROOT, so it isn't copied");
  rmSync(home, { recursive: true });
});

test("guard: the installed copy works when fed a payload directly", () => {
  const home = tmp("sync-home");
  assert.equal(sync(home).status, 0);
  const run = (payload) => spawnSync(process.execPath, [join(home, "phased-shipping/hooks/guard.mjs"), "--agent", "builder"], { input: JSON.stringify(payload), encoding: "utf8" });
  const denied = run({ tool_name: "Bash", tool_input: { command: "git push" } });
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /^git-push: /);
  assert.equal(run({ tool_name: "Bash", tool_input: { command: "git status" } }).stdout, "");
  rmSync(home, { recursive: true });
});

test("guard: --check reports a changed, missing or stale guard file and a changed agent block", () => {
  const home = tmp("sync-home");
  assert.equal(sync(home).status, 0);
  const ok = sync(home, "--check");
  assert.equal(ok.status, 0, ok.stdout);
  writeFileSync(join(home, "phased-shipping/hooks/guard-rules.mjs"), `${read(home, "phased-shipping/hooks/guard-rules.mjs")}\n// edited`);
  const changed = sync(home, "--check");
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /out of date: .*guard-rules\.mjs/);
  assert.equal(sync(home).status, 0, "a sync repairs it");
  assert.equal(sync(home, "--check").status, 0);
  rmSync(join(home, "phased-shipping/hooks/lib/shell.mjs"));
  assert.match(sync(home, "--check").stdout, /out of date: .*shell\.mjs/);
  assert.equal(sync(home).status, 0);
  writeFileSync(join(home, "agents/ps-builder.md"), read(home, "agents/ps-builder.md").replace(/hooks:[\s\S]*?(?=\n---\n)/, ""));
  const agent = sync(home, "--check");
  assert.equal(agent.status, 1);
  assert.match(agent.stdout, /out of date: .*ps-builder\.md/);
  assert.equal(sync(home).status, 0);
  put(home, "phased-shipping/hooks/old.mjs", `${jsMarker}\n// source is gone\n`);
  const stale = sync(home, "--check");
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /stale copy \(source is gone\): .*old\.mjs/);
  assert.ok(existsSync(join(home, "phased-shipping/hooks/old.mjs")), "--check does not prune");
  assert.match(sync(home).stdout, /pruned hook old\.mjs/);
  assert.ok(!existsSync(join(home, "phased-shipping/hooks/old.mjs")));
  rmSync(home, { recursive: true });
});

test("guard: --remove deletes only marked hook files and leaves other files and the history alone", () => {
  const home = tmp("sync-home");
  assert.equal(sync(home).status, 0);
  put(home, "phased-shipping/history.jsonl", '{"project":"zork"}\n');
  put(home, "phased-shipping/hooks/mine.mjs", "// my own script\n");
  const r = sync(home, "--remove");
  assert.equal(r.status, 0, r.stderr);
  for (const rel of GUARD_FILES) assert.ok(!existsSync(join(home, "phased-shipping/hooks", rel)), rel);
  assert.ok(!existsSync(join(home, "phased-shipping/hooks/lib")), "the emptied lib folder is gone");
  assert.equal(read(home, "phased-shipping/hooks/mine.mjs"), "// my own script\n");
  assert.equal(read(home, "phased-shipping/history.jsonl"), '{"project":"zork"}\n');
  assert.ok(!existsSync(join(home, "agents/ps-builder.md")));
  rmSync(home, { recursive: true });

  const clean = tmp("sync-home");
  assert.equal(sync(clean).status, 0);
  assert.equal(sync(clean, "--remove").status, 0);
  assert.ok(!existsSync(join(clean, "phased-shipping/hooks")), "with nothing else in it, the hooks folder is removed too");
  rmSync(clean, { recursive: true });
});

test("guard: an unmarked file where a hook script would go is refused, and nothing is written", () => {
  const home = tmp("sync-home");
  put(home, "phased-shipping/hooks/guard.mjs", "// my own guard\n");
  const r = sync(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to overwrite .*guard\.mjs/);
  assert.equal(read(home, "phased-shipping/hooks/guard.mjs"), "// my own guard\n");
  assert.ok(!existsSync(join(home, "agents/ps-builder.md")), "the refusal comes before any write");
  assert.ok(!existsSync(join(home, "skills")));
  // --remove leaves the unmarked file alone as well.
  assert.equal(sync(home, "--remove").status, 0);
  assert.equal(read(home, "phased-shipping/hooks/guard.mjs"), "// my own guard\n");
  rmSync(home, { recursive: true });
});

test("guard: a hook file carrying another plugin's marker is also refused", () => {
  const home = tmp("sync-home");
  put(home, "phased-shipping/hooks/guard.mjs", "// Generated from the some-other-plugin plugin by scripts/sync-personal.mjs. Edit the plugin, then re-run the script.\n");
  assert.equal(sync(home).status, 1);
  rmSync(home, { recursive: true });
});

test("guard: a home path with spaces still gives a valid command line", () => {
  const home = join(tmp("sync-home"), "my claude home");
  mkdirSync(home);
  assert.equal(sync(home).status, 0);
  const copy = read(home, "agents/ps-shipper.md");
  assert.ok(copy.includes(`command: node "${fwd(join(home, "phased-shipping", "hooks"))}/guard.mjs" --agent shipper`));
  rmSync(dirname(home), { recursive: true });
});

test("guard: the personal agent copies block the call when the hook can't run (onFailure: block)", () => {
  const home = tmp("sync-home");
  assert.equal(sync(home).status, 0);
  for (const role of Object.keys(ROLE_MATCHERS)) {
    const fm = read(home, `agents/ps-${role}.md`).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)[1];
    assert.match(fm, /^ {10}command: node .*guard\.mjs" --agent /m, role);
    assert.match(fm, /^ {10}onFailure: block$/m, role);
    assert.equal((fm.match(/onFailure/g) ?? []).length, 1, role);
  }
  // The plugin's own agent sources and hooks.json never carry it: a missing node would block the main session there.
  assert.doesNotMatch(readFileSync(join(PS, "hooks", "hooks.json"), "utf8"), /onFailure/);
  for (const role of Object.keys(ROLE_MATCHERS)) assert.doesNotMatch(readFileSync(join(PS, "agents", `${role}.md`), "utf8"), /onFailure/);
  rmSync(home, { recursive: true });
});

test("guard: a Claude home path with a dollar sign, a backtick or a double quote is refused before anything is written", () => {
  const base = tmp("sync-base");
  for (const name of ["a$b", "a`b", 'a"b', "$HOME"]) {
    const home = join(base, name);
    const r = sync(home);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /Refusing to install: the Claude home path .* contains a \$, a backtick or a double quote/, name);
    assert.ok(!existsSync(home), `nothing was written for ${name}`);
    assert.equal(sync(home, "--check").status, 1, "--check refuses too");
  }
  // --remove has nothing to quote, so it still runs.
  assert.equal(sync(join(base, "a$b"), "--remove").status, 0);
  rmSync(base, { recursive: true });
});

test("guard: an agent copy that comes out without the hooks block stops the sync and names the file, with nothing written", () => {
  const root = tmp("sync-broken");
  mkdirSync(join(root, "scripts"));
  cpSync(join(REPO, "scripts", "sync-personal.mjs"), join(root, "scripts", "sync-personal.mjs"));
  cpSync(join(REPO, "plugins", "phased-shipping"), join(root, "plugins", "phased-shipping"), { recursive: true });
  cpSync(join(REPO, "plugins", "free-resources"), join(root, "plugins", "free-resources"), { recursive: true });
  // No closing frontmatter fence: the block has nowhere to go.
  const agent = join(root, "plugins", "phased-shipping", "agents", "shipper.md");
  writeFileSync(agent, readFileSync(agent, "utf8").replace(/\r?\n---\r?\n/, "\n"));
  const home = join(root, "home");
  const r = spawnSync(process.execPath, [join(root, "scripts", "sync-personal.mjs")], { encoding: "utf8", env: { ...process.env, SYNC_PERSONAL_CLAUDE_HOME: home } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /guard hooks block is missing from the generated copy of shipper\.md/);
  assert.ok(!existsSync(home), "the check comes before any write");
  rmSync(root, { recursive: true });
});

test("guard: only a file that STARTS with the hook marker counts as ours; a marker further down is refused", () => {
  const home = tmp("sync-home");
  put(home, "phased-shipping/hooks/guard.mjs", `// my own script\n${jsMarker}\n`);
  const r = sync(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to overwrite .*guard\.mjs/);
  assert.equal(read(home, "phased-shipping/hooks/guard.mjs"), `// my own script\n${jsMarker}\n`);
  assert.equal(sync(home, "--remove").status, 0);
  assert.ok(existsSync(join(home, "phased-shipping/hooks/guard.mjs")), "--remove leaves it alone");
  rmSync(home, { recursive: true });
});

test("guard: pruning does not follow a link out of the hooks folder", () => {
  const home = tmp("sync-home");
  const outside = tmp("sync-outside");
  assert.equal(sync(home).status, 0);
  put(outside, "x.mjs", `${jsMarker}\n// a marked file in another folder\n`);
  try { symlinkSync(outside, join(home, "phased-shipping/hooks/link"), "junction"); } catch { rmSync(home, { recursive: true }); rmSync(outside, { recursive: true }); return; }
  const r = sync(home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(outside, "x.mjs")), "the file behind the link is not pruned");
  assert.doesNotMatch(r.stdout, /pruned hook link/);
  assert.equal(sync(home, "--check").status, 0, "and --check does not see it as stale");
  rmSync(join(home, "phased-shipping/hooks/link"));
  rmSync(home, { recursive: true });
  rmSync(outside, { recursive: true });
});
