// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSentence } from "../scripts/build-manifest.mjs";

test("a sentence ending within 200 characters is used as is", () => {
  assert.equal(firstSentence("Does a thing really well. Use when asked."), "Does a thing really well.");
  const s = "x".repeat(150) + " end.";
  assert.equal(firstSentence(`${s} More text.`), s);
});

test("whitespace is collapsed before the sentence is taken", () => {
  assert.equal(firstSentence("Does a\n  thing   really   well.\nMore."), "Does a thing really well.");
});

test("a first sentence longer than 200 characters is cut at a word boundary with an ellipsis", () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const out = firstSentence(`${words}. Second sentence.`);
  assert.ok(out.endsWith("\u2026"));
  assert.ok(out.length <= 158);
  const kept = out.slice(0, -1);
  assert.ok(words.startsWith(kept));
  assert.equal(words[kept.length], " ", "cut falls on a word boundary");
});

test("trailing punctuation and spaces are trimmed before the ellipsis", () => {
  const text = "a".repeat(100) + ", " + "b".repeat(100) + " tail";
  assert.equal(firstSentence(text), "a".repeat(100) + "\u2026");
});

test("a description with no sentence end: short stays whole, long is cut", () => {
  assert.equal(firstSentence("Short text without an end"), "Short text without an end");
  const long = Array.from({ length: 60 }, () => "lorem").join(" ");
  const out = firstSentence(long);
  assert.ok(out.endsWith("\u2026"));
  assert.ok(out.length <= 158);
  assert.match(out.slice(0, -1), /^(lorem )*lorem$/);
});

test("a long first word is cut hard at 157 characters", () => {
  const out = firstSentence("y".repeat(300) + " rest of the text");
  assert.equal(out, "y".repeat(157) + "\u2026");
});

test("every summary in the real library.json is within 240 characters", async () => {
  const { readFileSync } = await import("node:fs");
  const lib = JSON.parse(readFileSync(new URL("../library.json", import.meta.url), "utf8"));
  for (const i of lib.items) assert.ok(i.summary.length <= 240, i.slug);
});


