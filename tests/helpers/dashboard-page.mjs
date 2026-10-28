// Shared helpers of the dashboard page tests: tests/dashboard-page*.test.mjs and tests/regression-pack.test.mjs import them.
// Not a test file (no .test.mjs), so `node --test tests/*.test.mjs` does not run it. Temp folders are made under the OS temp
// folder and removed after each test file's run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, cpSync, statSync, lstatSync, utimesSync, openSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename, sep } from "node:path";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main as status, run as statusRun } from "../../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";
import { main as collect } from "../../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import { main as page, renderPage, buildPage } from "../../plugins/phased-shipping/skills/dashboard/scripts/page.mjs";
import * as pageModule from "../../plugins/phased-shipping/skills/dashboard/scripts/page.mjs";
import * as collectModule from "../../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import * as statusModule from "../../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL = join(HERE, "..", "plugins", "phased-shipping", "skills", "dashboard");
export const ASSETS = join(SKILL, "assets");
export const MIN = 60000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
export const cp = (n) => String.fromCodePoint(n);
// Names the guard protects are assembled here, so no such name is stored in this file.
export const RM = ["PH", "ASES.md"].join("");
export const scratch = [];
export const tmp = (label = "w") => { const d = mkdtempSync(join(tmpdir(), `roadmap-test-page-${label}-`)); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
export const put = (root, rel, data) => {
  const p = join(root, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
};
export const readJson = (root, rel) => JSON.parse(readFileSync(join(root, ...rel.split("/")), "utf8"));
export const listing = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
export function world(label) {
  const base = tmp(label);
  const data = join(base, "data");
  const proj = (name = "zork") => { const p = join(base, name); mkdirSync(p, { recursive: true }); return p; };
  return { base, data, proj };
}
export function st(argv, o = {}) {
  const out = [];
  const err = [];
  const code = status(argv, { out: (s) => out.push(s), err: (s) => err.push(s), now: () => NOW, ...o });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
export async function col(w, extra = []) {
  const out = [];
  const err = [];
  const code = await collect(["--data", w.data, "--now", String(NOW), ...extra], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, text: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
}
export async function pg(argv, o = {}) {
  const out = [];
  const err = [];
  const code = await page(argv, { out: (s) => out.push(s), err: (s) => err.push(s), now: () => NOW, ...o });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
export const enable = (w) => { assert.equal(st(["enable", "--data", w.data]).code, 0); };
export const setStatus = (w, root, phase, step, state, at, extra = [], o = {}) => st(["set", "--data", w.data, "--root", root, "--phase", phase, "--step", step, "--state", state, ...extra], { now: () => at, ...o });
export const idFor = (w, root) => { const m = st(["register", "--data", w.data, "--root", root]).out.match(/id ([0-9a-f]{12})/); assert.ok(m); return m[1]; };
// The session file name `set` writes for a phase in a roadmap: <id>-<6 hex of the SHA-256 of the roadmap path>+<phase in lower case>.json.
// The path is lower-cased for the tag only where the file system ignores letter case (Windows, macOS), as the scripts do by default.
// Whether the scripts' default folds the case of a roadmap path, asked of status.mjs itself (this file assumes no platform):
// `set` for a roadmap in a folder with capitals, and the name it wrote says which tag it used.
export const FOLDS = (() => {
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
export const tagFor = (roadmapPath, folds = FOLDS) => createHash("sha256").update(folds ? roadmapPath.toLowerCase() : roadmapPath).digest("hex").slice(0, 6);
export const sname = (id, phase, roadmapPath = RM, folds = FOLDS) => `${id}-${tagFor(roadmapPath, folds)}+${phase.toLowerCase()}.json`;
export const sessionPath = (w, id, phase) => join(w.data, "sessions", `${id}-${phase.toLowerCase()}.json`);
// Writes a session file by hand (a trail given as [step, state, minutes ago] triples). By default it is the older form
// (<id>-<phase>.json, no roadmap field); with named: true (or a roadmap path) it is the file `set` writes for that roadmap (the project root's by default).
export function hand(w, id, phase, o) {
  mkdirSync(join(w.data, "sessions"), { recursive: true });
  const trail = o.trail?.map(([step, state, ago]) => ({ step, state, at: NOW - ago * MIN }));
  const file = { v: 1, project: id, phase, phase_name: "", step: o.step, state: o.state ?? "working", step_started: NOW - (o.startedAgo ?? 5) * MIN, updated: NOW - (o.updatedAgo ?? 1) * MIN, ...(o.named ? { roadmap: o.named === true ? RM : o.named } : {}), ...(trail ? { trail } : {}), ...(o.extra ?? {}) };
  writeFileSync(o.named ? join(w.data, "sessions", sname(id, phase, o.named === true ? RM : o.named)) : sessionPath(w, id, phase), JSON.stringify(file));
  return file;
}
export const HEAD = "| # | Phase | Status | Kind | Priority | Urgency | Est. (raw \u2192 cal.) | Actual | Commit / deploy | Blocked by | Plan file | Note |";
export const rowE = (id, title, status, est = "2h \u2192 1.5h", actual = "") => `| ${id} | ${title} | ${status} | backend | P1 | Soon | ${est} | ${actual} | | | | |`;
export const roadmap = (rows) => ["<!-- phased-shipping:roadmap v1 -->", HEAD, `|${"---|".repeat(12)}`, ...rows].join("\n") + "\n";
export function pathForms(w) {
  const raw = [tmpdir(), realpathSync.native(tmpdir()), w.base, realpathSync.native(w.base), homedir()];
  const forms = new Set(["roadmap-test-page-"]);
  for (const p of raw) {
    forms.add(p.toLowerCase());
    forms.add(p.toLowerCase().split("\\").join("/"));
    forms.add(JSON.stringify(p).slice(1, -1).toLowerCase());
  }
  return [...forms];
}
export const noPath = (w, text, what) => {
  const t = text.toLowerCase();
  for (const f of pathForms(w)) assert.ok(!t.includes(f), `${what}: found a path (${f.slice(0, 20)}...)`);
};
export const HOSTILE = `<script>alert("pwned")</script> & "double" 'single' <img src=x onerror=alert(1)> ${cp(0x202e)}reversed${cp(0x202c)} ${cp(7)}bell ../../etc/passwd`;
export const stripB64 = (s) => s.replace(/base64,[A-Za-z0-9+/=]+/g, "base64,X");
export const scriptOf = (html) => html.split("<script>")[1].split("</script>")[0];
export const cssOf = (html) => html.split("<style>")[1].split("</style>")[0];
export const count = (s, needle) => s.split(needle).length - 1;

// ── page.mjs: rendering ─────────────────────────────────────────────────────
// A world with everything the page shows: a project with a waiting and a working session (a loop active), an idle one,
// an archived one, a roadmap with shipped phases and an unreadable roadmap file; a project with nothing running; and a
// project whose folder is gone.
export async function richWorld() {
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

// ── status.mjs: the page is rebuilt at every step ───────────────────────────
export async function sr(argv, o = {}) {
  const out = [];
  const err = [];
  const code = await statusRun(argv, { out: (s) => out.push(s), err: (s) => err.push(s), now: () => NOW, ...o });
  return { code, out: out.join("\n"), err: err.join("\n"), lines: out };
}
export const setArgs = (w, root, phase, step, state, extra = []) => ["set", "--data", w.data, "--root", root, "--phase", phase, "--step", step, "--state", state, ...extra];
export const pageFile = (w) => join(w.data, "dashboard.html");

// ── fix round 1 ─────────────────────────────────────────────────────────────
// A project as the collected data holds it, with a roadmap of `rows` rows (every third one shipped, with an actual time).
export const fakeProject = (n, label, rows = 0, extra = {}) => ({
  id: String(n).padStart(12, "a"), name: label, status: "ok",
  roadmaps: Array.from({ length: Math.ceil(rows / 300) }, (_, c) => ({ file: `plan-${c}.md`, tables: 1, standard: true, phases: Array.from({ length: Math.min(300, rows - c * 300) }, (_, j0) => { const j = c * 300 + j0; return { id: String(j + 1), phase: `Phase ${j + 1} of ${label}, with a title of a fair length to fill a row`, status: j % 3 === 0 ? "shipped" : "planned", kind: "backend", priority: "P1", urgency: "Soon", estRaw: 2, estCal: 1.5, estimateH: null, actual: j % 3 === 0 ? 1.2 : null, commit: "abc1234", timestamps: {} }; }) })),
  history: [], errors: [], ...extra,
});
export const fakeSession = (project, phase, state = "working", ago = 1) => ({ project: project.id, phase, phase_name: "", step: "build", state, shown: state === "working" ? "Working" : "Waiting", noUpdate: false, updated: NOW - ago * MIN, step_started: NOW - ago * MIN, loops: [], rounds: 1, visits: { build: 1 }, workedMs: 0, elapsedMs: 0, estimateH: null, archived: false });
export const fakeData = (projects, sessions = []) => ({ v: 1, generatedAt: new Date(NOW).toISOString(), thresholds: { warnMin: 90, idleMin: 180 }, projects, sessions, warnings: [], errors: [] });
export const KB = 1024;
export const bytesOf = (s) => Buffer.byteLength(s);
export const LEFT_OUT = "left out to keep the page small";
export const blockOf = (html, name) => html.split('<details class="proj"').slice(1).find((b) => b.includes(`>${name}<`));

// A trail whose eight loops back are all different (a step back to build, and two back to the first steps), newest last.
export const LOOPY = ["baseline", "build", "compare", "build", "review", "build", "preview", "build", "approve", "build", "ship", "build", "prod-check", "build", "compare", "baseline", "review", "baseline", "build"];
export const loopyTrail = () => LOOPY.map((step, i) => [step, "working", (LOOPY.length - i) * 2]);
// n session files of one project, each a working session with eight loops (a tall drawing), as written by hand.
export function heavySessions(w, id, n, o = {}) {
  for (let i = 0; i < n; i++) hand(w, id, `s${i}`, { step: "build", trail: loopyTrail(), ...o });
}

// ── the script of the page, run for real in a sandbox with a small stub of the page ──
export const CLIENT_SRC = readFileSync(join(ASSETS, "client.js"), "utf8");
export const T0 = 1700000000000;
export function stubEl(attrs = {}, extra = {}) {
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
// Runs a script text against the stub. o: storage (initial values), throwOnGet (keys whose read throws), focusThrows (the
// lookup of the focused row throws, as a browser does for a selector it cannot parse), projects, ts (the .t elements),
// body (the data attributes of the body).
export function runClient(src, o = {}) {
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
export const BS = "\\";

// The whole of a scenario runs against the real scripts and, in the last test, against a temp copy of the scripts with one
// change at a time: every change must make its scenario fail. A scenario takes the two modules { page, collect }.
export const REAL = { page: pageModule, collect: collectModule, status: statusModule };
export const ROADMAP_SCRIPTS = join(HERE, "..", "plugins", "phased-shipping", "skills", "roadmap", "scripts");
export async function mutantOf(changes) {
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

// A mutation sweep: every case is [name, changes, scenario]. Each one makes its change in a temp copy of the scripts and its scenario must
// then fail on an assertion. The cases are independent (each has its own temp copy and its own temp folders, and the scripts keep no state
// between calls), so up to SWEEP_CAP run at the same time. Every case runs even after one fails, and the first failure is thrown. It returns
// the number of cases it ran, so a sweep test can pin that number, and it throws if that is not the number it was given.
export const SWEEP_CAP = 4;
export async function runSweep(cases, cap = SWEEP_CAP) {
  let next = 0;
  let executed = 0;
  const failures = [];
  const worker = async () => {
    while (next < cases.length) {
      const [name, changes, scenario] = cases[next++];
      try {
        const mods = await mutantOf(changes);
        await assert.rejects(async () => { await scenario(mods); }, (e) => e?.code === "ERR_ASSERTION", `${name}: the scenario did not fail on an assertion`);
      } catch (e) {
        failures.push(e);
      } finally {
        executed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, cases.length) }, worker));
  if (failures.length) throw failures[0];
  if (executed !== cases.length) throw new Error(`the sweep ran ${executed} of ${cases.length} cases`);
  return executed;
}

// A roadmap of n shipped rows with long titles and long notes (the note column is not read; it makes the file big).
// Every title is full of ampersands, which the page writes as five characters each: the widest page one row can make.
export const bigRoadmap = (tag, n) => roadmap(Array.from({ length: n }, (_, j) => `| ${tag}${j + 1} | ${`Shipped item ${j + 1} of ${tag}, `.padEnd(198, "&")} | shipped | backend | P1 | Soon | 2h ${cp(0x2192)} 1.5h | 1.1h | abc1234 | | | ${"a long note ".repeat(21)} |`));

// ── 1. --out as a network or device path, or as another route to the data folder ──
export const uncSpellings = (rest) => [
  `${BS}${BS}host${BS}share${BS}${rest.split("/").join(BS)}`,
  `//host/share/${rest}`,
  `${BS}${BS}localhost${BS}share$${BS}${rest.split("/").join(BS)}`,
  `//localhost/share$/${rest}`,
  `${BS}${BS}?${BS}UNC${BS}host${BS}share${BS}${rest.split("/").join(BS)}`,
  `${BS}${BS}.${BS}host${BS}${rest.split("/").join(BS)}`,
  `/${BS}host/share/${rest}`,
];
export async function scenarioOut(mods) {
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

// ── 5c. a name with a dollar sign and a colon ───────────────────────────────
export async function scenarioColon(mods) {
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

// ── 4. a removed project leaves no trace ────────────────────────────────────
export async function scenarioUnregister(mods) {
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

// ── 2. a running project with a large roadmap ───────────────────────────────
export async function scenarioRunning(mods) {
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

// ── 5a. the hard limit really is 1 MB ───────────────────────────────────────
export async function scenarioHard(mods) {
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

// ── 5b. the note line itself pushes the page over ───────────────────────────
export function scenarioNoteEdge(mods) {
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

// ── round 3: the logo's look, the stale banner, the title block, the estimate from the history ──
export const ph = (id, title, status, extra = {}) => ({ id, phase: title, status, kind: "backend", priority: "P1", urgency: "Soon", estRaw: 2, estCal: 1.5, estimateH: null, actual: null, commit: "", timestamps: {}, ...extra });
export const pj = (n, name, phases, extra = {}) => ({ id: String(n).padStart(12, "b"), name, status: "ok", roadmaps: phases ? [{ file: "plan.md", tables: 1, standard: true, phases }] : [], history: [], errors: [], ...extra });
export const htmlOf = (projects, sessions = [], o = {}) => renderPage(fakeData(projects, sessions), { now: NOW, fonts: false, ...o });
export const MEDIA_MOTION = "@media screen and (prefers-reduced-motion:no-preference)";

// The rules of a stylesheet, flattened: { stack: the at-rules around it, selector, body }.
export function cssRules(css, stack = []) {
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
export const declarations = (body) => body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const at = d.indexOf(":"); return [d.slice(0, at).trim(), d.slice(at + 1).trim()]; });

// ── the title block ─────────────────────────────────────────────────────────
export const titleBlockOf = (html) => html.match(/<dl class="titleblock">[\s\S]*?<\/dl>/)[0];
// The text of the <dd> in the cell <div ...><dt>name</dt><dd>text</dd></div>, or undefined. Exact string checks, so the name is never
// turned into a pattern: the <dt> must open right after a <div ...> tag and the text must run to </dd></div> with no "<" inside it.
export const cell = (tb, name) => {
  const key = `<dt>${name}</dt><dd>`;
  for (let from = 0; ;) {
    const at = tb.indexOf(key, from);
    if (at < 0) return undefined;
    from = at + 1;
    const open = tb.lastIndexOf("<div", at);
    if (open < 0 || tb[at - 1] !== ">" || tb.slice(open + 4, at - 1).includes(">")) continue;
    const start = at + key.length;
    const end = tb.indexOf("<", start);
    if (end >= 0 && tb.startsWith("</dd></div>", end)) return tb.slice(start, end);
  }
};

// ── the estimate against actual, from the history ───────────────────────────
export const rec = (phase, est, actual, extra = {}) => ({ phase, est_h: est, actual_h: actual, check_rounds: 1, caught_by: [], prod_first_pass: true, rolled_back: false, tokens: null, ...extra });
// The text of a piece of markup with every <...> tag taken out, scanning left to right (a "<" with no ">" after it stays as text).
const tagsOut = (s) => {
  let out = "";
  for (let i = 0; ;) {
    const lt = s.indexOf("<", i);
    const gt = lt < 0 ? -1 : s.indexOf(">", lt + 1);
    if (gt < 0) return out + s.slice(i);
    out += s.slice(i, lt);
    i = gt + 1;
  }
};
export const estRows = (html, name) => {
  const part = blockOf(html, name).split("<summary>Estimate against actual")[1].split("</details>")[0];
  return [...part.matchAll(/<tr><td class="id">([^<]*)<\/td><td>([\s\S]*?)<\/td><td class="n">([^<]*)<\/td><td class="n"><strong>([^<]*)<\/strong><\/td>/g)].map((m) => ({ id: m[1], title: tagsOut(m[2]), est: m[3], actual: m[4] }));
};

// ── round 4: strict roadmap display ─────────────────────────────────────────
// Only a standardized roadmap file is drawn: it has at least one table and every table has the marker line. The files that
// are not are named in one note inside their project. Every scenario runs against the real scripts and, in the last test of
// this section, against a temp copy with one change at a time (each must make its scenario fail).
export const legacyMd = (rows) => [HEAD, `|${"---|".repeat(12)}`, ...rows].join("\n") + "\n";
export const mixedMd = (marked, bare) => `${roadmap(marked)}\nA second table, with no marker line above it\n\n${legacyMd(bare)}`;
export const PROSE_MD = "# Plan\n\nNothing but words here, and no table at all.\n";
export const collectFrom = async (mods, w, extra = {}) => {
  const got = await mods.collect.collectData({ data: w.data, now: NOW, ...extra });
  assert.ok(got.ok, got.message);
  return got.data;
};
export const draw = (mods, data) => mods.page.renderPage(data, { now: NOW, fonts: false });
export const roadRows = (block) => count(block, 'class="tbl tbl-road"');
export async function scenarioStrictFiles(mods) {
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
export const FILES10 = Array.from({ length: 10 }, (_, i) => `old-${i + 1}.md`);
export const strictSummary = (o = {}) => ({ roadmaps: 0, phasesTotal: 0, phasesShipped: 0, legacyFiles: 0, legacyNames: [], active: 0, working: 0, waiting: 0, idle: 0, archived: 0, estimateActiveH: 0, workedActiveMs: 0, ...o });
export function scenarioStrictPage(mods) {
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

// ── fix round 4: roadmap-keyed sessions, estimates, repository trust, notes, summary numbers, calm page ──
// Each scenario takes the three modules { page, collect, status } and runs against the real scripts and, in the last test of
// this section, against a temp copy with one change at a time (each change must make its scenario fail).
export const s4 = (mods, argv, o = {}) => {
  const out = [];
  const err = [];
  const code = mods.status.main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), now: () => NOW, ...o });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
export const snap4 = (dir) => {
  if (!existsSync(dir)) return "(absent)";
  const out = [];
  const walk = (d, pre) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) { out.push(`${pre}${n}/`); walk(f, `${pre}${n}/`); } else out.push(`${pre}${n}:${readFileSync(f, "utf8")}`); } };
  walk(dir, "");
  return out.join("\n");
};
export const samePlace = (a, b) => a.toLowerCase() === realpathSync.native(b).toLowerCase();

// 1. two roadmaps in one repository keep one session file each for the same phase id
export async function scenarioTwoRoadmaps(mods) {
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

// 1. older files, a roadmap the project does not list, the tag, the file name grammar
export async function scenarioOldNames(mods) {
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

// 2. a file that is not standard gives no title and no estimate
export async function scenarioLegacyEstimate(mods) {
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

// 3. a .git that someone else owns is not trusted; the project root's own roadmap is not added when the climb found it
export async function scenarioRepoTrust(mods) {
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

// 5. a roadmap that was not added says why, in fixed words
export const WHY_DEEP = "roadmap not listed: its folder is more than 5 folders below the project root";
export const WHY_NAME = "roadmap not listed: a folder name has a character that is not allowed (letters, digits and . _ @ + ( ) - and space only)";
export const WHY_FULL = "roadmap not listed: the project already lists 10 roadmaps";
export async function scenarioNotAdded(mods) {
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

// 6 and 8. never a folder inside .git, node_modules or .roadmap-backups; the roadmap file must be a real file; the data side refuses them too
export async function scenarioNeverFolders(mods) {
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

// 7. the page does not trust the summary numbers, the written time or the sessions of projects that are not listed
export function scenarioSummaryNumbers(mods) {
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

// 4. a page with more than 25 moving things keeps only the header rule and the running gates moving
export function scenarioCalm(mods) {
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

// ── fix round 5: unlisted folders, an old registry, the session cap, the figures drawn, letter case ──
// A folder whose roadmap path is not usable (too deep, a character that is not allowed) is unlisted: its sessions get a tag
// of their own and the marker unlisted: true, and the older name <id>-<phase>.json is never written for a new session.
// Each scenario takes the three modules { page, collect, status } and runs against the real scripts and, in the last test of
// this section, against a temp copy with one change at a time (each change must make its scenario fail).
export const MARKED = (id, phase, extra = {}) => ({ v: 1, project: id, phase, phase_name: "", step: "build", state: "working", step_started: NOW - MIN, updated: NOW - MIN, ...extra });
export const textOf = (dir, name) => readFileSync(join(dir, name), "utf8");
export const rowsOf = (html) => html.split('<details class="sess"').slice(1).map((r) => r.split("</details>")[0]);
export const rowIds = (html) => [...html.matchAll(/<details class="sess" id="([^"]+)"/g)].map((m) => m[1]);
export async function scenarioUnlisted(mods) {
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

// 1. an unlisted name has a u in it, so no tag, whatever it is, makes it the name of a listed roadmap's file; a phase id that
// looks like a tag plus a phase cannot make one name read as another
export async function scenarioAlias(mods) {
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

// 7. set and clear never read, write, take over or remove an older file, from any folder of the project
export async function scenarioOldUntouched(mods) {
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

// 7b. the older file and the new one of one phase are one phase: the newer is shown, the other is dropped without a word
export async function scenarioOldNewest(mods) {
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

// 2. a projects.json from an earlier version keeps working
export async function scenarioOldRegistry(mods) {
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

// 3. the cap of 100 sessions counts only listed projects' sessions and keeps the newest
export async function scenarioCap(mods) {
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

// 3b. a session whose time is far in the future never wins the cap, whatever its time; the cap sorts by updated, not by step_started
export async function scenarioSkewCap(mods) {
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
export async function scenarioCapKey(mods) {
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

// 3c. a data folder that only grows: only the newest 250 files by modified time are opened, and the rest are counted as left out
export async function scenarioReads(mods) {
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

// 4. the page draws the rows itself, so it never shows more than it draws
export function scenarioSmallerFigure(mods) {
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

// 5. the letter case of a roadmap path counts only where the file system keeps it; a file name carries a lower-case phase
export async function scenarioCaseNames(mods) {
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

// ── fix round 6: older files are only read, the session reads are bounded, the cap, letter case, a hostile figure, a registry with repeats ──
// Each scenario takes the three modules { page, collect, status } and runs against the real scripts and, in the last test of
// this section, against a temp copy with one change at a time (each change must make its scenario fail).

// 4. a session's roadmap is matched to a listed one with its letter case ignored only where the file system ignores it
export async function scenarioFold(mods) {
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

// 6. a hostile summary cannot claim a million files or a million names
export function scenarioLegacyClamp(mods) {
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

// 7. a stored list with entries that become the same path once cleaned keeps one of them
export async function scenarioDupRoadmaps(mods) {
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

// 8. 100 sessions with the longest trails and long names still make a page under the hard limit
export async function scenarioHundred(mods) {
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

// ── final fixes: an older-form file against one or two tagged files; repeated roadmap entries in collect, the page and status ──
// A. an older-form file displaces a tagged file only when it is the only tagged file of that project and phase
export async function scenarioOldTwoRoadmaps(mods) {
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

// B. roadmap entries that are the same path are one, in collect, in the page and in status
export async function scenarioDupRegistry(mods) {
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
export function scenarioDupPage(mods) {
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
export function scenarioDupFold(mods) {
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

// ── each change to a script makes its round 6 scenario fail ─────────────────
// (some of these put back code that this round removed, so the scenario that proves it is gone is shown to catch it)
export function round6Cases() {
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
  return cases;
}
// The round 6 sweep has 38 cases, which take about 40 seconds one after the other (they are CPU work, so running them side by side in one process
// gains nothing). They run as two tests in two files, the first ROUND6_SPLIT cases in one and the rest in the other, so the runner runs them in parallel.
export const ROUND6_SPLIT = 14;
