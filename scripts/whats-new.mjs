// Writes or checks the "What's new" block at the top of README.md from the phased-shipping CHANGELOG
// (the newest three entries) and releases.json (the work-in-progress banner). No dependencies.
//   node scripts/whats-new.mjs --write   replace the text between the markers
//   node scripts/whats-new.mjs --check   exit 1 when the block is out of date or an input is wrong
// Each of the newest three CHANGELOG entries starts with a "Date: YYYY-MM-DD" line and a "Summary: ..." line.
// The summary is checked against a short allowlist of characters, so CHANGELOG text cannot add HTML or markdown to the README.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
export const START = "<!-- whats-new:start -->";
export const END = "<!-- whats-new:end -->";
const CHANGELOG = "plugins/phased-shipping/CHANGELOG.md";
const PLUGIN_JSON = "plugins/phased-shipping/.claude-plugin/plugin.json";
const SHOWN = 3;
const SUMMARY_MIN = 20;
const SUMMARY_MAX = 160;
// Letters, digits, spaces and . , ; : ' " ( ) / - + & ! ? and the backtick. Nothing else gets into the README.
const ALLOWED = /^[\p{L}\p{Nd} .,;:'"()/+&!?`-]*$/u;

const code = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
const cmp = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const realDate = (y, m, d) => {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

function checkSummary(text, where) {
  const s = text.trim();
  const n = [...s].length;
  if (n < SUMMARY_MIN || n > SUMMARY_MAX) throw new Error(`${where} Summary must be ${SUMMARY_MIN} to ${SUMMARY_MAX} characters (it is ${n})`);
  for (const ch of text) if (!ALLOWED.test(ch)) throw new Error(`${where} Summary has a character that is not allowed (${code(ch)})`);
  if (s.split("`").length % 2 === 0) throw new Error(`${where} Summary has an odd number of backticks`);
  if (s.includes("://") || /www\./i.test(s)) throw new Error(`${where} Summary must not contain a web address`);
  return s;
}

// The newest three entries as { version, date, summary }, newest first. Throws an Error with a message that names the version.
export function parseChangelog(text, file = CHANGELOG) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const heads = [];
  lines.forEach((l, i) => {
    const m = /^## (\d+\.\d+\.\d+)[ \t]*$/.exec(l);
    if (m) heads.push({ version: m[1], at: i });
  });
  if (!heads.length) throw new Error(`${file}: no "## x.y.z" version heading found`);
  for (let i = 1; i < heads.length; i++) {
    if (cmp(heads[i - 1].version, heads[i].version) <= 0) {
      throw new Error(`${file}: versions must go from newest to oldest, but ${heads[i].version} comes after ${heads[i - 1].version}`);
    }
  }
  const entries = [];
  for (const h of heads.slice(0, SHOWN)) {
    const where = `${file}: ${h.version}`;
    // The entry's own lines: from its heading to the first "###" or the next "##".
    const region = [];
    for (let i = h.at + 1; i < lines.length && !/^#{2,} /.test(lines[i]); i++) region.push(lines[i]);
    const pick = (label) => {
      const found = region.filter((l) => l.startsWith(`${label}:`));
      if (found.length === 0) throw new Error(`${where} needs a "${label}:" line directly under its heading`);
      if (found.length > 1) throw new Error(`${where} has more than one "${label}:" line`);
      return found[0];
    };
    const dm = /^Date: (\d{4})-(\d{2})-(\d{2})$/.exec(pick("Date"));
    if (!dm) throw new Error(`${where} has a "Date:" line that is not "Date: YYYY-MM-DD"`);
    if (!realDate(Number(dm[1]), Number(dm[2]), Number(dm[3]))) throw new Error(`${where} has a date that is not a real calendar date`);
    const sm = /^Summary: ([^\n]*)$/.exec(pick("Summary"));
    if (!sm) throw new Error(`${where} has a "Summary:" line that is not "Summary: <text>"`);
    entries.push({ version: h.version, date: `${dm[1]}-${dm[2]}-${dm[3]}`, summary: checkSummary(sm[1], where) });
  }
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].date > entries[i - 1].date) {
      throw new Error(`${file}: ${entries[i].version} is dated ${entries[i].date}, after ${entries[i - 1].version} (${entries[i - 1].date}); dates must not go up as versions go down`);
    }
  }
  return entries;
}

// The text between the markers, without the markers: the banner, the heading, the bullets and the history link.
export function renderBlock({ entries, releases, plugin }) {
  if (!entries.length) throw new Error("no CHANGELOG entries to show");
  if (entries[0].version !== plugin.version) {
    throw new Error(`${CHANGELOG}: the newest entry is ${entries[0].version} but plugin.json says ${plugin.version}`);
  }
  const wip = releases.find((r) => r.status === "in progress");
  const banner = wip
    ? `> **Work in progress.** Phasewright is built in the open. Release ${wip.version} (${wip.name}) is being built, so interfaces and file formats may still change; see [Releases](#releases).`
    : "> **Under active development.** Interfaces and file formats may still change; see [Releases](#releases).";
  const bullets = entries.map((e) => `- **${plugin.name} ${e.version}** (${e.date}): ${e.summary}`);
  return [banner, "", "## What's new", "", ...bullets, "", `Full history: [${plugin.name} changelog](${CHANGELOG}).`].join("\n");
}

function load(root) {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const text = readme.replace(/\r\n/g, "\n");
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (text.split(START).length !== 2 || text.split(END).length !== 2 || b < a) {
    throw new Error(`README.md needs the markers ${START} and ${END}, each once and in that order`);
  }
  const releases = JSON.parse(readFileSync(join(root, "releases.json"), "utf8")).releases;
  const plugin = JSON.parse(readFileSync(join(root, PLUGIN_JSON), "utf8"));
  const entries = parseChangelog(readFileSync(join(root, CHANGELOG), "utf8"));
  return { text, eol, a, b, block: renderBlock({ entries, releases, plugin: { name: plugin.name, version: plugin.version } }) };
}

export function main(argv, root = ROOT) {
  const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : null;
  if (!mode || argv.some((x) => x !== "--write" && x !== "--check")) {
    console.error("usage: node scripts/whats-new.mjs --write | --check");
    return 2;
  }
  let d;
  try { d = load(root); } catch (e) { console.error(e.message); return 1; }
  const current = d.text.slice(d.a + START.length, d.b).replace(/^\n+|\n+$/g, "");
  if (mode === "check") {
    if (current === d.block) { console.log("what's new block is up to date"); return 0; }
    const want = d.block.split("\n");
    const have = current.split("\n");
    const i = want.findIndex((line, n) => line !== have[n]);
    const at = i < 0 ? want.length : i;
    console.error(`README.md what's new block is out of date (line ${at + 1} of the block)`);
    console.error(`  expected: ${want[at] ?? "(end)"}`);
    console.error(`  found:    ${have[at] ?? "(end)"}`);
    console.error("run: node scripts/whats-new.mjs --write");
    return 1;
  }
  const out = d.text.slice(0, d.a + START.length) + "\n" + d.block + "\n" + d.text.slice(d.b);
  writeFileSync(join(root, "README.md"), d.eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out);
  console.log("README.md what's new block written");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
