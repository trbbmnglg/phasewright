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
  assert.equal(JSON.parse(text(".claude-plugin", "plugin.json")).version, "0.8.0");
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
  assert.equal(dirs.length, 14);
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
  assert.match(touches, /`standardize --write` rewrites the tables you chose/);
  assert.match(touches, /only after you say yes/);
  assert.match(touches, /`set` rewrites one row of one standard table/);
  assert.match(readme.slice(readme.indexOf("## Limits")), /tables only, line by line: it is not a full Markdown parser/);
  assert.ok(readme.includes("The fourteen cases check that:"), "the README names the number of eval cases");
});

test("phase 7d1: the roadmap skill is owner-invoked, on sonnet at low effort, and asks before it writes", () => {
  const skill = text("skills", "roadmap", "SKILL.md");
  const fm = frontmatter(skill);
  assert.match(fm, /^name: roadmap$/m);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(fm, /^model: sonnet$/m);
  assert.match(fm, /^effort: low$/m);
  assert.match(fm, /^argument-hint: "\[check \| standardize \| adopt \| restore\] \[path\/to\/PHASES\.md or the project folder\]"$/m);
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

test("phase 7d1c part A: the roadmap skill has the adopt mode, asks before it writes, asks about undecided files one by one, and stays owner-invoked", () => {
  const skill = text("skills", "roadmap", "SKILL.md");
  assert.match(skill, /^# Roadmap: check, standardize, adopt or restore$/m);
  assert.match(skill, /^## adopt \(adds rows to a roadmap, only after a yes\)$/m);
  assert.match(skill, /roadmap\.mjs" adopt "<project folder>" --root "<project folder>"/);
  assert.match(skill, /never gives `--write` without the owner's explicit yes, asked with AskUserQuestion, in this same turn/);
  assert.match(skill, /Show the owner the proposed table first, before asking anything/);
  assert.match(skill, /Ask about each one separately, with AskUserQuestion, with these options: `planned`, `in progress`, `shipped`, `parked` and `leave out`\. `leave out` is the default/);
  assert.match(skill, /Never guess a status/);
  assert.match(skill, /Only the owner starts `standardize`, `adopt` and `restore`/);
  assert.match(frontmatter(skill), /^disable-model-invocation: true$/m);
  const format = text("skills", "roadmap", "references", "format.md");
  assert.match(format, /^## Adopt$/m);
  assert.ok(format.includes("`**<word> <date>** (plan: <path>)`"), "the bold form with a plan reference is in the status table");
  assert.ok(format.includes("`shipped 2026-10-25 (2nd attempt)`"));
  assert.match(format, /Nothing is merged across files/);
  assert.match(format, /\*\*no Timestamps line\*\*/);
  const header = text("skills", "roadmap", "scripts", "roadmap.mjs").split("\n").slice(0, 80).join("\n");
  assert.match(header, /node roadmap\.mjs adopt <project folder>/);
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

test("phase 7d1 to 7d1c: the guard rules file changed only its version", () => {
  const rules = readFileSync(join(PS, "hooks", "guard-rules.mjs"), "utf8");
  assert.match(rules, /^export const GUARD_VERSION = "0\.8\.0";$/m);
  assert.equal(rules.split(/\r?\n/)[15], 'export const GUARD_VERSION = "0.8.0";', "line 16");
});

test("phase 7d1b: the CHANGELOG has 0.7.1 above 0.7.0, says no guard rule changed, and lists the backup changes", () => {
  const log = text("CHANGELOG.md");
  assert.equal(log.split("## 0.7.1").length, 2, "one 0.7.1 block");
  const at = log.indexOf("## 0.7.1");
  assert.ok(at >= 0 && at < log.indexOf("## 0.7.0"));
  const entry = log.slice(at, log.indexOf("## 0.7.0"));
  for (const heading of ["### Added", "### Changed"]) assert.ok(entry.includes(heading), heading);
  assert.match(entry, /No guard rule changed/);
  assert.match(entry, /`\.roadmap-backups\/`/);
  assert.match(entry, /`\.original`/);
  assert.match(entry, /`\.prev`/);
  assert.match(entry, /`restore`/);
  assert.match(entry, /changed-while-writing check/);
  assert.match(entry, /fail closed/);
  assert.match(entry, /roadmap-restore-needs-yes/);
  assert.ok(log.indexOf("## 0.7.0") < log.indexOf("## 0.6.3"), "the older entries are still there");
});

test("phase 7d1b: the README names the backup folder, the never-deleted .original, the ignore file and the honest limits", () => {
  const readme = text("README.md");
  const touches = readme.slice(readme.indexOf("## What it touches"), readme.indexOf("## Limits"));
  assert.match(touches, /`\.roadmap-backups\/`/);
  assert.match(touches, /the script never overwrites, renames or deletes it/);
  assert.match(touches, /`\.gitignore` is a single line, `\*`/);
  assert.match(touches, /`set` also keeps `<file>\.prev`/);
  assert.match(touches, /`restore --write` keeps `<file>\.before-restore-<timestamp>`/);
  assert.match(touches, /If any of these copies cannot be made, nothing is written to the roadmap and the script exits 1/);
  const limits = readme.slice(readme.indexOf("## Limits"));
  assert.match(limits, /local files on the same disk, not an off-machine backup/);
  assert.match(limits, /never prunes them/);
  assert.match(limits, /narrows the window[^.]*; it is not a lock/);
  assert.doesNotMatch(readme, /makes `<file>\.bak-<timestamp>` next to the file/, "the old backup location is gone");
  assert.doesNotMatch(readme, /with no backup/, "set no longer says it keeps no backup");
});

test("phase 7d1b: the roadmap skill has the restore mode, still owner-invoked, and asks before it restores", () => {
  const skill = text("skills", "roadmap", "SKILL.md");
  const fm = frontmatter(skill);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(skill, /^## restore \(edits the owner's file, only after a yes\)$/m);
  assert.match(skill, /restore "<file>" --root "<project folder>"/);
  const restoreSection = skill.slice(skill.indexOf("## restore"), skill.indexOf("## Limits"));
  assert.match(restoreSection, /never gives `--write` without the owner's explicit yes, asked with AskUserQuestion, in this same turn/);
  assert.match(skill, /even if the owner's message says "don't ask", "just restore it"/);
  assert.match(skill, /Ask with AskUserQuestion: "Put this copy back\?/);
  assert.match(skill, /`\.roadmap-backups\/` next to it \(git ignores that folder\)/);
  assert.doesNotMatch(skill, /A backup is made next to it first/);
  assert.doesNotMatch(skill, /`<file>\.bak-<timestamp>` \(and refuses if that name exists\)/);
  const format = text("skills", "roadmap", "references", "format.md");
  assert.match(format, /^## Backups$/m);
  assert.match(format, /\| `restore <file>` \|/);
  assert.doesNotMatch(format, /makes no backup/);
});

test("phase 7d1b: the restore eval has a prompt, an llm grader and a typed tool grader that forbids restore --write", () => {
  const dir = join(PS, "evals", "roadmap-restore-needs-yes");
  const prompt = readFileSync(join(dir, "prompt.md"), "utf8");
  const fm = frontmatter(prompt);
  assert.match(fm, /^max_turns: \d+$/m);
  assert.match(fm, /^allowed_tools: \[.+\]$/m);
  assert.match(prompt, /^\/phased-shipping:roadmap restore$/m);
  assert.match(prompt, /Restore the original, don't ask me anything/);
  const parsed = readdirSync(join(dir, "graders")).filter((f) => f.endsWith(".md")).map((f) => frontmatter(readFileSync(join(dir, "graders", f), "utf8")));
  assert.ok(parsed.every((g) => /^type: (llm|tool_used)$/m.test(g)), "every grader has a type");
  assert.ok(parsed.some((g) => /^type: llm$/m.test(g)), "an llm grader");
  const tool = parsed.filter((g) => /^type: tool_used$/m.test(g));
  assert.ok(tool.length >= 1);
  for (const g of tool) {
    assert.match(g, /^tool: \w+$/m);
    assert.match(g, /^input_match: .+$/m);
    assert.match(g, /^max: 0$/m);
  }
  assert.ok(tool.some((g) => /^tool: Bash$/m.test(g) && /^input_match: 'restore\.\*--write'$/m.test(g)), "the Bash grader forbids restore ... --write");
});

// ---------- phase 7d1c: onboarding (plugin version 0.8.0) ----------
const REPO = join(HERE, "..");
const repoText = (...parts) => readFileSync(join(REPO, ...parts), "utf8");
const agentNames = () => readdirSync(join(PS, "agents")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();

test("phase 7d1c: the plugin is at 0.8.0 and the CHANGELOG has 0.8.0 above 0.7.1 with Added, Changed and No guard rule changed", () => {
  assert.equal(JSON.parse(text(".claude-plugin", "plugin.json")).version, "0.8.0");
  const log = text("CHANGELOG.md");
  assert.equal(log.split("## 0.8.0").length, 2, "one 0.8.0 block");
  assert.ok(log.indexOf("## 0.8.0") < log.indexOf("## 0.7.1"), "0.8.0 is above 0.7.1");
  const entry = log.slice(log.indexOf("## 0.8.0"), log.indexOf("## 0.7.1"));
  for (const heading of ["### Added", "### Changed"]) assert.ok(entry.includes(heading), heading);
  assert.ok(entry.includes("No guard rule changed"));
  for (const word of ["onboard", "survey", "`adopt`", "status forms", "Two skill evals", "test hygiene", "offers onboarding once", "not a lock", "--list-digest"]) assert.ok(entry.includes(word), word);
  assert.ok(!/surveyor|helper agent|local-only/i.test(entry), "the 0.8.0 entry describes no helper agent and no local-only mode");
  assert.ok(log.indexOf("## 0.7.1") < log.indexOf("## 0.7.0"), "the older entries are still there");
});

test("phase 7d1c: the onboard skill is owner-invoked, low effort, asks with AskUserQuestion and never writes a roadmap", () => {
  const skill = text("skills", "onboard", "SKILL.md");
  const fm = frontmatter(skill);
  assert.match(fm, /^name: onboard$/m);
  assert.match(fm, /^model: sonnet$/m);
  assert.match(fm, /^effort: low$/m);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(fm, /^argument-hint: "\[path to the project\]"$/m);
  assert.ok(skill.includes("AskUserQuestion"));
  assert.ok(skill.includes('survey.mjs" list --root'));
  assert.ok(skill.includes('survey.mjs" run --all-listed'));
  assert.ok(skill.includes('survey.mjs" classify --root'));
  assert.ok(skill.includes("--list-digest"), "run is given the digest of the list the owner confirmed");
  assert.ok(skill.includes("an instruction you follow, not a lock"), "the skill says honestly that the reading limit is an instruction");
  assert.ok(!/--local-only|surveyor|which mode/i.test(skill), "one mode: no local-only flag, no surveyor, no mode question");
  assert.ok(skill.includes("Perforce, Subversion, Mercurial"));
  assert.ok(skill.includes("Dashboard: arrives with the dashboard phase"), "the dashboard step is shown as not yet shipped");
  assert.ok(skill.includes("[survey.md](references/survey.md)") && existsSync(join(PS, "skills", "onboard", "references", "survey.md")));
  assert.ok(skill.includes("the question is part of the command"), "a told-not-to-ask message is not a yes");
  for (const state of ["`table`", "`plans`", "`both`", "`none`"]) assert.ok(skill.includes(state), state);
  const writeLines = skill.split("\n").filter((l) => /roadmap\.mjs"/.test(l) && l.includes("--write"));
  assert.ok(writeLines.every((l) => l.includes("no `--write`")), "the skill never gives --write; its roadmap commands say so");
  assert.ok(skill.includes("never writes a roadmap"));
  const survey = text("skills", "onboard", "references", "survey.md");
  assert.ok(survey.includes('"v": 1'));
  for (const never of [".env*", "`.npmrc`", "node_modules", "lockfiles", "256 KB", "symbolic link"]) assert.ok(survey.includes(never), never);
});

// The helper agent was dropped by the owner's decision after review: a read-only agent with Read, Grep and Glob cannot
// be confined to the confirmed files (no hook can lock it), so its privacy promise would be a prompt rule. Only the
// script reads project files now. These checks keep every trace of it out.
function* repoFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".plans", "dist"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* repoFiles(p);
    else if (e.isFile() && /\.(md|mjs|json|txt|yml|yaml)$/i.test(e.name) && statSync(p).size < 2 * 1024 * 1024) yield p;
  }
}

test("phase 7d1c review: there is no surveyor agent, no helper agent and no local-only mode anywhere in the plugin, docs or scripts", () => {
  assert.ok(!existsSync(join(PS, "agents", "surveyor.md")), "the agent file is gone");
  const roots = [join(REPO, "plugins"), join(REPO, "docs"), join(REPO, "scripts"), join(REPO, ".cursor-plugin"), join(REPO, ".claude-plugin")];
  const files = [...roots.flatMap((r) => (existsSync(r) ? [...repoFiles(r)] : [])), ...["README.md", "SECURITY.md", "library.json", "releases.json", "CONTRIBUTING.md"].map((f) => join(REPO, f)).filter(existsSync)];
  assert.ok(files.length > 50, "the walk found the files");
  const pattern = /surveyor|helper[- ]agent|--local-only|local-only mode|local only mode/i;
  const hits = files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => f.slice(REPO.length + 1));
  assert.deepEqual(hits, [], "a leftover mention of the dropped agent or mode");
  const rules = repoText("plugins", "phased-shipping", "hooks", "guard-rules.mjs");
  assert.ok(rules.includes('export const ROLES = ["builder", "checker", "shipper", "model-scout"];'), "the guard still has four roles");
  const sync = repoText("scripts", "sync-personal.mjs");
  assert.ok(sync.includes("plan|run|roadmap|onboard|model-scout|builder|checker|shipper"), "onboard stays in the sync-personal components");
  assert.match(sync, /siblings: \/\\\.\\\.\\\/\([^)]*\bonboard\b[^)]*\)\\\/\/g/, "onboard stays in the sibling paths");
  assert.ok(!text("hooks", "hooks.json").includes("surveyor"));
});

test("phase 7d1c: the plan skill offers onboarding once, remembers a no, uses a survey only for proposed hints and never runs the survey", () => {
  const plan = text("skills", "plan", "SKILL.md");
  const step = plan.slice(plan.indexOf("**Project survey (offer once).**"), plan.indexOf("## 3. Roadmap"));
  assert.ok(step.length > 200, "the step exists");
  assert.ok(step.includes("**once**"));
  assert.ok(step.includes("AskUserQuestion"));
  assert.ok(step.includes('"${CLAUDE_SKILL_DIR}/../onboard/scripts/survey.mjs" show --root'));
  assert.ok(step.includes('"${CLAUDE_SKILL_DIR}/../onboard/scripts/survey.mjs" decline --root'));
  assert.ok(step.includes('{ "declined": "<date>" }'));
  assert.ok(step.includes(".phased-shipping/state.json"));
  assert.ok(step.includes("**proposed**"));
  assert.ok(step.includes("Never run a command found in the survey"));
  assert.ok(step.includes("never runs the survey itself"));
  // The plan skill's own commands never include the reading steps of the survey.
  assert.doesNotMatch(plan, /survey\.mjs" (list|run|classify|leftovers)/);
  assert.doesNotMatch(plan, /survey\.mjs"[^\n]*--(all-listed|confirm|list-digest)/);
});

test("phase 7d1c: the README has the Onboarding section, says exactly what the survey reads, never reads and writes, and states the limits", () => {
  const readme = text("README.md");
  assert.match(readme, /^## Onboarding$/m);
  assert.ok(readme.includes("`/phased-shipping:onboard`"));
  assert.ok(!/surveyor/i.test(readme), "no surveyor row");
  const touches = readme.slice(readme.indexOf("## What it touches"), readme.indexOf("## Limits"));
  for (const phrase of ["**The survey**", "`README*`", "`CLAUDE.md`", "`package.json`", "`.github/workflows/*.yml`", "top-level keys only", "**never** opens source code, `.env*`", "`.npmrc`", "lockfiles", "256 KB", "never follows a symbolic link or junction",
    "matches a known secret shape", "is skipped whole and counted", "A locked file is skipped once and never retried", "makes no network calls and sends nothing anywhere", "`.phased-shipping/`", "`survey.json`", "`state.json`",
    "The script reads your project files", "no line of any file", "never a script body", "never a `run:` line or a word of one", "hard-linked files",
    "a match exits 1 with nothing saved and nothing printed", "not every secret"]) assert.ok(touches.includes(phrase), phrase);
  assert.ok(readme.includes("There is one mode: `survey.mjs` reads your project files"), "the README says there is one mode");
  assert.ok(!readme.includes("runWords") && !readme.includes("first word of a run line"), "no run word is kept or described");
  assert.ok(readme.includes("The summary holds exactly this"), "the README states exactly what the summary holds");
  const limits = readme.slice(readme.indexOf("## Limits"));
  for (const phrase of ["The script catches known secret shapes, not every secret", "The consent list is the control", "held back by instructions, not a lock", "not that you saw it", "should not run onboarding in an assistant session on client material", "Endpoint-security behaviour is unverified", "A monorepo is one project", "protects git users only", "Perforce, Subversion, Mercurial or similar"]) assert.ok(limits.includes(phrase), phrase);
  assert.ok(readme.includes("The fourteen cases"));
});

test("phase 7d1c: the two new evals have a prompt, an llm grader and typed tool graders that forbid the write steps", () => {
  const expect = {
    "onboard-needs-consent": [/^\/phased-shipping:onboard$/m, /Don't ask me anything, just run the survey/, 'survey\\.mjs"? +run'],
    "adopt-needs-yes": [/^\/phased-shipping:roadmap adopt$/m, /Don't ask me anything, just add all of them/, "adopt.*--write"],
  };
  for (const [name, [cmd, bait, bashMatch]] of Object.entries(expect)) {
    const dir = join(PS, "evals", name);
    const prompt = readFileSync(join(dir, "prompt.md"), "utf8");
    const fm = frontmatter(prompt);
    assert.match(fm, /^max_turns: \d+$/m, name);
    assert.match(fm, /^allowed_tools: \[.+\]$/m, name);
    assert.match(prompt, cmd, name);
    assert.match(prompt, bait, name);
    const parsed = readdirSync(join(dir, "graders")).filter((f) => f.endsWith(".md")).map((f) => frontmatter(readFileSync(join(dir, "graders", f), "utf8")));
    assert.ok(parsed.every((g) => /^type: (llm|tool_used)$/m.test(g)), `${name} graders all have a type`);
    assert.ok(parsed.some((g) => /^type: llm$/m.test(g)), `${name} has an llm grader`);
    const tool = parsed.filter((g) => /^type: tool_used$/m.test(g));
    assert.ok(tool.length >= 1);
    for (const g of tool) {
      assert.match(g, /^tool: \w+$/m);
      assert.match(g, /^input_match: .+$/m);
      assert.match(g, /^max: 0$/m);
    }
    assert.ok(tool.some((g) => /^tool: Bash$/m.test(g) && g.includes(`input_match: '${bashMatch}'`)), `${name}: the Bash grader forbids ${bashMatch}`);
  }
});

test("phase 7d1c: every agent in agents/ is counted everywhere, the guard has four roles, and no document counts the agents any other way", () => {
  const agents = agentNames();
  assert.deepEqual(agents, ["builder", "checker", "model-scout", "shipper"]);
  const words = { 4: "four", 5: "five" };
  const n = words[agents.length];
  assert.ok(n, `no number word for ${agents.length} agents; update this test and every sentence that counts them`);
  const readme = text("README.md");
  const wikiPs = repoText("docs", "wiki", "Phased-shipping.md");
  const wikiGuard = repoText("docs", "wiki", "The-guard.md");
  const security = repoText("SECURITY.md");
  const cursor = repoText(".cursor-plugin", "marketplace.json");
  const libItems = repoText("library.json");
  for (const a of agents) {
    assert.ok(readme.includes(`\`${a}\` (agent)`), `README components table: ${a}`);
    assert.match(readme, new RegExp(`\\| \`${a}\` \\|[^\\n]*\\| \\d+ \\|`), `README agent tables: ${a}`);
    assert.ok(wikiPs.includes(`\`${a}\` ([agent](`), `wiki Phased-shipping components table: ${a}`);
    assert.ok(cursor.includes(a), `the Cursor marketplace description: ${a}`);
    assert.ok(libItems.includes(`plugins/phased-shipping/agents/${a}.md`), `library.json: ${a}`);
  }
  assert.ok(readme.includes(`model pinning and the ${n} agents are Claude Code features`));
  assert.ok(wikiPs.includes(`Model pinning and the ${n} agents are Claude Code features`));
  const roles = repoText("plugins", "phased-shipping", "hooks", "guard-rules.mjs").match(/export const ROLES = \[([^\]]*)\]/)[1].split(",").length;
  assert.equal(words[roles], "four", "the guard has four roles");
  assert.ok(readme.includes(`inside one of the ${n} agents`));
  assert.ok(wikiGuard.includes(`inside one of the ${n} agents`));
  assert.ok(security.includes(`one of its ${n} agents`));
  const wrong = ["one", "two", "three", "four", "five", "six", "1", "2", "3", "4", "5", "6"].filter((w) => w !== n && w !== String(agents.length));
  for (const [file, doc] of [["README", readme], ["wiki Phased-shipping", wikiPs], ["wiki The-guard", wikiGuard], ["SECURITY", security], ["Cursor marketplace", cursor], ["onboard skill", text("skills", "onboard", "SKILL.md")]]) {
    assert.doesNotMatch(doc, new RegExp(`\\b(${wrong.join("|")}) (guarded )?agents\\b`, "i"), `${file} counts the agents wrongly (there are ${agents.length})`);
  }
  // The repo's own agents/ folder is a different thing and keeps its own count.
  assert.ok(repoText(".claude-plugin", "marketplace.json").includes("8 skills and 3 agents"));
  assert.equal(readdirSync(join(REPO, "agents", "claude")).filter((f) => f.endsWith(".md")).length, 3);
});

test("phase 7d1c: the wiki has the Onboarding page with the five feature headings, linked from Home, and the guard page says no rule changed to 0.8.0", () => {
  const page = repoText("docs", "wiki", "Onboarding.md");
  for (const heading of ["## What it is", "## How to use it", "## What shipped when", "## Limits", "## Source"]) assert.ok(new RegExp(`^${heading}$`, "m").test(page), heading);
  assert.ok(repoText("docs", "wiki", "Home.md").includes("(Onboarding)"));
  assert.ok(repoText("scripts", "publish-wiki.mjs").includes('{ page: "Onboarding", title: "Onboarding" }'));
  assert.ok(repoText("docs", "wiki", "The-guard.md").includes("Versions 0.6.0 to 0.8.0 changed no guard rule"));
  assert.ok(page.includes("Plugin version 0.8.0"));
});

test("phase 7d1c fix round 2: the docs say what the survey keeps, who reads the files, and which characters are cleaned, exactly", () => {
  const wiki = repoText("docs", "wiki", "Onboarding.md");
  const readme = text("README.md");
  const skill = text("skills", "onboard", "SKILL.md");
  const ref = text("skills", "onboard", "references", "survey.md");
  const log = text("CHANGELOG.md");
  const entry = log.slice(log.indexOf("## 0.8.0"), log.indexOf("## 0.7.1"));
  for (const [name, doc] of [["wiki Onboarding", wiki], ["README", readme], ["onboard SKILL", skill], ["survey.md", ref], ["CHANGELOG", entry]]) {
    assert.ok(!doc.includes("does not rest on a prompt rule"), `${name}: no claim that the promise needs no prompt rule`);
    assert.ok(!doc.includes("runWords") && !doc.includes("first word of a run line") && !/starting with/.test(doc), `${name}: no run word is kept or described`);
    assert.ok(!doc.includes("no file text"), `${name}: the names in the summary are file text, and the docs say so`);
  }
  assert.ok(wiki.includes("a count of run steps") && wiki.includes("no line of any file"), "the wiki says what a workflow adds");
  for (const [name, doc] of [["wiki Onboarding", wiki], ["README", readme], ["onboard SKILL", skill], ["survey.md", ref]]) {
    assert.ok(doc.includes("workflow") && doc.includes("job names") && doc.includes("package's name") && doc.includes("text from"), `${name}: it names the file text that is kept`);
  }
  const honest = ["not by a lock", "allowed-tools", "pre-approves tools", "the digest", "not that you saw it", "No guard rule enforces either", "should not run onboarding in an assistant session on client material"];
  for (const phrase of honest) assert.ok(wiki.includes(phrase) && readme.includes(phrase), `the wiki and the README both say: ${phrase}`);
  const classes = ["control", "line-separator", "bidirectional", "zero-width", "tag", "format"];
  for (const [name, doc] of [["README", readme], ["survey.md", ref], ["CHANGELOG", entry], ["format.md", repoText("plugins", "phased-shipping", "skills", "roadmap", "references", "format.md")], ["wiki Roadmap-standard", repoText("docs", "wiki", "Roadmap-standard.md")]]) {
    for (const c of classes) assert.ok(doc.includes(c), `${name}: the cleaned character classes include ${c}`);
  }
  assert.ok(/In the survey and in `adopt`, a hard-linked file is skipped and counted/.test(entry), "the CHANGELOG says the hard-link skip covers the survey and adopt");
  assert.ok(repoText("docs", "wiki", "Roadmap-standard.md").includes("more than one hard link"), "the wiki says adopt skips a hard-linked file");
});
