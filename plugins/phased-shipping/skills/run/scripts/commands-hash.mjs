#!/usr/bin/env node
// Binds an approval to the commands the user saw: hashes a phase plan's "## Commands" section.
//
//   node commands-hash.mjs <plan>                              print the full SHA-256
//   node commands-hash.mjs <plan> --short                      print its first 12 hex characters
//   node commands-hash.mjs <plan> --record <stage> --data <dir>  save the section as the record for a stage
//   node commands-hash.mjs <plan> --check  <stage> --data <dir>  compare the plan with that record
//
// <stage> is "planned" (written when the plan is made) or "previewed" (written when the user is
// shown the commands). Records live in <dir>/previews/<key>.<stage>.json, where <key> is the first
// 12 hex characters of the SHA-256 of the plan's absolute path, lower-cased, with forward slashes.
// The folder holds {hash, text, plan, at}. It is the only place this script writes, and it uses no
// network and no dependencies.
//
// <key> is built from the plan's real path (symlinks and short Windows names resolved), so a relative
// and an absolute spelling of the same file share a key. A different spelling that resolves elsewhere
// (a copy, another checkout) is another plan and needs its own preview.
//
// The section runs from the "## Commands" heading to the next "## " heading or the end of the file
// (a heading inside a fenced code block doesn't count; a fence follows the standard Markdown rules, see `fenceStep`: it
// closes only on a line of the same character, at least as long, so a fence left open before "## Commands" hides the
// heading and the plan is refused with exit 2). Before hashing, CRLF becomes LF, trailing
// spaces and tabs are trimmed on each line and trailing blank lines are dropped. A plan with two
// headings that look like "Commands", or one that isn't exactly "## Commands" (### Commands,
// ## Commands (updated)), is ambiguous and is refused.
//
// --record prints "recorded <stage> <12 hex>" and --check on a match prints "match <12 hex>", each
// followed by the normalized section. That printed section is what the skill shows the user and briefs
// the shipper with, so what was hashed, shown and run are the same text.
//
// Exit codes: 0 done, or --check matched; 1 usage or I/O error; 2 the plan has no "## Commands"
// section, or has an ambiguous one; 3 --check found a different section (the diff is printed: "-"
// removed, "+" added); 4 --check found no record.
//
// This binds the approval to what the user saw against accidental and model-made drift. It does not
// stop a malicious local process that can rewrite both the plan and the record.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const STAGES = ["planned", "previewed"];

const HEADING = /^##[ \t]+Commands[ \t]*$/;
const LOOKS_LIKE_HEADING = /^#{1,6}[ \t]+commands\b/i;
// Fenced code blocks, by the standard Markdown fence rules: an opening fence is 3 or more backticks or tildes after at most 3 spaces (a backtick
// fence's info text can't hold a backtick); it closes only on a line of the SAME character, at least as many, and nothing else
// but spaces. A fence that never closes runs to the end of the text.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// The fence state after `line`: null (outside a fence) or { ch, len } (inside one). `open` is the state before the line.
// A line belongs to a fence (its content, its opening or its closing line) when `open` before it or the state after it is not null.
export function fenceStep(open, line) {
  if (open) {
    const m = FENCE_CLOSE.exec(line);
    return m && m[1][0] === open.ch && m[1].length >= open.len ? null : open;
  }
  const m = FENCE_OPEN.exec(line);
  if (!m || (m[1][0] === "`" && m[2].includes("`"))) return null;
  return { ch: m[1][0], len: m[1].length };
}
const NEXT_HEADING = /^##[ \t]/;

// The normalized text of the "## Commands" section, or null when the plan has none. Throws an error
// with code "ambiguous" when two headings look like "Commands" or the one there is isn't "## Commands".
export function commandsSection(planText) {
  const lines = String(planText).replace(/\r\n?/g, "\n").split("\n");
  let start = -1;
  let fence = null;
  const lookalikes = [];
  for (let i = 0; i < lines.length; i++) {
    const before = fence;
    fence = fenceStep(fence, lines[i]);
    if (!before && !fence && LOOKS_LIKE_HEADING.test(lines[i])) lookalikes.push(i);
  }
  if (lookalikes.length > 1) {
    throw Object.assign(new Error(`${lookalikes.length} headings look like "Commands" (lines ${lookalikes.map((i) => i + 1).join(", ")}): keep one "## Commands" section`), { code: "ambiguous" });
  }
  if (lookalikes.length === 1) {
    if (!HEADING.test(lines[lookalikes[0]])) {
      throw Object.assign(new Error(`line ${lookalikes[0] + 1} looks like a Commands heading but isn't exactly "## Commands": ${JSON.stringify(lines[lookalikes[0]])}`), { code: "ambiguous" });
    }
    start = lookalikes[0];
  }
  if (start < 0) return null;
  let end = lines.length;
  fence = null;
  for (let i = start + 1; i < lines.length; i++) {
    const before = fence;
    fence = fenceStep(fence, lines[i]);
    if (!before && !fence && NEXT_HEADING.test(lines[i])) { end = i; break; }
  }
  const section = lines.slice(start, end).map((l) => l.replace(/[ \t]+$/, ""));
  while (section.length > 1 && section[section.length - 1] === "") section.pop();
  return section.join("\n");
}

export const hashOf = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// First 12 hex characters of the SHA-256 of the real path, lower-cased, forward slashes. The plan must
// exist: a path that can't be resolved throws.
export function planKey(planPath) {
  const abs = realpathSync.native(resolve(planPath)).replace(/\\/g, "/").toLowerCase();
  return hashOf(abs).slice(0, 12);
}

export const recordPath = (dataDir, planPath, stage) => join(resolve(dataDir), "previews", `${planKey(planPath)}.${stage}.json`);

// A line diff of two texts: "- " for a removed line, "+ " for an added one, nothing for unchanged lines.
export function lineDiff(before, after) {
  const a = String(before).split("\n");
  const b = String(after).split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    const inB = new Set(b);
    const inA = new Set(a);
    return [...a.filter((l) => !inB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !inA.has(l)).map((l) => `+ ${l}`)];
  }
  // Longest common subsequence, then walk it.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

function usageTo(message, err) {
  if (message) err(`${message}\n`);
  err("usage: commands-hash.mjs <plan> [--short] [--record <planned|previewed> --data <dir>] [--check <planned|previewed> --data <dir>]\n");
  return 1;
}

// main(argv, io): io.out and io.err take a piece of text each (default: stdout and stderr); the return value is the exit code.
export function main(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((text) => process.stderr.write(text));
  const usage = (message) => usageTo(message, err);
  let plan;
  let short = false;
  let record;
  let check;
  let data;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--short") short = true;
    else if (a === "--record" || a === "--check" || a === "--data") {
      if (i + 1 >= argv.length || String(argv[i + 1]).startsWith("--")) return usage(`${a} needs a value`);
      const value = argv[++i];
      if (a === "--record") record = value;
      else if (a === "--check") check = value;
      else data = value;
    }
    else if (a.startsWith("--")) return usage(`unknown option ${a}`);
    else if (plan === undefined) plan = a;
    else return usage("more than one plan path");
  }
  if (plan === undefined) return usage("a plan path is needed");
  if (record !== undefined && check !== undefined) return usage("use --record or --check, not both");
  const stage = record ?? check;
  if ((record !== undefined || check !== undefined) && !STAGES.includes(stage)) return usage(`the stage must be one of ${STAGES.join(", ")}`);
  if (stage !== undefined && !data) return usage("--data <dir> is needed with --record and --check");

  let planText;
  try { planText = readFileSync(plan, "utf8"); } catch (e) { return usage(`can't read the plan: ${e.message}`); }
  let section;
  try { section = commandsSection(planText); } catch (e) {
    if (e?.code !== "ambiguous") throw e;
    err(`ambiguous Commands heading in ${plan}: ${e.message}\n`);
    return 2;
  }
  if (section === null) {
    err(`no "## Commands" section in ${plan}\n`);
    return 2;
  }
  const hash = hashOf(section);
  const shown = short ? hash.slice(0, 12) : hash;
  let real;
  if (stage !== undefined) {
    try { real = realpathSync.native(resolve(plan)).replace(/\\/g, "/"); } catch (e) { return usage(`can't resolve the plan's real path: ${e.message}`); }
  }

  if (record !== undefined) {
    const file = recordPath(data, plan, record);
    try {
      mkdirSync(join(resolve(data), "previews"), { recursive: true });
      writeFileSync(file, JSON.stringify({ hash, text: section, plan: real, at: new Date().toISOString() }, null, 2) + "\n");
    } catch (e) { return usage(`can't write the record: ${e.message}`); }
    out(`recorded ${record} ${hash.slice(0, 12)}\n${section}\n`);
    return 0;
  }

  if (check !== undefined) {
    const file = recordPath(data, plan, check);
    if (!existsSync(file)) {
      out(`no ${check} record for this plan\n`);
      return 4;
    }
    let saved;
    try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { saved = null; }
    if (!saved || typeof saved.hash !== "string" || typeof saved.text !== "string") {
      out(`the ${check} record is unreadable\n`);
      return 4;
    }
    if (saved.hash === hash) {
      out(`match ${hash.slice(0, 12)}\n${section}\n`);
      return 0;
    }
    out(`the Commands section changed since it was ${check} (${saved.hash.slice(0, 12)} -> ${hash.slice(0, 12)}):\n${lineDiff(saved.text, section).join("\n")}\n`);
    return 3;
  }

  out(`${shown}\n`);
  return 0;
}

// Run as a script, not when a test imports it. Both paths are resolved through links (a symbolic link or a
// junction to this folder gives a different argv[1] than the module's own path), so the script still runs.
const realOf = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
