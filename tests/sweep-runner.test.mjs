// Run with: node --test tests/sweep-runner.test.mjs
// Covers runSweep in tests/helpers/dashboard-page.mjs, the runner of every mutation sweep of the dashboard tests. Every sweep test trusts it, so it
// has tests of its own: a mutant that survives, an error that is not an assertion and a change text that is not there all fail the sweep, every case
// still runs after a failure, an empty list passes, and the number of cases it ran is the number it was given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSweep, SWEEP_CAP } from "./helpers/dashboard-page.mjs";

// A change that applies to the real collect.mjs (a copy of it is made, the real file is never touched).
const APPLIES = [["collect.mjs", "const MAX_SESSIONS = 100;", "const MAX_SESSIONS = 101;"]];
const kills = (log, name) => [name, APPLIES, async () => { log.push(name); assert.fail("the scenario fails, so the mutant is caught"); }];

test("sweep runner: a mutant that survives (its scenario passes) makes the sweep reject, with an assertion error naming the case", async () => {
  const log = [];
  const survivor = ["the survivor", APPLIES, async () => { log.push("survivor"); }];
  await assert.rejects(runSweep([kills(log, "k1"), survivor]), (e) => e?.code === "ERR_ASSERTION" && /the survivor: the scenario did not fail on an assertion/.test(e.message));
  assert.deepEqual(log.sort(), ["k1", "survivor"]);
});

test("sweep runner: a scenario that fails with something other than an assertion makes the sweep reject", async () => {
  const boom = ["crashes", APPLIES, async () => { throw new TypeError("not an assertion"); }];
  await assert.rejects(runSweep([boom]), (e) => e?.code === "ERR_ASSERTION" && /crashes: the scenario did not fail on an assertion/.test(e.message));
});

test("sweep runner: a change whose text is not in the script makes the sweep reject", async () => {
  const log = [];
  const gone = ["no such text", [["collect.mjs", "this text is not in collect.mjs at all", "x"]], async () => { log.push("ran"); assert.fail("never reached"); }];
  await assert.rejects(runSweep([gone]), (e) => /collect\.mjs has the text to change/.test(e.message));
  assert.deepEqual(log, [], "the scenario is not run on a copy that was not changed");
});

test("sweep runner: every case runs after a failure, and the first failure is the one thrown", async () => {
  const log = [];
  const first = ["first survivor", APPLIES, async () => { log.push("first"); }];
  const second = ["second survivor", APPLIES, async () => { log.push("second"); }];
  const cases = [first, ...Array.from({ length: 9 }, (_, i) => kills(log, `k${i}`)), second];
  for (const cap of [1, 2, SWEEP_CAP, 50]) {
    log.length = 0;
    await assert.rejects(runSweep(cases, cap), (e) => /first survivor/.test(e.message) || /second survivor/.test(e.message), `cap ${cap}`);
    assert.equal(log.length, cases.length, `every case ran with a cap of ${cap}`);
  }
  log.length = 0;
  await assert.rejects(runSweep(cases, 1), /first survivor/, "with one worker the first failure in order is the first thrown");
});

test("sweep runner: an empty list passes and runs nothing", async () => {
  assert.equal(await runSweep([]), 0);
});

test("sweep runner: it returns the number of cases it ran, which is the number it was given, for any cap", async () => {
  for (const n of [1, 2, 4, 5, 9]) {
    for (const cap of [1, 3, SWEEP_CAP, 100]) {
      const log = [];
      const cases = Array.from({ length: n }, (_, i) => kills(log, `k${i}`));
      assert.equal(await runSweep(cases, cap), n, `${n} cases, cap ${cap}`);
      assert.equal(log.length, n, "and each scenario ran exactly once");
      assert.equal(new Set(log).size, n);
    }
  }
});

test("sweep runner: no more than the cap run at the same time", async () => {
  let live = 0;
  let peak = 0;
  const slow = (i) => [`s${i}`, APPLIES, async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; assert.fail("caught"); }];
  assert.equal(await runSweep(Array.from({ length: 12 }, (_, i) => slow(i)), 3), 12);
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
});
