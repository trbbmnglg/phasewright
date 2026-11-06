// Run with: node --test tests/ship.test.mjs
// Covers plugins/phased-shipping/skills/run/scripts/ship.mjs and the ship block parser in commands-hash.mjs, in this process
// (tests/helpers/ship.mjs). The cases about the binding record a real preview on a copy of a temp git repo. The others inject the binding,
// git and a scripted spawn that runs nothing and appends each command to a sentinel log (ran.log), so "nothing ran" is an empty log; a case
// that needs a step to change the repository gives the scripted spawn an effect, which runs real git. A few cases run the real bash: the log
// tail, a real timeout and a hook that must still run. The real-process smoke is tests/ship-process.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { shipBlock, messageFiles, commandsSection, hashOf, planKey } from "../plugins/phased-shipping/skills/run/scripts/commands-hash.mjs";
import { main, safetyFiles, loadSafety, findBash, logTail, stagedSecrets, commandEnv, PERSONAL_MARKER, WITHHELD, TIMEOUT_EXIT } from "../plugins/phased-shipping/skills/run/scripts/ship.mjs";
import { secretShapeIn, SECRET_SHAPES } from "../plugins/phased-shipping/skills/onboard/scripts/survey.mjs";
import { DANGEROUS_ENV } from "../plugins/phased-shipping/hooks/guard-rules.mjs";
import { cleanEnv } from "./helpers/tree-state.mjs";
import { shipCase, fakeCase, fakeIo, fakeGit, fakeMessage, realBindIo, recordPreview, ship, scratch, git, linkFolder, unlinkLink, FAKE_TOKEN, COMMIT, MESSAGE_REL } from "./helpers/ship.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PS = join(HERE, "..", "plugins", "phased-shipping");
const SCRIPT = join(PS, "skills", "run", "scripts", "ship.mjs");
const REPORT = /^(step|check|rollback) \d+ exit \d+ seconds \d+$/;
const block = (...lines) => ["branch: main", ...lines];
const ch = (n) => String.fromCodePoint(n);
// A case whose real preview is recorded (git runs); the record must succeed.
const recorded = (shipLines) => {
  const c = shipCase(shipLines);
  const r = recordPreview(c);
  assert.equal(r.status, 0, r.out + r.err);
  return c;
};
// A case with everything injected: ship it and return { status, out, ran, spawned }.
const fakeShip = async (shipLines, opts = {}) => {
  const c = fakeCase(shipLines);
  const { io, spawned } = fakeIo(c, opts);
  const r = await ship(c, io);
  return { ...r, ran: c.ran(), spawned, c };
};
const remoteMain = (c) => git(c.base, "--git-dir=remote.git", "rev-parse", "main");

// ---------- the ship block ----------
const VALID = ["branch: main", "step: git push origin main", "check: test -z \"$(git status --short)\"", "rollback: git revert --no-edit HEAD"];
const section = (blockLines, fence = "```ship") => commandsSection(`# x\n\n## Commands\n- a\n\n${fence}\n${blockLines.join("\n")}\n\`\`\`\n`);

test("ship block: a valid block parses with its defaults, in order, and a section without one gives null", () => {
  const b = shipBlock(section([...VALID, "step: git commit -F '.plans/commits/x.txt'", "", "timeout: 60"]));
  assert.equal(b.branch, "main");
  assert.deepEqual(b.steps, ["git push origin main", "git commit -F '.plans/commits/x.txt'"]);
  assert.deepEqual(b.checks, ["test -z \"$(git status --short)\""]);
  assert.deepEqual(b.rollbacks, ["git revert --no-edit HEAD"]);
  assert.equal(b.timeout, 60);
  assert.deepEqual(b.messages, [".plans/commits/x.txt"]);
  assert.deepEqual(b.commits, [null, { file: ".plans/commits/x.txt" }], "the strict commit steps, parallel to the steps");
  assert.equal(shipBlock(section(VALID)).timeout, 900, "default timeout");
  assert.equal(shipBlock(commandsSection("# x\n\n## Commands\n- `npm test`\n")), null);
  assert.equal(shipBlock(section(VALID, "```text")), null, "another info string is not a ship block");
  assert.equal(shipBlock(section(VALID, "```shipping")), null);
});

const INVALID = {
  "an unknown key": [...VALID, "deploy: x"],
  "a key in another case": [...VALID, "Step: x"],
  "a line that is not key: value": [...VALID, "git push"],
  "an empty value": [...VALID, "check:"],
  "an empty block": [],
  "a blank-only block": ["", "  "],
  "no step": VALID.filter((l) => !l.startsWith("step")),
  "no check": VALID.filter((l) => !l.startsWith("check")),
  "no rollback": VALID.filter((l) => !l.startsWith("rollback")),
  "no branch": VALID.filter((l) => !l.startsWith("branch")),
  "two branches": [...VALID, "branch: dev"],
  "a branch that is not a plain name": ["branch: main..x", ...VALID.slice(1)],
  "a timeout of 0": [...VALID, "timeout: 0"],
  "a timeout over 1800": [...VALID, "timeout: 1801"],
  "a timeout that is not a whole number": [...VALID, "timeout: 1.5"],
  "two timeouts": [...VALID, "timeout: 10", "timeout: 20"],
  "a commit -F value that expands": [...VALID, "step: git commit -F \"$MSG\""],
  "a commit -F value from stdin": [...VALID, "step: git commit -F -"],
  "a rollback that commits": [...VALID, "rollback: git commit -F m.txt"],
  "a check that commits": [...VALID, "check: git add -A && git commit -F m.txt"],
};

test("ship block: every invalid shape throws a ship error", () => {
  for (const [name, blockLines] of Object.entries(INVALID)) {
    assert.throws(() => shipBlock(section(blockLines)), (e) => e.code === "ship", name);
  }
  const two = commandsSection(`# x\n\n## Commands\n\n\`\`\`ship\n${VALID.join("\n")}\n\`\`\`\n\n\`\`\`ship\n${VALID.join("\n")}\n\`\`\`\n`);
  assert.throws(() => shipBlock(two), /2 ship blocks/);
  assert.throws(() => shipBlock(section(VALID, "```ship yaml")), /exactly "ship"/);
  assert.throws(() => shipBlock(section(VALID, "  ```ship")), /beginning of the line/);
  assert.throws(() => shipBlock(commandsSection(`# x\n\n## Commands\n\n\`\`\`ship\n${VALID.join("\n")}\n`)), /never closed/);
});

test("ship block: messageFiles reads -F, a flag cluster, --file and --file=, quoted or bare, and refuses any other commit form", () => {
  assert.deepEqual(messageFiles(["git commit -F '.plans/commits/a b.txt'", "git commit -qF \"m.txt\"", "git commit --file=x.txt", "git commit --file y.txt", "git commit -Fz.txt",
    "git commit -q -s --no-edit -F w.txt", "git commit --quiet --signoff --file 'v.txt'", "git push origin main", "npm test"]), [".plans/commits/a b.txt", "m.txt", "x.txt", "y.txt", "z.txt", "w.txt", "v.txt"]);
  assert.throws(() => messageFiles(["git commit -m zork && git push -F x"]), (e) => e.code === "ship", "a -m message and a second command");
  assert.throws(() => messageFiles(["echo git commit -F no.txt"]), (e) => e.code === "ship", "the word commit in any other command");
});

test("ship block: each invalid shape exits 2 from ship.mjs, and nothing ran", async () => {
  for (const [name, blockLines] of [...Object.entries(INVALID), ["no block at all", null]]) {
    const r = await fakeShip(blockLines);
    assert.equal(r.status, 2, `${name}: ${r.out}`);
    assert.match(r.out, /nothing ran: the (ship block is invalid|previewed Commands section has no ship block)/, name);
    assert.deepEqual(r.ran, [], name);
  }
});

test("ship block: the block is read from the recorded text, not from the plan file", async () => {
  const c = fakeCase(block("step: echo from-file", "check: true", "rollback: true"));
  const { io } = fakeIo(c);
  const bound = io.bind();
  // The binding's recorded text holds another step than the plan file: that one runs.
  io.bind = () => ({ ...bound, saved: { ...bound.saved, text: bound.saved.text.replace("echo from-file", "echo from-record") } });
  const r = await ship(c, io);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(c.ran(), ["echo from-record", "true"]);
});

// ---------- the binding (real git) ----------
test("exit 3: a command changed after the preview, and nothing ran", async () => {
  const c = recorded(block("step: echo zork-ran", "check: true", "rollback: true"));
  writeFileSync(c.plan, readFileSync(c.plan, "utf8").replace("echo zork-ran", "echo zork-changed"));
  const { io, spawned } = realBindIo(c);
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /the Commands section changed since it was previewed/);
  assert.equal(spawned.calls.length, 0);
});

test("exit 3: the code changed after the preview (the path is named), and nothing ran; the plan and the roadmap may change", async () => {
  const c = recorded(block("step: echo zork-ran", "check: true", "rollback: true"));
  writeFileSync(c.roadmap, "# Roadmap\n| 1 | zork | in progress |\n");
  writeFileSync(c.plan, `${readFileSync(c.plan, "utf8")}\n## Phase report\n- built\n`);
  writeFileSync(join(c.repo, "a.txt"), "alpha changed\n");
  const { io, spawned } = realBindIo(c);
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /the code changed since it was previewed/);
  assert.match(r.out, /^ {2}a\.txt$/m);
  assert.equal(spawned.calls.length, 0);
});

test("exit 3: a record without a tree (an old preview) is refused, and nothing ran", async () => {
  const c = shipCase(block("step: echo zork-ran", "check: true", "rollback: true"));
  assert.equal(recordPreview(c, { root: false }).status, 0);
  const { io, spawned } = fakeIo(c);
  delete io.bind;
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /holds no tree id/);
  assert.equal(spawned.calls.length, 0);
});

test("exit 3 during the run: a commit message file that changed after the binding is never committed", async () => {
  const c = recorded(block("step: echo zork-edit", `step: ${COMMIT}`, "check: true", "rollback: true"));
  const message = join(c.repo, ".plans", "commits", "zork-commit.txt");
  const { io, spawned } = realBindIo(c, { effects: { "echo zork-edit": () => writeFileSync(message, "changed\n") } });
  const head = git(c.repo, "rev-parse", "HEAD");
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /step 2 was not run, so nothing was committed: the commit message file \.plans\/commits\/zork-commit\.txt changed during the run/);
  assert.match(r.out, /1 step ran \(what it did stays done\); HEAD is still [0-9a-f]{40}, so this run made no commit \(exit 3\)/);
  assert.deepEqual(spawned.calls.map((x) => x.command), ["echo zork-edit"], "the commit step never ran");
  assert.equal(git(c.repo, "rev-parse", "HEAD"), head);
});

test("the script never writes the plan, the roadmap or the data folder", async () => {
  const c = recorded(block("step: true", "check: true", "rollback: true"));
  const snapshot = () => [readFileSync(c.plan, "utf8"), readFileSync(c.roadmap, "utf8"), readdirSync(c.data, { recursive: true }).join(), readdirSync(join(c.data, "previews")).map((f) => readFileSync(join(c.data, "previews", f), "utf8")).join()];
  const before = snapshot();
  const { io } = realBindIo(c);
  assert.equal((await ship(c, io)).status, 0);
  assert.deepEqual(snapshot(), before);
});

// ---------- ship.mjs exit codes (the binding, git and the spawn injected) ----------
test("exit 0: every step and check passes; the report lines, the commit, the Commands hash and the total seconds", async () => {
  const r = await fakeShip(block("step: echo zork-step-1", "step: echo zork-step-2", "check: echo zork-check-1", "rollback: echo zork-rollback"), { git: fakeGit({ head: "abc123".padEnd(40, "9") }) });
  assert.equal(r.status, 0, r.out);
  const out = r.out.split("\n");
  assert.deepEqual(out.filter((l) => REPORT.test(l)), ["step 1 exit 0 seconds 0", "step 2 exit 0 seconds 0", "check 1 exit 0 seconds 0"]);
  assert.ok(out.includes(`shipped ${"abc123".padEnd(40, "9")}`));
  assert.ok(out.includes(`Commands hash: ${hashOf(commandsSection(readFileSync(r.c.plan, "utf8"))).slice(0, 12)}`));
  assert.ok(out.includes("total seconds 0"));
  assert.match(r.out, /^log folder .+ship-/m);
  assert.deepEqual(r.ran, ["echo zork-step-1", "echo zork-step-2", "echo zork-check-1"]);
});

test("the report counts seconds from the injected clock", async () => {
  let t = 1_000_000;
  const r = await fakeShip(block("step: true", "check: true", "rollback: true"), { now: () => (t += 1500) });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^step 1 exit 0 seconds 2$/m);
  assert.match(r.out, /^total seconds \d+$/m);
});

test("exit 1: a failing step stops the run, and no later step, check or rollback ran", async () => {
  const r = await fakeShip(block("step: echo zork-step-1", "step: false", "step: echo zork-step-3", "check: echo zork-check", "rollback: echo zork-rollback"));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^step 2 exit 1 seconds \d+$/m);
  assert.match(r.out, /a step failed: the ship stopped there and no rollback ran; 2 steps ran \(what they did stays done\).* \(exit 1\)/);
  assert.deepEqual(r.ran, ["echo zork-step-1", "false"]);
});

test("exit 1 before any step: HEAD is on another branch", async () => {
  const r = await fakeShip(["branch: release", "step: echo zork-ran", "check: true", "rollback: true"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /nothing ran: HEAD is on main, and the ship block says release/);
  assert.deepEqual(r.ran, []);
});

test("exit 5: a guard-denied command refuses the whole run before anything runs, and so does a missing guard", async () => {
  // (A git push in another form than the strict push step is an invalid block, exit 2, before the guard: see fix round 2, N2.)
  for (const denied of ["gh repo delete zork --yes", "git -c core.hooksPath=x status", "git reset --hard HEAD~1", "powershell -c ls", "GIT_DIR=/x git status"]) {
    const r = await fakeShip(block("step: echo zork-ran", "check: true", `rollback: ${denied}`));
    assert.equal(r.status, 5, `${denied}: ${r.out}`);
    assert.match(r.out, /nothing ran: the guard refused rollback 1 \(/);
    assert.deepEqual(r.ran, [], denied);
  }
  const r = await fakeShip(block("step: echo zork-ran", "check: true", "rollback: true"), { loadSafety: async () => null });
  assert.equal(r.status, 5);
  assert.match(r.out, /the guard rules or the secret matcher were not found; brief the shipper instead/);
  assert.deepEqual(r.ran, []);
});

test("fix round 1 (7r), mutant: a guard-denied command in a step or in a check refuses the whole run too, and nothing ran", async () => {
  // ($(echo git) as a program is an invalid block since fix round 4, exit 2, before the guard; an assignment the guard refuses stands in.)
  for (const denied of ["gh release delete v1", "git reset --hard HEAD~1", "GIT_DIR=/x git status"]) {
    const asStep = await fakeShip(block("step: echo zork-ran", `step: ${denied}`, "check: true", "rollback: true"));
    assert.equal(asStep.status, 5, `${denied}: ${asStep.out}`);
    assert.match(asStep.out, /nothing ran: the guard refused step 2 \(/);
    assert.deepEqual(asStep.ran, [], denied);
    const asCheck = await fakeShip(block("step: echo zork-ran", "check: true", `check: ${denied}`, "rollback: true"));
    assert.equal(asCheck.status, 5, `${denied}: ${asCheck.out}`);
    assert.match(asCheck.out, /nothing ran: the guard refused check 2 \(/);
    assert.deepEqual(asCheck.ran, [], denied);
  }
});

test("exit 6: no bash, and nothing ran", async () => {
  const r = await fakeShip(block("step: echo zork-ran", "check: true", "rollback: true"), { bash: null });
  assert.equal(r.status, 6, r.out);
  assert.match(r.out, /nothing ran: no bash was found/);
  assert.deepEqual(r.ran, []);
});

test("exit 7: a fake secret in the staged diff stops before the commit; only the file name and the category are printed", async () => {
  const diff = ["diff --git a/leak.txt b/leak.txt", "new file mode 100644", "--- /dev/null", "+++ b/leak.txt", "@@ -0,0 +1 @@", `+token = ${FAKE_TOKEN}`, ""].join("\n");
  const c = fakeCase(block("step: echo zork-step-1", `step: ${COMMIT}`, "step: echo zork-step-3", "check: true", "rollback: true"));
  const { io } = fakeIo(c, { git: fakeGit({ diff }), messages: [fakeMessage(c)] });
  const r = await ship(c, io);
  assert.equal(r.status, 7, r.out);
  assert.match(r.out, /step 2 was not run, so nothing was committed: secret-shaped text in the staged changes; 1 step ran/);
  assert.match(r.out, /^ {2}leak\.txt: an API key or token$/m);
  assert.ok(!r.out.includes(FAKE_TOKEN) && !r.out.includes("A1b2C3d4E5"), "the secret is never printed");
  assert.deepEqual(c.ran(), ["echo zork-step-1"], "the commit and the later steps never ran");
  // A staged diff that can't be read is not scanned: refused the same way. Here no step ran first, and the output says nothing was shipped.
  const u = fakeCase(block(`step: ${COMMIT}`, "check: true", "rollback: true"));
  const { io: uio } = fakeIo(u, { git: (args) => { if (args.includes("diff")) throw new Error("too big"); return args[1] === "--abbrev-ref" ? "main\n" : `${"c0ffee".padEnd(40, "0")}\n`; }, messages: [fakeMessage(u)] });
  const unreadable = await ship(u, uio);
  assert.equal(unreadable.status, 7, unreadable.out);
  assert.match(unreadable.out, /the staged diff could not be read for the secret scan; no step ran, so nothing was shipped \(exit 7\)/);
  assert.deepEqual(u.ran(), []);
});

test("exit 4: a failing check runs every rollback line once, in order, and no later check", async () => {
  const r = await fakeShip(block("step: true", "check: echo zork-check-1", "check: false", "check: echo zork-check-3", "rollback: echo zork-rollback-1", "rollback: echo zork-rollback-2"));
  assert.equal(r.status, 4, r.out);
  assert.deepEqual(r.ran, ["true", "echo zork-check-1", "false", "echo zork-rollback-1", "echo zork-rollback-2"], "each rollback ran once, in order; no check ran again");
  assert.match(r.out, /^check 2 exit 1 seconds \d+$/m);
  assert.match(r.out, /^rollback 2 exit 0 seconds \d+$/m);
  assert.match(r.out, /every rollback line passed \(exit 4\)/);
});

test("exit 8: a failing rollback line stops the rollback and says to roll back by hand", async () => {
  const r = await fakeShip(block("step: true", "check: false", "rollback: echo zork-rollback-1", "rollback: exit 3", "rollback: echo zork-rollback-3"));
  assert.equal(r.status, 8, r.out);
  assert.deepEqual(r.ran, ["true", "false", "echo zork-rollback-1", "exit 3"]);
  assert.match(r.out, /^rollback 2 exit 3 seconds \d+$/m);
  assert.match(r.out, /rollback 2 failed and 1 later rollback line was not run: roll back by hand \(exit 8\)/);
});

test("exit 2: usage errors run nothing", async () => {
  let out = "";
  for (const argv of [[], ["run"], ["run", "--plan", "x"], ["ship", "--plan", "a", "--root", "b", "--roadmap", "c", "--data", "d"], ["run", "--plan", "a", "--plan", "a", "--root", "b", "--roadmap", "c", "--data", "d"], ["run", "--plan", "--root", "b", "--roadmap", "c", "--data", "d"]]) {
    assert.equal(await main(argv, { out: (t) => { out += t; } }), 2, argv.join(" "));
  }
  assert.match(out, /^usage: ship\.mjs run --plan/m);
});

// ---------- the runner ----------
test("the spawn arguments: bash with an argument array, never cmd.exe and never shell: true, stdin closed, in the project folder", async () => {
  for (const platform of ["win32", "linux"]) {
    const bash = platform === "win32" ? "C:/zork/Git/bin/bash.exe" : "/usr/zork/bin/bash";
    const r = await fakeShip(block("step: git status --short", "check: true", "rollback: true"), { bash, platform });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.spawned.calls.length, 2);
    for (const call of r.spawned.calls) {
      assert.equal(call.file, bash);
      assert.doesNotMatch(call.file, /(^|[\\/])(cmd|powershell|pwsh)(\.exe)?$/i);
      assert.deepEqual(call.args.slice(0, 3), ["--noprofile", "--norc", "-c"]);
      assert.equal(call.args.length, 4);
      assert.notEqual(call.options.shell, true);
      assert.equal(call.options.stdio[0], "ignore");
      assert.equal(call.options.cwd, realpathSync.native(r.c.repo), "the bound real project folder");
      assert.equal(call.options.detached, platform !== "win32", "a process group of its own off Windows, so the tree can be killed");
      assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0");
    }
    assert.deepEqual(r.spawned.calls.map((x) => x.args[3]), ["git status --short", "true"]);
  }
});

test("a timeout kills the child's process tree and reports exit 124; a timed-out check rolls back", async () => {
  const started = Date.now();
  const r = await fakeShip(block("step: true", "check: sleep 30", "rollback: echo zork-rollback", "timeout: 1"));
  assert.equal(r.status, 4, r.out);
  assert.deepEqual(r.spawned.kills, [r.spawned.calls[1].child.pid], "the hanging check was killed");
  assert.deepEqual(r.ran, ["true", "sleep 30", "echo zork-rollback"]);
  assert.match(r.out, new RegExp(`^check 1 exit ${TIMEOUT_EXIT} seconds \\d+$`, "m"));
  assert.match(r.out, /check 1 ran past 1 seconds and was killed with its process tree/);
  assert.ok(Date.now() - started < 8000, "it did not wait for the command");
});

test("a real timeout: the real bash running sleep is killed after the block's timeout", async () => {
  const c = fakeCase(block("step: sleep 30; echo late > ../after-sleep", "check: true", "rollback: true", "timeout: 1"));
  const { io } = fakeIo(c);
  delete io.spawn;
  delete io.killTree;
  delete io.findBash;
  const started = Date.now();
  const r = await ship(c, io);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`^step 1 exit ${TIMEOUT_EXIT} seconds \\d+$`, "m"));
  assert.ok(Date.now() - started < 20000, `took ${Date.now() - started} ms`);
  await new Promise((done) => setTimeout(done, 1500));
  assert.throws(() => readFileSync(c.at("after-sleep")), "the killed command never got to its next line");
});

test("a failed command's log tail withholds secret-shaped lines and keeps the others (the real bash)", async () => {
  const c = fakeCase(block("step: echo visible-zork-line; echo \"token: $ZORK_VALUE\"; false", "check: true", "rollback: true"));
  const { io } = fakeIo(c, { env: { ...process.env, ZORK_VALUE: FAKE_TOKEN } });
  delete io.spawn;
  delete io.killTree;
  delete io.findBash;
  const r = await ship(c, io);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^ {2}visible-zork-line$/m);
  assert.ok(r.out.includes(WITHHELD));
  assert.ok(!r.out.includes(FAKE_TOKEN));
  const log = join(scratch(), "step-1.log");
  writeFileSync(log, [...Array.from({ length: 30 }, (_, i) => `line ${i}`), `password=Zork${"Hunter2"}Acme9`, `${FAKE_TOKEN}`].join("\n"));
  const tail = logTail(log, secretShapeIn);
  assert.equal(tail.length, 20);
  assert.equal(tail[0], "  line 12");
  assert.deepEqual(tail.slice(-2), [`  ${WITHHELD}`, `  ${WITHHELD}`]);
});

// ---------- finding bash, the guard rules and the secret matcher ----------
test("findBash: Git Bash from git --exec-path on Windows (never the PATH), the first bash on the PATH elsewhere, null when none", () => {
  const execPath = "C:/zork/Git/mingw64/libexec/git-core";
  const seen = [];
  const gitStub = (args) => { seen.push(args); return `${execPath}\n`; };
  const want = win32.join("C:/zork/Git", "bin", "bash.exe");
  assert.equal(findBash({ platform: "win32", git: gitStub, env: { PATH: "C:/Windows/System32" }, exists: (p) => p === want }), want);
  assert.deepEqual(seen[0], ["--exec-path"]);
  const usr = win32.join("C:/zork/Git", "usr", "bin", "bash.exe");
  assert.equal(findBash({ platform: "win32", git: gitStub, env: {}, exists: (p) => p === usr }), usr);
  assert.equal(findBash({ platform: "win32", git: gitStub, env: {}, exists: () => false }), null);
  assert.equal(findBash({ platform: "win32", git: () => { throw new Error("no git"); }, env: {}, exists: () => true }), null);
  assert.equal(findBash({ platform: "linux", env: { PATH: "relative/bin:/opt/zork/bin:/usr/bin" }, exists: (p) => p === "/usr/bin/bash" || p === "relative/bin/bash" }), "/usr/bin/bash");
  assert.equal(findBash({ platform: "linux", env: { PATH: "/opt/zork/bin" }, exists: () => false }), null);
});

test("the guard rules and the secret matcher load from the plugin layout, and from a personal-copy layout only with the marker", async () => {
  const plugin = await loadSafety();
  assert.equal(plugin.layout, "plugin");
  assert.ok(plugin.decide("shipper", "Bash", { command: "git push --force" }, "."));
  assert.equal(plugin.decide("shipper", "Bash", { command: "git push origin main" }, "."), null);
  assert.ok(plugin.dangerousEnv instanceof RegExp && plugin.dangerousEnv.test("GIT_DIR"), "the guard's dangerous-env list comes with it");
  // The personal layout as scripts/sync-personal.mjs lays it out: <claude home>/skills/ps-run/scripts, <claude home>/phased-shipping/hooks,
  // <claude home>/skills/ps-onboard/scripts. Built in a temp folder; the real one is never touched.
  // A module is loaded once per path, so each rules text gets a claude home of its own.
  const rules = readFileSync(join(PS, "hooks", "guard-rules.mjs"), "utf8");
  const personalHome = (guardText) => {
    const home = join(scratch(), "claude-home");
    const here = join(home, "skills", "ps-run", "scripts");
    const files = safetyFiles(here).find((x) => x.layout === "personal");
    assert.equal(files.guard, join(home, "phased-shipping", "hooks", "guard-rules.mjs"));
    assert.equal(files.survey, join(home, "skills", "ps-onboard", "scripts", "survey.mjs"));
    mkdirSync(join(home, "phased-shipping", "hooks", "lib"), { recursive: true });
    mkdirSync(dirname(files.survey), { recursive: true });
    mkdirSync(here, { recursive: true });
    copyFileSync(join(PS, "hooks", "lib", "shell.mjs"), join(home, "phased-shipping", "hooks", "lib", "shell.mjs"));
    copyFileSync(join(PS, "skills", "onboard", "scripts", "survey.mjs"), files.survey);
    writeFileSync(files.guard, guardText);
    return { here, files };
  };
  const { here, files } = personalHome(rules);
  assert.equal(await loadSafety(here), null, "no marker: not loaded");
  writeFileSync(files.guard, `${PERSONAL_MARKER} Edit the plugin, then re-run the script.\n${rules}`);
  const personal = await loadSafety(here);
  assert.equal(personal.layout, "personal");
  assert.ok(personal.decide("shipper", "Bash", { command: "git push --force" }, "."));
  assert.equal(personal.secretShapeIn(FAKE_TOKEN), "an API key or token");
  assert.ok(personal.dangerousEnv instanceof RegExp);
  // A rules file without the dangerous-env list is not a usable layout: nothing runs (exit 5).
  assert.ok(rules.includes("export const DANGEROUS_ENV"));
  const old = personalHome(`${PERSONAL_MARKER} Edit the plugin, then re-run the script.\n${rules.replace("export const DANGEROUS_ENV", "const DANGEROUS_ENV")}`);
  assert.equal(await loadSafety(old.here), null, "no DANGEROUS_ENV export: not loaded");
  const sync = readFileSync(join(HERE, "..", "scripts", "sync-personal.mjs"), "utf8");
  assert.ok(sync.includes('dest: join(CLAUDE, p.name, "hooks")') && sync.includes("`${plugin.jsMarker}\\n${readFileSync(path, \"utf8\")}`"), "the hooks copy is still <claude home>/phased-shipping/hooks, marker first");
  assert.ok(sync.includes("// Generated from the ${name} plugin by scripts/sync-personal.mjs.") && PERSONAL_MARKER === "// Generated from the phased-shipping plugin by scripts/sync-personal.mjs.", "the marker sentence is the one sync-personal writes");
  assert.equal(await loadSafety(join(scratch(), "a", "b", "c")), null, "neither layout");
});

test("stagedSecrets reads only added lines and names the file", () => {
  const diff = ["diff --git a/x.txt b/x.txt", "--- a/x.txt", "+++ b/x.txt", "@@ -1 +1 @@", `-old ${FAKE_TOKEN}`, "+new line", `+${FAKE_TOKEN}`, `+again ${FAKE_TOKEN}`,
    "diff --git a/y.md b/y.md", "+++ b/y.md", "@@ -0,0 +1 @@", "++++ not a header", "diff --git a/gone.txt b/gone.txt", "+++ /dev/null"].join("\n");
  assert.deepEqual(stagedSecrets(diff, secretShapeIn), [{ file: "x.txt", category: "an API key or token" }]);
});

test("the script imports only node: built-ins and its two siblings, writes no file outside its log folder, and never uses a shell option", () => {
  const text = readFileSync(SCRIPT, "utf8");
  for (const m of text.matchAll(/^import .* from "([^"]+)";/gm)) assert.ok(/^node:/.test(m[1]) || ["./commands-hash.mjs", "./tree-state.mjs"].includes(m[1]), m[1]);
  assert.doesNotMatch(text, /shell:\s*true|cmd\.exe"|"cmd"|powershell"|writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync/);
  assert.match(text, /openSync\(log, "wx"\)/, "the only file it opens to write is a new log file in the fresh log folder (Git Bash on Windows writes nothing to an append handle)");
});

// ---------- phase 7r, fix round 1 (the security review of the first build) ----------

test("fix round 1 (7r), M1: a --roadmap that names a changed tracked file is not the previewed roadmap: exit 3, and nothing ran", async () => {
  const c = recorded(block("step: git add -A -- a.txt", `step: ${COMMIT}`, "step: git push -q origin main", "check: true", "rollback: true"));
  writeFileSync(join(c.repo, "a.txt"), "alpha changed after the preview\n");
  const { io, spawned } = realBindIo(c);
  const head = git(c.repo, "rev-parse", "HEAD");
  const r = await ship(c, io, { roadmap: join(c.repo, "a.txt") });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /the roadmap given now is not the previewed one/);
  assert.equal(spawned.calls.length, 0);
  assert.equal(remoteMain(c), head, "nothing was pushed");
});

test("fix round 1 (7r), M2: a step with the word commit must be exactly git commit with -q, -s, --no-edit and one -F: every other form is an invalid block (exit 2), and nothing ran", async () => {
  const forms = ["git commit -q -a -F m.txt", "git commit -q --all -F m.txt", "git commit -q -F m.txt -- a.txt", "git commit -q -F m.txt a.txt", "git add -A && git commit -F m.txt", "git -C . commit -F m.txt", "git -c core.hooksPath=x commit -F m.txt",
    "command git commit -F m.txt", "git commit --include -F m.txt a.txt", "git commit -i -F m.txt a.txt", "git commit -o -F m.txt a.txt", "git commit --only -F m.txt", "git commit -p -F m.txt", "git commit --interactive -F m.txt",
    "git commit --patch -F m.txt", "git commit --pathspec-from-file=list.txt -F m.txt", "git commit --amend -F m.txt", "git commit --allow-empty -F m.txt", "true; git commit -F m.txt", "\\git commit -F m.txt", "'git' commit -F m.txt", "g''it commit -F m.txt",
    "git com''mit -F m.txt", "git \"commit\" -F m.txt", "git commit -m zork", "git commit", "git commit -F m.txt -F n.txt", "git commit -F m.txt | cat", "git commit -F m.txt > out.txt", "git commit -F m.txt # zork", "git commit -F m.txt; git push origin main",
    "git commit -F 'm.txt' $(echo -a)", "git commit -F m.txt `echo -a`", "git commit -F ~/m.txt", "git commit -F m*.txt", "echo commit", "GIT_DIR=x git commit -F m.txt", "git commit -qa -F m.txt", "git commit --no-verify -F m.txt", "git commit -F"];
  for (const form of forms) {
    assert.throws(() => shipBlock(section([...VALID, `step: ${form}`])), (e) => e.code === "ship", form);
    const r = await fakeShip(block(`step: ${form}`, "check: true", "rollback: true"));
    assert.equal(r.status, 2, `${form}: ${r.out}`);
    assert.match(r.out, /nothing ran: the ship block is invalid/, form);
    assert.deepEqual(r.ran, [], form);
  }
  // A check never commits.
  assert.throws(() => shipBlock(section([...VALID, "check: git commit -F m.txt"])), /a check never commits/);
  // The strict forms that stay valid.
  for (const form of ["git commit -q -F m.txt", "git commit -qF m.txt", "git commit -qsF'm.txt'", "git commit -q -s --no-edit --file=m.txt", "git commit --quiet --signoff --file 'a b/m.txt'", "git commit -F '.plans/commits/p7r-commit.txt'"]) {
    assert.equal(shipBlock(section([...VALID, `step: ${form}`])).commits[1]?.file !== undefined, true, form);
  }
  // `--commit` and `--commit-hash=x` are other words: a CI watch with `gh run list --commit` is a valid check.
  assert.ok(shipBlock(section([...VALID, "check: test -n \"$(gh run list --commit \"$(git rev-parse HEAD)\" --json databaseId --jq '.[].databaseId')\"", "step: echo --commit-hash=x"])));
});

test("fix round 1 (7r), M2: an alias for commit (git ci) is refused by the guard before anything runs (exit 5)", async () => {
  const r = await fakeShip(block("step: git ci -q -F m.txt", "check: true", "rollback: true"));
  assert.equal(r.status, 5, r.out);
  assert.match(r.out, /nothing ran: the guard refused step 1 \(git-allowlist\)/);
  assert.deepEqual(r.ran, []);
});

test("fix round 1 (7r), M2: the staged-diff scan reads a file whose .gitattributes says -diff as text: exit 7, and the commit never ran", async () => {
  const c = shipCase(block(`step: ${COMMIT}`, "step: git push -q origin main", "check: true", "rollback: true"));
  writeFileSync(join(c.repo, ".gitattributes"), "leak.txt -diff\n");
  writeFileSync(join(c.repo, "leak.txt"), `token = ${FAKE_TOKEN}\n`);
  git(c.repo, "add", "--", ".gitattributes", "leak.txt");
  assert.match(git(c.repo, "diff", "--cached", "--", "leak.txt"), /^Binary files /m, "without --text git hides the file's lines");
  assert.equal(recordPreview(c).status, 0);
  const { io } = realBindIo(c);
  const head = git(c.repo, "rev-parse", "HEAD");
  const r = await ship(c, io);
  assert.equal(r.status, 7, r.out);
  assert.match(r.out, /^ {2}leak\.txt: an API key or token$/m);
  assert.match(r.out, /no step ran, so nothing was shipped \(exit 7\)/);
  assert.ok(!r.out.includes(FAKE_TOKEN));
  assert.deepEqual(c.ran(), []);
  assert.equal(git(c.repo, "rev-parse", "HEAD"), head);
});

test("fix round 1 (7r), M2: what a commit step committed is scanned too: a file staged after the scan (as a pre-commit hook could) gives exit 7, names the local commit and never pushes it", async () => {
  const c = shipCase(block(`step: ${COMMIT}`, "step: git push -q origin main", "check: true", "rollback: true"));
  writeFileSync(join(c.repo, "leak.txt"), `token = ${FAKE_TOKEN}\n`); // in the previewed tree, but not staged when the scan runs
  assert.equal(recordPreview(c).status, 0);
  const { io } = realBindIo(c, { effects: { [COMMIT]: () => { git(c.repo, "add", "--", "leak.txt"); git(c.repo, "commit", "-q", "-F", MESSAGE_REL); } } });
  const head = git(c.repo, "rev-parse", "HEAD");
  const r = await ship(c, io);
  assert.equal(r.status, 7, r.out);
  const made = git(c.repo, "rev-parse", "HEAD");
  assert.notEqual(made, head);
  assert.match(r.out, new RegExp(`step 1 made the local commit ${made}, and it holds secret-shaped text: stopped; no later step ran, so this run did not push it`));
  assert.match(r.out, /^ {2}leak\.txt: an API key or token$/m);
  assert.ok(!r.out.includes(FAKE_TOKEN));
  assert.deepEqual(c.ran(), [COMMIT], "the push never ran");
  assert.equal(remoteMain(c), head);
});

test("fix round 1 (7r), M2: a step that is not a commit step but moves HEAD stops the run (exit 3), names the commit and runs no later step", async () => {
  const c = recorded(block("step: echo zork-release", "step: git push -q origin main", "check: true", "rollback: true"));
  const { io } = realBindIo(c, { effects: { "echo zork-release": () => git(c.repo, "commit", "-q", "--allow-empty", "-m", "made by a script") } });
  const head = git(c.repo, "rev-parse", "HEAD");
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  const made = git(c.repo, "rev-parse", "HEAD");
  assert.match(r.out, new RegExp(`step 1 moved HEAD to ${made}, a commit that no bound commit step made: stopped; no later step ran, so this run did not push it unless step 1 did`));
  assert.match(r.out, /1 step ran \(what it did stays done\)/);
  assert.deepEqual(c.ran(), ["echo zork-release"]);
  assert.equal(remoteMain(c), head);
});

test("fix round 1 (7r), M2: a commit step that makes more than one commit, and a check that moves HEAD, stop the run (exit 3) with no later command", async () => {
  const c = recorded(block(`step: ${COMMIT}`, "step: git push -q origin main", "check: true", "rollback: true"));
  const two = () => { git(c.repo, "commit", "-q", "--allow-empty", "-m", "one"); git(c.repo, "commit", "-q", "--allow-empty", "-m", "two"); };
  const { io } = realBindIo(c, { effects: { [COMMIT]: two } });
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /step 1 made more than one commit, or a merge \(HEAD is now [0-9a-f]{40}\): stopped; no later step ran, so this run did not push it/);
  assert.deepEqual(c.ran(), [COMMIT]);
  const k = recorded(block("step: true", "check: echo zork-check", "check: echo zork-check-2", "rollback: echo zork-rollback"));
  const { io: kio } = realBindIo(k, { effects: { "echo zork-check": () => git(k.repo, "commit", "-q", "--allow-empty", "-m", "made by a check") } });
  const checked = await ship(k, kio);
  assert.equal(checked.status, 3, checked.out);
  assert.match(checked.out, /check 1 moved HEAD to [0-9a-f]{40}: stopped before any later check or rollback/);
  assert.deepEqual(k.ran(), ["true", "echo zork-check"], "no rollback on top of an unknown commit");
});

test("fix round 1 (7r), M3: a tracked file edited after the binding check and staged by a step is never committed (exit 3), and the push never ran", async () => {
  const c = recorded(block("step: echo zork-started", "step: git add -A -- a.txt", `step: ${COMMIT}`, "step: git push -q origin main", "check: true", "rollback: true"));
  const effects = {
    "echo zork-started": () => writeFileSync(join(c.repo, "a.txt"), "edited by another process after the check\n"),
    "git add -A -- a.txt": () => git(c.repo, "add", "-A", "--", "a.txt"),
  };
  const { io } = realBindIo(c, { effects });
  const head = git(c.repo, "rev-parse", "HEAD");
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /step 3 was not run, so nothing was committed: the staged changes are not the previewed code \(only the plan and the roadmap may differ\); 2 steps ran/);
  assert.match(r.out, /^ {2}a\.txt$/m);
  assert.deepEqual(c.ran(), ["echo zork-started", "git add -A -- a.txt"]);
  assert.equal(git(c.repo, "rev-parse", "HEAD"), head);
  assert.equal(remoteMain(c), head, "nothing was pushed");
});

test("fix round 1 (7r), M3: the new commit is checked against the preview too: a tracked file a hook changed and staged gives exit 3, names the local commit and never pushes it", async () => {
  const c = shipCase(block(`step: ${COMMIT}`, "step: git push -q origin main", "check: true", "rollback: true"));
  writeFileSync(join(c.repo, "feature.txt"), "zork feature\n");
  git(c.repo, "add", "--", "feature.txt");
  assert.equal(recordPreview(c).status, 0);
  const hook = () => { writeFileSync(join(c.repo, "a.txt"), "changed by a hook\n"); git(c.repo, "add", "--", "a.txt"); git(c.repo, "commit", "-q", "-F", MESSAGE_REL); };
  const { io } = realBindIo(c, { effects: { [COMMIT]: hook } });
  const head = git(c.repo, "rev-parse", "HEAD");
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  const made = git(c.repo, "rev-parse", "HEAD");
  assert.match(r.out, new RegExp(`step 1 made the local commit ${made}, and it holds code that was not previewed: stopped; no later step ran, so this run did not push it`));
  assert.match(r.out, /^ {2}a\.txt$/m);
  assert.doesNotMatch(r.out, /^ {2}feature\.txt$/m, "the previewed file is fine");
  assert.equal(remoteMain(c), head);
});

test("fix round 1 (7r), M3: every command runs in the bound real project folder, not the --root spelling", async () => {
  const c = shipCase(block("step: echo zork-where", "check: true", "rollback: true"));
  const link = c.at("repo-link");
  linkFolder(c.repo, link);
  assert.equal(recordPreview(c, { extra: ["--root", link, "--roadmap", c.roadmap] }).status, 0);
  const { io, spawned } = realBindIo(c);
  const r = await ship(c, io, { root: link });
  assert.equal(r.status, 0, r.out);
  assert.equal(spawned.calls[0].options.cwd, realpathSync.native(c.repo));
  unlinkLink(link);
});

test("fix round 1 (7r), M5: the parent's GIT_CONFIG_* never reach a command, so a refusing pre-commit hook still refuses (exit 1); the left-out names are printed, never the values (the real bash)", async () => {
  const c = shipCase(block("step: git add -A -- feature.txt", `step: ${COMMIT}`, "step: git push -q origin main", "check: true", "rollback: true"));
  writeFileSync(join(c.repo, "feature.txt"), "zork feature\n");
  writeFileSync(join(c.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho zork-hook-refused >&2\nexit 1\n", { mode: 0o755 });
  assert.equal(recordPreview(c).status, 0);
  // The test's own environment without any name ship.mjs leaves out, so the printed list holds only the ones added here.
  const env = { ...commandEnv(cleanEnv(), DANGEROUS_ENV).env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "zork-no-hooks", HUSKY: "0", NODE_OPTIONS: "--zork-value" };
  const head = git(c.repo, "rev-parse", "HEAD");
  const r = await ship(c, { env });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^step 2 exit 1 seconds \d+$/m);
  assert.match(r.out, /^ {2}zork-hook-refused$/m, "the hook ran");
  assert.match(r.out, /^left out of the commands' environment: GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0, HUSKY, NODE_OPTIONS$/m);
  assert.ok(!r.out.includes("zork-no-hooks") && !r.out.includes("--zork-value"), "no value is printed");
  assert.equal(git(c.repo, "rev-parse", "HEAD"), head);
  assert.equal(remoteMain(c), head);
});

test("fix round 1 (7r), M5: commandEnv drops every GIT_* variable, every name on the guard's list and the fixed extra names, keeps the home and PATH names, and lists what it dropped", () => {
  const dropped = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_EXEC_PATH", "GIT_ASKPASS", "GIT_AUTHOR_NAME", "git_work_tree", "HUSKY", "HUSKY_SKIP_HOOKS", "SKIP", "LEFTHOOK",
    "LEFTHOOK_EXCLUDE", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "NODE_OPTIONS", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "BASH_FUNC_git%%", "SSH_ASKPASS", "PROMPT_COMMAND",
    "OVERCOMMIT_DISABLE", "PRE_COMMIT_ALLOW_NO_CONFIG", "PERL5OPT", "RUBYOPT", "PYTHONSTARTUP", "JAVA_TOOL_OPTIONS", "npm_config_script_shell"];
  const kept = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "XDG_CONFIG_HOME", "PATH", "Path", "SystemRoot", "ZORK_VALUE", "GH_REPO", "GH_HOST"];
  for (const name of dropped) {
    const r = commandEnv({ [name]: "zork", PATH: "/bin" }, DANGEROUS_ENV);
    assert.ok(!(name in r.env), `${name} is dropped`);
    assert.deepEqual(r.dropped, [name], name);
  }
  const all = commandEnv(Object.fromEntries([...dropped, ...kept].map((n) => [n, "v"])), DANGEROUS_ENV);
  assert.deepEqual(Object.keys(all.env).sort(), [...kept, "GIT_TERMINAL_PROMPT"].sort());
  assert.equal(all.env.GIT_TERMINAL_PROMPT, "0");
  assert.deepEqual(all.dropped, [...dropped].sort());
  // The fixed names go even without the guard's list.
  for (const name of dropped.filter((n) => !["SSH_ASKPASS", "PROMPT_COMMAND"].includes(n))) assert.ok(!(name in commandEnv({ [name]: "v" }).env), name);
});

test("fix round 1 (7r), L1: the log tail withholds a token behind an ANSI colour code, the rest of a line cut by the 64 KB read, and every line of a PEM block", () => {
  const dir = scratch();
  const esc = ch(0x1b);
  const ansi = join(dir, "ansi.log");
  writeFileSync(ansi, `ok line\n${esc}[31m${FAKE_TOKEN}${esc}[0m\n`);
  assert.deepEqual(logTail(ansi, secretShapeIn), ["  ok line", `  ${WITHHELD}`]);
  // A JWT-shaped line whose start lies before the last 64 KB: the read starts inside it, and that part line is never printed.
  const header = `eyJ${"h".repeat(40)}`;
  const rest = `.eyJ${"p".repeat(40)}.${"s".repeat(20)}`;
  const filler = "y".repeat(64 * 1024 - header.slice(10).length - rest.length - 2);
  const cut = join(dir, "cut.log");
  writeFileSync(cut, `first line\ntoken ${header}${rest}\n${filler}\n`);
  const tail = logTail(cut, secretShapeIn);
  assert.equal(tail.length, 1, "only whole lines");
  assert.ok(tail[0].startsWith("  yyyy") && !tail.join("").includes("eyJ"), tail[0].slice(0, 40));
  // PEM blocks: between BEGIN and END; BEGIN with no END runs to the end; END with no BEGIN in the tail runs from the start.
  const begin = (what) => ["-----BEGIN", `${what}-----`].join(" ");
  const end = (what) => ["-----END", `${what}-----`].join(" ");
  const key = ["RSA", "PRIVATE", "KEY"].join(" ");
  const cases = [
    [["before", begin("CERTIFICATE"), "MIIBzork1", "MIIBzork2", end("CERTIFICATE"), "after"], ["  before", "W", "W", "W", "W", "  after"]],
    [["before", begin(key), "MIIEzork1", "zork2"], ["  before", "W", "W", "W"]],
    [["MIIEzork1", "zork2", end(key), "after"], ["W", "W", "W", "  after"]],
    [["before", `${esc}[33m${begin(key)}`, "MIIEzork1", `${esc}[0m${end(key)}`, "after"], ["  before", "W", "W", "W", "  after"]],
  ];
  for (const [lines, want] of cases) {
    const f = join(dir, "pem.log");
    writeFileSync(f, `${lines.join("\n")}\n`);
    assert.deepEqual(logTail(f, secretShapeIn), want.map((w) => (w === "W" ? `  ${WITHHELD}` : w)), lines.join(" | "));
  }
});

test("fix round 1 (7r), L4: a commit message folder re-pointed to another folder during the run is never committed from (exit 3)", async () => {
  const c = shipCase(block("step: echo zork-repoint", `step: ${COMMIT}`, "check: true", "rollback: true"));
  const commits = join(c.repo, ".plans", "commits");
  rmSync(commits, { recursive: true, force: true });
  for (const [name, text] of [["msg-a", "Ship zork\n"], ["msg-b", "Ship zork\n"]]) {
    mkdirSync(c.at(name));
    writeFileSync(join(c.at(name), "zork-commit.txt"), text);
  }
  linkFolder(c.at("msg-a"), commits);
  assert.equal(recordPreview(c).status, 0);
  // The same bytes behind the new link: the real path decides before the hash does.
  const { io } = realBindIo(c, { effects: { "echo zork-repoint": () => { unlinkLink(commits); linkFolder(c.at("msg-b"), commits); } } });
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /step 2 was not run, so nothing was committed: the commit message file \.plans\/commits\/zork-commit\.txt is not at its previewed real path/);
  assert.deepEqual(c.ran(), ["echo zork-repoint"]);
  unlinkLink(commits);
});

test("fix round 1 (7r), L5: a record whose text was edited without its hash is refused (exit 3), and nothing ran", async () => {
  const c = recorded(block("step: echo from-file", "check: true", "rollback: true"));
  const file = join(c.data, "previews", `${planKey(c.plan)}.previewed.json`);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.text = saved.text.replace("echo from-file", "echo from-record");
  writeFileSync(file, JSON.stringify(saved));
  const { io, spawned } = realBindIo(c);
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /the previewed record's text does not match its hash/);
  assert.equal(spawned.calls.length, 0);
});

test("fix round 1 (7r), L6: a format character (bidi, zero-width, BOM) anywhere in a ship block line makes the block invalid", async () => {
  for (const code of [0x202e, 0x2066, 0x200b, 0xfeff, 0x2028, 0x2029]) {
    for (const line of [`step: git push origin ${ch(code)}main`, `step: ${ch(code)}git push origin main`, `${ch(code)}step: git push origin main`]) {
      assert.throws(() => shipBlock(section([...VALID, line])), (e) => e.code === "ship", `U+${code.toString(16)}`);
    }
    const r = await fakeShip(block(`step: echo zork${ch(code)}`, "check: true", "rollback: true"));
    assert.equal(r.status, 2, r.out);
    assert.deepEqual(r.ran, []);
  }
});

test("fix round 1 (7r), L8: the log folder is made in the temp folder the caller gives", async () => {
  const tmp = scratch();
  const c = fakeCase(block("step: true", "check: true", "rollback: true"));
  const { io } = fakeIo(c, { tmpdir: tmp });
  const r = await ship(c, io);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("ship-")).length, 1);
  assert.ok(r.out.includes(`log folder ${join(tmp, "ship-")}`));
});

// ---------- phase 7r, fix round 2 (the re-review of fix round 1) ----------

test("fix round 2 (7r), N3: the word commit hidden by a backslash, quotes, $'..', a line continuation or an empty expansion still counts: a step must then be strict, and a check or a rollback may not hold it", async () => {
  const hidden = ["git c\\ommit -a -F m.txt", "git \"c\"ommit -a -F m.txt", "git co''mmit -a -F m.txt", "git $'commit' -a -F m.txt", "git c${x}ommit -a -F m.txt", "git c$X\"\"ommit -a -F m.txt", "git c\\ommit -q -a -F m.txt && git push -q origin main",
    "bash -c 'git c\\ommit -a -F m.txt'", "git co`true`mmit -a -F m.txt", "git co$(true)mmit -a -F m.txt", "g\\it c\\ommit -F m.txt", "git \\commit -F m.txt"];
  for (const form of hidden) {
    for (const key of ["step", "check", "rollback"]) assert.throws(() => shipBlock(section([...VALID, `${key}: ${form}`])), (e) => e.code === "ship", `${key}: ${form}`);
    const r = await fakeShip(block(`step: ${form}`, "check: true", "rollback: true"));
    assert.equal(r.status, 2, `${form}: ${r.out}`);
    assert.deepEqual(r.ran, [], form);
  }
  // A line continuation can't be in a ship block line (a line ends it), but the parser of a step treats it as bash does.
  assert.throws(() => messageFiles(["git com\\\nmit -a -F m.txt"]), (e) => e.code === "ship");
  // --commit and words that merely contain it stay other words.
  assert.ok(shipBlock(section([...VALID, "check: test -n \"$(gh run list --commit \"$(git rev-parse HEAD)\" --json databaseId --jq '.[].databaseId')\"", "step: echo --commit-hash=x", "step: echo recommit commitment"])));
});

test("fix round 2 (7r), N2: a push step must be exactly git push [-q] origin <the block's branch>, on its own; a check never pushes; a rollback pushes only that way, after &&", async () => {
  const bad = ["git push -q origin evil:main", "git push origin HEAD:main", "git push origin main:main", "git push --all origin", "git push --tags", "git push origin v9", "git tag v9 HEAD~3 && git push origin v9", "git push -f origin main",
    "git push --force origin main", "git push -u origin main", "git push origin main --force", "git push --delete origin main", "git push origin", "git push", "git push upstream main", "git push origin dev", "git add -A && git push origin main",
    "git push origin main && echo done", "bash -c 'git push origin main'", "git -C . push origin main", "\"git\" push origin main", "git pu\\sh origin main", "git push origin 'main'", "command git push origin main", "git push -q origin main # x",
    "git push origin main; true", "git push --no-verify origin main", "git push origin +main", "env git push origin main"];
  for (const form of bad) {
    assert.throws(() => shipBlock(section([...VALID, `step: ${form}`])), (e) => e.code === "ship", form);
    const r = await fakeShip(block(`step: ${form}`, "check: true", "rollback: true"));
    assert.equal(r.status, 2, `${form}: ${r.out}`);
    assert.deepEqual(r.ran, [], form);
  }
  for (const form of ["git push origin main", "git push -q origin main"]) assert.throws(() => shipBlock(section([...VALID, `check: ${form}`])), /a check never pushes/, form);
  for (const form of ["git push -f origin main", "git revert --no-edit HEAD; git push origin main", "git revert --no-edit HEAD && git push origin evil:main", "git push origin main || true", "git revert --no-edit HEAD && git push --tags"]) {
    assert.throws(() => shipBlock(section([...VALID, `rollback: ${form}`])), (e) => e.code === "ship", `rollback: ${form}`);
  }
  for (const form of ["git revert --no-edit HEAD && git push origin main", "git push -q origin main", "git revert --no-edit HEAD && git push --quiet origin main"]) {
    assert.ok(shipBlock(section([...VALID, `rollback: ${form}`])), `rollback: ${form}`);
  }
  for (const form of ["git push origin main", "git push -q origin main", "git push --quiet origin main"]) assert.equal(shipBlock(section([...VALID, `step: ${form}`])).pushes[1], true, form);
  const other = shipBlock(section([...VALID, "step: docker push acmecorp/zork:1", "step: npm run deploy"]));
  assert.deepEqual(other.pushes, [true, false, false], "a deploy tool's own push is not a git push");
  assert.deepEqual(shipBlock(section(["branch: release", "step: git push origin release", "check: true", "rollback: true"])).pushes, [true], "the block's own branch");
  assert.throws(() => shipBlock(section(["branch: release", "step: git push origin main", "check: true", "rollback: true"])), (e) => e.code === "ship", "another branch than the block's");
});

test("fix round 2 (7r), N2: a commit made after the preview refuses the ship (exit 3) even when the tree is the previewed one, and so does a record with no HEAD; nothing ran", async () => {
  const c = recorded(block("step: git add -A -- a.txt", `step: ${COMMIT}`, "step: git push -q origin main", "check: true", "rollback: true"));
  const start = git(c.repo, "rev-parse", "HEAD");
  writeFileSync(join(c.repo, "leak.txt"), `token = ${FAKE_TOKEN}\n`);
  git(c.repo, "add", "--", "leak.txt");
  git(c.repo, "commit", "-q", "-m", "add");
  git(c.repo, "rm", "-q", "--", "leak.txt");
  git(c.repo, "commit", "-q", "-m", "remove");
  assert.equal(git(c.repo, "rev-parse", "HEAD^{tree}"), git(c.repo, "rev-parse", `${start}^{tree}`), "the same tree as the preview");
  const { io, spawned } = realBindIo(c);
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, new RegExp(`nothing ran: HEAD is ${git(c.repo, "rev-parse", "HEAD")}, and the preview bound ${start}; run the preview again \\(exit 3\\)`));
  assert.equal(spawned.calls.length, 0);
  assert.equal(remoteMain(c), start, "nothing was pushed");
  // A record from before this check (no HEAD in it): refused the same way.
  const k = recorded(block("step: echo zork-ran", "check: true", "rollback: true"));
  const file = join(k.data, "previews", `${planKey(k.plan)}.previewed.json`);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.match(saved.head, /^[0-9a-f]{40}$/, "the record binds HEAD");
  delete saved.head;
  writeFileSync(file, JSON.stringify(saved));
  const { io: kio, spawned: kspawned } = realBindIo(k);
  const old = await ship(k, kio);
  assert.equal(old.status, 3, old.out);
  assert.match(old.out, /nothing ran: the previewed record holds no HEAD commit \(it was made before that check\); run the preview again \(exit 3\)/);
  assert.equal(kspawned.calls.length, 0);
});

test("fix round 2 (7r), N2: after a push step origin's branch must be HEAD (exit 3 otherwise), and a run that did not put HEAD on origin never prints shipped", async () => {
  const empty = (k) => () => git(k.repo, "commit", "-q", "--allow-empty", "-F", MESSAGE_REL);
  const c = recorded(block(`step: ${COMMIT}`, "step: git push -q origin main", "check: echo zork-check", "rollback: true"));
  const start = git(c.repo, "rev-parse", "HEAD");
  const { io } = realBindIo(c, { effects: { [COMMIT]: empty(c) } }); // the push step runs nothing: origin keeps the old commit
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  const made = git(c.repo, "rev-parse", "HEAD");
  assert.match(r.out, new RegExp(`step 2 pushed, but origin's main is ${start}, not HEAD ${made}: stopped; no later step or check ran`));
  assert.deepEqual(c.ran(), [COMMIT, "git push -q origin main"]);
  assert.doesNotMatch(r.out, /^shipped /m);
  // No push step at all: the checks pass (exit 0), but the summary says origin does not have HEAD.
  const k = recorded(block(`step: ${COMMIT}`, "check: true", "rollback: true"));
  const kstart = git(k.repo, "rev-parse", "HEAD");
  const { io: kio } = realBindIo(k, { effects: { [COMMIT]: empty(k) } });
  const done = await ship(k, kio);
  assert.equal(done.status, 0, done.out);
  assert.doesNotMatch(done.out, /^shipped /m);
  assert.match(done.out, new RegExp(`^checked, but origin's main is ${kstart}, not HEAD ${git(k.repo, "rev-parse", "HEAD")}: this run did not put HEAD on origin, and origin's branches and tags were as before at every ref check$`, "m"));
  // The fake remote that lags HEAD: no shipped line either.
  const f = await fakeShip(block("step: true", "check: true", "rollback: true"), { git: fakeGit({ head: "abc123".padEnd(40, "9"), remote: "def456".padEnd(40, "9") }) });
  assert.equal(f.status, 0, f.out);
  assert.doesNotMatch(f.out, /^shipped /m);
});

test("fix round 2 (7r), N1: a step or a check that runs a process substitution or an fd path as a shell script is refused by the guard (exit 5), and nothing ran", async () => {
  for (const form of ["bash <(echo zork)", "source <(echo zork)", ". <(echo zork)", "exec 3<<<'echo zork'; bash /dev/fd/3"]) {
    for (const key of ["step", "check"]) {
      const r = await fakeShip(block(key === "step" ? `step: ${form}` : "step: true", key === "check" ? `check: ${form}` : "check: true", "rollback: true"));
      assert.equal(r.status, 5, `${key}: ${form}: ${r.out}`);
      assert.match(r.out, /\(hidden-program\)/);
      assert.deepEqual(r.ran, [], form);
    }
  }
});

test("fix round 2 (7r), N4: a token split by a lone CR in a log line is withheld, and the line is never shown in two parts", () => {
  const f = join(scratch(), "cr.log");
  writeFileSync(f, `ok line\n${FAKE_TOKEN.slice(0, 20)}\r${FAKE_TOKEN.slice(20)}\nlast\r\n`);
  const tail = logTail(f, secretShapeIn);
  assert.deepEqual(tail, ["  ok line", `  ${WITHHELD}`, "  last"]);
  assert.ok(!tail.join("").includes(FAKE_TOKEN.slice(0, 20)) && !tail.join("").includes(FAKE_TOKEN.slice(20)));
});

test("fix round 2 (7r), N5: a commit message file with secret-shaped text stops before the commit (exit 7); only its name and the category are printed", async () => {
  const c = fakeCase(block("step: echo zork-step-1", `step: ${COMMIT}`, "check: true", "rollback: true"));
  const { io } = fakeIo(c, { messages: [fakeMessage(c, MESSAGE_REL, `Ship zork\n\ntoken = ${FAKE_TOKEN}\n`)] });
  const r = await ship(c, io);
  assert.equal(r.status, 7, r.out);
  assert.match(r.out, /step 2 was not run, so nothing was committed: secret-shaped text in a commit message file; 1 step ran/);
  assert.match(r.out, /^ {2}\.plans\/commits\/zork-commit\.txt: an API key or token$/m);
  assert.ok(!r.out.includes(FAKE_TOKEN));
  assert.deepEqual(c.ran(), ["echo zork-step-1"]);
});

test("fix round 2 (7r): every stop before the first step says nothing ran or no step ran, and a stop after a step says neither (the run skill reads those words)", async () => {
  const before = [
    await fakeShip(["branch: release", "step: echo zork", "check: true", "rollback: true"]),
  ];
  const c = fakeCase(block(`step: ${COMMIT}`, "check: true", "rollback: true"));
  const { io } = fakeIo(c, { git: fakeGit({ diff: ["diff --git a/x b/x", "+++ b/x", "@@ -0,0 +1 @@", `+${FAKE_TOKEN}`].join("\n") }), messages: [fakeMessage(c)] });
  before.push(await ship(c, io));
  const moved = fakeCase(block("step: echo zork", "check: true", "rollback: true"));
  const m = fakeIo(moved);
  const bound = m.io.bind();
  m.io.bind = () => ({ ...bound, saved: { ...bound.saved, head: "abc123".padEnd(40, "9") } });
  before.push(await ship(moved, m.io));
  for (const r of before) {
    assert.ok([1, 3, 7].includes(r.status), r.out);
    assert.match(r.out, /nothing ran|no step ran/, r.out);
  }
  const after = await fakeShip(block("step: true", "step: false", "check: true", "rollback: true"));
  assert.equal(after.status, 1);
  assert.doesNotMatch(after.out, /nothing ran|no step ran/);
});

// ---------- phase 7r, fix round 3 (the final review) ----------
// The real bash, the real binding and real git, against the bare remote: what the review ran.
const realBashIo = (c, opts = {}) => {
  const { io } = realBindIo(c, opts);
  delete io.spawn;
  delete io.killTree;
  delete io.findBash;
  return io;
};
// A case whose HEAD has a parent on origin too (so HEAD~1 is a real commit), recorded with `lines` as its ship block.
const twoCommits = (lines) => {
  const c = shipCase(lines);
  writeFileSync(join(c.repo, "b.txt"), "beta\n");
  git(c.repo, "add", "--", "b.txt");
  git(c.repo, "commit", "-q", "-m", "second");
  git(c.repo, "push", "-q", "origin", "main");
  assert.equal(recordPreview(c).status, 0);
  return c;
};
const remoteRefs = (c) => git(c.base, "--git-dir=remote.git", "for-each-ref", "--format=%(refname) %(objectname)");

test("fix round 3 (7r), M1: a shell reading its stdin from a process substitution, a file or an fd is refused (the reviewer's force push, the real bash): exit 5, and origin is untouched", async () => {
  const c = twoCommits(block("step: bash < <(printf 'g%st push -q --force origin HEAD~1:main' i)", "check: true", "rollback: true"));
  const before = remoteRefs(c);
  const r = await ship(c, realBashIo(c));
  assert.equal(r.status, 5, r.out);
  assert.match(r.out, /nothing ran: the guard refused step 1 \(hidden-program\)/);
  assert.equal(remoteRefs(c), before, "origin's refs are as they were");
});

test("fix round 3 (7r), M2: a push hidden by a nested substitution is read as a push (the reviewer's evil ref, the real bash): an invalid block, exit 2, and no ref appears on origin", async () => {
  for (const step of ["git pu$( (true) )sh -q origin HEAD~1:refs/heads/evil", "git p$( (:) )ush -q origin HEAD~1:refs/heads/evil", "git pu$(echo $(echo $(echo $(true))))sh -q origin HEAD~1:refs/heads/evil"]) {
    const c = twoCommits(block(`step: ${step}`, "check: true", "rollback: true"));
    const before = remoteRefs(c);
    const r = await ship(c, realBashIo(c));
    assert.equal(r.status, 2, `${step}: ${r.out}`);
    assert.match(r.out, /nothing ran: the ship block is invalid/);
    assert.equal(remoteRefs(c), before, step);
  }
});

test("fix round 3 (7r), M2: a nested substitution is read through in a step, a check and a rollback, and one that is never closed makes the block invalid", () => {
  const forms = ["git pu$( (true) )sh -q origin HEAD~1:refs/heads/evil", "git p$( (:) )ush -q origin main", "git pu$(echo $(echo $(echo $(true))))sh -q origin HEAD~1:refs/heads/evil", "git co$( (true) )mmit -a -F m.txt",
    "git pu`(true)`sh origin evil:main", "git pu$((0))sh origin evil:main", "git pu<(true)sh origin evil:main", "git pu$( sh origin main"];
  for (const form of forms) for (const key of ["step", "check", "rollback"]) assert.throws(() => shipBlock(section([...VALID, `${key}: ${form}`])), (e) => e.code === "ship", `${key}: ${form}`);
  // The real checks with substitutions (parentheses inside quotes included) stay valid.
  assert.ok(shipBlock(section([...VALID, "check: test -z \"$(gh run list --commit \"$(git rev-parse HEAD)\" --json conclusion --jq '.[] | select(.conclusion != \"success\")')\"",
    "check: test \"$(git rev-parse HEAD)\" = \"$(git ls-remote origin refs/heads/main | cut -f1)\""])));
});

test("fix round 3 (7r), M1, M2: origin's refs are read before the run and after every step and check: a ref a step or a check changed stops the run (exit 3) and is named; only a strict push may move the block's branch to HEAD", async () => {
  // A step the guard and the parser can't see into (a script) that pushes a new ref, and one that moves main back.
  for (const [what, effect, ref] of [["a new ref", (c, first) => git(c.repo, "push", "-q", "origin", `${first}:refs/heads/evil`), "refs/heads/evil"],
    ["main moved back", (c, first) => git(c.repo, "push", "-q", "--force", "origin", `${first}:refs/heads/main`), "refs/heads/main"]]) {
    const c = twoCommits(block("step: bash zork-release.sh", "step: echo zork-later", "check: true", "rollback: true"));
    const first = git(c.repo, "rev-parse", "HEAD~1");
    const { io } = realBindIo(c, { effects: { "bash zork-release.sh": () => effect(c, first) } });
    const r = await ship(c, io);
    assert.equal(r.status, 3, `${what}: ${r.out}`);
    assert.match(r.out, new RegExp(`after step 1 origin's refs changed, and no strict push step can explain it: stopped; no later step or check ran`), what);
    assert.match(r.out, new RegExp(`^ {2}${ref}$`, "m"), what);
    assert.deepEqual(c.ran(), ["bash zork-release.sh"], what);
    assert.doesNotMatch(r.out, /^shipped /m);
  }
  // A check that pushes and passes: stopped before the next check, and nothing is rolled back (fix round 5).
  const k = twoCommits(block("step: true", "check: echo zork-check", "check: true", "rollback: echo zork-rollback"));
  const kfirst = git(k.repo, "rev-parse", "HEAD~1");
  const { io: kio } = realBindIo(k, { effects: { "echo zork-check": () => git(k.repo, "push", "-q", "origin", `${kfirst}:refs/tags/zork`) } });
  const checked = await ship(k, kio);
  assert.equal(checked.status, 3, checked.out);
  assert.match(checked.out, /after check 1 origin's refs changed/);
  assert.match(checked.out, /^ {2}refs\/tags\/zork$/m);
  assert.deepEqual(k.ran(), ["true", "echo zork-check"], "the check passed: no rollback");
});

test("fix round 3 (7r), M2: a run that can't read origin's refs proves nothing: exit 3 before any step, or right after the step that ran", async () => {
  const failing = (after) => {
    let calls = 0;
    const base = fakeGit();
    return (args, opts) => { if (args.includes("ls-remote") && ++calls > after) throw new Error("offline"); return base(args, opts); };
  };
  const none = await fakeShip(block("step: echo zork", "check: true", "rollback: true"), { git: failing(0) });
  assert.equal(none.status, 3, none.out);
  assert.match(none.out, /nothing ran: origin's refs could not be read \(git ls-remote failed or timed out\), so the run could not show what it pushed; run it when origin can be reached \(exit 3\)/);
  assert.deepEqual(none.ran, []);
  const later = await fakeShip(block("step: echo zork", "step: echo zork-2", "check: true", "rollback: true"), { git: failing(1) });
  assert.equal(later.status, 3, later.out);
  assert.match(later.out, /after step 1 origin's refs could not be read \(git ls-remote failed or timed out\), so it can't be shown that nothing was pushed: stopped; no later step or check ran/);
  assert.deepEqual(later.ran, ["echo zork"]);
});

test("fix round 3 (7r), M2: a push step runs only while HEAD is the block's branch (git symbolic-ref): exit 3 otherwise, and the push never ran", async () => {
  const base = fakeGit();
  const git2 = (args, opts) => (args[0] === "symbolic-ref" ? "refs/heads/zork-other\n" : base(args, opts));
  const r = await fakeShip(block("step: echo zork", "step: git push -q origin main", "check: true", "rollback: true"), { git: git2 });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /step 2 was not run: HEAD is refs\/heads\/zork-other, not refs\/heads\/main/);
  assert.deepEqual(r.ran, ["echo zork"]);
});

// ---------- phase 7r, fix round 4 (the third review) ----------
// The git program spelled with a glob, as the review ran it: the Git for Windows path, or the usual POSIX one.
const GLOB_GIT = process.platform === "win32" ? "/mingw64/bin/g?t.exe" : "/usr/bin/g?t";

test("fix round 4 (7r), M1: a glob in the program word (the reviewer's force push, the real bash) is an invalid block: exit 2, and origin is untouched", async () => {
  const c = twoCommits(block(`step: ${GLOB_GIT} push -q --force origin HEAD~1:main`, "check: true", "rollback: true"));
  const before = remoteRefs(c);
  const r = await ship(c, realBashIo(c));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /nothing ran: the ship block is invalid/);
  assert.equal(remoteRefs(c), before);
});

test("fix round 4 (7r), M1: a glob, a brace expansion or ${ in any command's program word makes the block invalid in a step, a check and a rollback; arguments may glob", () => {
  const forms = ["g?t push origin main", "g*t status", "gi[t] status", "{git,status}", "/mingw64/bin/g?t.exe push -q --force origin HEAD~1:main", "/usr/bin/gi? status", "${G:-git} status", "true && g?t status", "env g?t status", "command gi* status",
    "git pu{,}sh origin main", "echo {a,b}"];
  for (const form of forms) for (const key of ["step", "check", "rollback"]) assert.throws(() => shipBlock(section([...VALID, `${key}: ${form}`])), (e) => e.code === "ship", `${key}: ${form}`);
  for (const form of ["test -f a*", "[ -f x ]", "[[ -f x ]]", "ls *.md", "grep -r 'a*b' .", "for f in *.json; do test -s \"$f\"; done", "echo '{a,b}'", "test -z \"${X:-}\""]) {
    for (const key of ["step", "check", "rollback"]) assert.ok(shipBlock(section([...VALID, `${key}: ${form}`])), `${key}: ${form}`);
  }
});

test("fix round 4 (7r), M2: a background job is refused (the reviewer's delayed push, the real bash): an invalid block, exit 2, and origin is never rewritten later", async () => {
  const c = twoCommits(block("step: (sleep 2; bash ../zork-late.sh) >/dev/null 2>&1 &", "check: true", "rollback: true"));
  writeFileSync(c.at("zork-late.sh"), "git push -q --force origin HEAD~1:main\n");
  const before = remoteRefs(c);
  const r = await ship(c, realBashIo(c));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /nothing ran: the ship block is invalid: .*background/);
  await new Promise((done) => setTimeout(done, 3500));
  assert.equal(remoteRefs(c), before, "nothing ran later either");
});

test("fix round 4 (7r), M2: & as an operator and the background programs are refused in every line; && and the redirections with & stay valid", () => {
  for (const form of ["sleep 1 &", "true & true", "(sleep 1; true) &", "nohup true", "setsid true", "disown", "coproc true", "at now", "batch", "env nohup true", "command setsid true", "time nohup true", "bash -c 'sleep 1 &'", "true &\ntrue"]) {
    for (const key of ["step", "check", "rollback"]) assert.throws(() => shipBlock(section([...VALID, `${key}: ${form}`])), (e) => e.code === "ship", `${key}: ${form}`);
  }
  for (const form of ["true && true", "npm test 2>&1", "echo x >&2", "echo x 1>&2", "npm test &> out.txt", "npm test &>> out.txt", "true || true", "echo at", "echo batch"]) {
    for (const key of ["step", "check", "rollback"]) assert.ok(shipBlock(section([...VALID, `${key}: ${form}`])), `${key}: ${form}`);
  }
});

test("fix round 4 (7r), M2: each command's process group (or tree) is ended after the command exits, not only on a timeout", async () => {
  const reaped = [];
  const r = await fakeShip(block("step: echo zork-1", "step: echo zork-2", "check: true", "rollback: true"), { reap: (child) => reaped.push(child.pid) });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(reaped, r.spawned.calls.map((x) => x.child.pid), "every command, after it exited");
});

test("fix round 4 (7r), M2: a job left running by a command dies with its process group (POSIX, the real bash)", { skip: process.platform === "win32" ? "Windows has no process groups: a job that leaves the tree can outlive its command (documented)" : false }, async () => {
  // The step's node starts a child and exits at once (unref: it does not wait for it); the child writes ../late 1.5 s later unless
  // something ends it. It stays in the step's process group (not detached), which ship.mjs ends after the step exits.
  const job = "node -e \"require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => require(\\'fs\\').writeFileSync(\\'../late\\', \\'x\\'), 1500)'], { stdio: 'ignore' }).unref()\"";
  // The control: run the same command outside ship.mjs, with nothing to end the child: the file appears, so the case below can
  // only pass because the group was ended (with the kill removed it fails).
  const control = fakeCase(null);
  execFileSync("bash", ["-c", job], { cwd: control.repo, stdio: "ignore" });
  assert.throws(() => readFileSync(control.at("late")), "the command returned before its child wrote");
  await new Promise((done) => setTimeout(done, 2500));
  assert.ok(existsSync(control.at("late")), "left alone, the child writes the file");
  const c = fakeCase(block(`step: ${job}`, "check: true", "rollback: true"));
  const { io } = fakeIo(c);
  delete io.spawn;
  delete io.killTree;
  delete io.findBash;
  delete io.reap;
  const r = await ship(c, io);
  assert.equal(r.status, 0, r.out);
  await new Promise((done) => setTimeout(done, 2500));
  assert.throws(() => readFileSync(c.at("late")), "the left-over job was killed with its group");
});

test("fix round 4 (7r), M2: one more ref check after the last command, after a short wait, catches a push that lands late (exit 3)", async () => {
  const c = twoCommits(block("step: echo zork-step", "check: echo zork-check", "rollback: true"));
  const first = git(c.repo, "rev-parse", "HEAD~1");
  // The wait before the last ref check is injected: the late push lands during it, every time (no race with a timer).
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); git(c.repo, "push", "-q", "origin", `${first}:refs/heads/evil`); };
  const { io } = realBindIo(c, { sleep, settleMs: 1500 });
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /after the last command origin's refs changed/);
  assert.match(r.out, /^ {2}refs\/heads\/evil$/m);
  assert.doesNotMatch(r.out, /^shipped /m);
  assert.deepEqual(waits, [1500], "one wait, of the given length, before the last ref check");
});

test("fix round 4 (7r), M3: refs that hosting services own (refs/pull, refs/merge-requests, refs/changes, refs/notes, refs/remotes, refs/keep-around) changing during the run don't stop it", async () => {
  for (const ref of ["refs/pull/1/merge", "refs/merge-requests/1/head", "refs/changes/01/1/1", "refs/notes/commits", "refs/remotes/zork/main", "refs/keep-around/zork"]) {
    const c = twoCommits(block("step: echo zork-step", "check: true", "rollback: true"));
    const first = git(c.repo, "rev-parse", "HEAD~1");
    const outside = () => git(c.base, "--git-dir=remote.git", "update-ref", ref, first); // someone else, on the remote itself
    const { io } = realBindIo(c, { effects: { "echo zork-step": outside } });
    const r = await ship(c, io);
    assert.equal(r.status, 0, `${ref}: ${r.out}`);
    assert.match(r.out, /^shipped [0-9a-f]{40}$/m, ref);
  }
  // Another branch or a tag: kept as a stop, and the message says it may be someone else.
  const k = twoCommits(block("step: echo zork-step", "check: true", "rollback: true"));
  const kfirst = git(k.repo, "rev-parse", "HEAD~1");
  const { io: kio } = realBindIo(k, { effects: { "echo zork-step": () => git(k.base, "--git-dir=remote.git", "update-ref", "refs/heads/zork-bot", kfirst) } });
  const stopped = await ship(k, kio);
  assert.equal(stopped.status, 3, stopped.out);
  assert.match(stopped.out, /a ref changed by something else \(CI, another person\) is indistinguishable from a push this run did not intend/);
  assert.match(stopped.out, /^ {2}refs\/heads\/zork-bot$/m);
});

test("fix round 5 (7r), A: a check that passed while a ref of origin changed stops the run (exit 3) and rolls nothing back; a failing check with a ref change rolls back (exit 4)", async () => {
  // A passing check, and a tag someone else made on origin meanwhile: the deploy is good, so nothing is undone.
  const c = twoCommits(block("step: true", "check: echo zork-check", "check: echo zork-check-2", "rollback: echo zork-rollback-1", "rollback: echo zork-rollback-2"));
  const first = git(c.repo, "rev-parse", "HEAD~1");
  const { io } = realBindIo(c, { effects: { "echo zork-check": () => git(c.base, "--git-dir=remote.git", "update-ref", "refs/tags/zork-ci", first) } });
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /after check 1 origin's refs changed, and no strict push step can explain it; the check passed, so nothing was rolled back; origin's main is HEAD/);
  assert.match(r.out, /^ {2}refs\/tags\/zork-ci$/m);
  assert.deepEqual(c.ran(), ["true", "echo zork-check"], "no later check and no rollback line");
  // The same change while the check fails: the rollback lines run, the change is reported, and the exit is 4.
  const k = twoCommits(block("step: true", "check: exit 1", "rollback: echo zork-rollback-1", "rollback: echo zork-rollback-2"));
  const kfirst = git(k.repo, "rev-parse", "HEAD~1");
  const { io: kio } = realBindIo(k, { effects: { "exit 1": () => git(k.base, "--git-dir=remote.git", "update-ref", "refs/tags/zork-ci", kfirst) } });
  const failed = await ship(k, kio);
  assert.equal(failed.status, 4, failed.out);
  assert.match(failed.out, /after check 1 origin's refs changed, and no strict push step can explain it \(reported; the check failed, so the rollback lines run\)/);
  assert.match(failed.out, /^ {2}refs\/tags\/zork-ci$/m);
  assert.deepEqual(k.ran(), ["true", "exit 1", "echo zork-rollback-1", "echo zork-rollback-2"]);
});

test("fix round 5 (7r), A: a ref of origin that changes after a rollback line is reported, and the later rollback lines still run", async () => {
  const c = twoCommits(block("step: true", "check: false", "rollback: echo zork-rollback-1", "rollback: echo zork-rollback-2"));
  const first = git(c.repo, "rev-parse", "HEAD~1");
  const { io } = realBindIo(c, { effects: { "echo zork-rollback-1": () => git(c.base, "--git-dir=remote.git", "update-ref", "refs/heads/zork-bot", first) } });
  const r = await ship(c, io);
  assert.equal(r.status, 4, r.out);
  assert.match(r.out, /after rollback 1 origin's refs changed, and no strict push step can explain it \(reported; the later rollback lines still run\)/);
  assert.match(r.out, /^ {2}refs\/heads\/zork-bot$/m);
  assert.deepEqual(c.ran(), ["true", "false", "echo zork-rollback-1", "echo zork-rollback-2"]);
});

test("fix round 5 (7r), A: origin's refs that can't be read after a passing check stop the run (exit 3) and roll nothing back", async () => {
  let calls = 0;
  const base = fakeGit();
  const git3 = (args, opts) => { if (args.includes("ls-remote") && ++calls > 2) throw new Error("offline"); return base(args, opts); };
  const r = await fakeShip(block("step: true", "check: true", "rollback: echo zork-rollback"), { git: git3 });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /after check 1 origin's refs could not be read \(git ls-remote failed or timed out\); the check passed, so nothing was rolled back; origin's main could not be read/);
  assert.deepEqual(r.ran, ["true", "true"], "no rollback line");
});

test("fix round 4 (7r): a failed step still gets its ref check: a ref it pushed before failing is named, and the exit stays 1", async () => {
  const c = twoCommits(block("step: exit 1", "check: true", "rollback: true"));
  const first = git(c.repo, "rev-parse", "HEAD~1");
  const { io } = realBindIo(c, { effects: { "exit 1": () => git(c.repo, "push", "-q", "origin", `${first}:refs/heads/evil`) } });
  const r = await ship(c, io);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /origin's refs changed during step 1/);
  assert.match(r.out, /^ {2}refs\/heads\/evil$/m);
});

test("fix round 4 (7r): a rollback line is followed by its own ref check (what it changed is reported, and the later rollback lines still run), and ls-remote runs with its own 60-second timeout", async () => {
  const c = twoCommits(block("step: true", "check: false", "rollback: echo zork-rollback", "rollback: echo zork-rollback-2"));
  const first = git(c.repo, "rev-parse", "HEAD~1");
  const { io } = realBindIo(c, { effects: { "echo zork-rollback": () => git(c.repo, "push", "-q", "origin", `${first}:refs/heads/evil`) } });
  const r = await ship(c, io);
  assert.equal(r.status, 4, r.out);
  assert.match(r.out, /after rollback 1 origin's refs changed/);
  assert.match(r.out, /^ {2}refs\/heads\/evil$/m);
  assert.deepEqual(c.ran(), ["true", "false", "echo zork-rollback", "echo zork-rollback-2"], "the later rollback line still ran (fix round 5)");
  const timeouts = [];
  const base = fakeGit();
  const recorder = (args, opts) => { if (args.includes("ls-remote")) timeouts.push(opts?.timeout); return base(args, opts); };
  const f = await fakeShip(block("step: true", "check: true", "rollback: true"), { git: recorder });
  assert.equal(f.status, 0, f.out);
  assert.ok(timeouts.length >= 3 && timeouts.every((t) => t === 60000), JSON.stringify(timeouts));
});

test("fix round 4 (7r): the log tail withholds a token glued to text by a colour code, split by a backspace or by an OSC sequence, and leaves ordinary progress output alone", () => {
  const dir = scratch();
  const esc = ch(0x1b);
  const cases = [`a${esc}[31m${FAKE_TOKEN}${esc}[0m`, `${FAKE_TOKEN.slice(0, 20)}X\b${FAKE_TOKEN.slice(20)}`, `${FAKE_TOKEN.slice(0, 20)}${esc}]8;;${ch(7)}${FAKE_TOKEN.slice(20)}`];
  for (const line of cases) {
    const f = join(dir, "t.log");
    writeFileSync(f, `ok\n${line}\n`);
    assert.deepEqual(logTail(f, secretShapeIn), ["  ok", `  ${WITHHELD}`], JSON.stringify(line));
  }
  const f = join(dir, "progress.log");
  writeFileSync(f, `[=====>    ] 45% 1.2MB/s\r[==========] 100% 2.4MB/s\n${esc}[32mok${esc}[0m 12 tests passed\nDownloading zork-1.2.3.tgz\n`);
  assert.ok(!logTail(f, secretShapeIn).includes(`  ${WITHHELD}`), "ordinary output is shown");
});

test("fix round 4 (7r): a case in a substitution, a ${ holding a quote and a brace expansion are refused as unreadable (bash reads them as push)", () => {
  for (const form of ["git pu$(case x in x) true;; esac)sh origin main", "git pu${x:+'}'}sh origin main", "git pu{,}sh origin main", "git pu${x:+\"}\"}sh origin main"]) {
    for (const key of ["step", "check", "rollback"]) assert.throws(() => shipBlock(section([...VALID, `${key}: ${form}`])), (e) => e.code === "ship", `${key}: ${form}`);
  }
});

test("fix round 4 (7r), N6: a 64-hex checksum in a lockfile does not stop the ship, but any other shape in it does, and a 64-hex string elsewhere still does", () => {
  const hex = "ab12".repeat(16);
  const diff = (file, line) => ["diff --git a/x b/x", `+++ b/${file}`, "@@ -0,0 +1 @@", `+${line}`].join("\n");
  for (const file of ["Cargo.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "poetry.lock", "Gemfile.lock", "composer.lock", "dist/zork.tgz.sha256", "SHA256SUMS", "sub/dir/Cargo.lock"]) {
    assert.deepEqual(stagedSecrets(diff(file, `checksum = "${hex}"`), secretShapeIn, SECRET_SHAPES), [], file);
    assert.deepEqual(stagedSecrets(diff(file, `token = "${FAKE_TOKEN}" checksum = "${hex}"`), secretShapeIn, SECRET_SHAPES), [{ file, category: "an API key or token" }], `${file}: another shape still stops`);
  }
  for (const file of ["app.js", "Cargo.lock.bak", "my-package-lock.json", "go.sum.txt"]) {
    assert.deepEqual(stagedSecrets(diff(file, `const k = "${hex}";`), secretShapeIn, SECRET_SHAPES), [{ file, category: "a 64-character hex string" }], file);
  }
  assert.deepEqual(stagedSecrets(diff("Cargo.lock", `checksum = "${hex}"`), secretShapeIn), [{ file: "Cargo.lock", category: "a 64-character hex string" }], "without the shapes list nothing is skipped");
});

// ---------- phase 7r, fix round 5 ----------
test("fix round 5 (7r), B: the background refusal reads through folders, .exe, wrapper option values and shell options, and nohup, setsid, disown and coproc count as any plain word", () => {
  const forms = ["/usr/bin/setsid true", "/usr/bin/nohup true", "/usr/bin/at now", "nohup.exe true", "C:/Tools/setsid.exe true", "/usr/bin/batch",
    "nice -n 5 nohup true", "nice -n5 setsid true", "timeout -s KILL 9 setsid true", "timeout -k 5 9 nohup true", "timeout --signal KILL 9 nohup true", "env -u X nohup true", "env -C /tmp setsid true", "env -S x nohup true",
    "stdbuf -o L nohup true", "exec -a zork setsid true", "sudo -u root nohup true", "sudo -g wheel setsid true", "xargs -n 1 nohup true", "xargs -I zork setsid true", "xargs -P 2 at now",
    "bash --norc -c 'sleep 1 &'", "bash --noprofile --norc -c 'sleep 1 &'", "bash -o pipefail -c 'sleep 1 &'", "bash +o posix -c 'sleep 1 &'", "bash -O extglob -c 'sleep 1 &'", "bash -e -c 'sleep 1 &'",
    "bash -lc 'sleep 1 &'", "bash --rcfile x -c 'sleep 1 &'", "bash --init-file x -c 'sleep 1 &'", "/bin/bash -c 'sleep 1 &'", "bash.exe -c 'sleep 1 &'", "sh -ec 'nohup true'", "env bash --norc -c 'setsid true'",
    "chronic nohup true", "ionice -c3 setsid true", "doas disown", "echo x; zork coproc true", "true && echo nohup"];
  for (const form of forms) for (const key of ["step", "check", "rollback"]) assert.throws(() => shipBlock(section([...VALID, `${key}: ${form}`])), (e) => e.code === "ship", `${key}: ${form}`);
  // Still valid: at and batch as ordinary words, quoted text, wrappers with their values, a shell with options and no job, and what a deploy uses.
  for (const form of ["echo deployed at noon", "grep -r at .", "echo batch done", "bash --norc -c 'echo hi'", "bash -o pipefail -c 'npm test | tee out.txt'", "nice -n 5 npm test", "timeout -s KILL 9 npm test", "env -u X npm test",
    "stdbuf -o L npm test", "echo 'run nohup later'", "sudo -u deploy systemctl restart zork", "pm2 reload zork", "tmux new-session -d zork", "systemd-run --user true"]) {
    for (const key of ["step", "check", "rollback"]) assert.ok(shipBlock(section([...VALID, `${key}: ${form}`])), `${key}: ${form}`);
  }
});

test("fix round 5 (7r): the log tail withholds a token cut by a string sequence (DCS, APC, PM, SOS, OSC), hidden by a carriage-return overwrite, split by a tab or percent-encoded, and leaves progress output alone", () => {
  const dir = scratch();
  const esc = ch(0x1b);
  const st = `${esc}\\`;
  const half = (a) => [FAKE_TOKEN.slice(0, 20), FAKE_TOKEN.slice(20)].join(a);
  const cases = [half(`${esc}Pzork${st}`), half(`${esc}_zork${st}`), half(`${esc}^zork${st}`), half(`${esc}Xzork${st}`), half(`${esc}]0;zork${ch(7)}`), half(`${esc}]0;zork${st}`),
    `${FAKE_TOKEN.slice(4)}\r${FAKE_TOKEN.slice(0, 4)}`, half("\t"), FAKE_TOKEN.replace("_", "%5F"), FAKE_TOKEN.replace("_", "%5f")];
  for (const line of cases) {
    const f = join(dir, "t.log");
    writeFileSync(f, `ok\n${line}\n`);
    assert.deepEqual(logTail(f, secretShapeIn), ["  ok", `  ${WITHHELD}`], JSON.stringify(line));
  }
  const f = join(dir, "progress.log");
  writeFileSync(f, `\r 45% |#####     | 1.2MB/s\r100% |##########| 2.4MB/s\n${esc}]0;npm install${ch(7)}added 120 packages in 3s\nGET /search?q=zork%20acmecorp 200\t12ms\n`);
  assert.ok(!logTail(f, secretShapeIn).includes(`  ${WITHHELD}`), "ordinary output is shown");
});

// ---------- phase 7r, fix round 6 ----------
test("fix round 6 (7r), B1: a shell's -c or its command text written with a quote or a backslash is read as bash reads it, and refused when it can't be (fail closed)", () => {
  const forms = ["bash '-c' 'X &'", "bash \"-c\" 'X &'", "bash \\-c 'X &'", "bash -\\c 'X &'", "bash -c'' 'X &'", "bash -c\"\" 'X &'", "env bash '-c' 'X &'", "bash -c 'X '\\&", "sh -c \"X \"\\&",
    "bash -c 'bash -c \"X \"\\&'", "env -S'bash -c \"X &\"'", "env --split-string='bash -c \"X &\"'", "env -S 'nohup true'", "bash -c -- 'X &'", "bash -c -e 'X &'", "fish -c 'X &'", "csh -c 'X &'", "tcsh -c 'X &'",
    "bash --norc 'script.sh'", "bash -c \"echo \\\"a\\\" &\"", "env -Sat now", "env --split-string=at now", "bash -c 'echo hi'\\x", "sh -c \\echo"];
  for (const form of forms) for (const key of ["step", "check", "rollback"]) assert.throws(() => shipBlock(section([...VALID, `${key}: ${form}`])), (e) => e.code === "ship", `${key}: ${form}`);
  for (const form of ["bash -c 'echo hi'", "bash -c -- 'echo hi'", "bash -o pipefail -c 'npm test | tee out.txt'", "sh -c \"npm test\"", "bash scripts/check.sh", "env -S 'npm test'", "fish -c 'echo hi'"]) {
    for (const key of ["step", "check", "rollback"]) assert.ok(shipBlock(section([...VALID, `${key}: ${form}`])), `${key}: ${form}`);
  }
});

test("fix round 6 (7r), L2: at and batch can't sit behind a keyword's or a wrapper's options, and a wrapper option the reader does not know is refused", () => {
  const forms = ["time -p at now", "sudo -iu bob at now", "exec -ca z at now", "ionice -c 3 at now", "timeout 9 at now", "nice -n 5 -- at now", "sudo -u bob -- batch", "xargs -0 -n 1 at now",
    "chrt -f 99 at now", "taskset -c 0 at now", "nsenter -t 1 at now", "unshare -m at now", "flock /tmp/x at now", "flock -c 'at now' /tmp/x", "setpriv --reuid 1 at now", "runuser -u bob -- at now", "su -c 'at now' bob",
    "nice --zork 5 npm test", "timeout --zork 9 npm test", "env --zork x npm test", "nice -z 5 npm test", "timeout -z 9 npm test", "sudo -Z bob npm test"];
  for (const form of forms) for (const key of ["step", "check", "rollback"]) assert.throws(() => shipBlock(section([...VALID, `${key}: ${form}`])), (e) => e.code === "ship", `${key}: ${form}`);
  for (const form of ["nice -n 5 npm test", "nice -5 npm test", "timeout -s KILL 9 npm test", "timeout 9 npm test", "ionice -c 3 npm test", "time -p npm test", "sudo -iu deploy systemctl restart zork", "env -i PATH=/bin npm test",
    "xargs -0 -n 1 echo", "stdbuf -oL npm test", "command -v npm", "echo deployed at noon"]) {
    for (const key of ["step", "check", "rollback"]) assert.ok(shipBlock(section([...VALID, `${key}: ${form}`])), `${key}: ${form}`);
  }
});

test("fix round 6 (7r), L4: ;& and ;;& are case separators, and the operators with & stay valid; a lone & is still refused", () => {
  for (const form of ["case x in x) true ;& y) true ;; esac", "case x in x) true ;;& *) true ;; esac", "npm test |& tee out.txt", "echo x >&2", "npm test &> out.txt", "npm test 2>&1"]) {
    for (const key of ["step", "check", "rollback"]) assert.ok(shipBlock(section([...VALID, `${key}: ${form}`])), `${key}: ${form}`);
  }
  for (const form of ["true &", "case x in x) true & ;; esac"]) assert.throws(() => shipBlock(section([...VALID, `step: ${form}`])), (e) => e.code === "ship", form);
});

test("fix round 6 (7r), L3: the log tail withholds a token cut by an nF escape, by a string sequence never ended, or by an 8-bit string sequence, and leaves ordinary output alone", () => {
  const dir = scratch();
  const esc = ch(0x1b);
  const half = (a) => [FAKE_TOKEN.slice(0, 20), FAKE_TOKEN.slice(20)].join(a);
  const cases = [half(`${esc}(B`), half(`${esc}#8`), half(`${esc})0`), half(`${esc}]`), half(`${esc}P`), half(`${esc}_`), half(`${esc}]0;`),
    half(`${ch(0x90)}1;2|z${ch(0x9c)}`), half(`${ch(0x9d)}0;z|k${ch(7)}`), half(`${ch(0x9f)}a;b${ch(0x9c)}`), half(`${ch(0x98)}s:t${ch(0x9c)}`)];
  for (const line of cases) {
    const f = join(dir, "t.log");
    writeFileSync(f, `ok\n${line}\n`);
    assert.deepEqual(logTail(f, secretShapeIn), ["  ok", `  ${WITHHELD}`], JSON.stringify(line));
  }
  const f = join(dir, "plain.log");
  writeFileSync(f, `${esc}(Bdone in 3s${esc}(B\n${esc}]0;npm test\nbuild ${esc}#8 ok\n`);
  assert.ok(!logTail(f, secretShapeIn).includes(`  ${WITHHELD}`), "ordinary output is shown");
});

test("fix round 6 (7r), L1: a passing check whose ref check trips, in a block that never pushed, says origin's branch is unchanged and this run did not push HEAD", async () => {
  const c = shipCase(block("step: echo deployed-with-a-tool", "check: echo zork-check", "rollback: echo zork-rollback"));
  git(c.repo, "commit", "-q", "--allow-empty", "-m", "ahead of origin");
  assert.equal(recordPreview(c).status, 0);
  const remote = remoteMain(c);
  const { io } = realBindIo(c, { effects: { "echo zork-check": () => git(c.base, "--git-dir=remote.git", "update-ref", "refs/tags/zork-ci", remote) } });
  const r = await ship(c, io);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /the check passed, so nothing was rolled back; origin's main is unchanged; this run did not push HEAD/);
  assert.doesNotMatch(r.out, /the deployed commit is not what was shipped/);
  assert.deepEqual(c.ran(), ["echo deployed-with-a-tool", "echo zork-check"]);
});

test("fix round 6 (7r): after a failing check whose refs can't be read, the rollback lines still run (exit 4) and the read failure is reported", async () => {
  let calls = 0;
  const base = fakeGit();
  const git3 = (args, opts) => { if (args.includes("ls-remote") && ++calls > 2) throw new Error("offline"); return base(args, opts); };
  const r = await fakeShip(block("step: true", "check: false", "rollback: echo zork-rollback-1", "rollback: echo zork-rollback-2"), { git: git3 });
  assert.equal(r.status, 4, r.out);
  assert.match(r.out, /after check 1 origin's refs could not be read \(git ls-remote failed or timed out\) \(reported; the check failed, so the rollback lines run\)/);
  assert.deepEqual(r.ran, ["true", "false", "echo zork-rollback-1", "echo zork-rollback-2"]);
});
