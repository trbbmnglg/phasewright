// Run with: node --test tests/releases.test.mjs
// releases.json is the one source for the README table and the release title; these tests keep them in step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderTable, cell, START, END } from "../scripts/releases-table.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const releasesText = read("releases.json");
const releases = JSON.parse(releasesText).releases;
const readme = read("README.md").replace(/\r\n/g, "\n");
const between = () => readme.slice(readme.indexOf(START) + START.length, readme.indexOf(END)).replace(/^\n+|\n+$/g, "");
const releasesSection = () => {
  const a = readme.indexOf("\n## Releases\n");
  assert.ok(a >= 0, "README has a Releases section");
  const next = readme.indexOf("\n## ", a + 1);
  return readme.slice(a, next < 0 ? undefined : next);
};
const parts = (v) => v.slice(1).split(".").map(Number);
const cmp = (a, b) => { const x = parts(a), y = parts(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

test("releases.json: versions, names, statuses and dates are well formed", () => {
  assert.equal(releases.length, 12);
  for (const r of releases) {
    assert.match(r.version, /^v\d+\.\d+\.\d+$/, r.version);
    assert.ok(typeof r.name === "string" && r.name.trim() !== "", `${r.version} name`);
    assert.ok(typeof r.summary === "string" && r.summary.trim() !== "", `${r.version} summary`);
    assert.ok(["shipped", "in progress", "planned"].includes(r.status), `${r.version} status`);
    if (r.status === "shipped") assert.match(r.date ?? "", /^\d{4}-\d{2}-\d{2}$/, `${r.version} date`);
    else assert.equal("date" in r, false, `${r.version} must not have a date`);
  }
  assert.equal(new Set(releases.map((r) => r.version)).size, releases.length, "versions unique");
  assert.equal(new Set(releases.map((r) => r.name)).size, releases.length, "names unique");
  for (let i = 1; i < releases.length; i++) assert.ok(cmp(releases[i - 1].version, releases[i].version) < 0, `ascending at ${releases[i].version}`);
  const accented = releases.filter((r) => "accent" in r);
  assert.equal(accented.length, 1);
  assert.equal(accented[0].version, "v1.4.0");
  assert.equal(accented[0].accent, "gold");
});

test("releases.json and the README Releases section carry no rename wording", () => {
  const words = ["renamed", "formerly"];
  for (const [label, body] of [["releases.json", releasesText], ["README Releases section", releasesSection()]]) {
    for (const w of words) assert.ok(!body.toLowerCase().includes(w), `${label} contains "${w}"`);
  }
});

test("the README table equals the table rendered from releases.json, with the gold name only on v1.4.0", () => {
  assert.equal(between(), renderTable(releases));
  const gold = "$\\color{#D4AF37}{\\textbf{Gattaran}}$";
  assert.equal(readme.split(gold).length - 1, 1, "gold form appears once");
  const row = between().split("\n").find((l) => l.includes(gold));
  assert.ok(row.startsWith("| v1.4.0 |"), "gold form is on the v1.4.0 row");
  assert.equal((between().match(/\\color/g) ?? []).length, 1);
});

// Test-side reading of a GFM table cell, scanned left to right: \\ is a backslash, \| is a pipe, anything else is itself.
const unescapeCell = (s) => {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && (s[i + 1] === "\\" || s[i + 1] === "|")) { out += s[i + 1]; i++; } else out += s[i];
  }
  return out;
};
// Splits a table row on the pipes that are not escaped, the way a Markdown renderer does.
const splitRow = (line) => {
  const cells = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) { cur += line[i] + line[i + 1]; i++; }
    else if (line[i] === "|") { cells.push(cur); cur = ""; }
    else cur += line[i];
  }
  cells.push(cur);
  return cells.slice(1); // text before the first pipe is empty
};

test("cell escapes the backslash first and then the pipe, so the text reads back unchanged and a pipe never splits a cell", () => {
  const B = "\\";
  const values = ["", "plain", "a|b", `a${B}b`, `a${B}|b`, `a${B}${B}|b`, `x${B}`, "|", B, B + B, `|${B}|`];
  for (const v of values) {
    const out = cell(v);
    assert.equal(unescapeCell(out), v, `round trip of ${JSON.stringify(v)}`);
    const row = `| ${cell("first")} | ${out} | ${cell("last")} |`;
    const got = splitRow(row);
    assert.equal(got.length, 4, `cells in the row for ${JSON.stringify(v)}`);
    assert.equal(unescapeCell(got[1].trim()), v, `the middle cell of ${JSON.stringify(v)}`);
  }
  assert.equal(cell(`a${B}|b`), `a${B}${B}${B}|b`, "backslash escaped first, then the pipe");
  assert.equal(cell(123), "123", "a number is turned into text");
});

test("renderTable escapes cells and still renders the gold name as the exact expected string", () => {
  const rows = renderTable([
    { version: "v9.9.9", name: "Gattaran", accent: "gold", status: "shipped", summary: "plain" },
    { version: "v9.9.8", name: "a|b", accent: "none", status: "shipped", summary: "x\\y|z" },
    { version: "v9.9.7", name: "p\\q", accent: "gold", status: "shipped", summary: "s" },
  ]).split("\n");
  assert.equal(rows[2], "| v9.9.9 | $\\color{#D4AF37}{\\textbf{Gattaran}}$ | shipped | plain |");
  assert.equal(rows[3], "| v9.9.8 | a\\|b | shipped | x\\\\y\\|z |");
  assert.equal(rows[4], "| v9.9.7 | $\\color{#D4AF37}{\\textbf{p\\\\q}}$ | shipped | s |");
});

const workflow = read(".github", "workflows", "release.yml");

test("release.yml reads releases.json for the title and keeps its pinned actions and permissions", () => {
  assert.ok(workflow.includes("releases.json"));
  assert.ok(workflow.includes("RELEASE_TITLE"));
  assert.ok(workflow.includes('--title "$RELEASE_TITLE"'));
  assert.ok(workflow.includes("uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4"));
  assert.ok(workflow.includes("uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4"));
  assert.ok(workflow.includes("\npermissions: {}\n"));
  assert.ok(workflow.includes("    permissions:\n      contents: write\n"));
});

const hasJq = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

// The script of the "Release name" step: the indented block after `run: |`.
function releaseNameScript() {
  const lines = workflow.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === "- name: Release name");
  assert.ok(at >= 0, "Release name step");
  assert.equal(lines[at + 1].trim(), "run: |");
  const body = [];
  for (let i = at + 2; i < lines.length && /^ {10}/.test(lines[i]); i++) body.push(lines[i].slice(10));
  return body.join("\n") + "\n";
}

test("the Release name step titles a listed tag and fails an unlisted one", { skip: hasJq ? false : "jq is not on the PATH" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "releases-"));
  try {
    copyFileSync(join(ROOT, "releases.json"), join(dir, "releases.json"));
    writeFileSync(join(dir, "step.sh"), releaseNameScript());
    const run = (tag, envFile) => spawnSync("sh", ["step.sh"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_ENV: envFile },
    });
    const ok = join(dir, "env-ok");
    writeFileSync(ok, "");
    const good = run("v1.1.0", ok);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(readFileSync(ok, "utf8").trim(), "RELEASE_TITLE=v1.1.0 Baggao");
    const bad = run("v9.9.9", join(dir, "env-bad"));
    assert.notEqual(bad.status, 0);
    assert.ok(bad.stdout.includes("::error::add v9.9.9 to releases.json"), bad.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
