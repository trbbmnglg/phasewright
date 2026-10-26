// Run with: node --test tests/
// The marketplace and plugin ids all carry the project name, and every install line agrees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "phasewright";
const PLUGINS = [NAME, "phased-shipping", "free-resources"];

const json = (...p) => JSON.parse(readFileSync(join(REPO, ...p), "utf8"));
const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter((f) => f && existsSync(join(REPO, f)));
const read = (f) => readFileSync(join(REPO, f), "utf8");
const installLines = (text) => [...text.matchAll(/claude plugin install ([A-Za-z0-9_-]+)@([A-Za-z0-9_-]+)/g)].map((m) => ({ plugin: m[1], market: m[2], line: m[0] }));

test("the marketplace name is the project name in both marketplace files", () => {
  assert.equal(json(".claude-plugin", "marketplace.json").name, NAME);
  assert.equal(json(".cursor-plugin", "marketplace.json").name, NAME);
});

test("the root plugin name is the project name in both plugin files", () => {
  assert.equal(json(".claude-plugin", "plugin.json").name, NAME);
  assert.equal(json(".cursor-plugin", "plugin.json").name, NAME);
});

test("every install line in a tracked file names the marketplace and an existing plugin", () => {
  const market = json(".claude-plugin", "marketplace.json").name;
  let count = 0;
  for (const f of tracked()) {
    let text;
    try { text = read(f); } catch { continue; }
    for (const { plugin, market: m, line } of installLines(text)) {
      count++;
      assert.equal(m, market, `${f}: ${line}`);
      assert.ok(PLUGINS.includes(plugin), `${f}: ${line}`);
    }
  }
  assert.ok(count >= 3, "the README install lines are found");
});

test("no tracked file contains a term from the local list, when the list exists", () => {
  const files = tracked();
  assert.ok(files.includes("library.json"), "library.json is tracked and scanned");
  const deny = join(REPO, "scripts", "denylist.local.txt");
  if (!existsSync(deny)) return;
  // Whole word, case-insensitive, like the lint. A failure names the file, never the term.
  const res = readFileSync(deny, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))
    .map((t) => new RegExp(`(?<![\\p{L}\\p{N}_])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "giu"));
  for (const f of files) {
    if (/\.(png|jpg|webp|zip)$/i.test(f) || f === "scripts/denylist.local.txt") continue;
    if (statSync(join(REPO, f)).size > 5 * 1024 * 1024) continue;
    let text;
    try { text = read(f); } catch { continue; }
    for (const re of res) {
      re.lastIndex = 0;
      if (re.test(text)) assert.fail(`${f} contains a term from the local list`);
    }
  }
});

test("library.json install lines follow the same rule", () => {
  const lines = installLines(read("library.json"));
  assert.ok(lines.length > 0, "library.json has install lines");
  for (const { plugin, market, line } of lines) {
    assert.equal(market, NAME, line);
    assert.ok(PLUGINS.includes(plugin), line);
  }
});
