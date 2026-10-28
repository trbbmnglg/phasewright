// Run with: node --test tests/dashboard.test.mjs
// Covers plugins/phased-shipping/skills/dashboard/scripts/status.mjs and collect.mjs (phase 7d2): the opt-in, the
// project list, the session files, the fail-closed folders, the atomic writes, and the merged JSON (containment,
// the history join, session states, caps, no absolute path in the output, the module lookup in both layouts).
// Every project and data folder here is a synthetic temp folder (made-up names such as zork and acmecorp), every
// temp folder is removed afterwards, and nothing is written to the real data folder. Files the guard protects by name
// (a roadmap file, a plan file) are created by the test at run time; control, format and bidirectional characters
// are built with String.fromCodePoint, never stored.
// The helpers it shares with tests/regression-pack.test.mjs are in tests/helpers/dashboard.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, symlinkSync, linkSync, renameSync, cpSync, statSync, lstatSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { main as status } from "../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";
import { main as collect } from "../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import { WIN, NOW, cp, RM, PLANS, tmp, put, read, readJson, listing, snapshot, world, st, col, enable, setStatus, register, sessionFiles, idFor, row, roadmap, planText, noPath, seeded, phaseRows, BS, shipped, repoWorld } from "./helpers/dashboard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const PS = join(REPO, "plugins", "phased-shipping");
const SCRIPTS = join(PS, "skills", "dashboard", "scripts");
const STATUS_SRC = readFileSync(join(SCRIPTS, "status.mjs"), "utf8");
const COLLECT_SRC = readFileSync(join(SCRIPTS, "collect.mjs"), "utf8");
const MIN = 60000;
// The session file name `set` writes for a phase in a roadmap: <id>-<6 hex of the SHA-256 of the roadmap path>+<phase in lower case>.json.
// The path is lower-cased for the tag only where the file system ignores letter case (Windows, macOS), as the scripts do by default.
const FOLDS = process.platform === "win32" || process.platform === "darwin";
const tagFor = (roadmapPath, folds = FOLDS) => createHash("sha256").update(folds ? roadmapPath.toLowerCase() : roadmapPath).digest("hex").slice(0, 6);
const sname = (id, phase, roadmapPath = RM, folds = FOLDS) => `${id}-${tagFor(roadmapPath, folds)}+${phase.toLowerCase()}.json`;
const CANARY = "CANARY_OUTSIDE_TEXT";
test("status: enable then set writes the session file and registers the project with its label", () => {
  const w = world("on");
  const p = w.proj("zork");
  enable(w);
  const r = setStatus(w, p, "7d2", "build", "working", ["--label", "zork-app", "--name", "Zork thing"]);
  assert.equal(r.code, 0, r.err);
  const reg = readJson(w.data, "projects.json");
  assert.equal(reg.v, 1);
  assert.equal(reg.projects.length, 1);
  const e = reg.projects[0];
  assert.match(e.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(e.labels, ["zork-app"]);
  assert.deepEqual(e.roadmaps, [RM]);
  assert.equal(e.name, "zork");
  assert.equal(e.path.toLowerCase(), realpathSync.native(p).toLowerCase());
  assert.deepEqual(sessionFiles(w), [sname(e.id, "7d2")]);
  const s = readJson(w.data, `sessions/${sname(e.id, "7d2")}`);
  assert.deepEqual(s, { v: 1, project: e.id, roadmap: RM, phase: "7d2", phase_name: "Zork thing", step: "build", state: "working", step_started: NOW, updated: NOW });
  assert.equal(readJson(w.data, "dashboard.json").enabled, true);
});
test("status: set keeps step_started within a step and moves it when the step changes", () => {
  const w = world("steps");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working", ["--name", "Zork thing"], { now: () => NOW });
  const f = () => readJson(w.data, `sessions/${sessionFiles(w)[0]}`);
  setStatus(w, p, "1", "build", "waiting", [], { now: () => NOW + 5000 });
  assert.equal(f().step_started, NOW);
  assert.equal(f().updated, NOW + 5000);
  assert.equal(f().phase_name, "Zork thing", "the name stays when a later call gives none");
  setStatus(w, p, "1", "compare", "working", [], { now: () => NOW + 9000 });
  assert.equal(f().step_started, NOW + 9000);
});
test("status: asked records the question without turning the dashboard on", () => {
  const w = world("asked");
  const p = w.proj();
  const r = st(["asked", "--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const cfg = readJson(w.data, "dashboard.json");
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.asked, "2026-10-27");
  const s = st(["state", "--data", w.data]);
  assert.ok(s.out.includes("dashboard: off") && s.out.includes("asked: yes"));
  assert.ok(setStatus(w, p, "1", "build", "working").out.includes("nothing written"));
  assert.deepEqual(listing(w.data), ["dashboard.json"]);
});
test("status: an explicit register while off exits 1 and writes nothing, even after asked", () => {
  const w = world("regoff");
  const p = w.proj();
  const r = register(w, p);
  assert.equal(r.code, 1);
  assert.ok(/enable/.test(r.err));
  assert.ok(!existsSync(w.data));
  st(["asked", "--data", w.data]);
  const before = snapshot(w.data);
  assert.equal(register(w, p).code, 1);
  assert.equal(snapshot(w.data), before);
});
test("status: unregister removes only that entry, and works while the dashboard is off", () => {
  const w = world("unreg");
  const a = w.proj("zork");
  const b = w.proj("acmecorp");
  enable(w);
  const ida = idFor(w, a);
  const idb = idFor(w, b);
  assert.notEqual(ida, idb);
  assert.equal(st(["unregister", "nothex", "--data", w.data]).code, 2);
  assert.equal(st(["unregister", "0".repeat(12), "--data", w.data]).code, 1);
  const r = st(["unregister", ida, "--data", w.data]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readJson(w.data, "projects.json").projects.map((x) => x.id), [idb]);
  // while the dashboard is off it still works: it exits 0, says what it removed and changes nothing but projects.json
  st(["disable", "--data", w.data]);
  const config = read(w.data, "dashboard.json");
  const off = st(["unregister", idb, "--data", w.data]);
  assert.equal(off.code, 0, off.err);
  assert.ok(off.out.includes("removed: acmecorp") && off.out.includes(idb), off.out);
  assert.deepEqual(readJson(w.data, "projects.json").projects, []);
  assert.equal(read(w.data, "dashboard.json"), config, "the setting file is untouched");
  assert.deepEqual(listing(w.data), ["dashboard.json", "projects.json"], "nothing else was written");
  // with nothing to remove it still writes nothing, and a data folder that is not there is not created
  const before = snapshot(w.data);
  assert.equal(st(["unregister", idb, "--data", w.data]).code, 1);
  assert.equal(snapshot(w.data), before);
  const fresh = world("unreg-fresh");
  assert.equal(st(["unregister", idb, "--data", fresh.data]).code, 1);
  assert.ok(!existsSync(fresh.data));
});
test("status: ids are stable for the same folder, differ for two folders, and ignore letter case on Windows", () => {
  const w = world("ids");
  const a = w.proj("zork");
  const b = w.proj("acmecorp");
  enable(w);
  const first = idFor(w, a);
  const again = register(w, a);
  assert.ok(again.out.includes("already listed") && again.out.includes(first));
  assert.notEqual(idFor(w, b), first);
  assert.equal(readJson(w.data, "projects.json").projects.length, 2);
  if (WIN) {
    const real = realpathSync.native(a);
    for (const spelled of [real.toUpperCase(), real.toLowerCase()]) {
      const r = register(w, spelled);
      assert.equal(r.code, 0, r.err);
      assert.ok(r.out.includes(first), "the same folder in another letter case is the same id");
    }
    assert.equal(readJson(w.data, "projects.json").projects.length, 2);
  }
});
test("status: a bad phase id, step or state is refused with exit 2 and nothing is written", () => {
  const w = world("bad");
  const p = w.proj();
  enable(w);
  const before = snapshot(w.data);
  const outside = snapshot(w.base);
  for (const phase of ["a/b", "..", ".", "a..\\b", "C:x", "a b", "", "x".repeat(41), "../../evil", `a${cp(0)}b`]) {
    const r = setStatus(w, p, phase, "build", "working");
    assert.equal(r.code, 2, `phase ${JSON.stringify(phase)}`);
    assert.equal(st(["clear", "--data", w.data, "--root", p, "--phase", phase]).code, 2);
  }
  assert.equal(setStatus(w, p, "1", "deploy", "working").code, 2, "unknown step");
  assert.equal(setStatus(w, p, "1", "build", "paused").code, 2, "unknown state");
  assert.equal(snapshot(w.data), before);
  assert.equal(snapshot(w.base), outside, "nothing was written anywhere else");
  assert.equal(setStatus(w, p, "1.0_a-b", "prod-check", "done").code, 0, "a plain id is accepted");
});
test("status: arguments are checked: unknown option, a missing --data, a repeated single option, a missing folder", () => {
  const w = world("args");
  const p = w.proj();
  enable(w);
  assert.equal(st(["state"]).code, 2);
  assert.equal(st(["state", "--data", w.data, "--data", w.data]).code, 2);
  assert.equal(st(["state", "--data", w.data, "--bogus"]).code, 2);
  assert.equal(st(["nothing", "--data", w.data]).code, 2);
  assert.equal(st([]).code, 2);
  assert.equal(st(["register", "--data", w.data]).code, 2);
  assert.equal(st(["register", "--data", w.data, "--root", p, "--roadmap", "../x.md"]).code, 2);
  assert.equal(st(["register", "--data", w.data, "--root", p, "--roadmap", "C:/x.md"]).code, 2);
  assert.equal(st(["register", "--data", w.data, "--root", p, "--roadmap", "notes.txt"]).code, 2);
  assert.equal(st(["register", "--data", w.data, "--root", p, "--label", cp(0x200b)]).code, 2, "a label that is empty after cleaning");
  const missing = join(w.base, "no-such-folder");
  const r = setStatus(w, missing, "1", "build", "working");
  assert.equal(r.code, 1);
  assert.ok(!r.all.includes("no-such-folder") && !r.all.includes(w.base), "the error names no path");
  assert.equal(st(["register", "--data", w.data, "--root", p, "--roadmap", "docs\\plan.md"]).code, 0, "a Windows-style relative path is normalised");
  assert.deepEqual(readJson(w.data, "projects.json").projects[0].roadmaps, [RM, "docs/plan.md"]);
});
test("status: a session file over 16 KB is never written and the old one stays whole", () => {
  const w = world("big");
  const p = w.proj();
  enable(w);
  assert.equal(setStatus(w, p, "1", "build", "working", ["--name", "first"]).code, 0);
  const file = `sessions/${sessionFiles(w)[0]}`;
  const before = read(w.data, file);
  const r = setStatus(w, p, "1", "build", "waiting", ["--name", "y".repeat(200)], { maxSessionBytes: 100 });
  assert.equal(r.code, 1);
  assert.ok(/16 KB/.test(r.err));
  assert.equal(read(w.data, file), before);
  assert.ok(STATUS_SRC.includes("16 * 1024"), "the real limit is 16 KB");
  assert.ok(!sessionFiles(w).some((n) => n.includes(".tmp-")));
});

// ── status.mjs: links and fail-closed folders ───────────────────────────────
test("status: a data folder that is a link, or a folder where a file belongs, fails closed and writes nothing through it", (t) => {
  const w = world("links");
  const p = w.proj();
  const target = tmp("target");
  let linked = true;
  try { symlinkSync(target, w.data, "junction"); } catch { linked = false; }
  if (!linked) { t.skip("this machine cannot create links"); return; }
  for (const argv of [["enable"], ["state"], ["asked"], ["list"]]) {
    const r = st([...argv, "--data", w.data]);
    assert.equal(r.code, 1, argv[0]);
    assert.ok(/link/.test(r.err), r.err);
  }
  assert.equal(setStatus(w, p, "1", "build", "working").code, 1);
  assert.deepEqual(readdirSync(target), [], "nothing was written through the link");
});
test("status: a file in the data folder that is a link, a hard link or a folder fails closed", (t) => {
  const w = world("filelinks");
  const p = w.proj();
  const outside = tmp("outside");
  put(outside, "other.json", CANARY);
  enable(w);
  // dashboard.json as a folder
  const cfg = join(w.data, "dashboard.json");
  const saved = readFileSync(cfg);
  rmSync(cfg);
  mkdirSync(cfg);
  for (const argv of [["state"], ["enable"], ["disable"]]) assert.equal(st([...argv, "--data", w.data]).code, 1, `${argv[0]} with a folder in place of dashboard.json`);
  rmSync(cfg, { recursive: true });
  writeFileSync(cfg, saved);
  // projects.json as a folder, and sessions as a file
  mkdirSync(join(w.data, "projects.json"));
  assert.equal(setStatus(w, p, "1", "build", "working").code, 1);
  assert.equal(register(w, p).code, 1);
  rmSync(join(w.data, "projects.json"), { recursive: true });
  writeFileSync(join(w.data, "sessions"), "not a folder");
  assert.equal(setStatus(w, p, "1", "build", "working").code, 1);
  rmSync(join(w.data, "sessions"));
  // a hard link at projects.json
  let hard = true;
  try { linkSync(join(outside, "other.json"), join(w.data, "projects.json")); } catch { hard = false; }
  if (hard) {
    assert.equal(setStatus(w, p, "1", "build", "working").code, 1);
    assert.equal(register(w, p).code, 1);
    assert.equal(readFileSync(join(outside, "other.json"), "utf8"), CANARY, "the file behind the hard link is untouched");
    rmSync(join(w.data, "projects.json"));
  }
  // a symbolic link at dashboard.json
  rmSync(cfg);
  let sym = true;
  try { symlinkSync(join(outside, "other.json"), cfg, "file"); } catch { sym = false; }
  if (sym) {
    assert.equal(st(["enable", "--data", w.data]).code, 1);
    assert.equal(st(["state", "--data", w.data]).code, 1);
    assert.equal(readFileSync(join(outside, "other.json"), "utf8"), CANARY, "nothing was written through the link");
  }
  if (!hard && !sym) t.diagnostic("this machine cannot create file links; only the folder cases ran");
});
test("status: a project list or settings file edited into a bad shape stops the command and is left as it is", () => {
  const w = world("hand");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working");
  const reg = readJson(w.data, "projects.json");
  for (const bad of ["{not json", JSON.stringify({ v: 2, projects: [] }), JSON.stringify({ v: 1, projects: [{ ...reg.projects[0], id: "ZZ" }] }), JSON.stringify({ v: 1, projects: [{ ...reg.projects[0], roadmaps: [5] }] }), JSON.stringify({ v: 1, projects: [{ ...reg.projects[0], labels: [1] }] })]) {
    writeFileSync(join(w.data, "projects.json"), bad);
    for (const r of [setStatus(w, p, "2", "build", "working"), register(w, p), st(["list", "--data", w.data])]) assert.equal(r.code, 1, bad);
    assert.equal(read(w.data, "projects.json"), bad, "the file was not rewritten");
  }
  writeFileSync(join(w.data, "projects.json"), JSON.stringify(reg));
  writeFileSync(join(w.data, "dashboard.json"), JSON.stringify({ v: 1, enabled: "yes", asked: null, warnMin: 90, idleMin: 180 }));
  assert.equal(st(["state", "--data", w.data]).code, 1);
  assert.equal(setStatus(w, p, "2", "build", "working").code, 1);
});

// ── status.mjs: atomic writes, caps, output ─────────────────────────────────
test("status: an injected rename failure leaves the old files whole and no temp file behind", () => {
  const w = world("atomic");
  const p = w.proj("zork");
  const q = w.proj("acmecorp");
  enable(w);
  assert.equal(setStatus(w, p, "1", "build", "working").code, 0);
  const before = snapshot(w.data);
  const boom = () => { throw Object.assign(new Error("injected"), { code: "EIO" }); };
  const failing = [
    st(["register", "--data", w.data, "--root", q], { rename: boom }),
    st(["disable", "--data", w.data], { rename: boom }),
    st(["asked", "--data", w.data], { rename: boom }),
    st(["unregister", readJson(w.data, "projects.json").projects[0].id, "--data", w.data], { rename: boom }),
    setStatus(w, p, "1", "compare", "working", [], { rename: boom }),
    setStatus(w, q, "9", "build", "working", [], { rename: boom }),
  ];
  for (const r of failing) assert.equal(r.code, 1, r.all);
  assert.equal(snapshot(w.data), before, "the files are whole and no temp file is left");
  assert.equal(readJson(w.data, "dashboard.json").enabled, true);
});
test("status: on Windows a rename refused for a moment is retried; elsewhere it is not", () => {
  const w = world("retry");
  enable(w);
  let calls = 0;
  const flaky = (a, b) => { if (calls++ < 2) throw Object.assign(new Error("busy"), { code: "EPERM" }); renameSync(a, b); };
  const r = st(["disable", "--data", w.data], { rename: flaky });
  if (WIN) {
    assert.equal(r.code, 0, r.err);
    assert.equal(calls, 3);
    assert.equal(readJson(w.data, "dashboard.json").enabled, false);
  } else {
    assert.equal(r.code, 1);
    assert.equal(calls, 1);
    assert.equal(readJson(w.data, "dashboard.json").enabled, true);
  }
  assert.ok(!listing(w.data).some((n) => n.includes(".tmp-")));
});
test("status: the project list holds at most 100 projects", () => {
  const w = world("cap");
  enable(w);
  const folders = Array.from({ length: 101 }, (_, i) => w.proj(`p${i}`));
  for (let i = 0; i < 100; i++) assert.equal(register(w, folders[i]).code, 0, `project ${i}`);
  const r = register(w, folders[100]);
  assert.equal(r.code, 1);
  assert.ok(/full/.test(r.err));
  assert.equal(setStatus(w, folders[100], "1", "build", "working").code, 1, "the automatic registration is capped too");
  assert.equal(readJson(w.data, "projects.json").projects.length, 100);
  assert.deepEqual(sessionFiles(w), [], "no session file was written for the project that did not fit");
});
test("collect: a roadmap and its plan files merge into the schema, with the plan timestamps", async () => {
  const { w } = seeded("merge");
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const j = r.json();
  assert.equal(j.v, 1);
  assert.equal(j.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(j.thresholds, { warnMin: 90, idleMin: 180 });
  assert.equal(j.projects.length, 1);
  const proj = j.projects[0];
  assert.equal(proj.status, "ok");
  assert.equal(proj.name, "zork");
  assert.match(proj.id, /^[0-9a-f]{12}$/);
  assert.equal(proj.roadmaps[0].file, RM);
  assert.equal(proj.roadmaps[0].tables, 1);
  const [one, two] = phaseRows(j);
  assert.deepEqual(Object.keys(one), ["id", "phase", "status", "kind", "priority", "urgency", "estRaw", "estCal", "estimateH", "actual", "commit", "planFile", "timestamps"]);
  assert.equal(one.id, "1");
  assert.equal(one.phase, "Zork thing");
  assert.equal(one.status, "shipped");
  assert.equal(one.estRaw, 2);
  assert.equal(one.estCal, 1.5);
  assert.equal(one.planFile, `${PLANS}/phase-1.md`);
  assert.deepEqual(one.timestamps, { started: "2026-10-01T10:00:00Z", previewed: "2026-10-01T12:00:00Z", approved: null, shipped: null });
  assert.equal(two.planFile, null);
  assert.deepEqual(two.timestamps, { started: null, previewed: null, approved: null, shipped: null });
  assert.deepEqual(proj.errors, []);
  assert.deepEqual([j.sessions, j.warnings, j.errors], [[], [], []]);
  noPath(w, r.out, "output");
});
test("collect: a project folder that moved shows not found, stays listed and is never removed from the list", async () => {
  const { w, p } = seeded("moved");
  const before = read(w.data, "projects.json");
  renameSync(p, join(w.base, "zork-moved"));
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const proj = r.json().projects[0];
  assert.equal(proj.status, "not found");
  assert.equal(proj.name, "zork");
  assert.deepEqual(proj.roadmaps, []);
  assert.equal(read(w.data, "projects.json"), before, "the tool never edits the list");
  noPath(w, r.out, "output");
  // a hand-edited path that points at another existing folder does not match the id either
  const reg = readJson(w.data, "projects.json");
  reg.projects[0].path = join(w.base, "zork-moved");
  writeFileSync(join(w.data, "projects.json"), JSON.stringify(reg));
  assert.equal((await col(["--data", w.data])).json().projects[0].status, "not found");
});
test("collect: a plan file outside the project is skipped by base name and never read (dot-dot, a link, a junction, a hard link)", async (t) => {
  const outside = tmp("outside");
  put(outside, "outside.md", `${planText("9", "Outside")}${CANARY}\n`);
  put(outside, "docs/plan.md", `${planText("9", "Outside")}${CANARY}\n`);
  const { w, p } = seeded("contain", {
    rows: [row("1", "Dotdot", "planned", "../outside.md"), row("2", "Link", "planned", `${PLANS}/linked.md`), row("3", "Junction", "planned", "docs/plan.md"), row("4", "Hard", "planned", `${PLANS}/hard.md`), row("5", "Absolute", "planned", join(outside, "outside.md")), row("6", "Ok", "shipped", `${PLANS}/phase-1.md`)],
  });
  const roots = [realpathSync.native(outside).toLowerCase(), outside.toLowerCase()];
  const made = [];
  try { symlinkSync(join(outside, "outside.md"), join(p, PLANS, "linked.md"), "file"); made.push("link"); } catch { /* cannot make a file link here */ }
  try { symlinkSync(join(outside, "docs"), join(p, "docs"), "junction"); made.push("junction"); } catch { /* cannot make a junction here */ }
  try { linkSync(join(outside, "outside.md"), join(p, PLANS, "hard.md")); made.push("hard"); } catch { /* cannot make a hard link here */ }
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const proj = r.json().projects[0];
  const reasons = Object.fromEntries(proj.errors.map((e) => [e.file, e.reason]));
  assert.match(reasons["outside.md"], /outside the project folder|not a usable|hard link|symbolic link/);
  assert.equal(reasons["outside.md"] !== undefined, true);
  if (made.includes("link")) assert.match(reasons["linked.md"], /symbolic link or junction/);
  if (made.includes("junction")) assert.match(reasons["plan.md"], /outside the project folder|symbolic link or junction/);
  if (made.includes("hard")) assert.match(reasons["hard.md"], /hard link/);
  assert.equal(proj.errors.every((e) => !/[\\/]/.test(e.file)), true, "errors name base names only");
  for (const read of r.reads) for (const root of roots) assert.ok(!read.toLowerCase().startsWith(root), `a path outside the project was read: ${read}`);
  assert.ok(!r.out.includes(CANARY), "no text of an outside file reached the output");
  const rows = phaseRows(r.json());
  for (const phase of rows.slice(0, 5)) assert.deepEqual(phase.timestamps, { started: null, previewed: null, approved: null, shipped: null }, phase.phase);
  assert.equal(rows[5].timestamps.started, "2026-10-01T10:00:00Z", "the rest of the project still loads");
  if (!made.length) t.diagnostic("this machine cannot create links; only the dot-dot and absolute cases ran");
});
test("collect: a roadmap file that is a hard link or a link, or is listed with a bad path, is skipped and never read", async () => {
  const outside = tmp("outside-rm");
  put(outside, "other.md", roadmap([row("1", CANARY, "planned")]));
  const { w, p } = seeded("rmlink");
  put(p, "docs/real.md", roadmap([row("7", "Docs thing", "planned")]));
  let hard = true;
  try { linkSync(join(outside, "other.md"), join(p, "hard.md")); } catch { hard = false; }
  let sym = true;
  try { symlinkSync(join(outside, "other.md"), join(p, "sym.md"), "file"); } catch { sym = false; }
  assert.equal(register(w, p, ["--roadmap", "hard.md", "--roadmap", "sym.md", "--roadmap", "docs/real.md", "--roadmap", "missing.md"]).code, 0);
  // paths edited into the list by hand, not through the command: a file next to the project and one in the outside folder
  put(w.base, "escape.md", roadmap([row("1", CANARY, "planned")]));
  const reg = readJson(w.data, "projects.json");
  reg.projects[0].roadmaps = [...reg.projects[0].roadmaps, "../escape.md", "sub/../../escape.md", join(outside, "other.md")];
  writeFileSync(join(w.data, "projects.json"), JSON.stringify(reg));
  const ok = await col(["--data", w.data]);
  assert.equal(ok.code, 0, ok.err);
  const proj = ok.json().projects[0];
  const reasons = Object.fromEntries(proj.errors.map((e) => [e.file, e.reason]));
  if (hard) assert.match(reasons["hard.md"], /hard link/);
  if (sym) assert.match(reasons["sym.md"], /symbolic link/);
  assert.equal(reasons["missing.md"], "not found");
  assert.equal(reasons["escape.md"], "not a usable roadmap path");
  assert.deepEqual(proj.roadmaps.map((x) => x.file), [RM, "docs/real.md"]);
  assert.ok(!ok.out.includes(CANARY));
  assert.ok(!ok.reads.some((p) => /escape\.md$/.test(p)), "a roadmap path that leaves the project was never opened");
  for (const read of ok.reads) assert.ok(!read.toLowerCase().startsWith(realpathSync.native(outside).toLowerCase()), `read outside: ${read}`);
});
test("collect: a file over 256 KB is skipped and never read", async () => {
  const big = `${planText("2", "Big")}${"x".repeat(300 * 1024)}\n`;
  const { w } = seeded("large", {
    rows: [row("1", "Zork thing", "shipped", `${PLANS}/phase-1.md`), row("2", "Big", "planned", `${PLANS}/phase-2.md`)],
    files: { [`${PLANS}/phase-2.md`]: big, "docs/BIG.md": roadmap([row("3", "Huge", "planned")]) + "x".repeat(300 * 1024) },
  });
  assert.equal(register(w, join(realpathSync.native(w.base), "zork"), ["--roadmap", "docs/BIG.md"]).code, 0);
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const proj = r.json().projects[0];
  const reasons = Object.fromEntries(proj.errors.map((e) => [e.file, e.reason]));
  assert.match(reasons["phase-2.md"], /too large/);
  assert.match(reasons["BIG.md"], /too large/);
  assert.ok(!r.reads.some((p) => /phase-2\.md$|BIG\.md$/.test(p)), "the oversized files were not read");
  assert.equal(proj.roadmaps.length, 1);
});
test("collect: a run reads a bounded number of bytes in all, and says which files it skipped", async () => {
  const files = {};
  const rows = [];
  for (let i = 1; i <= 4; i++) { files[`${PLANS}/phase-${i}.md`] = `${planText(String(i), `Phase ${i}`)}${"y".repeat(100 * 1024)}\n`; rows.push(row(String(i), `Phase ${i}`, "planned", `${PLANS}/phase-${i}.md`)); }
  const { w } = seeded("budget", { rows, files });
  const r = await col(["--data", w.data], { maxTotalRead: 250 * 1024 });
  assert.equal(r.code, 0, r.err);
  const proj = r.json().projects[0];
  assert.ok(proj.errors.some((e) => /read budget/.test(e.reason)), "a file past the budget is reported");
  assert.ok(phaseRows(r.json()).filter((p) => p.timestamps.started).length >= 1, "the files under the budget were read");
  assert.ok(r.reads.filter((p) => /phase-\d\.md$/.test(p)).length < 4, "not every file was read");
  assert.ok(COLLECT_SRC.includes("MAX_TOTAL_READ = 64 * 1024 * 1024"));
});
test("collect: history joins only the labels stored with the project, never the folder name", async () => {
  const { w } = seeded("history");
  const other = w.proj("acmecorp");
  assert.equal(register(w, other, ["--label", "acmecorp-app"]).code, 0);
  const records = [
    { project: "zork-app", phase: "1", est_h: 2, actual_h: 1.2, check_rounds: 1, caught_by: ["compare"], prod_first_pass: true, rolled_back: false, tokens: { builder: 100, checker: 5, secret: 9 }, note: "EXTRA_FIELD" },
    { project: "zork", phase: "1", est_h: 99 },
    { project: "acmecorp", phase: "1", est_h: 98 },
    { project: "acmecorp-app", phase: "1", est_h: 5 },
    { project: "zork-app", phase: "2", est_h: "bad", actual_h: null, caught_by: ["compare", "nonsense"] },
  ];
  writeFileSync(join(w.data, "history.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\nnot json\n{"phase":"1"}\n`);
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const [zork, acme] = r.json().projects;
  assert.deepEqual(zork.history.map((h) => [h.phase, h.est_h]), [["1", 2], ["2", null]]);
  assert.deepEqual(zork.history[0], { phase: "1", est_h: 2, actual_h: 1.2, check_rounds: 1, caught_by: ["compare"], prod_first_pass: true, rolled_back: false, tokens: { builder: 100, checker: 5 } });
  assert.deepEqual(zork.history[1].caught_by, ["compare"]);
  assert.deepEqual(acme.history.map((h) => h.est_h), [5], "a record with another label that shares a phase id is not joined");
  assert.ok(!r.out.includes("EXTRA_FIELD"), "only the known fields are copied");
});

// ── collect.mjs: sessions ───────────────────────────────────────────────────
test("collect: session states at 89, 90, 179 and 180 minutes (noUpdate and Idle boundaries)", async () => {
  const { w, p } = seeded("states");
  setStatus(w, p, "1", "build", "working", ["--name", "Zork thing"]);
  setStatus(w, p, "2", "approve", "waiting");
  setStatus(w, p, "3", "prod-check", "done");
  const at = async (minutes) => {
    const r = await col(["--data", w.data, "--now", String(NOW + minutes * MIN)]);
    assert.equal(r.code, 0, r.err);
    return Object.fromEntries(r.json().sessions.map((s) => [s.phase, s]));
  };
  const a = await at(89);
  assert.deepEqual([a["1"].shown, a["1"].noUpdate], ["Working", false]);
  assert.deepEqual([a["2"].shown, a["2"].noUpdate], ["Waiting for you", false]);
  assert.deepEqual([a["3"].shown, a["3"].noUpdate], ["Done", false]);
  const b = await at(90);
  assert.deepEqual([b["1"].shown, b["1"].noUpdate], ["Working", true]);
  assert.deepEqual([b["2"].shown, b["2"].noUpdate], ["Waiting for you", false], "only a working session can have no update");
  const c = await at(179);
  assert.deepEqual([c["1"].shown, c["1"].noUpdate], ["Working", true]);
  const d = await at(180);
  assert.deepEqual([d["1"].shown, d["2"].shown, d["3"].shown], ["Idle", "Idle", "Idle"]);
  assert.equal(d["1"].noUpdate, true);
  assert.deepEqual(Object.keys(a["1"]), ["project", "roadmap", "phase", "phase_name", "step", "state", "shown", "noUpdate", "updated", "step_started", "loops", "rounds", "visits", "workedMs", "elapsedMs", "estimateH", "archived"]);
  assert.equal(a["1"].phase_name, "Zork thing");
  // the thresholds come from dashboard.json
  const cfg = readJson(w.data, "dashboard.json");
  writeFileSync(join(w.data, "dashboard.json"), JSON.stringify({ ...cfg, warnMin: 10, idleMin: 20 }));
  const custom = await col(["--data", w.data, "--now", String(NOW + 10 * MIN)]);
  assert.deepEqual(custom.json().thresholds, { warnMin: 10, idleMin: 20 });
  assert.equal(custom.json().sessions.find((s) => s.phase === "1").noUpdate, true);
  assert.equal((await col(["--data", w.data, "--now", String(NOW + 20 * MIN)])).json().sessions.find((s) => s.phase === "1").shown, "Idle");
});
test("collect: two open sessions in one project give the warning; a done or idle one, or another project, does not", async () => {
  const { w, p } = seeded("warn");
  const other = w.proj("acmecorp");
  setStatus(w, p, "1", "build", "working");
  let r = await col(["--data", w.data]);
  assert.deepEqual(r.json().warnings, []);
  setStatus(w, p, "2", "approve", "waiting");
  r = await col(["--data", w.data]);
  const id = r.json().projects[0].id;
  assert.deepEqual(r.json().warnings, [{ kind: "same project, more than one open session", project: id }]);
  setStatus(w, p, "2", "prod-check", "done");
  assert.deepEqual((await col(["--data", w.data])).json().warnings, []);
  setStatus(w, p, "2", "build", "working");
  setStatus(w, other, "1", "build", "working");
  assert.equal((await col(["--data", w.data])).json().warnings.length, 1);
  assert.deepEqual((await col(["--data", w.data, "--now", String(NOW + 200 * MIN)])).json().warnings, [], "idle sessions are not open");
});
test("collect: a session of a project that is not on the list is not shown", async () => {
  const { w, p } = seeded("orphan");
  setStatus(w, p, "1", "build", "working");
  const id = readJson(w.data, "projects.json").projects[0].id;
  assert.equal(st(["unregister", id, "--data", w.data]).code, 0);
  const r = await col(["--data", w.data]);
  assert.deepEqual([r.json().projects, r.json().sessions], [[], []]);
});
test("collect: more than 100 session files are capped, and the output stays under 2 MB with many large roadmaps", async () => {
  const w = world("caps");
  enable(w);
  const folders = [];
  const rows = Array.from({ length: 320 }, (_, i) => row(String(i + 1), `${"p".repeat(190)}${i}`, "planned", "", "n".repeat(150)));
  for (let i = 0; i < 12; i++) {
    const p = w.proj(`big${i}`);
    put(p, RM, roadmap(rows));
    folders.push(p);
    assert.equal(register(w, p).code, 0);
  }
  const id = readJson(w.data, "projects.json").projects[0].id;
  const sdir = join(w.data, "sessions");
  mkdirSync(sdir);
  for (let i = 0; i < 105; i++) {
    const phase = `s${String(i).padStart(3, "0")}`;
    writeFileSync(join(sdir, `${id}-${phase}.json`), JSON.stringify({ v: 1, project: id, phase, phase_name: "n", step: "build", state: "done", step_started: NOW, updated: NOW }));
  }
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  assert.ok(Buffer.byteLength(r.out) <= 2 * 1024 * 1024, `output is ${Buffer.byteLength(r.out)} bytes`);
  const j = r.json();
  assert.equal(j.sessions.length, 100);
  assert.ok(j.errors.some((e) => e.file === "sessions" && /^5 session\(s\) left out: more than 100 live sessions/.test(e.reason)), JSON.stringify(j.errors));
  assert.equal(j.projects.length, 12);
  assert.ok(j.projects[0].roadmaps[0].phases.length <= 300, "phases per project are capped");
  assert.ok(j.projects.some((p) => p.errors.some((e) => /2 MB/.test(e.reason))), "projects past the budget are left out and say so");
  // a list with more than 100 entries is refused
  const reg = readJson(w.data, "projects.json");
  reg.projects = Array.from({ length: 101 }, (_, i) => ({ ...reg.projects[0], id: i.toString(16).padStart(12, "0") }));
  writeFileSync(join(w.data, "projects.json"), JSON.stringify(reg));
  assert.equal((await col(["--data", w.data])).code, 1);
  assert.ok(STATUS_SRC.includes("MAX_PROJECTS = 100") && COLLECT_SRC.includes("MAX_SESSIONS = 100") && COLLECT_SRC.includes("MAX_OUT_BYTES = 2 * 1024 * 1024"));
});
test("collect: --out writes atomically; a failed rename leaves the old file whole; a link or folder as the target is refused", async (t) => {
  const { w } = seeded("out");
  const target = join(w.base, "dash.json");
  const printed = await col(["--data", w.data]);
  const r = await col(["--data", w.data, "--out", target]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith("wrote dash.json") && !r.out.includes(w.base));
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), printed.json());
  const before = readFileSync(target, "utf8");
  const boom = () => { throw Object.assign(new Error("injected"), { code: "EIO" }); };
  const failed = await col(["--data", w.data, "--out", target], { rename: boom });
  assert.equal(failed.code, 1);
  assert.equal(readFileSync(target, "utf8"), before);
  assert.ok(!readdirSync(w.base).some((n) => n.includes(".tmp-")), "no temp file is left");
  mkdirSync(join(w.base, "adir"));
  assert.equal((await col(["--data", w.data, "--out", join(w.base, "adir")])).code, 2, "a folder as the target is refused");
  const outside = tmp("out-outside");
  put(outside, "x.json", CANARY);
  try { symlinkSync(join(outside, "x.json"), join(w.base, "linked.json"), "file"); } catch { t.diagnostic("no file links here"); return; }
  assert.equal((await col(["--data", w.data, "--out", join(w.base, "linked.json")])).code, 1);
  assert.equal(readFileSync(join(outside, "x.json"), "utf8"), CANARY);
});
test("collect: arguments are checked, and an empty or absent data folder gives an empty result", async () => {
  const w = world("collect-args");
  for (const argv of [[], ["--data"], ["--data", w.data, "--now", "abc"], ["--data", w.data, "--bogus"], ["--data", w.data, "extra"], ["--data", w.data, "--data", w.data]]) assert.equal((await col(argv)).code, 2, argv.join(" "));
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().projects, r.json().sessions, r.json().warnings, r.json().errors], [[], [], [], []]);
  assert.ok(!existsSync(w.data), "collect created nothing");
  const target = tmp("data-link");
  const link = join(w.base, "link");
  try { symlinkSync(target, link, "junction"); } catch { return; }
  assert.equal((await col(["--data", link])).code, 1, "a data folder that is a link fails closed");
});

// ── the module lookup, in both layouts ──────────────────────────────────────
function layout(dashName, roadmapName) {
  const root = tmp("layout");
  cpSync(SCRIPTS, join(root, dashName, "scripts"), { recursive: true });
  cpSync(join(PS, "skills", "roadmap", "scripts"), join(root, roadmapName, "scripts"), { recursive: true });
  return join(root, dashName, "scripts", "collect.mjs");
}
function seededData() {
  const { w } = seeded("lookup");
  setStatus(w, join(realpathSync.native(w.base), "zork"), "1", "build", "working");
  return w;
}
const runScript = (script, data) => spawnSync(process.execPath, [script, "--data", data], { encoding: "utf8" });
test("collect: the roadmap module is found in the plugin layout and in the personal-copy layout, and nowhere else", () => {
  const w = seededData();
  for (const [dash, rm] of [["dashboard", "roadmap"], ["ps-dashboard", "ps-roadmap"]]) {
    const r = runScript(layout(dash, rm), w.data);
    assert.equal(r.status, 0, `${dash}: ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.projects[0].roadmaps[0].phases.length, 2);
    assert.equal(j.sessions.length, 1);
  }
  const lonely = tmp("lonely");
  cpSync(SCRIPTS, join(lonely, "dashboard", "scripts"), { recursive: true });
  put(lonely, "elsewhere/scripts/roadmap.mjs", "export const x = 1;\n");
  put(lonely, "somewhere/roadmap/scripts/roadmap.mjs", "export const x = 1;\n");
  const none = runScript(join(lonely, "dashboard", "scripts", "collect.mjs"), w.data);
  assert.equal(none.status, 1);
  assert.ok(/cannot find the roadmap script/.test(none.stderr));
  const stub = layout("dashboard", "roadmap");
  writeFileSync(join(dirname(stub), "..", "..", "roadmap", "scripts", "roadmap.mjs"), "export const parseRoadmap = () => null;\n");
  const lacking = runScript(stub, w.data);
  assert.equal(lacking.status, 1);
  assert.ok(/lacks parseRoadmap/.test(lacking.stderr));
});
test("collect: the scripts import only node: built-ins, and the one dynamic import is the roadmap reader chosen by the script's own folder name", () => {
  for (const [name, src] of [["status.mjs", STATUS_SRC], ["collect.mjs", COLLECT_SRC]]) {
    const froms = [...src.matchAll(/^import [^;]*? from "([^"]+)";/gms)].map((m) => m[1]);
    assert.ok(froms.length > 3, `${name} has imports`);
    for (const f of froms) assert.ok(f.startsWith("node:"), `${name} imports ${f}`);
    assert.ok(!/\brequire\s*\(/.test(src), `${name} has no require`);
  }
  assert.equal([...COLLECT_SRC.matchAll(/\bimport\(/g)].length, 1, "one dynamic import");
  assert.ok(COLLECT_SRC.includes("await import(pathToFileURL(path).href)"), "its argument is a file URL built from a candidate path");
  assert.equal([...STATUS_SRC.matchAll(/\bimport\(/g)].length, 1, "status.mjs has one dynamic import: the page builder next to it");
  assert.ok(STATUS_SRC.includes('await import("./page.mjs")'), "a fixed file of its own folder, no variable");
  assert.ok(COLLECT_SRC.includes('const READER_FOLDER = { dashboard: "roadmap", "ps-dashboard": "ps-roadmap" };'), "the choice holds exactly the two fixed pairs");
  assert.ok(COLLECT_SRC.includes('const path = join(HERE, "..", "..", sibling, "scripts", "roadmap.mjs");'), "one path is built from the chosen sibling");
  assert.ok(!COLLECT_SRC.includes("CANDIDATES"), "there is no list of places to try");
  for (const [name, src] of [["status.mjs", STATUS_SRC], ["collect.mjs", COLLECT_SRC]]) assert.ok(!/fetch\(|node:net|node:http|node:dgram|child_process/.test(src), `${name} uses no network or process module`);
});

// ── the personal copies ─────────────────────────────────────────────────────
test("sync-personal: ps-dashboard is installed byte for byte, ps-run reaches it, and its collect.mjs runs from the personal layout", () => {
  const home = tmp("home");
  const sync = spawnSync(process.execPath, [join(REPO, "scripts", "sync-personal.mjs")], { encoding: "utf8", env: { ...process.env, SYNC_PERSONAL_CLAUDE_HOME: home } });
  assert.equal(sync.status, 0, sync.stderr);
  const dash = join(home, "skills", "ps-dashboard");
  assert.match(readFileSync(join(dash, "SKILL.md"), "utf8"), /^name: ps-dashboard$/m);
  assert.match(readFileSync(join(dash, "SKILL.md"), "utf8"), /^disable-model-invocation: true$/m);
  assert.ok(existsSync(join(dash, "references", "status.md")));
  for (const f of ["status.mjs", "collect.mjs"]) {
    assert.equal(Buffer.compare(readFileSync(join(dash, "scripts", f)), readFileSync(join(SCRIPTS, f))), 0, `${f} is copied byte for byte`);
  }
  const run = readFileSync(join(home, "skills", "ps-run", "SKILL.md"), "utf8");
  assert.ok(run.includes("../ps-dashboard/scripts/status.mjs"));
  assert.doesNotMatch(run, /\.\.\/dashboard\//);
  assert.ok(!run.includes("${CLAUDE_PLUGIN_DATA}"));
  assert.ok(run.includes(join(home, "phased-shipping").split("\\").join("/")), "the data folder token is rewritten");
  assert.ok(run.includes("/ps-dashboard enable"));
  const onboard = readFileSync(join(home, "skills", "ps-onboard", "SKILL.md"), "utf8");
  assert.ok(onboard.includes("/ps-dashboard enable") && !onboard.includes("phased-shipping:"));
  const check = spawnSync(process.execPath, [join(REPO, "scripts", "sync-personal.mjs"), "--check"], { encoding: "utf8", env: { ...process.env, SYNC_PERSONAL_CLAUDE_HOME: home } });
  assert.equal(check.status, 0, check.stdout);
  // the personal copy of collect.mjs finds ps-roadmap next to it
  const w = seededData();
  const r = runScript(join(dash, "scripts", "collect.mjs"), w.data);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.projects[0].roadmaps[0].phases.length, 2);
  assert.equal(j.sessions[0].step, "build");
  // and the personal status.mjs reads the same data folder
  const s = spawnSync(process.execPath, [join(dash, "scripts", "status.mjs"), "state", "--data", w.data], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.ok(s.stdout.includes("dashboard: on"));
});
test("status and collect run as commands: exit codes and output through the real process", () => {
  const w = world("cli");
  const p = w.proj("zork");
  const run = (args) => spawnSync(process.execPath, args, { encoding: "utf8" });
  const state = run([join(SCRIPTS, "status.mjs"), "state", "--data", w.data]);
  assert.equal(state.status, 0, state.stderr);
  assert.ok(state.stdout.includes("dashboard: off"));
  assert.ok(!existsSync(w.data), "state through the real process writes nothing");
  assert.equal(run([join(SCRIPTS, "status.mjs"), "enable", "--data", w.data]).status, 0);
  const set = run([join(SCRIPTS, "status.mjs"), "set", "--data", w.data, "--root", p, "--phase", "1", "--step", "build", "--state", "working"]);
  assert.equal(set.status, 0, set.stderr);
  const c = run([join(SCRIPTS, "collect.mjs"), "--data", w.data]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).sessions.length, 1);
  assert.equal(run([join(SCRIPTS, "status.mjs"), "bogus"]).status, 2);
  assert.ok(statSync(join(SCRIPTS, "status.mjs")).size > 1000);
});

// ── fix round 1 (review findings) ───────────────────────────────────────────
// 1. The run skill never lets text from a file reach a command line.
const RUN_SRC = readFileSync(join(PS, "skills", "run", "SKILL.md"), "utf8");
const ALLOWED_PLACEHOLDERS = [`folder of ${RM}`, "phase id", "label", "step", "state"];
// Every inline code span that runs status.mjs: no --name, no double-quoted placeholder, only the allowed placeholders.
function statusLineProblems(doc, allowed = ALLOWED_PLACEHOLDERS) {
  const spans = doc.match(/`[^`\n]*(?:status|collect)\.mjs[^`\n]*`/g) ?? [];
  const problems = spans.length ? [] : ["no status.mjs command line found"];
  for (const span of spans) {
    if (/--name\b/.test(span)) problems.push(`passes --name: ${span.slice(0, 60)}`);
    if (/"<[^">]*>"/.test(span)) problems.push(`a double-quoted placeholder: ${span.slice(0, 60)}`);
    for (const m of span.matchAll(/<([^<>]*)>/g)) if (!allowed.includes(m[1])) problems.push(`placeholder <${m[1]}>`);
  }
  return problems;
}
test("run skill: every status.mjs command line has no --name, no double-quoted free text and only the allowed placeholders", () => {
  assert.deepEqual(statusLineProblems(RUN_SRC), []);
  // the check itself sees the old, unsafe shapes
  const old = (extra) => `\`node "x/dashboard/scripts/status.mjs" set --data "d" --root '<folder of ${RM}>' ${extra} --step <step> --state <state>\``;
  assert.ok(statusLineProblems(old('--phase <phase id> --name "<phase title>"')).length >= 2, "--name and its quoted placeholder");
  assert.ok(statusLineProblems(old('--phase "<phase id>"')).length >= 1, "a double-quoted placeholder");
  assert.ok(statusLineProblems(old("--phase <phase title>")).length >= 1, "a placeholder that is not allowed");
  assert.ok(statusLineProblems("no command here").length >= 1, "a doc with no status line is a problem, not a pass");
  // the rule is in the skill: the pattern, the skip, and never --name
  assert.ok(RUN_SRC.includes("^[A-Za-z0-9._-]{1,40}$") && !RUN_SRC.includes("{1,60}"), "the pattern for the phase id and the label is the script's 40");
  assert.ok(RUN_SRC.includes("skip that status call") && RUN_SRC.includes("leave out `--label`"));
  assert.ok(RUN_SRC.includes("never pass `--name`"));
  assert.ok(RUN_SRC.includes("Never put a title, a name or any other text from a roadmap, a plan file, an issue or a commit into a status command line"));
  // a value that matches the pattern holds no character the shell treats as special
  const pattern = /^[A-Za-z0-9._-]{1,40}$/;
  for (let c = 0; c < 0x250; c++) {
    const ch = String.fromCodePoint(c);
    if (pattern.test(ch)) assert.ok(!" \t\n\r\"'`$\\;&|<>()[]{}*?!#~=%^,:@+".includes(ch), `U+${c.toString(16)} is allowed by the pattern but special to a shell`);
  }
  for (const evil of ["`echo hi`", "$(echo hi)", "a b", "a;b", "a\"b", "x".repeat(41), ""]) assert.ok(!pattern.test(evil), JSON.stringify(evil));
  // the other docs do not show the run passing --name
  for (const doc of [join(PS, "skills", "dashboard", "references", "status.md"), join(PS, "skills", "dashboard", "SKILL.md"), join(PS, "README.md")]) {
    const text = readFileSync(doc, "utf8");
    assert.deepEqual((text.match(/`[^`\n]*status\.mjs[^`\n]*`/g) ?? []).filter((s) => /--name\b/.test(s)), [], doc);
  }
  assert.ok(readFileSync(join(PS, "skills", "dashboard", "references", "status.md"), "utf8").includes("The run never passes `--name`"));
});

// 2. --data must be an absolute path.
test("status and collect refuse a --data that is empty or relative (exit 2) and read and write nothing", async () => {
  const cwd = tmp("cwd-guard");
  const proj = tmp("cwd-proj");
  put(cwd, "dashboard.json", JSON.stringify({ v: 1, enabled: false, asked: null, warnMin: 90, idleMin: 180 }));
  put(cwd, "projects.json", JSON.stringify({ v: 1, projects: [] }));
  const before = snapshot(cwd);
  // The cases run in this process, from the working folder the real command would have had (restored at the end); one real process per
  // script follows, so the command line itself is still covered.
  const startedIn = process.cwd();
  const inProcess = async (script, args) => {
    process.chdir(cwd);
    try {
      const r = script === "status.mjs" ? st(args) : await col(args);
      return { status: r.code, stdout: r.out, stderr: r.err };
    } finally {
      process.chdir(startedIn);
    }
  };
  const realProcess = (script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: "utf8", cwd });
  const bads = [["--data", ""], ["--data="], ["--data", "."], ["--data", "relative-data"], ["--data", ".." + (WIN ? "\\" : "/") + "elsewhere"]];
  const commands = [
    ["status.mjs", ["state"], []],
    ["status.mjs", ["enable"], []],
    ["status.mjs", ["set"], ["--root", proj, "--phase", "1", "--step", "build", "--state", "working"]],
    ["status.mjs", ["unregister"], ["0".repeat(12)]],
    ["collect.mjs", [], []],
  ];
  const check = (run, script, args) => async () => {
    const r = await run(script, args);
    assert.equal(r.status, 2, `${script} ${JSON.stringify(args)}: ${r.stderr}`);
    assert.equal(r.stdout, "", `${script} printed nothing`);
    assert.ok(r.stderr.includes("--data must be an absolute path"), r.stderr);
    assert.equal(snapshot(cwd), before, `${script} ${JSON.stringify(args)} wrote into or changed the working folder`);
  };
  for (const bad of bads) {
    for (const [script, pre, more] of commands) await check(inProcess, script, [...pre, ...bad, ...more])();
  }
  // The real-process smoke: one relative --data for each script.
  await check(realProcess, "status.mjs", ["state", "--data", "relative-data"])();
  await check(realProcess, "collect.mjs", ["--data", "relative-data"])();
  assert.deepEqual(listing(proj), [], "the project folder holds nothing new");
});

// 3. The roadmap reader is chosen by the script's own folder name.
test("collect: the roadmap reader comes from the script's own folder name, and a neighbour of the other layout is never run", () => {
  const w = seededData();
  const decoy = [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(new URL("./RAN", import.meta.url), "the decoy ran");',
    "export const parseRoadmap = () => ({});",
    "export const toReadJson = () => ({ tables: [] });",
    "export const parsePlanFile = () => ({ timestamps: null });",
    "",
  ].join("\n");
  const ranIn = (root, folder) => existsSync(join(root, folder, "scripts", "RAN"));
  for (const [dash, real, other] of [["ps-dashboard", "ps-roadmap", "roadmap"], ["dashboard", "roadmap", "ps-roadmap"]]) {
    const script = layout(dash, real);
    const root = join(dirname(script), "..", "..");
    put(root, `${other}/scripts/roadmap.mjs`, decoy);
    const r = runScript(script, w.data);
    assert.equal(r.status, 0, `${dash}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).projects[0].roadmaps[0].phases.length, 2, `${dash}: the real reader was used`);
    assert.equal(ranIn(root, other), false, `the decoy next to ${dash} did not run`);
    assert.equal(ranIn(root, real), false);
  }
  // any other folder name: the script stops and imports nothing
  const odd = layout("dashboard-copy", "roadmap");
  const oddRoot = join(dirname(odd), "..", "..");
  put(oddRoot, "ps-roadmap/scripts/roadmap.mjs", decoy);
  writeFileSync(join(oddRoot, "roadmap", "scripts", "roadmap.mjs"), decoy);
  const r = runScript(odd, w.data);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("a folder named dashboard or ps-dashboard"), r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(ranIn(oddRoot, "roadmap") || ranIn(oddRoot, "ps-roadmap"), false, "no neighbour was imported");
  noPath(w, r.stderr, "the folder-name message");
});

// 5. Phase ids that differ only in letter case are one session.
test("status: phase ids that differ only in letter case share one session file, in both orders, and clear finds it; collect compares them without case", async () => {
  const w = world("case");
  const p = w.proj();
  enable(w);
  const id = idFor(w, p);
  for (const [first, second] of [["7a", "7A"], ["7A", "7a"]]) {
    assert.equal(setStatus(w, p, first, "build", "working").code, 0);
    assert.equal(setStatus(w, p, second, "compare", "working").code, 0);
    assert.deepEqual(sessionFiles(w), [sname(id, "7a")], `${first} then ${second}`);
    const sessions = (await col(["--data", w.data])).json().sessions;
    assert.deepEqual(sessions.map((s) => [s.phase, s.step]), [[second, "compare"]]);
    assert.equal(st(["clear", "--data", w.data, "--root", p, "--phase", first]).code, 0);
    assert.deepEqual(sessionFiles(w), [], `clear ${first} removed the file written as ${second}`);
  }
  // a file name with a capital in its phase is not a session file name: skipped and reported by base name (the scripts write lower case only)
  put(w.data, `sessions/${id}-9B.json`, JSON.stringify({ v: 1, project: id, phase: "9b", phase_name: "", step: "build", state: "working", step_started: NOW, updated: NOW }));
  const old = await col(["--data", w.data]);
  assert.deepEqual(old.json().sessions, []);
  assert.deepEqual(old.json().errors, [{ file: `${id}-9B.json`, reason: "not a session file name" }]);
});

// 7. One open, the descriptor is the one that is checked.
test("collect: a file is opened once and its descriptor checked: a non-regular file, a size over the cap and a second name are refused without a read, and every descriptor is closed", async () => {
  const plan = (n) => `${PLANS}/phase-${n}.md`;
  const { w } = seeded("fdcheck", {
    rows: [1, 2, 3, 4].map((n) => row(String(n), `Row ${n}`, "planned", plan(n))),
    files: { [plan(2)]: planText("2", "Odd"), [plan(3)]: planText("3", "Big"), [plan(4)]: planText("4", "Linked") },
  });
  const names = new Map();
  const opened = [];
  const closed = [];
  const readFrom = [];
  const fd = {
    open: (path, flags) => { const f = openSync(path, flags); names.set(f, basename(path)); opened.push(f); return f; },
    fstat: (f) => {
      const n = names.get(f);
      if (n === "phase-2.md") return { isFile: () => false, nlink: 1, size: 10 };
      if (n === "phase-3.md") return { isFile: () => true, nlink: 1, size: 300 * 1024 };
      if (n === "phase-4.md") return { isFile: () => true, nlink: 2, size: 10 };
      return fstatSync(f);
    },
    read: (f, ...rest) => { readFrom.push(names.get(f)); return readSync(f, ...rest); },
    close: (f) => { closed.push(f); closeSync(f); },
  };
  const r = await col(["--data", w.data], { fd });
  assert.equal(r.code, 0, r.err);
  const reasons = Object.fromEntries(r.json().projects[0].errors.map((e) => [e.file, e.reason]));
  assert.equal(reasons["phase-2.md"], "not a regular file");
  assert.match(reasons["phase-3.md"], /too large/);
  assert.match(reasons["phase-4.md"], /hard link/);
  assert.equal(reasons["phase-1.md"], undefined, "the unchanged file is fine");
  for (const n of ["phase-2.md", "phase-3.md", "phase-4.md"]) assert.ok(!readFrom.includes(n), `${n} was read`);
  assert.ok(readFrom.includes("phase-1.md") && readFrom.includes(RM), "the files that pass are read through the descriptor");
  assert.equal(phaseRows(r.json())[0].timestamps.started, "2026-10-01T10:00:00Z");
  assert.ok(opened.length >= 6);
  assert.deepEqual([...closed].sort(), [...opened].sort(), "every descriptor was closed, including the refused ones");
  // a failing read still closes the descriptor
  closed.length = 0;
  opened.length = 0;
  const boom = await col(["--data", w.data], { fd: { ...fd, read: (f, ...rest) => { if (names.get(f) === "phase-1.md") throw Object.assign(new Error("injected"), { code: "EIO" }); return readSync(f, ...rest); } } });
  assert.equal(boom.code, 0, boom.err);
  assert.ok(boom.json().projects[0].errors.some((e) => /unreadable \(EIO\)/.test(e.reason)));
  assert.deepEqual([...closed].sort(), [...opened].sort());
  // the data folder's own files go through the same checks
  const cfg = await col(["--data", w.data], { fd: { ...fd, fstat: (f) => (names.get(f) === "dashboard.json" ? { isFile: () => true, nlink: 2, size: 5 } : fd.fstat(f)) } });
  assert.equal(cfg.code, 0, cfg.err);
  assert.ok(cfg.json().errors.some((e) => e.file === "dashboard.json"), "a hard-linked settings file is reported");
});

// 8. A clock that is wrong.
test("collect: a session time more than 5 minutes ahead (or a step that started after its update) is clock skew: Idle, noUpdate, a warning, never an open session", async () => {
  const { w, p } = seeded("skew");
  setStatus(w, p, "1", "build", "working");
  const id = readJson(w.data, "projects.json").projects[0].id;
  const at = async (minutes) => (await col(["--data", w.data, "--now", String(NOW + minutes * MIN)])).json();
  for (const minutes of [-4, -5]) {
    const j = await at(minutes);
    assert.deepEqual([j.sessions[0].shown, j.sessions[0].noUpdate, j.warnings], ["Working", false, []], `${-minutes} minutes ahead is normal`);
  }
  for (const minutes of [-6, -525600]) {
    const j = await at(minutes);
    assert.deepEqual([j.sessions[0].shown, j.sessions[0].noUpdate], ["Idle", true], `${-minutes} minutes ahead`);
    assert.deepEqual(j.warnings, [{ kind: "clock skew", project: id }]);
  }
  // a step that started after its last update
  const file = join(w.data, "sessions", sname(id, "1"));
  const base = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...base, step_started: base.updated + 1 }));
  const odd = await at(0);
  assert.deepEqual([odd.sessions[0].shown, odd.sessions[0].noUpdate, odd.warnings], ["Idle", true, [{ kind: "clock skew", project: id }]]);
  writeFileSync(file, JSON.stringify(base));
  // a skewed session does not keep the same-project warning on
  setStatus(w, p, "2", "build", "working");
  assert.deepEqual((await at(0)).warnings, [{ kind: "same project, more than one open session", project: id }]);
  const second = join(w.data, "sessions", sname(id, "2"));
  const two = JSON.parse(readFileSync(second, "utf8"));
  writeFileSync(second, JSON.stringify({ ...two, updated: NOW + 525600 * MIN, step_started: NOW + 525600 * MIN }));
  const j = await at(0);
  assert.deepEqual(j.warnings, [{ kind: "clock skew", project: id }], "only the clock warning, not the same-project one");
  assert.deepEqual(j.sessions.map((s) => [s.phase, s.shown, s.noUpdate]), [["1", "Working", false], ["2", "Idle", true]]);
});

// 11. Plan files under folders that are never read.
test("collect: a plan file whose resolved path has a .git, node_modules or .roadmap-backups folder is refused with the reason and never opened", async (t) => {
  const dirs = [".git", "node_modules/pkg", ".roadmap-backups"];
  const rows = dirs.map((d, i) => row(String(i + 1), `Row ${i + 1}`, "planned", `${d}/phase-9.md`));
  rows.push(row("4", "Linked", "planned", "docs/gl/phase-9.md"), row("5", "Fine", "shipped", `${PLANS}/phase-1.md`));
  const files = Object.fromEntries(dirs.map((d) => [`${d}/phase-9.md`, planText("9", "Hidden")]));
  const { w, p } = seeded("neverread", { rows, files });
  let linked = true;
  try { mkdirSync(join(p, "docs")); symlinkSync(join(p, dirs[0]), join(p, "docs", "gl"), "junction"); } catch { linked = false; }
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const proj = r.json().projects[0];
  const why = proj.errors.filter((e) => e.file === "phase-9.md").map((e) => e.reason);
  assert.ok(why.length >= 1 && why.every((x) => /never read/.test(x)), JSON.stringify(proj.errors));
  assert.ok(why.some((x) => x.includes(".git") && x.includes("node_modules") && x.includes(".roadmap-backups")), "the reason names the folders");
  const rowsOut = phaseRows(r.json());
  for (const phase of rowsOut.slice(0, linked ? 4 : 3)) assert.deepEqual(phase.timestamps, { started: null, previewed: null, approved: null, shipped: null }, phase.phase);
  assert.equal(rowsOut[4].timestamps.started, "2026-10-01T10:00:00Z", "the rest of the project still loads");
  assert.ok(!r.reads.some((x) => /[\\/](\.git|node_modules|\.roadmap-backups)[\\/]/.test(x)), "nothing under those folders was opened");
  if (!linked) t.diagnostic("no junctions here; the linked case did not run");
});
const DOC_SPAN = /`[^`\n]*(?:status|collect)\.mjs[^`\n]*`/g;

// 1 and 3. The dashboard skill's command lines follow the same rule as the run skill's.
const DASH_SRC = readFileSync(join(PS, "skills", "dashboard", "SKILL.md"), "utf8");
const DASH_PLACEHOLDERS = ["project folder", "id", "history label", "relative path", "output file"];
test("dashboard skill: its command lines have no double-quoted free text and only the allowed placeholders; both skills skip a folder that could end single quotes", () => {
  assert.deepEqual(statusLineProblems(DASH_SRC, DASH_PLACEHOLDERS), []);
  for (const bad of [`--root "<project folder>"`, `--label "<history label>"`, `--roadmap "<relative path>"`, `unregister "<id>"`, `--out "<output file>"`]) {
    assert.ok(statusLineProblems(`\`node status.mjs x ${bad}\``, DASH_PLACEHOLDERS).length >= 1, `the check sees ${bad}`);
  }
  assert.ok(statusLineProblems("`node collect.mjs --out <some file>`", DASH_PLACEHOLDERS).length >= 1, "a placeholder that is not allowed");
  assert.ok(statusLineProblems("nothing here", DASH_PLACEHOLDERS).length >= 1, "a doc with no command is a problem, not a pass");
  // a folder or output file is `.` or single-quoted; a label or a roadmap path is bare
  const spans = DASH_SRC.match(DOC_SPAN) ?? [];
  assert.ok(spans.length >= 6, "the skill's command lines were found");
  for (const span of spans) {
    assert.equal((span.match(/--(?:root|out) (?:'<[^'>]*>'|\.)(?=[ `])/g) ?? []).length, (span.match(/--(?:root|out)\b/g) ?? []).length, `a folder or file is single-quoted: ${span.slice(0, 80)}`);
    assert.equal((span.match(/--(?:label|roadmap) <[^">]*>/g) ?? []).length, (span.match(/--(?:label|roadmap)\b/g) ?? []).length, `a label or roadmap is bare: ${span.slice(0, 80)}`);
  }
  for (const phrase of ["^[A-Za-z0-9._-]{1,40}$", "^[A-Za-z0-9._/-]{1,100}$", "ends in `.md`", "written `.` when it is the working directory", "otherwise in single quotes", "a single quote, a control character or any of U+2018 to U+201B", "An `--out` file is written in single quotes under the same rule", "Never put a title, a name or any other text from a file into a command line"]) assert.ok(DASH_SRC.includes(phrase), phrase);
  const skip = "a single quote, a control character or any of U+2018 to U+201B";
  assert.ok(RUN_SRC.includes(skip) && RUN_SRC.includes("skip the status call"), "the run skill skips the call for the same characters");
  assert.ok(!RUN_SRC.includes("holds a single quote, skip") && !RUN_SRC.includes("only a single quote"));
  // the claims are only as strong as what is true
  for (const doc of [RUN_SRC, DASH_SRC, readFileSync(join(PS, "README.md"), "utf8"), readFileSync(join(PS, "CHANGELOG.md"), "utf8"), readFileSync(join(PS, "skills", "dashboard", "references", "status.md"), "utf8")]) {
    for (const claim of ["can never reach", "never reaches a command line", "built by this session's shell", "The values above hold no character"]) assert.ok(!doc.includes(claim), claim);
  }
  assert.ok(RUN_SRC.includes("The folder is the one value that can"), "the run skill says the folder is the one value that can hold a special character");
  // what the patterns accept
  const bare = /^[A-Za-z0-9._-]{1,40}$/;
  const road = /^[A-Za-z0-9._/-]{1,100}$/;
  for (const evil of ["proj$(touch pwned)", "a b", "a;b", "`id`", "a'b", `a${cp(0x2019)}b`, "x".repeat(41), ""]) assert.ok(!bare.test(evil), JSON.stringify(evil));
  for (const evil of ["a b.md", "$(x).md", "a;b.md", "x/".repeat(60)]) assert.ok(!road.test(evil), JSON.stringify(evil));
  assert.ok(bare.test("zork-app_1.2") && road.test("docs/PHASES.md"));
  // PowerShell ends a single-quoted string at U+2018 to U+201B, so each of them must be on the skip list
  const unsafeFolder = new RegExp(`['${cp(0)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x2018)}-${cp(0x201b)}]`);
  for (const ch of ["'", cp(9), cp(0x2018), cp(0x2019), cp(0x201a), cp(0x201b)]) assert.ok(unsafeFolder.test(`${BS}x${ch}y`), `U+${ch.codePointAt(0).toString(16)}`);
  assert.ok(!unsafeFolder.test(`C:${BS}Users${BS}zork${BS}my app`) && !unsafeFolder.test(cp(0x201c)));
});

// 7. Documentation that says what is true.
test("docs: status.md writes the escape names as visible text; the README and skills describe the step, the data folder and the paths truthfully", () => {
  const ref = readFileSync(join(PS, "skills", "dashboard", "references", "status.md"), "utf8");
  for (const doc of [ref, DASH_SRC, readFileSync(join(PS, "README.md"), "utf8"), readFileSync(join(PS, "CHANGELOG.md"), "utf8")]) assert.ok(!doc.includes(cp(0x2028)) && !doc.includes(cp(0x2029)), "no raw line or paragraph separator");
  const line = ref.split(cp(10)).find((l) => l.includes("As a second layer"));
  assert.ok(line, "the escapes line is there");
  const tail = line.slice(line.indexOf("as the escapes"));
  for (const hex of ["003c", "003e", "0026", "2028", "2029"]) assert.ok(tail.includes(`${BS}u${hex}`), `${BS}u${hex} is written out`);
  assert.ok(!/[<>&]/.test(tail), "no raw <, > or & where the escapes are written");
  const readme = readFileSync(join(PS, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Dashboard data"), readme.indexOf("## What it touches"));
  assert.ok(section.includes("approve (waiting for your approval)") && !section.includes("preview (waiting for your approval)"), "the step the run writes is approve");
  assert.ok(!readme.includes("nothing into a project folder"));
  assert.ok(readme.includes("Its status and list files go to the data folder only. `collect --out` writes the one file you name, and is refused inside the data folder"));
  assert.ok(readme.includes("Do not point `--data` at a folder tracked by git"));
  assert.ok(ref.includes("Do not point `--data` at a folder that git tracks") && ref.includes("`collect --out` writes the one file you name"));
  assert.ok(DASH_SRC.includes("Do not point `--data` at a folder that git tracks") && DASH_SRC.includes("`collect --out` writes the one file you name, and is refused inside the data folder"));
  for (const doc of [readme, readFileSync(join(PS, "CHANGELOG.md"), "utf8"), ref, DASH_SRC]) assert.ok(doc.toLowerCase().includes("other spellings of a path may remain"), "the redaction wording says other spellings may remain");
  assert.ok(!RUN_SRC.includes("{1,60}") && RUN_SRC.includes("{1,40}"), "the run skill says 40, as the script does");
  assert.ok(COLLECT_SRC.includes("other spellings of a path may remain"));
});

// 5. --out never lands in the data folder.
test("collect: --out is refused (exit 2, nothing written) in the data folder or when a real path there is not a regular file, and a sibling folder is fine", async () => {
  const { w, p } = seeded("outdata");
  setStatus(w, p, "1", "build", "working");
  const before = snapshot(w.data);
  const realData = realpathSync.native(w.data);
  const targets = [
    join(w.data, "projects.json"),
    join(w.data, "dashboard.json"),
    join(w.data, "new.json"),
    join(w.data, "sessions", "x.json"),
    join(w.data, "..", "data", "projects.json"),
    join(realData, "projects.json"),
    join(realData, "sessions", sessionFiles(w)[0]),
  ];
  for (const target of targets) {
    const r = await col(["--data", w.data, "--out", target]);
    assert.equal(r.code, 2, `${basename(target)} was not refused`);
    assert.ok(r.err.includes("data folder"), r.err);
    assert.equal(snapshot(w.data), before, `${basename(target)}: the data folder changed`);
  }
  assert.ok(readJson(w.data, "projects.json").projects.length === 1, "the registry is whole");
  // a name that only starts like the data folder's is another folder
  mkdirSync(join(w.base, "data-other"));
  const ok = await col(["--data", w.data, "--out", join(w.base, "data-other", "dash.json")]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(readFileSync(join(w.base, "data-other", "dash.json"), "utf8")).v, 1);
  assert.equal(snapshot(w.data), before);
  assert.ok(COLLECT_SRC.includes("function outProblem"));
});

// 6. status.mjs reads its files through one checked descriptor, and collect re-checks the data folder after a read.
test("status: every file of ours is opened once and checked on the open descriptor: a non-regular file, a size over the cap and a second name are refused, and every descriptor is closed", () => {
  const w = world("sfd");
  const p = w.proj();
  enable(w);
  assert.equal(setStatus(w, p, "1", "build", "working").code, 0);
  const session = sessionFiles(w)[0];
  const names = new Map();
  const opened = [];
  const closed = [];
  const readFrom = [];
  const hooks = (over = {}) => ({
    open: (path, flags) => { const f = openSync(path, flags); names.set(f, basename(path)); opened.push(f); return f; },
    fstat: (f) => over[names.get(f)] ?? fstatSync(f),
    read: (f, ...rest) => { readFrom.push(names.get(f)); if (over[`${names.get(f)}:read`]) throw over[`${names.get(f)}:read`]; return readSync(f, ...rest); },
    close: (f) => { closed.push(f); closeSync(f); },
  });
  const reset = () => { opened.length = 0; closed.length = 0; readFrom.length = 0; };
  const odd = { isFile: () => false, nlink: 1, size: 10 };
  const big = { isFile: () => true, nlink: 1, size: 600 * 1024 };
  const linked = { isFile: () => true, nlink: 2, size: 10 };
  // the files that pass are read through the descriptor and every descriptor is closed
  const fine = st(["list", "--data", w.data], { fd: hooks() });
  assert.equal(fine.code, 0, fine.err);
  assert.ok(readFrom.includes("projects.json"), "read through the descriptor");
  assert.deepEqual([...closed].sort(), [...opened].sort());
  const before = snapshot(w.data);
  for (const [file, shape, why, argv] of [
    ["projects.json", odd, /not a regular file/, ["list"]],
    ["projects.json", big, /too large/, ["list"]],
    ["projects.json", linked, /not a regular file/, ["list"]],
    ["dashboard.json", odd, /not a regular file/, ["state"]],
    ["dashboard.json", big, /too large/, ["state"]],
    ["dashboard.json", linked, /not a regular file/, ["state"]],
  ]) {
    reset();
    const r = st([...argv, "--data", w.data], { fd: hooks({ [file]: shape }) });
    assert.equal(r.code, 1, `${file}: ${r.all}`);
    assert.match(r.err, why, file);
    assert.ok(!readFrom.includes(file), `${file} was read`);
    assert.deepEqual([...closed].sort(), [...opened].sort(), `${file}: every descriptor is closed`);
  }
  // a write that depends on a refused file writes nothing
  reset();
  const refused = setStatus(w, p, "2", "build", "working", [], { fd: hooks({ "projects.json": linked }) });
  assert.equal(refused.code, 1, refused.all);
  assert.equal(snapshot(w.data), before, "nothing was written");
  reset();
  const prev = setStatus(w, p, "1", "ship", "working", [], { fd: hooks({ [session]: linked }) });
  assert.equal(prev.code, 1, prev.all);
  assert.match(prev.err, /not a regular file/);
  assert.equal(snapshot(w.data), before, "nothing was written");
  // a failing read still closes the descriptor
  reset();
  const boom = st(["state", "--data", w.data], { fd: hooks({ "dashboard.json:read": Object.assign(new Error("injected"), { code: "EIO" }) }) });
  assert.equal(boom.code, 1, boom.all);
  assert.match(boom.err, /EIO/);
  assert.deepEqual([...closed].sort(), [...opened].sort());
  assert.ok(!STATUS_SRC.includes("readFileSync"), "no read goes around the descriptor");
});
test("collect: a data folder file is checked again after the read: a folder swapped for a link during the read drops what was read", async (t) => {
  const { w, p } = seeded("recheck");
  setStatus(w, p, "1", "build", "working");
  const sdir = join(w.data, "sessions");
  const plain = await col(["--data", w.data]);
  assert.equal(plain.json().sessions.length, 1, "without a swap the session is shown");
  const elsewhere = tmp("recheck-else");
  cpSync(sdir, join(elsewhere, "sessions"), { recursive: true });
  const names = new Map();
  let swapped = false;
  let trouble = null;
  const fd = {
    open: (path, flags) => { const f = openSync(path, flags); names.set(f, path); return f; },
    // the swap happens once the file is read and its descriptor closed, before the path is checked again
    close: (f) => {
      closeSync(f);
      if (!swapped && dirname(names.get(f)) === sdir) {
        swapped = true;
        try { renameSync(sdir, join(w.data, "sessions-old")); symlinkSync(join(elsewhere, "sessions"), sdir, "junction"); } catch (e) { trouble = e; }
      }
    },
  };
  const r = await col(["--data", w.data], { fd });
  if (trouble) { t.diagnostic(`no links here (${trouble.code}); the swap did not run`); return; }
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().sessions, [], "what was read from the swapped folder is dropped");
  assert.ok(r.json().errors.some((e) => /^[0-9a-f]{12}-[0-9a-f]{6}\+1\.json$/.test(e.file) && /link/.test(e.reason)), JSON.stringify(r.json().errors));
  assert.ok(COLLECT_SRC.includes("a link, not a real file"));
});

// ── status.mjs: the repository is the project (phase 7d3, round 3) ──────────
// Every folder is a temp folder; the home folder the climb stops at is injected (io.homedir), so no real .git above the
// temp area can change a result. Expectations use the same id algorithm the script documents.
const idOfPath = (p) => createHash("sha256").update(WIN ? realpathSync.native(p).toLowerCase() : realpathSync.native(p)).digest("hex").slice(0, 12);
const registryOf = (w) => readJson(w.data, "projects.json").projects;
test("status: a run in the repository root keeps the folder as the project, as before", () => {
  const { w, repo, home } = repoWorld("repo-root");
  writeFileSync(join(repo, RM), shipped);
  enable(w);
  assert.equal(setStatus(w, repo, "1", "build", "working", [], home).code, 0);
  const [e] = registryOf(w);
  assert.equal(e.id, idOfPath(repo));
  assert.equal(e.name, "repo");
  assert.deepEqual(e.roadmaps, [RM]);
  assert.deepEqual(sessionFiles(w), [sname(e.id, "1")]);
});
test("status: a run in docs/roadmap inside a repository makes the repository the project, adds the roadmap path and attaches the session to the repository id", async () => {
  const { w, repo, home, sub } = repoWorld("repo-sub");
  const given = sub("docs/roadmap");
  enable(w);
  const r = setStatus(w, given, "1", "build", "working", ["--label", "zork"], home);
  assert.equal(r.code, 0, r.err);
  const reg = registryOf(w);
  assert.equal(reg.length, 1, "one project, not one for the subfolder");
  assert.equal(reg[0].id, idOfPath(repo));
  assert.equal(reg[0].name, "repo");
  assert.equal(reg[0].path.toLowerCase(), realpathSync.native(repo).toLowerCase());
  assert.deepEqual(reg[0].roadmaps, [`docs/roadmap/${RM}`], "the nested path, and no default that is not there");
  assert.deepEqual(sessionFiles(w), [sname(idOfPath(repo), "1", `docs/roadmap/${RM}`)]);
  assert.equal(st(["clear", "--data", w.data, "--root", given, "--phase", "1"], home).code, 0);
  assert.deepEqual(sessionFiles(w), [], "clear from the subfolder finds the repository's file");
  // collect reads a nested relative roadmap path inside the project root
  const c = await col(["--data", w.data]);
  assert.equal(c.code, 0, c.err);
  const proj = c.json().projects[0];
  assert.equal(proj.status, "ok");
  assert.deepEqual(proj.errors, []);
  assert.equal(proj.roadmaps[0].file, `docs/roadmap/${RM}`);
  assert.deepEqual(proj.roadmaps[0].phases.map((p) => p.id), ["1", "2"]);
});
test("status: two roadmap folders in one repository give one project with two roadmaps and one id; --roadmap is relative to the project root", () => {
  const { w, repo, home, sub } = repoWorld("repo-two");
  const a = sub("docs/a");
  const b = sub("docs/b");
  enable(w);
  assert.equal(setStatus(w, a, "1", "build", "working", [], home).code, 0);
  assert.equal(setStatus(w, b, "2", "build", "working", [], home).code, 0);
  const reg = registryOf(w);
  assert.equal(reg.length, 1);
  assert.deepEqual(reg[0].roadmaps, [`docs/a/${RM}`, `docs/b/${RM}`]);
  assert.deepEqual(sessionFiles(w), [sname(reg[0].id, "1", `docs/a/${RM}`), sname(reg[0].id, "2", `docs/b/${RM}`)].sort());
  // the same folder again changes nothing in the list (deduped)
  assert.equal(setStatus(w, a, "1", "compare", "working", [], home).code, 0);
  assert.equal(registryOf(w)[0].roadmaps.length, 2);
  const x = st(["register", "--data", w.data, "--root", join(repo, "docs"), "--roadmap", `notes/${RM}`], home);
  assert.equal(x.code, 0, x.err);
  assert.deepEqual(registryOf(w)[0].roadmaps, [`docs/a/${RM}`, `docs/b/${RM}`, `notes/${RM}`]);
  assert.equal(registryOf(w).length, 1);
});
test("status: with no .git anywhere the folder itself is the project; a .git that is a file (worktree style) counts", () => {
  const w = world("no-git");
  const p = w.proj("zork");
  const deep = join(p, "docs", "roadmap");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, RM), shipped);
  enable(w);
  assert.equal(setStatus(w, deep, "1", "build", "working", [], { homedir: w.base }).code, 0);
  assert.equal(registryOf(w)[0].id, idOfPath(deep));
  assert.equal(registryOf(w)[0].name, "roadmap");
  assert.deepEqual(registryOf(w)[0].roadmaps, [RM]);
  // a worktree-style .git file; its content is never read, so it can say anything
  writeFileSync(join(p, ".git"), "gitdir: /nowhere/at/all\n");
  assert.equal(setStatus(w, deep, "1", "compare", "working", [], { homedir: w.base }).code, 0);
  const reg = registryOf(w);
  assert.equal(reg.length, 2, "the old entry is not rewritten or migrated; the repository is a new one");
  assert.equal(reg[0].id, idOfPath(deep));
  assert.deepEqual(reg[0].roadmaps, [RM]);
  assert.equal(reg[1].id, idOfPath(p));
  assert.deepEqual(reg[1].roadmaps, [`docs/roadmap/${RM}`]);
});
test("status: a .git at the home folder is ignored (a dotfiles repository does not swallow everything), wherever the home folder is", () => {
  const w = world("home-git");
  mkdirSync(join(w.base, ".git"));
  const p = w.proj("zork");
  enable(w);
  assert.equal(setStatus(w, p, "1", "build", "working", [], { homedir: w.base }).code, 0);
  assert.equal(registryOf(w)[0].id, idOfPath(p), "the folder itself, not the home folder");
  // the folder under home that has its own .git is still found
  mkdirSync(join(p, ".git"));
  const q = join(p, "docs");
  mkdirSync(q);
  assert.equal(setStatus(w, q, "2", "build", "working", [], { homedir: w.base }).code, 0);
  assert.equal(registryOf(w).at(-1).id, idOfPath(p));
  // another home folder: its .git is ignored too
  const other = tmp("home-git-else");
  const q2 = join(other, "x");
  mkdirSync(q2);
  mkdirSync(join(other, ".git"));
  assert.equal(setStatus(w, q2, "3", "build", "working", [], { homedir: other }).code, 0);
  assert.equal(registryOf(w).at(-1).id, idOfPath(q2));
});
test("status: a nested repository wins: the nearest .git is the project root", () => {
  const { w, repo, home, sub } = repoWorld("nested");
  const inner = sub("tools/inner", false);
  mkdirSync(join(inner, ".git"));
  const given = sub("tools/inner/docs");
  enable(w);
  assert.equal(setStatus(w, given, "1", "build", "working", [], home).code, 0);
  const [e] = registryOf(w);
  assert.equal(e.id, idOfPath(inner));
  assert.notEqual(e.id, idOfPath(repo));
  assert.equal(e.name, "inner");
  assert.deepEqual(e.roadmaps, [`docs/${RM}`]);
});
test("status: a repository that holds the data folder is not used (the folder itself is), and a folder inside the data folder is refused", () => {
  const w = world("data-in-repo");
  const repo = w.proj("repo");
  mkdirSync(join(repo, ".git"));
  const data = join(repo, ".dash-data");
  const given = join(repo, "docs");
  mkdirSync(given);
  writeFileSync(join(given, RM), shipped);
  const run = (argv) => st(argv, { homedir: w.base });
  assert.equal(run(["enable", "--data", data]).code, 0);
  const r = run(["set", "--data", data, "--root", given, "--phase", "1", "--step", "build", "--state", "working"]);
  assert.equal(r.code, 0, r.err);
  const [e] = readJson(data, "projects.json").projects;
  assert.equal(e.id, idOfPath(given), "falls back to the given folder");
  assert.deepEqual(e.roadmaps, [RM]);
  mkdirSync(join(data, "inner"));
  const before = snapshot(data);
  const inside = run(["set", "--data", data, "--root", join(data, "inner"), "--phase", "1", "--step", "build", "--state", "working"]);
  assert.equal(inside.code, 1);
  assert.ok(inside.err.includes("data folder"));
  assert.equal(snapshot(data), before);
});
test("status: a repository root that was already registered keeps its id and entry when a run comes from a subfolder", () => {
  const w = world("keep-id");
  const repo = w.proj("repo");
  writeFileSync(join(repo, RM), shipped);
  enable(w);
  const oldId = idFor(w, repo);
  assert.equal(oldId, idOfPath(repo));
  mkdirSync(join(repo, ".git"));
  const given = join(repo, "docs");
  mkdirSync(given);
  writeFileSync(join(given, RM), shipped);
  assert.equal(setStatus(w, given, "1", "build", "working", [], { homedir: w.base }).code, 0);
  const reg = registryOf(w);
  assert.equal(reg.length, 1);
  assert.equal(reg[0].id, oldId);
  assert.deepEqual(reg[0].roadmaps, [RM, `docs/${RM}`]);
  assert.deepEqual(sessionFiles(w), [sname(oldId, "1", `docs/${RM}`)]);
});
test("status: the climb looks at 40 folders at most: the repository at the 40th folder is found, one level further is not", () => {
  const w = world("climb");
  const top = w.proj("top");
  mkdirSync(join(top, ".git"));
  const chain = (n) => { let p = top; for (let i = 0; i < n; i++) p = join(p, "d"); mkdirSync(p, { recursive: true }); return p; };
  enable(w);
  const near = chain(39);
  assert.equal(setStatus(w, near, "1", "build", "working", [], { homedir: w.base }).code, 0);
  assert.equal(registryOf(w)[0].id, idOfPath(top), "40 folders counting the given one");
  const far = chain(40);
  assert.equal(setStatus(w, far, "2", "build", "working", [], { homedir: w.base }).code, 0);
  assert.equal(registryOf(w).at(-1).id, idOfPath(far), "41 folders: no repository, the folder itself");
});
test("status: a link or junction in the given path is resolved by real path first, so the repository behind it is found", (t) => {
  const { w, repo, home, sub } = repoWorld("linked");
  const real = sub("docs/roadmap");
  const elsewhere = tmp("linked-else");
  const link = join(elsewhere, "link");
  try { symlinkSync(real, link, "junction"); } catch (e) { t.diagnostic(`no links here (${e.code})`); return; }
  enable(w);
  assert.equal(setStatus(w, link, "1", "build", "working", [], home).code, 0);
  const [e] = registryOf(w);
  assert.equal(e.id, idOfPath(repo));
  assert.deepEqual(e.roadmaps, [`docs/roadmap/${RM}`]);
});
test("status: the .git entry is never read or followed: only its name is looked at (a file, a folder and a dangling link all count)", (t) => {
  const { w, repo, home, sub } = repoWorld("git-unread");
  writeFileSync(join(repo, ".git", "config"), "[core]\n");
  const given = sub("docs");
  enable(w);
  const opened = [];
  const fd = { open: (p, flags) => { opened.push(p); return openSync(p, flags); } };
  assert.equal(setStatus(w, given, "1", "build", "working", [], { ...home, fd }).code, 0);
  assert.ok(opened.length > 0 && opened.every((p) => !p.split(/[\\/]/).includes(".git")), `opened: ${opened.length}`);
  const climb = STATUS_SRC.slice(STATUS_SRC.indexOf("function repoRootOf"), STATUS_SRC.indexOf("function resolveProject"));
  assert.ok(climb.includes("lstatSync") && !/(readFileSync|readdirSync|existsSync|openSync|statSync\()/.test(climb.replace(/lstatSync/g, "")), "the climb uses lstat existence only");
  // a dangling .git link counts: the climb does not follow it
  const w2 = world("git-dangling");
  const p2 = w2.proj("repo");
  const g = join(p2, "docs");
  mkdirSync(g);
  try { symlinkSync(join(w2.base, "missing-target"), join(p2, ".git")); } catch (e) { t.diagnostic(`no links here (${e.code})`); return; }
  enable(w2);
  assert.equal(setStatus(w2, g, "1", "build", "working", [], { homedir: w2.base }).code, 0);
  assert.equal(registryOf(w2)[0].id, idOfPath(p2));
});
