// Run with: node --test tests/dashboard-page-rounds.test.mjs
// Covers the same scripts as dashboard-page.test.mjs: the fix-round 2 scenarios (--out spellings, the page size limits, a removed project), the look of the page, the
// title block and estimate, strict roadmap display, and fix rounds 4 to 6 (roadmap-keyed sessions, repository trust, notes, the calm page, unlisted folders, an old registry,
// the session cap, older files that are only read, bounded reads, repeated roadmap entries). Each scenario runs against the real scripts in these tests; the sweeps that run it against changed copies are in
// dashboard-page-sweeps.test.mjs and dashboard-page-sweeps-6.test.mjs.
// This file is one of five (dashboard-page.test.mjs, dashboard-page-rounds.test.mjs, dashboard-page-sweeps.test.mjs, dashboard-page-sweeps-6.test.mjs, dashboard-page-sweeps-6b.test.mjs) that came from one 4,000-line file;
// the helpers they share are in tests/helpers/dashboard-page.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { main as status } from "../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";
import { main as collect, collectData } from "../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import { main as page, renderPage } from "../plugins/phased-shipping/skills/dashboard/scripts/page.mjs";
import { HERE, SKILL, ASSETS, MIN, NOW, RM, put, readJson, listing, world, st, col, enable, rowE, roadmap, HOSTILE, scriptOf, cssOf, count, sr, setArgs, pageFile, fakeProject, fakeSession, fakeData, KB, bytesOf, LEFT_OUT, blockOf, CLIENT_SRC, T0, stubEl, runClient, REAL, bigRoadmap, scenarioUnregister, scenarioRunning, scenarioHard, scenarioNoteEdge, ph, pj, htmlOf, MEDIA_MOTION, cssRules, declarations, titleBlockOf, cell, rec, estRows, legacyMd, draw, scenarioStrictFiles, strictSummary, scenarioStrictPage, scenarioTwoRoadmaps, scenarioOldNames, scenarioLegacyEstimate, scenarioRepoTrust, scenarioNotAdded, scenarioNeverFolders, scenarioSummaryNumbers, scenarioCalm, scenarioUnlisted, scenarioAlias, scenarioOldUntouched, scenarioOldNewest, scenarioOldRegistry, scenarioCap, scenarioSkewCap, scenarioCapKey, scenarioReads, scenarioCaseNames, scenarioFold, scenarioLegacyClamp, scenarioDupRoadmaps, scenarioHundred, scenarioOldTwoRoadmaps, scenarioDupRegistry, scenarioDupPage, scenarioDupFold } from "./helpers/dashboard-page.mjs";


// ── fix round 2 ─────────────────────────────────────────────────────────────
// A text of the repository's files, read from the repository root.
const repoText = (...parts) => readFileSync(join(HERE, "..", ...parts), "utf8");
test("unregister: a malformed session file of the removed project is neither read nor reported, and the page has no trace of it", async () => {
  await scenarioUnregister(REAL);
});
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
test("big page: a page between 256 KB and 1 MB is written, by the rebuild and by the command, with the real limit and no seam", async () => {
  await scenarioHard(REAL);
});
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
// The page without its stylesheet, so a class name is looked for in the markup only.
const mu = (projects, sessions = [], o = {}) => htmlOf(projects, sessions, o).replace(/<style>[\s\S]*?<\/style>/, "");
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
test("round 4, 1: two roadmaps in one repository keep their own session file, title, estimate and trail; clear removes only its own; the same-project warning still fires", async () => {
  await scenarioTwoRoadmaps(REAL);
});
test("round 4, 1: older session files are still read and never touched by set or clear; an unlisted roadmap falls back; the tag follows the lower-case path; a wrong tag or shape is skipped", async () => {
  await scenarioOldNames(REAL);
});
test("round 4, 2: a file that is not standard gives no title and no estimate to a session, on the page or in the active estimate", async () => {
  await scenarioLegacyEstimate(REAL);
});
test("round 4, 3: a .git owned by someone else is not trusted (through the user-id seams); the project root's own roadmap is not added by a climb", async () => {
  await scenarioRepoTrust(REAL);
});
test("round 4, 5: a roadmap that is not added says why in one fixed line: too deep, a name with a character that is not allowed, a full list", async () => {
  await scenarioNotAdded(REAL);
});
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
test("round 4, 7: the page recounts a summary number that is not a whole number, shows an unusable written time as unknown, and counts only sessions of listed projects", () => {
  scenarioSummaryNumbers(REAL);
});
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
test("round 5, 1: a folder with no usable roadmap path keeps its own session file, marker and tag: no deletion, no inheritance, clear removes only its own, no estimate or title", async () => {
  await scenarioUnlisted(REAL);
});
test("round 5, 1: an unlisted name has a u in it, so no tag can make it a listed roadmap's file; a phase named like a tag and a phase cannot alias another session's name", async () => {
  await scenarioAlias(REAL);
});
test("round 5, 7: set and clear never read, write, take over or remove an older file, from the root, an unlisted folder, a listed sub-roadmap or a folder too deep to list", async () => {
  await scenarioOldUntouched(REAL);
});
test("round 5, 7: when an older file and a tagged file exist for one project and phase, only the newer is shown (the phase compared without regard to case), and nothing is reported", async () => {
  await scenarioOldNewest(REAL);
});
test("round 5, 2: a projects.json from an earlier version, with roadmaps that are not usable paths, still works for set, list, register and unregister", async () => {
  await scenarioOldRegistry(REAL);
});
test("round 5, 3: files of projects that are not listed do not count toward the 100-session cap, and past it the newest are kept and the drop is reported once", async () => {
  await scenarioCap(REAL);
});
test("round 6, 3: 200 clock-skewed sessions do not push the live ones out of the cap", async () => {
  await scenarioSkewCap(REAL);
});
test("round 6, 3: the cap keeps the newest by updated, not by step_started", async () => {
  await scenarioCapKey(REAL);
});
test("round 6, 2: of 1,000 session files only the newest 250 by modified time are opened; the live ones survive and the rest are counted as left out", async () => {
  await scenarioReads(REAL);
});
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
test("round 6, 4: the case-folded roadmap match is used only where io.caseInsensitive is true, in collect and in the page", async () => {
  await scenarioFold(REAL);
});
test("round 6, 6: a summary with a million legacy files and a hundred thousand names is shown as at most 10,000 files and 10 names", () => {
  scenarioLegacyClamp(REAL);
});
test("round 6, 7: roadmap entries that become the same path once cleaned are one entry when the list is read and written", async () => {
  await scenarioDupRoadmaps(REAL);
});
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
test("final fixes, L1: an older-form file hides a tagged file only when it is the one tagged file of its phase; with two roadmaps both stay and the older-form file goes", async () => {
  await scenarioOldTwoRoadmaps(REAL);
});
test("final fixes, L2: collect reads roadmap entries that are the same path once (letter case through io.caseInsensitive)", async () => {
  await scenarioDupRegistry(REAL);
});
test("final fixes, L2: the page draws roadmap entries that are the same path once (letter case through its caseInsensitive option)", () => {
  scenarioDupPage(REAL);
});
test("final fixes, L2: status compares roadmap entries with the same letter-case fold as the tags, under both io.caseInsensitive settings", () => {
  scenarioDupFold(REAL);
});
