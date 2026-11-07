// Run with: node --test tests/docs-writer-tag.test.mjs
// The docs-writer agent runs `git log` on a tag that comes from the repository. A tag such as `v1$(id)`, `v1;ls`, `a b` or one that
// starts with `-` can pass `git check-ref-format`, so the agent text must check the tag against a pattern before it goes into a
// command, refuse a tag that does not match, and write the command with the validated tag bare (no brace placeholder in it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = readFileSync(join(ROOT, "agents", "claude", "docs-writer.md"), "utf8");

const PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$";
const lines = (text) => text.split(/\r?\n/);

// The pattern as the agent text states it: the code span that starts with the anchor and the first character class.
const statedPattern = (text) => /`(\^\[A-Za-z0-9\][^`]*)`/.exec(text)?.[1];

// The problems in one copy of the agent text (empty when the tag rule is fully stated). Each rule is a separate entry so a
// mutation of the text can be shown to trip exactly the rule it removes.
function tagProblems(text) {
  const problems = [];
  if (statedPattern(text) !== PATTERN) problems.push(`the pattern ${PATTERN} is not stated`);
  if (!/does not contain `\.\.`/.test(text)) problems.push("the no-`..` rule is not stated");
  const refusal = lines(text).join(" ").split(/(?<=\.)\s/).find((s) => /does not match/.test(s));
  if (!refusal || !/do not run the command/.test(refusal) || !/which value was refused/.test(refusal)) {
    problems.push("a tag that does not match is not refused with the command left unrun and the value reported");
  }
  lines(text).forEach((line, i) => {
    for (const m of line.matchAll(/git log[^`\n]*/g)) {
      if (/[{}]/.test(m[0])) problems.push(`line ${i + 1}: a brace placeholder inside a git log command: ${m[0].trim()}`);
    }
  });
  if (!/^\s+version:\s*"1\.1\.1"\s*$/m.test(text)) problems.push("the version field is not 1.1.1");
  return problems;
}

test("the agent text states the tag pattern, the no-`..` rule, the refusal, a bare git log command and version 1.1.1", () => {
  assert.deepEqual(tagProblems(AGENT), []);
  assert.ok(AGENT.includes("`" + PATTERN + "`"), "the exact pattern is in a code span");
  assert.ok(AGENT.includes("`git describe --tags --abbrev=0`"), "the previous tag is found with git describe");
  assert.ok(AGENT.includes("`git rev-parse --verify --quiet 'refs/tags/<prev tag>'`"), "the existence check puts the validated tag in single quotes");
  assert.ok(AGENT.includes("`git log --oneline <prev tag>..HEAD`"), "the log command is written with the validated tag bare");
  assert.ok(!/\{prev-tag\}/.test(AGENT), "the old brace placeholder is gone");
});

test("the pattern, with the no-`..` rule, accepts ordinary tags and refuses every shell-special or option-like value (made-up tags)", () => {
  const pattern = new RegExp(statedPattern(AGENT));
  const allowed = (tag) => pattern.test(tag) && !tag.includes("..");
  for (const tag of ["v1.2.0", "release-3", "2026.11.07", "v1", "a" + "b".repeat(99)]) assert.ok(allowed(tag), `${tag} is accepted`);
  const refused = ["-x", "--output=x", "v1$(id)", "v1;ls", "a b", "a`id`", "v1|x", "'x'", "a..b", "", "a" + "b".repeat(100)];
  for (const tag of refused) assert.ok(!allowed(tag), `${JSON.stringify(tag)} is refused`);
  assert.equal(pattern.test("a..b"), true, "the pattern alone lets a..b through, so the separate no-`..` rule is needed");
  assert.equal(("a" + "b".repeat(100)).length, 101);
});

test("removing a rule from a copy of the agent text makes the check fail (mutation proof, in memory)", () => {
  const without = (drop) => AGENT.split(/\r?\n/).filter((line) => !drop(line)).join("\n");
  const noPattern = without((line) => line.includes(PATTERN));
  assert.ok(noPattern !== AGENT, "the copy really lost a line");
  assert.ok(tagProblems(noPattern).some((p) => p.startsWith("the pattern")), "the pattern line removed fails the pattern check");
  assert.ok(tagProblems(AGENT.replace("do not run the command", "run the command anyway")).some((p) => p.startsWith("a tag that does not match")), "the refusal removed fails the refusal check");
  assert.ok(tagProblems(AGENT.replace("which value was refused", "what happened")).some((p) => p.startsWith("a tag that does not match")), "the report removed fails the refusal check");
  assert.ok(tagProblems(AGENT.replace("git log --oneline <prev tag>..HEAD", "git log --oneline {prev-tag}..HEAD")).some((p) => p.includes("brace placeholder")), "a brace placeholder in a git log command fails");
  assert.ok(tagProblems(AGENT.replace("does not contain `..`", "is short")).some((p) => p.includes("no-`..`")), "the no-`..` rule removed fails");
  assert.ok(tagProblems(AGENT.replace('version: "1.1.1"', 'version: "1.1.0"')).some((p) => p.includes("version")), "the old version fails");
});
