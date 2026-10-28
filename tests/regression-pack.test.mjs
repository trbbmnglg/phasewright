// Run with: node --test tests/regression-pack.test.mjs
// The regression pack: the probes that every security review of the dashboard repeats, collected in one file so `npm run verify:fast` runs them
// and a reviewer can be told "the regression pack passed (N tests)" instead of re-deriving them. Each test is moved here unchanged from
// tests/dashboard-page*.test.mjs or tests/dashboard.test.mjs, with its name and assertions as they were:
//   the hostile-string page render, the --out spellings, writes while the dashboard is off, user text in paths, absolute paths in output,
//   the CSP script hash, no network sources, reduced motion and print kept static, and the escaping of every rendered field.
// The helpers are in tests/helpers/dashboard-page.mjs and tests/helpers/dashboard.mjs. Every folder is a synthetic temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { main as status } from "../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";
import * as collectModule from "../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import { main as collect, collectData } from "../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import { main as page, renderPage, loadAssets, buildPage } from "../plugins/phased-shipping/skills/dashboard/scripts/page.mjs";
import { homedir } from "node:os";
import { ASSETS, MIN, NOW, cp, RM, put, readJson, listing, world, st, col, pg, enable, setStatus, idFor, sname, rowE, roadmap, noPath, HOSTILE, stripB64, scriptOf, cssOf, count, richWorld, sr, setArgs, pageFile, fakeData, BS, REAL, uncSpellings, scenarioOut, scenarioColon, ph, pj, htmlOf, MEDIA_MOTION, cssRules, declarations, scenarioSmallerFigure } from "./helpers/dashboard-page.mjs";
import * as dash from "./helpers/dashboard.mjs";

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
  // the page without its one script: from the first <script> to the last </script>, found by position, not by a pattern
  const scriptAt = html.indexOf("<script>");
  const scriptEnd = html.lastIndexOf("</script>");
  const markup = scriptEnd >= scriptAt + "<script>".length && scriptAt >= 0 ? html.slice(0, scriptAt) + html.slice(scriptEnd + "</script>".length) : html;
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
test("--out: a file name with a dollar sign and a colon is refused on every platform (the colon rule has no exception)", async () => {
  await scenarioColon(REAL);
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
test("round 5, 4: a hostile summary figure is never shown above the rows the page draws", () => {
  scenarioSmallerFigure(REAL);
});

// ── probes moved from tests/dashboard.test.mjs (that file's helpers, in their own block) ──
{
  const { WIN, NOW, cp, RM, PLANS, put, read, readJson, listing, snapshot, world, st, col, enable, setStatus, register, sessionFiles, idFor, row, roadmap, noPath, seeded, phaseRows, BS, repoWorld } = dash;

// ── status.mjs: off by default ──────────────────────────────────────────────
test("status: a fresh data folder is off: state and set write nothing, and set exits 0", () => {
  const w = world("off");
  const p = w.proj();
  const s = st(["state", "--data", w.data]);
  assert.equal(s.code, 0, s.err);
  assert.ok(s.out.includes("dashboard: off") && s.out.includes("asked: no"));
  const r = setStatus(w, p, "1", "build", "working", ["--label", "zork"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("dashboard is off; nothing written"));
  for (const argv of [["clear", "--data", w.data, "--root", p, "--phase", "1"], ["list", "--data", w.data]]) assert.equal(st(argv).code, 0);
  assert.ok(!existsSync(w.data), "no data folder was created");
});
test("status: disable then set writes nothing, and a session file already there is untouched", () => {
  const w = world("disable");
  const p = w.proj();
  enable(w);
  setStatus(w, p, "1", "build", "working");
  assert.equal(st(["disable", "--data", w.data]).code, 0);
  const before = snapshot(w.data);
  const r = setStatus(w, p, "1", "ship", "working", ["--label", "other"], { now: () => NOW + 1000 });
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("dashboard is off; nothing written"));
  assert.equal(st(["clear", "--data", w.data, "--root", p, "--phase", "1"]).code, 0);
  assert.equal(snapshot(w.data), before);
  assert.ok(st(["state", "--data", w.data]).out.includes("dashboard: off"));
});
test("status: text fields are cleaned of control, bidirectional, zero-width, tag and format characters, and capped", () => {
  const w = world("clean");
  const p = w.proj();
  enable(w);
  const hostile = ["a", cp(0x1b), "[31m", cp(0x202e), "b", cp(0x200b), "c", cp(0xe0041), "d", cp(0x0a), "e", cp(0xad), cp(0x61c), cp(0x2066), "f"].join("");
  const r = setStatus(w, p, "1", "build", "working", ["--name", hostile, "--label", hostile]);
  assert.equal(r.code, 0, r.err);
  const s = readJson(w.data, `sessions/${sessionFiles(w)[0]}`);
  assert.equal(s.phase_name, "a [31m b c d e f");
  assert.equal(readJson(w.data, "projects.json").projects[0].labels[0], "a [31m b c d e f");
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(read(w.data, "projects.json").replace(/\r?\n/g, "")), "no control or format character reached the file");
  setStatus(w, p, "2", "build", "working", ["--name", "x".repeat(500)]);
  assert.equal(readJson(w.data, `sessions/${sessionFiles(w)[1]}`).phase_name.length, 200);
  const odd = join(w.base, `z${cp(0x202e)}ork${cp(0x200b)}`);
  let made = true;
  try { mkdirSync(odd); } catch { made = false; }
  if (made) {
    const id = idFor(w, odd);
    const e = readJson(w.data, "projects.json").projects.find((x) => x.id === id);
    assert.ok(!/[\p{Cc}\p{Cf}]/u.test(e.name), "a folder name with format characters is cleaned");
  }
});
test("status: list prints no absolute path unless --paths, and clear removes one session file", () => {
  const w = world("list");
  const p = w.proj("zork");
  enable(w);
  setStatus(w, p, "1", "build", "working", ["--label", "zork-app"]);
  setStatus(w, p, "2", "build", "working");
  const plain = st(["list", "--data", w.data]);
  assert.equal(plain.code, 0);
  assert.ok(plain.out.includes("zork") && plain.out.includes("zork-app") && plain.out.includes(RM));
  noPath(w, plain.all, "list");
  const paths = st(["list", "--data", w.data, "--paths"]);
  assert.ok(paths.out.toLowerCase().includes(realpathSync.native(p).toLowerCase()));
  const c = st(["clear", "--data", w.data, "--root", p, "--phase", "1"]);
  assert.equal(c.code, 0);
  assert.equal(sessionFiles(w).length, 1);
  assert.ok(st(["clear", "--data", w.data, "--root", p, "--phase", "1"]).out.includes("no status file"));
  noPath(w, [st(["state", "--data", w.data]).all, c.all].join("\n"), "state and clear");
});
test("collect: a bad session file is skipped and reported by base name only, and its contents never reach the output", async () => {
  const { w, p } = seeded("badsess");
  setStatus(w, p, "1", "build", "working");
  const id = readJson(w.data, "projects.json").projects[0].id;
  const good = { v: 1, project: id, phase: "x", phase_name: "n", step: "build", state: "working", step_started: NOW, updated: NOW };
  const sdir = join(w.data, "sessions");
  const bad = {
    [`${id}-json.json`]: `{ "oops": "MARK_JSON" `,
    [`${id}-types.json`]: JSON.stringify({ ...good, phase: "types", phase_name: 5, note: "MARK_TYPES" }),
    [`${id}-step.json`]: JSON.stringify({ ...good, phase: "step", step: "MARK_STEP" }),
    [`${id}-state.json`]: JSON.stringify({ ...good, phase: "state", state: "MARK_STATE" }),
    [`${id}-time.json`]: JSON.stringify({ ...good, phase: "time", updated: "MARK_TIME" }),
    [`${id}-name.json`]: JSON.stringify({ ...good, phase: "other", note: "MARK_NAME" }),
    [`${id}-huge.json`]: JSON.stringify({ ...good, phase: "huge", phase_name: "MARK_HUGE".repeat(3000) }),
    "notasession.json": "MARK_NAME_FILE",
  };
  for (const [name, data] of Object.entries(bad)) writeFileSync(join(sdir, name), data);
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const j = r.json();
  assert.deepEqual(j.sessions.map((s) => s.phase), ["1"], "only the good session is shown");
  assert.deepEqual(j.errors.map((e) => e.file).sort(), [`${id}-huge.json`, `${id}-json.json`, `${id}-name.json`, `${id}-state.json`, `${id}-step.json`, `${id}-time.json`, `${id}-types.json`, "notasession.json"].sort());
  assert.ok(!/MARK_/.test(r.out), "no content of a bad file is in the output");
  assert.ok(j.errors.every((e) => Object.keys(e).join() === "file,reason"));
});

// ── collect.mjs: hostile input, caps, no absolute path ──────────────────────
test("collect: hostile roadmap text cannot inject control characters or grow without limit", async () => {
  const evil = ["a", cp(0x1b), "[2J", cp(0x202e), "b", cp(0x200b), cp(0xe0041), cp(0x0d), "c"].join("");
  const { w } = seeded("hostile", { rows: [row("1", evil, "planned"), row("2", "t".repeat(5000), "planned"), row("3", "Plan", "planned", `${PLANS}/${cp(0x1b)}x.md`), row("4", "Url", "planned", "https://example.invalid/x.md"), row("5", "Colon", "planned", `${PLANS}/a:b.md`)] });
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const rows = phaseRows(r.json());
  assert.equal(rows[0].phase, "a [2J b c");
  assert.equal(rows[1].phase.length, 200);
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(r.out.replace(/\n/g, "")), "no control or format character is in the output");
  assert.ok(r.json().projects[0].errors.some((e) => /not a usable plan file path/.test(e.reason)));
});
test("collect: the output holds no absolute path, and a project path that appears in a title is removed", async () => {
  const w = world("nopath");
  const p = w.proj("zork");
  const real = realpathSync.native(p);
  put(p, RM, roadmap([row("1", `see ${real} now`, "planned", "../outside.md"), row("2", `and ${real.split("\\").join("/")} too`, "planned")]));
  enable(w);
  setStatus(w, p, "1", "build", "working", ["--name", `at ${real}`]);
  put(w.data, "sessions/notasession.json", real);
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  JSON.parse(r.out);
  noPath(w, r.out, "collect output");
  assert.ok(r.out.includes("[path]"), "the path in a title was removed");
  noPath(w, r.err, "collect errors");
  // the failure messages name no path either
  const bad = await col(["--data", join(w.base, "gone", "deeper")]);
  noPath(w, bad.err + bad.out, "an absent data folder");
  const usage = await col(["--out"]);
  noPath(w, usage.err, "usage");
});

// 4. The JSON is safe to inline and to read back.
test("collect: HTML and Markdown in roadmap and session text come out as plain text, with < > & written as escapes, on stdout and in --out", async () => {
  const hostile = ["</script><img src=x onerror=alert(1)>", "[x](javascript:alert(1))", "a & b <b>bold</b> &amp; &lt;"];
  const { w, p } = seeded("escape", { rows: hostile.map((h, i) => row(String(i + 1), h, "planned")) });
  setStatus(w, p, "1", "build", "working", ["--name", "<img src=x onerror=1> & more"]);
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!/[<>&]/.test(r.out), "no raw < > & anywhere in the output");
  assert.ok(r.out.includes("\\u003c/script\\u003e\\u003cimg src=x onerror=alert(1)\\u003e"), "the script closer is escaped");
  assert.ok(r.out.includes("\\u0026"));
  const j = r.json();
  assert.deepEqual(phaseRows(j).map((x) => x.phase), hostile, "the values read back as written");
  assert.equal(j.sessions[0].phase_name, "<img src=x onerror=1> & more");
  const target = join(w.base, "page.json");
  const o = await col(["--data", w.data, "--out", target]);
  assert.equal(o.code, 0, o.err);
  const file = readFileSync(target, "utf8");
  assert.ok(!/[<>&]/.test(file), "no raw < > & in the --out file");
  assert.deepEqual(JSON.parse(file), j);
});

// 6. Paths inside text copied from a file, and keys.
test("collect: this machine's project, data and home folder paths inside a roadmap cell become [path] in values only", async () => {
  const w = world("cellpath");
  const p = w.proj("zork");
  const real = realpathSync.native(p);
  const home = homedir();
  const slashed = (s) => s.split("\\").join("/");
  const cells = [`in ${real} and ${home} too`, `${slashed(real)}/sub and ${slashed(home)}/x`, `${w.data} then ${real}`];
  if (WIN) cells.push(`${real.toUpperCase()} and ${home.toLowerCase()}`);
  put(p, RM, roadmap(cells.map((c, i) => row(String(i + 1), c, "planned", "", `see ${real}`))));
  enable(w);
  assert.equal(register(w, p).code, 0);
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const rows = phaseRows(r.json());
  assert.equal(rows[0].phase, "in [path] and [path] too");
  assert.equal(rows[1].phase, "[path]/sub and [path]/x");
  assert.equal(rows[2].phase, "[path] then [path]");
  if (WIN) assert.equal(rows[3].phase, "[path] and [path]", "letter case does not matter on Windows");
  const lower = r.out.toLowerCase();
  for (const form of [real, slashed(real), home, slashed(home), JSON.stringify(real).slice(1, -1), JSON.stringify(home).slice(1, -1), w.data, JSON.stringify(w.data).slice(1, -1)]) assert.ok(!lower.includes(form.toLowerCase()), `a path is left in the output: ${form.slice(0, 12)}`);
  assert.ok(rows.every((x) => x.phase.includes("[path]")));
});
test("collect: a hand-edited project path such as a plain word cannot rename a key in the output", async () => {
  const w = world("keys");
  const dataDir = w.data;
  mkdirSync(dataDir);
  const entry = { id: "0123456789ab", path: "name", name: "name", labels: ["status"], roadmaps: [RM], added: "2026-10-27T00:00:00.000Z" };
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({ v: 1, projects: [entry, { ...entry, id: "ba9876543210", path: "ok", name: "errors" }] }));
  const r = await col(["--data", dataDir]);
  assert.equal(r.code, 0, r.err);
  const j = r.json();
  for (const proj of j.projects) assert.equal(Object.keys(proj).join(), "id,name,status,roadmaps,history,errors,summary");
  assert.deepEqual(j.projects.map((x) => x.name), ["name", "errors"], "a value that is not an absolute path is left as it is");
  assert.equal(Object.keys(j).join(), "v,generatedAt,thresholds,projects,sessions,warnings,errors");
  assert.ok(r.out.includes('"name": "name"'));
});
const ZW = cp(0x200b);
// Folder prefixes of other users, kept in variables so no machine path is written out in this file.
const SLU = "/Users/";
const SLH = "/home/";

// 4. Redaction of more spellings of a path.
test("collect: known spellings of this machine's paths become [path]: mixed and doubled separators, URL-encoded, 8.3 and Git Bash user folders, a hidden character inside", async () => {
  const w = world("spell");
  const p = w.proj("zork");
  const real = realpathSync.native(p);
  const lead = real.startsWith("/") ? "/" : "";
  const segs = real.split(/[\\/]+/).filter(Boolean);
  const enc = (s) => s.split(":").join("%3A");
  const forms = [
    lead + segs.join("/"),
    lead + segs.join(BS),
    lead + segs.join(BS + BS),
    lead + segs.join("//"),
    lead + segs.map((s, i) => (i === 0 ? s : `${i % 2 ? "/" : BS}${s}`)).join(""),
    (lead ? "%2F" : "") + segs.map(enc).join("%5C"),
    (lead ? "%2f" : "") + segs.map((s) => s.split(":").join("%3a")).join("%5c"),
    real.slice(0, 12) + ZW + real.slice(12),
    real.slice(0, 20) + cp(0x202e) + cp(7) + real.slice(20),
  ];
  const users = [
    [`C:${BS}Users${BS}quuxuser${BS}Documents`, `[path]${BS}Documents`],
    [`C:${BS}Users${BS}QUUXUS~1.YY${BS}AppData`, `[path]${BS}AppData`],
    [`/c${SLU}quuxuser/x`, "[path]/x"],
    [`/mnt/c${SLU}quuxuser/x`, "[path]/x"],
    [`${SLU}quuxuser/x`, "[path]/x"],
    [`${SLH}quuxuser/x`, "[path]/x"],
    [`C:${BS}Users/quuxuser/x`, "[path]/x"],
    [`C:${BS}${BS}Users${BS}${BS}quuxuser${BS}${BS}x`, `[path]${BS}${BS}x`],
    ["C%3A%5CUsers%5Cquuxuser%5Cx", "[path]%5Cx"],
    ["c%3a%5cusers%5cquuxuser%5cx", "[path]%5cx"],
    ["D:/users/quuxuser/x", "[path]/x"],
    [`file:///C:${SLU}quuxuser/x`, "file:///[path]/x"],
    [`C:${BS}Users${BS}quu${ZW}xuser${BS}x`, `[path]${BS}x`],
    [`"C:${BS}Users${BS}quuxuser", ok`, `"[path]", ok`],
  ];
  const kept = [`C:${BS}Users alone`, "no path /home here", "a /Users/ folder", "see /homes/x and /home", `C:${BS}Users${BS} gap`];
  const titles = [...forms.map((f) => `see ${f}/sub now`), ...users.map(([f]) => `at ${f} end`), ...kept];
  put(p, RM, roadmap(titles.map((t, i) => row(String(i + 1), t, "planned"))));
  enable(w);
  assert.equal(register(w, p).code, 0);
  const r = await col(["--data", w.data]);
  assert.equal(r.code, 0, r.err);
  const got = phaseRows(r.json()).map((x) => x.phase);
  forms.forEach((f, i) => assert.equal(got[i], "see [path]/sub now", `spelling ${i}`));
  users.forEach(([, expected], i) => assert.equal(got[forms.length + i], `at ${expected} end`, `user form ${i}`));
  kept.forEach((k, i) => assert.equal(got[forms.length + users.length + i], k, `left alone: ${k}`));
  assert.ok(!r.out.includes("quuxuser") && !r.out.toLowerCase().includes("roadmap-test-dash-"), "no user name and no temp folder name is left");
  // this run's own short (8.3) temp folder name is not left either
  const short = w.base.match(/[\\/]Users[\\/]([^\\/]+)/i)?.[1];
  put(p, RM, roadmap([row("1", `in ${w.base}${BS}x`, "planned"), row("2", `in ${real}${BS}x`, "planned")]));
  const again = await col(["--data", w.data]);
  assert.equal(again.code, 0, again.err);
  if (short) {
    assert.ok(!again.out.includes(short), "the user folder in the temp path is not left");
    // only where the temp folder sits under a user folder (Windows) is the temp base itself redacted
    assert.ok(phaseRows(again.json())[0].phase.startsWith("in [path]"), "the user folder of a temp base under it becomes [path]");
  }
  // on every platform the registered project path becomes [path]
  const rows2 = phaseRows(again.json());
  assert.equal(rows2[1].phase, "in [path]" + BS + "x", "the registered project path becomes [path]");
  assert.ok(again.out.includes("[path]"));
});
test("status: while the dashboard is off, a run from a repository subfolder writes nothing", () => {
  const { w, repo, home, sub } = repoWorld("off-sub");
  const given = sub("docs/roadmap");
  const r = setStatus(w, given, "1", "build", "working", [], home);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("nothing written"));
  assert.ok(!existsSync(w.data));
  assert.equal(st(["clear", "--data", w.data, "--root", given, "--phase", "1"], home).code, 0);
  assert.ok(!existsSync(w.data));
  assert.deepEqual(listing(repo).filter((f) => f.includes("projects.json") || f.includes("sessions")), []);
});
}
