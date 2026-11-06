// Run with: node --test tests/commands-hash.test.mjs
// Covers plugins/phased-shipping/skills/run/scripts/commands-hash.mjs: the hash of a plan's
// "## Commands" section, and the planned and previewed records that bind an approval to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main, commandsSection, hashOf, planKey, lineDiff } from "../plugins/phased-shipping/skills/run/scripts/commands-hash.mjs";
import { shipCase, recordPreview, checkPreview, git, planText, linkFolder, unlinkLink } from "./helpers/ship.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "plugins", "phased-shipping", "skills", "run", "scripts", "commands-hash.mjs");

// The cases call main(argv, io) in this process, from the folder the real command would have run in (a node process per case is slow
// where this runs). runReal starts the script itself; the tests that say so use it, so the command line and its exit code stay covered.
const runIn = (cwd, ...args) => {
  const startedIn = process.cwd();
  let out = "";
  let err = "";
  try {
    if (cwd !== undefined) process.chdir(cwd);
    const status = main(args, { out: (text) => { out += text; }, err: (text) => { err += text; } });
    return { status, out, err };
  } finally {
    process.chdir(startedIn);
  }
};
const run = (...args) => runIn(undefined, ...args);
const runReal = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

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

// Most tests never remove their folder, so the after hook removes every folder this file made.
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "psp7-")); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
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
  const full = runReal(plan); // a real process: the command line, its output and its exit code
  assert.equal(full.status, 0);
  assert.match(full.out.trim(), /^[0-9a-f]{64}$/);
  assert.equal(full.out.trim(), hashOf(commandsSection(PLAN)));
  assert.equal(run(plan).out, full.out, "the same text in this process");
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
  // node: built-ins, plus the one sibling it shares the tree id with (phase 7r: treeId is reused, not copied)
  for (const m of text.matchAll(/^import .* from "([^"]+)";/gm)) assert.ok(/^node:/.test(m[1]) || m[1] === "./tree-state.mjs", m[1]);
  assert.doesNotMatch(text, /fetch\(|node:https?|node:net|child_process/);
  // Run it from a fresh folder: nothing is written beside the plan.
  const { dir, plan, data } = withPlan(PLAN);
  run(plan, "--record", "planned", "--data", data);
  assert.deepEqual(readdirSync(dir).sort(), ["data", "phase-3-zork.md"]);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- phase 7r: the preview is bound to the code (--root, --roadmap) and to the commit message file ----------
// These run git on a copy of a temp repo (tests/helpers/ship.mjs); the plan, the roadmap and the message file are under a git-ignored .plans.
const SHIP_LINES = ["branch: main", "step: git commit -q -F '.plans/commits/zork-commit.txt'", "check: true", "rollback: true"];

test("phase 7r: --record previewed --root stores the project folder, the tree id and the commit message file's SHA-256", () => {
  const c = shipCase(SHIP_LINES);
  const r = recordPreview(c);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /^recorded previewed [0-9a-f]{12}\n## Commands\n/);
  const saved = JSON.parse(readFileSync(join(c.data, "previews", `${planKey(c.plan)}.previewed.json`), "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["allowed", "at", "hash", "head", "messages", "plan", "root", "text", "tree"]);
  assert.equal(saved.head, git(c.repo, "rev-parse", "HEAD"), "the commit HEAD points at (fix round 2)");
  assert.equal(saved.tree, git(c.repo, "rev-parse", "HEAD^{tree}"), "the ignored .plans folder is not in the tree");
  assert.equal(saved.root.toLowerCase(), realpathSync.native(c.repo).replace(/\\/g, "/").toLowerCase());
  const message = join(c.repo, ".plans", "commits", "zork-commit.txt");
  assert.deepEqual(saved.messages.map((m) => [m.file, m.sha256]), [[".plans/commits/zork-commit.txt", hashOf(readFileSync(message, "utf8"))]]);
  // A message file that can't be read: exit 1 and nothing is recorded.
  rmSync(message);
  rmSync(join(c.data, "previews"), { recursive: true });
  const missing = recordPreview(c);
  assert.equal(missing.status, 1);
  assert.match(missing.err, /can't read the commit message file .plans\/commits\/zork-commit.txt named in the ship block; nothing was recorded/);
  assert.throws(() => readdirSync(join(c.data, "previews")), "nothing was written");
});

test("phase 7r: --check previewed --root passes a plan-only or roadmap-only change and refuses any other changed path, by name", () => {
  const c = shipCase(null);
  // Here the plan and the roadmap are tracked, so they are in the tree and their changes show in the diff.
  const plan = join(c.repo, "docs", "phases", "phase-1-zork.md");
  const roadmap = join(c.repo, "PHASES.md");
  mkdirSync(dirname(plan), { recursive: true });
  writeFileSync(plan, PLAN);
  writeFileSync(roadmap, "# Roadmap\n");
  git(c.repo, "add", "-A");
  git(c.repo, "commit", "-q", "-m", "plan");
  const bind = ["--data", c.data, "--root", c.repo, "--roadmap", roadmap];
  assert.equal(run(plan, "--record", "previewed", ...bind).status, 0);
  writeFileSync(plan, `${PLAN}\n## Phase report\n- built\n`);
  assert.equal(run(plan, "--check", "previewed", ...bind).status, 0, "the plan changed outside its Commands section");
  writeFileSync(roadmap, "# Roadmap\n| 1 | zork | shipped |\n");
  const both = run(plan, "--check", "previewed", ...bind);
  assert.equal(both.status, 0, both.out + both.err);
  assert.match(both.out, /^match [0-9a-f]{12}\n## Commands\n/);
  mkdirSync(join(c.repo, "src"));
  writeFileSync(join(c.repo, "src", "zork.js"), "export {};\n");
  writeFileSync(join(c.repo, "a.txt"), "alpha changed\n");
  const other = run(plan, "--check", "previewed", ...bind);
  assert.equal(other.status, 3);
  assert.ok(other.out.startsWith("the code changed since it was previewed (only the plan and the roadmap may change); changed paths:\n"), other.out);
  assert.deepEqual(other.out.trim().split("\n").slice(1).sort(), ["  a.txt", "  src/zork.js"]);
  assert.doesNotMatch(other.out, /^match /m);
  // Without --roadmap, the roadmap is not an allowed difference.
  rmSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, "a.txt"), "alpha\n");
  const noRoadmap = run(plan, "--check", "previewed", "--data", c.data, "--root", c.repo);
  assert.equal(noRoadmap.status, 3);
  assert.match(noRoadmap.out, /^ {2}PHASES\.md$/m);
});

test("phase 7r: a changed -F message file is refused, and so is an old record with --root, another project folder, or a lost tree", () => {
  const c = shipCase(SHIP_LINES);
  assert.equal(recordPreview(c).status, 0);
  assert.equal(checkPreview(c).status, 0);
  const message = join(c.repo, ".plans", "commits", "zork-commit.txt");
  writeFileSync(message, "Ship zork\n\nAn edited message.\n");
  const changed = checkPreview(c);
  assert.equal(changed.status, 3);
  assert.equal(changed.out, "the commit message file changed since it was previewed: .plans/commits/zork-commit.txt\n");
  // An old record (no tree) with --root: refused. Without --root it is the commands-only check, as before.
  const old = shipCase(SHIP_LINES);
  assert.equal(recordPreview(old, { root: false }).status, 0);
  const refused = checkPreview(old);
  assert.equal(refused.status, 3);
  assert.equal(refused.out, "the previewed record holds no tree id, so the code can't be checked: preview again\n");
  // Another project folder than the one previewed.
  const elsewhere = checkPreview(c, ["--root", old.repo, "--roadmap", old.roadmap]);
  assert.equal(elsewhere.status, 3);
  assert.match(elsewhere.out, /the project folder is not the one that was previewed/);
  // A stored tree whose objects are gone: refused, preview again.
  const key = join(c.data, "previews", `${planKey(c.plan)}.previewed.json`);
  writeFileSync(message, "Ship zork\n\nShips the zork change.\n");
  const saved = JSON.parse(readFileSync(key, "utf8"));
  writeFileSync(key, JSON.stringify({ ...saved, tree: "0123456789abcdef0123456789abcdef01234567" }));
  const lost = checkPreview(c);
  assert.equal(lost.status, 3);
  assert.match(lost.out, /can't be compared with the current one/);
});

test("phase 7r: without --root the check is unchanged (old and new records, code changes unseen); --root and --roadmap need their stage", () => {
  const c = shipCase(SHIP_LINES);
  assert.equal(recordPreview(c).status, 0, "a record with a tree");
  writeFileSync(join(c.repo, "a.txt"), "alpha changed\n");
  const plain = checkPreview(c, []);
  assert.equal(plain.status, 0, "the commands-only check does not look at the code");
  assert.match(plain.out, /^match [0-9a-f]{12}\n/);
  assert.equal(checkPreview(c).status, 3, "the same record with --root sees the change");
  for (const args of [[c.plan, "--record", "planned", "--data", c.data, "--root", c.repo], [c.plan, "--check", "planned", "--data", c.data, "--root", c.repo],
    [c.plan, "--check", "previewed", "--data", c.data, "--roadmap", c.roadmap], [c.plan, "--root", c.repo], [c.plan, "--check", "previewed", "--data", c.data, "--root"]]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.doesNotMatch(r.out, /^match /m);
  }
});

// ---------- phase 7r, fix round 1: the paths that may change are fixed at the preview; message files and the record's own text ----------
test("fix round 1 (7r), M1: --record previewed --root stores and prints the paths that may change; a roadmap not named PHASES.md, a plan not shaped like a plan file, a path outside the project folder and a link to one are refused, and nothing is recorded", () => {
  const c = shipCase(SHIP_LINES);
  const r = recordPreview(c);
  assert.equal(r.status, 0, r.out + r.err);
  const previews = join(c.data, "previews");
  const saved = JSON.parse(readFileSync(join(previews, `${planKey(c.plan)}.previewed.json`), "utf8"));
  assert.deepEqual(saved.allowed, { plan: ".plans/phases/phase-1-zork.md", roadmap: ".plans/PHASES.md" });
  assert.match(r.out, /^recorded previewed [0-9a-f]{12}\n## Commands\n/);
  assert.match(r.out, /\ncode bound to the tree [0-9a-f]{12}; only these may change: \.plans\/phases\/phase-1-zork\.md, \.plans\/PHASES\.md\n$/);
  const refused = (plan, extra, why) => {
    rmSync(previews, { recursive: true, force: true });
    const x = recordPreview({ ...c, plan }, { extra });
    assert.equal(x.status, 1, `${why}: ${x.out}${x.err}`);
    assert.match(x.err, why);
    assert.match(x.err, /nothing was recorded/);
    assert.doesNotMatch(x.out, /^recorded /m);
    assert.throws(() => readdirSync(previews), "nothing was written");
  };
  refused(c.plan, ["--root", c.repo, "--roadmap", join(c.repo, "a.txt")], /the roadmap's file name is not PHASES\.md/);
  const odd = join(c.repo, ".plans", "zork.md");
  writeFileSync(odd, planText(SHIP_LINES.slice(1)));
  refused(odd, ["--root", c.repo, "--roadmap", c.roadmap], /the plan is not a phase-\*\.md file in a folder named phases/);
  writeFileSync(c.at("PHASES.md"), "# Roadmap\n");
  refused(c.plan, ["--root", c.repo, "--roadmap", c.at("PHASES.md")], /the roadmap is not inside the project folder/);
  // A folder link on the way that leads outside the project folder.
  mkdirSync(c.at(join("outside", "phases")), { recursive: true });
  writeFileSync(c.at(join("outside", "phases", "phase-1-zork.md")), planText(SHIP_LINES.slice(1)));
  linkFolder(c.at("outside"), join(c.repo, ".plans", "linked"));
  refused(join(c.repo, ".plans", "linked", "phases", "phase-1-zork.md"), ["--root", c.repo, "--roadmap", c.roadmap], /the plan is not inside the project folder/);
  unlinkLink(join(c.repo, ".plans", "linked"));
  // A plan or roadmap that is itself a link, where this machine can make one (file links need a privilege on Windows).
  const roadmapLink = join(c.repo, ".plans", "other", "PHASES.md");
  mkdirSync(dirname(roadmapLink), { recursive: true });
  let linked = true;
  try { symlinkSync(c.roadmap, roadmapLink); } catch { linked = false; }
  if (linked) refused(c.plan, ["--root", c.repo, "--roadmap", roadmapLink], /the roadmap is a link/);
});

test("fix round 1 (7r), M1: --check previewed --root takes the paths that may change from the record: a --roadmap or plan given now that is not the previewed one exits 3, and so does a record without them", () => {
  const c = shipCase(SHIP_LINES);
  assert.equal(recordPreview(c).status, 0);
  writeFileSync(join(c.repo, "a.txt"), "alpha changed\n");
  for (const roadmap of [join(c.repo, "a.txt"), join(c.repo, "docs", "PHASES.md")]) {
    mkdirSync(join(c.repo, "docs"), { recursive: true });
    writeFileSync(join(c.repo, "docs", "PHASES.md"), "# Roadmap\n");
    const r = checkPreview(c, ["--root", c.repo, "--roadmap", roadmap]);
    assert.equal(r.status, 3, r.out + r.err);
    assert.match(r.out, /the roadmap given now is not the previewed one \(\.plans\/PHASES\.md\): preview again/);
    assert.doesNotMatch(r.out, /^match /m);
  }
  rmSync(join(c.repo, "docs"), { recursive: true });
  writeFileSync(join(c.repo, "a.txt"), "alpha\n");
  assert.equal(checkPreview(c).status, 0, "the previewed roadmap still passes");
  // A record from before this check (no allowed paths): preview again.
  const key = join(c.data, "previews", `${planKey(c.plan)}.previewed.json`);
  const saved = JSON.parse(readFileSync(key, "utf8"));
  delete saved.allowed;
  writeFileSync(key, JSON.stringify(saved));
  const old = checkPreview(c);
  assert.equal(old.status, 3);
  assert.equal(old.out, "the previewed record holds no list of the paths that may change (it was made before that check): preview again\n");
});

test("fix round 1 (7r), L4: a commit message file is resolved again before it is hashed: a folder on its way re-pointed to another folder exits 3, even with the same bytes there", () => {
  const c = shipCase(SHIP_LINES);
  const commits = join(c.repo, ".plans", "commits");
  rmSync(commits, { recursive: true, force: true });
  for (const name of ["msg-a", "msg-b"]) {
    mkdirSync(c.at(name));
    writeFileSync(join(c.at(name), "zork-commit.txt"), "Ship zork\n");
  }
  writeFileSync(join(c.at("msg-b"), "zork-commit.txt"), "An unseen message\n");
  linkFolder(c.at("msg-a"), commits);
  assert.equal(recordPreview(c).status, 0);
  assert.equal(checkPreview(c).status, 0);
  unlinkLink(commits);
  linkFolder(c.at("msg-b"), commits);
  const moved = checkPreview(c);
  assert.equal(moved.status, 3, moved.out);
  assert.equal(moved.out, "the commit message file is not at its previewed real path (a folder on its way changed): .plans/commits/zork-commit.txt\n");
  writeFileSync(join(c.at("msg-b"), "zork-commit.txt"), "Ship zork\n");
  assert.equal(checkPreview(c).status, 3, "the path decides before the hash");
  unlinkLink(commits);
});

test("fix round 1 (7r), L5: a record whose text was edited without its hash is refused (exit 4), with or without --root", () => {
  const c = shipCase(SHIP_LINES);
  assert.equal(recordPreview(c).status, 0);
  const key = join(c.data, "previews", `${planKey(c.plan)}.previewed.json`);
  const saved = JSON.parse(readFileSync(key, "utf8"));
  writeFileSync(key, JSON.stringify({ ...saved, text: saved.text.replace("check: true", "check: true\nstep: echo zork-added") }));
  for (const extra of [[], ["--root", c.repo, "--roadmap", c.roadmap]]) {
    const r = checkPreview(c, extra);
    assert.equal(r.status, 4, r.out);
    assert.equal(r.out, "the previewed record's text does not match its hash (the record was edited): record it again\n");
  }
});
