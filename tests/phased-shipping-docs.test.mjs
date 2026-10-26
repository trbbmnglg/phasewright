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
  assert.equal(JSON.parse(text(".claude-plugin", "plugin.json")).version, "0.7.0");
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
  assert.equal(dirs.length, 11);
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
  assert.match(readme, /Seen firing in real runs, on one setup/);
  assert.match(readme, /not been checked on macOS/);
  assert.match(readme, /sample payloads/);
  assert.doesNotMatch(readme, /Not yet seen firing in a real run/);
  assert.doesNotMatch(readme, /Hooks can't run on the machine this was built on/);
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

test("phase 7: run records the preview, checks it on approve and push, and a mismatch is a hard stop", () => {
  const run = text("skills", "run", "SKILL.md");
  assert.match(run, /commands-hash\.mjs" "<plan>" --check planned --data/);
  assert.match(run, /commands-hash\.mjs" "<plan>" --record previewed --data/);
  assert.match(run, /commands-hash\.mjs" "<plan>" --check previewed --data/);
  assert.doesNotMatch(run, /commands-hash\.mjs" <plan>/, "the plan path is always quoted");
  assert.match(run, /Commands changed since planning/);
  assert.match(run, /no planning record \(plan made elsewhere or before 0\.5\.0\)/);
  assert.match(run, /Exit 3: hard stop/);
  assert.match(run, /Run `\/phased-shipping:run N` again to preview the current commands/);
  assert.match(run, /No preview record\. Run `\/phased-shipping:run N` first/);
  assert.match(run, /Commands hash: <12 hex>/);
  assert.match(run, /Run the same `--check previewed` step first/);
  // The check comes before the shipper is briefed.
  const approve = run.slice(run.indexOf("## On `approve`"));
  assert.ok(approve.indexOf("--check previewed") < approve.indexOf("Brief `phased-shipping:shipper`"));
  // The preview records before it ends the turn.
  assert.ok(run.indexOf("--record previewed") < run.indexOf("Reply `/phased-shipping:run approve`"));
});

test("phase 7 fix round 1: the commands shown and the commands briefed are the section the script printed", () => {
  const run = text("skills", "run", "SKILL.md");
  const approve = run.slice(run.indexOf("## On `approve`"));
  const preview = run.slice(run.indexOf("## Preview, then stop"), run.indexOf("## On `approve`"));
  // H1: one source of the commands, in the preview and in the brief.
  assert.match(preview, /It prints `recorded previewed <12 hex>`, then the recorded `## Commands` section\. The commands you show in the report are that printed section, copied verbatim\. Don't use an earlier read of the plan\./);
  assert.match(preview, /the section printed by the `--record previewed` step, verbatim, with the plan file path and `Commands hash: <12 hex>`/);
  assert.match(approve, /it prints `match <12 hex>` and the recorded section\. That printed section is the only source of the commands for the brief\. Don't re-read the plan file, and don't take commands from the preview turn or from memory\. If it lacks a deploy, prod-check or rollback command, stop\./);
  assert.match(approve, /the deploy, prod-check and rollback commands and the window, in order, copied verbatim from the section `--check previewed` printed;/);
  assert.match(approve, /The commands in the brief come only from the section it printed, copied verbatim, as for approve\./, "push path");
  assert.ok(run.includes("only source of the commands"));
  // L3: a failure of the script is a stop, never a skipped step.
  assert.match(approve, /Any other exit code, or no `match` line: stop and show the output\./);
  assert.match(preview, /If it doesn't print `recorded previewed`, stop: approve can't be bound\./);
  assert.match(preview, /Any other exit code \(the script can't run, a usage or I\/O error\): stop and show the output\. Don't skip this step\./);
  // L10: a fix-forward that changes the commands needs a new preview.
  // Fix round 2, L4: the fix-forward re-runs Preview steps 1 and 2 and ends the turn.
  assert.match(approve, /If the fix changes the plan's commands, run Preview steps 1 and 2 again, show the section `--record previewed` printed, and end the turn before the fresh approve\./);
  assert.doesNotMatch(approve, /re-record `previewed` in a preview turn/);
});

test("phase 7 fix round 2: no override for a hash script that can't run, plan says run stops, the brief window adds no command", () => {
  const run = text("skills", "run", "SKILL.md");
  const approve = run.slice(run.indexOf("## On `approve`"));
  // L3: a hash script that can't run is a stop with no "proceed anyway".
  assert.match(approve, /If the script can't run \(Node missing\), stop and say the approval can't be bound to the commands the user saw\.\n/);
  assert.doesNotMatch(approve, /Only the user's explicit "proceed anyway" overrides this/);
  const plan = text("skills", "plan", "SKILL.md");
  assert.match(plan, /If Node is missing, say that `run` will stop at the preview until Node is available\./);
  assert.doesNotMatch(plan, /approval won't be bound to the commands/);
  // L5: a no-deploy window only restricts deploys.
  assert.match(run, /any no-deploy window from CLAUDE\.md \(a window only restricts deploys; it never adds a command\)/);
});

test("phase 7 fix round 2: README and CHANGELOG say exactly what is protected and what is not", () => {
  const readme = text("README.md");
  const section = readme.slice(readme.indexOf("## How approval works"), readme.indexOf("## Requirements"));
  for (const doc of [section, text("CHANGELOG.md").slice(text("CHANGELOG.md").indexOf("## 0.5.0"), text("CHANGELOG.md").indexOf("## 0.4.0"))]) {
    assert.match(doc, /\.claude\/plugins\/cache/);
    assert.match(doc, /installed plugin folders for phased-shipping/);
    assert.match(doc, /`commands-hash\.mjs`/);
    assert.match(doc, /`--record`/);
    assert.match(doc, /`git restore --staged`/);
  }
  assert.match(section, /`previews\/<key>\.planned\.json` and `\.previewed\.json`/);
  assert.match(section, /can still forge a record by running the script from its own `node -e`/);
  assert.match(section, /nor `git stash pop`, a whole-folder `git checkout`, subshell or brace-group redirects, `>\|`, other in-place editors, or scripts/);
  assert.match(section, /The record key is path-based/);
  assert.match(section, /A `previewed` record is not used up: an `approve` in a later session still matches an old preview of an unchanged plan/);
  assert.match(section, /fix-forward round that changes the plan's commands needs a new preview/);
  assert.equal(text("CHANGELOG.md").split("## 0.5.0").length, 2, "one 0.5.0 block");
});

test("phase 7: plan records `planned` and adds the Commands hash line; the shipper reports the hash", () => {
  const plan = text("skills", "plan", "SKILL.md");
  assert.match(plan, /commands-hash\.mjs" "<phase plan path>" --record planned --data/);
  assert.doesNotMatch(plan, /commands-hash\.mjs" <phase plan path>/, "the plan path is always quoted");
  assert.match(plan, /If it doesn't print `recorded planned`, stop and show the output/);
  assert.match(plan, /\*\*Commands hash:\*\* <12 hex> \(planned\)/);
  assert.match(text("skills", "plan", "references", "templates.md"), /^\*\*Commands hash:\*\* <12 hex> \(planned\)$/m);
  assert.match(text("agents", "shipper.md"), /If the brief carries a `Commands hash`, put it in the report/);
});

test("phase 7: the changelog has a 0.5.0 entry above 0.4.0, and the README is honest about what the binding stops", () => {
  const log = text("CHANGELOG.md");
  const at = log.indexOf("## 0.5.0");
  assert.ok(at >= 0 && at < log.indexOf("## 0.4.0"));
  for (const heading of ["### Added", "### Changed"]) assert.ok(log.indexOf(heading, at) > at, heading);
  assert.match(log.slice(at, log.indexOf("## 0.4.0")), /does not protect against a malicious local process/);
  const readme = text("README.md");
  assert.match(readme, /^## How approval works$/m);
  assert.match(readme, /accidental and model-made drift/);
  assert.match(readme, /does not protect against a malicious local process that can rewrite both the plan and the record/);
  assert.match(readme, /to preview the current commands/);
  assert.match(readme, /best effort|reads literal paths in the common write forms only/);
});

test("phase 7b: run attributes fix rounds, records caught_by, and reads NO SHELL and UNFINISHED results", () => {
  const run = text("skills", "run", "SKILL.md");
  for (const phrase of ["NO SHELL:", "UNFINISHED", "TIMED OUT", "caught_by", "(re-run in main)", "unverified"]) assert.ok(run.includes(phrase), phrase);
  for (const source of ["builder-self", "compare", "own-review", "security-review", "browser-check", "prod-check"]) assert.ok(run.includes("`" + source + "`"), source);
  assert.match(run, /\(Get-Date\)\.ToUniversalTime\(\)\.ToString\('yyyy-MM-ddTHH:mm:ssZ'\)/);
  assert.match(run, /date -u/);
  assert.match(run, /Agents never make timestamps/);
  assert.ok(run.includes('SECONDS=0; <command>; echo "exit=$? seconds=$SECONDS"'), "run brief asks for the exit= seconds= line");
  assert.ok(run.includes("seconds=$SECONDS"), "run brief reads the seconds counter");
  assert.ok(run.includes("take the exit code and the duration in seconds from that line"), "run brief takes both values from the line");
  assert.doesNotMatch(run, /report each command's duration/);
  assert.match(run, /Never report a phase as built or checked on the result of an agent that had no shell/);
  // The approval-binding text from phases 6 and 7 is still there.
  assert.match(run, /### Guard \(warns, never stops\)/);
  assert.match(run, /--check previewed --data/);
});

test("phase 7b: the checker runs long commands in the foreground with a 10-minute timeout and reports unfinished ones", () => {
  const checker = text("agents", "checker.md");
  assert.match(checker, /\*\*Long commands\.\*\*/);
  assert.match(checker, /`timeout` parameter as 600000/);
  assert.match(checker, /never use background mode/);
  assert.match(checker, /at most 5 times/);
  assert.match(checker, /`UNFINISHED`/);
  assert.match(checker, /TIMED OUT after 10 min/);
  assert.match(checker, /`pass`, `fail` or `unfinished`/);
  assert.match(checker, /overall: not complete/);
});

test("phase 7b: builder, checker and shipper carry the NO SHELL rule and the Windows note, and never tell the agent to call powershell or cmd", () => {
  for (const agent of ["builder", "checker", "shipper"]) {
    const md = text("agents", `${agent}.md`);
    assert.ok(md.includes("NO SHELL:"), `${agent} NO SHELL:`);
    assert.ok(md.includes("cmd /c npm"), `${agent} cmd /c note`);
    assert.match(md, /^## Windows and Git Bash$/m, agent);
    assert.match(md, /Don't read the clock to make timestamps/, agent);
    assert.doesNotMatch(md, /Don't read the clock or report times/, agent);
    // Instruction position: "run/use/call/invoke powershell|cmd", other than the "don't use" note.
    for (const line of md.split(/\r?\n/)) {
      if (/don't use|Don't use|prints only the cmd banner/.test(line)) continue;
      assert.doesNotMatch(line, /\b(run|use|call|invoke|launch|start)\b[^.\n]*\b(powershell|pwsh|cmd)\b/i, `${agent}: ${line}`);
    }
  }
  assert.match(text("agents", "builder.md"), /Edit a file only when you can run that step's test afterwards/);
  assert.match(text("agents", "builder.md"), /files you edited since your last passing test run/);
  assert.match(text("agents", "shipper.md"), /Don't retry\. Start your report with `NO SHELL:`/);
  assert.match(text("agents", "checker.md"), /list the commands that did not run/);
});

test("phase 7g: the checker reports durations and captures exit codes; the README's Windows section says so", () => {
  const checker = text("agents", "checker.md");
  assert.ok(checker.includes("Do report each command's duration"));
  assert.ok(checker.includes('SECONDS=0; <command>; echo "exit=$? seconds=$SECONDS"'));
  assert.ok(checker.includes("seconds=$SECONDS"));
  assert.ok(checker.includes("SECONDS=0"));
  assert.ok(checker.includes("**Exit codes and durations.**"));
  assert.ok(!checker.includes("**Exit codes.**"));
  assert.doesNotMatch(checker, /Don't read the clock or report times/);
  const readme = text("README.md");
  const win = readme.slice(readme.indexOf("## Windows and Git Bash"));
  assert.ok(win.includes("report each command's duration"));
  assert.ok(win.includes('SECONDS=0; <command>; echo "exit=$? seconds=$SECONDS"'));
  assert.doesNotMatch(readme, /The agents don't read the clock\. /);
  const log = text("CHANGELOG.md");
  assert.ok(log.indexOf("## 0.6.2") >= 0 && log.indexOf("## 0.6.2") < log.indexOf("## 0.6.0"));
});

test("phase 7k: the CHANGELOG has 0.6.3 above 0.6.2 and says it is documentation only", () => {
  const log = text("CHANGELOG.md");
  const at = log.indexOf("## 0.6.3");
  assert.ok(at >= 0 && at < log.indexOf("## 0.6.2"));
  const entry = log.slice(at, log.indexOf("## 0.6.2"));
  assert.match(entry, /No guard rule changed/);
  assert.match(entry, /Documentation only/);
});

test("phase 7b: the eval run-no-shell-not-verified has a prompt and at least two graders with a typed llm grader", () => {
  const dir = join(PS, "evals", "run-no-shell-not-verified");
  const prompt = readFileSync(join(dir, "prompt.md"), "utf8");
  const fm = frontmatter(prompt);
  assert.match(fm, /^max_turns: \d+$/m);
  assert.match(fm, /^allowed_tools: \[.+\]$/m);
  assert.match(prompt, /^NO SHELL: edited 3 files, no test run/m);
  const graders = readdirSync(join(dir, "graders")).filter((f) => f.endsWith(".md"));
  assert.ok(graders.length >= 2);
  const types = graders.map((f) => frontmatter(readFileSync(join(dir, "graders", f), "utf8")).match(/^type: (llm|tool_used)$/m)?.[1]);
  assert.ok(types.every(Boolean));
  assert.ok(types.includes("llm"));
});

test("phase 7b: the changelog has one 0.6.0 block above 0.5.0, and the README has the Windows note and the two limits", () => {
  const log = text("CHANGELOG.md");
  assert.equal(log.split("## 0.6.0").length, 2, "one 0.6.0 block");
  const at = log.indexOf("## 0.6.0");
  assert.ok(at >= 0 && at < log.indexOf("## 0.5.0"));
  for (const heading of ["### Added", "### Changed"]) assert.ok(log.indexOf(heading, at) > at, heading);
  const readme = text("README.md");
  assert.match(readme, /^## Windows and Git Bash$/m);
  assert.match(readme, /`cmd \/c npm \.\.\.` prints only the cmd banner/);
  assert.match(readme, /A checker can report `UNFINISHED`/);
  assert.match(readme, /`caught_by` in the history is only as good as the main session's attribution/);
});

test("phase 7d1: the CHANGELOG has 0.7.0 above 0.6.3, says no guard rule changed, and lists what was added", () => {
  const log = text("CHANGELOG.md");
  assert.equal(log.split("## 0.7.0").length, 2, "one 0.7.0 block");
  const at = log.indexOf("## 0.7.0");
  assert.ok(at >= 0 && at < log.indexOf("## 0.6.3"));
  const entry = log.slice(at, log.indexOf("## 0.6.3"));
  for (const heading of ["### Added", "### Changed"]) assert.ok(entry.includes(heading), heading);
  assert.match(entry, /No guard rule changed/);
  assert.match(entry, /roadmap\.mjs/);
  assert.match(entry, /`v` field/);
  assert.match(entry, /roadmap-check-is-read-only/);
  assert.match(entry, /roadmap-standardize-needs-yes/);
  // The earlier entries are still there.
  assert.ok(log.indexOf("## 0.6.3") < log.indexOf("## 0.6.2"));
});

test("phase 7d1: the README has the roadmap section, the touches lines and the limit", () => {
  const readme = text("README.md");
  assert.match(readme, /^## The roadmap format$/m);
  assert.match(readme, /\]\(skills\/roadmap\/references\/format\.md\)/);
  assert.match(readme, /<!-- phased-shipping:roadmap v1 -->/);
  assert.match(readme, /^\| `\/phased-shipping:roadmap` \(skill\) \| sonnet, low \|/m);
  const touches = readme.slice(readme.indexOf("## What it touches"), readme.indexOf("## Limits"));
  assert.match(touches, /The roadmap file \(`PHASES\.md`\), through `roadmap\.mjs`/);
  assert.match(touches, /`standardize --write` writes `<file>\.bak-<timestamp>`/);
  assert.match(touches, /only after you say yes/);
  assert.match(touches, /`set` rewrites one row of one standard table/);
  assert.match(readme.slice(readme.indexOf("## Limits")), /tables only, line by line: it is not a full Markdown parser/);
  assert.match(readme, /The eleven cases check that:/);
});

test("phase 7d1: the roadmap skill is owner-invoked, on sonnet at low effort, and asks before it writes", () => {
  const skill = text("skills", "roadmap", "SKILL.md");
  const fm = frontmatter(skill);
  assert.match(fm, /^name: roadmap$/m);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(fm, /^model: sonnet$/m);
  assert.match(fm, /^effort: low$/m);
  assert.match(fm, /^argument-hint: "\[check \| standardize\] \[path\/to\/PHASES\.md\]"$/m);
  assert.match(skill, /node "\$\{CLAUDE_SKILL_DIR\}\/scripts\/roadmap\.mjs" check "<file>" --root "<project folder>"/);
  assert.match(skill, /Always pass it as `--root "<project folder>"`/);
  assert.match(skill, /never gives `--write` without the owner's explicit yes, asked with AskUserQuestion/);
  assert.match(skill, /even if the owner's message says "don't ask"/);
  assert.match(skill, /Never edit the file in this mode/);
  assert.match(skill, /Never guess a status/);
  assert.match(skill, /one roadmap file in this project\. It never takes a file from another project/);
  for (const status of ["planned", "in progress", "shipped", "parked"]) assert.ok(skill.includes(`\`${status}\``), status);
  assert.ok(existsSync(join(PS, "skills", "roadmap", "references", "format.md")));
  assert.ok(existsSync(join(PS, "skills", "roadmap", "scripts", "roadmap.mjs")));
});

test("phase 7d1: plan and run reach the roadmap script the same way they reach commands-hash.mjs", () => {
  const plan = text("skills", "plan", "SKILL.md");
  const run = text("skills", "run", "SKILL.md");
  assert.match(plan, /node "\$\{CLAUDE_SKILL_DIR\}\/\.\.\/run\/scripts\/commands-hash\.mjs"/, "the pattern being copied");
  assert.match(plan, /node "\$\{CLAUDE_SKILL_DIR\}\/\.\.\/roadmap\/scripts\/roadmap\.mjs" check "<PHASES\.md path>" --root "<project folder>"/);
  assert.match(plan, /fix every error it reports/);
  assert.match(run, /node "\$\{CLAUDE_SKILL_DIR\}\/\.\.\/roadmap\/scripts\/roadmap\.mjs" set "<PHASES\.md>" <phase id> --status "in progress" --root "<folder of PHASES\.md>"/);
  assert.match(run, /roadmap\.mjs" set "<PHASES\.md>" <phase id> --status shipped --commit <sha> --actual <hours> --root/);
  assert.match(run, /run standardize first/);
  assert.match(run, /update the row by hand as before/);
  // Neither skill ever runs standardize or --write itself.
  for (const doc of [plan, run]) assert.doesNotMatch(doc, /roadmap\.mjs" standardize/);
  assert.doesNotMatch(run, /roadmap\.mjs"[^\n]*--write/);
  // The status words agree across the skills and the template.
  assert.match(run, /\*\*The previous phase\*\* is shipped or parked \(skipped\)\./);
  assert.doesNotMatch(run, /marked skipped/);
  const template = text("skills", "plan", "references", "templates.md");
  assert.match(template, /^## Roadmap\n<!-- phased-shipping:roadmap v1 -->\n\| # \| Phase \| Kind \|/m);
  assert.match(template, /Status is one of `planned`, `in progress`, `shipped` or `parked`/);
});

test("phase 7d1: the two roadmap evals have a prompt with max_turns and allowed_tools, an llm grader and typed tool graders", () => {
  for (const name of ["roadmap-check-is-read-only", "roadmap-standardize-needs-yes"]) {
    const dir = join(PS, "evals", name);
    const prompt = readFileSync(join(dir, "prompt.md"), "utf8");
    const fm = frontmatter(prompt);
    assert.match(fm, /^max_turns: \d+$/m, `${name} max_turns`);
    assert.match(fm, /^allowed_tools: \[.+\]$/m, `${name} allowed_tools`);
    assert.match(prompt, /^\/phased-shipping:roadmap (check|standardize)$/m, name);
    const graders = readdirSync(join(dir, "graders")).filter((f) => f.endsWith(".md"));
    const parsed = graders.map((f) => frontmatter(readFileSync(join(dir, "graders", f), "utf8")));
    assert.ok(parsed.every((g) => /^type: (llm|tool_used)$/m.test(g)), `${name} graders all have a type`);
    assert.ok(parsed.some((g) => /^type: llm$/m.test(g)), `${name} has an llm grader`);
    for (const g of parsed.filter((x) => /^type: tool_used$/m.test(x))) {
      assert.match(g, /^tool: \w+$/m);
      assert.match(g, /^input_match: .+$/m);
      assert.match(g, /^max: 0$/m);
    }
  }
  const check = readdirSync(join(PS, "evals", "roadmap-check-is-read-only", "graders")).map((f) => readFileSync(join(PS, "evals", "roadmap-check-is-read-only", "graders", f), "utf8")).join("\n");
  assert.match(check, /tool: Edit/);
  assert.match(check, /tool: Write/);
  const yes = readdirSync(join(PS, "evals", "roadmap-standardize-needs-yes", "graders")).map((f) => readFileSync(join(PS, "evals", "roadmap-standardize-needs-yes", "graders", f), "utf8")).join("\n");
  assert.match(yes, /tool: Bash\ninput_match: '--write'/);
  assert.match(readFileSync(join(PS, "evals", "roadmap-standardize-needs-yes", "prompt.md"), "utf8"), /Don't ask me anything, just fix it/);
});

test("phase 7d1: the guard rules file changed only its version", () => {
  const rules = readFileSync(join(PS, "hooks", "guard-rules.mjs"), "utf8");
  assert.match(rules, /^export const GUARD_VERSION = "0\.7\.0";$/m);
  assert.equal(rules.split(/\r?\n/)[15], 'export const GUARD_VERSION = "0.7.0";', "line 16");
});
