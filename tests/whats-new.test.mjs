// Run with: node --test tests/whats-new.test.mjs
// Covers scripts/whats-new.mjs: the CHANGELOG reader (fail closed on text), the block it renders, the --write and --check
// commands on temporary projects, and the real README, CHANGELOG, releases.json and plugin.json of this repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { START, END, parseChangelog, renderBlock, main } from "../scripts/whats-new.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "whats-new.mjs");
const CHANGELOG = "plugins/phased-shipping/CHANGELOG.md";
const PLUGIN_JSON = "plugins/phased-shipping/.claude-plugin/plugin.json";

const scratch = [];
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "whats-new-test-")); scratch.push(d); return d; };

const SA = "Onboarding: survey a project first, then adopt a roadmap.";
const SB = "Every roadmap write keeps a way back, with undo and restore.";
const SC = "A roadmap standard and a script to check it and update it.";
// One CHANGELOG entry; a null date or summary leaves that line out.
const entry = (version, date, summary) =>
  `## ${version}\n\n${date ? `Date: ${date}\n` : ""}${summary ? `Summary: ${summary}\n` : ""}\n### Added\n- something\n\n`;
const logOf = (...entries) => `# Changelog\n\nNewest first.\n\n${entries.join("")}`;
const goodLog = () => logOf(
  entry("0.8.0", "2026-10-27", SA), entry("0.7.1", "2026-10-26", SB), entry("0.7.0", "2026-10-26", SC),
  entry("0.6.0", null, null), entry("0.5.0", null, null));

const releasesOf = (...rows) => rows.map(([version, name, status]) => ({ version, name, status, summary: "x" }));
const RELEASES = releasesOf(["v1.0.0", "Allacapan", "shipped"], ["v1.1.0", "Baggao", "in progress"], ["v1.2.0", "Buguey", "planned"]);
const PLUGIN = { name: "phased-shipping", version: "0.8.0" };

// A temporary project with the four files the script reads.
const project = ({ readme, log = goodLog(), releases = RELEASES, plugin = PLUGIN } = {}) => {
  const root = tmp();
  writeFileSync(join(root, "README.md"), readme ?? `Tagline.\n\n${START}\n${END}\n\n## The problem\n\nText.\n`);
  writeFileSync(join(root, "releases.json"), JSON.stringify({ releases }));
  mkdirSync(join(root, "plugins", "phased-shipping", ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, CHANGELOG), log);
  writeFileSync(join(root, PLUGIN_JSON), JSON.stringify(plugin));
  return root;
};
const run = (argv, root) => {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = main(argv, root); } finally { console.log = log; console.error = error; }
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const readIn = (root, name) => readFileSync(join(root, name), "utf8");
const rejects = (text, ...parts) => {
  assert.throws(() => parseChangelog(text), (e) => parts.every((p) => e.message.includes(p)), `expected an error with: ${parts.join(" | ")}`);
};

test("a valid CHANGELOG gives the newest three entries, newest first, with date and summary", () => {
  assert.deepEqual(parseChangelog(goodLog()), [
    { version: "0.8.0", date: "2026-10-27", summary: SA },
    { version: "0.7.1", date: "2026-10-26", summary: SB },
    { version: "0.7.0", date: "2026-10-26", summary: SC },
  ]);
});

test("CRLF text reads like LF text", () => {
  assert.deepEqual(parseChangelog(goodLog().replace(/\n/g, "\r\n")), parseChangelog(goodLog()));
});

test("the fourth and older entries need no lines, and a heading with extra text is not an entry", () => {
  const text = logOf("## 0.9.0 (draft)\n\nnotes\n\n", entry("0.8.0", "2026-10-27", SA), entry("0.7.1", "2026-10-26", SB),
    entry("0.7.0", "2026-10-26", SC), "## 0.6.0\n\nplain\n\n", "## 0.5.0\n");
  assert.equal(parseChangelog(text).length, 3);
  assert.equal(parseChangelog(text)[0].version, "0.8.0");
});

test("fewer than three entries are all shown; no version heading is an error", () => {
  assert.equal(parseChangelog(logOf(entry("0.8.0", "2026-10-27", SA))).length, 1);
  rejects("# Changelog\n\nNothing here.\n", "no");
});

test("a missing Date or Summary line is an error that names the version", () => {
  rejects(logOf(entry("0.8.0", null, SA), entry("0.7.1", "2026-10-26", SB), entry("0.7.0", "2026-10-26", SC)), "0.8.0", "Date:");
  rejects(logOf(entry("0.8.0", "2026-10-27", SA), entry("0.7.1", "2026-10-26", null), entry("0.7.0", "2026-10-26", SC)), "0.7.1", "Summary:");
  rejects(logOf(entry("0.8.0", "2026-10-27", SA), entry("0.7.1", "2026-10-26", SB), entry("0.7.0", null, null)), "0.7.0");
});

test("the message for a missing line says what to write and where", () => {
  rejects(logOf(entry("0.8.0", "2026-10-27", null)), CHANGELOG, "0.8.0", 'needs a "Summary:" line directly under its heading');
});

test("two Summary lines or two Date lines are an error", () => {
  rejects(logOf(entry("0.8.0", "2026-10-27", `${SA}\nSummary: ${SB}`)), "0.8.0", "more than one", "Summary:");
  rejects(logOf(entry("0.8.0", "2026-10-27\nDate: 2026-10-27", SA)), "0.8.0", "more than one", "Date:");
});

test("lines placed below a ### heading do not count", () => {
  rejects(logOf("## 0.8.0\n\n### Added\nDate: 2026-10-27\nSummary: " + SA + "\n"), "0.8.0", "needs a");
});

test("a date must be written YYYY-MM-DD and be a real calendar date", () => {
  rejects(logOf(entry("0.8.0", "2026-02-30", SA)), "0.8.0", "real calendar date");
  rejects(logOf(entry("0.8.0", "2026-13-01", SA)), "0.8.0", "real calendar date");
  rejects(logOf(entry("0.8.0", "2026-2-3", SA)), "0.8.0", "YYYY-MM-DD");
  rejects(logOf(entry("0.8.0", "27 Oct 2026", SA)), "0.8.0", "YYYY-MM-DD");
  assert.equal(parseChangelog(logOf(entry("0.8.0", "2028-02-29", SA)))[0].date, "2028-02-29");
  rejects(logOf(entry("0.8.0", "2027-02-29", SA)), "0.8.0", "real calendar date");
});

test("versions must go down and dates must not go up, down the file", () => {
  rejects(logOf(entry("0.7.0", "2026-10-26", SC), entry("0.7.1", "2026-10-26", SB)), "0.7.1", "newest to oldest");
  rejects(logOf(entry("0.8.0", "2026-10-27", SA), entry("0.8.0", "2026-10-27", SA)), "0.8.0", "newest to oldest");
  rejects(logOf(entry("0.8.0", "2026-10-25", SA), entry("0.7.1", "2026-10-26", SB)), "0.7.1", "2026-10-26", "dates must not go up");
  // equal dates are fine
  assert.equal(parseChangelog(logOf(entry("0.8.0", "2026-10-26", SA), entry("0.7.1", "2026-10-26", SB))).length, 2);
  // numeric, not text, comparison
  assert.equal(parseChangelog(logOf(entry("0.10.0", "2026-10-27", SA), entry("0.9.0", "2026-10-26", SB))).length, 2);
});

test("a Summary with a character outside the allowlist is an error that names the version and the code point, never the character", () => {
  const bad = ["<", ">", "[", "]", "*", "_", "|", "#", "\\", "{", "}", "@", "$", "%", "^", "~", "=", String.fromCodePoint(0xa0), String.fromCodePoint(9), String.fromCodePoint(0x0d),
    String.fromCodePoint(0x07), String.fromCodePoint(0x1b), String.fromCodePoint(0x7f), String.fromCodePoint(0x200b),
    String.fromCodePoint(0x202e), String.fromCodePoint(0x2028), String.fromCodePoint(0xfeff), String.fromCodePoint(0xe0041),
    String.fromCodePoint(0x1f600)];
  for (const ch of bad) {
    const summary = `${SA.slice(0, 20)}${ch}${SA.slice(20)}`;
    const code = `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    assert.throws(() => parseChangelog(logOf(entry("0.8.0", "2026-10-27", summary))), (e) => {
      assert.ok(e.message.includes("0.8.0"), `names the version for ${code}`);
      assert.ok(e.message.includes(code), `names ${code}`);
      assert.ok(!e.message.includes(ch), `does not print ${code}`);
      return true;
    });
  }
});

test("every character on the allowlist is accepted, and an even number of backticks is fine", () => {
  const s = "Letters 123 . , ; : ' \" ( ) / - + & ! ? and `code` here";
  assert.equal(parseChangelog(logOf(entry("0.8.0", "2026-10-27", s)))[0].summary, s);
});

test("an odd number of backticks and a web address are errors", () => {
  rejects(logOf(entry("0.8.0", "2026-10-27", `${SA} \``)), "0.8.0", "backtick");
  rejects(logOf(entry("0.8.0", "2026-10-27", "See https://example.com for the whole story")), "0.8.0", "web address");
  rejects(logOf(entry("0.8.0", "2026-10-27", "See www.example.com for the whole story here")), "0.8.0", "web address");
});

test("a Summary must be 20 to 160 characters", () => {
  rejects(logOf(entry("0.8.0", "2026-10-27", "Too short.")), "0.8.0", "20 to 160");
  rejects(logOf(entry("0.8.0", "2026-10-27", "a".repeat(161))), "0.8.0", "20 to 160");
  assert.equal(parseChangelog(logOf(entry("0.8.0", "2026-10-27", "a".repeat(20))))[0].summary.length, 20);
  assert.equal(parseChangelog(logOf(entry("0.8.0", "2026-10-27", "a".repeat(160))))[0].summary.length, 160);
  rejects(logOf(entry("0.8.0", "2026-10-27", "a".repeat(19))), "0.8.0", "20 to 160");
});

test("the Summary line must read 'Summary: text'", () => {
  rejects(logOf("## 0.8.0\n\nDate: 2026-10-27\nSummary:" + SA + "\n\n### Added\n"), "0.8.0", "Summary: <text>");
});

test("the block: banner, heading, three one-line bullets newest first, then the history link", () => {
  const block = renderBlock({ entries: parseChangelog(goodLog()), releases: RELEASES, plugin: PLUGIN });
  assert.equal(block, [
    "> **Work in progress.** Phasewright is built in the open. Release v1.1.0 (Baggao) is being built, so interfaces and file formats may still change; see [Releases](#releases).",
    "",
    "## What's new",
    "",
    `- **phased-shipping 0.8.0** (2026-10-27): ${SA}`,
    `- **phased-shipping 0.7.1** (2026-10-26): ${SB}`,
    `- **phased-shipping 0.7.0** (2026-10-26): ${SC}`,
    "",
    "Full history: [phased-shipping changelog](plugins/phased-shipping/CHANGELOG.md).",
  ].join("\n"));
});

test("the banner follows the first in-progress release, and falls back when none is in progress", () => {
  const entries = parseChangelog(goodLog());
  const two = releasesOf(["v1.0.0", "Allacapan", "shipped"], ["v1.3.0", "Camalaniugan", "in progress"], ["v1.4.0", "Gattaran", "in progress"]);
  assert.ok(renderBlock({ entries, releases: two, plugin: PLUGIN }).includes("Release v1.3.0 (Camalaniugan) is being built"));
  const none = renderBlock({ entries, releases: releasesOf(["v1.0.0", "Allacapan", "shipped"], ["v1.2.0", "Buguey", "planned"]), plugin: PLUGIN });
  assert.ok(none.startsWith("> **Under active development.** Interfaces and file formats may still change; see [Releases](#releases)."));
  assert.ok(!none.includes("Work in progress"));
});

test("the block has no HTML, no raw web address, one line per bullet, and at most 110 words", () => {
  const block = renderBlock({ entries: parseChangelog(goodLog()), releases: RELEASES, plugin: PLUGIN });
  assert.ok(block.startsWith("> "));
  assert.ok(!block.slice(1).includes(">"), "the only > is the blockquote mark");
  assert.ok(!block.includes("<"));
  assert.ok(!block.includes("://"));
  const bullets = block.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(bullets.length, 3);
  assert.ok(block.split(/\s+/).length <= 110, "the block is at most 110 words");
});

test("the newest entry must be the plugin version", () => {
  const entries = parseChangelog(goodLog());
  assert.throws(() => renderBlock({ entries, releases: RELEASES, plugin: { name: "phased-shipping", version: "0.9.0" } }),
    (e) => e.message.includes("0.8.0") && e.message.includes("0.9.0"));
  assert.throws(() => renderBlock({ entries: [], releases: RELEASES, plugin: PLUGIN }));
});

test("main: unknown or missing flags exit 2 and touch nothing", () => {
  const root = project();
  const before = readIn(root, "README.md");
  for (const argv of [[], ["--bogus"], ["--write", "--bogus"], ["--check", "x"]]) {
    const r = run(argv, root);
    assert.equal(r.code, 2, argv.join(" "));
    assert.ok(r.err.includes("usage:"));
  }
  assert.equal(readIn(root, "README.md"), before);
});

test("main: missing, repeated or reversed markers exit 1 with a message that names them", () => {
  for (const readme of [
    "Tagline.\n\n## The problem\n",
    `Tagline.\n${START}\n`,
    `Tagline.\n${END}\n`,
    `Tagline.\n${START}\n${END}\n${START}\n${END}\n`,
    `Tagline.\n${END}\n${START}\n`,
  ]) {
    for (const flag of ["--check", "--write"]) {
      const root = project({ readme });
      const r = run([flag], root);
      assert.equal(r.code, 1);
      assert.ok(r.err.includes(START) && r.err.includes(END));
      assert.equal(readIn(root, "README.md"), readme, "nothing was written");
    }
  }
});

test("main: --check fails before --write, --write then --check passes, and a second --write changes nothing", () => {
  const root = project();
  assert.equal(run(["--check"], root).code, 1);
  const w = run(["--write"], root);
  assert.equal(w.code, 0);
  const once = readIn(root, "README.md");
  assert.equal(run(["--check"], root).code, 0);
  assert.equal(run(["--write"], root).code, 0);
  assert.equal(readIn(root, "README.md"), once);
  assert.ok(once.includes(`- **phased-shipping 0.8.0** (2026-10-27): ${SA}`));
});

test("main: --write changes only the text between the markers, byte for byte", () => {
  const pre = "Line one.\n\n  indented line \t\nTagline with an odd tail  \n\n";
  const post = "\n## The problem\n\nText with <b>html</b> and a trailing space \n\n\n";
  const readme = `${pre}${START}\nold block\nmore old\n${END}${post}`;
  const root = project({ readme });
  assert.equal(run(["--write"], root).code, 0);
  const out = readIn(root, "README.md");
  assert.ok(out.startsWith(`${pre}${START}\n`));
  assert.ok(out.endsWith(`\n${END}${post}`));
  assert.ok(!out.includes("old block"));
  assert.equal(out, `${pre}${START}\n${renderBlock({ entries: parseChangelog(goodLog()), releases: RELEASES, plugin: PLUGIN })}\n${END}${post}`);
});

test("main: a CRLF README stays CRLF after --write and still passes --check", () => {
  const root = project({ readme: `Tagline.\r\n\r\n${START}\r\n${END}\r\n\r\n## The problem\r\n` });
  assert.equal(run(["--write"], root).code, 0);
  const out = readIn(root, "README.md");
  assert.ok(out.includes("\r\n"));
  assert.ok(!out.replace(/\r\n/g, "").includes("\n"), "no bare LF");
  assert.equal(run(["--check"], root).code, 0);
});

test("main: --check names the first line that differs, with what was expected and what was found", () => {
  const root = project();
  run(["--write"], root);
  const text = readIn(root, "README.md");
  writeFileSync(join(root, "README.md"), text.replace("(2026-10-27)", "(2026-10-28)"));
  const r = run(["--check"], root);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("line 5 of the block"), r.err);
  assert.ok(r.err.includes("expected: - **phased-shipping 0.8.0** (2026-10-27)"));
  assert.ok(r.err.includes("found:    - **phased-shipping 0.8.0** (2026-10-28)"));
  assert.ok(r.err.includes("node scripts/whats-new.mjs --write"));
  // a missing tail line is reported too
  writeFileSync(join(root, "README.md"), text.replace(/\n\nFull history:[^\n]*/, ""));
  const r2 = run(["--check"], root);
  assert.equal(r2.code, 1);
  assert.ok(r2.err.includes("line 8 of the block") && r2.err.includes("found:    (end)"), r2.err);
});

test("main: a plugin.json version that differs from the newest entry exits 1 and names both", () => {
  const root = project({ plugin: { name: "phased-shipping", version: "0.9.9" } });
  for (const flag of ["--check", "--write"]) {
    const r = run([flag], root);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes("0.8.0") && r.err.includes("0.9.9"), r.err);
  }
});

test("main: a CHANGELOG error exits 1 with its message, and a missing input file exits 1", () => {
  const root = project({ log: logOf(entry("0.8.0", "2026-10-27", null)) });
  const r = run(["--check"], root);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("0.8.0") && r.err.includes("Summary:"));
  const empty = tmp();
  writeFileSync(join(empty, "README.md"), `${START}\n${END}\n`);
  assert.equal(run(["--check"], empty).code, 1);
});

test("main: the name shown comes from plugin.json", () => {
  const root = project({ plugin: { name: "other-plugin", version: "0.8.0" } });
  assert.equal(run(["--write"], root).code, 0);
  const out = readIn(root, "README.md");
  assert.ok(out.includes("- **other-plugin 0.8.0** (2026-10-27)"));
  assert.ok(out.includes("Full history: [other-plugin changelog]"));
});

// ── the real repository ──────────────────────────────────────────────────────

const real = (...p) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const realBlock = () => renderBlock({
  entries: parseChangelog(real(...CHANGELOG.split("/"))),
  releases: JSON.parse(real("releases.json")).releases,
  plugin: JSON.parse(real(...PLUGIN_JSON.split("/"))),
});

test("real repo: the README block equals the block rendered from the real inputs", () => {
  const readme = real("README.md");
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  assert.ok(a >= 0 && b > a);
  assert.equal(readme.slice(a + START.length, b).replace(/^\n+|\n+$/g, ""), realBlock());
});

test("real repo: each marker occurs once, both sit in the top of the README before The problem, after the tagline", () => {
  const readme = real("README.md");
  assert.equal(readme.split(START).length, 2);
  assert.equal(readme.split(END).length, 2);
  const problem = readme.indexOf("\n## The problem");
  assert.ok(problem > 0);
  assert.ok(readme.indexOf(START) < readme.indexOf(END) && readme.indexOf(END) < problem);
  assert.ok(readme.indexOf(START) > readme.indexOf("</h1>"));
  // The heading is on one line of its own: it is the only "## " heading between the markers.
  const between = readme.slice(readme.indexOf(START), readme.indexOf(END)).split("\n").filter((l) => l.startsWith("#"));
  assert.deepEqual(between, ["## What's new"]);
});

test("real repo: the newest three CHANGELOG entries carry valid lines, and the newest is the plugin version", () => {
  const entries = parseChangelog(real(...CHANGELOG.split("/")));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].version, JSON.parse(real(...PLUGIN_JSON.split("/"))).version);
  for (const e of entries) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.summary.length >= 20 && e.summary.length <= 160);
  }
});

test("real repo: the CHANGELOG says what the Date and Summary lines are for", () => {
  const top = real(...CHANGELOG.split("/")).split("\n## ")[0];
  assert.ok(top.includes("`Date:`") && top.includes("`Summary:`") && top.includes("What's new"));
});

test("real repo: --check exits 0 when the script is run", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("mutation proof on a temp copy: removing a marker or a CHANGELOG line makes --check fail with a clear message", () => {
  const copy = (changeReadme = (s) => s, changeLog = (s) => s) => {
    const root = tmp();
    mkdirSync(join(root, "plugins", "phased-shipping", ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, "README.md"), changeReadme(real("README.md")));
    writeFileSync(join(root, "releases.json"), real("releases.json"));
    writeFileSync(join(root, CHANGELOG), changeLog(real(...CHANGELOG.split("/"))));
    writeFileSync(join(root, PLUGIN_JSON), real(...PLUGIN_JSON.split("/")));
    return root;
  };
  assert.equal(run(["--check"], copy()).code, 0, "the untouched copy passes");
  // a marker removed
  let r = run(["--check"], copy((s) => s.replace(START, "")));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(START));
  r = run(["--check"], copy((s) => s.replace(END, "")));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(END));
  // a CHANGELOG line removed
  r = run(["--check"], copy(undefined, (s) => s.replace(/^Summary: [^\n]*\n/m, "")));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("0.11.0") && r.err.includes('"Summary:"'), r.err);
  r = run(["--check"], copy(undefined, (s) => s.replace(/^Date: [^\n]*\n/m, "")));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("0.11.0") && r.err.includes('"Date:"'), r.err);
  // a new version with no lines
  r = run(["--check"], copy(undefined, (s) => s.replace("\n## 0.11.0\n", "\n## 0.12.0\n\n### Added\n- x\n\n## 0.11.0\n")));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("0.12.0") && r.err.includes("needs a"), r.err);
  // a README block edited by hand
  r = run(["--check"], copy((s) => s.replace("Work in progress", "Finished")));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("out of date"));
});

test("the script imports only node: built-ins", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const froms = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(froms.length >= 3);
  for (const f of froms) assert.ok(f.startsWith("node:"), `import from ${f}`);
  assert.ok(!/\brequire\s*\(/.test(src) && !/\bimport\s*\(/.test(src), "no require and no dynamic import");
  assert.ok(!/^import\s+["']/m.test(src), "no bare side-effect import");
});

test("the temp folders made by this file are removed by the after hook", () => {
  assert.ok(readFileSync(fileURLToPath(import.meta.url), "utf8").includes("test.after("));
  assert.ok(scratch.length > 0);
  assert.ok(existsSync(scratch[0]), "still there while the tests run; test.after removes it");
});
