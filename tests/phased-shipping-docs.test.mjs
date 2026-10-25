// Run with: node --test tests/phased-shipping-docs.test.mjs
// Phase 5 (trust pass): checks that the phased-shipping skills, agents, README, changelog and evals
// say what the phase promised. These read the real plugin files; they don't run any model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PS = join(HERE, "..", "plugins", "phased-shipping");
const text = (...parts) => readFileSync(join(PS, ...parts), "utf8");
const frontmatter = (md) => md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";

test("run builds here only when the plan's model and effort both match this skill's", () => {
  const run = text("skills", "run", "SKILL.md");
  assert.match(run, /both its build model and its build effort match this skill's/);
  assert.match(run, /`sonnet \(high\), main` doesn't match/);
});

test("run handles proposed commands, partial results, close steps and tokens", () => {
  const run = text("skills", "run", "SKILL.md");
  assert.match(run, /`Proposed commands`/);
  assert.match(run, /only after the user's OK/i);
  assert.match(run, /marked partial/);
  assert.match(run, /never treat it as complete|never treats it as complete/);
  assert.match(run, /## Close steps/);
  assert.match(run, /didn't come from the plan skill in this session/);
  assert.match(run, /`tokens`/);
  for (const key of ["builder", "checker", "shipper", "model_scout"]) assert.match(run, new RegExp(`"${key}": N`));
  assert.match(run, /production personal data/);
});

test("the PHASES.md template has an optional Close steps section", () => {
  assert.match(text("skills", "plan", "references", "templates.md"), /^## Close steps$/m);
});

test("the checker has no file-editing tools, proposes commands and never runs them", () => {
  const checker = text("agents", "checker.md");
  const fm = frontmatter(checker);
  assert.match(fm, /has no file-editing tools/i);
  assert.doesNotMatch(fm, /^tools:.*\b(Edit|Write)\b/m);
  assert.match(checker, /`Proposed commands`/);
  assert.match(checker, /Never run a command you worked out yourself/);
  assert.doesNotMatch(checker, /run only typecheck, lint, tests and build/);
  assert.match(checker, /production personal data/);
});

test("the builder's output has no time-per-step line and carries the personal-data rule", () => {
  const builder = text("agents", "builder.md");
  assert.doesNotMatch(builder, /Time per step/i);
  assert.match(builder, /Don't estimate or report time/);
  assert.match(builder, /production personal data/);
});

test("all four agents carry the agreed maxTurns", () => {
  const expected = { builder: 200, checker: 25, shipper: 20, "model-scout": 15 };
  for (const [agent, turns] of Object.entries(expected)) {
    assert.match(frontmatter(text("agents", `${agent}.md`)), new RegExp(`^maxTurns: ${turns}$`, "m"), agent);
  }
});

test("the README lists what it touches and the four limits, and is at the new version", () => {
  const readme = text("README.md");
  assert.match(readme, /^## What it touches$/m);
  assert.match(readme, /^## Limits$/m);
  assert.match(readme, /v2\.1\.292 or later/);
  for (const [agent, turns] of [["builder", 200], ["checker", 25], ["shipper", 20], ["model-scout", 15]]) {
    assert.match(readme, new RegExp(`\\| \`${agent}\` \\|[^\\n]*\\| ${turns} \\|`), `${agent} ${turns}`);
  }
  assert.equal(JSON.parse(text(".claude-plugin", "plugin.json")).version, "0.4.0");
});

test("what the README says each agent can use matches the agent files", () => {
  const readme = text("README.md");
  for (const agent of ["builder", "checker", "shipper", "model-scout"]) {
    const tools = frontmatter(text("agents", `${agent}.md`)).match(/^tools: (.+)$/m)[1].trim();
    assert.ok(readme.includes(`| \`${agent}\` | ${tools} |`), `README tools for ${agent}: ${tools}`);
  }
});

test("the changelog has a 0.3.0 entry with Added, Changed and Fixed", () => {
  const log = text("CHANGELOG.md");
  const at = log.indexOf("## 0.3.0");
  assert.ok(at >= 0);
  for (const heading of ["### Added", "### Changed", "### Fixed"]) assert.ok(log.indexOf(heading, at) > at, heading);
});

test("each of the four safety evals has a prompt with max_turns and allowed_tools, and a typed grader", () => {
  for (const name of ["run-refuses-without-plan", "no-deploy-in-build-turn", "shipper-skips-unapproved", "untrusted-plan-needs-ok"]) {
    const dir = join(PS, "evals", name);
    assert.ok(existsSync(join(dir, "prompt.md")), `${name}/prompt.md`);
    const fm = frontmatter(readFileSync(join(dir, "prompt.md"), "utf8"));
    assert.match(fm, /^max_turns: \d+$/m, `${name} max_turns`);
    assert.match(fm, /^allowed_tools: \[.+\]$/m, `${name} allowed_tools`);
    const graders = readdirSync(join(dir, "graders")).filter((f) => f.endsWith(".md"));
    assert.ok(graders.length >= 1, `${name} has a grader`);
    const types = graders.map((f) => frontmatter(readFileSync(join(dir, "graders", f), "utf8")).match(/^type: (llm|tool_used)$/m)?.[1]);
    assert.ok(types.every(Boolean), `${name} graders all have a type`);
    assert.ok(types.includes("llm"), `${name} has an llm grader`);
    for (const f of graders) {
      const g = frontmatter(readFileSync(join(dir, "graders", f), "utf8"));
      if (/^type: tool_used$/m.test(g)) {
        assert.match(g, /^tool: \w+$/m, `${name}/${f} tool`);
        assert.match(g, /^input_match: .+$/m, `${name}/${f} input_match`);
        assert.match(g, /^max: 0$/m, `${name}/${f} max 0`);
      }
    }
  }
});

test("every eval folder, old and new, has a prompt and at least one grader", () => {
  const dirs = readdirSync(join(PS, "evals")).filter((d) => statSync(join(PS, "evals", d)).isDirectory());
  assert.equal(dirs.length, 8);
  for (const d of dirs) assert.ok(readdirSync(join(PS, "evals", d, "graders")).length >= 1, d);
});

test("the changelog has a 0.4.0 entry above 0.3.0 that describes the guard honestly", () => {
  const log = text("CHANGELOG.md");
  const at = log.indexOf("## 0.4.0");
  assert.ok(at >= 0 && at < log.indexOf("## 0.3.0"));
  for (const heading of ["### Added", "### Changed"]) assert.ok(log.indexOf(heading, at) > at, heading);
  const entry = log.slice(at, log.indexOf("## 0.3.0"));
  assert.match(entry, /not a sandbox/);
  assert.match(entry, /has not been seen firing in a real Claude Code run/);
});

test("the README describes the guard, its cost and its limits, and no longer says a hook can't help", () => {
  const readme = text("README.md");
  assert.match(readme, /^## The guard$/m);
  assert.doesNotMatch(readme, /A hook can't do this gate/, "the old sentence is gone");
  assert.match(readme, /tool-call hooks never see the model name/);
  assert.match(readme, /does a different job: it limits what the plugin's agents may run/);
  assert.match(readme, /echo phased-shipping-guard-probe/);
  // What it touches: every call, the measured time, nothing read but the call.
  assert.match(readme, /reads nothing but the call/);
  assert.match(readme, /median \d+ ms, p95 \d+ ms/);
  assert.match(readme, /30 runs/);
  // Limits.
  assert.match(readme, /allowManagedHooksOnly/);
  assert.match(readme, /It is not a sandbox/);
  assert.match(readme, /lists are not exhaustive/);
  assert.match(readme, /Not yet seen firing in a real run/);
  assert.match(readme, /sample payloads/);
});

test("run starts the checker with the probe, shows a Guard row that warns, and records guard", () => {
  const run = text("skills", "run", "SKILL.md");
  assert.match(run, /Start the brief with the guard probe, `echo phased-shipping-guard-probe`/);
  assert.match(run, /### Guard \(warns, never stops\)/);
  assert.match(run, /Guard probe: blocked \(active\)/);
  assert.match(run, /Guard probe: ran \(not active\)/);
  assert.match(run, /not active in this session \(an organization policy that allows only managed hooks, `disableAllHooks`, or the hook didn't load\); the prompt rules and gates still apply/);
  for (const value of ["active", "inactive", "unknown"]) assert.match(run, new RegExp(`\`guard: "${value}"\``));
  assert.match(run, /then the \*\*Guard\*\* row/);
});

test("the checker runs the probe first when the brief has it, and it is never a check failure", () => {
  const checker = text("agents", "checker.md");
  assert.match(checker, /If the brief includes `echo phased-shipping-guard-probe`, run it first/);
  assert.match(checker, /Guard probe: blocked \(active\)/);
  assert.match(checker, /Guard probe: ran \(not active\)/);
  assert.match(checker, /not a failure either way/);
});
