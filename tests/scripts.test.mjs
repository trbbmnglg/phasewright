// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, root, args = [], env = {}) =>
  spawnSync(process.execPath, [join(REPO, "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, LIBRARY_ROOT: root, LIBRARY_DENYLIST: join(root, "no-denylist.txt"), ...env },
  });

const META = 'metadata:\n  title: "T"\n  tags: "a,b"\n  featured: "false"\n  order: "1"\n  version: "1.0.0"';
const skill = (name, extra = "", desc = "Does a thing. Use when asked.") =>
  `---\nname: ${name}\ndescription: ${desc}\nlicense: MIT\n${META}\n---\n\n# Skill\n${extra}\n`;
const agent = (name, model = "sonnet") =>
  `---\nname: ${name}\ndescription: "An agent."\nmodel: ${model}\n${META}\n---\n\nBody\n`;

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "phasewright-"));
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "agents", "claude"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const good = () => fixture({
  "skills/good-skill/SKILL.md": skill("good-skill"),
  "agents/claude/helper.md": agent("helper"),
});

test("the real repo passes lint and its manifest is current", () => {
  const lint = spawnSync(process.execPath, [join(REPO, "scripts", "lint.mjs")], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout);
  const manifest = spawnSync(process.execPath, [join(REPO, "scripts", "build-manifest.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(manifest.status, 0, manifest.stdout);
});

test("a clean fixture passes", () => {
  const root = good();
  const r = run("lint.mjs", root);
  assert.equal(r.status, 0, r.stdout);
  rmSync(root, { recursive: true });
});

test("bad names, long descriptions, emails and tokens each fail with a clear message", () => {
  const root = fixture({
    "skills/Bad_Skill/SKILL.md": skill("other-name", "contact me at someone" + "@company.com and ghp_" + "a".repeat(36), "x".repeat(1100)),
    "agents/claude/helper.md": agent("helper", "claude-opus-5-5"),
  });
  const out = run("lint.mjs", root).stdout;
  assert.match(out, /must match the folder/);
  assert.match(out, /lowercase letters, digits and single hyphens/);
  assert.match(out, /description is 1100 characters/);
  assert.match(out, /email address found/);
  assert.match(out, /API key or token found/);
  assert.match(out, /must be an alias/);
  assert.equal(run("lint.mjs", root).status, 1);
  rmSync(root, { recursive: true });
});

test("an unquoted colon in frontmatter fails (real YAML would drop every field)", () => {
  const root = fixture({
    "skills/colon/SKILL.md": skill("colon", "", "Use this skill. TRIGGER on: any request"),
    "agents/claude/helper.md": agent("helper"),
  });
  const r = run("lint.mjs", root);
  assert.match(r.stdout, /unquoted ": "/);
  assert.equal(r.status, 1);
  rmSync(root, { recursive: true });
});

test("a quoted description with escaped quotes passes and round-trips", () => {
  const root = fixture({
    "skills/quoted/SKILL.md": skill("quoted", "", '"Say \\"go\\" and it: works."'),
    "agents/claude/helper.md": agent("helper"),
  });
  assert.equal(run("lint.mjs", root).status, 0);
  assert.equal(run("build-manifest.mjs", root).status, 0);
  const items = JSON.parse(readFileSync(join(root, "library.json"), "utf8")).items;
  assert.equal(items.find((i) => i.slug === "quoted").description, 'Say "go" and it: works.');
  rmSync(root, { recursive: true });
});

test("a broken relative link fails, but a link inside a code block does not", () => {
  const ok = fixture({
    "skills/s/SKILL.md": skill("s", "```\n[x](./nope.md)\n```"),
    "agents/claude/helper.md": agent("helper"),
  });
  assert.equal(run("lint.mjs", ok).status, 0);
  const bad = fixture({
    "skills/s/SKILL.md": skill("s", "See [guide](references/guide.md)."),
    "agents/claude/helper.md": agent("helper"),
  });
  assert.match(run("lint.mjs", bad).stdout, /broken link: references\/guide\.md/);
  rmSync(ok, { recursive: true });
  rmSync(bad, { recursive: true });
});

test("a term from the local denylist fails, including mixed case", () => {
  const root = fixture({
    "skills/s/SKILL.md": skill("s", "Built for AcmeCorp teams."),
    "agents/claude/helper.md": agent("helper"),
  });
  const list = join(root, "denylist.txt");
  writeFileSync(list, "acmecorp\n");
  const r = run("lint.mjs", root, [], { LIBRARY_DENYLIST: list });
  assert.match(r.stdout, /internal term from the local denylist found: "acmecorp"/);
  assert.equal(r.status, 1);
  rmSync(root, { recursive: true });
});

test("an agent file with a bad name fails the name rule", () => {
  const root = fixture({
    "skills/s/SKILL.md": skill("s"),
    "agents/claude/Bad_Agent.md": agent("Bad_Agent"),
  });
  const r = run("lint.mjs", root);
  assert.match(r.stdout, /agents\/claude\/Bad_Agent\.md: file name must be lowercase letters, digits and single hyphens/);
  assert.equal(r.status, 1);
  rmSync(root, { recursive: true });
});

test("an email with a multi-label domain is reported in full", () => {
  const email = "someone" + "@mail.company.co.uk";
  const root = fixture({
    "skills/s/SKILL.md": skill("s", `Write to ${email} please.`),
    "agents/claude/helper.md": agent("helper"),
  });
  const r = run("lint.mjs", root);
  assert.ok(r.stdout.includes(`email address found: "${email}"`), r.stdout);
  rmSync(root, { recursive: true });
});

test("denylist terms match whole words only", () => {
  // The list lives outside the fixture root so the scan doesn't read it.
  const list = (root) => {
    const f = root + "-denylist.txt";
    writeFileSync(f, "zork\n");
    return f;
  };
  const ok = fixture({
    "skills/s/SKILL.md": skill("s", "Run the zorkify step."),
    "agents/claude/helper.md": agent("helper"),
  });
  assert.equal(run("lint.mjs", ok, [], { LIBRARY_DENYLIST: list(ok) }).status, 0);
  const bad = fixture({
    "skills/s/SKILL.md": skill("s", "Ask the ZORK team."),
    "agents/claude/helper.md": agent("helper"),
  });
  const r = run("lint.mjs", bad, [], { LIBRARY_DENYLIST: list(bad) });
  assert.match(r.stdout, /internal term from the local denylist found: "zork"/);
  assert.equal(r.status, 1);
  rmSync(ok, { recursive: true });
  rmSync(bad, { recursive: true });
  rmSync(ok + "-denylist.txt");
  rmSync(bad + "-denylist.txt");
});

test("key patterns need a left word boundary: slugs like risk-deadlines pass, a standalone key fails", () => {
  const ok = fixture({
    "skills/s/SKILL.md": skill("s", `See risk-deadlines-and-other-key-changes and task-${"AKIA" + "A".repeat(16)} and my_${"ghp_" + "a".repeat(36)}.`),
    "agents/claude/helper.md": agent("helper"),
  });
  const okRun = run("lint.mjs", ok);
  assert.equal(okRun.status, 0, okRun.stdout);
  for (const key of ["sk-" + "a".repeat(20), "ghp_" + "a".repeat(36), "AKIA" + "A".repeat(16), "xoxb-" + "1".repeat(12)]) {
    const bad = fixture({
      "skills/s/SKILL.md": skill("s", `token=${key} here`),
      "agents/claude/helper.md": agent("helper"),
    });
    const r = run("lint.mjs", bad);
    assert.match(r.stdout, /API key or token found/, key);
    assert.equal(r.status, 1);
    rmSync(bad, { recursive: true });
  }
  rmSync(ok, { recursive: true });
});

// A fixture with one plugin. Plugin files carry no metadata block or license (root-only rule).
const PLUGIN_JSON = JSON.stringify({ name: "plug", version: "1.0.0", description: "A plugin." });
const pAgent = (extra = "", { model = "sonnet", desc = '"An agent."', name = "pa" } = {}) =>
  `---\nname: ${name}\ndescription: ${desc}\nmodel: ${model}\n${extra}---\n\nBody\n`;
const pSkill = (extra = "", name = "ps") => `---\nname: ${name}\ndescription: "Does a thing."\n${extra}---\n\n# Skill\n`;
const withPlugin = (files) => fixture({
  "skills/good-skill/SKILL.md": skill("good-skill"),
  "agents/claude/helper.md": agent("helper"),
  "plugins/plug/.claude-plugin/plugin.json": PLUGIN_JSON,
  ...files,
});
// Lints a fixture and removes it. Returns { out, status }.
function lintOf(root) {
  const r = run("lint.mjs", root);
  rmSync(root, { recursive: true, force: true });
  return { out: r.stdout, status: r.status };
}
const agentFile = (text) => lintOf(withPlugin({ "plugins/plug/agents/pa.md": text }));
const skillFile = (text, folder = "ps") => lintOf(withPlugin({ [`plugins/plug/skills/${folder}/SKILL.md`]: text }));

test("a clean plugin agent and skill pass, with no metadata block needed", () => {
  const r = lintOf(withPlugin({
    "plugins/plug/agents/pa.md": pAgent("effort: low\nmaxTurns: 20\ntools: Read, Grep\n", { model: "fable" }),
    "plugins/plug/skills/ps/SKILL.md": pSkill("model: best\neffort: high\n"),
  }));
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /warning\s+(plugins|skills|agents)\//);
});

test("an unquoted colon in a plugin agent description fails (audit mutation test)", () => {
  const r = agentFile(pAgent("", { desc: "Use this agent. TRIGGER on: any request" }));
  assert.match(r.out, /plugins\/plug\/agents\/pa\.md: frontmatter "description" has an unquoted ": "/);
  assert.equal(r.status, 1);
});

test("plugin agents: bad effort and maxTurns fail", () => {
  const e = agentFile(pAgent("effort: extreme\n"));
  assert.match(e.out, /effort "extreme" must be one of/);
  assert.equal(e.status, 1);
  const zero = agentFile(pAgent("maxTurns: 0\n"));
  assert.match(zero.out, /maxTurns "0" must be a positive whole number/);
  assert.equal(zero.status, 1);
  const word = agentFile(pAgent("maxTurns: ten\n"));
  assert.match(word.out, /maxTurns "ten" must be a positive whole number/);
  assert.equal(word.status, 1);
});

test("plugin agents: fields that plugins ignore fail", () => {
  const h = agentFile(pAgent("hooks:\n  PreToolUse: x\n"));
  assert.match(h.out, /"hooks" is ignored in plugin agents/);
  assert.equal(h.status, 1);
  const p = agentFile(pAgent("permissionMode: acceptEdits\n"));
  assert.match(p.out, /"permissionMode" is ignored in plugin agents/);
  assert.equal(p.status, 1);
  assert.match(agentFile(pAgent("mcpServers: x\n")).out, /"mcpServers" is ignored/);
  assert.match(agentFile(pAgent("initialPrompt: x\n")).out, /"initialPrompt" is ignored/);
});

test("an unknown frontmatter key warns but does not fail", () => {
  const r = agentFile(pAgent("colour: red\n"));
  assert.match(r.out, /warning\s+plugins\/plug\/agents\/pa\.md: unknown frontmatter field "colour"/);
  assert.equal(r.status, 0, r.out);
});

test("agent model: best warns, a full ID fails, fable passes", () => {
  const best = agentFile(pAgent("", { model: "best" }));
  assert.match(best.out, /warning\s+.*model "best" is not listed for subagent frontmatter/);
  assert.equal(best.status, 0, best.out);
  const id = agentFile(pAgent("", { model: "claude-opus-5-5" }));
  assert.match(id.out, /model "claude-opus-5-5" must be an alias/);
  assert.equal(id.status, 1);
  const fable = agentFile(pAgent("", { model: "fable" }));
  assert.equal(fable.status, 0, fable.out);
});

test("plugin agent names must match the file and have no colon", () => {
  const r = agentFile(pAgent("", { name: "other" }));
  assert.match(r.out, /name "other" must match the file name/);
  assert.equal(r.status, 1);
  assert.match(agentFile(pAgent("", { name: "ns:pa" })).out, /must not contain ":"/);
});

test("plugin skills: name must match the folder, allowed-tools warns, bad effort and model fail", () => {
  const name = skillFile(pSkill("", "other"));
  assert.match(name.out, /plugins\/plug\/skills\/ps: name "other" must match the folder "ps"/);
  assert.equal(name.status, 1);
  const tools = skillFile(pSkill("allowed-tools: Bash\n"));
  assert.match(tools.out, /warning\s+plugins\/plug\/skills\/ps: "allowed-tools" pre-approves/);
  assert.equal(tools.status, 0, tools.out);
  assert.equal(skillFile(pSkill("effort: huge\n")).status, 1);
  assert.match(skillFile(pSkill("model: claude-opus-5-5\n")).out, /model "claude-opus-5-5" must be an alias/);
});

test("plugin skills: missing description, broken link and a long body are caught", () => {
  const desc = skillFile("---\nname: ps\n---\n\n# S\n");
  assert.match(desc.out, /description is missing/);
  assert.equal(desc.status, 1);
  const link = skillFile(pSkill("") + "See [x](references/nope.md).\n");
  assert.match(link.out, /broken link: references\/nope\.md/);
  assert.equal(link.status, 1);
  const long = skillFile(pSkill("") + "line\n".repeat(520));
  assert.match(long.out, /warning\s+.*body is \d+ lines/);
  assert.equal(long.status, 0, long.out);
});

test("root items follow the same effort rules, and a root skill without metadata still fails", () => {
  const root = (extra, skillText) => lintOf(fixture({
    "skills/s/SKILL.md": skillText ?? skill("s"),
    "agents/claude/helper.md": agent("helper").replace("model: sonnet", `model: sonnet\n${extra}`),
  }));
  assert.equal(root("effort: high").status, 0);
  const huge = root("effort: huge");
  assert.match(huge.out, /effort "huge" must be one of/);
  assert.equal(huge.status, 1);
  const bare = root("", "---\nname: s\ndescription: x\nlicense: MIT\n---\n\nBody\n");
  assert.match(bare.out, /missing metadata block/);
  assert.equal(bare.status, 1);
});

test("the real repo lints with no errors, including the plugin files", () => {
  const lint = spawnSync(process.execPath, [join(REPO, "scripts", "lint.mjs")], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout);
  assert.doesNotMatch(lint.stdout, /^error/m);
});

const PS = join(REPO, "plugins", "phased-shipping");
const text = (...parts) => readFileSync(join(PS, ...parts), "utf8");

test("the plan skill's env regex catches the override variables and no key variables", () => {
  const m = text("skills", "plan", "SKILL.md").match(/env \| grep -E '([^']+)'/);
  assert.ok(m, "grep -E pattern not found in plan/SKILL.md");
  const re = new RegExp(m[1]);
  for (const v of ["CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1", "CLAUDE_CODE_SUBAGENT_MODEL=haiku", "CLAUDE_CODE_EFFORT_LEVEL=low", "ANTHROPIC_DEFAULT_OPUS_MODEL=x"]) {
    assert.ok(re.test(v), `should match ${v}`);
  }
  for (const v of ["ANTHROPIC_API_KEY=x", "ANTHROPIC_AUTH_TOKEN=x"]) assert.ok(!re.test(v), `should not match ${v}`);
});

test("run's override and version gates, the template line and both READMEs say what the plan promises", () => {
  const run = text("skills", "run", "SKILL.md");
  assert.match(run, /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
  assert.match(run, /CLAUDE_CODE_EFFORT_LEVEL/);
  assert.match(run, /proceed anyway/);
  assert.match(run, /2\.1\.292/);
  assert.match(run, /override: <variable>=<value>, proceed anyway <ISO>/);
  // The gate prints only the named variables and the version gate names the binary it checked.
  assert.match(run, /env \| grep -E '\^\(CLAUDE_CODE_SUBAGENT_MODEL\[A-Z_\]\*\|CLAUDE_CODE_EFFORT_LEVEL\)='/);
  assert.match(run, /name which binary you checked/);
  assert.match(text("skills", "plan", "references", "templates.md"), /^- Overrides: </m);
  assert.match(text("agents", "model-scout.md"), /`Overrides:` line/);
  assert.match(text("README.md"), /v2\.1\.292 or later/);
  assert.match(readFileSync(join(REPO, "README.md"), "utf8"), /v2\.1\.292 or later/);
});

const git = (root, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });

test("in a git repo only the published tree is scanned; outside git the full walk still applies", () => {
  const key = "sk-" + "a".repeat(24);
  const files = {
    "skills/s/SKILL.md": skill("s"),
    "agents/claude/helper.md": agent("helper"),
    ".gitignore": ".plans/\n",
    ".plans/notes.md": `key ${key}\n`,
  };
  // Git repo: the ignored folder is skipped.
  const repo = fixture(files);
  git(repo, "init", "-q");
  git(repo, "add", ".gitignore", "skills", "agents");
  const clean = run("lint.mjs", repo);
  assert.equal(clean.status, 0, clean.stdout);
  // A tracked file and an untracked, not-ignored file are both scanned.
  writeFileSync(join(repo, "untracked.md"), `key ${key}\n`);
  const untracked = run("lint.mjs", repo);
  assert.match(untracked.stdout, /untracked\.md: API key or token found/);
  rmSync(join(repo, "untracked.md"));
  writeFileSync(join(repo, "tracked.md"), `key ${key}\n`);
  git(repo, "add", "tracked.md");
  assert.match(run("lint.mjs", repo).stdout, /tracked\.md: API key or token found/);
  // Non-git folder: the old full walk applies, so the same ignored folder is scanned.
  const plain = fixture(files);
  const walk = run("lint.mjs", plain);
  assert.match(walk.stdout, /\.plans\/notes\.md: API key or token found/);
  assert.equal(walk.status, 1);
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true });
});

test("manifest --check fails after an edit until the manifest is rebuilt", () => {
  const root = good();
  assert.equal(run("build-manifest.mjs", root).status, 0);
  assert.equal(run("build-manifest.mjs", root, ["--check"]).status, 0);
  const file = join(root, "skills/good-skill/SKILL.md");
  writeFileSync(file, readFileSync(file, "utf8").replace('title: "T"', 'title: "Renamed"'));
  assert.equal(run("build-manifest.mjs", root, ["--check"]).status, 1);
  assert.equal(run("build-manifest.mjs", root).status, 0);
  assert.equal(run("build-manifest.mjs", root, ["--check"]).status, 0);
  rmSync(root, { recursive: true });
});

test("the manifest is deterministic and orders by type then order then slug", () => {
  const root = fixture({
    "skills/b-skill/SKILL.md": skill("b-skill").replace('order: "1"', 'order: "2"'),
    "skills/a-skill/SKILL.md": skill("a-skill").replace('order: "1"', 'order: "2"'),
    "skills/c-skill/SKILL.md": skill("c-skill"),
    "agents/claude/helper.md": agent("helper"),
  });
  run("build-manifest.mjs", root);
  const first = readFileSync(join(root, "library.json"), "utf8");
  run("build-manifest.mjs", root);
  assert.equal(readFileSync(join(root, "library.json"), "utf8"), first);
  const order = JSON.parse(first).items.map((i) => `${i.type}/${i.slug}`);
  assert.deepEqual(order, ["agent/helper", "skill/c-skill", "skill/a-skill", "skill/b-skill"]);
  rmSync(root, { recursive: true });
});

// ---------- plugin hooks/hooks.json ----------

const hooksJson = (command, event = "PreToolUse") => JSON.stringify({
  hooks: { [event]: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] }] },
});
const hooksFile = (text) => lintOf(withPlugin({ "plugins/plug/hooks/hooks.json": text }));
const GOOD_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs"';

test("hooks.json: a valid file passes, and so does one with no hooks folder at all", () => {
  const ok = hooksFile(hooksJson(GOOD_COMMAND));
  assert.equal(ok.status, 0, ok.out);
  assert.doesNotMatch(ok.out, /hooks\.json/);
  assert.equal(lintOf(withPlugin({})).status, 0);
  assert.equal(hooksFile(hooksJson("echo hello")).status, 0, "a command with no script path is fine");
});

test("hooks.json: a file that does not parse fails", () => {
  const r = hooksFile("{ not json");
  assert.match(r.out, /plugins\/plug\/hooks\/hooks\.json: hooks\.json does not parse/);
  assert.equal(r.status, 1);
});

test("hooks.json: the shape is checked", () => {
  const noHooks = hooksFile("{}");
  assert.match(noHooks.out, /needs a "hooks" object/);
  assert.equal(noHooks.status, 1);
  assert.match(hooksFile("[]").out, /must be a JSON object/);
  assert.match(hooksFile(JSON.stringify({ hooks: { PreToolUse: {} } })).out, /hooks\.PreToolUse must be an array/);
  assert.match(hooksFile(JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash" }] } })).out, /entries need a "hooks" array/);
  const empty = hooksFile(JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command" }] }] } }));
  assert.match(empty.out, /has no command/);
  assert.equal(empty.status, 1);
});

test("hooks.json: an unknown event fails", () => {
  const r = hooksFile(hooksJson(GOOD_COMMAND, "BeforeTool"));
  assert.match(r.out, /unknown hook event "BeforeTool"/);
  assert.equal(r.status, 1);
  for (const event of ["PreToolUse", "PostToolUse", "SessionStart", "SubagentStop", "Stop"]) {
    assert.equal(hooksFile(hooksJson(GOOD_COMMAND, event)).status, 0, event);
  }
});

// The 33 events of the lifecycle table in https://code.claude.com/docs/en/hooks (read 2026-10-25).
const OFFICIAL_HOOK_EVENTS = [
  "SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse", "PermissionRequest", "PermissionDenied", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification",
  "MessageDisplay", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "Stop", "StopFailure", "TeammateIdle", "InstructionsLoaded", "ConfigChange", "CwdChanged", "DirectoryAdded",
  "FileChanged", "WorktreeCreate", "WorktreeRemove", "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch", "Elicitation", "ElicitationResult", "SessionEnd",
];

test("hooks.json: every one of the 33 official events passes, and near misses fail", () => {
  assert.equal(OFFICIAL_HOOK_EVENTS.length, 33);
  assert.equal(new Set(OFFICIAL_HOOK_EVENTS).size, 33);
  for (const event of OFFICIAL_HOOK_EVENTS) assert.equal(hooksFile(hooksJson(GOOD_COMMAND, event)).status, 0, event);
  for (const event of ["pretooluse", "PreToolUsage", "BeforeTool", "SessionStop", "Compact", "ModelSwitch", "PostToolCall"]) {
    const r = hooksFile(hooksJson(GOOD_COMMAND, event));
    assert.equal(r.status, 1, event);
    assert.match(r.out, new RegExp(`unknown hook event "${event}"`));
  }
});

test("hooks.json: scripts must be reached through CLAUDE_PLUGIN_ROOT", () => {
  const bad = [
    'node "/opt/plug/hooks/guard.mjs"',
    "node /opt/plug/hooks/guard.mjs",
    "node C:/plug/hooks/guard.mjs",
    String.raw`node "C:\plug\hooks\guard.mjs"`,
    "node ~/plug/hooks/guard.mjs",
    "node ./hooks/guard.mjs",
    "node ../hooks/guard.mjs",
    "node hooks/guard.mjs",
    "bash guard.sh",
  ];
  for (const command of bad) {
    const r = hooksFile(hooksJson(command));
    assert.match(r.out, /error\s+plugins\/plug\/hooks\/hooks\.json: hook (command path|script) /, command);
    assert.equal(r.status, 1, command);
  }
});

test("the real phased-shipping hooks.json passes lint and is wired to the guard", () => {
  const file = join(REPO, "plugins", "phased-shipping", "hooks", "hooks.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.match(cfg.hooks.PreToolUse[0].hooks[0].command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/guard\.mjs"$/);
  const lint = spawnSync(process.execPath, [join(REPO, "scripts", "lint.mjs")], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout);
  assert.doesNotMatch(lint.stdout, /hooks\.json/);
});
