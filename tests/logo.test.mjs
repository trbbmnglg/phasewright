// Run with: node --test tests/logo.test.mjs
// The logo files in docs/brand/ exist, are small, are drawn as plain geometry (no text, no fonts, no round shapes,
// no gradients, filters or links), and the social preview has the size the repository settings expect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BRAND = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "brand");
const SVGS = ["phasewright-lockup-light.svg", "phasewright-lockup-dark.svg", "phasewright-mark-light.svg", "phasewright-mark-dark.svg"];
const FORBIDDEN = ["<text", "rx=", "ry=", "<circle", "<ellipse", 'stroke-linecap="round"', 'stroke-linejoin="round"',
  "Gradient", "<filter", "filter=", "http"];

test("the four SVGs exist, are at most 12 KB and have a viewBox", () => {
  for (const f of SVGS) {
    const size = statSync(join(BRAND, f)).size;
    assert.ok(size > 0 && size <= 12 * 1024, `${f} is ${size} bytes`);
    const svg = readFileSync(join(BRAND, f), "utf8");
    assert.match(svg, /^<svg\b[^>]*\bviewBox="[^"]+"/, `${f} has a viewBox`);
  }
});

test("none of the SVGs uses text, rounded shapes, a gradient, a filter or a link", () => {
  for (const f of SVGS) {
    const svg = readFileSync(join(BRAND, f), "utf8");
    for (const bad of FORBIDDEN) {
      // xmlns names a namespace, not a link to fetch, so it is removed before the link check.
      const text = svg.replace(/xmlns="[^"]*"/g, "");
      assert.ok(!text.includes(bad), `${f} contains ${bad}`);
    }
  }
});

test("the social preview is a 1280 by 640 PNG of at most 1 MB", () => {
  const buf = readFileSync(join(BRAND, "social-preview.png"));
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  assert.equal(buf.toString("ascii", 12, 16), "IHDR");
  assert.equal(buf.readUInt32BE(16), 1280);
  assert.equal(buf.readUInt32BE(20), 640);
  assert.ok(buf.length <= 1024 * 1024, `social-preview.png is ${buf.length} bytes`);
});
