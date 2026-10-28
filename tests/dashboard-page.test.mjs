// Run with: node --test tests/dashboard-page.test.mjs
// Covers phase 7d3, part A: the trail in a session file (status.mjs), the fields collect.mjs adds (loops, rounds,
// workedMs, estimateH, the project summary, archived sessions), and the page (page.mjs with assets/page.css and
// assets/client.js): escaping, the one script and its hash, the shapes it may draw, the nested details, the empty and
// error states, the writes, and the fonts. Every folder is a synthetic temp folder (made-up names such as zork and
// acmecorp), removed afterwards; nothing is written to the real data folder. Control, format and bidirectional
// characters are built with String.fromCodePoint. Nothing here assumes a Windows layout.
// This file is one of five (dashboard-page.test.mjs, dashboard-page-rounds.test.mjs, dashboard-page-sweeps.test.mjs, dashboard-page-sweeps-6.test.mjs, dashboard-page-sweeps-6b.test.mjs) that came from one 4,000-line file;
// the helpers they share are in tests/helpers/dashboard-page.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createHash } from "node:crypto";
import { brotliDecompressSync, brotliCompressSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { main as status } from "../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";
import { main as collect } from "../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import { main as page, renderPage, phaseFlow, loadAssets, buildPage } from "../plugins/phased-shipping/skills/dashboard/scripts/page.mjs";
import { HERE, SKILL, ASSETS, MIN, HOUR, NOW, cp, RM, tmp, put, readJson, listing, world, st, col, pg, enable, setStatus, idFor, sname, hand, rowE, roadmap, noPath, stripB64, scriptOf, cssOf, count, richWorld, sr, setArgs, pageFile, fakeProject, fakeSession, fakeData, KB, bytesOf, LEFT_OUT, blockOf, heavySessions, CLIENT_SRC, T0, stubEl, runClient, ph, cell, rec } from "./helpers/dashboard-page.mjs";


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
  // The file this test came from is now these files, the helpers, and the part of the regression pack that came from it.
  const text = (f) => readFileSync(join(HERE, f), "utf8");
  const src = [
    "dashboard-page.test.mjs", "dashboard-page-rounds.test.mjs", "dashboard-page-sweeps.test.mjs", "dashboard-page-sweeps-6.test.mjs", "dashboard-page-sweeps-6b.test.mjs", "helpers/dashboard-page.mjs",
  ].map(text).concat(text("regression-pack.test.mjs").split("// ── probes moved from tests/dashboard.test.mjs")[0]).join("\n");
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
