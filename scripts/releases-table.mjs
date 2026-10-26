// Writes or checks the Releases table in README.md from releases.json. No dependencies.
//   node scripts/releases-table.mjs --write   replace the text between the markers
//   node scripts/releases-table.mjs --check   exit 1 when the table is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
export const START = "<!-- releases:start -->";
export const END = "<!-- releases:end -->";

const GOLD = (name) => `$\\color{#D4AF37}{\\textbf{${name}}}$`;
// GFM table cells: \| is a pipe and \\ is a backslash, so escape the backslash first, then the pipe.
export const cell = (s) => String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

// The table as text lines, without the markers. The one entry with accent "gold" renders its name in gold.
export function renderTable(releases) {
  const rows = releases.map((r) =>
    `| ${r.version} | ${r.accent === "gold" ? GOLD(cell(r.name)) : cell(r.name)} | ${r.status} | ${cell(r.summary)} |`);
  return ["| Release | Name | Status | What it is |", "|---|---|---|---|", ...rows].join("\n");
}

function load(root) {
  const releases = JSON.parse(readFileSync(join(root, "releases.json"), "utf8")).releases;
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const text = readme.replace(/\r\n/g, "\n");
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < 0 || b < a) return { releases, error: `README.md needs the markers ${START} and ${END}` };
  return { releases, text, eol, a, b };
}

export function main(argv, root = ROOT) {
  const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : null;
  if (!mode) { console.error("usage: node scripts/releases-table.mjs --write | --check"); return 2; }
  const d = load(root);
  if (d.error) { console.error(d.error); return 1; }
  const table = renderTable(d.releases);
  const current = d.text.slice(d.a + START.length, d.b).replace(/^\n+|\n+$/g, "");
  if (mode === "check") {
    if (current === table) { console.log("releases table is up to date"); return 0; }
    const want = table.split("\n");
    const have = current.split("\n");
    const i = want.findIndex((line, n) => line !== have[n]);
    const at = i < 0 ? want.length : i;
    console.error(`README.md releases table is out of date (line ${at + 1} of the table)`);
    console.error(`  expected: ${want[at] ?? "(end)"}`);
    console.error(`  found:    ${have[at] ?? "(end)"}`);
    console.error("run: node scripts/releases-table.mjs --write");
    return 1;
  }
  const out = d.text.slice(0, d.a + START.length) + "\n" + table + "\n" + d.text.slice(d.b);
  writeFileSync(join(root, "README.md"), d.eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out);
  console.log("README.md releases table written");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
