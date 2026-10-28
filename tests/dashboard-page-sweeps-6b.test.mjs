// Run with: node --test tests/dashboard-page-sweeps-6b.test.mjs
// The second part (24 of 38 changes) of the mutation sweep of fix round 6: each change, made on its own in a temp copy of the scripts, must make its scenario fail.
// The first half is in dashboard-page-sweeps-6.test.mjs; the cases and the point where they are cut are in tests/helpers/dashboard-page.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { round6Cases, ROUND6_SPLIT, runSweep } from "./helpers/dashboard-page.mjs";

test("round 6, second part: the rules are in the scripts: each change makes its scenario fail", async () => {
  assert.equal(await runSweep(round6Cases().slice(ROUND6_SPLIT)), 24, "every case of the sweep ran");
});

// The two parts together are all 38 cases, and this part is the 24 after the first 14.
test("mutation sweeps: the second part of the round 6 sweep is the cases after the first part", () => {
  assert.equal(ROUND6_SPLIT, 14);
  assert.equal(round6Cases().length, 38);
  assert.equal(round6Cases().slice(ROUND6_SPLIT).length, 24);
  assert.deepEqual(round6Cases().slice(0, ROUND6_SPLIT).concat(round6Cases().slice(ROUND6_SPLIT)).map((c) => c[0]), round6Cases().map((c) => c[0]));
});
