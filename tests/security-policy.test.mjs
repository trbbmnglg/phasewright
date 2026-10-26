// Run with: node --test tests/security-policy.test.mjs
// Checks that SECURITY.md exists at the root with no .github/ or docs/ copy shadowing it, has the agreed headings,
// promises only what one maintainer can keep, and claims no more about releases than the workflow does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const policy = () => read("SECURITY.md");
const section = (md, h) => (md.split(/^## /m).find((s) => s.startsWith(h)) ?? "");

test("SECURITY.md is at the root and nothing shadows it", () => {
  assert.ok(existsSync(join(ROOT, "SECURITY.md")));
  for (const p of [".github/SECURITY.md", "docs/SECURITY.md"]) {
    assert.ok(!existsSync(join(ROOT, p)), `${p} would take precedence`);
  }
});

test("it has the required headings in order", () => {
  const heads = policy().match(/^#{1,2} .+$/gm);
  assert.deepEqual(heads, [
    "# Security policy", "## Report a vulnerability", "## What to include", "## In scope",
    "## Out of scope", "## Supported versions", "## What to expect", "## Safe harbour", "## How releases are built",
  ]);
});

test("it links private reporting and a no-email fallback, and has no email", () => {
  const md = policy();
  assert.match(md, /https:\/\/github\.com\/trbbmnglg\/phasewright\/security\/advisories\/new/);
  assert.match(md, /Security contact request/);
  assert.doesNotMatch(md, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(md, /mailto:/i);
});

test("it makes no promise one maintainer can't keep and uses no forbidden words", () => {
  const md = policy();
  for (const re of [/\bPGP\b/, /bug bounty/i,
    /\b\d+\s*(hours?|hrs?)\b/i, /24\/7/, /\bwe guarantee\b|\bguaranteed\b/i]) {
    assert.doesNotMatch(md, re);
  }
  for (const re of [/best[- ]effort/i, /\b14 days\b/, /\b45 days\b/, /\b90 days\b/, /vulnerab/i, /disclosure/i]) {
    assert.match(md, re);
  }
  const deny = join(ROOT, "scripts", "denylist.local.txt");
  if (existsSync(deny)) {
    const terms = readFileSync(deny, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    for (const t of terms) {
      // Never print the term: a failure in CI must not leak it.
      assert.ok(!md.toLowerCase().includes(t.toLowerCase()), "a local denylist term is in SECURITY.md");
    }
  }
});

test("supported versions is a rule, not a table of numbers", () => {
  const s = section(policy(), "Supported versions");
  assert.ok(s.length > 0);
  assert.doesNotMatch(s, /^\|/m);
  assert.doesNotMatch(s, /\bv?\d+\.\d+(\.\d+)?\b/);
});

test("the release note claims provenance only when the workflow makes it", () => {
  const md = policy();
  const attests = /actions\/attest/.test(read(".github", "workflows", "release.yml"));
  if (attests) {
    assert.match(md, /attestation/i);
    assert.doesNotMatch(md, /no build provenance|not signed/i);
  } else {
    assert.match(md, /not signed/i);
    assert.match(md, /no build provenance/i);
  }
});

test("paths it names exist, and it stays short", () => {
  for (const p of ["plugins/phased-shipping/hooks", "plugins/phased-shipping/skills/run/scripts/commands-hash.mjs",
    "scripts/sync-personal.mjs", ".github/workflows", "library.json"]) {
    assert.ok(existsSync(join(ROOT, p)), p);
  }
  assert.ok(policy().split(/\r?\n/).length <= 80);
});
