// Run with: node --test tests/commands-hash.test.mjs
// Covers plugins/phased-shipping/skills/run/scripts/commands-hash.mjs: the hash of a plan's
// "## Commands" section, and the planned and previewed records that bind an approval to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { commandsSection, hashOf, planKey, lineDiff } from "../plugins/phased-shipping/skills/run/scripts/commands-hash.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "plugins", "phased-shipping", "skills", "run", "scripts", "commands-hash.mjs");

const runIn = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const run = (...args) => runIn(undefined, ...args);

const PLAN = [
  "# Phase 3: zork",
  "**Timestamps:** started 2026-01-01T00:00:00Z",
  "",
  "## Commands",
  "- **Verify:** `npm run verify`",
  "- **Deploy:**",
  "  1. `git push origin main`",
  "- **Rollback:** `git revert --no-edit HEAD`",
  "",
  "## Risks",
  "- slow",
  "",
].join("\n");

const scratch = () => mkdtempSync(join(tmpdir(), "psp7-"));
const withPlan = (text, name = "phase-3-zork.md") => {
  const dir = scratch();
  const plan = join(dir, name);
  writeFileSync(plan, text);
  return { dir, plan, data: join(dir, "data") };
};

test("the same section gives the same hash, whatever the line endings or trailing spaces", () => {
  const a = hashOf(commandsSection(PLAN));
  assert.equal(hashOf(commandsSection(PLAN)), a);
  assert.equal(hashOf(commandsSection(PLAN.replace(/\n/g, "\r\n"))), a, "CRLF");
  assert.equal(hashOf(commandsSection(PLAN.replace(/`\n/g, "`   \n"))), a, "trailing spaces");
  assert.equal(hashOf(commandsSection(PLAN.replace("\n## Risks", "\n\n\n## Risks"))), a, "trailing blank lines");
  assert.equal(hashOf(commandsSection(PLAN + "\n\n")), a);
});

test("one changed character in a command changes the hash; a change outside the section does not", () => {
  const a = hashOf(commandsSection(PLAN));
  assert.notEqual(hashOf(commandsSection(PLAN.replace("origin main", "origin mains"))), a);
  assert.notEqual(hashOf(commandsSection(PLAN.replace("npm run verify", "npm run verify "))), hashOf(commandsSection(PLAN.replace("npm run verify", "npm run  verify"))));
  assert.equal(hashOf(commandsSection(PLAN.replace("- slow", "- slower, and more"))), a, "Risks");
  assert.equal(hashOf(commandsSection(PLAN.replace("2026-01-01", "2027-02-02"))), a, "Timestamps");
  assert.equal(hashOf(commandsSection(`${PLAN}\n## Close steps\n- more\n`)), a, "a later section");
});

test("the section ends at the next heading, and a heading inside a code fence doesn't count", () => {
  const fenced = PLAN.replace("- **Deploy:**", "- **Deploy:**\n```\n## not a heading\n```");
  assert.match(commandsSection(fenced), /not a heading/);
  assert.match(commandsSection(fenced), /git revert/);
  assert.doesNotMatch(commandsSection(PLAN), /slow/);
  assert.equal(commandsSection("# x\n## Commandsx\n- a\n"), null);
  assert.equal(commandsSection("# x\n## Risks\n- a\n"), null);
});

test("no ## Commands section: exit 2", () => {
  const { plan } = withPlan("# Phase\n## Risks\n- a\n");
  const r = run(plan);
  assert.equal(r.status, 2);
  assert.match(r.err, /no "## Commands" section/);
  assert.equal(run(plan, "--short").status, 2);
});

test("prints the full hash, or 12 hex characters with --short", () => {
  const { plan } = withPlan(PLAN);
  const full = run(plan);
  assert.equal(full.status, 0);
  assert.match(full.out.trim(), /^[0-9a-f]{64}$/);
  assert.equal(full.out.trim(), hashOf(commandsSection(PLAN)));
  const short = run(plan, "--short");
  assert.match(short.out.trim(), /^[0-9a-f]{12}$/);
  assert.equal(short.out.trim(), full.out.trim().slice(0, 12));
});

test("--record then --check: exit 0 on a match", () => {
  const { plan, data } = withPlan(PLAN);
  const rec = run(plan, "--record", "planned", "--data", data);
  assert.equal(rec.status, 0, rec.err);
  assert.match(rec.out, /^recorded planned [0-9a-f]{12}\n## Commands\n/);
  const check = run(plan, "--check", "planned", "--data", data);
  assert.equal(check.status, 0);
  assert.match(check.out, /^match [0-9a-f]{12}/);
  // The record holds hash, text, plan and at, under <data>/previews/.
  const files = readdirSync(join(data, "previews"));
  assert.deepEqual(files, [`${planKey(plan)}.planned.json`]);
  const saved = JSON.parse(readFileSync(join(data, "previews", files[0]), "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["at", "hash", "plan", "text"]);
  assert.equal(saved.hash, hashOf(commandsSection(PLAN)));
  assert.equal(saved.text, commandsSection(PLAN));
  assert.ok(!Number.isNaN(Date.parse(saved.at)));
});

test("editing a command then --check: exit 3 and a diff that names the changed line", () => {
  const { plan, data } = withPlan(PLAN);
  assert.equal(run(plan, "--record", "previewed", "--data", data).status, 0);
  writeFileSync(plan, PLAN.replace("git push origin main", "git push origin zork"));
  const r = run(plan, "--check", "previewed", "--data", data);
  assert.equal(r.status, 3);
  assert.match(r.out, /^- {3}1\. `git push origin main`$/m);
  assert.match(r.out, /^\+ {3}1\. `git push origin zork`$/m);
  assert.doesNotMatch(r.out, /npm run verify/, "unchanged lines aren't listed");
  // Recording again (a fresh preview) makes the new commands the ones that match.
  assert.equal(run(plan, "--record", "previewed", "--data", data).status, 0);
  assert.equal(run(plan, "--check", "previewed", "--data", data).status, 0);
});

test("--check with no record exits 4, and the two stages are kept apart", () => {
  const { plan, data } = withPlan(PLAN);
  assert.equal(run(plan, "--check", "planned", "--data", data).status, 4);
  assert.equal(run(plan, "--record", "planned", "--data", data).status, 0);
  assert.equal(run(plan, "--check", "planned", "--data", data).status, 0);
  assert.equal(run(plan, "--check", "previewed", "--data", data).status, 4);
  // An unreadable record counts as no record.
  writeFileSync(join(data, "previews", `${planKey(plan)}.previewed.json`), "not json");
  assert.equal(run(plan, "--check", "previewed", "--data", data).status, 4);
});

test("the key differs for two plan files with the same name in different folders", () => {
  const one = withPlan(PLAN);
  const two = withPlan(PLAN);
  assert.notEqual(planKey(one.plan), planKey(two.plan));
  assert.match(planKey(one.plan), /^[0-9a-f]{12}$/);
  // One shared data folder: recording one plan doesn't satisfy the check for the other.
  const data = scratch();
  assert.equal(run(one.plan, "--record", "previewed", "--data", data).status, 0);
  assert.equal(run(one.plan, "--check", "previewed", "--data", data).status, 0);
  assert.equal(run(two.plan, "--check", "previewed", "--data", data).status, 4);
});

test("the key ignores case and slash direction of the path", () => {
  const { plan } = withPlan(PLAN);
  assert.equal(planKey(plan.replace(/\\/g, "/")), planKey(plan.replace(/\\/g, "/")));
  // Only a case-insensitive file system resolves an upper-cased path to the same file.
  if (process.platform === "win32") assert.equal(planKey(plan.replace(/\\/g, "/")), planKey(plan.toUpperCase()));
});

test("fix round 1, L9: a relative and an absolute path to the same file share a key; the same name in two folders differs", () => {
  const { dir, plan, data } = withPlan(PLAN);
  const name = "phase-3-zork.md";
  assert.equal(planKey(join(dir, name)), planKey(join(dir, ".", name)));
  assert.equal(planKey(join(dir, "data", "..", name)), planKey(plan));
  // Record by the absolute path, check from inside the folder by the relative one.
  assert.equal(run(plan, "--record", "previewed", "--data", data).status, 0);
  const rel = runIn(dir, name, "--check", "previewed", "--data", data);
  assert.equal(rel.status, 0, rel.out + rel.err);
  assert.match(rel.out, /^match [0-9a-f]{12}\n/);
  const other = withPlan(PLAN);
  assert.notEqual(planKey(other.plan), planKey(plan));
  assert.equal(runIn(other.dir, name, "--check", "previewed", "--data", data).status, 4, "the same file name in another folder has no record");
  // The record names the real path, and the plan must exist to be keyed.
  const saved = JSON.parse(readFileSync(join(data, "previews", `${planKey(plan)}.previewed.json`), "utf8"));
  assert.equal(saved.plan.toLowerCase(), realpathSync.native(plan).replace(/\\/g, "/").toLowerCase());
  assert.throws(() => planKey(join(dir, "missing.md")));
  assert.equal(run(join(dir, "missing.md"), "--record", "planned", "--data", data).status, 1);
});

test("usage errors exit 1 and write nothing", () => {
  const { plan, data } = withPlan(PLAN);
  assert.equal(run().status, 1);
  assert.equal(run(plan, "--record", "planned").status, 1, "no --data");
  assert.equal(run(plan, "--record", "approved", "--data", data).status, 1, "unknown stage");
  assert.equal(run(plan, "--check", "--data", data).status, 1, "missing stage");
  assert.equal(run(plan, "--zork").status, 1);
  assert.equal(run(join(data, "missing.md")).status, 1);
  assert.throws(() => readdirSync(data), "nothing was created");
});

test("fix round 1, H1: --record and --check print the normalized section after the status line", () => {
  const { plan, data } = withPlan(PLAN.replace(/\n/g, "\r\n").replace("`npm run verify`", "`npm run verify`   "));
  const section = commandsSection(PLAN);
  const short = hashOf(section).slice(0, 12);
  const rec = run(plan, "--record", "previewed", "--data", data);
  assert.equal(rec.status, 0, rec.err);
  assert.equal(rec.out, `recorded previewed ${short}\n${section}\n`);
  const check = run(plan, "--check", "previewed", "--data", data);
  assert.equal(check.status, 0);
  assert.equal(check.out, `match ${short}\n${section}\n`);
  assert.ok(check.out.includes("git push origin main") && check.out.includes("git revert --no-edit HEAD"), "deploy and rollback commands are in the output");
  assert.doesNotMatch(check.out, /slow|\r| +\n/, "nothing from outside the section, no CR, no trailing spaces");
  // A mismatch keeps the diff output and doesn't print the full section.
  writeFileSync(plan, PLAN.replace("git push origin main", "git push origin zork"));
  const bad = run(plan, "--check", "previewed", "--data", data);
  assert.equal(bad.status, 3);
  assert.match(bad.out, /^the Commands section changed since it was previewed/);
  assert.doesNotMatch(bad.out, /^match /m);
  assert.doesNotMatch(bad.out, /npm run verify/);
});

test("fix round 1, L1: two Commands headings, or one that isn't exactly '## Commands', exit 2", () => {
  const second = PLAN.replace("## Risks", "## Commands\n- `rm -rf zork`\n\n## Risks");
  assert.throws(() => commandsSection(second), /2 headings look like "Commands"/);
  const updated = PLAN.replace("## Commands", "## Commands (updated)");
  assert.throws(() => commandsSection(updated), /isn't exactly "## Commands"/);
  for (const h of ["### Commands", "# Commands", "## commands", "##  Commands:"]) assert.throws(() => commandsSection(PLAN.replace("## Commands", h)), /Commands/, h);
  for (const [name, text] of [["second section", second], ["Commands (updated)", updated]]) {
    const { plan, data } = withPlan(text);
    for (const args of [[], ["--short"], ["--record", "previewed", "--data", data], ["--check", "previewed", "--data", data]]) {
      const r = run(plan, ...args);
      assert.equal(r.status, 2, `${name} ${args[0] ?? ""}: ${r.err}`);
      assert.match(r.err, /ambiguous Commands heading/);
      assert.equal(r.out, "", "prints no hash");
    }
    assert.throws(() => readdirSync(data), "nothing was recorded");
  }
  // A heading inside a code fence and a different word don't count; the plain plan is still fine.
  assert.equal(typeof commandsSection(PLAN.replace("- **Deploy:**", "- **Deploy:**\n```\n## Commands\n```")), "string");
  assert.throws(() => commandsSection(PLAN.replace("## Risks", "## Commands hash notes")), /2 headings/, "another heading that starts with the word Commands is ambiguous");
  assert.equal(commandsSection(PLAN.replace("## Risks", "## Commandsx")), commandsSection(PLAN), "a different word is not");
});

test("fix round 1, L2: --record, --check or --data with no value exits 1 and never prints the hash", () => {
  const { plan, data } = withPlan(PLAN);
  for (const args of [["--record"], ["--check"], ["--data"], ["--record", "planned", "--data"], ["--data", data, "--check"], ["--short", "--record"], ["--record", "--data", data], ["--check", "--data", data]]) {
    const r = run(plan, ...args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.out}`);
    assert.doesNotMatch(r.out, /[0-9a-f]{12}/, "no hash printed");
  }
  assert.throws(() => readdirSync(data), "nothing was created");
});

test("fix round 2, L6: an option whose value starts with -- exits 1 with a message and creates no folder", () => {
  const { dir, plan, data } = withPlan(PLAN);
  for (const args of [["--record", "previewed", "--data", "--short"], ["--record", "--short", "--data", data], ["--check", "--data", "--data", data], ["--data", "--record", "planned"]]) {
    const r = run(plan, ...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.err, /needs a value/, args.join(" "));
    assert.doesNotMatch(r.out, /[0-9a-f]{12}/, "no hash printed");
  }
  assert.deepEqual(readdirSync(dir).sort(), ["phase-3-zork.md"], "no data folder, and no folder named --short either");
  rmSync(dir, { recursive: true, force: true });
});

test("lineDiff lists only removed and added lines", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nc"), ["- b"]);
  assert.deepEqual(lineDiff("a\nb", "a\nb\nc"), ["+ c"]);
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), ["- b", "+ x"]);
  assert.deepEqual(lineDiff("a", "a"), []);
});

test("the script imports only node: built-ins and writes only under --data", () => {
  const text = readFileSync(SCRIPT, "utf8");
  for (const m of text.matchAll(/^import .* from "([^"]+)";/gm)) assert.match(m[1], /^node:/, m[1]);
  assert.doesNotMatch(text, /fetch\(|node:https?|node:net|child_process/);
  // Run it from a fresh folder: nothing is written beside the plan.
  const { dir, plan, data } = withPlan(PLAN);
  run(plan, "--record", "planned", "--data", data);
  assert.deepEqual(readdirSync(dir).sort(), ["data", "phase-3-zork.md"]);
  rmSync(dir, { recursive: true, force: true });
});
