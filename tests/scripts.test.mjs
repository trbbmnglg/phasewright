// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
