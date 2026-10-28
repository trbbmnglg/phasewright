// Run with: node --test tests/dashboard-page.test.mjs
// Covers phase 7d3, part A: the trail in a session file (status.mjs), the fields collect.mjs adds (loops, rounds,
// workedMs, estimateH, the project summary, archived sessions), and the page (page.mjs with assets/page.css and
// assets/client.js): escaping, the one script and its hash, the shapes it may draw, the nested details, the empty and
// error states, the writes, and the fonts. Every folder is a synthetic temp folder (made-up names such as zork and
// acmecorp), removed afterwards; nothing is written to the real data folder. Control, format and bidirectional
// characters are built with String.fromCodePoint. Nothing here assumes a Windows layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, symlinkSync, cpSync, statSync, lstatSync, utimesSync, openSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename, sep } from "node:path";
import { createHash } from "node:crypto";
import { brotliDecompressSync, brotliCompressSync } from "node:zlib";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { main as status, run as statusRun } from "../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";
import { main as collect, collectData } from "../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import { main as page, renderPage, phaseFlow, loadAssets, buildPage } from "../plugins/phased-shipping/skills/dashboard/scripts/page.mjs";
import * as pageModule from "../plugins/phased-shipping/skills/dashboard/scripts/page.mjs";
import * as collectModule from "../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import * as statusModule from "../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, "..", "plugins", "phased-shipping", "skills", "dashboard");
const ASSETS = join(SKILL, "assets");
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
const cp = (n) => String.fromCodePoint(n);
// Names the guard protects are assembled here, so no such name is stored in this file.
const RM = ["PH", "ASES.md"].join("");

const scratch = [];
const tmp = (label = "w") => { const d = mkdtempSync(join(tmpdir(), `roadmap-test-page-${label}-`)); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const put = (root, rel, data) => {
  const p = join(root, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
};
const readJson = (root, rel) => JSON.parse(readFileSync(join(root, ...rel.split("/")), "utf8"));
const listing = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

function world(label) {
  const base = tmp(label);
  const data = join(base, "data");
  const proj = (name = "zork") => { const p = join(base, name); mkdirSync(p, { recursive: true }); return p; };
  return { base, data, proj };
}
function st(argv, o = {}) {
  const out = [];
  const err = [];
  const code = status(argv, { out: (s) => out.push(s), err: (s) => err.push(s), now: () => NOW, ...o });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
async function col(w, extra = []) {
  const out = [];
  const err = [];
  const code = await collect(["--data", w.data, "--now", String(NOW), ...extra], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, text: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
}
async function pg(argv, o = {}) {
  const out = [];
  const err = [];
  const code = await page(argv, { out: (s) => out.push(s), err: (s) => err.push(s), now: () => NOW, ...o });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const enable = (w) => { assert.equal(st(["enable", "--data", w.data]).code, 0); };
const setStatus = (w, root, phase, step, state, at, extra = [], o = {}) => st(["set", "--data", w.data, "--root", root, "--phase", phase, "--step", step, "--state", state, ...extra], { now: () => at, ...o });
const idFor = (w, root) => { const m = st(["register", "--data", w.data, "--root", root]).out.match(/id ([0-9a-f]{12})/); assert.ok(m); return m[1]; };
// The session file name `set` writes for a phase in a roadmap: <id>-<6 hex of the SHA-256 of the roadmap path>+<phase in lower case>.json.
// The path is lower-cased for the tag only where the file system ignores letter case (Windows, macOS), as the scripts do by default.
// Whether the scripts' default folds the case of a roadmap path, asked of status.mjs itself (this file assumes no platform):
// `set` for a roadmap in a folder with capitals, and the name it wrote says which tag it used.
const FOLDS = (() => {
  const base = tmp("probe");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "Zz"));
  const data = join(base, "data");
  st(["enable", "--data", data]);
  st(["set", "--data", data, "--root", join(repo, "Zz"), "--phase", "1", "--step", "build", "--state", "working"], { homedir: base });
  const name = readdirSync(join(data, "sessions"))[0];
  const tag = (folds) => createHash("sha256").update(folds ? `zz/${RM}`.toLowerCase() : `Zz/${RM}`).digest("hex").slice(0, 6);
  if (!name.includes(`-${tag(true)}+`) && !name.includes(`-${tag(false)}+`)) throw new Error("the probe found neither tag");
  return name.includes(`-${tag(true)}+`);
})();
const tagFor = (roadmapPath, folds = FOLDS) => createHash("sha256").update(folds ? roadmapPath.toLowerCase() : roadmapPath).digest("hex").slice(0, 6);
const sname = (id, phase, roadmapPath = RM, folds = FOLDS) => `${id}-${tagFor(roadmapPath, folds)}+${phase.toLowerCase()}.json`;
const sessionPath = (w, id, phase) => join(w.data, "sessions", `${id}-${phase.toLowerCase()}.json`);
// Writes a session file by hand (a trail given as [step, state, minutes ago] triples). By default it is the older form
// (<id>-<phase>.json, no roadmap field); with named: true (or a roadmap path) it is the file `set` writes for that roadmap (the project root's by default).
function hand(w, id, phase, o) {
  mkdirSync(join(w.data, "sessions"), { recursive: true });
  const trail = o.trail?.map(([step, state, ago]) => ({ step, state, at: NOW - ago * MIN }));
  const file = { v: 1, project: id, phase, phase_name: "", step: o.step, state: o.state ?? "working", step_started: NOW - (o.startedAgo ?? 5) * MIN, updated: NOW - (o.updatedAgo ?? 1) * MIN, ...(o.named ? { roadmap: o.named === true ? RM : o.named } : {}), ...(trail ? { trail } : {}), ...(o.extra ?? {}) };
  writeFileSync(o.named ? join(w.data, "sessions", sname(id, phase, o.named === true ? RM : o.named)) : sessionPath(w, id, phase), JSON.stringify(file));
  return file;
}

const HEAD = "| # | Phase | Status | Kind | Priority | Urgency | Est. (raw \u2192 cal.) | Actual | Commit / deploy | Blocked by | Plan file | Note |";
const rowE = (id, title, status, est = "2h \u2192 1.5h", actual = "") => `| ${id} | ${title} | ${status} | backend | P1 | Soon | ${est} | ${actual} | | | | |`;
const roadmap = (rows) => ["<!-- phased-shipping:roadmap v1 -->", HEAD, `|${"---|".repeat(12)}`, ...rows].join("\n") + "\n";

function pathForms(w) {
  const raw = [tmpdir(), realpathSync.native(tmpdir()), w.base, realpathSync.native(w.base), homedir()];
  const forms = new Set(["roadmap-test-page-"]);
  for (const p of raw) {
    forms.add(p.toLowerCase());
    forms.add(p.toLowerCase().split("\\").join("/"));
    forms.add(JSON.stringify(p).slice(1, -1).toLowerCase());
  }
  return [...forms];
}
const noPath = (w, text, what) => {
  const t = text.toLowerCase();
  for (const f of pathForms(w)) assert.ok(!t.includes(f), `${what}: found a path (${f.slice(0, 20)}...)`);
};

const HOSTILE = `<script>alert("pwned")</script> & "double" 'single' <img src=x onerror=alert(1)> ${cp(0x202e)}reversed${cp(0x202c)} ${cp(7)}bell ../../etc/passwd`;
const stripB64 = (s) => s.replace(/base64,[A-Za-z0-9+/=]+/g, "base64,X");
const scriptOf = (html) => html.split("<script>")[1].split("</script>")[0];
const cssOf = (html) => html.split("<style>")[1].split("</style>")[0];
const count = (s, needle) => s.split(needle).length - 1;

// ── status.mjs: the trail ───────────────────────────────────────────────────
test("trail: a first call writes none, a change of step or state appends, a repeat only moves updated", () => {
  const w = world("trail");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working", NOW);
  const id = idFor(w, p);
  const read = () => readJson(w.data, `sessions/${sname(id, "1")}`);
  assert.equal(read().trail, undefined, "the first call writes no trail");
  setStatus(w, p, "1", "build", "working", NOW + 5000);
  assert.equal(read().trail, undefined);
  assert.equal(read().updated, NOW + 5000);
  setStatus(w, p, "1", "compare", "working", NOW + 10 * MIN);
  assert.deepEqual(read().trail, [{ step: "build", state: "working", at: NOW }, { step: "compare", state: "working", at: NOW + 10 * MIN }]);
  setStatus(w, p, "1", "compare", "waiting", NOW + 20 * MIN);
  assert.equal(read().trail.length, 3);
  assert.deepEqual(read().trail[2], { step: "compare", state: "waiting", at: NOW + 20 * MIN });
  setStatus(w, p, "1", "compare", "waiting", NOW + 21 * MIN);
  assert.equal(read().trail.length, 3, "a repeated call does not append");
  assert.equal(read().updated, NOW + 21 * MIN);
});

test("trail: the newest 40 entries are kept", () => {
  const w = world("trailcap");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working", NOW);
  const id = idFor(w, p);
  for (let i = 1; i <= 60; i++) setStatus(w, p, "1", i % 2 ? "compare" : "build", "working", NOW + i * MIN);
  const t = readJson(w.data, `sessions/${sname(id, "1")}`).trail;
  assert.equal(t.length, 40);
  assert.equal(t.at(-1).at, NOW + 60 * MIN);
  assert.equal(t[0].at, NOW + 21 * MIN);
});

test("trail: entries of an existing file are validated with the step and state lists, and a run after done starts again", () => {
  const w = world("trailval");
  const p = w.proj();
  enable(w);
  const id = idFor(w, p);
  hand(w, id, "1", { step: "build", named: true, extra: { step_started: NOW - 1000, trail: [{ step: "nope", state: "working", at: 1 }, { step: "build", state: "working", at: NOW - 1000 }, "x", { step: "build", state: "gone", at: 5 }, { step: "build", state: "working", at: -4 }] } });
  setStatus(w, p, "1", "compare", "working", NOW);
  assert.deepEqual(readJson(w.data, `sessions/${sname(id, "1")}`).trail, [{ step: "build", state: "working", at: NOW - 1000 }, { step: "compare", state: "working", at: NOW }]);
  // a file from before the trail existed gets one entry for what it said, then the new one
  hand(w, id, "2", { step: "review", startedAgo: 30, named: true });
  setStatus(w, p, "2", "preview", "working", NOW);
  assert.deepEqual(readJson(w.data, `sessions/${sname(id, "2")}`).trail, [{ step: "review", state: "working", at: NOW - 30 * MIN }, { step: "preview", state: "working", at: NOW }]);
  // done, then the same phase runs again: a new trail, so the rerun is not drawn as a loop back
  setStatus(w, p, "3", "build", "working", NOW - 3 * HOUR);
  setStatus(w, p, "3", "prod-check", "done", NOW - 2 * HOUR);
  assert.ok(readJson(w.data, `sessions/${sname(id, "3")}`).trail, "done is a change like any other");
  setStatus(w, p, "3", "baseline", "working", NOW - HOUR);
  assert.equal(readJson(w.data, `sessions/${sname(id, "3")}`).trail, undefined);
});

test("trail: nothing is written while the dashboard is off", () => {
  const w = world("trailoff");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working", NOW);
  assert.equal(st(["disable", "--data", w.data]).code, 0);
  const before = readFileSync(join(w.data, "sessions", listing(join(w.data, "sessions"))[0]), "utf8");
  const r = setStatus(w, p, "1", "compare", "working", NOW + MIN);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("nothing written"));
  assert.equal(readFileSync(join(w.data, "sessions", listing(join(w.data, "sessions"))[0]), "utf8"), before);
});

test("trail: inside the 16 KB cap the oldest entries go first and the newest stays; too large even without any is refused", () => {
  const w = world("trailsize");
  const p = w.proj();
  enable(w);
  const id = idFor(w, p);
  setStatus(w, p, "1", "build", "working", NOW);
  const steps = ["compare", "build", "compare", "build", "compare", "build", "compare", "build"];
  steps.forEach((s, i) => setStatus(w, p, "1", s, "working", NOW + (i + 1) * MIN));
  const file = join(w.data, "sessions", sname(id, "1"));
  const full = Buffer.byteLength(readFileSync(file, "utf8"));
  const r = setStatus(w, p, "1", "review", "working", NOW + 20 * MIN, [], { maxSessionBytes: full - 40 });
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(text) <= full - 40);
  const t = JSON.parse(text).trail;
  assert.ok(t.length >= 1 && t.length < 9);
  assert.deepEqual(t.at(-1), { step: "review", state: "working", at: NOW + 20 * MIN }, "the newest entry stays");
  const tiny = setStatus(w, p, "1", "ship", "working", NOW + 30 * MIN, [], { maxSessionBytes: 40 });
  assert.equal(tiny.code, 1);
  assert.ok(tiny.err.includes("over 16 KB"));
});

// ── collect.mjs: the added fields ───────────────────────────────────────────
async function flowWorld() {
  const w = world("flow");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("w1", "Worked one", "in progress")]));
  enable(w);
  const id = idFor(w, p);
  const T = (arr) => arr;
  hand(w, id, "one", { step: "build", trail: T([["build", "working", 60], ["compare", "working", 40], ["build", "working", 20]]) });
  hand(w, id, "fin", { step: "compare", trail: [["build", "working", 60], ["compare", "working", 40], ["build", "working", 20], ["compare", "working", 5]] });
  hand(w, id, "two", { step: "build", trail: [["baseline", "working", 100], ["build", "working", 90], ["compare", "working", 80], ["build", "working", 70], ["compare", "working", 60], ["review", "working", 50], ["build", "working", 40]] });
  hand(w, id, "same", { step: "build", trail: [["build", "working", 90], ["compare", "working", 80], ["build", "working", 70], ["compare", "working", 60], ["build", "working", 50]] });
  hand(w, id, "fwd", { step: "review", trail: [["baseline", "working", 90], ["build", "working", 80], ["compare", "working", 70], ["review", "working", 60]] });
  hand(w, id, "stonly", { step: "build", trail: [["build", "working", 90], ["build", "waiting", 80], ["build", "working", 70]] });
  hand(w, id, "roll", { step: "build", trail: [["baseline", "working", 100], ["build", "working", 90], ["prod-check", "working", 60], ["build", "working", 20]] });
  hand(w, id, "rolldone", { step: "prod-check", trail: [["build", "working", 90], ["prod-check", "working", 60], ["build", "working", 40], ["prod-check", "working", 5]] });
  hand(w, id, "donesess", { step: "build", state: "done", trail: [["build", "working", 60], ["compare", "working", 40], ["build", "done", 20]] });
  hand(w, id, "W1", { step: "build", startedAgo: 20, updatedAgo: 20, trail: [["baseline", "working", 60], ["build", "waiting", 50], ["build", "working", 30]] });
  hand(w, id, "w2", { step: "build", startedAgo: 30, updatedAgo: 10 });
  const r = await col(w);
  assert.equal(r.code, 0, r.err);
  const by = Object.fromEntries(r.json().sessions.map((s) => [s.phase, s]));
  return { w, p, id, by, json: r.json(), text: r.text };
}

test("collect: loops from the trail: one loop, two loops, the same gate twice, forward only, state-only changes", async () => {
  const { by } = await flowWorld();
  assert.deepEqual(by.one.loops, [{ from: "compare", to: "build", count: 1, active: true }]);
  assert.equal(by.one.rounds, 2);
  assert.deepEqual(by.one.visits, { build: 2, compare: 1 });
  assert.deepEqual(by.fin.loops, [{ from: "compare", to: "build", count: 1, active: false }], "finished: the run is back at the gate it left");
  assert.deepEqual(by.two.loops, [{ from: "compare", to: "build", count: 1, active: false }, { from: "review", to: "build", count: 1, active: true }], "only the latest move back can be active");
  assert.deepEqual(by.same.loops, [{ from: "compare", to: "build", count: 2, active: true }]);
  assert.equal(by.same.rounds, 3);
  assert.deepEqual(by.fwd.loops, []);
  assert.equal(by.fwd.rounds, 1);
  assert.deepEqual(by.stonly.loops, []);
  assert.deepEqual(by.stonly.visits, { build: 1 });
});

test("collect: a rollback from prod-check to build is a loop; active until prod-check is reached again, never when done", async () => {
  const { by } = await flowWorld();
  assert.deepEqual(by.roll.loops, [{ from: "prod-check", to: "build", count: 1, active: true }]);
  assert.deepEqual(by.rolldone.loops, [{ from: "prod-check", to: "build", count: 1, active: false }]);
  assert.deepEqual(by.donesess.loops, [{ from: "compare", to: "build", count: 1, active: false }]);
});

test("collect: workedMs counts only the time in working, up to the last update; elapsedMs runs from the first entry", async () => {
  const { by } = await flowWorld();
  assert.equal(by.W1.workedMs, 20 * MIN, "10 min working, 20 min waiting (not counted), 10 min working");
  assert.equal(by.W1.elapsedMs, 40 * MIN);
  assert.equal(by.w2.workedMs, 20 * MIN, "a session without a trail: its own step_started to updated");
  assert.equal(by.w2.elapsedMs, 20 * MIN);
  assert.deepEqual(by.w2.loops, []);
  assert.equal(by.w2.rounds, 1);
});

test("collect: estimateH is the calibrated number of the matching row, null when there is none; the phase id ignores letter case", async () => {
  const w = world("est");
  const p = w.proj("zork");
  put(p, RM, roadmap([
    rowE("7d3", "Plain hours", "in progress", "3.3 h"),
    rowE("8", "Raw arrow cal plus", "in progress", "5.4 h \u2192 3.3 h + 1 h review"),
    rowE("9", "Arrow", "in progress", "2h \u2192 1.5h"),
    rowE("10", "Words", "in progress", "soon"),
    rowE("11", "Empty", "in progress", ""),
  ]));
  enable(w);
  const id = idFor(w, p);
  for (const ph of ["7D3", "8", "9", "10", "11", "99"]) hand(w, id, ph, { step: "build" });
  const r = await col(w);
  assert.equal(r.code, 0, r.err);
  const j = r.json();
  const by = Object.fromEntries(j.sessions.map((s) => [s.phase.toLowerCase(), s]));
  assert.equal(by["7d3"].estimateH, 3.3);
  assert.equal(by["8"].estimateH, 3.3);
  assert.equal(by["9"].estimateH, 1.5);
  assert.equal(by["10"].estimateH, null);
  assert.equal(by["11"].estimateH, null);
  assert.equal(by["99"].estimateH, null, "no matching row");
  const rows = j.projects[0].roadmaps[0].phases;
  assert.deepEqual(rows.map((x) => x.estimateH), [3.3, 3.3, 1.5, null, null]);
});

test("collect: archived is done and more than 7 days since the last update; the project summary counts what is happening now", async () => {
  const w = world("sum");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("1", "A", "shipped", "2h \u2192 1.5h", "1.4h"), rowE("2", "B", "shipped"), rowE("3", "C", "planned"), rowE("w", "Work", "in progress", "2h \u2192 2h"), rowE("q", "Wait", "in progress", "4h \u2192 3h")]));
  enable(w);
  const id = idFor(w, p);
  hand(w, id, "w", { step: "build", trail: [["baseline", "working", 60], ["build", "working", 30]], updatedAgo: 1 });
  hand(w, id, "q", { step: "approve", state: "waiting", trail: [["build", "working", 60], ["approve", "waiting", 20]], updatedAgo: 2 });
  hand(w, id, "idle", { step: "build", updatedAgo: 4 * 60, startedAgo: 4 * 60 });
  hand(w, id, "d6", { step: "prod-check", state: "done", updatedAgo: 6 * 24 * 60 + 23 * 60, startedAgo: 7 * 24 * 60 });
  hand(w, id, "d7", { step: "prod-check", state: "done", updatedAgo: 7 * 24 * 60 + 60, startedAgo: 8 * 24 * 60 });
  hand(w, id, "d7x", { step: "prod-check", state: "done", updatedAgo: 7 * 24 * 60, startedAgo: 8 * 24 * 60 });
  const r = await col(w);
  const j = r.json();
  const by = Object.fromEntries(j.sessions.map((s) => [s.phase, s]));
  assert.equal(by.d6.archived, false, "6 d 23 h is not archived");
  assert.equal(by.d7.archived, true, "7 d 1 h is");
  assert.equal(by.d7x.archived, false, "exactly 7 d is not more than 7 d");
  assert.equal(by.w.archived, false);
  const sum = j.projects[0].summary;
  assert.deepEqual(sum, {
    roadmaps: 1, phasesTotal: 5, phasesShipped: 2, legacyFiles: 0, legacyNames: [], active: 2, working: 1, waiting: 1, idle: 1, archived: 1,
    estimateActiveH: 5, workedActiveMs: by.w.workedMs + by.q.workedMs,
  });
  assert.equal(by.w.workedMs, 59 * MIN, "30 min in baseline, then 29 min in build up to the update one minute ago");
});

test("collect: a project that is not found has a summary of zeros, and a session of an older version (no trail) still works", async () => {
  const w = world("old");
  const p = w.proj("zork");
  enable(w);
  const id = idFor(w, p);
  const old = hand(w, id, "1", { step: "build", state: "working" });
  assert.equal(old.trail, undefined);
  rmSync(p, { recursive: true, force: true });
  const r = await col(w);
  assert.equal(r.code, 0, r.err);
  const j = r.json();
  assert.equal(j.projects[0].status, "not found");
  assert.deepEqual(j.projects[0].summary, { roadmaps: 0, phasesTotal: 0, phasesShipped: 0, legacyFiles: 0, legacyNames: [], active: 1, working: 1, waiting: 0, idle: 0, archived: 0, estimateActiveH: 0, workedActiveMs: 4 * MIN });
  assert.equal(j.sessions[0].workedMs, 4 * MIN);
});

test("collect: a bad trail skips the session and names the file only; more than 40 entries is a bad trail", async () => {
  const w = world("badtrail");
  const p = w.proj("zork");
  enable(w);
  const id = idFor(w, p);
  hand(w, id, "a", { step: "build", extra: { trail: "nope" } });
  hand(w, id, "b", { step: "build", extra: { trail: [{ step: "build", state: "working", at: "soon" }] } });
  hand(w, id, "c", { step: "build", extra: { trail: Array.from({ length: 41 }, () => ({ step: "build", state: "working", at: NOW })) } });
  hand(w, id, "d", { step: "build", extra: { trail: Array.from({ length: 40 }, () => ({ step: "build", state: "working", at: NOW })) } });
  const r = await col(w);
  const j = r.json();
  assert.deepEqual(j.sessions.map((s) => s.phase), ["d"]);
  assert.equal(j.errors.length, 3);
  assert.ok(j.errors.every((e) => e.file.endsWith(".json") && e.reason === "its trail is not as expected"));
});

test("collect: the new fields hold no absolute path and no raw < > &; collectData returns the same values the command prints", async () => {
  const w = world("safe");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("1", `Title ${HOSTILE.slice(0, 40)}`, "in progress")]));
  enable(w);
  setStatus(w, p, "1", "build", "working", NOW - 30 * MIN, ["--name", HOSTILE]);
  setStatus(w, p, "1", "compare", "working", NOW - MIN);
  const r = await col(w);
  assert.equal(r.code, 0, r.err);
  for (const c of ["<", ">", "&"]) assert.ok(!r.text.includes(c), `raw ${c} in the output`);
  noPath(w, r.text, "collect output");
  const got = await collectData({ data: w.data, now: NOW });
  assert.equal(got.ok, true);
  assert.deepEqual(got.data, r.json());
  assert.deepEqual(got.data.sessions[0].loops, []);
  const bad = await collectData({ data: "relative/dir", now: NOW });
  assert.deepEqual([bad.ok, bad.code, bad.usage], [false, 2, true]);
});

// ── page.mjs: rendering ─────────────────────────────────────────────────────
// A world with everything the page shows: a project with a waiting and a working session (a loop active), an idle one,
// an archived one, a roadmap with shipped phases and an unreadable roadmap file; a project with nothing running; and a
// project whose folder is gone.
async function richWorld() {
  const w = world("rich");
  const zork = w.proj("zork");
  const acme = w.proj("acmecorp");
  const north = w.proj("northwind");
  put(zork, RM, roadmap([
    rowE("1", "Sign-in screen", "shipped", "2h \u2192 1.5h", "1.8h"),
    rowE("2", "Audit log viewer", "shipped", "3h \u2192 2.2h", "1.4h"),
    rowE("11", "Search index rebuild for every tenant, including the archived ones", "in progress", "5.4 h \u2192 3.3 h + 1 h"),
    rowE("12", "Session timeout banner", "in progress"),
    rowE("14", "Legacy import", "parked"),
  ]));
  put(acme, RM, roadmap([rowE("5", "Password reset emails", "shipped", "2h \u2192 1.5h", "2.4h")]));
  put(north, RM, roadmap([rowE("3", "Onboarding checklist", "planned")]));
  enable(w);
  const zid = idFor(w, zork);
  const aid = idFor(w, acme);
  const nid = idFor(w, north);
  st(["register", "--data", w.data, "--root", zork, "--roadmap", "missing-plan.md"]);
  hand(w, zid, "11", { step: "build", trail: [["baseline", "working", 120], ["build", "working", 100], ["compare", "working", 60], ["build", "working", 30]] });
  hand(w, zid, "12", { step: "approve", state: "waiting", trail: [["build", "working", 50], ["approve", "waiting", 20]] });
  hand(w, zid, "13", { step: "build", updatedAgo: 5 * 60, startedAgo: 5 * 60 });
  hand(w, zid, "9", { step: "prod-check", state: "done", updatedAgo: 9 * 24 * 60, startedAgo: 9 * 24 * 60 });
  hand(w, aid, "5", { step: "prod-check", state: "done", updatedAgo: 20 * 24 * 60, startedAgo: 20 * 24 * 60 });
  rmSync(north, { recursive: true, force: true });
  const r = await col(w);
  assert.equal(r.code, 0, r.err);
  return { w, ids: { zid, aid, nid }, data: r.json() };
}

test("page: the hostile string is cleaned and escaped in a project name, a phase title, a session label, a phase id and an error file name", () => {
  const data = {
    v: 1, generatedAt: new Date(NOW).toISOString(), thresholds: { warnMin: 90, idleMin: 180 },
    projects: [{ id: "aaaaaaaaaaaa", name: HOSTILE, status: "ok", roadmaps: [{ file: HOSTILE, tables: 1, standard: true, phases: [{ id: "7", phase: HOSTILE, status: "shipped", kind: HOSTILE, priority: "P1", urgency: "Soon", estRaw: 2, estCal: 1.5, actual: 1, commit: HOSTILE, timestamps: {} }] }], history: [], errors: [{ file: HOSTILE, reason: HOSTILE }] }],
    sessions: [{ project: "aaaaaaaaaaaa", phase: HOSTILE, phase_name: HOSTILE, step: "build", state: "working", shown: "Working", noUpdate: false, updated: NOW - MIN, step_started: NOW - MIN, loops: [], rounds: 1, visits: { build: 1 }, workedMs: MIN, elapsedMs: MIN, estimateH: null, archived: false }],
    warnings: [], errors: [{ file: HOSTILE, reason: HOSTILE }],
  };
  const html = renderPage(data, { now: NOW, fonts: false });
  assert.ok(!html.includes("<script>alert"), "no raw script from the data");
  assert.ok(!html.includes("<img"), "no raw tag from the data");
  assert.equal(count(html, "<script"), 1, "the one script is ours");
  assert.equal(count(html, "</script"), 1);
  assert.ok(!html.includes(cp(0x202e)) && !html.includes(cp(0x202c)) && !html.includes(cp(7)), "control and bidirectional characters are gone");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt; &amp; &quot;double&quot; &#39;single&#39;"), "text is shown, escaped");
  assert.ok(!/<[^>]*\sonerror=/.test(html), "no handler attribute inside a tag");
  const markup = html.replace(/<script>[\s\S]*<\/script>/, "");
  for (const id of markup.match(/\sid="[^"]*"/g)) assert.match(id, /^\sid="(?:[a-z]{1,2}-[0-9a-f]{10}|main|pw-stale|pw-countdown|pw-pause|pw-summary)"$/, "ids are generated");
  for (const k of markup.match(/data-k="[^"]*"/g)) assert.match(k, /^data-k="[a-z]-[0-9a-f]{10}"$/);
});

test("page: one script whose SHA-256 is the CSP hash, nothing fetched, no src, in-page links only, data: urls only, no http", async () => {
  const { data } = await richWorld();
  const html = renderPage(data, { now: NOW });
  assert.equal(count(html, "<script"), 1);
  const js = scriptOf(html);
  assert.equal(js, readFileSync(join(ASSETS, "client.js"), "utf8"));
  const hash = createHash("sha256").update(js).digest("base64");
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
  assert.ok(html.includes("default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; script-src 'sha256-"));
  assert.ok(html.includes("base-uri 'none'; form-action 'none'\">"));
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'));
  const bare = stripB64(html);
  assert.ok(!/https?:\/\//i.test(bare), "no http or https address outside base64");
  assert.ok(!/\ssrc\s*=/i.test(bare), "no src attribute");
  const hrefs = bare.match(/\shref\s*=\s*"[^"]*"/gi) ?? [];
  for (const h of hrefs) assert.match(h, /^\shref="#[a-z-]+"$/, "a link stays in the page");
  const urls = cssOf(html).match(/url\([^)]*\)/g) ?? [];
  assert.ok(urls.length >= 2);
  for (const u of urls) assert.ok(u.startsWith("url(data:font/woff2;base64,"), `css url: ${u.slice(0, 30)}`);
  assert.ok(!/<(?:link|iframe|object|embed|form|img|base)\b/i.test(bare));
  assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(bare), "no event handler attribute");
  noPath((await richWorld()).w, bare, "page");
});

test("page: square drawing only: border radius 0, no circle or ellipse or round caps, no shadows or smooth gradients, straight arrows", async () => {
  const { data } = await richWorld();
  const html = renderPage(data, { now: NOW });
  const css = cssOf(html);
  for (const m of css.matchAll(/border-radius\s*:\s*([^;}]+)/g)) assert.equal(m[1].trim(), "0", "border-radius");
  assert.ok(!/<(?:circle|ellipse)\b/.test(html));
  assert.ok(!/\brx\s*=|\bry\s*=|stroke-linecap\s*[:=]\s*"?round|stroke-linejoin\s*[:=]\s*"?round/.test(html + css));
  assert.ok(!/box-shadow|text-shadow|drop-shadow|radial-gradient|conic-gradient|filter\s*:|blur\(/.test(css));
  const loopPaths = [...html.matchAll(/<path class="loop[^"]*" d="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(loopPaths.length >= 1);
  for (const d of loopPaths) assert.match(d, /^[MHV0-9. -]+$/, "a loop arrow uses only M, H and V");
  for (const d of html.match(/\sd="[^"]*"/g)) assert.ok(!/[CcQqAaSsTt]/.test(d), `curve command in ${d}`);
  assert.ok(css.includes("@media screen and (prefers-color-scheme:dark)"), "dark (blueprint) palette");
  assert.ok(css.includes("@media (prefers-reduced-motion:reduce)"));
  assert.ok(css.includes("@media print"));
  assert.ok(css.includes("#0D1F33") && css.includes("#F5F6F4"));
});

test("page: only the active loop moves, every arrow has a text label, a repeated gate says round N", async () => {
  const { w } = await flowWorld();
  const j = (await col(w)).json();
  const html = renderPage(j, { now: NOW, fonts: false });
  const css = cssOf(html);
  assert.equal(count(html, 'class="loop loop-active"'), j.sessions.filter((s) => s.loops.some((l) => l.active)).length, "an active loop is drawn for each session that has one");
  const sessions = html.split('<details class="sess"').slice(1);
  const withActive = sessions.filter((s) => s.includes("loop-active"));
  assert.equal(withActive.length, j.sessions.filter((s) => s.loops.some((l) => l.active)).length);
  for (const s of sessions) assert.ok(count(s, 'class="loop loop-active"') <= 1);
  assert.equal(count(html, '<path class="loop'), count(html, '<text class="loop-lbl'));
  for (const m of html.matchAll(/<text class="loop-lbl[^"]*"[^>]*>([^<]*)<\/text>/g)) assert.match(m[1], /^x \d+$/);
  assert.ok(html.includes(">round 2<") && html.includes(">round 3<"));
  assert.equal(count(html, '<text class="loop-name"'), count(html, '<text class="loop-lbl'), "each arrow also names its two gates in text");
  assert.ok(html.includes(">Compare back to Build<") && html.includes(">Prod check back to Build<"));
  // CSS motion: the loop arrow's dashes run only for the active loop (the other animations are tested with the hatching)
  assert.ok(/@media screen and \(prefers-reduced-motion:no-preference\)\{[\s\S]*\.flow \.loop-active\{animation:flow-dash/.test(css));
  assert.ok(css.includes("stroke-dashoffset"));
  assert.ok(!/transition\s*:\s*(?!none)/.test(css));
  assert.equal(count(css, "@keyframes"), 3, "the dashes of the loop arrow and the two drifts of the hatching");
});

test("page: phaseFlow draws eight gates; a session without a trail shows a plain flow; a hostile or unknown session draws nothing", () => {
  const base = { project: "aaaaaaaaaaaa", phase: "1", phase_name: "", step: "review", state: "working", shown: "Working", updated: NOW, step_started: NOW };
  const plain = phaseFlow(base);
  assert.equal(count(plain, "<g class=\"g-"), 8);
  assert.ok(plain.startsWith("<svg") && plain.endsWith("</svg>"));
  assert.equal(count(plain, 'class="loop'), 0);
  assert.equal(count(plain, "round "), 0);
  assert.equal(count(plain, "g-done"), 3);
  assert.equal(count(plain, "g-run"), 1);
  assert.equal(count(plain, "g-pend"), 4);
  assert.ok(!plain.includes("http"), "no namespace address");
  const looped = phaseFlow({ ...base, step: "build", loops: [{ from: "compare", to: "build", count: 3, active: true }, { from: "review", to: "build", count: 1, active: true }], visits: { build: 4, compare: 3, review: 1 }, rounds: 4 });
  assert.equal(count(looped, 'class="loop loop-active"'), 1, "two flagged active: one is kept");
  assert.ok(looped.includes(">x 3<") && looped.includes(">x 1<") && looped.includes(">round 4<"));
  assert.ok(looped.includes(">To redo<"), "a gate left for later but visited before");
  assert.equal(phaseFlow({ ...base, step: "<script>" }), "");
  assert.equal(phaseFlow(null), "");
  const bad = phaseFlow({ ...base, loops: [{ from: "build", to: "compare", count: 2 }, { from: "<x>", to: "build", count: 2 }, { from: "compare", to: "build", count: "<b>" }] });
  assert.equal(count(bad, '<path class="loop'), 1, "a forward move or an unknown step is not a loop; a bad count is 1");
  assert.ok(bad.includes(">x 1<"));
  const done = phaseFlow({ ...base, step: "prod-check", state: "done" });
  assert.equal(count(done, "g-done"), 8);
});

test("page: nested details for project, session, roadmap, estimate and archived; the first-load rule; sort order; summary on the row", async () => {
  const { data } = await richWorld();
  const html = renderPage(data, { now: NOW, fonts: false });
  assert.equal(count(html, "<details"), count(html, "</details>"));
  const projects = html.split('<details class="proj"').slice(1);
  assert.equal(projects.length, 3);
  const zork = projects.find((p) => p.includes(">zork<"));
  const acme = projects.find((p) => p.includes(">acmecorp<"));
  const north = projects.find((p) => p.includes(">northwind<"));
  assert.ok(/^ id="p-[0-9a-f]{10}" data-k="p-[0-9a-f]{10}" open data-attn>/.test(zork), "a project with a waiting session starts open");
  assert.ok(!/^[^>]*\sopen/.test(acme), "a project with nothing running starts closed");
  assert.ok(!/^[^>]*\sopen/.test(north));
  assert.ok(html.indexOf(">zork<") < html.indexOf(">acmecorp<") && html.indexOf(">acmecorp<") < html.indexOf(">northwind<"), "the project with something to do is first, then by name");
  for (const p of projects) {
    assert.equal(count(p, 'class="part"'), 3);
    assert.ok(p.includes("<summary>Roadmap ") && p.includes("<summary>Estimate against actual ") && p.includes("<summary>Archived sessions "));
  }
  assert.equal(count(zork, '<details class="sess"'), 3, "an archived session is not in the list");
  assert.ok(zork.indexOf('data-declared="waiting"') < zork.indexOf('data-declared="working"') && zork.indexOf('data-declared="working"') < zork.indexOf('data-declared="working" data-state="idle"') , "Waiting for you, then Working, then Idle");
  const zorkRow = zork.split("</summary>")[0];
  for (const label of ["Roadmaps", "Shipped", "Active", "Idle", "Archived", "Estimate, active"]) assert.ok(zorkRow.includes(`data-h="${label}"`), label);
  assert.ok(zorkRow.includes('<span class="kv">est <span class="fig">') && zorkRow.includes('<span class="kv">worked <span class="fig" data-proj-worked>'), "the estimate and the worked time are two lines of one cell");
  assert.ok(zorkRow.includes("2 of 5") && zorkRow.includes('data-n="working">1<') && zorkRow.includes('data-n="waiting">1<') && zorkRow.includes('data-n="idle">1<'));
  assert.ok(zorkRow.includes('data-wait-stamp>Waiting for you'));
  assert.ok(!acme.split("</summary>")[0].includes("data-wait-stamp>Waiting"), "no stamp when nothing waits");
  assert.ok(zork.includes("Archived sessions <span class=\"sub\">1</span>"));
});

test("page: empty and error states appear in context", async () => {
  const { data } = await richWorld();
  const html = renderPage(data, { now: NOW, fonts: false });
  const projects = html.split('<details class="proj"').slice(1);
  const acme = projects.find((p) => p.includes(">acmecorp<"));
  const north = projects.find((p) => p.includes(">northwind<"));
  const zork = projects.find((p) => p.includes(">zork<"));
  assert.ok(acme.includes("No session is running a phase."), "no sessions, inside its project");
  assert.ok(!zork.includes("No session is running a phase."));
  assert.ok(north.includes("Project folder not found.") && north.split("</summary>")[0].includes("Folder not found"));
  assert.ok(zork.includes("missing-plan.md: not found"), "an unreadable roadmap names its file and the reason only");
  assert.ok(zork.split("</summary>")[0].includes("1 file problem"));
  assert.ok(zork.includes("Two sessions in one repo."));
  assert.ok(!acme.includes("No archived sessions.") && acme.includes("Archived sessions <span class=\"sub\">1</span>"));
  assert.ok(north.includes("No archived sessions."));
  assert.ok(north.includes("No phase has an actual time yet."));
  assert.ok(html.includes('id="pw-stale" hidden role="status"'), "the stale-page banner is at the top, hidden until the script shows it");
  assert.ok(html.indexOf('id="pw-stale"') < html.indexOf("<main"));
  assert.ok(html.includes("<noscript>") && html.includes("Scripts are off"));
  const none = renderPage({ v: 1, generatedAt: new Date(NOW).toISOString(), projects: [], sessions: [], warnings: [], errors: [] }, { now: NOW, fonts: false });
  assert.ok(none.includes("No projects are listed yet."));
  assert.equal(count(none, "<details"), 0);
  const skipped = renderPage({ v: 1, projects: [], sessions: [], warnings: [], errors: [{ file: "abc-1.json", reason: "not valid JSON" }] }, { now: NOW, fonts: false });
  assert.ok(skipped.includes("abc-1.json: not valid JSON"));
});

test("page: estimate against actual, roadmap rows and archived rows show their numbers", async () => {
  const { data } = await richWorld();
  const html = renderPage(data, { now: NOW, fonts: false });
  const zork = html.split('<details class="proj"').slice(1).find((p) => p.includes(">zork<"));
  assert.ok(zork.includes("2 phases with a time"));
  assert.ok(zork.includes("<strong>1.8 h</strong>") && zork.includes("+0.3 h") && zork.includes(`${cp(0x2212)}0.8 h`), "signed variance with a true minus");
  assert.ok(zork.includes("Total, 2 phases") && zork.includes("3.2 h"));
  assert.ok(zork.includes('<svg class="eva"'));
  assert.ok(zork.includes("5.4 h &rarr; 3.3 h"));
  assert.ok(zork.includes('class="r-parked"'));
  assert.ok(zork.includes("Search index rebuild for every tenant"));
  assert.ok(zork.includes("2026-10-18"), "the archived session's date");
});

test("page: size, fonts and --no-fonts", async () => {
  const { data } = await richWorld();
  const withFonts = renderPage(data, { now: NOW });
  const without = renderPage(data, { now: NOW, fonts: false });
  assert.ok(Buffer.byteLength(withFonts) < 256 * 1024);
  assert.ok(withFonts.includes('@font-face{font-family:"PW Sans"') && withFonts.includes('@font-face{font-family:"PW Mono"'));
  assert.ok(!without.includes("@font-face") && !without.includes("base64,"));
  assert.ok(cssOf(without).includes('--sans:"PW Sans","Helvetica Neue",Helvetica,Arial,sans-serif'), "a system stack follows the named font");
  assert.ok(Buffer.byteLength(without) < Buffer.byteLength(withFonts) - 30000);
  for (const h of [withFonts, without]) {
    assert.ok(h.includes('Reserved Font Name "Plex"') && h.includes("SIL Open Font License, Version 1.1") && h.includes("renamed PW Sans and PW Mono"));
    assert.ok(h.includes("Copyright 2017 IBM Corp."));
    const comment = h.match(/<!--[\s\S]*?-->/)[0];
    assert.ok(!comment.slice(4, -3).includes("--"));
  }
});

test("page: the client script makes no request, builds no address and writes only text", () => {
  const js = readFileSync(join(ASSETS, "client.js"), "utf8");
  for (const token of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "eval", "Function", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "src", "href=", "href", "new URL", "location.href", "location.assign", "location.replace", "import(", "importScripts", "postMessage", "localStorage", "document.cookie", "Worker", "createElement", "setAttribute(\"on", "http:", "https:"]) {
    assert.ok(!js.includes(token), `the client script uses ${token}`);
  }
  assert.ok(js.includes("textContent") && js.includes("location.reload()") && js.includes("sessionStorage"));
  assert.ok(!js.includes("</script") && !js.includes("<script"));
  assert.ok(/pw:o:/.test(js) && /\^\[a-z\]-\[0-9a-f\]\{10\}\$/.test(js), "open states are keyed by a generated slug, checked against a fixed pattern");
  for (const key of ["data-refresh-s", "refreshS", "beforeprint", "pointerdown", "data-t", "pw-stale"]) assert.ok(js.includes(key) || js.includes(key.replace("data-", "").replace(/-([a-z])/g, (_, c) => c.toUpperCase())), key);
  assert.ok(js.includes("4000") && js.includes("60000") && js.includes("5, 300"));
  assert.ok(js.includes("Date.now()") && js.includes("PAGE_STALE"));
  assert.ok(!/[^\x00-\x7f]/.test(js), "the script is plain ASCII");
});

test("page: the fonts are woff2 and the licence text is the SIL Open Font License 1.1 with the Reserved Font Name", () => {
  for (const f of ["pw-sans.woff2", "pw-mono.woff2"]) {
    const bytes = readFileSync(join(ASSETS, f));
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", f);
    assert.ok(bytes.length > 2000 && bytes.length < 60000);
  }
  const ofl = readFileSync(join(ASSETS, "OFL.txt"), "utf8");
  assert.ok(ofl.includes("SIL OPEN FONT LICENSE Version 1.1"));
  assert.ok(ofl.includes('Reserved Font Name "Plex"'));
  const assets = loadAssets();
  assert.ok(assets.sans.length && assets.mono.length && assets.css.length && assets.js.length);
  assert.equal(loadAssets({ fonts: false }).sans, undefined);
});

test("page: refresh seconds and the written time are in the body; the clock times come from data-t in milliseconds", async () => {
  const { data } = await richWorld();
  const html = renderPage(data, { now: NOW, fonts: false, refreshS: 30 });
  assert.ok(html.includes('data-refresh-s="30"') && html.includes('data-warn-min="90"') && html.includes('data-idle-min="180"') && html.includes('data-page-stale-min="90"'));
  assert.ok(html.includes(`data-written data-clock data-t="${NOW}"`));
  assert.ok(renderPage(data, { now: NOW, fonts: false, refreshS: 2 }).includes('data-refresh-s="10"'), "out of range falls back to 10");
  assert.ok(html.includes(`data-t="${NOW - MIN}"`));
});

test("page: the loop arrow has room under the gates, a thick line, a clear head and its text on its own line; the flow scrolls with a hint on a narrow screen", async () => {
  const base = { project: "aaaaaaaaaaaa", phase: "1", phase_name: "", step: "build", state: "working", shown: "Working", updated: NOW, step_started: NOW };
  const flow = phaseFlow({ ...base, loops: [{ from: "compare", to: "build", count: 2, active: true }, { from: "review", to: "build", count: 1, active: false }], visits: { build: 3, compare: 2 }, rounds: 3 });
  const paths = [...flow.matchAll(/<path class="loop[^"]*" d="M([\d.]+) (\d+)V(\d+)H([\d.]+)V(\d+)"/g)].map((m) => m.slice(1).map(Number));
  assert.equal(paths.length, 2);
  for (const [xf, y0, yd, xt, y1] of paths) {
    assert.equal(y0, 64, "the line leaves the bottom edge of a gate");
    assert.ok(yd - y0 >= 30, "at least 30 units of room under the gates");
    assert.ok(y1 - y0 >= 10 && y1 < yd, "the up leg ends where the head starts");
    assert.ok(xf !== xt);
  }
  assert.ok(paths[1][2] - paths[0][2] >= 30, "a second loop is a full row lower");
  const heads = [...flow.matchAll(/<polygon class="loop-head[^"]*" points="([^"]*)"/g)].map((m) => m[1].split(" ").map((p) => p.split(",").map(Number)));
  assert.equal(heads.length, 2);
  for (const [a, b, tip] of heads) assert.ok(b[0] - a[0] >= 12 && a[1] - tip[1] >= 10, "a head at least 12 wide and 10 tall");
  const viewH = Number(flow.match(/viewBox="0 0 976 (\d+)"/)[1]);
  assert.ok(viewH >= paths[1][2] + 20, "the drawing is tall enough for the last label");
  const labelYs = [...flow.matchAll(/<text class="loop-(?:lbl|name)[^"]*" x="[\d.]+" y="(\d+)"/g)].map((m) => Number(m[1]));
  for (const y of labelYs) assert.ok(y < viewH);
  const css = cssOf(renderPage({ v: 1, projects: [], sessions: [], warnings: [], errors: [] }, { now: NOW, fonts: false }));
  const width = (sel) => Number(css.match(new RegExp(`${sel}\\{[^}]*stroke-width:([\\d.]+)`))[1]);
  assert.ok(width("\\.flow \\.loop") >= 2.5 && width("\\.flow \\.loop-active") > width("\\.flow \\.loop"));
  assert.ok(css.includes("@media (max-width:640px){\n  .flow{min-width:976px}"), "at 400 px the drawing keeps its size and scrolls");
  assert.ok(css.includes(".scroll-hint{display:none") && css.includes("@media (max-width:1040px){\n  .scroll-hint{display:block}") && css.includes(".scroll-hint{display:none!important}"), "the hint shows on narrow screens, not in print");
  const { data } = await richWorld();
  const html = renderPage(data, { now: NOW, fonts: false });
  assert.ok(html.includes('class="scroll" role="region" aria-label="Phase flow of this session, scrolls sideways on a narrow screen" tabindex="0"'), "a labelled, keyboard-focusable scroll region");
  assert.ok(html.includes('<p class="scroll-hint" aria-hidden="true">Narrow screen'));
});

// ── page.mjs: the command ───────────────────────────────────────────────────
test("page command: writes <data>/dashboard.html by default, atomically, with no temp file left", async () => {
  const w = world("write");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working", NOW - MIN);
  const r = await pg(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith("wrote dashboard.html: 1 project(s), 1 session(s)"));
  assert.ok(!r.out.includes(w.base), "the message holds no path");
  assert.deepEqual(listing(w.data).filter((n) => n.startsWith("dashboard.html")), ["dashboard.html"]);
  const html = readFileSync(join(w.data, "dashboard.html"), "utf8");
  assert.ok(html.startsWith("<!doctype html>"));
  noPath(w, stripB64(html), "page file");
  const again = await pg(["--data", w.data, "--refresh-s", "45", "--no-fonts"]);
  assert.equal(again.code, 0, again.err);
  const second = readFileSync(join(w.data, "dashboard.html"), "utf8");
  assert.ok(second.includes('data-refresh-s="45"') && !second.includes("@font-face"));
  assert.deepEqual(listing(w.data).filter((n) => n.includes(".tmp-")), []);
});

test("page command: a failed rename leaves the old page whole and no temp file", async () => {
  const w = world("atomic");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working", NOW - MIN);
  put(w.data, "dashboard.html", "OLD PAGE");
  const err = Object.assign(new Error("no"), { code: "EXDEV" });
  const r = await pg(["--data", w.data], { rename: () => { throw err; } });
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("nothing was written") && r.err.includes("EXDEV"));
  assert.equal(readFileSync(join(w.data, "dashboard.html"), "utf8"), "OLD PAGE");
  assert.deepEqual(listing(w.data).filter((n) => n.includes(".tmp-")), []);
});

test("page command: --out is refused inside the data folder (any name but the default), allowed elsewhere", async () => {
  const w = world("out");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working", NOW - MIN);
  const before = listing(w.data).join(",");
  for (const target of [join(w.data, "other.html"), join(w.data, "sessions", "x.html"), join(w.data, "projects.json")]) {
    const r = await pg(["--data", w.data, "--out", target]);
    assert.equal(r.code, 2, target);
    assert.ok(r.err.includes("must not be in the data folder"));
  }
  assert.equal(listing(w.data).join(","), before, "nothing was written");
  const elsewhere = join(w.base, "site");
  mkdirSync(elsewhere);
  const ok = await pg(["--data", w.data, "--out", join(elsewhere, "page.html")]);
  assert.equal(ok.code, 0, ok.err);
  assert.ok(existsSync(join(elsewhere, "page.html")));
  assert.ok(!existsSync(join(w.data, "dashboard.html")), "the default file is not written when --out is given");
  const same = await pg(["--data", w.data, "--out", join(w.data, "dashboard.html")]);
  assert.equal(same.code, 0, same.err);
  assert.ok(existsSync(join(w.data, "dashboard.html")));
});

test("page command: a relative, empty or missing --data and bad numbers are usage errors; the data folder is never created", async () => {
  const w = world("usage");
  for (const argv of [[], ["--data", ""], ["--data", `relative${sep}dir`], ["--data", w.data, "--refresh-s", "4"], ["--data", w.data, "--refresh-s", "301"], ["--data", w.data, "--refresh-s", "x"], ["--data", w.data, "--now", "-1"], ["--data", w.data, "--bogus"], ["--data", w.data, "--out", ""], ["--data", w.data, "extra"]]) {
    const r = await pg(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.ok(r.err.includes("usage: page.mjs"));
  }
  assert.ok(!existsSync(w.data));
  const missing = await pg(["--data", w.data]);
  assert.equal(missing.code, 1);
  assert.ok(missing.err.includes("not created"));
  assert.ok(!existsSync(w.data), "the data folder is not created for the default file");
  const elsewhere = join(w.base, "page.html");
  const ok = await pg(["--data", w.data, "--out", elsewhere]);
  assert.equal(ok.code, 0, ok.err);
  assert.ok(readFileSync(elsewhere, "utf8").includes("No projects are listed yet."));
  assert.ok(!existsSync(w.data), "nor for an --out elsewhere");
});

test("page command: a page over the size limit is not written", async () => {
  const w = world("big");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working", NOW - MIN);
  const r = await pg(["--data", w.data], { maxPageBytes: 20000 });
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("over the 20 KB limit") && r.err.includes("--no-fonts"));
  assert.ok(!existsSync(join(w.data, "dashboard.html")));
  const small = await pg(["--data", w.data, "--no-fonts"], { maxPageBytes: 1024 * 1024 });
  assert.equal(small.code, 0, small.err);
});

test("page command: a data folder that is a file or link fails closed and writes nothing", async () => {
  const w = world("closed");
  mkdirSync(w.base, { recursive: true });
  writeFileSync(w.data, "not a folder");
  const r = await pg(["--data", w.data]);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("cannot use the data folder"));
  assert.equal(readFileSync(w.data, "utf8"), "not a folder");
});

// ── status.mjs: the page is rebuilt at every step ───────────────────────────
async function sr(argv, o = {}) {
  const out = [];
  const err = [];
  const code = await statusRun(argv, { out: (s) => out.push(s), err: (s) => err.push(s), now: () => NOW, ...o });
  return { code, out: out.join("\n"), err: err.join("\n"), lines: out };
}
const setArgs = (w, root, phase, step, state, extra = []) => ["set", "--data", w.data, "--root", root, "--phase", phase, "--step", step, "--state", state, ...extra];
const pageFile = (w) => join(w.data, "dashboard.html");

test("rebuild: a set while the dashboard is on writes <data>/dashboard.html with the session in it, and prints nothing more", async () => {
  const w = world("rb-set");
  const p = w.proj();
  enable(w);
  const r = await sr(setArgs(w, p, "zork1", "build", "working", ["--name", "Zork thing"]));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines, ["status set: phase zork1 build working"]);
  assert.ok(existsSync(pageFile(w)));
  const html = readFileSync(pageFile(w), "utf8");
  assert.ok(html.startsWith("<!doctype html>") && html.includes("#zork1") && html.includes("Zork thing"));
  assert.ok(html.includes("@font-face"), "the rebuilt page has its fonts");
  assert.deepEqual(listing(w.data).filter((n) => n.includes(".tmp-")), []);
  await sr(setArgs(w, p, "zork1", "compare", "waiting"));
  assert.ok(readFileSync(pageFile(w), "utf8").includes('data-declared="waiting"'), "each step rebuilds");
});

test("rebuild: clear rebuilds the page without the session; a clear with nothing to clear builds nothing", async () => {
  const w = world("rb-clear");
  const p = w.proj();
  enable(w);
  await sr(setArgs(w, p, "zork1", "build", "working"));
  assert.ok(readFileSync(pageFile(w), "utf8").includes("#zork1"));
  let calls = 0;
  const seen = async () => { calls++; return { ok: true }; };
  const gone = await sr(["clear", "--data", w.data, "--root", p, "--phase", "zork1"]);
  assert.equal(gone.code, 0, gone.err);
  assert.ok(!readFileSync(pageFile(w), "utf8").includes("#zork1"));
  assert.ok(readFileSync(pageFile(w), "utf8").includes("No session is running a phase."));
  const none = await sr(["clear", "--data", w.data, "--root", p, "--phase", "zork1"], { buildPage: seen });
  assert.equal(none.code, 0);
  assert.equal(calls, 0, "nothing was cleared, so nothing is rebuilt");
});

test("rebuild: while the dashboard is off, or when the command failed, nothing is built", async () => {
  const w = world("rb-off");
  const p = w.proj();
  let calls = 0;
  const seen = async () => { calls++; return { ok: true }; };
  const never = await sr(setArgs(w, p, "zork1", "build", "working"), { buildPage: seen });
  assert.equal(never.code, 0);
  assert.ok(never.out.includes("nothing written"));
  assert.ok(!existsSync(w.data), "the data folder is not created");
  enable(w);
  assert.equal(st(["disable", "--data", w.data]).code, 0);
  const off = await sr(setArgs(w, p, "zork1", "build", "working"), { buildPage: seen });
  assert.equal(off.code, 0);
  assert.ok(!existsSync(pageFile(w)));
  const offClear = await sr(["clear", "--data", w.data, "--root", p, "--phase", "zork1"], { buildPage: seen });
  assert.equal(offClear.code, 0);
  assert.ok(!existsSync(pageFile(w)));
  enable(w);
  const bad = await sr(setArgs(w, p, "bad phase", "build", "working"), { buildPage: seen });
  assert.equal(bad.code, 2);
  const badStep = await sr(setArgs(w, p, "zork1", "nope", "working"), { buildPage: seen });
  assert.equal(badStep.code, 2);
  const lone = await sr(["state", "--data", w.data], { buildPage: seen });
  assert.equal(lone.code, 0);
  assert.equal(calls, 0, "off, a refused command and the read-only commands build nothing");
  assert.ok(!existsSync(pageFile(w)));
});

test("rebuild: a builder that fails or throws still exits 0 and prints one line with a code or a fixed phrase, never a path or text", async () => {
  const w = world("rb-fail");
  const p = w.proj();
  enable(w);
  const secret = join(w.base, "secret-place", "file.txt");
  const cases = [
    [async () => { throw Object.assign(new Error(secret), { code: "EPERM" }); }, "EPERM"],
    [async () => { throw new Error(secret); }, "error"],
    [async () => ({ ok: false, reason: secret }), "error"],
    [async () => ({ ok: false, reason: "page too large" }), "page too large"],
    [async () => ({ ok: false }), "error"],
    [async () => undefined, "error"],
    [() => { throw Object.assign(new Error("x"), { code: "<script>" }); }, "error"],
  ];
  for (const [buildPageFn, reason] of cases) {
    const r = await sr(setArgs(w, p, "zork1", "build", "working"), { buildPage: buildPageFn });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.length, 2, "the status line and one page line");
    assert.equal(r.lines[1], `page not rebuilt (${reason})`);
    assert.ok(!r.out.includes(secret) && !r.out.includes(w.base) && !r.err.includes(w.base));
  }
  const session = readJson(w.data, `sessions/${sname(idFor(w, p), "zork1")}`);
  assert.equal(session.step, "build", "the status was written whatever the page did");
});

test("rebuild: the builder is given the data folder and nothing else; the real builder reports a folder that is not there and never creates it", async () => {
  const w = world("rb-args");
  const p = w.proj();
  enable(w);
  const calls = [];
  await sr(setArgs(w, p, "zork1", "build", "working"), { buildPage: async (...args) => { calls.push(args); return { ok: true }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], w.data);
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["nowMs", "rename"]);
  assert.equal(calls[0][1].nowMs, NOW);
  const gone = join(w.base, "never-made");
  assert.deepEqual(await buildPage(gone, { now: NOW }), { ok: false, reason: "no data folder" });
  assert.deepEqual(await buildPage("relative", { now: NOW }), { ok: false, reason: "bad folder" });
  assert.deepEqual(await buildPage(undefined), { ok: false, reason: "bad folder" });
  assert.ok(!existsSync(gone), "the data folder is never created");
  assert.deepEqual((await buildPage(w.data, { now: NOW, maxPageBytes: 1000 })), { ok: false, reason: "page too large" });
  const ok = await buildPage(w.data, { now: NOW });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(listing(w.data).filter((n) => n.startsWith("dashboard.html")), ["dashboard.html"]);
});

test("rebuild: the real builder failing (the page name is a folder, a rename refused) exits 0 with the one line", async () => {
  const w = world("rb-real");
  const p = w.proj();
  enable(w);
  mkdirSync(pageFile(w));
  const r = await sr(setArgs(w, p, "zork1", "build", "working"));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines.at(-1), "page not rebuilt (not a regular file)");
  rmSync(pageFile(w), { recursive: true });
  const denied = await sr(setArgs(w, p, "zork1", "compare", "working"), { rename: () => { throw Object.assign(new Error(w.base), { code: "EXDEV" }); } });
  assert.equal(denied.code, 1, "the same rename seam also refuses the session write, which is a status failure and not a page failure");
  const bad = await buildPage(w.data, { now: NOW, rename: () => { throw Object.assign(new Error(w.base), { code: "EXDEV" }); } });
  assert.deepEqual(bad, { ok: false, reason: "EXDEV" });
  assert.ok(!existsSync(pageFile(w)));
  assert.deepEqual(listing(w.data).filter((n) => n.includes(".tmp-")), []);
});

test("rebuild: run as a command (a real process) writes the page after set and clear, and the exit code stays 0 when the page cannot be written", () => {
  const w = world("rb-proc");
  const p = w.proj();
  enable(w);
  const script = join(SKILL, "scripts", "status.mjs");
  const go = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const set = go(setArgs(w, p, "zork1", "build", "working"));
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.stdout.trim(), "status set: phase zork1 build working");
  assert.ok(readFileSync(pageFile(w), "utf8").includes("#zork1"));
  const clear = go(["clear", "--data", w.data, "--root", p, "--phase", "zork1"]);
  assert.equal(clear.status, 0, clear.stderr);
  assert.ok(!readFileSync(pageFile(w), "utf8").includes("#zork1"));
  rmSync(pageFile(w));
  mkdirSync(pageFile(w));
  const blocked = go(setArgs(w, p, "zork2", "build", "working"));
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.ok(blocked.stdout.includes("page not rebuilt (not a regular file)"));
  assert.ok(!blocked.stdout.includes(w.base) && !blocked.stderr.includes(w.base));
});

test("rebuild: status.mjs has one fixed import of ./page.mjs, hands the builder the data folder only, and a build failure never reaches the exit code", () => {
  const src = readFileSync(join(SKILL, "scripts", "status.mjs"), "utf8");
  assert.equal(count(src, "import("), 1);
  assert.ok(src.includes('await import("./page.mjs")'));
  assert.ok(src.includes("(after.dir, { nowMs: after.nowMs, rename: io.rename })"));
  const body = src.slice(src.indexOf("export async function run("), src.indexOf("function execute("));
  assert.ok(body.includes("try {") && body.includes("catch (e)") && body.includes("return code;"), "the page step is inside a try and returns the command's own code");
  assert.ok(!/return\s+1/.test(body.slice(body.indexOf("if (code !== 0"))), "after the command no path returns a failure code");
  assert.ok(src.includes("process.exitCode = await run(process.argv.slice(2));"), "the command line runs the rebuilding entry");
});

// ── the personal copy ───────────────────────────────────────────────────────
test("sync-personal: ps-dashboard gets every asset byte for byte, its page.mjs builds the page with the fonts and the policy, and its status.mjs rebuilds it", () => {
  const home = tmp("home");
  const env = { ...process.env, SYNC_PERSONAL_CLAUDE_HOME: home };
  const sync = spawnSync(process.execPath, [join(HERE, "..", "scripts", "sync-personal.mjs")], { encoding: "utf8", env });
  assert.equal(sync.status, 0, sync.stderr);
  const dash = join(home, "skills", "ps-dashboard");
  const names = readdirSync(ASSETS).sort();
  assert.deepEqual(names, ["OFL.txt", "client.js", "page.css", "pw-mono.woff2", "pw-sans.woff2"]);
  assert.deepEqual(readdirSync(join(dash, "assets")).sort(), names, "every file of assets/ is installed");
  for (const f of names) assert.equal(Buffer.compare(readFileSync(join(dash, "assets", f)), readFileSync(join(ASSETS, f))), 0, `${f} is copied byte for byte`);
  for (const f of ["page.mjs", "status.mjs", "collect.mjs"]) assert.equal(Buffer.compare(readFileSync(join(dash, "scripts", f)), readFileSync(join(SKILL, "scripts", f))), 0, `${f} is copied byte for byte`);
  const check = spawnSync(process.execPath, [join(HERE, "..", "scripts", "sync-personal.mjs"), "--check"], { encoding: "utf8", env });
  assert.equal(check.status, 0, check.stdout);

  const w = world("personal");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "zork1", "build", "working", NOW - MIN);
  const outFile = join(w.base, "personal-page.html");
  const made = spawnSync(process.execPath, [join(dash, "scripts", "page.mjs"), "--data", w.data, "--out", outFile, "--now", String(NOW)], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const html = readFileSync(outFile, "utf8");
  assert.ok(html.includes("#zork1") && html.includes("Content-Security-Policy") && html.includes("script-src 'sha256-"));
  for (const f of ["pw-sans.woff2", "pw-mono.woff2"]) assert.ok(html.includes(readFileSync(join(dash, "assets", f)).toString("base64")), `${f} is embedded`);
  assert.ok(html.includes(readFileSync(join(ASSETS, "pw-sans.woff2")).toString("base64")), "the embedded font is the original's bytes");
  assert.equal(html, (() => { const r = spawnSync(process.execPath, [join(SKILL, "scripts", "page.mjs"), "--data", w.data, "--out", join(w.base, "plugin-page.html"), "--now", String(NOW)], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return readFileSync(join(w.base, "plugin-page.html"), "utf8"); })(), "the personal copy builds the same page as the plugin");
  const set = spawnSync(process.execPath, [join(dash, "scripts", "status.mjs"), ...setArgs(w, p, "zork2", "build", "working")], { encoding: "utf8" });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.stdout.trim(), "status set: phase zork2 build working");
  assert.ok(readFileSync(pageFile(w), "utf8").includes("#zork2"), "the personal status.mjs rebuilds the page");
});

// ── more edge cases and the source checks of the page ───────────────────────
test("trail: a rollback from prod-check to build and the same gate twice show as loops on the drawn page with their counts", async () => {
  const w = world("edge");
  const p = w.proj();
  enable(w);
  const id = idFor(w, p);
  hand(w, id, "roll", { step: "build", trail: [["baseline", "working", 100], ["build", "working", 90], ["prod-check", "working", 60], ["build", "working", 20]] });
  hand(w, id, "twice", { step: "build", trail: [["build", "working", 90], ["compare", "working", 80], ["build", "working", 70], ["compare", "working", 60], ["build", "working", 50]] });
  const r = await col(w);
  const html = renderPage(r.json(), { now: NOW, fonts: false });
  const rows = html.split('<details class="sess"').slice(1);
  const roll = rows.find((x) => x.includes("#roll"));
  const twice = rows.find((x) => x.includes("#twice"));
  assert.ok(roll.includes(">Prod check back to Build<") && roll.includes(">x 1<") && roll.includes('class="loop loop-active"'));
  assert.ok(twice.includes(">Compare back to Build<") && twice.includes(">x 2<") && twice.includes(">round 3<"));
  assert.ok(roll.includes("Loops: Prod check back to Build x 1 (running now)."));
});

test("page: every expectation of this file is platform independent (no drive letter, no fixed temp folder, no platform test)", () => {
  const src = readFileSync(join(HERE, "dashboard-page.test.mjs"), "utf8");
  // the lines that hold the patterns themselves are left out of the scan
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.includes("banned")).join("\n");
  const banned = [/[A-Za-z]:\\\\/, /[A-Za-z]:\\[A-Za-z]/, /["'`]\/tmp\b/, /process\.platform/, /["'`]C:/i, /AppData/, /\\Users\\/];
  for (const re of banned) assert.ok(!re.test(code), `a platform-dependent text matched ${re}`);
  assert.ok(code.includes("tmpdir()") && code.includes("sep"));
});

test("page: the client script reads sessionStorage only as a true or false from a fixed key pattern, or as a number or a checked key", () => {
  const js = readFileSync(join(ASSETS, "client.js"), "utf8");
  const reads = [...js.matchAll(/getItem\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(reads, ["key", '"pw:y"', '"pw:focus"'], "three reads: the flag helper, the scroll position, the focused row");
  assert.ok(js.includes('return v === "1" ? true : v === "0" ? false : null;'), "a flag is a boolean or null, whatever was stored");
  const flagCalls = [...js.matchAll(/\bflag\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== "key");
  assert.deepEqual(flagCalls, ['"pw:o:" + k', '"pw:paused"'], "flags are read from two fixed key forms");
  assert.ok(js.includes("var SLUG = /^[a-z]-[0-9a-f]{10}$/;"));
  const openRead = js.slice(js.indexOf('list("details[data-k]").forEach'), js.indexOf("doc.addEventListener(\"toggle\""));
  assert.ok(openRead.indexOf("SLUG.test(k)") > -1 && openRead.indexOf("SLUG.test(k)") < openRead.indexOf('flag("pw:o:" + k)'), "the key is checked before it is used");
  assert.ok(js.includes('put("pw:o:" + k, d.open ? "1" : "0")') && js.includes('put("pw:paused", paused ? "1" : "0")'), "only 1 and 0 are written for flags");
  assert.ok(js.includes("isFinite(y) && y > 0 && y < 1e7"), "the scroll position is a bounded number");
  assert.ok(js.includes("want === \"pause\" && btn") && js.includes("SLUG.test(want)"), "the stored focus is the word pause or a checked key");
  assert.ok(!js.includes("JSON.parse") && !js.includes("JSON.stringify"));
});

// ── fix round 1 ─────────────────────────────────────────────────────────────
// A project as the collected data holds it, with a roadmap of `rows` rows (every third one shipped, with an actual time).
const fakeProject = (n, label, rows = 0, extra = {}) => ({
  id: String(n).padStart(12, "a"), name: label, status: "ok",
  roadmaps: Array.from({ length: Math.ceil(rows / 300) }, (_, c) => ({ file: `plan-${c}.md`, tables: 1, standard: true, phases: Array.from({ length: Math.min(300, rows - c * 300) }, (_, j0) => { const j = c * 300 + j0; return { id: String(j + 1), phase: `Phase ${j + 1} of ${label}, with a title of a fair length to fill a row`, status: j % 3 === 0 ? "shipped" : "planned", kind: "backend", priority: "P1", urgency: "Soon", estRaw: 2, estCal: 1.5, estimateH: null, actual: j % 3 === 0 ? 1.2 : null, commit: "abc1234", timestamps: {} }; }) })),
  history: [], errors: [], ...extra,
});
const fakeSession = (project, phase, state = "working", ago = 1) => ({ project: project.id, phase, phase_name: "", step: "build", state, shown: state === "working" ? "Working" : "Waiting", noUpdate: false, updated: NOW - ago * MIN, step_started: NOW - ago * MIN, loops: [], rounds: 1, visits: { build: 1 }, workedMs: 0, elapsedMs: 0, estimateH: null, archived: false });
const fakeData = (projects, sessions = []) => ({ v: 1, generatedAt: new Date(NOW).toISOString(), thresholds: { warnMin: 90, idleMin: 180 }, projects, sessions, warnings: [], errors: [] });
const KB = 1024;
const bytesOf = (s) => Buffer.byteLength(s);
const LEFT_OUT = "left out to keep the page small";
const blockOf = (html, name) => html.split('<details class="proj"').slice(1).find((b) => b.includes(`>${name}<`));

test("big page: over 256 KB the tables of projects with no running session are left out, largest first, until it fits; row, sessions and archive stay", () => {
  const huge = fakeProject(1, "hugeco", 600);
  const mid = fakeProject(2, "midco", 120);
  const small = fakeProject(3, "smallco", 20);
  const busy = fakeProject(4, "busyco", 80);
  const data = fakeData([huge, mid, small, busy], [fakeSession(busy, "b1")]);
  const whole = renderPage(data, { now: NOW, softBytes: 1000 * KB * KB });
  assert.ok(bytesOf(whole) > 256 * KB, "the data is big enough to need the rule");
  assert.equal(count(whole, LEFT_OUT), 0, "a page that is allowed to be big is whole");
  const html = renderPage(data, { now: NOW });
  assert.ok(bytesOf(html) <= 256 * KB, `the page is ${bytesOf(html)} bytes`);
  assert.equal(count(html, '<summary class="prow">'), 4, "every project keeps its row");
  assert.ok(html.includes("#b1"), "the session stays");
  assert.ok(blockOf(html, "busyco").includes('aria-label="Roadmap table"') && !blockOf(html, "busyco").includes(LEFT_OUT), "a running project keeps its tables");
  const h = blockOf(html, "hugeco");
  assert.ok(h.includes(`${LEFT_OUT}: 800 rows`) && h.includes("the dashboard JSON still has them"), "600 roadmap rows and 200 shipped rows");
  assert.ok(!h.includes('aria-label="Roadmap table"') && !h.includes("tbl-est"));
  assert.ok(h.includes("No archived sessions.") && h.includes("No session is running a phase."), "the other parts stay");
  assert.ok(h.includes('<span class="fig">200 of 600</span>'), "the project row still has its numbers");
  assert.ok(html.includes("<strong>Page kept small.</strong>") && html.includes("are left out to keep the page small ("), "a visible line says it left something out");
  // largest first: with only the biggest one dropped the page fits, so the smaller ones keep their tables
  assert.ok(blockOf(html, "midco").includes('aria-label="Roadmap table"') && blockOf(html, "smallco").includes('aria-label="Roadmap table"'), "no more is left out than needed");
  assert.ok(html.includes("tables of 1 project with no running session"));
});

test("big page: running projects lose their tables only after the idle ones, never their rows or sessions; a page that fits has no note; idle projects go until it fits", () => {
  const busy = [1, 2, 3, 4].map((n) => fakeProject(n, `busy${n}co`, 200));
  const data = fakeData(busy, busy.map((p, i) => fakeSession(p, `r${i}`, i % 2 ? "waiting" : "working")));
  assert.ok(bytesOf(renderPage(data, { now: NOW, softBytes: 1000 * KB * KB })) > 256 * KB, "all four are running and the whole page is big");
  const html = renderPage(data, { now: NOW });
  assert.ok(bytesOf(html) <= 256 * KB, `the page is ${bytesOf(html)} bytes`);
  assert.ok(count(html, `${LEFT_OUT}: `) >= 1 && count(html, 'aria-label="Roadmap table"') < 4 && count(html, 'aria-label="Roadmap table"') >= 1, "some running projects lose their tables, not more than needed");
  assert.ok(/tables of \d projects? \(\d with a running session\) are left out to keep the page small \(/.test(html), "the note says that running projects were included");
  assert.equal(count(html, '<summary class="prow">'), 4, "every row stays");
  for (let i = 0; i < 4; i++) assert.ok(html.includes(`#r${i}`), `session r${i} stays`);
  assert.equal(count(html, 'data-declared="waiting"'), 2, "the waiting sessions stay on the page");
  // idle first: one small idle project and one big running one; the idle one goes, and then the running one
  const idleSmall = fakeProject(5, "idlesmallco", 60);
  const runBig = fakeProject(6, "runbigco", 700);
  const mixed = fakeData([idleSmall, runBig], [fakeSession(runBig, "w1", "waiting")]);
  const mx = renderPage(mixed, { now: NOW });
  assert.ok(bytesOf(mx) <= 256 * KB);
  assert.ok(blockOf(mx, "idlesmallco").includes(LEFT_OUT) && blockOf(mx, "runbigco").includes(LEFT_OUT), "the idle project goes first, and the running one still does not fit");
  assert.ok(blockOf(mx, "runbigco").includes("#w1") && blockOf(mx, "runbigco").includes('data-declared="waiting"'), "its waiting session stays");
  const idle = [1, 2, 3, 4].map((n) => fakeProject(n, `idle${n}co`, 200));
  const out = renderPage(fakeData(idle), { now: NOW });
  assert.ok(bytesOf(out) <= 256 * KB);
  assert.equal(count(out, '<summary class="prow">'), 4, "the executive row of every project is there");
  assert.ok(count(out, `${LEFT_OUT}: `) >= 2 && count(out, 'aria-label="Roadmap table"') >= 1, "some are left out, not all");
  const small = renderPage(fakeData([fakeProject(1, "tinyco", 5)]), { now: NOW });
  assert.equal(count(small, LEFT_OUT), 0);
  assert.ok(small.includes('aria-label="Roadmap table"'));
});

test("big page: an idle session does not keep the tables, an archived one is kept in the page", () => {
  const a = fakeProject(1, "idleco", 400);
  const b = fakeProject(2, "archco", 400);
  const sessions = [fakeSession(a, "i1", "working", 5 * 60), { ...fakeFixed(b), archived: true }];
  const html = renderPage(fakeData([a, b], sessions), { now: NOW });
  assert.ok(bytesOf(html) <= 256 * KB);
  assert.ok(blockOf(html, "idleco").includes('data-state="idle"'));
  assert.ok(html.includes("tables of 2 projects with no running session"), "an idle session and an archived one both leave the tables out");
  assert.ok(blockOf(html, "archco").includes("d1"), "the archived session still shows");
});
function fakeFixed(project) { return fakeSession(project, "d1", "done", 9 * 24 * 60); }

// A trail whose eight loops back are all different (a step back to build, and two back to the first steps), newest last.
const LOOPY = ["baseline", "build", "compare", "build", "review", "build", "preview", "build", "approve", "build", "ship", "build", "prod-check", "build", "compare", "baseline", "review", "baseline", "build"];
const loopyTrail = () => LOOPY.map((step, i) => [step, "working", (LOOPY.length - i) * 2]);
// n session files of one project, each a working session with eight loops (a tall drawing), as written by hand.
function heavySessions(w, id, n, o = {}) {
  for (let i = 0; i < n; i++) hand(w, id, `s${i}`, { step: "build", trail: loopyTrail(), ...o });
}

test("big page: a real data folder with big idle roadmaps still gets a page after a set (it used to print page too large); over the hard limit fails closed", async () => {
  const w = world("bigreal");
  const rows300 = (tag, n = 300) => roadmap(Array.from({ length: n }, (_, j) => rowE(`${tag}${j + 1}`, `Row ${j + 1} of ${tag} with a long enough title to take some room in the table`, j % 3 === 0 ? "shipped" : "planned", "2h \u2192 1.5h", j % 3 === 0 ? "1.1h" : "")));
  const idle = [["heavyco", 300], ["bigco", 300], ["smallco", 100]].map(([name, n]) => { const p = w.proj(name); put(p, RM, rows300(name[0], n)); return p; });
  const live = w.proj("liveco");
  put(live, RM, roadmap([rowE("l1", "A small thing", "planned")]));
  enable(w);
  for (const p of idle) assert.equal(st(["register", "--data", w.data, "--root", p]).code, 0);
  const r = await sr(setArgs(w, live, "l1", "build", "working"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines, ["status set: phase l1 build working"], "no page not rebuilt line");
  const html = readFileSync(pageFile(w), "utf8");
  assert.ok(bytesOf(html) <= 256 * KB && bytesOf(html) > 100 * KB, `the page is ${bytesOf(html)} bytes`);
  assert.equal(count(html, `${LEFT_OUT}: 400 rows`), 2, "300 roadmap rows and 100 shipped rows, for each of the two big ones");
  assert.ok(blockOf(html, "smallco").includes('aria-label="Roadmap table"'), "the small one keeps its table: no more is left out than needed");
  assert.ok(html.includes("#l1") && html.includes('aria-label="Roadmap table"'), "the running project keeps its table");
  assert.equal(count(html, '<summary class="prow">'), 4);
  // over 1 MB even with every table left out: the page is refused with the old message and nothing is written
  const w2 = world("over1mb");
  const heavy = w2.proj("heavyco");
  put(heavy, RM, rows300("h"));
  enable(w2);
  const hid = idFor(w2, heavy);
  // (The sessions cap keeps real data under 1 MB, so the fail-closed rule is checked with a smaller limit through the maxPageBytes seam;
  // the real 1 MB limit is checked in the source, in the docs and by the scenario that writes a page between 256 KB and 1 MB.)
  const SMALL = 128 * KB;
  heavySessions(w2, hid, 120);
  const cmd = await pg(["--data", w2.data], { maxPageBytes: SMALL });
  assert.equal(cmd.code, 1);
  assert.ok(/the page would be \d+ KB, over the 128 KB limit; nothing was written \(--no-fonts makes it smaller\)/.test(cmd.err), cmd.err);
  assert.ok(!existsSync(pageFile(w2)));
  const late = await sr(setArgs(w2, heavy, "s0", "compare", "working"), { buildPage: (dir, io) => buildPage(dir, { now: io.nowMs, rename: io.rename, maxPageBytes: SMALL }) });
  assert.equal(late.code, 0, late.err);
  assert.equal(late.lines.at(-1), "page not rebuilt (page too large)");
  assert.ok(!existsSync(pageFile(w2)));
  const collected = (await col(w2)).json();
  const whole = renderPage(collected, { now: NOW });
  assert.ok(whole.includes(LEFT_OUT) && bytesOf(whole) > SMALL, "the tables are already left out and the page is still over the limit");
});

test("big page: the hard limit is 1 MB and the soft one 256 KB, in the source and in the docs", () => {
  const src = readFileSync(join(SKILL, "scripts", "page.mjs"), "utf8");
  assert.ok(src.includes("const SOFT_PAGE_BYTES = 256 * 1024;") && src.includes("const MAX_PAGE_BYTES = 1024 * 1024;"));
  for (const f of [join(SKILL, "references", "status.md"), join(HERE, "..", "plugins", "phased-shipping", "README.md"), join(HERE, "..", "docs", "wiki", "Dashboard.md")]) {
    const t = readFileSync(f, "utf8");
    assert.ok(t.includes("256 KB") && t.includes("1 MB") && t.includes(LEFT_OUT), `${f.split(sep).slice(-2).join("/")} states the rule`);
  }
});

// ── the fonts: renamed, with the licence kept ───────────────────────────────
const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];
// A woff2 file read apart: the header and table directory (up to `end`), the directory entries and the decompressed stream.
function woff2Parts(buf) {
  assert.equal(buf.subarray(0, 4).toString("latin1"), "wOF2", "not a woff2 file");
  const numTables = buf.readUInt16BE(12);
  const compressed = buf.readUInt32BE(20);
  let p = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = buf[p++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error("a bad UIntBase128 in the table directory"); };
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    const index = flags & 0x3f;
    let tag;
    if (index === 63) { tag = buf.subarray(p, p + 4).toString("latin1"); p += 4; } else tag = WOFF2_TAGS[index];
    const version = flags >> 6;
    const orig = base128();
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    dir.push({ tag, transformed, length: transformed ? base128() : orig });
  }
  return { head: buf.subarray(0, p), dir, data: brotliDecompressSync(buf.subarray(p, p + compressed)) };
}
// The records of the name table of a woff2 file (woff2 stores it untransformed unless the directory flags say otherwise).
function woff2NameRecords(buf) {
  const { dir, data } = woff2Parts(buf);
  let at = 0;
  let table = null;
  for (const t of dir) {
    if (t.tag === "name") {
      assert.ok(!t.transformed, "the name table is stored transformed in this woff2 file, so this test cannot read it: extend woff2NameRecords before trusting the licence check");
      table = data.subarray(at, at + t.length);
    }
    at += t.length;
  }
  assert.ok(table, "the file has no name table");
  const n = table.readUInt16BE(2);
  const strings = table.readUInt16BE(4);
  const records = [];
  for (let i = 0; i < n; i++) {
    const r = 6 + i * 12;
    const [platform, , , id, length, offset] = [0, 2, 4, 6, 8, 10].map((o) => table.readUInt16BE(r + o));
    const raw = table.subarray(strings + offset, strings + offset + length);
    let text = "";
    if (platform === 3 || platform === 0) for (let k = 0; k + 1 < raw.length; k += 2) text += String.fromCharCode(raw.readUInt16BE(k));
    else text = raw.toString("latin1");
    records.push({ id, text });
  }
  return records;
}
// The name ids (other than copyright 0 and licence 13) whose text still says Plex, and the problems with the names.
function nameProblems(records, family, postscript) {
  const bad = [];
  for (const r of records) if (![0, 13].includes(r.id) && /plex/i.test(r.text)) bad.push(`name id ${r.id} says ${JSON.stringify(r.text.slice(0, 40))}`);
  const ids = (n) => records.filter((r) => r.id === n);
  if (!(ids(1).length >= 1 && ids(1).every((r) => r.text === family))) bad.push(`name id 1 is not ${family}`);
  if (!ids(4).every((r) => r.text.startsWith(family))) bad.push(`the full name does not start with ${family}`);
  if (!(ids(6).length >= 1 && ids(6).every((r) => r.text.startsWith(postscript)))) bad.push(`the PostScript name does not start with ${postscript}`);
  if (!ids(0).some((r) => /plex/i.test(r.text) && r.text.includes("IBM Corp."))) bad.push("the copyright record lost the notice");
  if (!ids(13).some((r) => r.text.includes("SIL Open Font License, Version 1.1"))) bad.push("the licence record is missing");
  return bad;
}

test("fonts: both woff2 files are renamed (no Plex outside the copyright and licence records) and the licence file is unchanged", () => {
  for (const [file, family, ps] of [["pw-sans.woff2", "PW Sans", "PWSans-"], ["pw-mono.woff2", "PW Mono", "PWMono-"]]) {
    const records = woff2NameRecords(readFileSync(join(ASSETS, file)));
    assert.ok(records.length >= 8, `${file} has name records`);
    assert.deepEqual(nameProblems(records, family, ps), [], file);
  }
  const sans = woff2NameRecords(readFileSync(join(ASSETS, "pw-sans.woff2")));
  for (const n of ["PWSans-Regular", "PWSans-Medium", "PWSans-SemiBold"]) assert.ok(sans.some((r) => r.id >= 256 && r.text === n), `an instance is named ${n}`);
  // the licence text, with line ends read the one way, hashes to the recorded value
  const ofl = readFileSync(join(ASSETS, "OFL.txt"), "utf8").replace(/\r\n?/g, "\n");
  assert.equal(createHash("sha256").update(ofl).digest("hex"), ["37784b44044a4ffd9256702b7c0982c3", "7e5c8887ba90c6dca0479aea93dc898d"].join(""), "OFL.txt is unchanged");
});

test("fonts: the check catches a name that still says Plex (a copy of the font with one instance name put back to the old text)", () => {
  const original = readFileSync(join(ASSETS, "pw-sans.woff2"));
  const { head, dir, data } = woff2Parts(original);
  const utf16 = (s) => Buffer.from(s, "utf16le").swap16();
  const from = utf16("PWSans-Medium");
  const to = utf16("IBMPlexSans-M");
  assert.equal(from.length, to.length);
  const at = data.indexOf(from);
  assert.ok(at > 0, "the instance name is in the stream");
  const changed = Buffer.from(data);
  to.copy(changed, at);
  const compressed = brotliCompressSync(changed);
  const head2 = Buffer.from(head);
  head2.writeUInt32BE(compressed.length, 20);
  const copy = Buffer.concat([head2, compressed]);
  assert.equal(dir.length, woff2Parts(copy).dir.length);
  assert.deepEqual(nameProblems(woff2NameRecords(copy), "PW Sans", "PWSans-").length, 1, "one name says Plex");
  assert.ok(nameProblems(woff2NameRecords(copy), "PW Sans", "PWSans-")[0].includes("IBMPlexSans-M"));
  assert.throws(() => woff2Parts(Buffer.from("not a font at all, not even close, really".repeat(5))), /not a woff2 file/);
});

// ── the script of the page: the same text is hashed and inlined, whatever its line ends ──
test("csp: a script with CRLF line ends is inlined with LF and the policy hash is the hash of that text", () => {
  const assets = loadAssets({ fonts: false });
  const crlf = { ...assets, js: assets.js.replace(/\n/g, "\r\n") + "\r// a lone CR\r" };
  assert.ok(crlf.js.includes("\r\n") && crlf.js !== assets.js);
  const html = renderPage(fakeData([]), { now: NOW, fonts: false, assets: crlf });
  const inline = scriptOf(html);
  assert.ok(!inline.includes("\r"), "no carriage return reaches the page");
  const normal = crlf.js.replace(/\r\n?/g, "\n");
  assert.equal(inline, normal);
  const hash = createHash("sha256").update(inline).digest("base64");
  assert.ok(html.includes(`script-src 'sha256-${hash}'`), "the policy names the hash of the inline text");
  const lf = renderPage(fakeData([]), { now: NOW, fonts: false, assets });
  assert.ok(lf.includes(`script-src 'sha256-${createHash("sha256").update(assets.js).digest("base64")}'`), "an LF script is unchanged");
});

// ── --out with a colon in its name ──────────────────────────────────────────
test("page command and collect: --out with a colon in the file name is refused on every platform, with nothing written", async () => {
  const w = world("colon");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working", NOW - MIN);
  const site = join(w.base, "site");
  mkdirSync(site);
  for (const name of ["x.html:evil", "x:y", ":stream"]) {
    const r = await pg(["--data", w.data, "--out", join(site, name)]);
    assert.equal(r.code, 2, name);
    assert.ok(r.err.includes("must not have a colon in its file name") && r.err.includes("nothing was written"), r.err);
    assert.deepEqual(listing(site), [], `${name}: nothing was written, not even the part before the colon`);
    const c = await col(w, ["--out", join(site, name)]);
    assert.equal(c.code, 2, `collect ${name}`);
    assert.ok(c.err.includes("must not have a colon in its file name"));
    assert.deepEqual(listing(site), []);
  }
  const ok = await pg(["--data", w.data, "--out", join(site, "x.html")]);
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(listing(site), ["x.html"]);
  const okc = await col(w, ["--out", join(site, "plain.json")]);
  assert.equal(okc.code, 0, okc.err);
});

// ── the newest history record of a phase ────────────────────────────────────
test("estimate table: a phase rolled back and shipped again shows the newest record, not the first attempt", () => {
  const rec = (rolledBack, firstPass, rounds) => ({ phase: "1", actual_h: 1, check_rounds: rounds, prod_first_pass: firstPass, rolled_back: rolledBack });
  const mk = (history) => renderPage(fakeData([fakeProject(1, "rollco", 1, { history })]), { now: NOW, fonts: false });
  const shippedAgain = mk([rec(true, false, 4), rec(false, true, 1)]);
  assert.ok(shippedAgain.includes("<td>first pass</td>") && !shippedAgain.includes("rolled back</td>"), "the later, good record shows");
  assert.ok(shippedAgain.includes('<td class="n">1</td><td>first pass</td>'));
  const rolledAfter = mk([rec(false, true, 1), rec(true, false, 4)]);
  assert.ok(rolledAfter.includes("<td>rolled back</td>") && !rolledAfter.includes("<td>first pass</td>"), "the newest record is the one shown");
  const case9 = mk([{ ...rec(false, true, 2), phase: "1" }, { ...rec(false, false, 3), phase: "1" }]);
  assert.ok(case9.includes("<td>fixed after</td>") && case9.includes('<td class="n">3</td>'));
});

// ── unregister rebuilds the page ────────────────────────────────────────────
test("unregister: while the dashboard is on the page is rebuilt without the project; off, nothing is built; disable leaves the page as it was", async () => {
  const w = world("unreg");
  const p = w.proj("zork");
  const q = w.proj("acmecorp");
  enable(w);
  await sr(setArgs(w, p, "z1", "build", "working"));
  await sr(setArgs(w, q, "a1", "build", "working"));
  const idQ = idFor(w, q);
  assert.ok(readFileSync(pageFile(w), "utf8").includes("acmecorp"));
  const r = await sr(["unregister", "--data", w.data, idQ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines.length, 1, "one line: the removal, and no page line when the page was built");
  assert.ok(r.lines[0].startsWith("removed: acmecorp"));
  const html = readFileSync(pageFile(w), "utf8");
  assert.ok(!html.includes("acmecorp") && html.includes("zork"), "the unregistered project's name is gone from the page");
  assert.deepEqual(listing(w.data).filter((n) => n.includes(".tmp-")), []);
  // a builder that fails: one line, exit code unchanged
  const idP = idFor(w, p);
  const bad = await sr(["unregister", "--data", w.data, idP], { buildPage: async () => ({ ok: false, reason: "EPERM" }) });
  assert.equal(bad.code, 0);
  assert.equal(bad.lines.at(-1), "page not rebuilt (EPERM)");
  // a refused unregister (no such id) builds nothing and keeps its exit code
  let calls = 0;
  const seen = async () => { calls++; return { ok: true }; };
  const none = await sr(["unregister", "--data", w.data, "0".repeat(12)], { buildPage: seen });
  assert.equal(none.code, 1);
  const badId = await sr(["unregister", "--data", w.data, "zz"], { buildPage: seen });
  assert.equal(badId.code, 2);
  assert.equal(calls, 0);
  // off: nothing is built, and disable itself leaves the page as it was last written
  const w2 = world("unreg-off");
  const p2 = w2.proj("zork");
  const q2 = w2.proj("acmecorp");
  enable(w2);
  await sr(setArgs(w2, p2, "z1", "build", "working"));
  await sr(setArgs(w2, q2, "a1", "build", "working"));
  const idQ2 = idFor(w2, q2);
  assert.equal((await sr(["disable", "--data", w2.data], { buildPage: seen })).code, 0);
  const before = readFileSync(pageFile(w2), "utf8");
  assert.ok(before.includes("acmecorp"), "disable left the page as it was");
  const off = await sr(["unregister", "--data", w2.data, idQ2], { buildPage: seen });
  assert.equal(off.code, 0, off.err);
  assert.equal(off.lines.length, 1);
  assert.equal(calls, 0, "off: no page is built");
  assert.equal(readFileSync(pageFile(w2), "utf8"), before, "off: the page is untouched");
});

test("unregister: the command line (a real process) rebuilds the page", () => {
  const w = world("unreg-proc");
  const p = w.proj("zork");
  enable(w);
  const script = join(SKILL, "scripts", "status.mjs");
  const go = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.equal(go(setArgs(w, p, "zork1", "build", "working")).status, 0);
  assert.ok(readFileSync(pageFile(w), "utf8").includes("zork"));
  const un = go(["unregister", "--data", w.data, idFor(w, p)]);
  assert.equal(un.status, 0, un.stderr);
  assert.ok(!readFileSync(pageFile(w), "utf8").includes("#zork1"), "the session of the unregistered project is not drawn any more");
  assert.ok(readFileSync(join(SKILL, "scripts", "status.mjs"), "utf8").includes("if (config.enabled) io.after.changed = true;"));
});

// ── JavaScript off ──────────────────────────────────────────────────────────
test("no script: the pause button and the refresh text are hidden until the script adds the js class; the banner stays", () => {
  const html = renderPage(fakeData([]), { now: NOW, fonts: false });
  const css = cssOf(html);
  assert.ok(css.includes("body:not(.js) .cd,body:not(.js) #pw-pause,body:not(.js) .foot-refresh{display:none}"), "one rule hides the header text, the button and the footer's refresh text");
  assert.ok(html.includes('<div class="foot-refresh"><dt>Refresh</dt><dd>10 s, pausable</dd></div>'), "the footer's refresh text is inside the hidden element");
  assert.equal(count(html, "pausable"), 1, "the refresh text is in the footer once, and nowhere outside it");
  assert.ok(/<body [^>]*>/.exec(html)[0].indexOf("class=") === -1, "the body has no js class as written");
  assert.ok(html.includes('<span class="cd" id="pw-countdown">Refresh every 10 s</span><button type="button" id="pw-pause" class="btn"'), "the two elements the rule hides");
  assert.ok(html.includes("<noscript><p class=\"banner\">Scripts are off: times and states are as written and the page will not refresh."));
  assert.ok(scriptOf(html).includes('body.classList.add("js")'));
});

// ── the script of the page, run for real in a sandbox with a small stub of the page ──
const CLIENT_SRC = readFileSync(join(ASSETS, "client.js"), "utf8");
const T0 = 1700000000000;
function stubEl(attrs = {}, extra = {}) {
  const e = {
    attrs: { ...attrs }, textContent: "", hidden: false, className: "", open: false, children: {}, lists: {}, classes: new Set(),
    getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    hasAttribute(n) { return Object.hasOwn(this.attrs, n); },
    querySelector(sel) { return Object.hasOwn(this.children, sel) ? this.children[sel] : null; },
    querySelectorAll(sel) { return this.lists[sel] ?? []; },
    closest() { return null; },
    matches() { return false; },
    focus() {},
    addEventListener(type, fn) { (this.handlers ??= {})[type] = fn; },
    classList: { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), contains: (c) => e.classes.has(c), toggle: (c, on) => { if (on) e.classes.add(c); else e.classes.delete(c); } },
    ...extra,
  };
  return e;
}
// A session row as the script reads it: declared state, how long ago it was updated, the stored worked and elapsed times.
function stubRow(clock, { declared = "working", age = 0, w = 0, e = 0 }) {
  const parts = { label: stubEl(), mk: stubEl(), warn: stubEl(), warnText: stubEl(), idleNote: stubEl(), elapsed: stubEl(), w1: stubEl(), w2: stubEl() };
  parts.warn.children["[data-warn-text]"] = parts.warnText;
  const row = stubEl({ "data-declared": declared, "data-t": String(clock.now - age), "data-w": String(w), "data-e": String(e), "data-state": declared });
  Object.assign(row.children, { "[data-label]": parts.label, "[data-mk]": parts.mk, "[data-warn]": parts.warn, "[data-idle-note]": parts.idleNote, "[data-elapsed]": parts.elapsed });
  row.lists["[data-worked]"] = [parts.w1, parts.w2];
  return { row, ...parts };
}
function stubProj(rows) {
  const names = ["working", "waiting", "idle", "active"].map((k) => [`[data-n="${k}"]`, stubEl()]);
  const proj = stubEl();
  for (const [k, el] of names) proj.children[k] = el;
  proj.children["[data-proj-worked]"] = stubEl();
  proj.children["[data-wait-stamp]"] = stubEl();
  proj.lists["[data-session]"] = rows.map((r) => r.row);
  proj.n = Object.fromEntries(names.map(([k, el]) => [k.slice(9, -2), el]));
  return proj;
}
// Runs a script text against the stub. o: storage (initial values), throwOnGet (keys whose read throws), focusThrows (the
// lookup of the focused row throws, as a browser does for a selector it cannot parse), projects, ts (the .t elements),
// body (the data attributes of the body).
function runClient(src, o = {}) {
  const clock = { now: T0 };
  const store = { ...(o.storage ?? {}) };
  const sets = [];
  const log = { intervals: [], reloads: 0, added: [], sets, scrolls: [] };
  const btn = stubEl({}, { textContent: "Pause refresh" });
  const cd = stubEl();
  const sum = stubEl({ "data-live": "" });
  sum.children["[data-text]"] = stubEl();
  const stale = stubEl();
  const body = stubEl();
  body.dataset = { refreshS: "10", warnMin: "90", idleMin: "180", pageStaleMin: "90", ...(o.body ?? {}) };
  body.classList.add = (c) => { body.classes.add(c); log.added.push(c); };
  const ids = { "pw-pause": btn, "pw-countdown": cd, "pw-summary": sum, "pw-stale": stale };
  const lists = { "details[data-k]": o.details ?? [], ".t": o.ts ?? [], ".proj": o.projects ?? [], "details": o.details ?? [] };
  const document = {
    body, activeElement: null,
    getElementById: (id) => ids[id] ?? null,
    querySelectorAll: (sel) => lists[sel] ?? [],
    querySelector(sel) {
      if (sel === ".t:hover") return null;
      if (sel === "[data-written]") return o.written ?? null;
      if (sel.startsWith('details[data-k="')) {
        if (o.focusThrows || !/^details\[data-k="[a-z]-[0-9a-f]{10}"\] > summary$/.test(sel)) throw new SyntaxError("not a valid selector");
        return o.focusTarget ?? null;
      }
      throw new Error(`the stub has no answer for ${sel}`);
    },
    addEventListener() {},
  };
  const sessionStorage = {
    getItem(k) { if (o.throwOnGet?.includes(k)) throw new Error("denied"); return Object.hasOwn(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); sets.push([k, String(v)]); },
  };
  const window = {
    sessionStorage, scrollY: 0, innerWidth: 1000,
    scrollTo: (x, y) => { if (o.scrollThrows) throw new Error("no"); log.scrolls.push(y); },
    setInterval: (fn, ms) => { log.intervals.push({ fn, ms }); return log.intervals.length; },
    setTimeout: () => 0, addEventListener() {}, requestAnimationFrame() {},
  };
  class StubDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  const location = { reload() { log.reloads++; } };
  const ctx = vm.createContext({ document, window, location, Date: StubDate });
  let threw = null;
  try { vm.runInContext(src, ctx, { timeout: 2000 }); } catch (e) { threw = e; }
  return Object.assign(log, { threw, store, clock, btn, cd, sum, body, stale, tick: () => log.intervals[0].fn() });
}
const MIDDOT_CHAR = String.fromCharCode(183);

test("client script, run in a sandbox: clean storage starts the script, adds js, sets one 1 s timer and reloads only after the refresh time", () => {
  const r = runClient(CLIENT_SRC);
  assert.equal(r.threw, null);
  assert.deepEqual(r.added, ["js"]);
  assert.equal(r.intervals.length, 1);
  assert.equal(r.intervals[0].ms, 1000);
  assert.equal(r.cd.textContent, "Next refresh in 10 s");
  assert.equal(r.btn.textContent, "Pause refresh");
  r.clock.now += 9000;
  r.tick();
  assert.equal(r.reloads, 0);
  assert.equal(r.cd.textContent, "Next refresh in 1 s");
  r.clock.now += 1000;
  r.tick();
  assert.equal(r.reloads, 1, "reloaded at the refresh time");
  assert.deepEqual(r.sets.filter(([k]) => k === "pw:focus"), [["pw:focus", ""]]);
  const custom = runClient(CLIENT_SRC, { body: { refreshS: "30" } });
  custom.clock.now += 29000;
  custom.tick();
  assert.equal(custom.reloads, 0);
  custom.clock.now += 1000;
  custom.tick();
  assert.equal(custom.reloads, 1);
});

test("client script, run in a sandbox: stored values that are poisoned or refused are ignored and the script still starts", () => {
  const poisoned = { "pw:focus": 'x"]', "pw:y": "not a number", "pw:paused": "maybe", "pw:o:p-0123456789": "2" };
  const a = runClient(CLIENT_SRC, { storage: poisoned });
  assert.equal(a.threw, null);
  assert.deepEqual(a.added, ["js"]);
  assert.equal(a.intervals.length, 1);
  assert.equal(a.cd.textContent, "Next refresh in 10 s", "a stored maybe is not paused");
  assert.deepEqual(a.scrolls, [], "a stored text is not a scroll position");
  // a well-formed key whose lookup the browser refuses
  const b = runClient(CLIENT_SRC, { storage: { "pw:focus": "p-0123456789" }, focusThrows: true });
  assert.equal(b.threw, null);
  assert.deepEqual(b.added, ["js"]);
  assert.equal(b.intervals.length, 1);
  // reading a stored value throws (storage blocked or full of trouble), and so does scrolling
  const c = runClient(CLIENT_SRC, { throwOnGet: ["pw:y", "pw:focus", "pw:paused"], storage: { "pw:y": "50" } });
  assert.equal(c.threw, null);
  assert.deepEqual(c.added, ["js"]);
  assert.equal(c.intervals.length, 1);
  const d = runClient(CLIENT_SRC, { storage: { "pw:y": "50" }, scrollThrows: true });
  assert.equal(d.threw, null);
  assert.deepEqual(d.added, ["js"]);
  assert.equal(d.intervals.length, 1);
  // one open-state restore that throws does not stop the next one
  const bad = stubEl({ "data-k": "p-aaaaaaaaaa" });
  Object.defineProperty(bad, "open", { get: () => false, set: () => { throw new Error("no"); } });
  const good = stubEl({ "data-k": "p-bbbbbbbbbb" });
  const poison = stubEl({ "data-k": 'x"]' });
  const e = runClient(CLIENT_SRC, { details: [bad, poison, good], storage: { "pw:o:p-aaaaaaaaaa": "1", "pw:o:p-bbbbbbbbbb": "1" } });
  assert.equal(e.threw, null);
  assert.equal(good.open, true, "the next open state is restored");
  assert.equal(poison.open, false, "a key that is not a generated one is left alone");
  assert.deepEqual(e.added, ["js"]);
  // a good stored value is used
  const target = stubEl();
  let focused = 0;
  target.focus = () => { focused++; };
  const ok = runClient(CLIENT_SRC, { storage: { "pw:focus": "p-0123456789", "pw:y": "120", "pw:paused": "1" }, focusTarget: target });
  assert.equal(focused, 1);
  assert.deepEqual(ok.scrolls, [120]);
  assert.equal(ok.btn.textContent, "Resume refresh");
});

test("client script, run in a sandbox: the paused state stops the reload, the button toggles it and stores a 1 or a 0", () => {
  const p = runClient(CLIENT_SRC, { storage: { "pw:paused": "1" } });
  assert.equal(p.threw, null);
  assert.equal(p.cd.textContent, "Refresh paused");
  assert.equal(p.btn.attrs["aria-pressed"], "true");
  p.clock.now += 120000;
  p.tick();
  assert.equal(p.reloads, 0, "no reload while paused");
  assert.equal(p.cd.textContent, "Refresh paused");
  p.btn.handlers.click();
  assert.deepEqual(p.sets.at(-1), ["pw:paused", "0"]);
  assert.equal(p.btn.textContent, "Pause refresh");
  p.clock.now += 11000;
  p.tick();
  assert.equal(p.reloads, 1, "after resuming it reloads");
  const q = runClient(CLIENT_SRC);
  q.btn.handlers.click();
  assert.deepEqual(q.sets.at(-1), ["pw:paused", "1"]);
  q.clock.now += 120000;
  q.tick();
  assert.equal(q.reloads, 0);
});

test("client script, run in a sandbox: Idle starts at exactly the idle time, the warning at the warn time, and worked so far is the stored time plus the age of a working session", () => {
  const clock = { now: T0 };
  const IDLE = 180 * MIN;
  const atEdge = stubRow(clock, { declared: "working", age: IDLE });
  const justUnder = stubRow(clock, { declared: "working", age: IDLE - 1 });
  const waiting = stubRow(clock, { declared: "waiting", age: 5 * MIN, w: 1 * MIN, e: 2 * MIN });
  const done = stubRow(clock, { declared: "done", age: 5 * IDLE });
  const p1 = stubProj([atEdge, justUnder, done]);
  const working = stubRow(clock, { declared: "working", age: 5 * MIN, w: 10 * MIN, e: 20 * MIN });
  const p2 = stubProj([working, waiting]);
  const r = runClient(CLIENT_SRC, { projects: [p1, p2] });
  assert.equal(r.threw, null);
  assert.equal(atEdge.row.attrs["data-state"], "idle", "age equal to the idle time is idle (>=, not >)");
  assert.equal(atEdge.label.textContent, "Idle");
  assert.equal(atEdge.idleNote.hidden, false);
  assert.equal(atEdge.warn.hidden, true, "an idle session shows no warning");
  assert.equal(justUnder.row.attrs["data-state"], "working", "one millisecond under is still working");
  assert.equal(justUnder.label.textContent, "Working");
  assert.equal(justUnder.warn.hidden, false, "past the warn time and not idle");
  assert.equal(justUnder.warnText.textContent, "No update for 2 h 59 min");
  assert.equal(done.row.attrs["data-state"], "done");
  assert.equal(done.label.textContent, "Done");
  assert.equal(p1.n.working.textContent, "1");
  assert.equal(p1.n.idle.textContent, "1");
  assert.equal(p1.n.active.textContent, "1");
  // worked so far: 10 min stored + 5 min since the last update; elapsed 20 + 5; a waiting session adds no age to worked
  assert.equal(working.w1.textContent, "15 min");
  assert.equal(working.w2.textContent, "15 min");
  assert.equal(working.elapsed.textContent, "25 min");
  assert.equal(waiting.w1.textContent, "1 min");
  assert.equal(waiting.elapsed.textContent, "7 min");
  assert.equal(p2.children["[data-proj-worked]"].textContent, "16 min", "the project adds the worked time of its live sessions");
  assert.equal(p2.n.waiting.textContent, "1");
  assert.equal(p2.children["[data-wait-stamp]"].hidden, false);
  assert.ok(p2.attrs["data-attn"] !== undefined && p1.attrs["data-attn"] === undefined);
  assert.equal(r.sum.children["[data-text]"].textContent, `1 waiting for you ${MIDDOT_CHAR} 2 working ${MIDDOT_CHAR} 1 idle`);
  // time moves on: the working row at the edge of idle, one tick later
  r.clock.now += 1;
  clock.now = r.clock.now;
  r.tick();
  assert.equal(justUnder.row.attrs["data-state"], "idle", "it crosses the idle time on the next tick");
});

test("client script, run in a sandbox: a cut-off title inside a summary is not focusable, one outside a summary is", () => {
  const inside = stubEl();
  const outside = stubEl();
  const whole = stubEl();
  const cut = () => stubEl({}, { scrollWidth: 300, clientWidth: 100 });
  inside.children[".t-s"] = cut();
  outside.children[".t-s"] = cut();
  whole.children[".t-s"] = stubEl({}, { scrollWidth: 100, clientWidth: 100 });
  inside.closest = (sel) => (sel === "summary" ? {} : null);
  const r = runClient(CLIENT_SRC, { ts: [inside, outside, whole] });
  assert.equal(r.threw, null);
  assert.ok(!inside.hasAttribute("tabindex"), "no tabindex inside a summary");
  assert.ok(inside.classes.has("is-cut"), "it is still marked as cut, so it shows its full text on hover");
  assert.equal(outside.attrs.tabindex, "0");
  assert.ok(!whole.hasAttribute("tabindex"), "a title that is not cut is not focusable");
  const html = renderPage(fakeData([fakeProject(1, "a-project-name-that-is-long-enough-to-be-cut", 1)]), { now: NOW, fonts: false });
  assert.ok(!html.includes('tabindex="0"><span class="t-s"') && !/class="t"[^>]*tabindex/.test(html), "the page itself never gives a title a tabindex");
  assert.ok(/<summary class="prow">[\s\S]*?<span class="t-s" aria-hidden="true">a-project-name/.test(html) && html.includes('<span class="t-f">a-project-name'), "the full text is in the page for a screen reader");
});

test("client script, run in a sandbox: the test is sensitive (each change below makes one of the checks above fail)", () => {
  const mutate = (from, to) => { assert.ok(CLIENT_SRC.includes(from), `the script has ${from.slice(0, 40)}`); return CLIENT_SRC.replace(from, () => to); };
  // without the guard around the focus step, a lookup the browser refuses stops the script before the js class
  const noFocusGuard = mutate("} catch (e) { /* a bad stored focus is ignored */ }", "} finally { }");
  const a = runClient(noFocusGuard, { storage: { "pw:focus": "p-0123456789" }, focusThrows: true });
  assert.ok(a.threw !== null && a.added.length === 0 && a.intervals.length === 0, "the script stops");
  // the same for the scroll step
  const noScrollGuard = mutate("} catch (e) { /* a bad scroll position is ignored */ }", "} finally { }");
  const b = runClient(noScrollGuard, { throwOnGet: ["pw:y"] });
  assert.ok(b.threw !== null && b.added.length === 0);
  // and for one open state
  const noOpenGuard = mutate("} catch (e) { /* a bad stored open state is ignored */ }", "} finally { }");
  const bad = stubEl({ "data-k": "p-aaaaaaaaaa" });
  Object.defineProperty(bad, "open", { get: () => false, set: () => { throw new Error("no"); } });
  const c = runClient(noOpenGuard, { details: [bad], storage: { "pw:o:p-aaaaaaaaaa": "1" } });
  assert.ok(c.threw !== null && c.added.length === 0);
  // age > IDLE instead of age >= IDLE
  const clock = { now: T0 };
  const edge = stubRow(clock, { declared: "working", age: 180 * MIN });
  runClient(mutate("(skew || age >= IDLE)", "(skew || age > IDLE)"), { projects: [stubProj([edge])] });
  assert.equal(edge.row.attrs["data-state"], "working", "a > instead of >= leaves the row at the edge working (the check above expects idle)");
  // a title in a summary made focusable again
  const inside = stubEl();
  inside.children[".t-s"] = stubEl({}, { scrollWidth: 300, clientWidth: 100 });
  inside.closest = (sel) => (sel === "summary" ? {} : null);
  runClient(mutate("if (cut && !inSummary)", "if (cut)"), { ts: [inside] });
  assert.equal(inside.attrs.tabindex, "0", "the old rule makes it focusable (the check above expects none)");
  // the worked arithmetic with no age added
  const w = stubRow(clock, { declared: "working", age: 5 * MIN, w: 10 * MIN });
  runClient(mutate('(state === "working" && age > 0 ? age : 0)', "0"), { projects: [stubProj([w])] });
  assert.equal(w.w1.textContent, "10 min");
  // the pause that does not stop the reload
  const p = runClient(mutate("if (paused) { setText(cd, \"Refresh paused\"); return; }", ""), { storage: { "pw:paused": "1" } });
  p.clock.now += 120000;
  p.tick();
  assert.equal(p.reloads, 1, "without the paused check it reloads");
});

// ── fix round 2 ─────────────────────────────────────────────────────────────
// A text of the repository's files, read from the repository root.
const repoText = (...parts) => readFileSync(join(HERE, "..", ...parts), "utf8");
const BS = "\\";

// The whole of a scenario runs against the real scripts and, in the last test, against a temp copy of the scripts with one
// change at a time: every change must make its scenario fail. A scenario takes the two modules { page, collect }.
const REAL = { page: pageModule, collect: collectModule, status: statusModule };
const ROADMAP_SCRIPTS = join(HERE, "..", "plugins", "phased-shipping", "skills", "roadmap", "scripts");
async function mutantOf(changes) {
  const root = tmp("mutant");
  cpSync(join(SKILL, "scripts"), join(root, "dashboard", "scripts"), { recursive: true });
  cpSync(ASSETS, join(root, "dashboard", "assets"), { recursive: true });
  cpSync(ROADMAP_SCRIPTS, join(root, "roadmap", "scripts"), { recursive: true });
  for (const [file, from, to] of changes) {
    const path = join(root, "dashboard", "scripts", file);
    const src = readFileSync(path, "utf8");
    assert.ok(src.includes(from), `${file} has the text to change: ${from.slice(0, 50)}`);
    writeFileSync(path, src.split(from).join(to));
  }
  const load = (file) => import(pathToFileURL(join(root, "dashboard", "scripts", file)).href);
  return { page: await load("page.mjs"), collect: await load("collect.mjs"), status: await load("status.mjs") };
}

// A roadmap of n shipped rows with long titles and long notes (the note column is not read; it makes the file big).
// Every title is full of ampersands, which the page writes as five characters each: the widest page one row can make.
const bigRoadmap = (tag, n) => roadmap(Array.from({ length: n }, (_, j) => `| ${tag}${j + 1} | ${`Shipped item ${j + 1} of ${tag}, `.padEnd(198, "&")} | shipped | backend | P1 | Soon | 2h ${cp(0x2192)} 1.5h | 1.1h | abc1234 | | | ${"a long note ".repeat(21)} |`));

// ── 1. --out as a network or device path, or as another route to the data folder ──
const uncSpellings = (rest) => [
  `${BS}${BS}host${BS}share${BS}${rest.split("/").join(BS)}`,
  `//host/share/${rest}`,
  `${BS}${BS}localhost${BS}share$${BS}${rest.split("/").join(BS)}`,
  `//localhost/share$/${rest}`,
  `${BS}${BS}?${BS}UNC${BS}host${BS}share${BS}${rest.split("/").join(BS)}`,
  `${BS}${BS}.${BS}host${BS}${rest.split("/").join(BS)}`,
  `/${BS}host/share/${rest}`,
];

async function scenarioOut(mods) {
  const w = world("out2");
  const p = w.proj();
  enable(w);
  assert.equal(st(["register", "--data", w.data, "--root", p]).code, 0);
  mkdirSync(w.data, { recursive: true });
  const id = idFor(w, p);
  hand(w, id, "1", { step: "build" });
  const real = realpathSync.native(w.data);
  const rests = ["projects.json", "dashboard.json", `sessions/${id}-1.json`, "dashboard.html"];
  for (const rest of rests) {
    for (const spelling of uncSpellings(rest)) {
      const why = mods.collect.outProblem(spelling, w.data, real);
      assert.ok(typeof why === "string" && why.includes("network or device path"), `${JSON.stringify(spelling)} is refused as a network or device path, got ${why}`);
    }
  }
  // an identity the real path does not show: the target sits under a folder with the data folder's device and file number
  const site = join(w.base, "site");
  mkdirSync(site, { recursive: true });
  const same = { dev: 7n, ino: 42n };
  const stat = (path) => {
    if (path === w.data || path === join(site, "alias")) return { ...same };
    if (path.length < 3) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return { dev: 7n, ino: 1000n + BigInt(path.length) };
  };
  const blind = { realpath: (path) => path, stat };
  assert.equal(mods.collect.outProblem(join(site, "alias", "x.html"), w.data, real, blind), "must not be in the data folder", "a folder above the target is the data folder by identity");
  assert.equal(mods.collect.outProblem(join(site, "alias"), w.data, real, blind), "must not be in the data folder", "the target itself is the data folder by identity");
  assert.equal(mods.collect.outProblem(join(site, "other", "x.html"), w.data, real, blind), null, "another folder passes");
  // an unusable file number (0 or missing): the identity check is off and the real-path check decides
  assert.equal(mods.collect.outProblem(join(site, "alias", "x.html"), w.data, real, { realpath: (path) => path, stat: () => ({ dev: 7n, ino: 0n }) }), null);
  assert.equal(mods.collect.outProblem(join(site, "alias", "x.html"), w.data, real, { realpath: (path) => path, stat: () => ({ dev: 7n }) }), null);
}

test("--out: a network or device path (a UNC spelling, //host/share, the \\\\?\\ and \\\\.\\ forms) is refused on every platform, and a folder with the data folder's identity is refused whatever its real path says", async () => {
  await scenarioOut(REAL);
});

test("page command and collect: --out as a network or device path writes nothing; the data files stay byte for byte; a normal --out elsewhere still works", async (t) => {
  const w = world("unc");
  const p = w.proj();
  enable(w);
  const r = await sr(setArgs(w, p, "1", "build", "working"));
  assert.equal(r.code, 0, r.err);
  const id = idFor(w, p);
  const rests = ["projects.json", "dashboard.json", `sessions/${sname(id, "1")}`, "dashboard.html"];
  const bytes = () => rests.map((rest) => readFileSync(join(w.data, ...rest.split("/"))));
  const before = bytes();
  const names = listing(w.data);
  const refused = async (target, why) => {
    const a = await pg(["--data", w.data, "--out", target]);
    assert.equal(a.code, 2, `page ${JSON.stringify(target)}: ${a.err}`);
    assert.ok(a.err.includes(why) && a.err.includes("nothing was written"), a.err);
    const c = await col(w, ["--out", target]);
    assert.equal(c.code, 2, `collect ${JSON.stringify(target)}: ${c.err}`);
    assert.ok(c.err.includes(why), c.err);
    bytes().forEach((b, i) => assert.ok(b.equals(before[i]), `${rests[i]} is byte for byte the same`));
    assert.deepEqual(listing(w.data), names, "no file was added to the data folder");
  };
  for (const rest of rests) for (const spelling of uncSpellings(rest)) await refused(spelling, "network or device path");
  // the real network spelling of the data folder, where the machine has one (the administrative share of the drive)
  const drive = /^([A-Za-z]):[\\/]+(.*)$/.exec(w.data);
  const back = drive ? `${BS}${BS}localhost${BS}${drive[1]}$${BS}${drive[2].split("/").join(BS)}` : null;
  if (!back || !existsSync(join(back, "projects.json"))) t.diagnostic("no administrative network path to the temp folder on this machine (a platform without drive letters, or the share is off): only the spelling cases above ran, not a real network path");
  else {
    const forward = `//localhost/${drive[1]}$/${drive[2].split(BS).join("/")}`;
    for (const rest of rests) {
      await refused(`${back}${BS}${rest.split("/").join(BS)}`, "network or device path");
      await refused(`${forward}/${rest}`, "network or device path");
    }
  }
  // a normal --out outside the data folder, for both commands
  const site = join(w.base, "site");
  mkdirSync(site);
  const ok = await pg(["--data", w.data, "--out", join(site, "page.html")]);
  assert.equal(ok.code, 0, ok.err);
  const okc = await col(w, ["--out", join(site, "dash.json")]);
  assert.equal(okc.code, 0, okc.err);
  assert.deepEqual(listing(site), ["dash.json", "page.html"]);
});

test("--out: a link or junction to the data folder is refused through the real path and through the identity walk; another folder is allowed", async (t) => {
  const w = world("alias");
  const p = w.proj();
  enable(w);
  assert.equal(st(["register", "--data", w.data, "--root", p]).code, 0);
  const real = realpathSync.native(w.data);
  const site = join(w.base, "site");
  mkdirSync(site);
  const link = join(site, "alias");
  try { symlinkSync(w.data, link, "junction"); } catch { t.diagnostic("this machine did not allow a link or junction: the alias case did not run"); return; }
  const before = listing(w.data);
  const projects = readFileSync(join(w.data, "projects.json"));
  assert.equal(collectModule.outProblem(join(link, "x.html"), w.data, real), "must not be in the data folder", "through the real path");
  assert.equal(collectModule.outProblem(join(link, "x.html"), w.data, real, { realpath: (path) => path }), "must not be in the data folder", "through the identity walk alone, with a real-path check that sees nothing");
  assert.equal(collectModule.outProblem(join(link, "projects.json"), w.data, real, { realpath: (path) => path }), "must not be in the data folder");
  for (const name of ["x.html", "projects.json"]) {
    const a = await pg(["--data", w.data, "--out", join(link, name)]);
    assert.equal(a.code, 2, a.err);
    assert.ok(a.err.includes("must not be in the data folder"), a.err);
  }
  assert.deepEqual(listing(w.data), before);
  assert.ok(readFileSync(join(w.data, "projects.json")).equals(projects), "the registry is byte for byte the same");
  assert.equal(collectModule.outProblem(join(site, "fine.html"), w.data, real), null);
  const ok = await pg(["--data", w.data, "--out", join(site, "fine.html")]);
  assert.equal(ok.code, 0, ok.err);
});

// ── 5c. a name with a dollar sign and a colon ───────────────────────────────
async function scenarioColon(mods) {
  const w = world("colon2");
  const p = w.proj();
  enable(w);
  assert.equal(st(["register", "--data", w.data, "--root", p]).code, 0);
  const site = join(w.base, "site");
  mkdirSync(site);
  for (const name of ["a$b.html:evil", "$x:y", "money$:stream"]) {
    assert.equal(mods.collect.outProblem(join(site, name), w.data, realpathSync.native(w.data)), "must not have a colon in its file name", name);
    const got = await mods.collect.collectData({ data: w.data, now: NOW, out: join(site, name) });
    assert.ok(!got.ok && got.usage === true && got.message.includes("colon"), name);
    const run = await mods.page.main(["--data", w.data, "--out", join(site, name)], { out: () => {}, err: () => {}, now: () => NOW });
    assert.equal(run, 2, name);
    assert.deepEqual(listing(site), [], `${name}: nothing was written`);
  }
  assert.equal(mods.collect.outProblem(join(site, "a$b.html"), w.data, realpathSync.native(w.data)), null, "the dollar sign alone is fine");
}

test("--out: a file name with a dollar sign and a colon is refused on every platform (the colon rule has no exception)", async () => {
  await scenarioColon(REAL);
});

// ── 4. a removed project leaves no trace ────────────────────────────────────
async function scenarioUnregister(mods) {
  const w = world("unreg2");
  const gone = w.proj("gonecorp");
  const stay = w.proj("staycorp");
  enable(w);
  setStatus(w, gone, "1", "build", "working", NOW - MIN);
  setStatus(w, stay, "1", "build", "working", NOW - MIN);
  const id = idFor(w, gone);
  writeFileSync(join(w.data, "sessions", `${id}-a2.json`), "{ not json");
  writeFileSync(join(w.data, "sessions", `${id}-a3.json`), JSON.stringify({ v: 1, project: id, phase: "a3", phase_name: "", step: "build", state: "working", step_started: 5, updated: 7, trail: "bad" }));
  const was = await mods.collect.collectData({ data: w.data, now: NOW });
  assert.ok(was.ok && was.data.errors.some((e) => e.file === `${id}-a2.json`) && was.data.errors.some((e) => e.file === `${id}-a3.json`), "while the project is listed, its bad files are reported");
  assert.equal(st(["unregister", "--data", w.data, id]).code, 0);
  const now = await mods.collect.collectData({ data: w.data, now: NOW });
  assert.ok(now.ok);
  const text = JSON.stringify(now.data);
  assert.ok(!text.includes(`${id}-a2`) && !text.includes(`${id}-a3`) && !text.includes("gonecorp"), "no name, no session and no bad file of the removed project");
  assert.deepEqual(now.data.errors, []);
  assert.equal(now.data.sessions.length, 1);
  const html = mods.page.renderPage(now.data, { now: NOW, fonts: false });
  assert.ok(!html.includes("a2.json") && !html.includes("a3.json") && !html.includes("gonecorp") && html.includes("staycorp"));
}

test("unregister: a malformed session file of the removed project is neither read nor reported, and the page has no trace of it", async () => {
  await scenarioUnregister(REAL);
});

// ── 2. a running project with a large roadmap ───────────────────────────────
async function scenarioRunning(mods) {
  const w = world("runbig");
  const big = w.proj("bigco");
  const other = w.proj("otherco");
  const file = put(big, RM, bigRoadmap("b", 300));
  put(other, RM, roadmap([rowE("o1", "Approve the thing", "planned")]));
  assert.ok(statSync(file).size >= 147000, `the roadmap file is ${statSync(file).size} bytes`);
  enable(w);
  assert.equal(setStatus(w, big, "b1", "build", "working", NOW - MIN).code, 0);
  assert.equal(setStatus(w, other, "o1", "approve", "waiting", NOW - 2 * MIN).code, 0);
  const got = await mods.collect.collectData({ data: w.data, now: NOW });
  assert.ok(got.ok);
  const whole = mods.page.renderPage(got.data, { now: NOW, softBytes: 1000 * KB * KB });
  assert.ok(bytesOf(whole) > 1024 * KB, `the whole page is ${bytesOf(whole)} bytes: over the hard limit, as in the report`);
  const built = await mods.page.buildPage(w.data, { now: NOW });
  assert.deepEqual(built, { ok: true });
  const html = readFileSync(pageFile(w), "utf8");
  assert.ok(bytesOf(html) <= 256 * KB, `the page is ${bytesOf(html)} bytes`);
  assert.ok(count(html, LEFT_OUT) >= 1 && html.includes("(1 with a running session)"), "the note says it left out the tables of a running project");
  assert.equal(count(html, '<summary class="prow">'), 2, "both project rows stay");
  assert.ok(blockOf(html, "otherco").includes("#o1") && blockOf(html, "otherco").includes('data-declared="waiting"'), "the waiting session of the second project is on the page");
  assert.ok(blockOf(html, "bigco").includes("#b1") && blockOf(html, "bigco").includes('data-declared="working"'), "the working session stays too");
  assert.ok(html.includes("Waiting for you"), "the waiting stamp stays");
}

test("big page: one running project with a big roadmap (300 long shipped rows, a 147 KB file) no longer stops the page; the waiting session of a second project reaches it", async () => {
  await scenarioRunning(REAL);
});

test("big page: a set with such a project prints no page not rebuilt line", async () => {
  const w = world("runbig-set");
  const big = w.proj("bigco");
  put(big, RM, bigRoadmap("b", 300));
  enable(w);
  const r = await sr(setArgs(w, big, "b1", "build", "working"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines, ["status set: phase b1 build working"]);
  assert.ok(bytesOf(readFileSync(pageFile(w), "utf8")) <= 256 * KB);
});

// ── 5a. the hard limit really is 1 MB ───────────────────────────────────────
async function scenarioHard(mods) {
  const w = world("hard");
  const heavy = w.proj("heavyco");
  put(heavy, RM, bigRoadmap("h", 120));
  enable(w);
  const id = idFor(w, heavy);
  heavySessions(w, id, 80);
  const built = await mods.page.buildPage(w.data, { now: NOW });
  assert.deepEqual(built, { ok: true }, "a page between 256 KB and 1 MB is written");
  const html = readFileSync(pageFile(w), "utf8");
  assert.ok(html.includes(LEFT_OUT), "the tables were left out first");
  assert.ok(bytesOf(html) > 256 * KB && bytesOf(html) < 1024 * KB, `the page is ${bytesOf(html)} bytes: over the soft limit even with the tables left out, under the hard one`);
  const out = join(w.base, "page.html");
  const logs = [];
  const code = await mods.page.main(["--data", w.data, "--out", out], { out: (s) => logs.push(s), err: (s) => logs.push(s), now: () => NOW });
  assert.equal(code, 0, logs.join("\n"));
  assert.equal(bytesOf(readFileSync(out, "utf8")) > 256 * KB, true);
}

test("big page: a page between 256 KB and 1 MB is written, by the rebuild and by the command, with the real limit and no seam", async () => {
  await scenarioHard(REAL);
});

// ── 5b. the note line itself pushes the page over ───────────────────────────
function scenarioNoteEdge(mods) {
  const a = fakeProject(1, "edgeaco", 150);
  const b = fakeProject(2, "edgebco", 120);
  const data = fakeData([a, b]);
  const whole = bytesOf(mods.page.renderPage(data, { now: NOW, fonts: false, softBytes: 1000 * KB * KB }));
  const oneOut = bytesOf(mods.page.renderPage(data, { now: NOW, fonts: false, softBytes: whole - 1 }));
  assert.ok(oneOut < whole - 1, "the first project alone is enough for that limit");
  // the limit is one byte under the page that has one project left out, so the note line's own bytes tip it over
  const html = mods.page.renderPage(data, { now: NOW, fonts: false, softBytes: oneOut - 1 });
  assert.ok(bytesOf(html) <= oneOut - 1, `the page is ${bytesOf(html)} bytes, over the limit of ${oneOut - 1}`);
  assert.ok(blockOf(html, "edgeaco").includes(LEFT_OUT) && blockOf(html, "edgebco").includes(LEFT_OUT), "a second project went because the note line took some bytes");
}

test("big page: when the note line itself puts the page over the limit, one more project's tables go", () => {
  scenarioNoteEdge(REAL);
});

// ── 3. the documents say what is true ───────────────────────────────────────
test("docs: the two size limits, the need for JavaScript, the path wording and the --out exception read the same everywhere", () => {
  const cl = repoText("plugins", "phased-shipping", "CHANGELOG.md");
  const change = cl.slice(cl.indexOf("## 0.10.0"), cl.indexOf("\n## ", cl.indexOf("## 0.10.0") + 5));
  const readme = repoText("plugins", "phased-shipping", "README.md");
  const status = repoText("plugins", "phased-shipping", "skills", "dashboard", "references", "status.md");
  const wiki = repoText("docs", "wiki", "Dashboard.md");
  const skill = repoText("plugins", "phased-shipping", "skills", "dashboard", "SKILL.md");
  const pageSrc = repoText("plugins", "phased-shipping", "skills", "dashboard", "scripts", "page.mjs");
  // (a) one rule everywhere: a soft limit of 256 KB (tables are left out) and a hard limit of 1 MB (nothing is written)
  for (const [name, text] of Object.entries({ change, readme, status, wiki })) {
    assert.ok(text.includes("soft limit of 256 KB") && text.includes("hard limit of 1 MB"), `${name} states both limits`);
  }
  assert.ok(!change.includes("is not written over 256 KB"), "the changelog no longer says the page is not written over 256 KB");
  for (const [name, text] of Object.entries({ change, readme, status, wiki })) assert.ok(!/not written (at all )?over 256 KB/.test(text), name);
  // (b) JavaScript: what needs it, and what is hidden without it
  for (const [name, text] of Object.entries({ readme, status, wiki })) {
    assert.ok(text.includes("90-minute stale banner") && text.includes("need JavaScript"), `${name} says what needs JavaScript`);
  }
  assert.ok(change.includes("(in the header and in the footer)") && change.includes("need JavaScript"));
  assert.ok(wiki.includes("(in the header and the footer)"));
  // (c) the path wording
  for (const [name, text] of Object.entries({ readme, status, change, skill, pageSrc })) assert.ok(!/(page|It) holds no (JSON and no )?absolute path|no JSON and no absolute path/.test(text), `${name} does not claim the page holds no absolute path`);
  assert.ok(count(readme, "do not put paths in plan text") >= 2, "README says it twice, in the page and in the data sections");
  for (const [name, text] of Object.entries({ status, change, wiki, pageSrc })) assert.ok(text.includes("do not put paths in plan text"), name);
  assert.ok(readme.includes("No path the tool builds appears in the page") && status.includes("no path the tool builds appears in it"));
  // (d) the one exception to "nothing else is written"
  assert.ok(status.includes("with `page.mjs --out <file>`, to the one file you name"), "status.md names the page --out file");
  assert.ok(skill.includes("`page.mjs --out <file>` writes the one file you name"), "SKILL.md names the page --out file");
});

// ── the changes above, each one made on its own in a temp copy of the scripts: every one is caught ──
test("fix round 2: each change below, made in a copy of the scripts, makes its scenario fail", async () => {
  const unc = `if (TWO_SEPARATORS.test(String(raw)) || TWO_SEPARATORS.test(target)) return "must not be a network or device path (two separators at the start)";`;
  const cases = [
    ["no network-path refusal", [["collect.mjs", unc, ""]], scenarioOut],
    ["no identity walk", [["collect.mjs", "if (hasFileNumber(own)) {", "if (false) {"]], scenarioOut],
    ["a colon is fine in a name with a dollar sign", [["collect.mjs", `if (basename(target).includes(":")) return`, `if (basename(target).includes(":") && !basename(target).includes("$")) return`]], scenarioColon],
    ["the hard limit is the soft one", [["page.mjs", "io.maxPageBytes ?? MAX_PAGE_BYTES", "io.maxPageBytes ?? SOFT_PAGE_BYTES"]], scenarioHard],
    ["no correction loop for the note line", [["page.mjs", "for (const c of order) { if (Buffer.byteLength(html) <= soft) break; if (!dropped.has(c.p)) { dropped.add(c.p); html = build(dropped); } }", ""]], scenarioNoteEdge],
    ["running projects never give up their tables", [["page.mjs", "const order = [...biggest(projects.filter((p) => !running(p))), ...biggest(projects.filter(running))];", "const order = [...biggest(projects.filter((p) => !running(p)))];"]], scenarioRunning],
    ["the unknown-project check after the shape checks", [["collect.mjs", `    if (!known.has((plain ?? tagged)[1])) continue;
`, ""], ["collect.mjs", "    const age = nowMs - v.updated;", `    if (!known.has(id)) continue;
    const age = nowMs - v.updated;`]], scenarioUnregister],
  ];
  for (const [name, changes, scenario] of cases) {
    const mods = await mutantOf(changes);
    await assert.rejects(async () => { await scenario(mods); }, (e) => e?.code === "ERR_ASSERTION", `${name}: the scenario did not fail on an assertion`);
  }
});

// ── round 3: the logo's look, the stale banner, the title block, the estimate from the history ──
const ph = (id, title, status, extra = {}) => ({ id, phase: title, status, kind: "backend", priority: "P1", urgency: "Soon", estRaw: 2, estCal: 1.5, estimateH: null, actual: null, commit: "", timestamps: {}, ...extra });
const pj = (n, name, phases, extra = {}) => ({ id: String(n).padStart(12, "b"), name, status: "ok", roadmaps: phases ? [{ file: "plan.md", tables: 1, standard: true, phases }] : [], history: [], errors: [], ...extra });
const htmlOf = (projects, sessions = [], o = {}) => renderPage(fakeData(projects, sessions), { now: NOW, fonts: false, ...o });
// The page without its stylesheet, so a class name is looked for in the markup only.
const mu = (projects, sessions = [], o = {}) => htmlOf(projects, sessions, o).replace(/<style>[\s\S]*?<\/style>/, "");
const MEDIA_MOTION = "@media screen and (prefers-reduced-motion:no-preference)";

// The rules of a stylesheet, flattened: { stack: the at-rules around it, selector, body }.
function cssRules(css, stack = []) {
  const text = stack.length ? css : css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
    const inner = text.slice(open + 1, j - 1);
    if (/^@(media|keyframes|supports)/.test(head)) out.push(...cssRules(inner, [...stack, head]));
    else out.push({ stack, selector: head, body: inner });
    i = j;
  }
  return out;
}
const declarations = (body) => body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const at = d.indexOf(":"); return [d.slice(0, at).trim(), d.slice(at + 1).trim()]; });
const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const lab = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(lin);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, k) => v - lab(b)[k]));
function palettes(css) {
  const vars = (body) => Object.fromEntries([...body.matchAll(/--([a-z0-9]+):(#[0-9A-Fa-f]{6});/g)].map((m) => [m[1], m[2].toUpperCase()]));
  const roots = cssRules(css).filter((r) => r.selector === ":root" && r.body.includes("--bg:"));
  const light = roots.find((r) => r.stack.length === 0);
  const dark = roots.find((r) => r.stack.some((s) => s.includes("prefers-color-scheme:dark")));
  return { light: vars(light.body), dark: vars(dark.body) };
}

test("look: the hatching is animated only where something is in progress, and the header rule only while a session is working", () => {
  const busy = pj(1, "busyco", [ph("1", "One", "shipped"), ph("2", "Two", "in progress"), ph("3", "Three", "planned")]);
  const calm = pj(2, "calmco", [ph("1", "One", "shipped"), ph("2", "Two", "planned")]);
  const html = mu([busy, calm], [fakeSession(busy, "2", "working", 1)]);
  assert.equal(count(html, 'class="hatch live"'), 1, "one running gate, one drifting hatch");
  assert.ok(blockOf(html, "busyco").includes('class="hatch live"') && !blockOf(html, "calmco").includes("hatch"));
  assert.equal(count(html, 'class="mk mk-h"'), 1, "one in-progress mark on the roadmap rows");
  assert.ok(blockOf(html, "busyco").includes('class="mk mk-h"') && !blockOf(html, "calmco").includes("mk-h"));
  assert.ok(blockOf(html, "busyco").includes("seg-p") && !blockOf(html, "calmco").includes("seg-p"));
  assert.ok(html.includes('<div class="sheet has-working">'), "a session is working, so the header rule moves");
  // a session that waits, is idle, is done, or no session at all: the header is still, and only a working gate drifts
  const waiting = mu([busy], [fakeSession(busy, "2", "waiting", 1)]);
  assert.ok(waiting.includes('<div class="sheet">') && !waiting.includes("has-working") && !waiting.includes('class="hatch'), "waiting: no drift, no moving header");
  const idle = mu([busy], [fakeSession(busy, "2", "working", 200)]);
  assert.ok(idle.includes('<div class="sheet">') && idle.includes('class="hatch"') && !idle.includes("hatch live"), "a working session gone Idle: the hatch is there and still");
  const done = mu([busy], [fakeSession(busy, "2", "done", 1)]);
  assert.ok(!done.includes("has-working") && !done.includes('class="hatch'));
  const none = mu([calm]);
  assert.ok(none.includes('<div class="sheet">') && !none.includes("has-working") && !none.includes("mk-h") && !none.includes("seg-p"));
  assert.ok(!mu([busy], [{ ...fakeSession(busy, "2", "working", 1), archived: true }]).includes("has-working"), "an archived session does not count");
  // no curve in the hatch: straight stripes only
  for (const m of html.matchAll(/<path class="hatch[^"]*" d="([^"]*)"/g)) assert.match(m[1], /^[Ml0-9. -]+$/);
  assert.ok(!/<svg class="hclip"[^>]*(?:rx|ry)=/.test(html));
});

test("look: animation is declared only inside the screen, no-preference block (none in print, none for reduced motion); the paused class stops it", () => {
  const css = cssOf(htmlOf([pj(1, "busyco", [ph("1", "One", "in progress")])]));
  const rules = cssRules(css);
  const animated = rules.filter((r) => declarations(r.body).some(([p, v]) => p === "animation" && !/^none\b/.test(v)));
  assert.ok(animated.length >= 4);
  for (const r of animated) assert.ok(r.stack.includes(MEDIA_MOTION), `animation outside the no-preference block: ${r.selector}`);
  assert.deepEqual(animated.map((r) => r.selector).sort(), [".flow .loop-active", ".mk-h::before,.seg-p::before", ".sess[data-state=working] .hatch.live", ".sheet.has-working .top-band::before"].sort(), "only the in-progress things move");
  for (const r of rules.filter((x) => x.stack.some((s) => s.startsWith("@media print")))) assert.ok(!/animation/.test(r.body), `animation in print: ${r.selector}`);
  assert.ok(MEDIA_MOTION.includes("screen"), "a screen-only block, so the printed page is still");
  for (const r of rules.filter((x) => x.stack.some((s) => s.startsWith("@keyframes")))) assert.ok(r.stack.includes(MEDIA_MOTION), "a keyframes rule outside the no-preference block");
  const reduce = rules.find((r) => r.stack.some((s) => s.includes("prefers-reduced-motion:reduce")));
  assert.ok(reduce && /animation:none!important/.test(reduce.body), "reduced motion switches every animation off");
  const paused = rules.find((r) => r.selector.includes("body.paused"));
  assert.ok(paused && paused.stack.includes(MEDIA_MOTION) && paused.body.includes("animation-play-state:paused"));
  assert.ok(paused.selector.includes("*::before") && paused.selector.includes("*::after"), "the drift runs on a ::before, so the paused class must reach it");
  assert.ok(!/transition\s*:\s*(?!none)/.test(css));
  // the drift is a whole number of stripe periods, so the loop has no jump: the tile is 8px and the drift is 8px; the gate's stripes are 6 apart and move 6
  assert.ok(css.includes("background-size:8px 8px") && css.includes("@keyframes hatch-drift{to{transform:translateX(8px)}}") && css.includes("translateX(6px)"));
  assert.ok(!css.includes("background-position"), "no background-position anywhere: it repaints on the main thread; only transform moves");
  for (const r of rules.filter((x) => x.stack.some((s) => s.startsWith("@keyframes")))) for (const [prop] of declarations(r.body)) assert.ok(["transform", "stroke-dashoffset"].includes(prop), `a keyframe changes ${prop}`);
});

test("look: the script marks the page paused with a class (CSS stops the drift) and adds no second script", () => {
  const off = runClient(CLIENT_SRC);
  assert.equal(off.threw, null);
  assert.ok(!off.body.classes.has("paused"));
  assert.deepEqual(off.added, ["js"], "toggle is not an add; js is still the only class added at start");
  const on = runClient(CLIENT_SRC, { storage: { "pw:paused": "1" } });
  assert.ok(on.body.classes.has("paused"), "paused from the start when it was paused before the reload");
  off.btn.handlers.click();
  assert.ok(off.body.classes.has("paused"), "the Pause button sets it");
  off.btn.handlers.click();
  assert.ok(!off.body.classes.has("paused"), "and Resume takes it off");
  const html = htmlOf([pj(1, "busyco", [ph("1", "One", "in progress")])]);
  assert.equal(count(html, "<script"), 1, "no second script");
  assert.equal(scriptOf(html), CLIENT_SRC.replace(/\r\n?/g, "\n"));
  assert.ok(html.includes(`script-src 'sha256-${createHash("sha256").update(CLIENT_SRC.replace(/\r\n?/g, "\n")).digest("base64")}'`), "the policy hash is that of the script as it is");
});

test("look: the project row has a bar of shipped, in progress and planned phases that matches the counts, with a text label and an aria-label", () => {
  const phases = (n) => Object.entries(n).flatMap(([status, k]) => Array.from({ length: k }, (_, i) => ph(`${status[0]}${i}`, `${status} ${i}`, status)));
  const bar = (n, extra = {}) => { const h = mu([pj(1, "barco", phases(n), extra)]); return { h, row: blockOf(h, "barco").split("</summary>")[0] }; };
  const segs = (row) => [...row.matchAll(/<span class="seg (seg-[spn])" style="flex-grow:(\d+)"><\/span>/g)].map((m) => [m[1], Number(m[2])]);
  const all = bar({ shipped: 3, "in progress": 1, planned: 3, parked: 2 });
  assert.deepEqual(segs(all.row), [["seg-s", 3], ["seg-p", 1], ["seg-n", 3]], "parked phases are not drawn");
  assert.ok(all.row.includes('<span class="plabel" aria-hidden="true">3 shipped, 1 in progress, 3 planned, 2 parked</span>'));
  assert.ok(all.row.includes('role="img" aria-label="Roadmap: 3 shipped, 1 in progress, 3 planned, 2 parked"'));
  const none = bar({ shipped: 2, planned: 1 });
  assert.deepEqual(segs(none.row), [["seg-s", 2], ["seg-n", 1]], "zero in progress: no hatched segment");
  assert.ok(none.row.includes("2 shipped, 0 in progress, 1 planned") && !none.row.includes("parked"));
  const noPlan = bar({ shipped: 1, "in progress": 2 });
  assert.deepEqual(segs(noPlan.row), [["seg-s", 1], ["seg-p", 2]], "zero planned: no outlined segment");
  assert.deepEqual(segs(bar({ planned: 4 }).row), [["seg-n", 4]]);
  assert.deepEqual(segs(bar({ shipped: 4 }).row), [["seg-s", 4]]);
  const weird = mu([pj(1, "barco", [ph("1", "a", "blocked"), ph("2", "b", ""), ph("3", "c", "shipped")])]);
  assert.deepEqual(segs(blockOf(weird, "barco")), [["seg-s", 1], ["seg-n", 2]], "an unknown status counts as planned, as the table shows it");
  const parkedOnly = bar({ parked: 2 });
  assert.deepEqual(segs(parkedOnly.row), []);
  assert.ok(!parkedOnly.row.includes("pbar") && parkedOnly.row.includes("0 shipped, 0 in progress, 0 planned, 2 parked"), "text only: nothing to draw");
  const empty = mu([pj(1, "barco", null)]);
  assert.ok(blockOf(empty, "barco").includes("No roadmap phases") && !empty.includes("pbar"));
  // two roadmap files are counted together
  const two = mu([{ ...pj(1, "barco", [ph("1", "a", "shipped")]), roadmaps: [{ file: "a.md", standard: true, phases: [ph("1", "a", "shipped")] }, { file: "b.md", standard: true, phases: [ph("2", "b", "in progress"), ph("3", "c", "planned")] }] }]);
  assert.deepEqual(segs(blockOf(two, "barco")), [["seg-s", 1], ["seg-p", 1], ["seg-n", 1]]);
  // the label is plain text: hostile text in a phase title never reaches it, and the widths are whole numbers
  const styles = [...all.h.matchAll(/ style="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(styles.length === 3 && styles.every((v) => /^flex-grow:[0-9]+$/.test(v)), "an inline style holds only flex-grow and a whole number");
  // shapes: the logo's three squares, square corners, hatch and outline in CSS
  const css = cssOf(htmlOf([pj(1, "barco", phases({ shipped: 1 }))]));
  const rules = cssRules(css);
  const rule = (sel) => rules.find((r) => r.selector === sel && r.stack.length === 0)?.body ?? "";
  assert.ok(rule(".seg-s").includes("background-color:var(--ink)"), "shipped: filled");
  const hatchRule = rules.find((r) => r.stack.length === 0 && r.selector.split(",").includes(".seg-p::before"))?.body ?? "";
  assert.ok(rule(".seg-p").includes("border-color:var(--prog)") && rule(".mk-h,.seg-p").includes("overflow:hidden") && hatchRule.includes("background-image:var(--hatch)"), "in progress: salmon border, and the hatch in a clipped pseudo-element");
  assert.ok(rule(".seg").includes("border:2px solid var(--ink)") && !rule(".seg").includes("background"), "planned: outlined, no fill");
  assert.ok(!/border-radius\s*:\s*(?!0\b)/.test(css) && !/linecap|round/.test(rule(".seg") + rule(".pbar")));
});

test("look: the colours: salmon only on borders, strokes and hatching; every new colour pair is 3:1 (text 4.5:1) in both palettes; waiting is a different tone", () => {
  const css = cssOf(htmlOf([pj(1, "busyco", [ph("1", "One", "in progress")])]));
  const pal = palettes(css);
  const brand = (f) => readFileSync(join(HERE, "..", "docs", "brand", f), "utf8");
  // the colours are the logo's: the dark mark has the pale salmon, the light mark has the darker one that reads on a light page
  assert.ok(brand("phasewright-mark-dark.svg").toUpperCase().includes(pal.dark.prog), "dark palette: the dark mark's salmon");
  assert.ok(brand("phasewright-mark-light.svg").toUpperCase().includes(pal.light.prog), "light palette: the light mark's salmon");
  assert.ok(contrast("#FFB28F", pal.light.bg) < 3, "the pale salmon does not reach 3:1 on the light page, which is why the light palette uses the light mark's");
  const rows = [];
  for (const [name, p] of Object.entries(pal)) {
    rows.push([`${name} prog (border, stroke, hatch) on the page`, contrast(p.prog, p.bg), 3]);
    rows.push([`${name} ink (filled segment, outline) on the page`, contrast(p.ink, p.bg), 3]);
    rows.push([`${name} wait (text and border) on the page`, contrast(p.wait, p.bg), 4.5]);
    rows.push([`${name} ink2 (label text) on the page`, contrast(p.ink2, p.bg), 4.5]);
    assert.ok(deltaE(p.prog, p.wait) >= 25, `${name}: waiting is clearly another tone than in progress (dE ${deltaE(p.prog, p.wait).toFixed(1)})`);
    assert.notEqual(p.prog, p.wait);
  }
  for (const [what, got, need] of rows) assert.ok(got >= need, `${what}: ${got.toFixed(2)} is under ${need}`);
  // salmon is used only on border, stroke and hatch properties
  const SALMON = [pal.light.prog, pal.dark.prog];
  let uses = 0;
  for (const r of cssRules(css)) {
    for (const [prop, value] of declarations(r.body)) {
      const salmon = value.includes("var(--prog)") || value.includes("var(--hatch)") || SALMON.some((c) => value.toUpperCase().includes(c));
      if (!salmon) continue;
      uses++;
      const ok = prop === "--prog" || (prop === "--hatch" && value.includes("var(--prog)")) || (prop === "--focus" && value === "var(--prog)")
        || /^border(-(top|right|bottom|left))?(-color)?$/.test(prop) || prop === "stroke" || (prop === "background-image" && value === "var(--hatch)");
      assert.ok(ok, `salmon used by ${prop} in ${r.selector}`);
      assert.ok(!["color", "fill", "background", "background-color"].includes(prop), prop);
    }
  }
  assert.ok(uses >= 8, "the salmon is used");
  const comments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const c of SALMON) assert.equal(count(comments.toUpperCase(), c), 1, "the literal colour appears once, as its palette's --prog");
  // never as text or as a panel in the markup either
  const html = htmlOf([pj(1, "busyco", [ph("1", "One", "in progress")])], [fakeSession(pj(1, "busyco"), "1", "working", 1)]);
  assert.ok(!/style="[^"]*(?:color|background|fill)/i.test(html));
});

// ── the stale-page banner ───────────────────────────────────────────────────
test("stale banner: 90 minutes, from one value in the page, the placeholder and the script", () => {
  const html = htmlOf([]);
  assert.ok(html.includes('data-page-stale-min="90"') && !html.includes('data-page-stale-min="15"'));
  assert.ok(html.includes('<strong>This page has not been rewritten for <span data-since-written>1 h 30 min</span>.</strong> The run that writes it may have stopped; times below still count up from the last write.'), "the wording is kept; the minutes are the same value");
  assert.ok(CLIENT_SRC.includes("bounded(ds.pageStaleMin, 90, 1, 100000)") && !CLIENT_SRC.includes("bounded(ds.pageStaleMin, 15"));
  const pageSrc = readFileSync(join(SKILL, "scripts", "page.mjs"), "utf8");
  assert.equal(count(pageSrc, "PAGE_STALE_MIN"), 3, "defined once and used twice: the attribute and the placeholder");
  assert.ok(pageSrc.includes("const PAGE_STALE_MIN = 90;"));
  // the script, run with no attribute: the banner appears at 90 minutes, not before; an explicit value still wins
  const run = (minAgo, body) => {
    const r = runClient(CLIENT_SRC, { body, written: stubEl({ "data-t": String(T0 - minAgo * MIN) }) });
    assert.equal(r.threw, null);
    return { r, hidden: r.stale.hidden };
  };
  assert.equal(run(89, { pageStaleMin: undefined }).hidden, true, "89 minutes: no banner");
  assert.equal(run(90, { pageStaleMin: undefined }).hidden, false, "90 minutes: banner");
  assert.equal(run(30, { pageStaleMin: "15" }).hidden, false, "the page's own value is used when it is given");
  assert.equal(run(30, {}).hidden, true, "the stub's body carries the page's 90");
  assert.equal(run(90, { pageStaleMin: "90" }).hidden, false);
});

// ── the title block ─────────────────────────────────────────────────────────
const titleBlockOf = (html) => html.match(/<dl class="titleblock">[\s\S]*?<\/dl>/)[0];
const cell = (tb, name) => (tb.match(new RegExp(`<div[^>]*><dt>${name.replace(/[()]/g, "\\$&")}</dt><dd>([^<]*)</dd></div>`)) ?? [])[1];

test("title block: real figures instead of Sheet 1 of 1: written (UTC), projects, roadmap, sessions, archived, source", () => {
  const a = pj(1, "alphaco", [ph("1", "a", "shipped"), ph("2", "b", "shipped"), ph("3", "c", "planned")]);
  const b = pj(2, "betaco", [ph("1", "a", "shipped"), ph("2", "b", "in progress")]);
  const c = pj(3, "gammaco", null);
  const sessions = [fakeSession(a, "3", "working", 1), fakeSession(a, "4", "waiting", 2), fakeSession(b, "2", "working", 400), { ...fakeSession(b, "9", "done", 9000), archived: true }, { ...fakeSession(b, "8", "done", 9000), archived: true }, fakeSession(b, "7", "done", 5)];
  const tb = titleBlockOf(htmlOf([a, b, c], sessions));
  assert.ok(!tb.includes("Sheet") && !tb.includes("1 of 1"), "the decorative sheet count is gone");
  assert.equal(cell(tb, "Written (UTC)"), "2026-10-27 10:00:00");
  assert.equal(cell(tb, "Projects"), "3");
  assert.equal(cell(tb, "Roadmap"), "3 of 5", "phases shipped of all phases, across the projects");
  assert.equal(cell(tb, "Sessions"), "2 active, 1 waiting", "an idle or done session is not active");
  assert.equal(cell(tb, "Archived"), "2");
  assert.equal(cell(tb, "Source"), "plan, history, status files");
  assert.equal(cell(tb, "Network"), "none");
  // the collected summary is used when it is smaller than the rows drawn (as on the project rows); one that claims more than
  // the page draws, or a bad one, gives the rows
  const s0 = { ...a, summary: { roadmaps: 1, phasesTotal: 2, phasesShipped: 1, legacyFiles: 0, legacyNames: [] } };
  assert.equal(cell(titleBlockOf(htmlOf([s0])), "Roadmap"), "1 of 2");
  const s1 = { ...a, summary: { roadmaps: 1, phasesTotal: 72, phasesShipped: 23, legacyFiles: 0, legacyNames: [] } };
  assert.equal(cell(titleBlockOf(htmlOf([s1])), "Roadmap"), "2 of 3");
  const s2 = { ...a, summary: { roadmaps: 1, phasesTotal: "<b>", phasesShipped: "x", legacyFiles: 0, legacyNames: [] } };
  assert.equal(cell(titleBlockOf(htmlOf([s2])), "Roadmap"), "2 of 3");
  // nothing to show is zero, not an error
  const empty = titleBlockOf(htmlOf([]));
  assert.equal(cell(empty, "Projects"), "0");
  assert.equal(cell(empty, "Roadmap"), "0 of 0");
  assert.equal(cell(empty, "Sessions"), "0 active, 0 waiting");
  assert.equal(cell(empty, "Archived"), "0");
  assert.ok(!/NaN|undefined|null/.test(empty));
  // a session of a project that is not listed is not counted as archived
  const orphan = { ...fakeSession(a, "5", "done", 9000), project: "zzzzzzzzzzzz", archived: true };
  assert.equal(cell(titleBlockOf(htmlOf([a], [orphan])), "Archived"), "0");
  // text goes through the usual escaping: a hostile name is not in the block, and the block holds no markup but its own
  const hostile = titleBlockOf(htmlOf([pj(1, HOSTILE, [ph("1", HOSTILE, "shipped")])]));
  assert.ok(!hostile.includes("<script") && !hostile.includes("pwned") && cell(hostile, "Roadmap") === "1 of 1");
  const pageSrc = readFileSync(join(SKILL, "scripts", "page.mjs"), "utf8");
  assert.ok(!pageSrc.includes("Sheet</dt>") && !pageSrc.includes("1 of 1</dd>"));
});

// ── the estimate against actual, from the history ───────────────────────────
const rec = (phase, est, actual, extra = {}) => ({ phase, est_h: est, actual_h: actual, check_rounds: 1, caught_by: [], prod_first_pass: true, rolled_back: false, tokens: null, ...extra });
const estRows = (html, name) => {
  const part = blockOf(html, name).split("<summary>Estimate against actual")[1].split("</details>")[0];
  return [...part.matchAll(/<tr><td class="id">([^<]*)<\/td><td>([\s\S]*?)<\/td><td class="n">([^<]*)<\/td><td class="n"><strong>([^<]*)<\/strong><\/td>/g)].map((m) => ({ id: m[1], title: m[2].replace(/<[^>]*>/g, ""), est: m[3], actual: m[4] }));
};
const estSummary = (html, name) => blockOf(html, name).match(/Estimate against actual <span class="sub">([^<]*)<\/span>/)[1];

test("estimate: the rows come from the history, so a roadmap with no Actual column still shows them; est and notes from the record, title from the roadmap", () => {
  const p = pj(1, "histco", [ph("1", "Sign-in screen", "shipped"), ph("2", "Audit log viewer", "shipped", { estimateH: 4 }), ph("3", "Planned later", "planned")], {
    history: [rec("1", 2, 1.5, { check_rounds: 0 }), rec("2", null, 5, { prod_first_pass: false, check_rounds: 2 }), rec("3", 1, 0.5, { rolled_back: true })],
  });
  const html = htmlOf([p]);
  assert.deepEqual(estRows(html, "histco"), [
    { id: "1", title: "Sign-in screen", est: "2.0 h", actual: "1.5 h" },
    { id: "2", title: "Audit log viewer", est: "4.0 h", actual: "5.0 h" },
    { id: "3", title: "Planned later", est: "1.0 h", actual: "0.5 h" },
  ], "history order, oldest first; the second row's estimate is the roadmap row's (the record has none)");
  assert.equal(estSummary(html, "histco"), "3 phases with a time");
  const part = blockOf(html, "histco").split("<summary>Estimate against actual")[1];
  assert.ok(part.includes("Total, 3 phases") && part.includes("7.0 h") && part.includes("7.0 h</td>"), "totals: estimate 2 + 4 + 1, actual 1.5 + 5 + 0.5");
  assert.ok(part.includes(`<td class="n over">+1.0 h</td>`), "the over-estimate styling stays");
  assert.ok(part.includes("<td>first pass</td>") && part.includes("<td>fixed after</td>") && part.includes("<td>rolled back</td>"), "first pass, fixed after, rolled back");
  assert.ok(part.includes('<td class="n">0</td>') && part.includes('<td class="n">2</td>'), "fix rounds");
  assert.ok(part.includes('<svg class="eva"') && count(part, '<rect class="act') === 3, "bars on one shared scale");
  assert.ok(part.includes("from the history log") && part.includes("includes any waiting"), "the table says where the time comes from");
});

test("estimate: two records for one phase use the newest; ids match without regard to case; a record with no actual time is no row", () => {
  const p = pj(1, "twice", [ph("7a", "Seven", "shipped")], { history: [rec("7A", 2, 3), rec("8", 1, 1), rec("7a", 2, 1.4, { prod_first_pass: false }), rec("9", 1, null)] });
  const html = htmlOf([p]);
  assert.deepEqual(estRows(html, "twice"), [
    { id: "8", title: "", est: "1.0 h", actual: "1.0 h" },
    { id: "7a", title: "Seven", est: "2.0 h", actual: "1.4 h" },
  ], "the newest record of 7a wins and sits where it was written (after 8); the record without an actual is skipped");
  assert.ok(html.split("<summary>Estimate against actual")[1].split('<td class="id">7a</td>')[1].split("</tr>")[0].includes("<td>fixed after</td>"), "its notes are the newest record's, not the first attempt's");
  assert.equal(estSummary(html, "twice"), "2 phases with a time");
});

test("estimate: a history record with no roadmap row shows the id alone; a roadmap row with an Actual and no history still shows, after the history rows", () => {
  const p = pj(1, "mixed", [ph("1", "Has history", "shipped"), ph("2", "Only roadmap", "shipped", { actual: 2.5, estimateH: 2 }), ph("3", "Open", "in progress", { actual: 9 })], { history: [rec("zz9", 1, 2), rec("1", 1, 1)] });
  const html = htmlOf([p]);
  assert.deepEqual(estRows(html, "mixed"), [
    { id: "zz9", title: "", est: "1.0 h", actual: "2.0 h" },
    { id: "1", title: "Has history", est: "1.0 h", actual: "1.0 h" },
    { id: "2", title: "Only roadmap", est: "2.0 h", actual: "2.5 h" },
  ], "an in-progress row with an Actual is not shipped, so it is not added");
  assert.ok(blockOf(html, "mixed").includes('<td class="id">zz9</td><td></td>'), "the id alone: no title, nothing made up");
  // the history wins over the roadmap's own Actual for the same phase
  const both = pj(1, "both", [ph("1", "One", "shipped", { actual: 9, estimateH: 3 })], { history: [rec("1", 2, 1)] });
  assert.deepEqual(estRows(htmlOf([both]), "both"), [{ id: "1", title: "One", est: "2.0 h", actual: "1.0 h" }]);
});

test("estimate: empty states, and the history of another project's labels is not used", async () => {
  const none = htmlOf([pj(1, "noneco", [ph("1", "One", "shipped"), ph("2", "Two", "planned")])]);
  assert.ok(blockOf(none, "noneco").includes("No phase has an actual time yet.") && !blockOf(none, "noneco").includes("Nothing has shipped"));
  assert.equal(estSummary(none, "noneco"), "0 phases with a time");
  const noActual = htmlOf([pj(1, "noact", [ph("1", "One", "shipped")], { history: [rec("1", 2, null)] })]);
  assert.ok(blockOf(noActual, "noact").includes("No phase has an actual time yet."), "a history record without an actual time gives no row and no fake zero");
  assert.equal(estSummary(htmlOf([pj(1, "one", [], { history: [rec("1", 1, 1)] })]), "one"), "1 phase with a time");
  // end to end through collect: only the labels stored with the project join its history, and est_h and actual_h are carried
  const w = world("est-hist");
  const zork = w.proj("zork");
  const other = w.proj("other");
  put(zork, RM, roadmap([rowE("1", "Sign-in screen", "shipped"), rowE("2", "Audit log viewer", "shipped")]));
  put(other, RM, roadmap([rowE("1", "Somebody elses phase", "shipped")]));
  enable(w);
  st(["register", "--data", w.data, "--root", zork, "--label", "zork-app"]);
  st(["register", "--data", w.data, "--root", other, "--label", "other-app"]);
  writeFileSync(join(w.data, "history.jsonl"), [
    JSON.stringify(rec("1", 2, 1.6, { project: "zork-app" })),
    JSON.stringify(rec("2", 3, 2.9, { project: "zork-app" })),
    JSON.stringify(rec("1", 5, 4.4, { project: "other-app" })),
    JSON.stringify(rec("1", 7, 6.6, { project: "zork" })),
  ].join("\n") + "\n");
  const j = (await col(w)).json();
  const zj = j.projects.find((x) => x.name === "zork");
  assert.deepEqual(zj.history.map((h) => [h.phase, h.est_h, h.actual_h]), [["1", 2, 1.6], ["2", 3, 2.9]], "collect carries est_h and actual_h, and only this project's labels join");
  const html = renderPage(j, { now: NOW, fonts: false });
  assert.deepEqual(estRows(html, "zork"), [
    { id: "1", title: "Sign-in screen", est: "2.0 h", actual: "1.6 h" },
    { id: "2", title: "Audit log viewer", est: "3.0 h", actual: "2.9 h" },
  ]);
  assert.deepEqual(estRows(html, "other"), [{ id: "1", title: "Somebody elses phase", est: "5.0 h", actual: "4.4 h" }]);
});

test("estimate: the page-size rule counts the rows the estimate table really holds (history rows with no roadmap row at all)", () => {
  const big = pj(1, "histbig", null, { history: Array.from({ length: 40 }, (_, i) => rec(`p${i}`, 1, 1.25)) });
  const small = pj(2, "tinyco", [ph("1", "a", "planned")]);
  const html = htmlOf([big, small], [], { softBytes: 2000 });
  assert.ok(html.includes("left out to keep the page small: 40 rows"), "40 history rows are counted, and the table is left out");
  assert.ok(!blockOf(html, "histbig").includes('<table class="tbl tbl-est">'));
  assert.ok(htmlOf([big, small]).includes("Total, 40 phases"), "and with room they are all there");
});

// ── round 4: strict roadmap display ─────────────────────────────────────────
// Only a standardized roadmap file is drawn: it has at least one table and every table has the marker line. The files that
// are not are named in one note inside their project. Every scenario runs against the real scripts and, in the last test of
// this section, against a temp copy with one change at a time (each must make its scenario fail).
const legacyMd = (rows) => [HEAD, `|${"---|".repeat(12)}`, ...rows].join("\n") + "\n";
const mixedMd = (marked, bare) => `${roadmap(marked)}\nA second table, with no marker line above it\n\n${legacyMd(bare)}`;
const PROSE_MD = "# Plan\n\nNothing but words here, and no table at all.\n";
const collectFrom = async (mods, w, extra = {}) => {
  const got = await mods.collect.collectData({ data: w.data, now: NOW, ...extra });
  assert.ok(got.ok, got.message);
  return got.data;
};
const draw = (mods, data) => mods.page.renderPage(data, { now: NOW, fonts: false });
const roadRows = (block) => count(block, 'class="tbl tbl-road"');

async function scenarioStrictFiles(mods) {
  // A. one standard file and three that are not: a legacy table, a file with two tables of which one has no marker, a file with no table
  {
    const w = world("strict-a");
    const zork = w.proj("zork");
    put(zork, RM, roadmap([rowE("1", "Sign-in screen", "shipped"), rowE("2", "Audit log viewer", "in progress")]));
    put(zork, "old.md", legacyMd([rowE("7", "Old legacy phase", "shipped"), rowE("8", "Another old one", "shipped"), rowE("9", "Third old one", "planned")]));
    put(zork, "two.md", mixedMd([rowE("4", "Marked table row", "shipped")], [rowE("5", "Unmarked table row", "shipped")]));
    put(zork, "prose.md", PROSE_MD);
    enable(w);
    assert.equal(st(["register", "--data", w.data, "--root", zork, "--roadmap", "old.md", "--roadmap", "two.md", "--roadmap", "prose.md"]).code, 0);
    const data = await collectFrom(mods, w);
    const p = data.projects[0];
    const by = Object.fromEntries(p.roadmaps.map((r) => [r.file, r]));
    assert.deepEqual(Object.keys(by), [RM, "old.md", "two.md", "prose.md"]);
    assert.deepEqual([RM, "old.md", "two.md", "prose.md"].map((f) => by[f].standard), [true, false, false, false], "standard: one table, all marked; legacy; two tables with one unmarked; no table");
    assert.equal(by["old.md"].phases.length, 3, "the JSON still holds the data of a file that is not standard");
    assert.equal(by["prose.md"].tables, 0);
    const { roadmaps, phasesTotal, phasesShipped, legacyFiles, legacyNames } = p.summary;
    assert.deepEqual({ roadmaps, phasesTotal, phasesShipped, legacyFiles, legacyNames }, { roadmaps: 1, phasesTotal: 2, phasesShipped: 1, legacyFiles: 3, legacyNames: ["old.md", "two.md", "prose.md"] });
    const html = draw(mods, data);
    const block = blockOf(html, "zork");
    assert.equal(roadRows(block), 1, "one table is drawn");
    assert.ok(block.includes(`<caption>${RM}</caption>`) && !block.includes("<caption>old.md") && !block.includes("<caption>two.md"));
    for (const t of ["Old legacy phase", "Another old one", "Unmarked table row", "Marked table row"]) assert.ok(!block.includes(t), `${t} is not drawn`);
    assert.ok(block.includes("Sign-in screen") && block.includes("Audit log viewer"));
    assert.equal(count(block, "not standardized:"), 1, "one note");
    assert.ok(block.includes("3 roadmap files not standardized: old.md, two.md, prose.md (not drawn).") && block.includes("Standardize them with the roadmap skill, mode standardize."));
    assert.ok(block.indexOf("not standardized:") < block.indexOf("<summary>Roadmap "), "the note is above the Roadmap part");
    assert.ok(block.includes('data-h="Roadmaps"><span class="fig">1</span> <span class="unit">(3 not standardized)</span>'), "the executive row");
    assert.ok(block.includes('<span class="fig">1 of 2</span>'), "shipped of total counts the standard file only");
    assert.ok(block.includes('aria-label="Roadmap: 1 shipped, 1 in progress, 0 planned"'), "the bar counts the standard file only");
    assert.ok(block.includes("1 of 2 shipped, 1 standard file"));
    assert.equal(cell(titleBlockOf(html), "Roadmap"), "1 of 2", "the title block counts the standard file only");
  }
  // B. only files that are not standard: the note, an empty state, no bar; the estimate part still works from the history
  {
    const w = world("strict-b");
    const zork = w.proj("zork");
    put(zork, RM, legacyMd([rowE("1", "Sign-in legacy title", "shipped", "2h → 1.5h", "1.6h"), rowE("2", "Second legacy title", "shipped", "2h → 1.5h", "2.9h")]));
    enable(w);
    assert.equal(st(["register", "--data", w.data, "--root", zork, "--label", "zork-app"]).code, 0);
    const id = idFor(w, zork);
    hand(w, id, "1", { step: "build" });
    writeFileSync(join(w.data, "history.jsonl"), `${JSON.stringify(rec("1", 2, 1.6, { project: "zork-app" }))}\n`);
    const data = await collectFrom(mods, w);
    assert.equal(data.projects[0].roadmaps[0].standard, false);
    assert.equal(data.projects[0].summary.roadmaps, 0);
    assert.equal(data.projects[0].summary.legacyFiles, 1);
    const html = draw(mods, data);
    const block = blockOf(html, "zork");
    assert.ok(block.includes(`1 roadmap file not standardized: ${RM} (not drawn).`) && block.includes("Standardize it with the roadmap skill, mode standardize."));
    assert.ok(block.includes("No standardized roadmap yet.") && roadRows(block) === 0);
    assert.ok(!block.includes('class="progress"') && !block.includes("pbar") && !block.includes("No roadmap phases"), "no bar, and not a row of zeros");
    assert.ok(block.includes('data-h="Roadmaps"><span class="fig">0</span> <span class="unit">(1 not standardized)</span>') && block.includes('<span class="fig">0 of 0</span>'));
    assert.equal(cell(titleBlockOf(html), "Roadmap"), "0 of 0");
    assert.deepEqual(estRows(html, "zork"), [{ id: "1", title: "", est: "2.0 h", actual: "1.6 h" }], "from the history, the id alone; the legacy row with an Actual and no record is not added");
    assert.ok(block.includes('<span class="none">(untitled)</span>'), "a session title is not taken from a file that is not standard");
    assert.ok(!html.includes("Sign-in legacy title") && !html.includes("Second legacy title"));
  }
  // C. only standard files: no note, nothing else changes
  {
    const w = world("strict-c");
    const zork = w.proj("zork");
    put(zork, RM, roadmap([rowE("1", "Sign-in screen", "shipped"), rowE("2", "Audit log viewer", "planned")]));
    enable(w);
    assert.equal(st(["register", "--data", w.data, "--root", zork]).code, 0);
    const html = draw(mods, await collectFrom(mods, w));
    const block = blockOf(html, "zork");
    assert.ok(!html.includes("not standardized") && !html.includes("No standardized roadmap"));
    assert.ok(block.includes('data-h="Roadmaps"><span class="fig">1</span></span>') && roadRows(block) === 1 && block.includes("1 of 2 shipped, 1 standard file"));
    assert.equal(cell(titleBlockOf(html), "Roadmap"), "1 of 2");
  }
}

test("strict: only standard roadmap files are drawn and counted; the others are named in one note, and a project with none has an empty state, no bar and a working estimate part", async () => {
  await scenarioStrictFiles(REAL);
});

test("strict: collect keeps at most 10 names of the files that are not standard, and the count is the number of files", async () => {
  const w = world("strict-ten");
  const zork = w.proj("zork");
  put(zork, RM, legacyMd([rowE("1", "A", "shipped")]));
  const extra = Array.from({ length: 9 }, (_, i) => `legacy-${i + 1}.md`);
  for (const f of extra) put(zork, f, legacyMd([rowE("1", "B", "planned")]));
  enable(w);
  assert.equal(st(["register", "--data", w.data, "--root", zork, ...extra.flatMap((f) => ["--roadmap", f])]).code, 0);
  const sum = (await col(w)).json().projects[0].summary;
  assert.equal(sum.legacyFiles, 10);
  assert.deepEqual(sum.legacyNames, [RM, ...extra]);
  assert.equal(sum.roadmaps, 0);
  const src = readFileSync(join(SKILL, "scripts", "collect.mjs"), "utf8");
  assert.ok(src.includes("legacy.slice(0, 10).map("), "the cap on the names is in the collector too");
});

const FILES10 = Array.from({ length: 10 }, (_, i) => `old-${i + 1}.md`);
const strictSummary = (o = {}) => ({ roadmaps: 0, phasesTotal: 0, phasesShipped: 0, legacyFiles: 0, legacyNames: [], active: 0, working: 0, waiting: 0, idle: 0, archived: 0, estimateActiveH: 0, workedActiveMs: 0, ...o });

function scenarioStrictPage(mods) {
  const render = (projects, sessions = []) => mods.page.renderPage(fakeData(projects, sessions), { now: NOW, fonts: false });
  const oldPh = [ph("1", "Hidden one", "shipped"), ph("2", "Hidden two", "planned"), ph("3", "Hidden three", "shipped")];
  // a roadmap entry of the first collector (no standard field), with that collector's summary, which counted every file
  const first = { id: "cccccccccccc", name: "firstco", status: "ok", roadmaps: [{ file: "plan.md", tables: 1, phases: oldPh }], history: [], errors: [],
    summary: { roadmaps: 1, phasesTotal: 3, phasesShipped: 2, active: 0, working: 0, waiting: 0, idle: 0, archived: 0, estimateActiveH: 0, workedActiveMs: 0 } };
  const h1 = render([first]);
  const b1 = blockOf(h1, "firstco");
  assert.equal(roadRows(b1), 0, "a missing standard field means not standard");
  assert.ok(!b1.includes("Hidden one") && !b1.includes("pbar") && !b1.includes('class="progress"'));
  assert.ok(b1.includes("1 roadmap file not standardized: plan.md (not drawn).") && b1.includes("No standardized roadmap yet."));
  assert.ok(b1.includes('<span class="fig">0</span> <span class="unit">(1 not standardized)</span>') && b1.includes('<span class="fig">0 of 0</span>'), "its summary is not used");
  assert.equal(cell(titleBlockOf(h1), "Roadmap"), "0 of 0");
  // the same entry marked standard is drawn, and the old summary is not trusted for its counts: the rows are counted
  const marked = { ...first, name: "markedco", roadmaps: [{ ...first.roadmaps[0], standard: true }] };
  const h2 = render([marked]);
  const b2 = blockOf(h2, "markedco");
  assert.equal(roadRows(b2), 1);
  assert.ok(b2.includes('<span class="fig">2 of 3</span>') && !b2.includes("not standardized"));
  // more than 10 names: ten are named, then "and M more"
  const many = { id: "dddddddddddd", name: "manyco", status: "ok", roadmaps: [], history: [], errors: [],
    summary: strictSummary({ legacyFiles: 12, legacyNames: [...FILES10, "old-11.md", "old-12.md"] }) };
  const b3 = blockOf(render([many]), "manyco");
  assert.ok(b3.includes(`12 roadmap files not standardized: ${FILES10.join(", ")} and 2 more (not drawn).`));
  assert.ok(!b3.includes("old-11.md") && !b3.includes("old-12.md"));
  // hostile names are cleaned and escaped
  const evil = { id: "eeeeeeeeeeee", name: "evilco", status: "ok", roadmaps: [{ file: HOSTILE, tables: 1, standard: false, phases: oldPh }], history: [], errors: [],
    summary: strictSummary({ legacyFiles: 2, legacyNames: [HOSTILE, `x${cp(0x202e)}y${cp(7)}.md`] }) };
  const h4 = render([evil]);
  const b4 = blockOf(h4, "evilco");
  assert.ok(b4.includes("2 roadmap files not standardized: &lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt; &amp;"));
  assert.ok(!b4.includes("<script>alert") && !b4.includes("<img") && !b4.includes(cp(0x202e)) && !b4.includes(cp(7)) && b4.includes("x y .md"));
  assert.equal(count(h4, "<script>"), 1, "only the page's own script");
  // a project that is not found behaves as before: no note, no empty state about standardizing
  const gone = { id: "ffffffffffff", name: "goneco", status: "not found", roadmaps: [], history: [], errors: [], summary: strictSummary() };
  const b5 = blockOf(render([gone]), "goneco");
  assert.ok(!b5.includes("not standardized") && !b5.includes("No standardized roadmap") && b5.includes("Project folder not found.") && b5.includes("No roadmap phases"));
  // a project with a standard file and a file that is not: the title block adds the standard files of every project
  const both = pj(7, "bothco", [ph("1", "Shown one", "shipped"), ph("2", "Shown two", "planned")], {
    roadmaps: [{ file: "a.md", tables: 1, standard: true, phases: [ph("1", "Shown one", "shipped"), ph("2", "Shown two", "planned")] }, { file: "b.md", tables: 1, standard: false, phases: oldPh }],
    summary: strictSummary({ roadmaps: 1, phasesTotal: 2, phasesShipped: 1, legacyFiles: 1, legacyNames: ["b.md"] }),
  });
  const other = pj(8, "otherco", [ph("1", "x", "shipped")]);
  const h6 = render([both, other]);
  assert.equal(cell(titleBlockOf(h6), "Roadmap"), "2 of 3");
  assert.ok(blockOf(h6, "bothco").includes("1 roadmap file not standardized: b.md (not drawn).") && !blockOf(h6, "otherco").includes("not standardized"));
  assert.ok(!h6.includes("Hidden one"));
  // the estimate titles come from standard rows only
  const est = pj(9, "estco", null, {
    roadmaps: [{ file: "a.md", tables: 1, standard: true, phases: [ph("1", "Standard title", "planned")] }, { file: "b.md", tables: 1, standard: false, phases: [ph("2", "Legacy title", "shipped", { actual: 3 })] }],
    history: [rec("1", 2, 1.5), rec("2", 2, 2.5)], summary: strictSummary({ roadmaps: 1, phasesTotal: 1, legacyFiles: 1, legacyNames: ["b.md"] }),
  });
  assert.deepEqual(estRows(render([est]), "estco"), [{ id: "1", title: "Standard title", est: "2.0 h", actual: "1.5 h" }, { id: "2", title: "", est: "2.0 h", actual: "2.5 h" }]);
}

test("strict: page: a missing field is not standard, more than 10 names, hostile names, not found, the title block and the estimate titles", () => {
  scenarioStrictPage(REAL);
});

test("strict: the big-page logic counts only what is drawn", () => {
  const legacyOf = (p, tag) => p.roadmaps.map((r) => ({ ...r, file: `${tag}-${r.file}`, standard: false }));
  // 600 standard rows (800 rows with the estimate part) and 600 more rows in files that are not standard
  const huge = fakeProject(1, "hugeco", 600);
  const hugeWith = { ...huge, roadmaps: [...huge.roadmaps, ...legacyOf(huge, "old")], summary: strictSummary({ roadmaps: 2, phasesTotal: 600, phasesShipped: 200, legacyFiles: 2, legacyNames: ["old-plan-0.md", "old-plan-1.md"] }) };
  const small = fakeProject(3, "smallco", 20);
  const busy = fakeProject(4, "busyco", 80);
  const html = renderPage(fakeData([hugeWith, small, busy], [fakeSession(busy, "b1")]), { now: NOW });
  const h = blockOf(html, "hugeco");
  assert.ok(h.includes(`${LEFT_OUT}: 800 rows`), "the rows of the files that are not standard are not counted");
  assert.ok(h.includes("2 roadmap files not standardized: old-plan-0.md, old-plan-1.md (not drawn)."), "the note stays when the tables are left out");
  assert.ok(bytesOf(html) <= 256 * KB);
  // files that are not standard add nothing to the size, so a project with only such files is never the one that is left out
  const legacyOnly = { ...fakeProject(5, "oldco", 0), roadmaps: legacyOf(fakeProject(5, "oldco", 600), "x"), summary: strictSummary({ legacyFiles: 2, legacyNames: ["x-plan-0.md", "x-plan-1.md"] }) };
  const quiet = renderPage(fakeData([legacyOnly, small]), { now: NOW });
  assert.ok(bytesOf(quiet) < 100 * KB && count(quiet, LEFT_OUT) === 0 && !quiet.includes("Phase 1 of oldco"));
  assert.ok(blockOf(quiet, "oldco").includes("No standardized roadmap yet."));
  // the same rows in standard files do need the rule
  const loud = renderPage(fakeData([fakeProject(5, "oldco", 600), fakeProject(6, "restco", 600)]), { now: NOW });
  assert.ok(count(loud, LEFT_OUT) >= 1);
});

test("strict: the rule is in the scripts: each change makes the scenarios fail", async () => {
  const cases = [
    ["a file counts as standard whatever its tables", [["collect.mjs", "read.tables.every((t) => t.legacy === false)", "true"]], scenarioStrictFiles],
    ["a file with no table counts as standard", [["collect.mjs", "read.tables.length > 0 && read.tables.every", "read.tables.every"]], scenarioStrictFiles],
    ["one marked table makes the file standard", [["collect.mjs", "read.tables.every((t) => t.legacy === false)", "read.tables.some((t) => t.legacy === false)"]], scenarioStrictFiles],
    ["the summary counts every file", [["collect.mjs", "const standard = item.roadmaps.filter((r) => r.standard === true);", "const standard = item.roadmaps;"]], scenarioStrictFiles],
    ["the names are not kept", [["collect.mjs", "legacyNames: legacy.slice(0, 10).map((r) => clean(r.file, 200)),", "legacyNames: [],"]], scenarioStrictFiles],
    ["the page draws every roadmap", [["page.mjs", "const roadmaps = entries.filter((r) => r.standard);", "const roadmaps = entries;"]], scenarioStrictFiles],
    ["a missing field counts as standard", [["page.mjs", "standard: r.standard === true,", "standard: r.standard !== false,"]], scenarioStrictPage],
    ["no note", [["page.mjs", "  if (n < 1) return \"\";", "  return \"\";"]], scenarioStrictFiles],
    ["the bar is drawn for a project with no standard file", [["page.mjs", "if (!p.roadmaps.length && p.legacy.count > 0) return \"\";", ""]], scenarioStrictFiles],
    ["no empty state", [["page.mjs", "if (!p.roadmaps.length && p.legacy.count > 0) body.push(", "if (false) body.push("]], scenarioStrictFiles],
    ["the executive row says nothing", [["page.mjs", "sm.legacy > 0 ?", "false ?"]], scenarioStrictFiles],
    ["the names are not cut at 10", [["page.mjs", "list(sum.legacyNames, MAX_LEGACY_NAMES)", "list(sum.legacyNames, 99)"], ["page.mjs", "const names = p.legacy.names.slice(0, 10).map(", "const names = p.legacy.names.map("]], scenarioStrictPage],
    ["the names are not escaped", [["page.mjs", "const names = p.legacy.names.slice(0, 10).map((x) => txt(x, 200));", "const names = p.legacy.names.slice(0, 10);"]], scenarioStrictPage],
  ];
  for (const [name, changes, scenario] of cases) {
    const mods = await mutantOf(changes);
    await assert.rejects(async () => { await scenario(mods); }, (e) => e?.code === "ERR_ASSERTION", `${name}: the scenario did not fail on an assertion`);
  }
});

// ── the hatch: one tile, one drift, one angle ───────────────────────────────
// Returns the problems found in the stylesheet and the page script: every hatched background has the same square tile, the
// drift of the background is one whole tile, the stripes of a gate drift by one whole period of their spacing, and the
// angle is the same wherever the hatch is drawn (the gradient in CSS and the strokes of a gate).
function hatchProblems(css, pageSrc) {
  const bad = [];
  const rules = cssRules(css);
  const tiles = new Set();
  for (const r of rules.filter((x) => x.body.includes("var(--hatch)"))) {
    const m = r.body.match(/background-size[:]\s*(\d+)px\s+(\d+)px/);
    if (!m) { bad.push(`no tile size on ${r.selector}`); continue; }
    if (m[1] !== m[2]) bad.push(`the tile of ${r.selector} is not square`);
    tiles.add(`${m[1]}x${m[2]}`);
  }
  if (tiles.size !== 1) bad.push(`the tiles differ or are missing: ${[...tiles].join(", ")}`);
  const tile = Number([...tiles][0]?.split("x")[0]);
  const drift = rules.filter((x) => x.stack.some((s) => /^@keyframes hatch-drift/.test(s)));
  // The hatch moves by transform only: a pseudo-element one tile wider on the left, shifted right by exactly one tile.
  const dm = drift.map((r) => r.body.match(/transform[:]\s*translateX\((\d+)px\)/)).filter(Boolean);
  if (dm.length !== 1 || Number(dm[0][1]) !== tile) bad.push(`the drift (${dm.map((m) => m[1]).join(",")}) is not the tile (${tile})`);
  if (rules.some((x) => /background-position/.test(x.body))) bad.push("background-position is used (a keyframe on it repaints on the main thread)");
  for (const r of rules.filter((x) => x.body.includes("var(--hatch)"))) {
    const left = r.body.match(/(?:^|;)left[:]\s*-(\d+)px/);
    if (!left || Number(left[1]) !== tile) bad.push(`the pseudo-element of ${r.selector} reaches ${left ? left[1] : "no"}px to the left, not one tile (${tile}): the loop would show a gap`);
    if (!/(?:^|;)position[:]\s*absolute/.test(r.body)) bad.push(`${r.selector} is not positioned inside its clipping parent`);
  }
  for (const sel of [".top-band", ".mk-h,.seg-p"]) {
    const r = rules.find((x) => x.stack.length === 0 && x.selector === sel);
    if (!r || !/(?:^|;)overflow[:]\s*hidden/.test(r.body)) bad.push(`the parent ${sel} does not clip (overflow:hidden)`);
  }
  const shift = rules.filter((x) => x.stack.some((s) => /^@keyframes hatch-shift/.test(s))).map((r) => r.body.match(/translateX\((\d+)px\)/)).filter(Boolean);
  const steps = [...pageSrc.matchAll(/hx \+= (\d+)/g)].map((m) => Number(m[1]));
  if (steps.length !== 1 || shift.length !== 1 || Number(shift[0][1]) !== steps[0]) bad.push(`the shift of a gate's stripes (${shift.map((m) => m[1]).join(",")}) is not their spacing (${steps.join(",")})`);
  const angles = new Set([...css.matchAll(/linear-gradient\((-?\d+(?:\.\d+)?)deg\s*,\s*var\(--prog\)/g)].map((m) => Number(m[1])));
  if (angles.size !== 1) bad.push(`the gradient angles differ or are missing: ${[...angles].join(", ")}`);
  const strokes = [...pageSrc.matchAll(/\}l(-?\d+) (-?\d+)`/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (strokes.length !== 1) bad.push(`the stroke of a gate's stripe is found ${strokes.length} times`);
  // The stripes of a gradient at A degrees run along (cos A, sin A) in screen coordinates (y down): they must be parallel to the stroke.
  for (const a of angles) for (const [dx, dy] of strokes) {
    const rad = (a * Math.PI) / 180;
    if (Math.abs(dx * Math.sin(rad) - dy * Math.cos(rad)) > 1e-6 * Math.hypot(dx, dy) + 1e-9) bad.push(`the stroke (${dx}, ${dy}) is not at the angle of the gradient (${a}deg)`);
  }
  return bad;
}

test("look: the hatch tile, the drift of the background and the drift of a gate's stripes are the same whole period, and the angle is the same wherever it is drawn", () => {
  const css = readFileSync(join(ASSETS, "page.css"), "utf8");
  const src = readFileSync(join(SKILL, "scripts", "page.mjs"), "utf8");
  assert.deepEqual(hatchProblems(css, src), []);
  // the checker sees each way the loop could jump or the angle could differ
  const mutate = (text, from, to) => { assert.ok(text.includes(from), from); return text.replace(from, to); };
  const mutants = [
    ["one tile is another size", mutate(css, "background-size:8px 8px", "background-size:9px 9px"), src],
    ["a tile is not square", mutate(css, "background-size:8px 8px", "background-size:8px 6px"), src],
    ["the drift is not the tile", mutate(css, "@keyframes hatch-drift{to{transform:translateX(8px)}}", "@keyframes hatch-drift{to{transform:translateX(6px)}}"), src],
    ["the drift goes back to background-position", mutate(css, "@keyframes hatch-drift{to{transform:translateX(8px)}}", "@keyframes hatch-drift{to{background-position:8px 0}}"), src],
    ["the pseudo-element does not reach one tile to the left", mutate(css, "left:-8px;right:0", "left:-6px;right:0"), src],
    ["a parent does not clip", mutate(css, ".top-band{position:absolute;left:0;right:0;bottom:0;height:10px;border-top:2px solid var(--prog);border-bottom:2px solid var(--prog);overflow:hidden}", ".top-band{position:absolute;left:0;right:0;bottom:0;height:10px;border-top:2px solid var(--prog);border-bottom:2px solid var(--prog)}"), src],
    ["the gate shift is not the spacing", mutate(css, "translateX(6px)", "translateX(5px)"), src],
    ["the spacing changed", css, mutate(src, "hx += 6", "hx += 7")],
    ["the gradient angle changed", mutate(css, "linear-gradient(135deg,var(--prog)", "linear-gradient(120deg,var(--prog)"), src],
    ["a second gradient at another angle", `${css}\n.x{background-image:linear-gradient(45deg,var(--prog) 25%,transparent 25%)}`, src],
    ["the stroke changed its angle", css, mutate(src, "l8 -8`", "l8 -6`")],
  ];
  for (const [name, c, s] of mutants) assert.ok(hatchProblems(c, s).length > 0, `${name}: not caught`);
});

// ── fix round 4: roadmap-keyed sessions, estimates, repository trust, notes, summary numbers, calm page ──
// Each scenario takes the three modules { page, collect, status } and runs against the real scripts and, in the last test of
// this section, against a temp copy with one change at a time (each change must make its scenario fail).
const s4 = (mods, argv, o = {}) => {
  const out = [];
  const err = [];
  const code = mods.status.main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), now: () => NOW, ...o });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const snap4 = (dir) => {
  if (!existsSync(dir)) return "(absent)";
  const out = [];
  const walk = (d, pre) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) { out.push(`${pre}${n}/`); walk(f, `${pre}${n}/`); } else out.push(`${pre}${n}:${readFileSync(f, "utf8")}`); } };
  walk(dir, "");
  return out.join("\n");
};
const samePlace = (a, b) => a.toLowerCase() === realpathSync.native(b).toLowerCase();

// 1. two roadmaps in one repository keep one session file each for the same phase id
async function scenarioTwoRoadmaps(mods) {
  const w = world("two-rm");
  const mono = w.proj("mono");
  mkdirSync(join(mono, ".git"));
  put(mono, `a/${RM}`, roadmap([rowE("1", "Alpha job", "in progress", "2h → 1.5h")]));
  put(mono, `b/${RM}`, roadmap([rowE("1", "Beta job", "in progress", "4h → 3h")]));
  const run = (argv, at = NOW) => s4(mods, argv, { homedir: w.base, now: () => at });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const A = join(mono, "a");
  const B = join(mono, "b");
  const set = (root, step, minAgo) => {
    const r = run(["set", "--data", w.data, "--root", root, "--phase", "1", "--step", step, "--state", "working"], NOW - minAgo * MIN);
    assert.equal(r.code, 0, r.err);
  };
  set(A, "build", 30);
  set(A, "compare", 20);
  set(A, "build", 10);
  set(B, "review", 2);
  const reg = readJson(w.data, "projects.json").projects;
  assert.equal(reg.length, 1);
  assert.deepEqual(reg[0].roadmaps, [`a/${RM}`, `b/${RM}`]);
  const id = reg[0].id;
  const nameA = sname(id, "1", `a/${RM}`);
  const nameB = sname(id, "1", `b/${RM}`);
  const sdir = join(w.data, "sessions");
  assert.deepEqual(listing(sdir), [nameA, nameB].sort(), "one file for each roadmap: no overwrite");
  const fa = readJson(w.data, `sessions/${nameA}`);
  const fb = readJson(w.data, `sessions/${nameB}`);
  assert.equal(fa.roadmap, `a/${RM}`);
  assert.equal(fb.roadmap, `b/${RM}`);
  assert.equal(fa.trail.length, 3, "a's own three changes");
  assert.equal(fb.trail, undefined, "b's first call: none of a's trail");
  assert.equal(fb.step, "review");
  const data = await collectFrom(mods, w);
  const sa = data.sessions.find((s) => s.roadmap === `a/${RM}`);
  const sb = data.sessions.find((s) => s.roadmap === `b/${RM}`);
  assert.deepEqual([sa.step, sa.estimateH, sa.loops.length], ["build", 1.5, 1], "a: its own state and estimate, and its loop");
  assert.deepEqual([sb.step, sb.estimateH, sb.loops.length], ["review", 3, 0], "b: its own state and estimate, and no loop that never happened");
  assert.deepEqual(data.warnings, [{ kind: "same project, more than one open session", project: id }], "two open sessions in one project still warn");
  const html = draw(mods, data);
  const rows = html.split('<details class="sess"').slice(1).map((r) => r.split("</details>")[0]);
  assert.equal(rows.length, 2);
  const ra = rows.find((r) => r.includes("Alpha job"));
  const rb = rows.find((r) => r.includes("Beta job"));
  assert.ok(ra && rb && !ra.includes("Beta job") && !rb.includes("Alpha job"), "each shows its own title");
  assert.ok(ra.includes('est <span class="fig">1.5 h</span>') && rb.includes('est <span class="fig">3.0 h</span>'), "and its own estimate");
  const ids = [...html.matchAll(/<details class="sess" id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, 2, "two rows, two different ids in the page");
  // clear of one removes only its own file
  const before = readFileSync(join(sdir, nameB), "utf8");
  assert.equal(run(["clear", "--data", w.data, "--root", A, "--phase", "1"]).code, 0);
  assert.deepEqual(listing(sdir), [nameB]);
  assert.equal(readFileSync(join(sdir, nameB), "utf8"), before, "b's file is untouched");
  // a again: a new file with no trail of b's
  set(A, "baseline", 1);
  assert.equal(readJson(w.data, `sessions/${nameA}`).trail, undefined);
  assert.equal(readJson(w.data, `sessions/${nameB}`).step, "review");
}

test("round 4, 1: two roadmaps in one repository keep their own session file, title, estimate and trail; clear removes only its own; the same-project warning still fires", async () => {
  await scenarioTwoRoadmaps(REAL);
});

// 1. older files, a roadmap the project does not list, the tag, the file name grammar
async function scenarioOldNames(mods) {
  const w = world("old-names");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("1", "One thing", "in progress", "2h → 1.5h")]));
  const run = (argv, at = NOW, o = {}) => s4(mods, argv, { homedir: w.base, now: () => at, ...o });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const id = run(["register", "--data", w.data, "--root", p]).out.match(/id ([0-9a-f]{12})/)[1];
  const sdir = join(w.data, "sessions");
  // an older file (<id>-<phase>.json, no roadmap field) is still read, and takes the first roadmap that has the phase id
  hand(w, id, "1", { step: "build", trail: [["build", "working", 30], ["compare", "working", 10]] });
  let d = await collectFrom(mods, w);
  assert.deepEqual(d.sessions.map((s) => [s.phase, s.roadmap, s.estimateH, s.step]), [["1", null, 1.5, "build"]]);
  assert.deepEqual(d.errors, []);
  // clear has no file of its own to remove (the older file is not its file): it says so and leaves the older one byte for byte
  const olderText = textOf(sdir, `${id}-1.json`);
  const cleared = run(["clear", "--data", w.data, "--root", p, "--phase", "1"]);
  assert.equal(cleared.code, 0, cleared.err);
  assert.ok(cleared.out.includes("no status file to clear"));
  assert.equal(textOf(sdir, `${id}-1.json`), olderText);
  // set writes its own file with nothing taken from the older one, and leaves the older one alone
  assert.equal(run(["set", "--data", w.data, "--root", p, "--phase", "1", "--step", "compare", "--state", "working"]).code, 0);
  assert.deepEqual(listing(sdir), [`${id}-1.json`, sname(id, "1")].sort());
  assert.equal(textOf(sdir, `${id}-1.json`), olderText);
  assert.equal(readJson(w.data, `sessions/${sname(id, "1")}`).trail, undefined, "no trail is inherited");
  rmSync(join(sdir, `${id}-1.json`));
  rmSync(join(sdir, sname(id, "1")));
  // the case of the path: the tag is of the lower-case path where the file system ignores letter case (io.caseInsensitive true),
  // of the path as written where it does not (false); the roadmap field keeps the case either way
  const repo = w.proj("repo");
  mkdirSync(join(repo, ".git"));
  put(repo, `Plans/${RM}`, roadmap([rowE("1", "Mixed", "planned")]));
  assert.notEqual(tagFor(`Plans/${RM}`, true), tagFor(`Plans/${RM}`, false), "the case of the path changes the hash");
  for (const folds of [true, false]) {
    assert.equal(run(["set", "--data", w.data, "--root", join(repo, "Plans"), "--phase", "1", "--step", "build", "--state", "working"], NOW, { caseInsensitive: folds }).code, 0);
    const rid = readJson(w.data, "projects.json").projects.at(-1).id;
    const want = sname(rid, "1", `Plans/${RM}`, folds);
    assert.deepEqual(listing(sdir).filter((f) => f.startsWith(rid)), [want], `caseInsensitive ${folds}`);
    assert.equal(readJson(w.data, `sessions/${want}`).roadmap, `Plans/${RM}`);
    rmSync(join(sdir, want));
  }
  // collect: a roadmap field that names a file the project does not list falls back to the first roadmap that has the phase id
  const mk = (name, extra) => put(w.data, `sessions/${name}`, JSON.stringify({ v: 1, project: id, phase: "1", phase_name: "", step: "build", state: "working", step_started: NOW - MIN, updated: NOW - MIN, ...extra }));
  const other = `elsewhere/${RM}`;
  mk(sname(id, "1", other), { roadmap: other });
  d = await collectFrom(mods, w);
  assert.deepEqual(d.sessions.map((s) => [s.roadmap, s.estimateH]), [[other, 1.5]]);
  assert.deepEqual(d.errors, []);
  rmSync(join(sdir, sname(id, "1", other)));
  // the tag follows the same rule when collect checks a name: with letter case ignored a name made from the lower-case path is
  // read and one made from the path as written is not; with letter case kept it is the other way round
  const mixed = `Docs/Sub/${RM}`;
  for (const folds of [true, false]) {
    const good = sname(id, "3", mixed, folds);
    const wrong = sname(id, "4", mixed, !folds);
    mk(good, { phase: "3", roadmap: mixed });
    mk(wrong, { phase: "4", roadmap: mixed });
    d = await collectFrom(mods, w, { caseInsensitive: folds });
    assert.deepEqual(d.sessions.map((s) => [s.phase, s.roadmap]), [["3", mixed]], `caseInsensitive ${folds}: the tag of the right form is read`);
    assert.deepEqual(d.errors, [{ file: wrong, reason: "its content does not match its file name" }], `caseInsensitive ${folds}: the other is reported by base name`);
    rmSync(join(sdir, good));
    rmSync(join(sdir, wrong));
  }
  // a name with a tag of another shape, a roadmap field that is not a usable path, or the form of an earlier build is skipped, by base name only
  const bad = [
    [`${id}-abc+5.json`, { phase: "5", roadmap: mixed }],
    [`${id}-ABCDEF+6.json`, { phase: "6", roadmap: mixed }],
    [`${id}-000000+7.json`, { phase: "7", roadmap: mixed }],
    [`${id}-${tagFor("../x.md")}+8.json`, { phase: "8", roadmap: "../x.md" }],
    [`${id}-123456+9.json`, { phase: "9", roadmap: 5 }],
    [`${id}-10.json`, { phase: "10", roadmap: "../x.md" }],
    [`${id}-11.json`, { phase: "11", roadmap: 5 }],
    [`${id}-${tagFor(mixed)}-12.json`, { phase: "12", roadmap: mixed }],
  ];
  for (const [name, extra] of bad) mk(name, extra);
  d = await collectFrom(mods, w);
  assert.deepEqual(d.errors.map((e) => e.file).sort(), bad.map(([n]) => n).sort(), "reported by base name, nothing else");
  assert.deepEqual(d.sessions.map((s) => s.phase).filter((x) => Number(x) >= 4), []);
  const text = JSON.stringify(d.errors);
  assert.ok(!text.includes("elsewhere") && !text.includes("Docs/Sub"), "the content of a bad file is not shown");
}

test("round 4, 1: older session files are still read and never touched by set or clear; an unlisted roadmap falls back; the tag follows the lower-case path; a wrong tag or shape is skipped", async () => {
  await scenarioOldNames(REAL);
});

// 2. a file that is not standard gives no title and no estimate
async function scenarioLegacyEstimate(mods) {
  const w = world("legacy-est");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("1", "Standard one", "planned", "2h → 1.5h")]));
  put(p, "old.md", legacyMd([rowE("7", "Legacy only title", "in progress", "5h → 4h"), rowE("1", "Legacy dup", "planned", "9h → 8h"), rowE("8", "Legacy eight", "planned", "6h → 5h")]));
  const run = (argv) => s4(mods, argv, { homedir: w.base });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const reg = run(["register", "--data", w.data, "--root", p, "--roadmap", "old.md"]);
  assert.equal(reg.code, 0, reg.err);
  const id = reg.out.match(/id ([0-9a-f]{12})/)[1];
  hand(w, id, "8", { step: "build" });
  hand(w, id, "1", { step: "build" });
  put(w.data, `sessions/${sname(id, "7", "old.md")}`, JSON.stringify({ v: 1, project: id, roadmap: "old.md", phase: "7", phase_name: "", step: "build", state: "working", step_started: NOW - MIN, updated: NOW - MIN }));
  const data = await collectFrom(mods, w);
  const est = (phase, roadmapField) => data.sessions.find((s) => s.phase === phase && s.roadmap === roadmapField)?.estimateH;
  assert.equal(est("8", null), null, "an older file for a phase only a legacy file has: no estimate");
  assert.equal(est("1", null), 1.5, "the standard row, not the legacy duplicate");
  assert.equal(est("7", "old.md"), null, "a session of a legacy file: no estimate");
  assert.equal(data.projects[0].summary.estimateActiveH, 1.5, "the estimate of the active sessions counts only the standard row");
  const html = draw(mods, data);
  assert.ok(!html.includes("Legacy only title") && !html.includes("Legacy dup") && !html.includes("Legacy eight"), "no title of a file that is not drawn");
  assert.equal(count(html, 'est <span class="fig">'), 1 + 1, "one est in a session row and one in the project row, both 1.5 h");
  assert.ok(!html.includes("4.0 h") && !html.includes("8.0 h") && !html.includes("9.5 h"));
}

test("round 4, 2: a file that is not standard gives no title and no estimate to a session, on the page or in the active estimate", async () => {
  await scenarioLegacyEstimate(REAL);
});

// 3. a .git that someone else owns is not trusted; the project root's own roadmap is not added when the climb found it
async function scenarioRepoTrust(mods) {
  const w = world("trust");
  const repo = w.proj("repo");
  mkdirSync(join(repo, ".git"));
  put(repo, RM, roadmap([rowE("1", "Root plan", "planned")]));
  put(repo, `docs/${RM}`, roadmap([rowE("2", "Docs plan", "planned")]));
  const docs = join(repo, "docs");
  const run = (argv, o = {}) => s4(mods, argv, { homedir: w.base, ...o });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const reg = () => readJson(w.data, "projects.json").projects;
  const setFrom = (root, o = {}) => run(["set", "--data", w.data, "--root", root, "--phase", "1", "--step", "build", "--state", "working"], o);
  const mine = { getuid: () => 1000, lstat: (p) => { lstatSync(p); return { uid: 1000 }; } };
  const theirs = { getuid: () => 1000, lstat: (p) => { lstatSync(p); return { uid: 4242 }; } };
  // the climb finds the repository; the roadmap of the folder is added, the root's own is not
  let r = setFrom(docs, mine);
  assert.equal(r.code, 0, r.err);
  assert.equal(reg().length, 1);
  assert.ok(samePlace(reg()[0].path, repo), "a .git owned by the current user is trusted");
  assert.deepEqual(reg()[0].roadmaps, [`docs/${RM}`], "the project root's own roadmap is not added when the climb found it");
  // a .git owned by someone else is not trusted: the climb stops and the folder itself is the project
  r = setFrom(docs, theirs);
  assert.equal(r.code, 0, r.err);
  assert.equal(reg().length, 2);
  assert.ok(samePlace(reg()[1].path, docs), "the foreign repository did not become the project");
  assert.deepEqual(reg()[1].roadmaps, [RM]);
  // the nearest .git decides: a foreign one stops the climb even when an own one is further up
  const outer = w.proj("outer");
  mkdirSync(join(outer, ".git"));
  mkdirSync(join(outer, "inner", ".git"), { recursive: true });
  mkdirSync(join(outer, "inner", "x"));
  const mixedOwners = { getuid: () => 1000, lstat: (p) => { lstatSync(p); return { uid: basename(dirname(p)) === "inner" ? 4242 : 1000 }; } };
  r = setFrom(join(outer, "inner", "x"), mixedOwners);
  assert.equal(r.code, 0, r.err);
  assert.ok(samePlace(reg().at(-1).path, join(outer, "inner", "x")), "stopped at the foreign .git: neither inner nor outer");
  // without the seams (the real system) everything here is ours on every platform, so the repository is found
  const count0 = reg().length;
  r = setFrom(docs);
  assert.equal(r.code, 0, r.err);
  assert.equal(reg().length, count0, "the same project as the first run");
}

test("round 4, 3: a .git owned by someone else is not trusted (through the user-id seams); the project root's own roadmap is not added by a climb", async () => {
  await scenarioRepoTrust(REAL);
});

// 5. a roadmap that was not added says why, in fixed words
const WHY_DEEP = "roadmap not listed: its folder is more than 5 folders below the project root";
const WHY_NAME = "roadmap not listed: a folder name has a character that is not allowed (letters, digits and . _ @ + ( ) - and space only)";
const WHY_FULL = "roadmap not listed: the project already lists 10 roadmaps";
async function scenarioNotAdded(mods) {
  const w = world("not-added");
  const repo = w.proj("repo");
  mkdirSync(join(repo, ".git"));
  const mk = (rel) => { const d = join(repo, ...rel.split("/")); mkdirSync(d, { recursive: true }); put(d, RM, roadmap([rowE("1", "x", "planned")])); return d; };
  const five = mk("a/b/c/d/e");
  const six = mk("a/b/c/d/e/f");
  const odd = mk("my&docs");
  const docs = mk("docs");
  const run = (argv) => s4(mods, argv, { homedir: w.base });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const setFrom = (root) => run(["set", "--data", w.data, "--root", root, "--phase", "1", "--step", "build", "--state", "working"]);
  const roadmaps = () => readJson(w.data, "projects.json").projects[0].roadmaps;
  const lines = (r) => r.out.split("\n");
  let r = setFrom(five);
  assert.deepEqual(lines(r), ["status set: phase 1 build working"], "five folders deep is listed, with no extra line");
  assert.deepEqual(roadmaps(), [`a/b/c/d/e/${RM}`]);
  r = setFrom(six);
  assert.deepEqual(lines(r), ["status set: phase 1 build working", WHY_DEEP]);
  assert.equal(roadmaps().length, 1);
  r = run(["register", "--data", w.data, "--root", six]);
  assert.equal(lines(r).length, 2);
  assert.ok(lines(r)[0].startsWith("already listed: repo"), r.out);
  assert.equal(lines(r)[1], WHY_DEEP);
  r = setFrom(odd);
  assert.deepEqual(lines(r), ["status set: phase 1 build working", WHY_NAME]);
  r = run(["register", "--data", w.data, "--root", odd]);
  assert.equal(lines(r)[1], WHY_NAME);
  // nine more fill the list to ten: still no line; the next one that would be added says why it was not
  const nine = Array.from({ length: 9 }, (_, i) => ["--roadmap", `n${i + 1}.md`]).flat();
  r = run(["register", "--data", w.data, "--root", repo, ...nine]);
  assert.equal(r.code, 0, r.err);
  assert.equal(lines(r).length, 1, "ten roadmaps fit");
  assert.equal(roadmaps().length, 10);
  r = setFrom(docs);
  assert.deepEqual(lines(r), ["status set: phase 1 build working", WHY_FULL]);
  r = run(["register", "--data", w.data, "--root", repo, "--roadmap", "n10.md"]);
  assert.deepEqual(lines(r).slice(1), [WHY_FULL]);
  assert.equal(roadmaps().length, 10);
  for (const text of [r.out, setFrom(six).out, setFrom(odd).out]) assert.ok(!text.includes(w.base) && !text.includes("my&docs") && !text.includes("a/b/c"), "never the path");
}

test("round 4, 5: a roadmap that is not added says why in one fixed line: too deep, a name with a character that is not allowed, a full list", async () => {
  await scenarioNotAdded(REAL);
});

// 6 and 8. never a folder inside .git, node_modules or .roadmap-backups; the roadmap file must be a real file; the data side refuses them too
async function scenarioNeverFolders(mods) {
  const w = world("never");
  const repo = w.proj("repo");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  for (const rel of ["node_modules/pkg", ".roadmap-backups/old", "Node_Modules/x"]) put(repo, `${rel}/${RM}`, roadmap([rowE("1", "Hidden", "planned")]));
  const run = (argv, o = {}) => s4(mods, argv, { homedir: w.base, ...o });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const before = snap4(w.data);
  for (const rel of [".git/hooks", "node_modules/pkg", ".roadmap-backups/old", "Node_Modules/x"]) {
    const root = join(repo, ...rel.split("/"));
    for (const argv of [["set", "--data", w.data, "--root", root, "--phase", "1", "--step", "build", "--state", "working"], ["register", "--data", w.data, "--root", root], ["clear", "--data", w.data, "--root", root, "--phase", "1"]]) {
      const r = run(argv);
      assert.equal(r.code, 1, `${argv[0]} in ${rel}: ${r.out}`);
      assert.ok(r.err.includes("inside a .git, node_modules or .roadmap-backups folder"), r.err);
      assert.equal(snap4(w.data), before, `${argv[0]} in ${rel} wrote nothing`);
    }
  }
  // the rule is about the path from the project root: with no repository the folder itself is the project, whatever its parents are called
  const alone = w.proj("alone");
  mkdirSync(join(alone, "node_modules", "pkg"), { recursive: true });
  assert.equal(run(["set", "--data", w.data, "--root", join(alone, "node_modules", "pkg"), "--phase", "1", "--step", "build", "--state", "working"]).code, 0);
  // an explicit --roadmap with such a folder in it is refused as a bad path
  const bare = snap4(w.data);
  const bad = run(["register", "--data", w.data, "--root", repo, "--roadmap", `node_modules/x/${RM}`]);
  assert.equal(bad.code, 2, bad.out);
  assert.equal(snap4(w.data), bare);
  // a PHASES.md that is a folder is not a roadmap
  put(repo, `docs/${RM}/inner.txt`, "x");
  const asDir = run(["register", "--data", w.data, "--root", join(repo, "docs")]);
  assert.equal(asDir.code, 0, asDir.err);
  assert.ok(!readJson(w.data, "projects.json").projects.some((q) => q.roadmaps.includes(`docs/${RM}`)), "a folder named like the roadmap is not listed");
  // the data side: a registry entry with such a folder in its roadmap path is not read, whatever is in the file
  const w2 = world("never-data");
  const p = w2.proj("zork");
  put(p, `node_modules/x/${RM}`, roadmap([rowE("1", "Should not be read", "planned")]));
  assert.equal(s4(mods, ["enable", "--data", w2.data]).code, 0);
  assert.equal(s4(mods, ["register", "--data", w2.data, "--root", p], { homedir: w2.base }).code, 0);
  const listed = readJson(w2.data, "projects.json");
  listed.projects[0].roadmaps = [`node_modules/x/${RM}`];
  writeFileSync(join(w2.data, "projects.json"), JSON.stringify(listed));
  const data = await collectFrom(mods, w2);
  assert.deepEqual(data.projects[0].roadmaps, []);
  assert.deepEqual(data.projects[0].errors, [{ file: RM, reason: "not a usable roadmap path" }]);
  assert.ok(!draw(mods, data).includes("Should not be read"));
}

test("round 4, 6 and 8: a --root inside .git, node_modules or .roadmap-backups is refused with nothing written; a folder named like the roadmap is not one; the data side refuses such a path", async () => {
  await scenarioNeverFolders(REAL);
});

test("round 4, 8: a PHASES.md that is a link is not listed as a roadmap (skipped where links cannot be made)", (t) => {
  const w = world("link-roadmap");
  const repo = w.proj("repo");
  mkdirSync(join(repo, ".git"));
  put(repo, "real.md", roadmap([rowE("1", "x", "planned")]));
  mkdirSync(join(repo, "docs"));
  try { symlinkSync(join(repo, "real.md"), join(repo, "docs", RM), "file"); } catch (e) { t.diagnostic(`no links here (${e.code}); the link case did not run`); return; }
  enable(w);
  const r = st(["register", "--data", w.data, "--root", join(repo, "docs")], { homedir: w.base });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readJson(w.data, "projects.json").projects[0].roadmaps, [], "a link is not a roadmap file");
});

// 7. the page does not trust the summary numbers, the written time or the sessions of projects that are not listed
function scenarioSummaryNumbers(mods) {
  const render = (projects, sessions = [], more = {}) => mods.page.renderPage({ ...fakeData(projects, sessions), ...more }, { now: NOW, fonts: false });
  const shipped = (n) => Array.from({ length: n }, (_, i) => ph(String(i + 1), `Done ${i + 1}`, "shipped"));
  // a negative total is not printed as "1 of 0": the page counts the rows it draws
  const neg = pj(1, "negco", shipped(1), { summary: strictSummary({ roadmaps: 1, phasesTotal: -5, phasesShipped: 1 }) });
  const html = render([neg]);
  assert.ok(blockOf(html, "negco").includes('<span class="fig">1 of 1</span>'), "recounted from the rows");
  assert.ok(!html.includes("1 of 0</span>") && !blockOf(html, "negco").includes(">-5<"));
  assert.equal(cell(titleBlockOf(html), "Roadmap"), "1 of 1");
  // every other form that is not a whole number of zero or more is recounted too, and shipped is never more than the total
  for (const bad of [-1, 2.5, "7", null, true, {}, [3]]) {
    const p = pj(1, "oddco", shipped(2), { summary: strictSummary({ roadmaps: bad, phasesTotal: bad, phasesShipped: bad }) });
    const b = blockOf(render([p]), "oddco");
    assert.ok(b.includes('<span class="fig">2 of 2</span>') && b.includes('data-h="Roadmaps"><span class="fig">1</span>'), `${JSON.stringify(bad)}: ${b.slice(0, 40)}`);
  }
  const more = pj(1, "moreco", shipped(2), { summary: strictSummary({ roadmaps: 1, phasesTotal: 2, phasesShipped: 9 }) });
  assert.ok(blockOf(render([more]), "moreco").includes('<span class="fig">2 of 2</span>'), "shipped is capped by the total");
  // the written time: an ISO text or an epoch in a range a four-digit year can show; anything else is unknown
  const written = (generatedAt) => cell(titleBlockOf(render([], [], { generatedAt })), "Written (UTC)");
  for (const bad of ["+275760-09-13T00:00:00.000Z", 8.64e15, 1e20, -1, "garbage", "", null, {}, [], true]) assert.equal(written(bad), "unknown", JSON.stringify(bad));
  assert.equal(cell(titleBlockOf(mods.page.renderPage({ ...fakeData([]), generatedAt: undefined }, { now: NOW, fonts: false })), "Written (UTC)"), "unknown", "missing");
  assert.equal(written(new Date(NOW).toISOString()), "2026-10-27 10:00:00");
  assert.equal(written(NOW), "2026-10-27 10:00:00");
  const leadOf = (h) => h.match(/<span data-text>([^<]*)<\/span>/)[1];
  // sessions of a project that is not listed are not counted in the title block, the summary line or the header
  const listed = pj(1, "listedco", [ph("1", "a", "planned")]);
  const ghost = pj(2, "ghostco", null);
  const mixed = render([listed], [fakeSession(ghost, "9", "working", 1), fakeSession(ghost, "8", "waiting", 1), fakeSession(listed, "1", "working", 1)]);
  assert.equal(cell(titleBlockOf(mixed), "Sessions"), "1 active, 0 waiting");
  assert.equal(leadOf(mixed), `1 working ${cp(0xb7)} 0 idle`);
  const onlyGhost = render([listed], [fakeSession(ghost, "9", "working", 1), { ...fakeSession(ghost, "8", "done", 9000), archived: true }]);
  assert.equal(cell(titleBlockOf(onlyGhost), "Sessions"), "0 active, 0 waiting");
  assert.equal(cell(titleBlockOf(onlyGhost), "Archived"), "0");
  assert.equal(leadOf(onlyGhost), `0 working ${cp(0xb7)} 0 idle`);
  assert.ok(onlyGhost.includes('<div class="sheet">'), "no header rule moves for a session nobody lists");
}

test("round 4, 7: the page recounts a summary number that is not a whole number, shows an unusable written time as unknown, and counts only sessions of listed projects", () => {
  scenarioSummaryNumbers(REAL);
});

// 4. a page with more than 25 moving things keeps only the header rule and the running gates moving
function scenarioCalm(mods) {
  const render = (n, working) => {
    const p = pj(1, "movco", Array.from({ length: n }, (_, i) => ph(String(i + 1), `P${i}`, "in progress")));
    return mods.page.renderPage(fakeData([p], working ? [fakeSession(p, "1", "working", 1)] : []), { now: NOW, fonts: false });
  };
  const sheet = (html) => html.match(/<div class="sheet[^"]*">/)[0];
  // the moving things: one mark per in-progress row, one segment in the project bar, and with a working session its gate and the header rule
  assert.equal(sheet(render(24, false)), '<div class="sheet">', "24 marks and one segment: 25, not over");
  assert.equal(sheet(render(25, false)), '<div class="sheet calm">', "26: over");
  assert.equal(sheet(render(22, true)), '<div class="sheet has-working">', "22 marks, a segment, a gate and the header rule: 25");
  assert.equal(sheet(render(23, true)), '<div class="sheet has-working calm">', "26");
  // the calm page still has the markup of what keeps moving: the header rule and the running gate
  const busy = render(40, true);
  assert.ok(busy.includes('<span class="top-band" aria-hidden="true"></span>') && busy.includes('class="hatch live"'));
}

test("round 4, 4: over 25 moving things the page carries the class calm (server side); the stylesheet stills only the marks and segments under it", () => {
  scenarioCalm(REAL);
  const css = cssOf(htmlOf([pj(1, "busyco", [ph("1", "One", "in progress")])]));
  const rules = cssRules(css);
  const calm = rules.filter((r) => r.selector.includes(".sheet.calm"));
  assert.deepEqual(calm.map((r) => r.selector), [".sheet.calm .mk-h::before,.sheet.calm .seg-p::before"], "only the marks and the project bar segments go still");
  assert.ok(calm[0].stack.includes(MEDIA_MOTION) && /animation:none/.test(calm[0].body));
  // the header rule and the running gates keep their rules: nothing under .calm names them
  const animated = rules.filter((r) => declarations(r.body).some(([p, v]) => p === "animation" && !/^none\b/.test(v)));
  assert.ok(animated.some((r) => r.selector === ".sheet.has-working .top-band::before") && animated.some((r) => r.selector === ".sess[data-state=working] .hatch.live"));
  // each hatch moves on a pseudo-element, which has transform and not background-position
  assert.ok(!css.includes("background-position"));
});

// ── each change to a script makes its scenario fail ─────────────────────────
test("round 4: the rules are in the scripts: each change makes its scenario fail", async () => {
  const cases = [
    ["status: the session file is not keyed by the roadmap", [["status.mjs", "const sessionName = (id, phase, tag, unlisted = false) => `${id}-${unlisted ? \"u\" : \"\"}${tag}+${phase.toLowerCase()}.json`;", "const sessionName = (id, phase, tag, unlisted = false) => `${id}-${phase.toLowerCase()}.json`;"]], scenarioTwoRoadmaps],
    ["collect: the estimate ignores the session's roadmap", [["collect.mjs", "const own = s.roadmap ? item.roadmaps.find(", "const own = false ? item.roadmaps.find("]], scenarioTwoRoadmaps],
    ["page: the title ignores the session's roadmap", [["page.mjs", "if (roadmap && p.files.some((f) => same(f, roadmap))) {", "if (false) {"]], scenarioTwoRoadmaps],
    ["page: the row id ignores the roadmap", [["page.mjs", "slug(\"s\", p.id, s.roadmap, s.phase.toLowerCase())", "slug(\"s\", p.id, s.phase.toLowerCase())"]], scenarioTwoRoadmaps],
    ["collect: the tag in the name is not checked", [["collect.mjs", "tagged && tagged[2] === \"\" && tagged[3] === roadmapTag(roadmap, io.caseInsensitive ?? CASE_INSENSITIVE) && tagged[4].toLowerCase()", "tagged && tagged[2] === \"\" && tagged[4].toLowerCase()"]], scenarioOldNames],
    ["collect: the tag is of the path as written", [["collect.mjs", "createHash(\"sha256\").update(caseInsensitive ? rel.toLowerCase() : rel)", "createHash(\"sha256\").update(rel)"]], scenarioOldNames],
    ["status: the tag is of the path as written", [["status.mjs", "createHash(\"sha256\").update(foldPath(roadmap, io))", "createHash(\"sha256\").update(roadmap)"]], scenarioOldNames],
    ["collect: an older file is not read", [["collect.mjs", ": plain?.[2].toLowerCase();", ": undefined;"]], scenarioOldNames],
    ["collect: a roadmap field that is not a usable path is read", [["collect.mjs", "if (!roadmap) { skip(name, \"not the expected shape\"); continue; }", ""]], scenarioOldNames],
    ["collect: the estimate takes a file that is not standard", [["collect.mjs", "item.roadmaps.filter((r) => r.standard === true).reduce(", "item.roadmaps.reduce("]], scenarioLegacyEstimate],
    ["collect: a session of a file that is not standard has its estimate", [["collect.mjs", "own.standard === true ? hoursIn(own, id) : null", "hoursIn(own, id)"]], scenarioLegacyEstimate],
    ["status: a .git owned by someone else is trusted", [["status.mjs", "if (found) return getuid && found.uid !== getuid() ? null : cur;", "if (found) return cur;"]], scenarioRepoTrust],
    ["status: the project root's own roadmap is added by a climb", [["status.mjs", "defaults: atRoot ? [DEFAULT_ROADMAP] : []", "defaults: [DEFAULT_ROADMAP]"]], scenarioRepoTrust],
    ["status: no line says why", [["status.mjs", "if (why) out(why);", ""]], scenarioNotAdded],
    ["status: a deep folder is said to have a bad name", [["status.mjs", "parts.length > MAX_ROADMAP_FOLDERS ? \"deep\" : \"name\"", "\"name\""]], scenarioNotAdded],
    ["status: a full list is not said", [["status.mjs", "const full = roadmaps.some(", "const full = false && roadmaps.some("]], scenarioNotAdded],
    ["status: a folder inside .git or node_modules is accepted", [["status.mjs", "if (parts.some((s) => NEVER_LISTED.has(s.toLowerCase()))) return { fail:", "if (false) return { fail:"]], scenarioNeverFolders],
    ["status: a folder named like the roadmap is listed", [["status.mjs", "if (st && st.isFile()) {", "if (st) {"]], scenarioNeverFolders],
    ["status: --roadmap accepts a never-listed folder", [["status.mjs", "|| NEVER_LISTED.has(p.toLowerCase()))) return null;", ")) return null;"]], scenarioNeverFolders],
    ["collect: a roadmap entry with a never-read folder is read", [["collect.mjs", "|| NEVER_READ.has(p.toLowerCase()))) return null;", ")) return null;"]], scenarioNeverFolders],
    ["page: a negative total is printed", [["page.mjs", "const total = Math.min(whole(sum.phasesTotal) ?? phases.length, phases.length);", "const total = Number.isInteger(sum.phasesTotal) ? count(sum.phasesTotal) : phases.length;"]], scenarioSummaryNumbers],
    ["page: shipped can be more than the total", [["page.mjs", "shipped: Math.min(total, whole(sum.phasesShipped) ?? drawn, drawn),", "shipped: Math.min(1e6, whole(sum.phasesShipped) ?? drawn),"]], scenarioSummaryNumbers],
    ["page: any finite written time is shown", [["page.mjs", "const known = Number.isFinite(generated) && generated >= GENERATED_MIN && generated <= GENERATED_MAX;", "const known = Number.isFinite(generated);"]], scenarioSummaryNumbers],
    ["page: sessions of projects that are not listed are counted", [["page.mjs", ".filter((s) => s && listed.has(s.project))", ".filter(Boolean)"]], scenarioSummaryNumbers],
    ["page: the page is never calm", [["page.mjs", "const calm = moving > MAX_MOVING;", "const calm = false;"]], scenarioCalm],
    ["page: the limit is 26", [["page.mjs", "const MAX_MOVING = 25;", "const MAX_MOVING = 26;"]], scenarioCalm],
  ];
  for (const [name, changes, scenario] of cases) {
    const mods = await mutantOf(changes);
    await assert.rejects(async () => { await scenario(mods); }, (e) => e?.code === "ERR_ASSERTION", `${name}: the scenario did not fail on an assertion`);
  }
});

// ── fix round 5: unlisted folders, an old registry, the session cap, the figures drawn, letter case ──
// A folder whose roadmap path is not usable (too deep, a character that is not allowed) is unlisted: its sessions get a tag
// of their own and the marker unlisted: true, and the older name <id>-<phase>.json is never written for a new session.
// Each scenario takes the three modules { page, collect, status } and runs against the real scripts and, in the last test of
// this section, against a temp copy with one change at a time (each change must make its scenario fail).
const MARKED = (id, phase, extra = {}) => ({ v: 1, project: id, phase, phase_name: "", step: "build", state: "working", step_started: NOW - MIN, updated: NOW - MIN, ...extra });
const textOf = (dir, name) => readFileSync(join(dir, name), "utf8");
const rowsOf = (html) => html.split('<details class="sess"').slice(1).map((r) => r.split("</details>")[0]);
const rowIds = (html) => [...html.matchAll(/<details class="sess" id="([^"]+)"/g)].map((m) => m[1]);

async function scenarioUnlisted(mods) {
  const w = world("unlisted");
  const repo = w.proj("mono");
  mkdirSync(join(repo, ".git"));
  put(repo, RM, roadmap([rowE("1", "Root job", "in progress", "2h → 1.5h")]));
  const deepRel = "a/b/c/d/e/f";
  const deep = join(repo, ...deepRel.split("/"));
  put(repo, `${deepRel}/${RM}`, roadmap([rowE("1", "Deep job", "in progress", "4h → 3h")]));
  const run = (argv, at = NOW) => s4(mods, argv, { homedir: w.base, now: () => at });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const set = (root, phase, step, minAgo, extra = []) => {
    const r = run(["set", "--data", w.data, "--root", root, "--phase", phase, "--step", step, "--state", "working", ...extra], NOW - minAgo * MIN);
    assert.equal(r.code, 0, r.err);
    return r;
  };
  const sdir = join(w.data, "sessions");
  // a deep set, then a root set for the same phase id: two sessions, nothing deleted, nothing inherited
  assert.equal(run(["register", "--data", w.data, "--root", repo]).code, 0);
  const first = set(deep, "1", "build", 30, ["--name", "Deep named"]);
  assert.ok(first.out.includes("roadmap not listed"), "the deep folder is said not to be listed");
  set(deep, "1", "compare", 20);
  set(repo, "1", "review", 5);
  const reg = readJson(w.data, "projects.json").projects;
  assert.equal(reg.length, 1);
  assert.deepEqual(reg[0].roadmaps, [RM]);
  const id = reg[0].id;
  const rootFile = sname(id, "1");
  const files = listing(sdir);
  assert.equal(files.length, 2, files.join(" "));
  assert.ok(!files.includes(`${id}-1.json`), "the older name is never written for a new session");
  assert.ok(files.includes(rootFile));
  const deepFile = files.find((f) => f !== rootFile);
  assert.ok(/^[0-9a-f]{12}-u[0-9a-f]{6}[+]1[.]json$/.test(deepFile), deepFile);
  const fd = readJson(w.data, `sessions/${deepFile}`);
  assert.deepEqual([fd.unlisted, fd.roadmap, fd.step, fd.phase_name, fd.trail?.length], [true, undefined, "compare", "Deep named", 2]);
  const fr = readJson(w.data, `sessions/${rootFile}`);
  assert.deepEqual([fr.roadmap, fr.unlisted, fr.step, fr.phase_name, fr.trail], [RM, undefined, "review", "", undefined], "the root session inherits nothing from the deep one");
  // clear removes only its own file, from either folder
  const deepText = textOf(sdir, deepFile);
  assert.equal(run(["clear", "--data", w.data, "--root", repo, "--phase", "1"]).code, 0);
  assert.deepEqual(listing(sdir), [deepFile]);
  assert.equal(textOf(sdir, deepFile), deepText, "the deep file is untouched");
  set(repo, "1", "build", 4);
  const rootText = textOf(sdir, rootFile);
  assert.equal(run(["clear", "--data", w.data, "--root", deep, "--phase", "1"]).code, 0);
  assert.deepEqual(listing(sdir), [rootFile]);
  assert.equal(textOf(sdir, rootFile), rootText, "the root file is untouched");
  // an older file of the project for another phase is neither taken over nor cleared by an unlisted folder
  hand(w, id, "5", { step: "ship", trail: [["build", "working", 50], ["ship", "working", 40]], extra: { phase_name: "Older one" } });
  const olderText = textOf(sdir, `${id}-5.json`);
  assert.ok(run(["clear", "--data", w.data, "--root", deep, "--phase", "5"]).out.includes("no status file to clear"));
  assert.ok(existsSync(join(sdir, `${id}-5.json`)), "clear from an unlisted folder leaves the older file");
  assert.equal(textOf(sdir, `${id}-5.json`), olderText);
  set(deep, "5", "build", 3);
  assert.ok(existsSync(join(sdir, `${id}-5.json`)), "set from an unlisted folder leaves the older file");
  assert.equal(textOf(sdir, `${id}-5.json`), olderText);
  const five = listing(sdir).filter((f) => f.includes("+5."));
  assert.equal(five.length, 1);
  assert.deepEqual([readJson(w.data, `sessions/${five[0]}`).phase_name, readJson(w.data, `sessions/${five[0]}`).trail], ["", undefined], "nothing inherited from the older file");
  rmSync(join(sdir, `${id}-5.json`));
  rmSync(join(sdir, five[0]));
  // two other unusable folders (too deep, and a name with a character that is not allowed) do not share a file with it or each other
  set(deep, "1", "build", 3);
  const deep2 = join(repo, "x", "b", "c", "d", "e", "f");
  mkdirSync(deep2, { recursive: true });
  const weird = join(repo, "we!rd");
  mkdirSync(weird);
  set(deep2, "1", "build", 2);
  set(weird, "1", "build", 1);
  const all = listing(sdir);
  assert.equal(all.length, 4, all.join(" "));
  assert.ok(!all.includes(`${id}-1.json`));
  assert.equal(new Set(all).size, 4);
  // collect: the unlisted sessions have no listed roadmap, no estimate and no title; the rows have their own ids
  const data = await collectFrom(mods, w);
  assert.deepEqual(data.errors, []);
  assert.deepEqual(data.projects[0].roadmaps.map((r) => r.file), [RM], "no roadmap row for an unlisted folder");
  const unlisted = data.sessions.filter((s) => s.roadmap !== RM);
  assert.equal(unlisted.length, 3);
  assert.ok(unlisted.every((s) => s.roadmap.startsWith("(unlisted:") && s.estimateH === null), "no estimate, though the project's roadmap has a row with the same id");
  assert.equal(new Set(unlisted.map((s) => s.roadmap)).size, 3, "three folders, three tags");
  assert.equal(data.sessions.find((s) => s.roadmap === RM).estimateH, 1.5);
  const html = draw(mods, data);
  const rows = rowsOf(html);
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((r) => r.includes("Root job")).length, 1, "only the root session shows the root row's title");
  assert.ok(!rows.some((r) => r.includes("Deep job")));
  assert.equal(new Set(rowIds(html)).size, 4);
  // the marker and the u in the name go together: an unlisted name needs the marker and no roadmap field, any other name needs neither
  for (const f of listing(sdir)) rmSync(join(sdir, f));
  const good = `${id}-uabcdef+9.json`;
  const shape = [
    [`${id}-9.json`, MARKED(id, "9", { unlisted: true })],
    [sname(id, "8"), MARKED(id, "8", { unlisted: true, roadmap: RM })],
    [`${id}-abcdef+7.json`, MARKED(id, "7", { unlisted: false })],
    [`${id}-abcdef+5.json`, MARKED(id, "5", { unlisted: true })],
    [`${id}-uabcdef+3.json`, MARKED(id, "3", { unlisted: false })],
  ];
  put(w.data, `sessions/${good}`, JSON.stringify(MARKED(id, "9", { unlisted: true })));
  for (const [name, content] of shape) put(w.data, `sessions/${name}`, JSON.stringify(content));
  put(w.data, `sessions/${id}-abcdef+6.json`, JSON.stringify(MARKED(id, "6")));
  put(w.data, `sessions/${id}-uabcdef+4.json`, JSON.stringify(MARKED(id, "4", { roadmap: RM })));
  const marks = await collectFrom(mods, w);
  assert.deepEqual(marks.sessions.map((s) => s.phase), ["9"], "only the u name with the marker is read");
  assert.deepEqual(marks.errors.map((e) => [e.file, e.reason]).sort(), [
    [`${id}-9.json`, "not the expected shape"],
    [sname(id, "8"), "not the expected shape"],
    [`${id}-abcdef+7.json`, "not the expected shape"],
    [`${id}-abcdef+5.json`, "not the expected shape"],
    [`${id}-uabcdef+3.json`, "not the expected shape"],
    [`${id}-abcdef+6.json`, "its content does not match its file name"],
    [`${id}-uabcdef+4.json`, "its content does not match its file name"],
  ].sort());
}

test("round 5, 1: a folder with no usable roadmap path keeps its own session file, marker and tag: no deletion, no inheritance, clear removes only its own, no estimate or title", async () => {
  await scenarioUnlisted(REAL);
});

// 1. an unlisted name has a u in it, so no tag, whatever it is, makes it the name of a listed roadmap's file; a phase id that
// looks like a tag plus a phase cannot make one name read as another
async function scenarioAlias(mods) {
  const w = world("alias");
  const repo = w.proj("mono");
  mkdirSync(join(repo, ".git"));
  put(repo, RM, roadmap([rowE("1", "Root job", "in progress")]));
  const deepRel = "a/b/c/d/e/f";
  const deep = join(repo, ...deepRel.split("/"));
  mkdirSync(deep, { recursive: true });
  const run = (argv, at = NOW) => s4(mods, argv, { homedir: w.base, now: () => at });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const set = (root, phase, step, minAgo) => {
    const r = run(["set", "--data", w.data, "--root", root, "--phase", phase, "--step", step, "--state", "working"], NOW - minAgo * MIN);
    assert.equal(r.code, 0, r.err);
  };
  const sdir = join(w.data, "sessions");
  const aliasPhase = `${tagFor(RM)}-1`;
  set(repo, "1", "build", 30);
  const id = readJson(w.data, "projects.json").projects[0].id;
  const rootFile = sname(id, "1");
  assert.ok(existsSync(join(sdir, rootFile)), "the root session file is there");
  const rootText = textOf(sdir, rootFile);
  // a deep folder's phase named like the root roadmap's tag and phase 1 does not land on the root's file; its own name has the u
  set(deep, aliasPhase, "compare", 20);
  assert.equal(listing(sdir).length, 2);
  assert.equal(textOf(sdir, rootFile), rootText, "the root file is untouched");
  const deepFile = listing(sdir).find((f) => f !== rootFile);
  assert.ok(new RegExp(`^${id}-u[0-9a-f]{6}[+]${aliasPhase}[.]json$`).test(deepFile), deepFile);
  assert.ok(!listing(sdir).includes(`${id}-${aliasPhase}.json`), "the older name is not written");
  // an unlisted file whose tag is the root roadmap's tag (what a folder whose hash collided would write) has another name:
  // the root's set neither reads nor overwrites it, and it inherits nothing
  const clash = `${id}-u${tagFor(RM)}+1.json`;
  put(w.data, `sessions/${clash}`, JSON.stringify(MARKED(id, "1", { unlisted: true, phase_name: "Clash", step: "ship", step_started: NOW - 50 * MIN, updated: NOW - 40 * MIN })));
  const clashText = textOf(sdir, clash);
  set(repo, "1", "compare", 10);
  assert.equal(textOf(sdir, clash), clashText, "the clashing file is untouched");
  const fr = readJson(w.data, `sessions/${rootFile}`);
  assert.deepEqual(fr.trail, [{ step: "build", state: "working", at: NOW - 30 * MIN }, { step: "compare", state: "working", at: NOW - 10 * MIN }]);
  assert.equal(fr.phase_name, "");
  assert.equal(run(["clear", "--data", w.data, "--root", repo, "--phase", "1"]).code, 0);
  assert.equal(textOf(sdir, clash), clashText, "clear removes only the root's own file");
  assert.ok(!existsSync(join(sdir, rootFile)));
  set(repo, "1", "build", 9);
  // an older-form file of the alias phase name sits where a dash-joined name would: the root's set does not read or remove it
  hand(w, id, aliasPhase, { step: "ship", startedAgo: 120, updatedAgo: 100, trail: [["build", "working", 120], ["ship", "working", 100]], extra: { phase_name: "Older one" } });
  const olderFile = `${id}-${aliasPhase}.json`;
  const olderText = textOf(sdir, olderFile);
  set(repo, "1", "compare", 8);
  assert.equal(textOf(sdir, olderFile), olderText, "the older file is untouched");
  // names with the u and content that does not agree with it are skipped and reported by base name
  const t = tagFor(RM);
  const mixes = [
    [`${id}-${t}+3.json`, MARKED(id, "3", { unlisted: true }), "not the expected shape"],
    [`${id}-u${t}+4.json`, MARKED(id, "4", { roadmap: RM }), "its content does not match its file name"],
    [`${id}-u${t}+5.json`, MARKED(id, "5"), "its content does not match its file name"],
    [`${id}-u${t}+6.json`, MARKED(id, "6", { roadmap: RM, unlisted: true }), "not the expected shape"],
  ];
  for (const [name, content] of mixes) put(w.data, `sessions/${name}`, JSON.stringify(content));
  // collect: the root's, the clashing unlisted one (its own label), the deep folder's, and the older file of the alias phase, which is
  // older than the deep folder's file of the same phase and so is not shown twice
  const data = await collectFrom(mods, w);
  assert.deepEqual(data.errors.map((e) => [e.file, e.reason]).sort(), mixes.map(([n, , r]) => [n, r]).sort());
  assert.equal(data.sessions.length, 3);
  assert.deepEqual(data.sessions.map((s) => [s.phase, s.roadmap?.startsWith("(unlisted:") ? "unlisted" : s.roadmap]).sort(), [["1", "unlisted"], ["1", RM], [aliasPhase, "unlisted"]].sort());
  assert.ok(data.sessions.some((s) => s.roadmap === `(unlisted:${t})` && s.phase === "1"), "the clashing file keeps its own label");
  assert.equal(data.sessions.filter((s) => s.roadmap === null).length, 0, "the older file is hidden by the newer one of its phase");
}

test("round 5, 1: an unlisted name has a u in it, so no tag can make it a listed roadmap's file; a phase named like a tag and a phase cannot alias another session's name", async () => {
  await scenarioAlias(REAL);
});

// 7. set and clear never read, write, take over or remove an older file, from any folder of the project
async function scenarioOldUntouched(mods) {
  const w = world("untouched");
  const repo = w.proj("mono");
  mkdirSync(join(repo, ".git"));
  put(repo, RM, roadmap([rowE("1", "One", "planned")]));
  put(repo, `a/${RM}`, roadmap([rowE("1", "Alpha", "planned")]));
  mkdirSync(join(repo, "src"));
  const deepRel = "a/b/c/d/e/f";
  mkdirSync(join(repo, ...deepRel.split("/")), { recursive: true });
  const run = (argv, at = NOW) => s4(mods, argv, { homedir: w.base, now: () => at });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const id = run(["register", "--data", w.data, "--root", repo]).out.match(/id ([0-9a-f]{12})/)[1];
  const sdir = join(w.data, "sessions");
  // four older-form files: a plain one, one with a roadmap field, another project's, one with the unlisted marker
  const kinds = [
    ["1", {}],
    ["2", { roadmap: `docs/${RM}` }],
    ["3", { project: "0123456789ab" }],
    ["4", { unlisted: true }],
  ];
  for (const [phase, extra] of kinds) hand(w, id, phase, { step: "build", trail: [["build", "working", 30], ["compare", "working", 20]], extra: { phase_name: "Inherited", ...extra } });
  const olders = Object.fromEntries(kinds.map(([phase]) => [phase, textOf(sdir, `${id}-${phase}.json`)]));
  const intact = (what) => { for (const [phase] of kinds) { assert.ok(existsSync(join(sdir, `${id}-${phase}.json`)), `${what}: the older file of phase ${phase} is still there`); assert.equal(textOf(sdir, `${id}-${phase}.json`), olders[phase], `${what}: the older file of phase ${phase} is there, byte for byte`); } };
  // the project root, a folder that is not listed (it has no roadmap file), a listed sub-roadmap, and a folder too deep to be listed
  const places = [["the project root", repo], ["an unlisted folder", join(repo, "src")], ["a listed sub-roadmap", join(repo, "a")], ["a folder too deep to list", join(repo, ...deepRel.split("/"))]];
  for (const [where, root] of places) {
    for (const [phase] of kinds) {
      const before = listing(sdir);
      const none = run(["clear", "--data", w.data, "--root", root, "--phase", phase]);
      assert.equal(none.code, 0, none.err);
      assert.ok(none.out.includes("no status file to clear"), `${where}, phase ${phase}: nothing of its own to clear`);
      assert.deepEqual(listing(sdir), before);
      intact(`${where} clear`);
      const made = run(["set", "--data", w.data, "--root", root, "--phase", phase, "--step", "review", "--state", "working"]);
      assert.equal(made.code, 0, made.err);
      const added = listing(sdir).filter((f) => !before.includes(f));
      assert.equal(added.length, 1, `${where}, phase ${phase}: one file of its own`);
      const mine = readJson(w.data, `sessions/${added[0]}`);
      assert.deepEqual([mine.phase_name, mine.trail], ["", undefined], `${where}, phase ${phase}: nothing is inherited`);
      intact(`${where} set`);
      assert.equal(run(["clear", "--data", w.data, "--root", root, "--phase", phase]).code, 0);
      assert.deepEqual(listing(sdir), before, `${where}, phase ${phase}: clear removed only its own file`);
      intact(`${where} clear again`);
    }
  }
  // collect still reads the older file that is as it should be, and reports the three that are not by base name
  const data = await collectFrom(mods, w);
  assert.deepEqual(data.sessions.map((s) => [s.phase, s.roadmap]), [["1", null]]);
  assert.deepEqual(data.errors.map((e) => e.file).sort(), [`${id}-2.json`, `${id}-3.json`, `${id}-4.json`].sort());
}

test("round 5, 7: set and clear never read, write, take over or remove an older file, from the root, an unlisted folder, a listed sub-roadmap or a folder too deep to list", async () => {
  await scenarioOldUntouched(REAL);
});

// 7b. the older file and the new one of one phase are one phase: the newer is shown, the other is dropped without a word
async function scenarioOldNewest(mods) {
  const w = world("old-newest");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("1", "One", "planned", "2h → 1.5h")]));
  const run = (argv, at = NOW) => s4(mods, argv, { homedir: w.base, now: () => at });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const id = run(["register", "--data", w.data, "--root", p]).out.match(/id ([0-9a-f]{12})/)[1];
  const sdir = join(w.data, "sessions");
  const A = `a/${RM}`;
  // 1. an older file from 10 minutes ago, then a real set from the project root: only the new file shows (and no second open session)
  hand(w, id, "1", { step: "build", startedAgo: 20, updatedAgo: 10 });
  assert.equal(run(["set", "--data", w.data, "--root", p, "--phase", "1", "--step", "compare", "--state", "working"]).code, 0);
  assert.equal(listing(sdir).length, 2, "both files are there");
  let d = await collectFrom(mods, w);
  assert.deepEqual(d.sessions.map((s) => [s.phase, s.roadmap, s.step]), [["1", RM, "compare"]]);
  assert.deepEqual(d.warnings, [], "no false same-project warning");
  assert.deepEqual(d.errors, []);
  for (const f of listing(sdir)) rmSync(join(sdir, f));
  // 2..7 in one collect: each phase has its own pair of files
  hand(w, id, "2", { step: "build", startedAgo: 20, updatedAgo: 1 });                 // the older file is the newer one: it is shown
  hand(w, id, "2", { step: "build", startedAgo: 20, updatedAgo: 10, named: true });
  hand(w, id, "7D", { step: "build", startedAgo: 30, updatedAgo: 20 });               // the phase is compared without regard to letter case
  hand(w, id, "7d", { step: "review", startedAgo: 30, updatedAgo: 5, named: true });
  hand(w, id, "8", { step: "build", updatedAgo: 3 });                                   // different phases: both are shown
  hand(w, id, "9", { step: "build", updatedAgo: 3, named: true });
  hand(w, id, "10", { step: "build", startedAgo: 20, updatedAgo: 3 });                  // a tie goes to the tagged file
  hand(w, id, "10", { step: "review", startedAgo: 20, updatedAgo: 3, named: true });
  hand(w, id, "11", { step: "build", startedAgo: 1e6, updatedAgo: -1e6 });              // a clock-skewed older file counts as the oldest
  hand(w, id, "11", { step: "review", startedAgo: 20, updatedAgo: 2, named: true });
  hand(w, id, "12", { step: "build", startedAgo: 20, updatedAgo: 10 });                 // a newer file of another roadmap of the project also hides it
  hand(w, id, "12", { step: "review", startedAgo: 20, updatedAgo: 2, named: A });
  d = await collectFrom(mods, w);
  const got = Object.fromEntries(d.sessions.map((s) => [s.phase, `${s.roadmap}:${s.step}`]));
  assert.deepEqual(got, { "2": "null:build", "7d": `${RM}:review`, "8": "null:build", "9": `${RM}:build`, "10": `${RM}:review`, "11": `${RM}:review`, "12": `${A}:review` });
  assert.equal(d.sessions.length, 7, "one session for each phase that has a pair, two for none");
  assert.deepEqual(d.errors, [], "nothing is reported: the dropped file is dropped without a word");
}

test("round 5, 7: when an older file and a tagged file exist for one project and phase, only the newer is shown (the phase compared without regard to case), and nothing is reported", async () => {
  await scenarioOldNewest(REAL);
});

// 2. a projects.json from an earlier version keeps working
async function scenarioOldRegistry(mods) {
  const w = world("old-registry");
  const p = w.proj("zork");
  const q = w.proj("acmecorp");
  put(p, RM, roadmap([rowE("1", "One", "planned")]));
  put(q, RM, roadmap([rowE("1", "Two", "planned")]));
  const run = (argv) => s4(mods, argv, { homedir: w.base });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const idP = run(["register", "--data", w.data, "--root", p]).out.match(/id ([0-9a-f]{12})/)[1];
  const idQ = run(["register", "--data", w.data, "--root", q, "--roadmap", "docs/extra.md"]).out.match(/id ([0-9a-f]{12})/)[1];
  const file = join(w.data, "projects.json");
  const stored = readJson(w.data, "projects.json");
  stored.projects[0].roadmaps = [RM, `.roadmap-backups/${RM}`, "node_modules/x/plan.md"];
  const seed = JSON.stringify(stored);
  writeFileSync(file, seed);
  const unchanged = () => assert.equal(readFileSync(file, "utf8"), seed, "the file is not rewritten");
  // read-only and no-change commands work and leave the file as it is
  const listed = run(["list", "--data", w.data]);
  assert.equal(listed.code, 0, listed.err);
  assert.ok(listed.out.includes(`${idP}  zork`) && listed.out.includes(`${idQ}  acmecorp`));
  assert.ok(listed.out.includes(`roadmaps: ${RM}  added`) && !listed.out.includes(".roadmap-backups") && !listed.out.includes("node_modules"), "the unusable ones are not shown");
  assert.ok(listed.out.includes(`roadmaps: ${RM}, docs/extra.md`), "the other project keeps its roadmaps");
  unchanged();
  assert.equal(run(["set", "--data", w.data, "--root", q, "--phase", "1", "--step", "build", "--state", "working"]).code, 0);
  unchanged();
  const again = run(["register", "--data", w.data, "--root", p]);
  assert.equal(again.code, 0, again.err);
  assert.ok(again.out.startsWith("already listed"));
  unchanged();
  // a command that writes the list writes it cleaned, with every other entry kept
  const added = run(["register", "--data", w.data, "--root", q, "--roadmap", "docs/more.md"]);
  assert.equal(added.code, 0, added.err);
  const now = readJson(w.data, "projects.json").projects;
  assert.deepEqual(now.map((x) => [x.id, x.roadmaps]), [[idP, [RM]], [idQ, [RM, "docs/extra.md", "docs/more.md"]]]);
  // unregister repairs it
  writeFileSync(file, seed);
  const gone = run(["unregister", "--data", w.data, idP]);
  assert.equal(gone.code, 0, gone.err);
  assert.deepEqual(readJson(w.data, "projects.json").projects.map((x) => [x.id, x.roadmaps]), [[idQ, [RM, "docs/extra.md"]]]);
  // collect stays lenient: it reads the project and says once for each such entry that the path is not usable
  writeFileSync(file, seed);
  const data = await collectFrom(mods, w);
  assert.equal(data.projects.length, 2);
  assert.deepEqual(data.projects[0].errors.filter((e) => e.reason === "not a usable roadmap path").map((e) => e.file).sort(), [RM, "plan.md"].sort());
  assert.deepEqual(data.projects[0].roadmaps.map((r) => r.file), [RM]);
  // a roadmap that is not even text is still a file that is not as expected: every command stops and nothing is written
  stored.projects[0].roadmaps = [5];
  const hostile = JSON.stringify(stored);
  writeFileSync(file, hostile);
  for (const argv of [["list", "--data", w.data], ["register", "--data", w.data, "--root", p], ["unregister", "--data", w.data, idQ], ["set", "--data", w.data, "--root", p, "--phase", "2", "--step", "build", "--state", "working"]]) {
    const r = run(argv);
    assert.equal(r.code, 1, argv[0]);
    assert.ok(r.err.includes("not as expected"), r.err);
  }
  assert.equal(readFileSync(file, "utf8"), hostile);
}

test("round 5, 2: a projects.json from an earlier version, with roadmaps that are not usable paths, still works for set, list, register and unregister", async () => {
  await scenarioOldRegistry(REAL);
});

// 3. the cap of 100 sessions counts only listed projects' sessions and keeps the newest
async function scenarioCap(mods) {
  const pad = (i) => String(i).padStart(3, "0");
  // 250 files of a project that is not listed, sorted before the listed project's, and 3 live sessions of a listed one
  const a = world("cap-a");
  const pa = a.proj("zork");
  assert.equal(s4(mods, ["enable", "--data", a.data]).code, 0);
  const ida = s4(mods, ["register", "--data", a.data, "--root", pa], { homedir: a.base }).out.match(/id ([0-9a-f]{12})/)[1];
  mkdirSync(join(a.data, "sessions"), { recursive: true });
  for (let i = 0; i < 250; i++) writeFileSync(join(a.data, "sessions", `000000000000-g${pad(i)}.json`), "{}");
  for (const k of [1, 2, 3]) hand(a, ida, `l${k}`, { step: "build" });
  const da = await collectFrom(mods, a);
  assert.deepEqual(da.sessions.map((s) => s.phase).sort(), ["l1", "l2", "l3"], "the listed project's sessions survive");
  assert.deepEqual(da.errors, [], "files of a project that is not listed leave no trace");
  // 250 sessions of a listed project: the 100 newest survive (the newest are the last names here) and the drop is reported once
  const b = world("cap-b");
  const pb = b.proj("zork");
  assert.equal(s4(mods, ["enable", "--data", b.data]).code, 0);
  const idb = s4(mods, ["register", "--data", b.data, "--root", pb], { homedir: b.base }).out.match(/id ([0-9a-f]{12})/)[1];
  mkdirSync(join(b.data, "sessions"), { recursive: true });
  for (let i = 0; i < 250; i++) {
    const at = NOW - (249 - i) * 1000 - 1000;
    writeFileSync(join(b.data, "sessions", `${idb}-s${pad(i)}.json`), JSON.stringify(MARKED(idb, `s${pad(i)}`, { step_started: at, updated: at })));
  }
  const db = await collectFrom(mods, b);
  assert.equal(db.sessions.length, 100);
  assert.deepEqual(db.sessions.map((s) => s.phase).sort(), Array.from({ length: 100 }, (_, i) => `s${pad(i + 150)}`), "the newest by their updated time, not by name");
  assert.deepEqual(db.errors, [{ file: "sessions", reason: "150 session(s) left out: more than 100 live sessions, the newest were kept" }], "reported once, with no file name");
  assert.equal(db.notes, undefined, "all 250 files were opened: no note about unopened files");
}

test("round 5, 3: files of projects that are not listed do not count toward the 100-session cap, and past it the newest are kept and the drop is reported once", async () => {
  await scenarioCap(REAL);
});

// 3b. a session whose time is far in the future never wins the cap, whatever its time; the cap sorts by updated, not by step_started
async function scenarioSkewCap(mods) {
  const w = world("skew-cap");
  const p = w.proj("zork");
  assert.equal(s4(mods, ["enable", "--data", w.data]).code, 0);
  const id = s4(mods, ["register", "--data", w.data, "--root", p], { homedir: w.base }).out.match(/id ([0-9a-f]{12})/)[1];
  mkdirSync(join(w.data, "sessions"), { recursive: true });
  const put1 = (phase, at, started = at) => writeFileSync(join(w.data, "sessions", `${id}-${phase}.json`), JSON.stringify(MARKED(id, phase, { step_started: started, updated: at })));
  // 200 sessions from a skewed clock (the newest time a file may hold, and just below it) and 3 live ones
  for (let i = 0; i < 200; i++) put1(`k${String(i).padStart(3, "0")}`, 8.64e15 - i, 8.64e15 - i - 1);
  for (const k of [1, 2, 3]) put1(`l${k}`, NOW - k * MIN);
  const d = await collectFrom(mods, w);
  assert.equal(d.sessions.length, 100);
  assert.deepEqual(d.sessions.filter((s) => s.phase.startsWith("l")).map((s) => s.phase).sort(), ["l1", "l2", "l3"], "the live sessions are kept");
  assert.equal(d.sessions.filter((s) => s.phase.startsWith("k")).length, 97, "the skewed ones fill what is left");
  assert.ok(d.sessions.filter((s) => s.phase.startsWith("k")).every((s) => s.shown === "Idle" && s.noUpdate === true), "and are shown as Idle");
  assert.deepEqual(d.errors, [{ file: "sessions", reason: "103 session(s) left out: more than 100 live sessions, the newest were kept" }]);
  assert.deepEqual(d.warnings.map((x) => x.kind).sort(), ["clock skew", "same project, more than one open session"]);
}

test("round 6, 3: 200 clock-skewed sessions do not push the live ones out of the cap", async () => {
  await scenarioSkewCap(REAL);
});

async function scenarioCapKey(mods) {
  const w = world("cap-key");
  const p = w.proj("zork");
  assert.equal(s4(mods, ["enable", "--data", w.data]).code, 0);
  const id = s4(mods, ["register", "--data", w.data, "--root", p], { homedir: w.base }).out.match(/id ([0-9a-f]{12})/)[1];
  mkdirSync(join(w.data, "sessions"), { recursive: true });
  const put1 = (phase, updatedAgoS, startedAgoS) => writeFileSync(join(w.data, "sessions", `${id}-${phase}.json`), JSON.stringify(MARKED(id, phase, { step_started: NOW - startedAgoS * 1000, updated: NOW - updatedAgoS * 1000 })));
  // 99 sessions of 10 s ago, a: updated 1000 s ago but started late (1000 s ago), b: updated 1 s ago but started early (5000 s ago).
  // By updated, a is the oldest; by step_started, b is. With one too many, the oldest by updated goes.
  for (let i = 0; i < 99; i++) put1(`o${String(i).padStart(2, "0")}`, 10, 10);
  put1("a", 1000, 1000);
  put1("b", 1, 5000);
  const d = await collectFrom(mods, w);
  assert.equal(d.sessions.length, 100);
  const phases = d.sessions.map((s) => s.phase);
  assert.ok(phases.includes("b") && !phases.includes("a"), "the one that was updated longest ago is dropped, not the one that started earliest");
  assert.deepEqual(d.errors, [{ file: "sessions", reason: "1 session(s) left out: more than 100 live sessions, the newest were kept" }]);
}

test("round 6, 3: the cap keeps the newest by updated, not by step_started", async () => {
  await scenarioCapKey(REAL);
});

// 3c. a data folder that only grows: only the newest 250 files by modified time are opened, and the rest are counted as left out
async function scenarioReads(mods) {
  const w = world("reads");
  const p = w.proj("zork");
  assert.equal(s4(mods, ["enable", "--data", w.data]).code, 0);
  const id = s4(mods, ["register", "--data", w.data, "--root", p], { homedir: w.base }).out.match(/id ([0-9a-f]{12})/)[1];
  const sdir = join(w.data, "sessions");
  mkdirSync(sdir, { recursive: true });
  const stamp = (name, secondsAgo) => { const t = (NOW - secondsAgo * 1000) / 1000; utimesSync(join(sdir, name), t, t); };
  // 997 old sessions (done long ago) and 3 live ones: the live ones were modified last, the old ones from 2 to 3 days ago
  for (let i = 0; i < 997; i++) {
    const phase = `o${String(i).padStart(4, "0")}`;
    const at = NOW - 30 * DAY - i * 1000;
    writeFileSync(join(sdir, `${id}-${phase}.json`), JSON.stringify(MARKED(id, phase, { state: "done", step_started: at, updated: at })));
    stamp(`${id}-${phase}.json`, 2 * 86400 + i);
  }
  for (const k of [1, 2, 3]) {
    writeFileSync(join(sdir, `${id}-l${k}.json`), JSON.stringify(MARKED(id, `l${k}`)));
    stamp(`${id}-l${k}.json`, k);
  }
  const opened = [];
  const d = await collectFrom(mods, w, { fd: { open: (path, flags) => { opened.push(path); return openSync(path, flags); } } });
  assert.deepEqual(d.sessions.filter((s) => s.phase.startsWith("l")).map((s) => s.phase).sort(), ["l1", "l2", "l3"], "the three live ones are among the newest by modified time and survive");
  assert.equal(d.sessions.length, 100);
  const sessionOpens = opened.filter((f) => f.includes(`${sep}sessions${sep}`) || f.includes("/sessions/")).length;
  assert.ok(sessionOpens <= 250, `${sessionOpens} session files were opened`);
  assert.ok(opened.length <= 250 + 5, `${opened.length} files were opened in all: at most 250 sessions and the small config files`);
  // The 250 files that were opened leave 150 sessions out of the cap of 100 (an error, as before); the 750 files never opened have
  // their own fixed phrase, in notes, and are not an error.
  assert.deepEqual(d.errors, [{ file: "sessions", reason: "150 session(s) left out: more than 100 live sessions, the newest were kept" }], "only the sessions the cap left out are an error");
  assert.deepEqual(d.notes, ["750 older session file(s) not opened (only the newest 250 are read)"], "the unopened files are a note with their own phrase");
  assert.ok(!d.errors.some((e) => e.reason.includes("not opened")), "never in the error list");
  // The page shows the note quietly: a note without the error styling, once, apart from the error list.
  const html = draw(mods, d);
  const phrase = "750 older session file(s) not opened (only the newest 250 are read)";
  assert.equal(count(html, phrase), 1);
  const noteDiv = html.split('<div class="note').slice(1).find((s) => s.includes(phrase));
  assert.ok(noteDiv.startsWith('" role="note">'), "a plain note, not the error note");
  assert.ok(!noteDiv.split("</div>")[0].includes("Skipped"), "not inside the error banner");
  assert.ok(html.includes("150 session(s) left out: more than 100 live sessions"), "the cap's phrase is still in the error banner");
}

test("round 6, 2: of 1,000 session files only the newest 250 by modified time are opened; the live ones survive and the rest are counted as left out", async () => {
  await scenarioReads(REAL);
});

// 4. the page draws the rows itself, so it never shows more than it draws
function scenarioSmallerFigure(mods) {
  const render = (projects) => mods.page.renderPage(fakeData(projects, []), { now: NOW, fonts: false });
  const rows = [ph("1", "a", "shipped"), ph("2", "b", "shipped"), ph("3", "c", "planned")];
  const hostile = pj(1, "bigco", rows, { summary: strictSummary({ roadmaps: 1e9, phasesTotal: 1e9, phasesShipped: 1e9, legacyFiles: 3 }) });
  const html = render([hostile]);
  const b = blockOf(html, "bigco");
  assert.ok(b.includes('data-h="Roadmaps"><span class="fig">1</span>') && b.includes('<span class="fig">2 of 3</span>'), b.slice(0, 600));
  assert.ok(!b.includes("1000000") && !html.includes("1000000"), "a figure far above the rows drawn is not shown");
  assert.equal(cell(titleBlockOf(html), "Roadmap"), "2 of 3");
  // a figure below the rows drawn is the collector's and is shown; shipped is never above the total
  const small = pj(1, "smallco", rows, { summary: strictSummary({ roadmaps: 1, phasesTotal: 2, phasesShipped: 1, legacyFiles: 0 }) });
  assert.ok(blockOf(render([small]), "smallco").includes('<span class="fig">1 of 2</span>'));
  const over = pj(1, "overco", rows, { summary: strictSummary({ roadmaps: 1, phasesTotal: 2, phasesShipped: 1e9, legacyFiles: 0 }) });
  assert.ok(blockOf(render([over]), "overco").includes('<span class="fig">2 of 2</span>'), "shipped is capped by the total");
  const noRows = pj(1, "noco", [], { summary: strictSummary({ roadmaps: 1e9, phasesTotal: 1e9, phasesShipped: 1e9, legacyFiles: 0 }) });
  const emptyHtml = render([noRows]);
  assert.ok(!emptyHtml.includes("1000000"), "no row drawn, nothing to show");
}

test("round 5, 4: a hostile summary figure is never shown above the rows the page draws", () => {
  scenarioSmallerFigure(REAL);
});

// 5. the letter case of a roadmap path counts only where the file system keeps it; a file name carries a lower-case phase
async function scenarioCaseNames(mods) {
  const w = world("case-names");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("1", "One", "planned")]));
  const run = (argv) => s4(mods, argv, { homedir: w.base });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const id = run(["register", "--data", w.data, "--root", p]).out.match(/id ([0-9a-f]{12})/)[1];
  const sdir = join(w.data, "sessions");
  mkdirSync(sdir, { recursive: true });
  const mk = (name, extra) => put(w.data, `sessions/${name}`, JSON.stringify(MARKED(id, "1", extra)));
  const clearAll = () => { for (const f of listing(sdir)) rmSync(join(sdir, f)); };
  // letter case kept: Docs and docs are two roadmaps with two files, and the page gives each its own row id
  mk(sname(id, "1", "Docs/plan.md", false), { roadmap: "Docs/plan.md" });
  mk(sname(id, "1", "docs/plan.md", false), { roadmap: "docs/plan.md" });
  let d = await collectFrom(mods, w, { caseInsensitive: false });
  assert.deepEqual(d.sessions.map((s) => s.roadmap).sort(), ["Docs/plan.md", "docs/plan.md"]);
  assert.deepEqual(d.errors, []);
  assert.equal(new Set(rowIds(draw(mods, d))).size, 2, "two rows, two different ids");
  // letter case ignored: the same two names are not both right (the tag is of the lower-case path)
  d = await collectFrom(mods, w, { caseInsensitive: true });
  assert.deepEqual(d.sessions.map((s) => s.roadmap), ["docs/plan.md"]);
  assert.deepEqual(d.errors, [{ file: sname(id, "1", "Docs/plan.md", false), reason: "its content does not match its file name" }]);
  clearAll();
  // an upper-case phase in a file name is not a session file name: skipped and reported by base name, so names stay canonical
  const t = tagFor(RM);
  // (the two spellings are written one after the other, as a file system that ignores letter case cannot hold both)
  put(w.data, `sessions/${id}-${t}+A.json`, JSON.stringify(MARKED(id, "A", { roadmap: RM })));
  put(w.data, `sessions/${id}-T-A.json`, JSON.stringify(MARKED(id, "T-A")));
  d = await collectFrom(mods, w);
  assert.deepEqual(d.sessions, []);
  assert.deepEqual(d.errors.map((e) => [e.file, e.reason]).sort(), [[`${id}-${t}+A.json`, "not a session file name"], [`${id}-T-A.json`, "not a session file name"]].sort());
  clearAll();
  put(w.data, `sessions/${id}-${t}+a.json`, JSON.stringify(MARKED(id, "a", { roadmap: RM })));
  put(w.data, `sessions/${id}-t-a.json`, JSON.stringify(MARKED(id, "t-a")));
  d = await collectFrom(mods, w);
  assert.deepEqual(d.sessions.map((s) => s.phase).sort(), ["a", "t-a"]);
  assert.deepEqual(d.errors, []);
  assert.equal(new Set(rowIds(draw(mods, d))).size, 2);
}

test("round 5, 5: the tag follows io.caseInsensitive in both scripts, two roadmaps differing only in case get two rows, and an upper-case phase in a file name is skipped", async () => {
  await scenarioCaseNames(REAL);
});

test("round 5, 5: Docs and docs in one repository get two session files (skipped where the file system ignores letter case)", async (t) => {
  const w = world("two-case");
  const repo = w.proj("mono");
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "Docs"));
  try { mkdirSync(join(repo, "docs")); } catch { /* the same folder where letter case is ignored */ }
  if (readdirSync(repo).filter((n) => n.toLowerCase() === "docs").length < 2) { t.diagnostic("this file system ignores letter case, so two folders differing only in case cannot be made; the rule is tested through io.caseInsensitive in the test above"); return; }
  put(repo, `Docs/${RM}`, roadmap([rowE("1", "Upper", "in progress")]));
  put(repo, `docs/${RM}`, roadmap([rowE("1", "Lower", "in progress")]));
  const io = { homedir: w.base, caseInsensitive: false };
  assert.equal(st(["enable", "--data", w.data]).code, 0);
  for (const f of ["Docs", "docs"]) assert.equal(st(["set", "--data", w.data, "--root", join(repo, f), "--phase", "1", "--step", "build", "--state", "working"], io).code, 0);
  assert.equal(listing(join(w.data, "sessions")).length, 2, "one file for each folder");
  const got = await collectData({ data: w.data, now: NOW, caseInsensitive: false });
  assert.ok(got.ok, got.message);
  assert.deepEqual(got.data.sessions.map((s) => s.roadmap).sort(), [`Docs/${RM}`, `docs/${RM}`]);
});

// ── each change to a script makes its round 5 scenario fail ─────────────────
test("round 5: the rules are in the scripts: each change makes its scenario fail", async () => {
  const cases = [
    ["status: a folder with no usable path writes the older name", [["status.mjs", "const file = sessionName(proj.id, phase, proj.tag, !proj.roadmap);", "const file = proj.roadmap ? sessionName(proj.id, phase, proj.tag) : `${proj.id}-${phase.toLowerCase()}.json`;"]], scenarioUnlisted],
    ["status: two unusable folders share one tag", [["status.mjs", "unlistedTag(parts.join(\"/\"), io)", "unlistedTag(\"\", io)"]], scenarioUnlisted],
    ["status: an unlisted session has no marker", [["status.mjs", ": { unlisted: true }), phase,", ": {}), phase,"]], scenarioUnlisted],
    ["status: an unlisted file has no u in its name", [["status.mjs", "const file = sessionName(proj.id, phase, proj.tag, !proj.roadmap);", "const file = sessionName(proj.id, phase, proj.tag);"]], scenarioUnlisted],
    ["collect: an unlisted session takes an estimate", [["collect.mjs", "if (s.roadmap?.startsWith(UNLISTED_PREFIX)) s.estimateH = null;", "if (false) s.estimateH = null;"]], scenarioUnlisted],
    ["page: an unlisted session takes a title", [["page.mjs", "if (roadmap.startsWith(UNLISTED_PREFIX)) return \"\";", ""]], scenarioUnlisted],
    ["collect: the marker is read on a plain name", [["collect.mjs", "v.unlisted !== true || !tagged || tagged[2] !== \"u\" || v.roadmap !== undefined", "v.unlisted !== true || v.roadmap !== undefined"]], scenarioUnlisted],
    ["collect: the marker is read on a name without the u", [["collect.mjs", "v.unlisted !== true || !tagged || tagged[2] !== \"u\" || v.roadmap !== undefined", "v.unlisted !== true || !tagged || v.roadmap !== undefined"]], scenarioUnlisted],
    ["collect: the marker is read with a roadmap field", [["collect.mjs", "v.unlisted !== true || !tagged || tagged[2] !== \"u\" || v.roadmap !== undefined", "v.unlisted !== true || !tagged || tagged[2] !== \"u\""]], scenarioAlias],
    ["collect: the marker may be false", [["collect.mjs", "v.unlisted !== true || !tagged || tagged[2] !== \"u\" || v.roadmap !== undefined", "!tagged || tagged[2] !== \"u\" || v.roadmap !== undefined"]], scenarioUnlisted],
    ["collect: a roadmap field is read on a name with the u", [["collect.mjs", "tagged && tagged[2] === \"\" && tagged[3] === roadmapTag", "tagged && tagged[3] === roadmapTag"]], scenarioAlias],
    ["status: the tag and the phase are joined by a dash", [["status.mjs", "${tag}+${phase.toLowerCase()}.json`;", "${tag}-${phase.toLowerCase()}.json`;"]], scenarioAlias],
    ["status: a stored roadmap that is not usable fails the file", [["status.mjs", "!p.roadmaps.every((r) => typeof r === \"string\")", "!p.roadmaps.every((r) => roadmapOf(r) !== null)"]], scenarioOldRegistry],
    ["status: a stored roadmap that is not text is accepted", [["status.mjs", "!p.roadmaps.every((r) => typeof r === \"string\")", "false"]], scenarioOldRegistry],
    ["status: the unusable stored roadmaps are kept in the list", [["status.mjs", "(r) => { if (r === null || seen.has(foldPath(r, io))) return false;", "(r) => { if (r === null) return true; if (seen.has(foldPath(r, io))) return false;"]], scenarioOldRegistry],
    ["collect: files of projects that are not listed count toward the reads", [["collect.mjs", "if (!known.has((plain ?? tagged)[1])) continue;", "if (!known.has((plain ?? tagged)[1])) { candidates.push({ name, plain, tagged, mtime: 0 }); continue; }"]], scenarioCap],
    ["collect: the oldest sessions are kept past the cap", [["collect.mjs", ".sort((a, b) => sessionRank(b) - sessionRank(a))", ".sort((a, b) => sessionRank(a) - sessionRank(b))"]], scenarioCap],
    ["collect: the sessions left out are not reported", [["collect.mjs", "if (sess.dropped > 0) errors.unshift(", "if (false) errors.unshift("]], scenarioCap],
    ["page: the roadmaps figure is the summary's whatever it is", [["page.mjs", "Math.min(whole(sum.roadmaps) ?? p.roadmaps.length, p.roadmaps.length)", "whole(sum.roadmaps) ?? p.roadmaps.length"]], scenarioSmallerFigure],
    ["page: the phases total is the summary's whatever it is", [["page.mjs", "Math.min(whole(sum.phasesTotal) ?? phases.length, phases.length)", "whole(sum.phasesTotal) ?? phases.length"]], scenarioSmallerFigure],
    ["page: the shipped figure may be above the rows drawn", [["page.mjs", "shipped: Math.min(total, whole(sum.phasesShipped) ?? drawn, drawn),", "shipped: Math.min(total, whole(sum.phasesShipped) ?? drawn),"]], scenarioSmallerFigure],
    ["status: the tag is always of the lower-case path", [["status.mjs", "(io.caseInsensitive ?? CASE_INSENSITIVE) ? p.toLowerCase() : p", "p.toLowerCase()"]], scenarioOldNames],
    ["collect: the tag is always of the lower-case path", [["collect.mjs", "caseInsensitive ? rel.toLowerCase() : rel", "rel.toLowerCase()"]], scenarioCaseNames],
    ["collect: an upper-case phase in a file name is read", [["collect.mjs", "([a-z0-9._-]{1,40})", "([A-Za-z0-9._-]{1,40})"]], scenarioCaseNames],
    ["page: the row id folds the case of the roadmap", [["page.mjs", "slug(\"s\", p.id, s.roadmap, s.phase.toLowerCase())", "slug(\"s\", p.id, s.roadmap.toLowerCase(), s.phase.toLowerCase())"]], scenarioCaseNames],
  ];
  for (const [name, changes, scenario] of cases) {
    const mods = await mutantOf(changes);
    await assert.rejects(async () => { await scenario(mods); }, (e) => e?.code === "ERR_ASSERTION", `${name}: the scenario did not fail on an assertion`);
  }
});

// ── fix round 6: older files are only read, the session reads are bounded, the cap, letter case, a hostile figure, a registry with repeats ──
// Each scenario takes the three modules { page, collect, status } and runs against the real scripts and, in the last test of
// this section, against a temp copy with one change at a time (each change must make its scenario fail).

// 4. a session's roadmap is matched to a listed one with its letter case ignored only where the file system ignores it
async function scenarioFold(mods) {
  const w = world("fold");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("1", "Root one", "in progress", "2h → 1.5h")]));
  put(p, `docs/${RM}`, roadmap([rowE("1", "Docs one", "in progress", "4h → 3h")]));
  const run = (argv) => s4(mods, argv, { homedir: w.base });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const reg = run(["register", "--data", w.data, "--root", p, "--roadmap", `docs/${RM}`]);
  assert.equal(reg.code, 0, reg.err);
  const id = reg.out.match(/id ([0-9a-f]{12})/)[1];
  const sdir = join(w.data, "sessions");
  mkdirSync(sdir, { recursive: true });
  for (const folds of [true, false]) {
    for (const f of listing(sdir)) rmSync(join(sdir, f));
    // the session's roadmap field says Docs/..., the project lists docs/...: the same roadmap only where letter case is ignored
    const field = `Docs/${RM}`;
    put(w.data, `sessions/${sname(id, "1", field, folds)}`, JSON.stringify(MARKED(id, "1", { roadmap: field })));
    const d = await collectFrom(mods, w, { caseInsensitive: folds });
    assert.deepEqual(d.errors, []);
    assert.equal(d.sessions[0].estimateH, folds ? 3 : 1.5, `collect, caseInsensitive ${folds}: the estimate of the roadmap it names, or the first roadmap that has the phase`);
    const html = mods.page.renderPage(d, { now: NOW, fonts: false, caseInsensitive: folds });
    const row = rowsOf(html)[0];
    assert.ok(folds ? row.includes("Docs one") && !row.includes("Root one") : row.includes("Root one") && !row.includes("Docs one"), `page, caseInsensitive ${folds}: the title of the roadmap it names, or of the first roadmap that has the phase`);
    // the page builder passes the seam on to both
    const built = await mods.page.buildPage(w.data, { now: NOW, caseInsensitive: folds });
    assert.equal(built.ok, true);
    const written = rowsOf(readFileSync(join(w.data, "dashboard.html"), "utf8"))[0];
    assert.ok(folds ? written.includes("Docs one") : written.includes("Root one") && !written.includes("Docs one"), `buildPage, caseInsensitive ${folds}`);
    rmSync(join(w.data, "dashboard.html"));
  }
}

test("round 6, 4: the case-folded roadmap match is used only where io.caseInsensitive is true, in collect and in the page", async () => {
  await scenarioFold(REAL);
});

// 6. a hostile summary cannot claim a million files or a million names
function scenarioLegacyClamp(mods) {
  const names = Array.from({ length: 100000 }, (_, i) => `legacy-name-${i}.md`);
  const hostile = pj(1, "bigco", [ph("1", "a", "planned")], { summary: strictSummary({ roadmaps: 1, phasesTotal: 1, legacyFiles: 1e9, legacyNames: names }) });
  const html = mods.page.renderPage(fakeData([hostile], []), { now: NOW, fonts: false });
  const b = blockOf(html, "bigco");
  assert.ok(b.includes("10000 roadmap files not standardized"), b.slice(0, 400));
  assert.ok(b.includes("legacy-name-9.md") && !b.includes("legacy-name-10.md"), "at most 10 names");
  assert.ok(b.includes("and 9990 more"), "the rest are counted, not named");
  assert.ok(!html.includes("1000000") && !html.includes("999990"), "no figure from the million");
  // a count that is honest is shown as it is
  const honest = pj(1, "honestco", [ph("1", "a", "planned")], { summary: strictSummary({ roadmaps: 1, phasesTotal: 1, legacyFiles: 3, legacyNames: ["x.md", "y.md", "z.md"] }) });
  assert.ok(blockOf(mods.page.renderPage(fakeData([honest], []), { now: NOW, fonts: false }), "honestco").includes("3 roadmap files not standardized: x.md, y.md, z.md (not drawn)."));
}

test("round 6, 6: a summary with a million legacy files and a hundred thousand names is shown as at most 10,000 files and 10 names", () => {
  scenarioLegacyClamp(REAL);
});

// 7. a stored list with entries that become the same path once cleaned keeps one of them
async function scenarioDupRoadmaps(mods) {
  const w = world("dup-roadmaps");
  const p = w.proj("zork");
  const run = (argv) => s4(mods, argv, { homedir: w.base });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const id = run(["register", "--data", w.data, "--root", p]).out.match(/id ([0-9a-f]{12})/)[1];
  const file = join(w.data, "projects.json");
  const stored = readJson(w.data, "projects.json");
  stored.projects[0].roadmaps = [`docs\\${RM}`, `docs/${RM}`, RM, `docs/${RM}`];
  const seed = JSON.stringify(stored);
  writeFileSync(file, seed);
  const listed = run(["list", "--data", w.data]);
  assert.equal(listed.code, 0, listed.err);
  assert.ok(listed.out.includes(`roadmaps: docs/${RM}, ${RM}  added`), listed.out);
  assert.equal(readFileSync(file, "utf8"), seed, "a command that does not write leaves the file as it is");
  // a command that writes the list writes it once for each path, the first one staying
  const added = run(["register", "--data", w.data, "--root", p, "--label", "zork-app"]);
  assert.equal(added.code, 0, added.err);
  assert.deepEqual(readJson(w.data, "projects.json").projects.map((x) => [x.id, x.roadmaps]), [[id, [`docs/${RM}`, RM]]]);
  // the same through set
  writeFileSync(file, seed);
  assert.equal(run(["set", "--data", w.data, "--root", p, "--phase", "1", "--step", "build", "--state", "working", "--label", "zork-app"]).code, 0);
  assert.deepEqual(readJson(w.data, "projects.json").projects[0].roadmaps, [`docs/${RM}`, RM]);
}

test("round 6, 7: roadmap entries that become the same path once cleaned are one entry when the list is read and written", async () => {
  await scenarioDupRoadmaps(REAL);
});

// 8. 100 sessions with the longest trails and long names still make a page under the hard limit
async function scenarioHundred(mods) {
  const w = world("hundred");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("1", "One", "planned")]));
  assert.equal(s4(mods, ["enable", "--data", w.data]).code, 0);
  const id = s4(mods, ["register", "--data", w.data, "--root", p], { homedir: w.base }).out.match(/id ([0-9a-f]{12})/)[1];
  const sdir = join(w.data, "sessions");
  mkdirSync(sdir, { recursive: true });
  const STEPS = ["baseline", "build", "compare", "review", "preview", "approve", "ship", "prod-check"];
  // 40 entries that go back and forth between the gates (many different loops), a 100-character name, 210 files
  const trail = Array.from({ length: 40 }, (_, k) => ({ step: STEPS[[1, 7, 2, 6, 3, 5, 4, 0][k % 8]], state: "working", at: NOW - (41 - k) * 2 * MIN }));
  for (let i = 0; i < 210; i++) {
    const phase = `s${String(i).padStart(3, "0")}`;
    writeFileSync(join(sdir, sname(id, phase)), JSON.stringify(MARKED(id, phase, { roadmap: RM, phase_name: "n".repeat(100), trail })));
  }
  const d = await collectFrom(mods, w);
  assert.equal(d.sessions.length, 100, "the cap is the one that fits");
  const built = await mods.page.buildPage(w.data, { now: NOW });
  assert.deepEqual(built, { ok: true }, "the page is built with the real limit");
  const size = statSync(join(w.data, "dashboard.html")).size;
  assert.ok(size < 1024 * 1024, `the page is ${size} bytes`);
}

test("round 6, 8: 100 sessions with 40-entry trails and 100-character names still build a page under the 1 MB hard limit", async () => {
  await scenarioHundred(REAL);
});

test("round 6, 8: the sessions cap and the number of files read are the same in the source and in the docs", () => {
  const src = repoText("plugins", "phased-shipping", "skills", "dashboard", "scripts", "collect.mjs");
  const cap = src.match(/^const MAX_SESSIONS = (\d+);$/m)[1];
  const reads = src.match(/^const MAX_SESSION_READS = (\d+);$/m)[1];
  const cl = repoText("plugins", "phased-shipping", "CHANGELOG.md");
  const docs = {
    status: repoText("plugins", "phased-shipping", "skills", "dashboard", "references", "status.md"),
    change: cl.slice(cl.indexOf("## 0.10.0"), cl.indexOf("\n## ", cl.indexOf("## 0.10.0") + 5)),
    readme: repoText("plugins", "phased-shipping", "README.md"),
    root: repoText("README.md"),
    wiki: repoText("docs", "wiki", "Dashboard.md"),
    skill: repoText("plugins", "phased-shipping", "skills", "dashboard", "SKILL.md"),
    header: src,
  };
  for (const [name, text] of Object.entries(docs)) {
    for (const m of text.matchAll(/\b(\d+) sessions\b/g)) assert.equal(m[1], cap, `${name} says ${m[0]}, the source cap is ${cap}`);
    assert.ok(!/\b\d+-session cap\b/.test(text), `${name} names the cap in the old way`);
  }
  for (const name of ["status", "change", "wiki", "header"]) {
    assert.ok(docs[name].includes(`${cap} sessions`), `${name} states the cap`);
    assert.ok(docs[name].includes(`newest ${reads}`), `${name} states the number of files read`);
  }
  assert.equal(cap, "100");
  assert.equal(reads, "250");
});

// ── final fixes: an older-form file against one or two tagged files; repeated roadmap entries in collect, the page and status ──
// A. an older-form file displaces a tagged file only when it is the only tagged file of that project and phase
async function scenarioOldTwoRoadmaps(mods) {
  const w = world("old-two");
  const p = w.proj("zork");
  put(p, RM, roadmap([rowE("1", "One", "planned")]));
  const run = (argv) => s4(mods, argv, { homedir: w.base });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  const id = run(["register", "--data", w.data, "--root", p]).out.match(/id ([0-9a-f]{12})/)[1];
  const A = `a/${RM}`;
  const B = `b/${RM}`;
  // x1: two roadmaps, the older-form file newer than both: both tagged sessions are shown, the older-form one is dropped
  hand(w, id, "x1", { step: "build", startedAgo: 20, updatedAgo: 1 });
  hand(w, id, "x1", { step: "review", startedAgo: 30, updatedAgo: 10, named: A });
  hand(w, id, "x1", { step: "compare", startedAgo: 30, updatedAgo: 12, named: B });
  // x2: two roadmaps, the older-form file newer than one of them only (the one it would have hidden is live)
  hand(w, id, "x2", { step: "build", startedAgo: 20, updatedAgo: 5 });
  hand(w, id, "x2", { step: "review", startedAgo: 30, updatedAgo: 2, named: A });
  hand(w, id, "x2", { step: "compare", startedAgo: 30, updatedAgo: 10, named: B });
  // x3: one tagged file and a newer older-form file: the older-form file is shown, the tagged one is dropped
  hand(w, id, "x3", { step: "build", startedAgo: 20, updatedAgo: 1 });
  hand(w, id, "x3", { step: "review", startedAgo: 30, updatedAgo: 10, named: A });
  // x4: one tagged file and an older older-form file: the tagged one is shown
  hand(w, id, "x4", { step: "build", startedAgo: 30, updatedAgo: 10 });
  hand(w, id, "x4", { step: "review", startedAgo: 20, updatedAgo: 1, named: A });
  // x5: one tagged file and a clock-skewed older-form file: the skewed one is dropped
  hand(w, id, "x5", { step: "build", startedAgo: 1e6, updatedAgo: -1e6 });
  hand(w, id, "x5", { step: "review", startedAgo: 30, updatedAgo: 10, named: A });
  // x6: two roadmaps and a clock-skewed older-form file: only the older-form file is dropped
  hand(w, id, "x6", { step: "build", startedAgo: 1e6, updatedAgo: -1e6 });
  hand(w, id, "x6", { step: "review", startedAgo: 30, updatedAgo: 10, named: A });
  hand(w, id, "x6", { step: "compare", startedAgo: 30, updatedAgo: 12, named: B });
  const d = await collectFrom(mods, w);
  const byPhase = {};
  for (const s of d.sessions) (byPhase[s.phase] ??= []).push(`${s.roadmap}:${s.step}`);
  for (const k of Object.keys(byPhase)) byPhase[k].sort();
  const both = [`${A}:review`, `${B}:compare`].sort();
  assert.deepEqual(byPhase, { x1: both, x2: both, x3: ["null:build"], x4: [`${A}:review`], x5: [`${A}:review`], x6: both });
  assert.deepEqual(d.errors, [], "nothing is reported: the dropped file is dropped without a word");
}

test("final fixes, L1: an older-form file hides a tagged file only when it is the one tagged file of its phase; with two roadmaps both stay and the older-form file goes", async () => {
  await scenarioOldTwoRoadmaps(REAL);
});

// B. roadmap entries that are the same path are one, in collect, in the page and in status
async function scenarioDupRegistry(mods) {
  const w = world("dup-registry");
  const p = w.proj("zork");
  put(p, `a/${RM}`, roadmap([rowE("1", "Alpha one", "shipped"), rowE("2", "Alpha two", "planned")]));
  put(p, RM, roadmap([rowE("1", "Root one", "planned")]));
  const run = (argv) => s4(mods, argv, { homedir: w.base });
  assert.equal(run(["enable", "--data", w.data]).code, 0);
  assert.equal(run(["register", "--data", w.data, "--root", p]).code, 0);
  const stored = readJson(w.data, "projects.json");
  stored.projects[0].roadmaps = [`a${BS}${RM}`, `a/${RM}`, `A/${RM}`, RM];
  writeFileSync(join(w.data, "projects.json"), JSON.stringify(stored));
  // letter case ignored: the four entries are two roadmaps, read once each, and the figures are not doubled
  let d = await collectFrom(mods, w, { caseInsensitive: true });
  const folded = d.projects[0];
  assert.deepEqual(folded.roadmaps.map((r) => r.file), [`a/${RM}`, RM]);
  assert.deepEqual(folded.errors, []);
  assert.equal(folded.summary.roadmaps, 2);
  assert.equal(folded.summary.phasesTotal, 3);
  assert.equal(folded.summary.phasesShipped, 1);
  // letter case kept: the backslash spelling is still the same path, the upper-case folder is another entry (a roadmap where the
  // file system finds it, a file not found where it does not), so three entries in all
  d = await collectFrom(mods, w, { caseInsensitive: false });
  const exact = d.projects[0];
  assert.equal(exact.roadmaps.filter((r) => r.file === `a/${RM}`).length, 1);
  assert.equal(exact.roadmaps.length + exact.errors.length, 3);
}

test("final fixes, L2: collect reads roadmap entries that are the same path once (letter case through io.caseInsensitive)", async () => {
  await scenarioDupRegistry(REAL);
});

function scenarioDupPage(mods) {
  const rows = [ph("1", "Alpha one", "shipped"), ph("2", "Alpha two", "planned")];
  const file = (name, phases) => ({ file: name, tables: 1, standard: true, phases });
  const data = fakeData([pj(1, "zork", null, { roadmaps: [file(`a${BS}${RM}`, rows), file(`a/${RM}`, rows), file(`A/${RM}`, rows), file(RM, [ph("1", "Root one", "planned")])] })]);
  const render = (fold) => mods.page.renderPage(data, { now: NOW, fonts: false, caseInsensitive: fold });
  let html = render(true);
  assert.equal(roadRows(blockOf(html, "zork")), 2, "each table once");
  assert.equal(cell(titleBlockOf(html), "Roadmap"), "1 of 3", "the figures are not multiplied");
  html = render(false);
  assert.equal(roadRows(blockOf(html, "zork")), 3, "the upper-case folder is another roadmap where letter case counts");
  assert.equal(cell(titleBlockOf(html), "Roadmap"), "2 of 5");
}

test("final fixes, L2: the page draws roadmap entries that are the same path once (letter case through its caseInsensitive option)", () => {
  scenarioDupPage(REAL);
});

function scenarioDupFold(mods) {
  for (const fold of [true, false]) {
    const w = world(`dup-fold-${fold}`);
    const p = w.proj("zork");
    const run = (argv) => s4(mods, argv, { homedir: w.base, caseInsensitive: fold });
    assert.equal(run(["enable", "--data", w.data]).code, 0);
    assert.equal(run(["register", "--data", w.data, "--root", p]).code, 0);
    const file = join(w.data, "projects.json");
    const stored = readJson(w.data, "projects.json");
    stored.projects[0].roadmaps = [`docs${BS}${RM}`, `docs/${RM}`, `Docs/${RM}`, RM];
    writeFileSync(file, JSON.stringify(stored));
    const expected = fold ? [`docs/${RM}`, RM] : [`docs/${RM}`, `Docs/${RM}`, RM];
    // reading the list
    const listed = run(["list", "--data", w.data]);
    assert.equal(listed.code, 0, listed.err);
    assert.ok(listed.out.includes(`roadmaps: ${expected.join(", ")}  added`), `fold ${fold}: ${listed.out}`);
    // writing the list
    assert.equal(run(["register", "--data", w.data, "--root", p, "--label", "zork-app"]).code, 0);
    assert.deepEqual(readJson(w.data, "projects.json").projects[0].roadmaps, expected, `fold ${fold}: written once for each path`);
    // adding a roadmap that differs only in letter case
    writeFileSync(file, JSON.stringify({ ...stored, projects: [{ ...stored.projects[0], roadmaps: [`docs/${RM}`] }] }));
    const added = run(["register", "--data", w.data, "--root", p, "--roadmap", `DOCS/${RM}`]);
    assert.equal(added.code, 0, added.err);
    assert.deepEqual(readJson(w.data, "projects.json").projects[0].roadmaps, fold ? [`docs/${RM}`] : [`docs/${RM}`, `DOCS/${RM}`], `fold ${fold}: register compares with the same fold`);
  }
}

test("final fixes, L2: status compares roadmap entries with the same letter-case fold as the tags, under both io.caseInsensitive settings", () => {
  scenarioDupFold(REAL);
});

// ── each change to a script makes its round 6 scenario fail ─────────────────
// (some of these put back code that this round removed, so the scenario that proves it is gone is shown to catch it)
test("round 6: the rules are in the scripts: each change makes its scenario fail", async () => {
  const OLD_NAME = "`${proj.id}-${phase.toLowerCase()}.json`";
  const own = "  const prev = readOwn(sdir, file, MAX_SESSION_BYTES, io);";
  const takeOver = (extra) => `  let prev = readOwn(sdir, file, MAX_SESSION_BYTES, io);
  let taken = null;
  if (prev.value === undefined && !prev.fail) {
    const was = readOwn(sdir, ${OLD_NAME}, MAX_SESSION_BYTES, io);
    if (!was.fail && isObj(was.value)${extra}) { ${"prev = was; taken = true;"} }
  }`;
  const clearOwn = "  const path = join(sdir, sessionName(proj.id, phase, proj.tag, !proj.roadmap));\n  try {\n    const st = lstatOrNull(path);\n    if (!st) {";
  const done = "  out(`status set: phase ${phase} ${step} ${state}`);";
  const hide = "    hidden.add(tagged.length === 1 && sessionRank(older) > sessionRank(tagged[0]) ? tagged[0] : older);";
  const rankLine = "const sessionRank = (e) => (e.skew ? -1 : e.s.updated);";
  const cases = [
    ["status: set takes the older file over (its trail and name go on)", [["status.mjs", own, takeOver("")]], scenarioOldUntouched],
    ["status: set takes over only this project's older file", [["status.mjs", own, takeOver(" && was.value.project === proj.id")]], scenarioOldUntouched],
    ["status: set removes the older file once its own is written", [["status.mjs", done, `  try { rmSync(join(sdir, ${OLD_NAME}), { force: true }); } catch { /* nothing */ }\n${done}`]], scenarioOldUntouched],
    ["status: clear falls back to the older file", [["status.mjs", clearOwn, "  let path = join(sdir, sessionName(proj.id, phase, proj.tag, !proj.roadmap));\n  try {\n    let st = lstatOrNull(path);\n    if (!st) { path = join(sdir, " + OLD_NAME + "); st = lstatOrNull(path); }\n    if (!st) {"]], scenarioOldUntouched],
    ["status: clear falls back to the older file only for a listed roadmap", [["status.mjs", clearOwn, "  let path = join(sdir, sessionName(proj.id, phase, proj.tag, !proj.roadmap));\n  try {\n    let st = lstatOrNull(path);\n    if (!st && proj.roadmap) { path = join(sdir, " + OLD_NAME + "); st = lstatOrNull(path); }\n    if (!st) {"]], scenarioOldUntouched],
    ["collect: an older file and a tagged file of one phase are both shown", [["collect.mjs", hide, ""]], scenarioOldNewest],
    ["collect: the older file always loses", [["collect.mjs", hide, "    hidden.add(older);"]], scenarioOldNewest],
    ["collect: the older file always wins", [["collect.mjs", hide, "    hidden.add(tagged[0]);"]], scenarioOldNewest],
    ["collect: a tie goes to the older file", [["collect.mjs", "sessionRank(older) > sessionRank(tagged[0]) ?", "sessionRank(older) >= sessionRank(tagged[0]) ?"]], scenarioOldNewest],
    ["collect: the phase is compared with its letter case", [["collect.mjs", "${e.id}\\u0000${e.s.phase.toLowerCase()}", "${e.id}\\u0000${e.s.phase}"]], scenarioOldNewest],
    ["collect: a clock-skewed older file wins", [["collect.mjs", rankLine, "const sessionRank = (e) => e.s.updated;"]], scenarioOldNewest],
    ["collect: a skewed session can win the cap", [["collect.mjs", rankLine, "const sessionRank = (e) => e.s.updated;"]], scenarioSkewCap],
    ["collect: the cap is by step_started", [["collect.mjs", rankLine, "const sessionRank = (e) => (e.skew ? -1 : e.s.step_started);"]], scenarioCapKey],
    ["collect: every session file is opened", [["collect.mjs", ".slice(0, MAX_SESSION_READS)", ".slice(0, 1e9)"]], scenarioReads],
    ["collect: the oldest files by modified time are the ones opened", [["collect.mjs", "[...candidates].sort((a, b) => b.mtime - a.mtime || byName(a, b))", "[...candidates].sort((a, b) => a.mtime - b.mtime || byName(a, b))"]], scenarioReads],
    ["collect: the files not opened are not counted", [["collect.mjs", "unread: candidates.length - chosen.length", "unread: 0"]], scenarioReads],
    ["collect: the files not opened are reported as an error", [["collect.mjs", "const notes = sess.unread > 0 ?", "const notes = false ?"], ["collect.mjs", "if (sess.dropped > 0) errors.unshift({ file: \"sessions\", reason: `${sess.dropped} session(s)", "if (sess.dropped + sess.unread > 0) errors.unshift({ file: \"sessions\", reason: `${sess.dropped + sess.unread} session(s)"]], scenarioReads],
    ["page: the note is drawn as an error", [["page.mjs", "main.push(note(\"\", m.notes.map(", "main.push(note(\"note-err\", m.notes.map("]], scenarioReads],
    ["page: the notes are not drawn", [["page.mjs", "if (m.notes.length) main.push(", "if (false) main.push("]], scenarioReads],
    ["collect: the case-folded match is always used", [["collect.mjs", "(fold ? item.roadmaps.find(", "(true ? item.roadmaps.find("]], scenarioFold],
    ["page: the case-folded match is always used", [["page.mjs", "const same = fold ? (a, b) =>", "const same = true ? (a, b) =>"]], scenarioFold],
    ["page: the builder does not pass the seam on", [["page.mjs", "const html = renderPage(got.data, { now: nowMs, fonts: true, refreshS: 10, assets, caseInsensitive: io.caseInsensitive });", "const html = renderPage(got.data, { now: nowMs, fonts: true, refreshS: 10, assets });"]], scenarioFold],
    ["page: the legacy count is not clamped", [["page.mjs", "count: Math.min(whole(sum.legacyFiles), MAX_LEGACY_COUNT),", "count: whole(sum.legacyFiles),"]], scenarioLegacyClamp],
    ["status: repeated roadmap entries are kept when the list is read", [["status.mjs", "r === null || seen.has(foldPath(r, io))", "r === null"]], scenarioDupRoadmaps],
    ["status: repeats are compared with the platform fold, not the seam (list)", [["status.mjs", "seen.has(foldPath(r, io))", "seen.has(keyOf(r))"], ["status.mjs", "seen.add(foldPath(r, io))", "seen.add(keyOf(r))"]], scenarioDupFold],
    ["status: repeats are compared with the platform fold, not the seam (register)", [["status.mjs", "(a, b) => foldPath(a, io) === foldPath(b, io)", "(a, b) => keyOf(a) === keyOf(b)"], ["status.mjs", "entry.roadmaps.some((y) => foldPath(y, io) === foldPath(r, io))", "entry.roadmaps.some((y) => keyOf(y) === keyOf(r))"]], scenarioDupFold],
    ["collect: repeated roadmap entries are all read", [["collect.mjs", "if (seenRoadmaps.has(foldRel(rel))) continue;", ""]], scenarioDupRegistry],
    ["collect: repeated roadmap entries are compared exactly", [["collect.mjs", "? rel.toLowerCase() : rel);", "? rel : rel);"]], scenarioDupRegistry],
    ["collect: repeated roadmap entries are always compared in lower case", [["collect.mjs", "? rel.toLowerCase() : rel);", "? rel.toLowerCase() : rel.toLowerCase());"]], scenarioDupRegistry],
    ["page: repeated roadmap entries are all drawn", [["page.mjs", "if (seenFiles.has(folded)) return false;", ""]], scenarioDupPage],
    ["page: repeated roadmap entries are compared exactly", [["page.mjs", "const folded = fold ? key.toLowerCase() : key;", "const folded = key;"]], scenarioDupPage],
    ["page: repeated roadmap entries are always compared in lower case", [["page.mjs", "const folded = fold ? key.toLowerCase() : key;", "const folded = key.toLowerCase();"]], scenarioDupPage],
    ["page: a backslash entry is a different roadmap", [["page.mjs", "const key = clean(r.file, 200).", "const key = clean(r.file, 200); const unused = clean(r.file, 200)."]], scenarioDupPage],
    ["collect: an older file displaces one of two tagged files", [["collect.mjs", hide, "    hidden.add(sessionRank(older) > sessionRank(tagged[0]) ? tagged[0] : older);"]], scenarioOldTwoRoadmaps],
    ["collect: an older file always loses, even to one tagged file", [["collect.mjs", hide, "    hidden.add(older);"]], scenarioOldTwoRoadmaps],
    ["collect: an older file always wins", [["collect.mjs", hide, "    hidden.add(tagged[0]);"]], scenarioOldTwoRoadmaps],
    ["collect: the first tagged file is the one compared, with a skewed older file winning", [["collect.mjs", rankLine, "const sessionRank = (e) => e.s.updated;"]], scenarioOldTwoRoadmaps],
    ["collect: the sessions cap is 200", [["collect.mjs", "const MAX_SESSIONS = 100;", "const MAX_SESSIONS = 200;"]], scenarioHundred],
  ];
  for (const [name, changes, scenario] of cases) {
    const mods = await mutantOf(changes);
    await assert.rejects(async () => { await scenario(mods); }, (e) => e?.code === "ERR_ASSERTION", `${name}: the scenario did not fail on an assertion`);
  }
});
