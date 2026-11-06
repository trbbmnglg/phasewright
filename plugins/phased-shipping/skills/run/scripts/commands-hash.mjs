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
// The folder holds {hash, text, plan, at} (with --root also root, tree, messages and allowed; see below). It is the only place this script writes, and it uses no
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
// removed, "+" added), or, with --root, different code; 4 --check found no record, or a record whose
// text does not match its hash (it was edited).
//
// The code binding (previewed only):
//   node commands-hash.mjs <plan> --record previewed --data <dir> --root <project folder> [--roadmap <PHASES.md>]
//   node commands-hash.mjs <plan> --check  previewed --data <dir> --root <project folder> [--roadmap <PHASES.md>]
// --record with --root also stores the project folder's real path, its tree id (tree-state.mjs treeId: the content of
// the working tree, leaving out what .gitignore ignores), the commit HEAD points at (`head`: ship.mjs refuses to start on another HEAD), the paths that may change later (`allowed`: the plan and the
// roadmap, relative to the project folder) and, for every strict `git commit -F <file>` step in the section's ship block
// (see shipBlock and commitStep), the file's real path and SHA-256. It refuses (exit 1, nothing recorded) a plan or a
// roadmap that is a link or lies outside the project folder, a plan that is not a phase-*.md file in a folder named
// phases, and a roadmap not named PHASES.md, and it prints `code bound to the tree <12 hex>; only these may change: <plan>,
// <roadmap>` after the section. --check with --root then also requires the same project folder, the plan and the --roadmap
// that were recorded (a --roadmap left out is not an allowed difference), the same message files at the same real paths,
// and a tree that differs from the stored one only in those paths (git diff-tree on the two tree ids). Anything else exits
// 3 with a fixed phrase and the changed path names; so does a record with no tree or no allowed paths. Without --root, the
// check is the commands-only check above, and old records still work. With --root, git runs (see tree-state.mjs: it writes
// objects into the repository's object store, nothing else).
//
// This binds the approval to what the user saw against accidental and model-made drift. It does not
// stop a malicious local process that can rewrite both the plan and the record.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { treeId, changedPaths, headId, Refusal } from "./tree-state.mjs";

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

// ---------- the ship block ----------
//
// A fenced block with the info string `ship` inside the "## Commands" section, one `key: value` entry per line:
//   branch: <name>      the branch HEAD must be on (exactly one)
//   step: <command>     deploy steps, run in order (at least one)
//   check: <command>    prod checks, run in order after the steps (at least one)
//   rollback: <command> run once, in order, when a check fails (at least one)
//   timeout: <seconds>  per command, a whole number from 1 to 1800 (at most one; default 900)
// Blank lines are skipped. An unknown key, a line that is not `key: value`, an empty value, a control character or an
// invisible format character (bidi controls such as U+202E and U+2066, zero-width characters, a BOM: anything in \p{Cf})
// anywhere in a line, a second ship block, a ship fence that is indented, that is left open or whose info string is not
// exactly `ship`, a missing branch, step, check or rollback, or a bad timeout makes the block invalid. So does a step with
// the word commit that is not a strict commit step (see commitStep: exactly `git commit` with -q, -s, --no-edit and one
// -F <file>, whose file is bound to the preview by its SHA-256), and a check or a rollback with the word commit. The same for
// git push (see pushStep): a step with it must be exactly `git push [-q] origin <the block's branch>` on its own, a check never
// pushes, and a rollback line pushes only in that form, after && (`git revert --no-edit HEAD && git push origin main`). Both
// words are found as bash reads them (quotes, backslashes, $'..', line continuations and empty expansions don't hide them).
export const SHIP_TIMEOUT_DEFAULT = 900;
export const SHIP_TIMEOUT_MAX = 1800;
const SHIP_KEYS = new Set(["branch", "step", "check", "rollback", "timeout"]);
const SHIP_ENTRY = /^[ \t]*([A-Za-z_-]+):[ \t]*(.*)$/;
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const ch = (n) => String.fromCodePoint(n);
const CONTROL = new RegExp(`[${ch(0)}-${ch(8)}${ch(0xa)}-${ch(0x1f)}${ch(0x7f)}-${ch(0x9f)}${ch(0x2028)}${ch(0x2029)}]|\\p{Cf}`, "u");
const shipError = (message) => Object.assign(new Error(message), { code: "ship" });

// The parsed ship block of a section's text, or null when it has none. Throws an error with code "ship" when the block
// is invalid. Callers pass the RECORDED section text, never a fresh read of the plan.
export function shipBlock(sectionText) {
  const lines = String(sectionText).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let open = null;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const before = open;
    open = fenceStep(open, line);
    if (!before && open) {
      const info = FENCE_OPEN.exec(line)[2].trim();
      if (/^ship(?![A-Za-z0-9_-])/i.test(info)) {
        if (info !== "ship") throw shipError(`line ${i + 1}: the ship block's info string must be exactly "ship"`);
        if (/^[ \t]/.test(line)) throw shipError(`line ${i + 1}: the ship block's fence must start at the beginning of the line`);
        current = { at: i + 1, lines: [] };
      }
    } else if (before && !open) {
      if (current) { blocks.push(current); current = null; }
    } else if (before && open && current) current.lines.push({ text: line, at: i + 1 });
  }
  if (current) throw shipError(`line ${current.at}: the ship block is never closed`);
  if (blocks.length === 0) return null;
  if (blocks.length > 1) throw shipError(`${blocks.length} ship blocks (lines ${blocks.map((b) => b.at).join(", ")}): keep one`);
  const block = { branch: null, steps: [], checks: [], rollbacks: [], timeout: SHIP_TIMEOUT_DEFAULT };
  let timeouts = 0;
  let branches = 0;
  for (const { text, at } of blocks[0].lines) {
    if (CONTROL.test(text)) throw shipError(`line ${at}: a control or invisible format character`);
    if (text.trim() === "") continue;
    const m = SHIP_ENTRY.exec(text);
    if (!m) throw shipError(`line ${at}: not a "key: value" entry`);
    const [, key, raw] = m;
    const value = raw.trim();
    if (!SHIP_KEYS.has(key)) throw shipError(`line ${at}: unknown key "${key}" (use branch, step, check, rollback or timeout)`);
    if (value === "") throw shipError(`line ${at}: "${key}" has no value`);
    if (key === "branch") {
      if (++branches > 1) throw shipError(`line ${at}: a second branch`);
      if (!BRANCH.test(value)) throw shipError(`line ${at}: not a plain branch name`);
      block.branch = value;
    } else if (key === "timeout") {
      if (++timeouts > 1) throw shipError(`line ${at}: a second timeout`);
      if (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > SHIP_TIMEOUT_MAX) throw shipError(`line ${at}: the timeout must be a whole number of seconds from 1 to ${SHIP_TIMEOUT_MAX}`);
      block.timeout = Number(value);
    } else block[`${key}s`].push(value);
  }
  if (!blocks[0].lines.some((l) => l.text.trim() !== "")) throw shipError(`line ${blocks[0].at}: the ship block is empty`);
  if (!block.branch) throw shipError("the ship block has no branch");
  for (const key of ["step", "check", "rollback"]) if (!block[`${key}s`].length) throw shipError(`the ship block has no ${key}`);
  // Only a strict commit step commits and only a strict push step pushes: ship.mjs scans and checks what it stages and commits,
  // and checks what it pushed. A check never commits or pushes; a rollback never commits (git revert has no word commit) and pushes
  // only with the strict push form, after && (`git revert --no-edit HEAD && git push origin main`).
  // Nothing in a line may hide a background job, a program name or a substitution from the checks below (see checkReadable).
  for (const line of [...block.steps, ...block.checks, ...block.rollbacks]) checkReadable(line);
  block.commits = block.steps.map((s) => commitStep(s));
  block.pushes = block.steps.map((s) => pushStep(s, block.branch));
  for (const c of block.checks) {
    if (mentionsCommit(c)) throw shipError("a check never commits: take the word commit out of the check");
    if (mentionsPush(c)) throw shipError("a check never pushes: push in a step of its own");
  }
  for (const r of block.rollbacks) {
    if (mentionsCommit(r)) throw shipError("a rollback never commits: undo with git revert instead");
    rollbackPushes(r, block.branch);
  }
  // Which rollback lines push (in the strict form): ship.mjs lets only those move origin's branch, to HEAD.
  block.rollbackPushes = block.rollbacks.map((r) => mentionsPush(r));
  block.messages = block.commits.filter(Boolean).map((c) => c.file);
  return block;
}

// The shell words of a command, each { raw, word, literal, quoted, seg }, across operators; whether the text has an operator
// (; & | < > ( ) or a newline) or a comment (# at the start of a word); and `ops`, the operators in order (&& and || as one).
// `seg` numbers the simple commands the operators split. `word` is the text with its quotes removed; `raw` is the text as
// written. A word is literal when nothing in it can expand: no $, backtick, backslash, glob, ~, brace or ! outside single
// quotes, and no $, backtick, backslash or ! inside double quotes.
function stepWords(command) {
  const words = [];
  const ops = [];
  let operator = false;
  const s = String(command);
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[ \t]/.test(s[i])) i++;
    if (i >= s.length) break;
    if (/[;&|<>()\n]/.test(s[i])) {
      operator = true;
      const two = s.slice(i, i + 2);
      const op = two === "&&" || two === "||" ? two : s[i];
      ops.push(op);
      i += op.length;
      continue;
    }
    if (s[i] === "#") { operator = true; ops.push("#"); break; }
    let word = "";
    let raw = "";
    let literal = true;
    let quoted = false;
    while (i < s.length && !/[ \t;&|<>()\n]/.test(s[i])) {
      const c = s[i];
      if (c === "'" || c === '"') {
        quoted = true;
        const end = s.indexOf(c, i + 1);
        if (end < 0) { literal = false; word += s.slice(i + 1); raw += s.slice(i); i = s.length; break; }
        const inner = s.slice(i + 1, end);
        if (c === '"' && /[$`\\!]/.test(inner)) literal = false;
        word += inner;
        raw += s.slice(i, end + 1);
        i = end + 1;
      } else {
        if (/[$`\\*?[\]{}~!#]/.test(c)) literal = false;
        word += c;
        raw += c;
        i++;
      }
    }
    words.push({ raw, word, literal, quoted, seg: ops.length });
  }
  return { words, operator, ops };
}

// The text of a command as bash reads its words, to find a word anywhere in it, in two forms. The first: quotes, $'..' and $".."
// removed with their content kept, a backslash outside single quotes dropped (the character after it kept; inside double quotes only
// before $ ` " \), and a backslash-newline (a line continuation) removed, so `c\ommit`, `"c"ommit`, `co''mmit`, `$'commit'` and
// `com\<newline>mit` all read commit. The second: the same with every substitution and variable removed ($x, ${..}, $(..) to its
// matching parenthesis, backticks, <(..)), because an unset variable or an empty substitution expands to nothing (`c${x}ommit`). A quote boundary
// ends a variable name, as in bash (`c$X""ommit` is c, $X, ommit).
const QUOTE_EDGE = "\u0000";
function bashText(command) {
  const s = String(command);
  let out = "";
  let q = null; // null, "'", '"' or "$'"
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") { q = null; out += QUOTE_EDGE; } else out += c; continue; }
    if (c === "\\") {
      const n = s[i + 1];
      if (n === undefined) continue;
      i++;
      if (n === "\n") continue;
      if (q === '"' && !"$`\"\\".includes(n)) out += c;
      out += n;
      continue;
    }
    if (q === "$'") { if (c === "'") { q = null; out += QUOTE_EDGE; } else out += c; continue; }
    if (q === '"') { if (c === '"') { q = null; out += QUOTE_EDGE; } else out += c; continue; }
    if (c === "$" && (s[i + 1] === "'" || s[i + 1] === '"')) { q = s[i + 1] === "'" ? "$'" : '"'; i++; out += QUOTE_EDGE; continue; }
    if (c === "'" || c === '"') { q = c; out += QUOTE_EDGE; continue; }
    out += c;
  }
  return out;
}
// The variables a word can hold ($x, ${..}, $1, $@ and the like), removed from the second form.
const VARIABLES = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]/g;
// A command with every command, arithmetic and process substitution removed ($(..), $((..)), `..`, <(..) and >(..) outside double
// quotes), each matched to its end as bash matches it: nested parentheses, quoted text and other substitutions inside count, and a
// backslash escapes the next character. `git pu$( (true) )sh` reads push, and so does `git pu$(echo $(echo $(true)))sh`. A
// substitution that is never closed throws a ship error: what it would run can't be read.
function withoutSubstitutions(command) {
  const s = String(command);
  const unclosed = () => shipError("a substitution ($(..), `..`, <(..) or >(..)) that is never closed: the command can't be read");
  const tickEnd = (from) => { // the index after the backtick that closes one opened before `from`
    let j = from;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) throw unclosed();
    return j + 1;
  };
  const dqEnd = (from) => { // the index after the double quote that closes one opened before `from`
    let j = from;
    while (j < s.length && s[j] !== '"') {
      if (s[j] === "\\") j += 2;
      else if (s[j] === "$" && s[j + 1] === "(") j = parenEnd(j + 2);
      else if (s[j] === "`") j = tickEnd(j + 1);
      else j++;
    }
    if (j >= s.length) throw unclosed();
    return j + 1;
  };
  function parenEnd(from) { // the index after the ) that matches a ( opened before `from`
    let depth = 1;
    let j = from;
    while (j < s.length) {
      const c = s[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "'") { const e = s.indexOf("'", j + 1); if (e < 0) throw unclosed(); j = e + 1; continue; }
      if (c === '"') { j = dqEnd(j + 1); continue; }
      if (c === "`") { j = tickEnd(j + 1); continue; }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j + 1;
      j++;
    }
    throw unclosed();
  }
  let out = "";
  let dq = false;
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "\\") { out += s.slice(i, i + 2); i += 2; continue; }
    if (!dq && c === "'") { const e = s.indexOf("'", i + 1); const end = e < 0 ? s.length : e + 1; out += s.slice(i, end); i = end; continue; }
    if (c === '"') { dq = !dq; out += c; i++; continue; }
    if (s[i + 1] === "(" && (c === "$" || (!dq && (c === "<" || c === ">")))) { i = parenEnd(i + 2); continue; }
    if (c === "`") { i = tickEnd(i + 1); continue; }
    out += c;
    i++;
  }
  return out;
}
// Read three levels deep, so text that a nested shell reads again (`bash -c 'git c\ommit'`) is read the way that shell reads it. The
// second form of each level has its substitutions and variables removed (see withoutSubstitutions and VARIABLES).
const bashForms = (command) => {
  let level = [String(command)];
  const all = new Set();
  for (let depth = 0; depth < 3; depth++) {
    const next = [];
    for (const t of level) {
      const plain = bashText(t).split(QUOTE_EDGE).join("");
      const bare = bashText(withoutSubstitutions(t)).replace(VARIABLES, "").split(QUOTE_EDGE).join("");
      for (const form of [plain, bare]) {
        if (!all.has(form)) { all.add(form); next.push(form); }
      }
    }
    level = next;
  }
  return [...all];
};

// ---------- what a ship line may not hide ----------
//
// The command texts of a line: the line itself and the inside of every $(..), `..`, <(..) and >(..), each with every quoted part
// replaced by a mark (QUOTED + its index + QUOTED; the text is in `quotes`, a double-quoted one with its backslash escapes resolved as
// bash resolves them), every substitution by SUBST and every backslash-escaped character by a mark (ESCAPED + its index + ESCAPED;
// the character is in `escapes`), so a quote, a substitution or an escape can't make an operator or a program word look like another. Throws a
// ship error for what can't be read the way bash reads it: a quote or a substitution never closed, a case inside a substitution (its
// `x)` is not the end of the substitution), and a ${..} holding a quote (`${x:+'}'}` ends at another brace than it seems to).
const QUOTED = "\u0001";
const SUBST = "\u0002";
const ESCAPED = "\u0003";
function commandTexts(line) {
  const s = String(line);
  const texts = [];
  const quotes = [];
  const escapes = [];
  const escaped = (c) => { escapes.push(c); return `${ESCAPED}${escapes.length - 1}${ESCAPED}`; };
  const unreadable = (why) => shipError(`a command that can't be read as bash reads it (${why}): write it plainly`);
  const quote = (text) => { quotes.push(text); return `${QUOTED}${quotes.length - 1}${QUOTED}`; };
  const braced = (i) => { // ${..} from its $: the index after its }
    const e = s.indexOf("}", i + 2);
    if (e < 0) throw unreadable("a ${ never closed");
    if (/['"]/.test(s.slice(i + 2, e))) throw unreadable("a ${..} holding a quote");
    return e + 1;
  };
  const sub = (from, stop) => { // a substitution's text, from just after its opening, and the index after its end
    const r = scan(from, stop);
    if (/(^|[\s;&|(])case(\s|$)/.test(r.text)) throw unreadable("a case inside a substitution");
    texts.push(r.text);
    return r.end;
  };
  const dq = (from) => { // inside double quotes: substitutions run, the rest is quoted text
    let i = from;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") i += 2;
      else if (s[i] === "$" && s[i + 1] === "(") i = sub(i + 2, ")");
      else if (s[i] === "$" && s[i + 1] === "{") i = braced(i);
      else if (s[i] === "`") i = sub(i + 1, "`");
      else i++;
    }
    if (i >= s.length) throw unreadable("a quote never closed");
    return { text: s.slice(from, i), end: i + 1 };
  };
  function scan(from, stop) {
    let out = "";
    let depth = 0;
    let i = from;
    while (i < s.length) {
      const c = s[i];
      if (stop === "`" && c === "`") return { text: out, end: i + 1 };
      if (stop === ")" && c === ")" && depth === 0) return { text: out, end: i + 1 };
      if (c === "\\") { out += s[i + 1] === "\n" ? "" : escaped(s[i + 1] ?? ""); i += 2; continue; }
      if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) throw unreadable("a quote never closed"); out += quote(s.slice(i + 1, e)); i = e + 1; continue; }
      if (c === '"') { const r = dq(i + 1); out += quote(r.text.replace(/\\([$`"\\\n])/g, (_, x) => (x === "\n" ? "" : x))); i = r.end; continue; }
      if (c === "$" && s[i + 1] === "{") { const e = braced(i); out += s.slice(i, e); i = e; continue; }
      if ((c === "$" || c === "<" || c === ">") && s[i + 1] === "(") { i = sub(i + 2, ")"); out += SUBST; continue; }
      if (c === "`") { i = sub(i + 1, "`"); out += SUBST; continue; }
      if (stop === ")" && c === "(") depth++;
      if (stop === ")" && c === ")") depth--;
      out += c;
      i++;
    }
    if (stop) throw unreadable("a substitution never closed");
    return { text: out, end: i };
  }
  texts.unshift(scan(0, null).text);
  return { texts, quotes, escapes };
}

const OPERATOR = /&&|\|\||\|&|;;&|;;|;&|&>>|&>|>>|>&|>\||<<<|<<|<&|<>|[;&|<>()\n]/y;
// The operators that end a simple command (;& and ;;& end a case branch, as ;; does).
const SEPARATORS = new Set(["&&", "||", "|", "|&", ";", ";;", ";&", ";;&", "&", "(", ")", "\n"]);
// Words before the program (control words) and words after which the program is the next plain word (wrappers).
const KEYWORDS = new Set(["!", "{", "}", "do", "done", "then", "else", "elif", "fi", "if", "while", "until", "time", "esac"]);
const NOT_A_COMMAND = new Set(["for", "case", "select", "function", "in"]);
// The wrappers and their options: `v` the short options that take a value, `f` the ones that don't, `lv` and `lf` the long ones,
// `positional` the plain words before the program (timeout's duration), `numeric` an old `-5` style option (nice). A cluster whose
// valued letter comes last takes the next word (`sudo -iu bob x`); one whose valued letter comes earlier carries its value
// (`nice -n5 x`). An option a wrapper does not have here is refused rather than guessed at.
const WRAPPERS = new Map([
  ["env", { v: "uCS", f: "i0v", lv: ["unset", "chdir", "split-string"], lf: ["ignore-environment", "null", "debug"] }],
  ["command", { v: "", f: "pvV" }],
  ["builtin", { v: "", f: "" }],
  ["exec", { v: "a", f: "cl" }],
  ["nice", { v: "n", f: "", lv: ["adjustment"], numeric: true }],
  ["timeout", { v: "sk", f: "v", lv: ["signal", "kill-after"], lf: ["preserve-status", "foreground", "verbose"], positional: 1 }],
  ["stdbuf", { v: "ioe", f: "", lv: ["input", "output", "error"] }],
  ["sudo", { v: "ughpCDRTUrt", f: "AbEeHiKklnPSsVv", lv: ["user", "group", "host", "prompt", "chdir", "close-from", "other-user", "role", "type", "command-timeout", "chroot"],
    lf: ["askpass", "background", "preserve-env", "edit", "set-home", "login", "remove-timestamp", "reset-timestamp", "non-interactive", "preserve-groups", "stdin", "shell", "validate"] }],
  ["xargs", { v: "nPILsdEa", f: "0rtpxo", lv: ["max-args", "max-procs", "replace", "max-lines", "max-chars", "delimiter", "eof", "arg-file", "process-slot-var"],
    lf: ["null", "no-run-if-empty", "verbose", "interactive", "exit", "open-tty"] }],
  ["time", { v: "fo", f: "pvaq", lv: ["format", "output"], lf: ["portability", "verbose", "append", "quiet"] }],
  ["ionice", { v: "cnpPu", f: "t", lv: ["class", "classdata", "pid", "pgid", "uid"], lf: ["ignore"] }],
]);
// Launchers whose options and plain words hide which program they run (a priority, a mask, a lock file, a user): refused as a
// program. The guard refuses them for the shipper too.
const LAUNCHERS = new Set(["chrt", "taskset", "nsenter", "unshare", "flock", "setpriv", "runuser", "su", "numactl", "chroot"]);
// Programs that leave a job running after the line ends: ship.mjs can't wait for or check what it does later. nohup, setsid,
// disown and coproc are refused as any plain word of a command (only a detacher uses them), at and batch as a program only
// (they are ordinary words too: `echo deployed at noon`).
const BACKGROUND = new Set(["nohup", "setsid", "disown", "coproc", "at", "batch"]);
const DETACHERS = new Set(["nohup", "setsid", "disown", "coproc"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "yash", "posh", "rbash", "fish", "csh", "tcsh"]);
// A shell's options that take a separate value (`bash -o pipefail -c ...`, `bash --rcfile f -c ...`).
const SHELL_VALUED = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
// The name a program word runs: no folder, no .exe (`/usr/bin/nohup`, `nohup.exe`, `C:/Tools/setsid.exe`).
const baseName = (w) => String(w).replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
// A word holding a quote or a backslash-escaped character (see commandTexts).
const marked = (w) => /[\u0001\u0003]/.test(w);
const unreadableWord = (why) => shipError(`a command that can't be read as bash reads it (${why}): write it plainly`);

// How a wrapper's option word is read: "value" (the next word is its value), "done" (nothing more to skip) or a throw for an
// option the table does not have.
function wrapperOption(spec, w) {
  if (marked(w)) throw unreadableWord("a quote or a backslash in a wrapper's option");
  if (w.startsWith("--")) {
    const [name, value] = [w.slice(2).split("=", 1)[0], w.includes("=")];
    if ((spec.lv ?? []).includes(name)) return value ? "done" : "value";
    if (!value && (spec.lf ?? []).includes(name)) return "done";
    throw unreadableWord(`an option the reader does not know for this wrapper: ${w}`);
  }
  if (spec.numeric && /^-\d+$/.test(w)) return "done";
  for (let k = 1; k < w.length; k++) {
    if (spec.v.includes(w[k])) return k === w.length - 1 ? "value" : "done";
    if (!spec.f.includes(w[k])) throw unreadableWord(`an option the reader does not know for this wrapper: ${w}`);
  }
  return "done";
}

// The tokens of one command text ({ op } or { word }), and its program words: the first word of each simple command after
// assignments, control words (with time's -p) and redirection targets, and the word a wrapper (env, command, timeout and the
// like) runs, its options, their values and its plain words before the program skipped.
function programWords(text) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    if (/[ \t]/.test(text[i])) { i++; continue; }
    OPERATOR.lastIndex = i;
    const m = OPERATOR.exec(text);
    if (m) { tokens.push({ op: m[0] }); i += m[0].length; continue; }
    let j = i;
    while (j < text.length && !/[ \t;&|<>()\n]/.test(text[j])) j++;
    tokens.push({ word: text.slice(i, j) });
    i = j;
  }
  const programs = [];
  let expect = true; // the next plain word is a program
  let skipTarget = false;
  let wrapped = null; // the spec of the wrapper whose program is still to come
  let skipValue = false;
  let positional = 0;
  let afterTime = false;
  let stopped = false;
  let pattern = false; // after ;; ;& or ;;& the words up to ) are the next case pattern, not a program
  for (const t of tokens) {
    if (t.op) {
      if (SEPARATORS.has(t.op)) { expect = true; wrapped = null; stopped = false; skipTarget = false; skipValue = false; afterTime = false; pattern = [";;", ";&", ";;&"].includes(t.op); }
      else skipTarget = true; // a redirection: its target is not a program
      continue;
    }
    const w = t.word;
    if (skipTarget) { skipTarget = false; continue; }
    if (pattern && w !== "esac") continue;
    pattern = false;
    if (stopped || !expect) continue;
    if (skipValue) { skipValue = false; continue; }
    if (wrapped) {
      if (w === "--") { wrapped = { ...wrapped, ended: true }; continue; }
      if (!wrapped.ended && w.startsWith("-") && w !== "-") { skipValue = wrapperOption(wrapped, w) === "value"; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w)) continue;
      if (positional > 0) { positional--; continue; }
    } else {
      if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w)) continue;
      if (afterTime && w.startsWith("-")) {
        if (w === "-p" || w === "--") continue;
        throw unreadableWord(`an option of time the reader does not know: ${w}`);
      }
      if (KEYWORDS.has(w)) { afterTime = w === "time"; continue; }
      if (NOT_A_COMMAND.has(w)) { stopped = true; continue; }
    }
    afterTime = false;
    programs.push(w);
    const spec = WRAPPERS.get(baseName(w));
    wrapped = spec ?? null;
    positional = spec?.positional ?? 0;
    expect = Boolean(spec);
  }
  return { tokens, programs };
}

// The command text a shell runs, from the raw words after its name (quote and escape marks still in them): its options are walked
// (`--norc`, `-o pipefail`, `+o x`, `-O x`, `--rcfile f`, `--init-file f`, `-e`, a `-lc` cluster, `--`), and when a cluster holds c,
// the first word after them is the text, quotes and escapes resolved. Fail closed: an option word with a quote or a backslash in
// it (`bash '-c' ...`, `bash -c'' ...`, `bash \-c ...`), and a command text with a backslash-escaped character in it (`bash -c 'x '\&`)
// can't be read the way bash reads them, so they throw.
function shellText(words, resolve) {
  let hasC = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === undefined) return undefined; // an operator: the command ended
    if (marked(w)) {
      if (!hasC || /^[-+]/.test(resolve(w))) throw unreadableWord("a quote or a backslash in a shell's options");
      if (w.includes(ESCAPED)) throw unreadableWord("a backslash-escaped character in a shell's command text");
      return resolve(w);
    }
    if (w === "--") {
      const text = words[i + 1];
      if (!hasC || text === undefined) return undefined;
      if (text.includes(ESCAPED)) throw unreadableWord("a backslash-escaped character in a shell's command text");
      return resolve(text);
    }
    if (SHELL_VALUED.has(w)) { i++; continue; }
    if (/^[-+][A-Za-z]+$/.test(w)) { if (w[0] === "-" && w.includes("c")) hasC = true; continue; }
    if (w.startsWith("--")) continue;
    return hasC ? w : undefined;
  }
  return undefined;
}

// The command text of env -S, --split-string, an attached -S... or --split-string=..., from the raw words after env.
function envText(words, resolve) {
  for (let i = 0; i < words.length && words[i] !== undefined; i++) {
    const r = resolve(words[i]);
    if (r === "--") return undefined;
    const attached = /^-[A-Za-z0-9]*S(.+)$/.exec(r) ?? /^--split-string=(.*)$/.exec(r);
    if (attached) return attached[1];
    if (/^-[A-Za-z0-9]*S$/.test(r) || r === "--split-string") return words[i + 1] === undefined ? undefined : resolve(words[i + 1]);
    if (!r.startsWith("-")) return undefined;
  }
  return undefined;
}

// Throws a ship error for a line the checks in ship.mjs could be fooled by: a background job (& as an operator; nohup, setsid,
// disown or coproc as any plain word; at or batch as a program; with or without a folder or .exe), a launcher that hides its
// program, a program word holding a glob, a brace, $, a quote or a substitution (`g?t push`, `/usr/bin/g?t`, `${G:-git}`; `[` and
// `[[` are programs of their own), a brace expansion anywhere (`git pu{,}sh`), a wrapper option the reader does not know, and what
// commandTexts can't read. The text a shell runs with -c (after any of its options) and the text of env -S are read the same way,
// three levels deep; a quote or a backslash where they can't be read the way bash reads them is refused.
function checkReadable(line, depth = 0) {
  const { texts, quotes, escapes } = commandTexts(line);
  const resolve = (w) => w.replace(new RegExp(`${QUOTED}(\\d+)${QUOTED}`, "g"), (_, n) => quotes[Number(n)])
    .replace(new RegExp(`${ESCAPED}(\\d+)${ESCAPED}`, "g"), (_, n) => escapes[Number(n)]);
  const job = (what) => shipError(`a background job (${what}) in a ship line: ship.mjs can't wait for what it does later; run it in the foreground`);
  for (const text of texts) {
    if (/(^|[^$])\{[^{}\s]*(,|\.\.)[^{}\s]*\}/.test(text)) throw shipError("a brace expansion ({a,b} or {1..3}) in a ship line: write each word out");
    const { tokens, programs } = programWords(text);
    if (tokens.some((t) => t.op === "&")) throw job("&");
    for (const t of tokens) if (t.word && DETACHERS.has(baseName(t.word))) throw job(baseName(t.word));
    for (const p of programs) {
      if (BACKGROUND.has(baseName(p))) throw job(baseName(p));
      if (LAUNCHERS.has(baseName(p))) throw shipError(`a launcher the reader can't follow (${baseName(p)}) in a ship line: run the program directly`);
      if (p !== "[" && p !== "[[" && /[*?[\]{}$`]|[\u0001-\u0003]/.test(p)) throw shipError("a program name with a glob, a brace, $, a quote or a substitution in a ship line: write the program name out plainly");
    }
    if (depth >= 3) continue;
    // The text a shell runs with -c (bash --norc -c 'sleep 1 &'), and env -S text.
    const words = tokens.map((t) => t.word);
    for (let k = 0; k < words.length; k++) {
      if (!words[k] || marked(words[k])) continue;
      const name = baseName(words[k]);
      const inner = SHELLS.has(name) ? shellText(words.slice(k + 1), resolve) : name === "env" ? envText(words.slice(k + 1), resolve) : undefined;
      if (inner) checkReadable(inner, depth + 1);
    }
  }
}

// The word commit anywhere in a command as bash reads it (`git com''mit`, `git c\ommit`, `bash -c 'git commit -a'`, `$(echo commit)`).
// --commit and --commit-hash=x are other words.
const COMMIT_WORD = /(^|[\s;&|()<>`$"'=])commit($|[\s;&|()<>`$"'])/i;
const mentionsCommit = (command) => bashForms(command).some((t) => COMMIT_WORD.test(t));
// A git push anywhere in a command as bash reads it: a word git (or a path to it) and a later word push, or git-push. A deploy
// tool's own push (`docker push`) has no git before it and is not one.
const GIT_PROGRAM = /(^|[\\/])git(\.exe)?$/i;
const GIT_PUSH_PROGRAM = /(^|[\\/])git-push(\.exe)?$/i;
const mentionsPush = (command) => bashForms(command).some((t) => {
  const w = t.split(/[\s;&|()<>`$"'=]+/).filter(Boolean);
  const g = w.findIndex((x) => GIT_PROGRAM.test(x) || GIT_PUSH_PROGRAM.test(x));
  return g >= 0 && (GIT_PUSH_PROGRAM.test(w[g]) || w.slice(g + 1).some((x) => x.toLowerCase() === "push"));
});

// A step's commit: null when the step has no word commit, otherwise { file } for a strict commit step: exactly `git commit`
// written plainly, then only -q (--quiet), -s (--signoff), --no-edit and one -F <file> (-F<file>, a cluster of q and s
// ending in F, --file <file>, --file=<file>), whose file is a plain path written out in full (quotes are fine; no expansion,
// no - for stdin). Anything else with the word commit, as bash reads it (a global option, -a, -i, -o, -p, a pathspec, --amend,
// -m, an operator, a prefix word such as command or an assignment, a quoted or escaped git or commit) throws an error with code
// "ship": it would commit what the scan and the tree check in ship.mjs never saw.
export function commitStep(step) {
  if (!mentionsCommit(step)) return null;
  const { words, operator } = stepWords(step);
  const refuse = (why) => { throw shipError(`a step with the word commit must be exactly git commit with -q, -s, --no-edit and one -F '<file>': ${why}`); };
  if (operator) refuse("no operator, redirection, substitution or comment");
  if (words.length < 2 || words[0].raw !== "git" || words[1].raw !== "commit") refuse("it starts with git commit, written plainly");
  let file;
  const take = (value) => {
    if (file !== undefined) refuse("one -F only");
    if (!value || !value.literal || value.word === "" || value.word.startsWith("-")) refuse("the -F value must be a plain path written out in full");
    file = value.word;
  };
  for (let i = 2; i < words.length; i++) {
    const { raw, word, literal } = words[i];
    if (["-q", "--quiet", "-s", "--signoff", "--no-edit"].includes(raw) || /^-[qs]+$/.test(raw)) continue;
    if (raw === "--file" || /^-[qs]*F$/.test(raw)) { take(words[++i]); continue; }
    const m = /^(-[qs]*F|--file=)/.exec(raw);
    if (m) { take({ word: word.slice(m[1].length), literal }); continue; }
    refuse(`${JSON.stringify(raw)} is not one of them`);
  }
  if (file === undefined) refuse("it needs -F '<file>'");
  return { file };
}

// Whether the words of one simple command are the strict push: exactly `git push`, an optional -q (--quiet), `origin` and the
// block's branch, each written plainly. No refspec with a colon or a +, no other remote or branch, no tag, --all, --tags,
// --force, --delete, -u or any other option.
const strictPush = (words, branch) => {
  const raw = words.map((w) => w.raw);
  const rest = raw[2] === "-q" || raw[2] === "--quiet" ? raw.slice(3) : raw.slice(2);
  return raw[0] === "git" && raw[1] === "push" && rest.length === 2 && rest[0] === "origin" && rest[1] === branch;
};
const PUSH_FORM = "git push [-q] origin <the block's branch>";

// A step's push: false when the step has no git push, true for a strict push step (the strict push and nothing else: no
// operator, no second command). Anything else with a git push throws an error with code "ship": what is pushed must be HEAD on
// the block's branch, which ship.mjs then checks on origin.
export function pushStep(step, branch) {
  if (!mentionsPush(step)) return false;
  const { words, operator } = stepWords(step);
  if (operator || !strictPush(words, branch)) throw shipError(`a step with git push must be exactly ${PUSH_FORM}, on its own: no refspec, tag, other remote or branch, option or second command`);
  return true;
}

// A rollback line may push only with the strict push form, and only when every operator in it is && (so a failed command
// stops it before the push).
function rollbackPushes(line, branch) {
  if (!mentionsPush(line)) return;
  const { words, ops } = stepWords(line);
  const refuse = () => { throw shipError(`a rollback line pushes only with ${PUSH_FORM}, joined with && (git revert --no-edit HEAD && git push origin ${branch})`); };
  if (ops.some((o) => o !== "&&")) refuse();
  for (let seg = 0; seg <= ops.length; seg++) {
    const part = words.filter((w) => w.seg === seg);
    if (mentionsPush(part.map((w) => w.raw).join(" ")) && !strictPush(part, branch)) refuse();
  }
}

// The commit message files of the steps (the -F value of each strict commit step), in order. Throws an error with code
// "ship" for a step with the word commit that is not a strict commit step (see commitStep).
export function messageFiles(steps) {
  return steps.map((s) => commitStep(s)).filter(Boolean).map((c) => c.file);
}

// ---------- the code binding ----------

const realSlash = (p) => realpathSync.native(resolve(p)).replace(/\\/g, "/");
const foldCase = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
// A file's path relative to the root, with forward slashes, or null when it is outside the root.
function inside(rootReal, fileReal) {
  const rel = relative(rootReal, fileReal).replace(/\\/g, "/");
  return rel === "" || rel.startsWith("../") || rel === ".." || isAbsolute(rel) ? null : rel;
}
// A path name as text that can be printed: control and format characters become \u escapes.
const UNPRINTABLE = new RegExp(`[${ch(0)}-${ch(0x1f)}${ch(0x7f)}-${ch(0x9f)}${ch(0x61c)}${ch(0x200b)}-${ch(0x200f)}${ch(0x2028)}-${ch(0x202e)}${ch(0x2060)}-${ch(0x2069)}${ch(0xfeff)}]`, "gu");
const printable = (s) => String(s).replace(UNPRINTABLE, (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`);
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const MAX_NAMES = 50;
export const CODE_CHANGED = "the code changed since it was previewed (only the plan and the roadmap may change); changed paths:";

// The paths that may differ from the previewed tree, root-relative with forward slashes: { plan, roadmap } (roadmap null
// without --roadmap). Fixed at --record and stored, so the caller of --check can't choose them. Throws an Error with a
// message for a plan or roadmap that is a link, that is outside the project folder (after links on the way are resolved),
// a plan that is not a phase-*.md file in a folder named phases, and a roadmap whose file name is not PHASES.md.
function allowedPaths(rootReal, plan, roadmap) {
  const rel = (p, what) => {
    let link;
    try { link = lstatSync(resolve(p)).isSymbolicLink(); } catch (e) { throw new Error(`can't read the ${what}: ${e.message}`); }
    if (link) throw new Error(`the ${what} is a link`);
    const r = inside(rootReal, realSlash(p));
    if (r === null) throw new Error(`the ${what} is not inside the project folder`);
    return r;
  };
  const planRel = rel(plan, "plan");
  const parts = planRel.split("/");
  if (!/^phase-.+\.md$/i.test(parts[parts.length - 1]) || (parts[parts.length - 2] ?? "").toLowerCase() !== "phases") {
    throw new Error("the plan is not a phase-*.md file in a folder named phases");
  }
  let roadmapRel = null;
  if (roadmap !== undefined) {
    roadmapRel = rel(roadmap, "roadmap");
    if (roadmapRel.split("/").pop() !== "PHASES.md") throw new Error("the roadmap's file name is not PHASES.md");
  }
  return { plan: planRel, roadmap: roadmapRel };
}

// The record's code part for --record previewed --root: { root, tree, head, messages, allowed }. Throws an Error with a message.
function codeBinding(section, rootReal, io, plan, roadmap) {
  const allowed = allowedPaths(rootReal, plan, roadmap);
  let messages = [];
  let block = null;
  try { block = shipBlock(section); } catch { block = null; } // an invalid block is refused by ship.mjs; it binds no file
  if (block) {
    messages = block.messages.map((file) => {
      let path;
      try { path = realSlash(resolve(rootReal, file)); } catch { throw new Error(`can't read the commit message file ${printable(file)} named in the ship block`); }
      return { file, path, sha256: sha256File(path) };
    });
  }
  const tree = treeId(rootReal, io);
  const head = headId(rootReal, io);
  return { root: rootReal, tree, head, messages, allowed };
}

// A bound commit message file, checked again: { why } when it is not at its previewed real path (a folder link on its way
// was re-pointed: `git commit -F` would read another file) or its SHA-256 changed, or null when it is the previewed file.
// ship.mjs calls this right before each commit step.
export function messageChanged(rootReal, m) {
  let now;
  try { now = realSlash(resolve(rootReal, String(m?.file))); } catch { return { why: "changed" }; }
  if (typeof m.path !== "string" || foldCase(now) !== foldCase(m.path)) return { why: "moved" };
  let sum = null;
  try { sum = sha256File(now); } catch { sum = null; }
  return sum !== null && sum === m.sha256 ? null : { why: "changed" };
}

// Compares the plan with its record. Returns { code, out, err, section, hash, saved }: code 0 is a match, 1 a usage or I/O
// error, 2 no or an ambiguous "## Commands" section, 3 a difference, 4 no record (or an edited one). Reads only; writes nothing.
// opts.root (and opts.roadmap) add the code binding (see the header); a match then also has root (the bound real project
// folder, forward slashes) and allowed (the paths that may differ, as compared: case-folded on Windows). ship.mjs calls this
// in-process and runs every command in that root.
export function checkPreviewed(plan, data, stage, opts = {}, io = {}) {
  const res = (code, out = "", err = "", extra = {}) => ({ code, out, err, ...extra });
  let planText;
  try { planText = readFileSync(plan, "utf8"); } catch (e) { return res(1, "", `can't read the plan: ${e.message}\n`); }
  let section;
  try { section = commandsSection(planText); } catch (e) {
    if (e?.code !== "ambiguous") throw e;
    return res(2, "", `ambiguous Commands heading in ${plan}: ${e.message}\n`);
  }
  if (section === null) return res(2, "", `no "## Commands" section in ${plan}\n`);
  const hash = hashOf(section);
  let file;
  try { file = recordPath(data, plan, stage); } catch (e) { return res(1, "", `can't resolve the plan's real path: ${e.message}\n`); }
  if (!existsSync(file)) return res(4, `no ${stage} record for this plan\n`);
  let saved;
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { saved = null; }
  if (!saved || typeof saved.hash !== "string" || typeof saved.text !== "string") return res(4, `the ${stage} record is unreadable\n`);
  // The text is what ship.mjs runs and what the user was shown: it must be the text the hash was made of.
  if (hashOf(saved.text) !== saved.hash) return res(4, `the ${stage} record's text does not match its hash (the record was edited): record it again\n`);
  if (saved.hash !== hash) {
    return res(3, `the Commands section changed since it was ${stage} (${saved.hash.slice(0, 12)} -> ${hash.slice(0, 12)}):\n${lineDiff(saved.text, section).join("\n")}\n`);
  }
  const matched = res(0, `match ${hash.slice(0, 12)}\n${section}\n`, "", { section, hash, saved });
  if (opts.root === undefined) return matched;

  let rootReal;
  let planRel;
  let roadmapRel;
  try {
    rootReal = realSlash(opts.root);
    planRel = inside(rootReal, realSlash(plan));
    roadmapRel = opts.roadmap === undefined ? undefined : inside(rootReal, realSlash(opts.roadmap));
  } catch (e) { return res(1, "", `can't resolve --root, the plan or --roadmap: ${e.message}\n`); }
  if (typeof saved.tree !== "string" || typeof saved.root !== "string" || !Array.isArray(saved.messages)) {
    return res(3, `the ${stage} record holds no tree id, so the code can't be checked: preview again\n`);
  }
  const fixed = saved.allowed;
  if (!fixed || typeof fixed !== "object" || typeof fixed.plan !== "string" || !(fixed.roadmap === null || typeof fixed.roadmap === "string")) {
    return res(3, `the ${stage} record holds no list of the paths that may change (it was made before that check): preview again\n`);
  }
  if (foldCase(saved.root) !== foldCase(rootReal)) return res(3, `the project folder is not the one that was ${stage}: preview again\n`);
  // The paths that may change are the stored ones: a --roadmap (or a plan) given now must be the one that was previewed.
  if (planRel === null || foldCase(planRel) !== foldCase(fixed.plan)) return res(3, `the plan given now is not the ${stage} one (${printable(fixed.plan)}): preview again\n`);
  if (roadmapRel !== undefined && (roadmapRel === null || fixed.roadmap === null || foldCase(roadmapRel) !== foldCase(fixed.roadmap))) {
    return res(3, `the roadmap given now is not the ${stage} one (${fixed.roadmap === null ? "none" : printable(fixed.roadmap)}): preview again\n`);
  }
  const allowed = [fixed.plan, ...(roadmapRel === undefined ? [] : [fixed.roadmap])].map(foldCase);
  let current;
  try { current = treeId(rootReal, io); } catch (e) {
    if (e instanceof Refusal) return res(1, "", `${e.message}\n`);
    throw e;
  }
  if (current !== saved.tree) {
    let names;
    try { names = changedPaths(rootReal, saved.tree, current, io); } catch (e) {
      if (e instanceof Refusal) return res(3, `the ${stage} tree can't be compared with the current one (its objects may be gone): preview again\n`);
      throw e;
    }
    const other = names.filter((n) => !allowed.includes(foldCase(n)));
    if (other.length) {
      const shown = other.slice(0, MAX_NAMES).map((n) => `  ${printable(n)}`);
      if (other.length > MAX_NAMES) shown.push(`  and ${other.length - MAX_NAMES} more`);
      return res(3, `${CODE_CHANGED}\n${shown.join("\n")}\n`);
    }
  }
  let expected;
  try { expected = shipBlock(section)?.messages ?? []; } catch { expected = []; }
  const bound = saved.messages;
  if (bound.length !== expected.length || bound.some((m, i) => m?.file !== expected[i])) {
    return res(3, `the commit message files in the ${stage} record don't match the ship block: preview again\n`);
  }
  for (const m of bound) {
    // Resolved again from the project folder first: a folder link on its way re-pointed elsewhere is refused even when the
    // file there has the same bytes, because `git commit -F` follows the link.
    const changed = messageChanged(rootReal, m);
    if (changed?.why === "moved") return res(3, `the commit message file is not at its ${stage} real path (a folder on its way changed): ${printable(m.file)}\n`);
    if (changed) return res(3, `the commit message file changed since it was ${stage}: ${printable(m.file)}\n`);
  }
  return { ...matched, root: rootReal, allowed };
}

function usageTo(message, err) {
  if (message) err(`${message}\n`);
  err("usage: commands-hash.mjs <plan> [--short] [--record <planned|previewed> --data <dir> [--root <dir> [--roadmap <file>]]] [--check <planned|previewed> --data <dir> [--root <dir> [--roadmap <file>]]]\n");
  return 1;
}

// main(argv, io): io.out and io.err take a piece of text each (default: stdout and stderr); the return value is the exit code.
// io.git and io.tmpdir go to tree-state.mjs treeId (see there).
export function main(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((text) => process.stderr.write(text));
  const usage = (message) => usageTo(message, err);
  let plan;
  let short = false;
  let record;
  let check;
  let data;
  let root;
  let roadmap;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--short") short = true;
    else if (a === "--record" || a === "--check" || a === "--data" || a === "--root" || a === "--roadmap") {
      if (i + 1 >= argv.length || String(argv[i + 1]).startsWith("--")) return usage(`${a} needs a value`);
      const value = argv[++i];
      if (a === "--record") record = value;
      else if (a === "--check") check = value;
      else if (a === "--root") root = value;
      else if (a === "--roadmap") roadmap = value;
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
  if (roadmap !== undefined && root === undefined) return usage("--roadmap goes with --root");
  if (root !== undefined && stage !== "previewed") return usage("--root goes with --record previewed or --check previewed");

  if (check !== undefined) {
    const r = checkPreviewed(plan, data, check, { root, roadmap }, io);
    if (r.err) err(r.err);
    if (r.out) out(r.out);
    return r.code;
  }

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

  if (record !== undefined) {
    let real;
    try { real = realSlash(plan); } catch (e) { return usage(`can't resolve the plan's real path: ${e.message}`); }
    let code = {};
    if (root !== undefined) {
      let rootReal;
      try { rootReal = realSlash(root); } catch (e) { return usage(`can't resolve --root: ${e.message}`); }
      try { code = codeBinding(section, rootReal, io, plan, roadmap); } catch (e) {
        err(`${e.message}; nothing was recorded\n`);
        return 1;
      }
    }
    const file = recordPath(data, plan, record);
    try {
      mkdirSync(join(resolve(data), "previews"), { recursive: true });
      writeFileSync(file, JSON.stringify({ hash, text: section, plan: real, at: new Date().toISOString(), ...code }, null, 2) + "\n");
    } catch (e) { return usage(`can't write the record: ${e.message}`); }
    out(`recorded ${record} ${hash.slice(0, 12)}\n${section}\n`);
    if (code.allowed) {
      const may = [code.allowed.plan, code.allowed.roadmap].filter((p) => p !== null).map(printable).join(", ");
      out(`code bound to the tree ${code.tree.slice(0, 12)}; only these may change: ${may}\n`);
    }
    return 0;
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
