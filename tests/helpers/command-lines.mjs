// The checker behind tests/command-lines.test.mjs: it reads the Markdown that tells a model to run a `.mjs` script and
// reports every command line that does not follow the quoting rule. In-process, no child processes, and every scan is
// linear in the size of the text (nothing is re-scanned from each match).
//
// A script line is text a model could build a command from: an inline code span (a run of N backticks closes on the next
// run of N), an HTML <code> element, a line in a fenced block or a <pre> block (a line ending in a backslash joins the
// next), or an indented code line. It is a script line when it runs a `.mjs` script, or holds a <placeholder> together with
// an option (`--x`, also after `[`, `(` or `|`), a quote, a `$`, or a script subcommand word (read, check, ...). What fails:
//   - a double-quoted string that is not exactly "${CLAUDE_SKILL_DIR}...", "${CLAUDE_PLUGIN_DATA}..." or a listed fixed word;
//   - a `$` or a backtick outside single quotes (outside those two variables), an unbalanced quote, a curly quote
//     (U+2018 to U+201E), an HTML entity, a {name}, an ALL_CAPS or a [bracketed words] placeholder;
//   - a bare <placeholder> that is not on the validated list, that does not follow its own option, or whose pattern or
//     word list the same file does not state;
//   - a <code> or <pre> element with attributes, and an indented code line that also holds a backtick;
//   - a file with single-quoted placeholders that does not state every piece of the unsafe-character rule.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const LABEL = "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$";
// A placeholder written bare is allowed only for a value with a stated pattern or word list, and only after the option it belongs to.
// `after` tests the 40 characters before the placeholder; `states` is the text the same file must hold (null: nothing to state).
const opt = (name) => new RegExp(`${name}\\s+$`);
export const BARE = new Map([
  ["phase id", { after: /(--phase|')\s+$/, where: "--phase or a quoted path", states: LABEL }],
  ["label", { after: opt("--label"), where: "--label", states: LABEL }],
  ["history label", { after: opt("--label"), where: "--label", states: LABEL }],
  ["commit", { after: opt("--commit"), where: "--commit", states: "^[0-9a-f]{7,40}$" }],
  ["hours", { after: opt("--actual"), where: "--actual", states: "^\\d{1,3}(\\.\\d{1,2})?$" }],
  ["list digest", { after: opt("--list-digest"), where: "--list-digest", states: "^[0-9a-f]{12,64}$" }],
  ["id", { after: opt("unregister"), where: "unregister", states: "^[0-9a-f]{12}$" }],
  ["relative path", { after: opt("--roadmap"), where: "--roadmap", states: "^[A-Za-z0-9._/-]{1,100}$" }],
  ["seconds", { after: opt("--refresh-s"), where: "--refresh-s", states: "whole number from 5 to 300" }],
  ["index", { after: opt("--table"), where: "--table", states: "^\\d{1,3}$" }],
  ["step", { after: opt("--step"), where: "--step", states: "fixed lists" }],
  ["state", { after: opt("--state"), where: "--state", states: "fixed lists" }],
  ["command", { after: /roadmap\.mjs\s+$/, where: "roadmap.mjs", states: "one of `read`, `check`, `standardize`, `set`, `restore` or `adopt`" }],
  ["command...", { after: /--\s+$/, where: "--", states: "the user's own command" }],
]);

// The unsafe-character rule: each piece must be in the file.
export const RULE_PIECES = ["single quote", "double quote", "control or format character", "U+2018 to U+201B", "trailing separator", "file-system root", "Bash tool"];

// A double-quoted string that is safe: a Claude Code variable (with a literal path after it) or one fixed word from this list.
// ("$CLAUDE_CODE_EXECPATH" is set by Claude Code, like the two variables)
const FIXED_DOUBLE = new Set(['"in progress"', '"$CLAUDE_CODE_EXECPATH"']);
const SAFE_VARIABLE = /^"\$\{CLAUDE_(?:SKILL_DIR|PLUGIN_DATA)\}[A-Za-z0-9 ._/-]*"$/;
// words that are fixed literals on a script line, not placeholders (none today)
const LITERAL_CAPS = new Set([]);
const PLACEHOLDER = /<[A-Za-z][^<>]*>/;
const OPTION = /(^|[\s[(|])--[a-z]/;
// a script subcommand word followed by a value: a quote, a placeholder or an option
const SUBCOMMAND = /^\s*(?:read|check|standardize|set|restore|adopt|list|run|classify|show|decline|state|enable|unregister|page|collect|id|record)\s+(?:['"<[-])/;
// the one fixed shell line that wraps an approved plan command (the checker runs it)
const FIXED_LINES = new Set(['SECONDS=0; <command>; echo "exit=$? seconds=$SECONDS"']);
const FENCE = /^\s*(`{3,}|~{3,})/;
const INDENTED = /^( {4,}|\t)/;
const ENTITY = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;
const CURLY = /[\u2018-\u201e]/;
// an inline span that starts with a brace and runs no script is a data sample (JSON), not a command
const JSON_SAMPLE = /^\s*\{/;
// a block line (fenced or <pre>) is a script line when it runs a .mjs script or puts a placeholder beside an option: blocks hold code in
// other languages and data samples too. Inline text, <code> and indented lines also count with a quote, a $ or a subcommand word.
const isScript = (t, block = false) => {
  if (FIXED_LINES.has(t)) return false;
  if (t.includes(".mjs")) return true;
  if (/^\s*git /.test(t)) return false;
  if (PLACEHOLDER.test(t) && (OPTION.test(t) || (!block && !JSON_SAMPLE.test(t) && (/['"$]/.test(t) || SUBCOMMAND.test(t))))) return true;
  // an option with a double-quoted or $ value needs no placeholder to be a command line: --into "$(x)"
  return !block && OPTION.test(t) && /["$]/.test(t);
};

// The inline code spans of one row: a run of N backticks opens a span that the next run of exactly N closes.
function* spansOf(row) {
  const none = new Set(); // lengths of backtick runs that have no closing run after them: no later run of that length has one either
  let i = 0;
  while (i < row.length) {
    if (row[i] !== "`") { i++; continue; }
    let j = i;
    while (row[j] === "`") j++;
    const n = j - i;
    if (none.has(n)) { i = j; continue; }
    let k = j;
    let found = -1;
    while (k < row.length) {
      if (row[k] !== "`") { k++; continue; }
      let m = k;
      while (row[m] === "`") m++;
      if (m - k === n) { found = k; break; }
      k = m;
    }
    if (found < 0) { none.add(n); i = j; continue; }
    yield row.slice(j, found);
    i = found + n;
  }
}

// The script lines of a document: { line, text } or { line, problem }, line starting at 1.
export function scriptLines(doc) {
  const out = [];
  let mode = null; // { fence: "```" } or { pre: true }
  let buf = null; // a fenced line that ended in a backslash, waiting for the next
  const flush = () => { if (buf && isScript(buf.text, true)) out.push(buf); buf = null; };
  const fenced = (row, line) => {
    const trimmed = row.trimEnd();
    const text = `${buf ? `${buf.text} ` : ""}${(trimmed.endsWith("\\") ? trimmed.slice(0, -1) : trimmed).trim()}`;
    buf = { line: buf ? buf.line : line, text };
    if (!trimmed.endsWith("\\")) flush();
  };
  const rows = doc.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const line = i + 1;
    if (mode?.fence) {
      const m = FENCE.exec(row);
      if (m && m[1][0] === mode.fence[0] && m[1].length >= mode.fence.length && row.trim() === m[1]) { flush(); mode = null; } else fenced(row, line);
      continue;
    }
    if (mode?.pre) {
      const end = row.indexOf("</pre>");
      fenced(end >= 0 ? row.slice(0, end) : row, line);
      if (end >= 0) { flush(); mode = null; }
      continue;
    }
    const f = FENCE.exec(row);
    if (f) { mode = { fence: f[1] }; continue; }
    const pre = /<pre(\s|>)/i.exec(row);
    if (pre) {
      const gt = row.indexOf(">", pre.index);
      if (pre[1] !== ">") out.push({ line, problem: "a <pre> element with attributes: write plain <pre>" });
      const rest = gt >= 0 ? row.slice(gt + 1) : "";
      const end = rest.indexOf("</pre>");
      fenced(end >= 0 ? rest.slice(0, end) : rest, line);
      if (end >= 0) flush(); else mode = { pre: true };
      continue;
    }
    if (INDENTED.test(row)) {
      const t = row.trim();
      // a list item that is indented is not code
      if (!/^([-*+]|[0-9]+[.)])\s/.test(t) && isScript(t)) out.push(row.includes("`") ? { line, problem: "an indented code line that also holds a backtick" } : { line, text: t });
      if (!row.includes("`")) continue;
    }
    for (const s of spansOf(row)) if (isScript(s)) out.push({ line, text: s });
    let p = 0;
    for (;;) {
      const a = row.indexOf("<code", p);
      if (a < 0) break;
      const gt = row.indexOf(">", a);
      if (gt < 0) break;
      const close = row.indexOf("</code>", gt + 1);
      if (close < 0) break;
      const content = row.slice(gt + 1, close);
      if (/^<code[\s>]/.test(row.slice(a, a + 6)) && isScript(content)) {
        if (row[a + 5] !== ">") out.push({ line, problem: "a <code> element with attributes: write plain <code>" });
        out.push({ line, text: content });
      }
      p = close + 7;
    }
  }
  flush();
  return out;
}

// One script line, scanned left to right in three states (outside, single, double). Returns what lies outside quotes,
// whether a single-quoted placeholder was seen, and the problems.
function scan(text) {
  const chunks = [];
  const issues = [];
  let singlePlaceholder = false;
  let i = 0;
  let from = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c !== "'" && c !== '"') { i++; continue; }
    chunks.push(text.slice(from, i));
    let end;
    if (c === "'") end = text.indexOf("'", i + 1);
    else { end = i + 1; while (end < n && text[end] !== '"') end += text[end] === "\\" ? 2 : 1; if (end >= n) end = -1; }
    if (end < 0) { issues.push(`an unbalanced ${c} quote`); from = n; i = n; break; }
    const quoted = text.slice(i, end + 1);
    if (c === "'") {
      if (PLACEHOLDER.test(quoted)) singlePlaceholder = true;
      chunks.push("'x'");
    } else {
      if (!SAFE_VARIABLE.test(quoted) && !FIXED_DOUBLE.has(quoted)) {
        issues.push(PLACEHOLDER.test(quoted) ? "a double-quoted placeholder, write it in single quotes" : "a double-quoted value that is not a Claude Code variable or a listed fixed word, write it in single quotes");
      }
      chunks.push('"x"');
    }
    i = end + 1;
    from = i;
  }
  chunks.push(text.slice(from));
  return { rest: chunks.join(""), issues, singlePlaceholder };
}

// The problems of one document, each "<file>:<line>: <what>". `file` is only a label.
export function checkCommandLines(file, doc) {
  const problems = [];
  const stated = new Map(); // whether the document holds a text: asked once per text, not once per placeholder
  const has = (t) => { if (!stated.has(t)) stated.set(t, doc.includes(t)); return stated.get(t); };
  let singleQuoted = null;
  for (const item of scriptLines(doc)) {
    const at = `${file}:${item.line}`;
    if (item.problem) { problems.push(`${at}: ${item.problem}`); continue; }
    const { text } = item;
    const show = text.length > 70 ? `${text.slice(0, 70)}...` : text;
    const { rest, issues, singlePlaceholder } = scan(text);
    if (singlePlaceholder) singleQuoted ??= item.line;
    for (const why of issues) problems.push(`${at}: ${why}: ${show}`);
    if (/[$`]/.test(rest)) problems.push(`${at}: a $ or a backtick outside single quotes: ${show}`);
    if (CURLY.test(text)) problems.push(`${at}: a curly quote (U+2018 to U+201E) on a script line: ${show}`);
    if (ENTITY.test(text)) problems.push(`${at}: an HTML entity on a script line: ${show}`);
    if (/\{[^{}]*\}/.test(rest)) problems.push(`${at}: a {name} placeholder, write it in single quotes: ${show}`);
    for (const w of rest.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []) if (!LITERAL_CAPS.has(w)) { problems.push(`${at}: an ALL_CAPS placeholder ${w}, write it in single quotes: ${show}`); break; }
    if (/\[(?!--)[A-Za-z][A-Za-z ]*\]/.test(rest)) problems.push(`${at}: a [bracketed words] placeholder, write it in single quotes: ${show}`);
    for (const m of rest.matchAll(/<([A-Za-z][^<>]*)>/g)) {
      const name = m[1];
      const spec = BARE.get(name);
      if (!spec) { problems.push(`${at}: a bare <${name}> that is not on the validated list, write it in single quotes: ${show}`); continue; }
      if (!spec.after.test(rest.slice(Math.max(0, m.index - 40), m.index))) problems.push(`${at}: a bare <${name}> that does not follow ${spec.where}, write it in single quotes: ${show}`);
      if (spec.states && !has(spec.states)) problems.push(`${at}: a bare <${name}> but the file does not state its pattern or word list ${spec.states}: ${show}`);
    }
  }
  if (singleQuoted !== null) {
    for (const piece of RULE_PIECES) {
      if (!has(piece)) problems.push(`${file}:${singleQuoted}: single-quoted placeholders, but the file does not state the unsafe-character rule (missing "${piece}")`);
    }
  }
  return problems;
}

// Every .md file in scope under `root`: plugins/*/skills/**, plugins/*/agents/**, skills/** and agents/**.
export function scopeFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  };
  const tops = [join(root, "skills"), join(root, "agents")];
  const plugins = join(root, "plugins");
  if (existsSync(plugins)) {
    for (const p of readdirSync(plugins).sort()) tops.push(join(plugins, p, "skills"), join(plugins, p, "agents"));
  }
  for (const top of tops) if (existsSync(top) && statSync(top).isDirectory()) walk(top);
  return out.map((f) => relative(root, f).split("\\").join("/"));
}

// The problems of every file in scope.
export function checkTree(root) {
  return scopeFiles(root).flatMap((f) => checkCommandLines(f, readFileSync(join(root, f), "utf8")));
}
