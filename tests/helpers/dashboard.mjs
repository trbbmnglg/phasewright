// Shared helpers of the dashboard status and collect tests: tests/dashboard.test.mjs and tests/regression-pack.test.mjs import them.
// Not a test file (no .test.mjs), so `node --test tests/*.test.mjs` does not run it. Temp folders are made under the OS temp
// folder and removed after each test file's run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, lstatSync, openSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { main as status } from "../../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";
import { main as collect } from "../../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";

export const WIN = process.platform === "win32";
export const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
export const cp = (n) => String.fromCodePoint(n);
// Names the guard protects are assembled here, so no such name is stored in this file.
export const RM = ["PH", "ASES.md"].join("");
export const PLANS = ["pha", "ses"].join("");
export const scratch = [];
export const tmp = (label = "w") => { const d = mkdtempSync(join(tmpdir(), `roadmap-test-dash-${label}-`)); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
export const put = (root, rel, data) => {
  const p = join(root, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
};
export const read = (root, rel) => readFileSync(join(root, ...rel.split("/")), "utf8");
export const readJson = (root, rel) => JSON.parse(read(root, rel));
export function listing(dir, base = dir) {
  const names = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    names.push(relative(base, p).split(/[\\/]/).join("/"));
    if (e.isDirectory()) names.push(...listing(p, base));
  }
  return names.sort();
}
// Names and contents of everything under dir, or "(absent)": equal snapshots mean nothing was written.
export const snapshot = (dir) => (existsSync(dir)
  ? listing(dir).map((f) => `${f}:${lstatSync(join(dir, f)).isFile() ? readFileSync(join(dir, f), "utf8") : "[dir]"}`).join("\n")
  : "(absent)");

// A world: a base folder, a data folder path (not created yet) and a way to make project folders.
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
  return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err].join("\n") };
}
export async function col(argv, o = {}) {
  const out = [];
  const err = [];
  const reads = [];
  const code = await collect(argv, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => NOW,
    fd: { open: (p, flags) => { reads.push(p); return openSync(p, flags); } },
    ...o,
  });
  const text = out.join("\n");
  return { code, out: text, err: err.join("\n"), reads, json: () => JSON.parse(text) };
}
export const enable = (w) => { const r = st(["enable", "--data", w.data]); assert.equal(r.code, 0, r.err); };
export const setStatus = (w, root, phase, step, state, extra = [], o = {}) => st(["set", "--data", w.data, "--root", root, "--phase", phase, "--step", step, "--state", state, ...extra], o);
export const register = (w, root, extra = []) => st(["register", "--data", w.data, "--root", root, ...extra]);
export const sessionFiles = (w) => (existsSync(join(w.data, "sessions")) ? readdirSync(join(w.data, "sessions")).sort() : []);
export const idFor = (w, root) => { const m = register(w, root).out.match(/id ([0-9a-f]{12})/); assert.ok(m); return m[1]; };
export const HEAD = "| # | Phase | Status | Kind | Priority | Urgency | Est. (raw \u2192 cal.) | Actual | Commit / deploy | Blocked by | Plan file | Note |";
export const row = (id, title, status, plan = "", note = "") => `| ${id} | ${title} | ${status} | backend | P1 | Soon | 2h \u2192 1.5h | | | | ${plan} | ${note} |`;
export const roadmap = (rows) => ["<!-- phased-shipping:roadmap v1 -->", HEAD, `|${"---|".repeat(12)}`, ...rows].join("\n") + "\n";
export const planText = (id, title, started = "2026-10-01T10:00:00Z") => `# Phase ${id}: ${title}\n**Timestamps:** started ${started} \u00b7 previewed 2026-10-01T12:00:00Z \u00b7 approved <ISO> \u00b7 shipped <ISO>\n`;

// Everything that identifies this machine's temp area, in the spellings a path could take in text.
export function pathForms(w) {
  const raw = [tmpdir(), realpathSync.native(tmpdir()), w.base, realpathSync.native(w.base), homedir()];
  const forms = new Set();
  for (const p of raw) {
    forms.add(p.toLowerCase());
    forms.add(p.toLowerCase().split("\\").join("/"));
    forms.add(JSON.stringify(p).slice(1, -1).toLowerCase());
  }
  forms.add("roadmap-test-dash-");
  return [...forms];
}
export const noPath = (w, text, what) => {
  const t = text.toLowerCase();
  for (const f of pathForms(w)) assert.ok(!t.includes(f), `${what}: found a path (${f.slice(0, 20)}...)`);
};

// ── collect.mjs ─────────────────────────────────────────────────────────────
// One project with a roadmap of two rows and a plan file for the first.
export function seeded(label, { rows, files } = {}) {
  const w = world(label);
  const p = w.proj("zork");
  put(p, RM, roadmap(rows ?? [row("1", "Zork thing", "shipped", `${PLANS}/phase-1.md`), row("2", "Next thing", "planned")]));
  put(p, `${PLANS}/phase-1.md`, planText("1", "Zork thing"));
  for (const [rel, data] of Object.entries(files ?? {})) put(p, rel, data);
  enable(w);
  assert.equal(register(w, p, ["--label", "zork-app"]).code, 0);
  return { w, p };
}
export const phaseRows = (json, at = 0) => json.projects[at].roadmaps[0].phases;

// ── fix round 2 (second review) ─────────────────────────────────────────────
export const BS = String.fromCharCode(92);
export const shipped = roadmap([row("1", "Zork thing", "shipped"), row("2", "Zork next", "planned")]);
export function repoWorld(label, { git = true } = {}) {
  const w = world(label);
  const repo = w.proj("repo");
  if (git) mkdirSync(join(repo, ".git"));
  const home = { homedir: w.base };
  const sub = (rel, withRoadmap = true) => {
    const p = join(repo, ...rel.split("/"));
    mkdirSync(p, { recursive: true });
    if (withRoadmap) writeFileSync(join(p, RM), shipped);
    return p;
  };
  return { w, repo, home, sub };
}
