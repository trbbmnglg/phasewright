// Run with: node --test tests/plugin-split-guard.test.mjs
// The guard part of the personal sync (always against a temp home, never the real ~/.claude): the hooks block in the agent copies, the hook scripts, --check,
// --remove, and every refusal.
// This file is one of 2 (plugin-split.test.mjs, plugin-split-guard.test.mjs) that came from one file; the helpers they share are in tests/helpers/plugin-split.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { REPO, tmp, sync, marker, put, read } from "./helpers/plugin-split.mjs";


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
