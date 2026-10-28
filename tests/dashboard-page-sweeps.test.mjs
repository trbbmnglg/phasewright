// Run with: node --test tests/dashboard-page-sweeps.test.mjs
// The mutation sweeps of fix round 2, strict display, and fix rounds 4 and 5: each change, made on its own in a temp copy of the scripts, must make its scenario fail.
// The scenarios are in tests/helpers/dashboard-page.mjs (or in this file, when only the sweep uses one); here they run against the changed copies. Up to four cases run at the same time.
// This file is one of five (dashboard-page.test.mjs, dashboard-page-rounds.test.mjs, dashboard-page-sweeps.test.mjs, dashboard-page-sweeps-6.test.mjs, dashboard-page-sweeps-6b.test.mjs) that came from one 4,000-line file;
// the helpers they share are in tests/helpers/dashboard-page.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { main as status } from "../plugins/phased-shipping/skills/dashboard/scripts/status.mjs";
import { main as collect } from "../plugins/phased-shipping/skills/dashboard/scripts/collect.mjs";
import { main as page } from "../plugins/phased-shipping/skills/dashboard/scripts/page.mjs";
import { st, roadmap, count, runSweep, scenarioOut, scenarioColon, scenarioUnregister, scenarioRunning, scenarioHard, scenarioNoteEdge, scenarioStrictFiles, scenarioStrictPage, scenarioTwoRoadmaps, scenarioOldNames, scenarioLegacyEstimate, scenarioRepoTrust, scenarioNotAdded, scenarioNeverFolders, scenarioSummaryNumbers, scenarioCalm, scenarioUnlisted, scenarioAlias, scenarioOldRegistry, scenarioCap, scenarioSmallerFigure, scenarioCaseNames } from "./helpers/dashboard-page.mjs";


// ── the changes above, each one made on its own in a temp copy of the scripts: every one is caught ──
function fixRound2Cases() {
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
  return cases;
}
test("fix round 2: each change below, made in a copy of the scripts, makes its scenario fail", async () => {
  assert.equal(await runSweep(fixRound2Cases()), 7, "every case of the sweep ran");
});
function strictCases() {
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
  return cases;
}
test("strict: the rule is in the scripts: each change makes the scenarios fail", async () => {
  assert.equal(await runSweep(strictCases()), 13, "every case of the sweep ran");
});

// ── each change to a script makes its scenario fail ─────────────────────────
function round4Cases() {
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
  return cases;
}
test("round 4: the rules are in the scripts: each change makes its scenario fail", async () => {
  assert.equal(await runSweep(round4Cases()), 26, "every case of the sweep ran");
});

// ── each change to a script makes its round 5 scenario fail ─────────────────
function round5Cases() {
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
  return cases;
}
test("round 5: the rules are in the scripts: each change makes its scenario fail", async () => {
  assert.equal(await runSweep(round5Cases()), 25, "every case of the sweep ran");
});

// A sweep must never lose a mutant: the number of cases in each one is pinned here, so a case that is removed or weakened to nothing shows up.
test("mutation sweeps: the mutant count of each sweep in dashboard-page-sweeps.test.mjs is unchanged", () => {
  assert.deepEqual(
    { fixRound2Cases: fixRound2Cases().length, strictCases: strictCases().length, round4Cases: round4Cases().length, round5Cases: round5Cases().length },
    { fixRound2Cases: 7, strictCases: 13, round4Cases: 26, round5Cases: 25 },
  );
});
