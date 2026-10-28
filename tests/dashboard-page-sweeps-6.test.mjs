// Run with: node --test tests/dashboard-page-sweeps-6.test.mjs
// The first part (14 of 38 changes) of the mutation sweep of fix round 6: each change, made on its own in a temp copy of the scripts, must make its scenario fail.
// This file is one of five (dashboard-page.test.mjs, dashboard-page-rounds.test.mjs, dashboard-page-sweeps.test.mjs, dashboard-page-sweeps-6.test.mjs, dashboard-page-sweeps-6b.test.mjs) that came from one 4,000-line file;
// the helpers they share are in tests/helpers/dashboard-page.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { round6Cases, ROUND6_SPLIT, runSweep } from "./helpers/dashboard-page.mjs";


// The first ROUND6_SPLIT (14) cases of the round 6 sweep (the rest are in dashboard-page-sweeps-6b.test.mjs; together they are all 38).
test("round 6: the rules are in the scripts: each change makes its scenario fail", async () => {
  assert.equal(await runSweep(round6Cases().slice(0, ROUND6_SPLIT)), 14, "every case of the sweep ran");
});

// A sweep must never lose a mutant: the number of cases in each one is pinned here, so a case that is removed or weakened to nothing shows up.
test("mutation sweeps: the mutant count of each sweep in dashboard-page-sweeps-6.test.mjs is unchanged", () => {
  assert.deepEqual(
    { round6Cases: round6Cases().length, firstPart: round6Cases().slice(0, ROUND6_SPLIT).length, secondPart: round6Cases().slice(ROUND6_SPLIT).length },
    { round6Cases: 38, firstPart: 14, secondPart: 24 },
  );
});
