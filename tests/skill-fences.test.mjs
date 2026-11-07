// Run with: node --test tests/skill-fences.test.mjs
// The code fences in every skill and agent file must close where the writer meant them to. A template written as a fence inside
// a fence of the same length closes early (everything after it renders inverted), and a space-split glyph standing in for an inner
// fence is copied into the output as it is. Inner fences go inside an outer fence with more backticks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The problems in one Markdown text, as lines of words (empty when the fences are sound). A fence closes with the same character,
// at least as many of them and nothing after; a line that opens a fence with an info string inside an open fence of the same or a
// longer length is the ambiguous nesting that closes the outer fence early.
export function fenceProblems(text) {
  const problems = [];
  let open = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    if (/^` ``/.test(line)) problems.push(`line ${n}: a space-split fence glyph; write a real fence inside a longer outer fence`);
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      if (!m || m[1][0] !== open.char || m[1].length < open.len) return;
      if (m[2].trim() === "") { open = null; return; }
      problems.push(`line ${n}: a fence with an info string inside the fence opened at line ${open.line} (same or longer length); give the outer fence more backticks`);
      return;
    }
    if (!m) return;
    if (m[1][0] === "`" && m[2].includes("`")) return; // inline code at the start of a line, not a fence
    open = { char: m[1][0], len: m[1].length, line: n };
  });
  if (open) problems.push(`the fence opened at line ${open.line} is never closed`);
  return problems;
}

const files = () => {
  const out = [];
  const skills = join(ROOT, "skills");
  for (const name of readdirSync(skills)) {
    const dir = join(skills, name);
    if (existsSync(join(dir, "SKILL.md"))) out.push(`skills/${name}/SKILL.md`);
    const refs = join(dir, "references");
    if (existsSync(refs)) for (const f of readdirSync(refs)) if (f.endsWith(".md")) out.push(`skills/${name}/references/${f}`);
  }
  const agents = join(ROOT, "agents", "claude");
  for (const f of readdirSync(agents)) if (f.endsWith(".md")) out.push(`agents/claude/${f}`);
  return out;
};

test("the checker passes sound fences and names each way a fence goes wrong (made-up text)", () => {
  const T = "```";
  const F = "````";
  assert.deepEqual(fenceProblems(`# zork\n\n${T}js\nlet a = 1;\n${T}\n\ntext\n`), []);
  assert.deepEqual(fenceProblems(`${F}markdown\n# acmecorp\n\n${T}mermaid\nflowchart TD\n${T}\n\n## Notes\n${F}\n`), [], "an inner fence inside a longer outer fence is sound");
  assert.deepEqual(fenceProblems(`${T}text\n${T}\n${T}text\n${T}\n`), [], "two fences one after the other");
  assert.deepEqual(fenceProblems("`inline code` at the start of a line\n"), []);
  const nested = fenceProblems(`${T}markdown\n# zork\n\n${T}mermaid\nflowchart TD\n${T}\n\n## Notes\n${T}\n`);
  assert.equal(nested.length, 2, "the early close also leaves the last fence open");
  assert.match(nested[0], /^line 4: a fence with an info string inside the fence opened at line 1/);
  assert.equal(nested[1], "the fence opened at line 9 is never closed");
  assert.deepEqual(fenceProblems(`${T}js\nnever closed\n`), ["the fence opened at line 1 is never closed"]);
  assert.match(fenceProblems("text\n` ``mermaid\nflowchart TD\n` ``\n")[0], /^line 2: a space-split fence glyph/);
  assert.equal(fenceProblems("~~~\n~~~\n~~~~\n~~~~\n").length, 0);
  assert.equal(fenceProblems(`${T}\n~~~js\n${T}\n`).length, 0, "a tilde line does not close or nest in a backtick fence");
});

test("every skill, skill reference and agent file has fences that close where they were meant to", () => {
  const list = files();
  assert.ok(list.length >= 12, `found only ${list.length} files`);
  const found = [];
  for (const file of list) for (const p of fenceProblems(readFileSync(join(ROOT, file), "utf8"))) found.push(`${file}: ${p}`);
  assert.deepEqual(found, []);
});
