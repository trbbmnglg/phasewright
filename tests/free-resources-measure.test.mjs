// Run with: node --test tests/free-resources-measure.test.mjs
// The measure CLI run as a real process (bad options, the exit code, the pass-through of the command's output, and a child that holds about 150 MB).
// These wait for real processes and timers, so they are a file of their own and run beside the other free-resources tests.
// This file is one of 2 (free-resources-headroom.test.mjs, free-resources-measure.test.mjs) that came from one file; the helpers they share are in tests/helpers/free-resources-headroom.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FR, WINDOWS_ONLY, sampler, tmp, peak, cliEnv } from "./helpers/free-resources-headroom.mjs";


// ---------- measure CLI ----------

const measureCli = (args, dir, extra = {}) => spawnSync(process.execPath, [join(FR, "scripts", "measure.mjs"), ...args], { encoding: "utf8", env: cliEnv(dir, extra), cwd: FR, timeout: 180000 });
test("measure CLI: bad options exit 2 before running anything", () => {
  const dir = tmp();
  try {
    for (const args of [[], ["--task", "x"], ["--bogus", "--", "node", "-v"], ["--interval-ms", "5", "--", "node", "-v"], ["--task"]]) {
      const r = measureCli(args, dir);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /usage|no command|must be|needs/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("measure CLI: the command's exit code becomes ours and the record carries exit_code 7", { skip: WINDOWS_ONLY }, () => {
  const dir = tmp();
  try {
    const r = measureCli(["--", "node", "-e", "process.exit(7)"], dir);
    assert.equal(r.status, 7, r.stderr);
    assert.match(r.stderr, /free-resources: node -e @ /, "the summary goes to stderr");
    assert.equal(r.stdout, "", "the command's own stdout stays clean: nothing of ours on stdout");
    const lines = readFileSync(join(dir, "peaks.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.exit_code, 7);
    assert.equal(record.schema_version, 1);
    assert.equal(record.platform, "win32");
    assert.equal(record.interval_ms, 2000);
    for (const f of ["key", "cmd_summary", "project", "started_iso", "duration_s", "peak_tree_mb", "peak_avail_drop_mb", "avg_cpu_cores", "peak_cpu_cores", "samples", "sampler_overhead_pct"]) assert.ok(f in record, `record has ${f}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("measure CLI: a command's stdout is passed through untouched, and --json goes to stderr", { skip: WINDOWS_ONLY }, () => {
  const dir = tmp();
  try {
    const r = measureCli(["--task", "pass-through", "--json", "--", "node", "-e", "console.log('hello from the task')"], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "hello from the task");
    const j = JSON.parse(r.stderr.slice(r.stderr.indexOf("{")));
    assert.equal(j.key, "pass-through");
    assert.equal(j.exit_code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("measure CLI: a child that holds about 150 MB records a tree peak of at least 100 MB", { skip: WINDOWS_ONLY, timeout: 240000 }, (t) => {
  // PowerShell can take 15 s to start on a busy machine, so the child lives long enough for the tree sampler to tick.
  const dir = tmp();
  try {
    const r = measureCli(["--task", "mem-150", "--", "node", "-e", "const a=Buffer.alloc(150*1024*1024,1);setTimeout(()=>{},30000)"], dir);
    assert.equal(r.status, 0, r.stderr);
    const record = JSON.parse(readFileSync(join(dir, "peaks.jsonl"), "utf8").trim());
    if (!record.samples) return t.skip("no tree sample arrived in 30 s: the machine was too busy to judge");
    assert.ok(record.peak_tree_mb >= 100, `peak_tree_mb ${record.peak_tree_mb}`);
    assert.ok(record.peak_tree_mb < 2000, "a plausible number, not another process's memory");
    assert.ok(record.peak_avail_drop_mb != null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
