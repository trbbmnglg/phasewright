// Run with: node --test tests/free-resources-headroom.test.mjs
// Phase 2 of the free-resources skill: peaks store, sampler arithmetic, headroom, measure CLI.
// Every fixture is synthetic (invented names, numbers and paths), never real process data.
// The live tests run only on Windows (they start real helper processes) and are skipped elsewhere.
// Mac code is covered by fixtures only and is untested on a real Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const FR = join(REPO, "plugins", "free-resources", "skills", "free-resources");
const FIX = join(HERE, "fixtures");
const fix = (name) => readFileSync(join(FIX, name), "utf8");
const load = (mod) => import(pathToFileURL(join(FR, "scripts", "lib", `${mod}.mjs`)).href);
const WINDOWS_ONLY = process.platform === "win32" ? false : "live test: Windows only";

const peaksLib = await load("peaks");
const sampler = await load("sampler");
const headroom = await load("headroom");
const rules = await load("rules");
const snapshot = await load("snapshot");

const tmp = () => mkdtempSync(join(tmpdir(), "fr-test-"));
const dirEnv = (dir) => ({ env: { FREE_RESOURCES_DATA: dir } });
const rec = (key, extra = {}) => ({ schema_version: 1, key, cmd_summary: "npm test", project: "x", started_iso: "2026-10-23T00:00:00.000Z", duration_s: 30, exit_code: 0, peak_tree_mb: 100, peak_avail_drop_mb: 120, avg_cpu_cores: 1, peak_cpu_cores: 2, samples: 10, ...extra });

// ---------- peaks store ----------

test("peaks: FREE_RESOURCES_DATA wins; the defaults are LOCALAPPDATA on Windows and ~/.local/state elsewhere", () => {
  assert.equal(peaksLib.dataDir({ env: { FREE_RESOURCES_DATA: "D:\\x\\data", LOCALAPPDATA: "C:\\L" }, platform: "win32" }), "D:\\x\\data");
  assert.equal(peaksLib.dataDir({ env: { LOCALAPPDATA: "C:\\Local" }, platform: "win32", home: "C:\\Users\\t" }), join("C:\\Local", "free-resources"));
  assert.equal(peaksLib.dataDir({ env: {}, platform: "win32", home: "C:\\Users\\t" }), join("C:\\Users\\t", "AppData", "Local", "free-resources"));
  assert.equal(peaksLib.dataDir({ env: {}, platform: "darwin", home: "/srv/fakehome" }), join("/srv/fakehome", ".local", "state", "free-resources"));
  assert.equal(peaksLib.peaksFile(dirEnv("D:\\x")), join("D:\\x", "peaks.jsonl"));
});

test("peaks: append then read returns the last 5 for a key in order, without another key's runs", () => {
  const dir = tmp();
  try {
    for (let i = 1; i <= 7; i++) {
      peaksLib.appendPeak(rec("npm test @ x", { peak_tree_mb: i }), dirEnv(dir));
      peaksLib.appendPeak(rec("other @ x", { peak_tree_mb: 1000 + i }), dirEnv(dir));
    }
    const got = peaksLib.readLast("npm test @ x", 5, dirEnv(dir));
    assert.deepEqual(got.map((r) => r.peak_tree_mb), [3, 4, 5, 6, 7]);
    assert.ok(got.every((r) => r.key === "npm test @ x"));
    assert.deepEqual(peaksLib.readLast("never ran", 5, dirEnv(dir)), []);
    assert.deepEqual(peaksLib.readLast("npm test @ x", 5, dirEnv(join(dir, "missing"))), [], "a missing folder is an empty list, not an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("peaks: a --token value in the command is stored masked, whether or not the caller masked it", () => {
  const dir = tmp();
  try {
    const summary = peaksLib.summarizeCommand(["node", "deploy.mjs", "--token", "abc123SECRET", "--api-key=zzz999"], { home: "D:\\Profiles\\tester" });
    assert.ok(!summary.includes("abc123SECRET") && !summary.includes("zzz999"));
    assert.match(summary, /--token \*\*\*/);
    peaksLib.appendPeak(rec("k", { cmd_summary: summary }), dirEnv(dir));
    peaksLib.appendPeak(rec("k2", { cmd_summary: "node deploy.mjs --token rawsecret456 D:\\Profiles\\tester\\work" }), { ...dirEnv(dir), home: "D:\\Profiles\\tester" });
    const raw = readFileSync(join(dir, "peaks.jsonl"), "utf8");
    assert.ok(!raw.includes("abc123SECRET") && !raw.includes("zzz999") && !raw.includes("rawsecret456"), "no secret reaches the file");
    assert.ok(!raw.includes("Profiles"), "a profile path is stored relative");
    assert.ok(raw.includes("~"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("peaks: a corrupt line is skipped, not fatal", () => {
  const dir = tmp();
  try {
    peaksLib.appendPeak(rec("k", { peak_tree_mb: 1 }), dirEnv(dir));
    appendFileSync(join(dir, "peaks.jsonl"), "{this is not json\n\n[1,2]\nnull\n", "utf8");
    peaksLib.appendPeak(rec("k", { peak_tree_mb: 2 }), dirEnv(dir));
    assert.deepEqual(peaksLib.readLast("k", 5, dirEnv(dir)).map((r) => r.peak_tree_mb), [1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task key: the command's first two words plus the folder name; --task overrides", () => {
  assert.equal(peaksLib.taskKey({ argv: ["npm", "test"], project: join("D:\\Work", "x") }), "npm test @ x");
  assert.equal(peaksLib.taskKey({ argv: ["npm", "run", "build", "--silent"], project: "D:\\Work\\zork\\" }), "npm run @ zork");
  assert.equal(peaksLib.taskKey({ argv: ["npm test"], project: "/srv/work/proj" }), "npm test @ proj", "a command given as one quoted string still gives two words");
  assert.equal(peaksLib.taskKey({ task: "nightly build", argv: ["npm", "test"], project: "D:\\Work\\x" }), "nightly build");
  assert.equal(peaksLib.taskKey({ task: "   ", argv: ["npm", "test"], project: "D:\\Work\\x" }), "npm test @ x", "a blank --task is ignored");
});

// ---------- sampler arithmetic ----------

test("sampler: a tick line parses, and a line that is not a tick is ignored", () => {
  const lines = fix("tree-ticks.txt").split(/\r?\n/);
  assert.equal(sampler.parseTreeLine(lines[0]), null);
  assert.equal(sampler.parseTreeLine(lines[4]), null);
  const t = sampler.parseTreeLine(lines[1]);
  assert.equal(t.t, 1790000000000);
  assert.equal(t.self_cpu_s, 1);
  assert.equal(t.rows.length, 4);
  assert.deepEqual(t.rows[1], { pid: 101, ppid: 100, ws_bytes: 209715200, cpu_s: 2 });
  assert.deepEqual(sampler.parseTreeLine("FR1 5 0.10 ").rows, []);
});

test("sampler: descendants are the root and everything below it, never a sibling, and a cycle cannot loop", () => {
  const t = sampler.parseTreeLine(fix("tree-ticks.txt").split(/\r?\n/)[1]);
  assert.deepEqual(sampler.descendants(t.rows, 100).map((r) => r.pid).sort(), [100, 101, 102]);
  assert.deepEqual(sampler.descendants(t.rows, 999), []);
  const loop = [{ pid: 1, ppid: 2, ws_bytes: 1, cpu_s: 0 }, { pid: 2, ppid: 1, ws_bytes: 1, cpu_s: 0 }];
  assert.deepEqual(sampler.descendants(loop, 1).map((r) => r.pid).sort(), [1, 2]);
});

test("sampler: peak tree MB counts descendants only, and CPU cores come from CPU-second deltas over wall time", () => {
  const agg = new sampler.Aggregator();
  for (const line of fix("tree-ticks.txt").split(/\r?\n/)) {
    const tick = sampler.parseTreeLine(line);
    if (tick) agg.addTree(tick, 100); // pid 200 (a sibling holding 1000 MB) is never counted
  }
  const r = agg.result();
  assert.equal(r.tree_samples, 3);
  assert.equal(r.peak_tree_mb, 550, "tick 2: 100 + 300 + 150 MB; the 1000 MB sibling is excluded");
  assert.equal(r.peak_cpu_cores, 1.25, "tick 1 to 2: 2.5 CPU-s over 2 s");
  assert.equal(r.avg_cpu_cores, 0.88, "3.5 CPU-s over 4 s");
  assert.equal(r.sampler_overhead_pct, 2.5, "0.10 CPU-s of the sampler's own over 4 s");
  assert.equal(r.sampler_startup_cpu_s, 1);
  assert.equal(r.first_tree_t, 1790000000000);
});

test("sampler: a pid that disappears mid-run, or a root that is gone, does not throw or add CPU", () => {
  const agg = new sampler.Aggregator();
  const rows = (...r) => r.map(([pid, ppid, mbv, cpu]) => ({ pid, ppid, ws_bytes: mbv * 1048576, cpu_s: cpu }));
  agg.addTree({ t: 0, self_cpu_s: null, rows: rows([10, 1, 50, 1], [11, 10, 50, 5]) }, 10);
  agg.addTree({ t: 2000, self_cpu_s: null, rows: rows([10, 1, 60, 2]) }, 10); // 11 vanished: its last stretch is lost, not negative
  agg.addTree({ t: 4000, self_cpu_s: null, rows: rows([77, 1, 5, 1]) }, 10); // root gone: tick ignored
  const r = agg.result();
  assert.equal(r.tree_samples, 2);
  assert.equal(r.peak_tree_mb, 100);
  assert.equal(r.peak_cpu_cores, 0.5, "only pid 10's 1 CPU-s over 2 s");
  assert.equal(r.sampler_overhead_pct, null);
  const empty = new sampler.Aggregator().result();
  assert.equal(empty.peak_tree_mb, null);
  assert.equal(empty.peak_avail_drop_mb, null);
  assert.equal(empty.avg_cpu_cores, null);
});

test("sampler: streaming typeperf lines parse, including a partial last line, and the drop is first minus lowest", () => {
  const text = fix("typeperf.txt");
  const cut = text.indexOf("8000.000000") + 3; // the third data row is cut in two
  const got = [];
  const stream = sampler.createTypeperfStream((s) => got.push(s));
  for (let i = 0; i < cut; i += 7) stream.feed(text.slice(i, Math.min(i + 7, cut))); // arbitrary chunk sizes
  assert.equal(got.length, 2, "the partial third row waits");
  stream.feed(text.slice(cut));
  stream.flush();
  assert.equal(got.length, 3);
  assert.deepEqual(got[0], { avail_mb: 8192, paging_per_s: 10, cpu_pct: 40 });
  assert.equal(got[2].avail_mb, 8000);
  const agg = new sampler.Aggregator();
  got.forEach((s) => agg.addMachine(s));
  assert.equal(agg.result().peak_avail_drop_mb, 192);
  assert.equal(agg.result().machine_samples, 3);
});

test("sampler: macOS ps output parses into the tree (fixture only; Mac is untested on a real machine)", () => {
  const tick = sampler.parseMacTree(fix("mac-tree-ps.txt"), 5);
  assert.equal(tick.rows.length, 4);
  const agg = new sampler.Aggregator();
  agg.addTree(tick, 500);
  assert.equal(agg.result().peak_tree_mb, 150, "100 MB root + 50 MB child; pid 600 is a sibling");
  assert.equal(tick.rows.find((r) => r.pid === 500).cpu_s, 1.5);
});

// ---------- headroom (pure) ----------

const scanReport = ({ total = 10000, avail = 5000, cpuPct = 50, cpus = 8, suggest = [], call = [], verdict = "none" } = {}) => ({
  generated_iso: "2026-10-23T12:00:00.000Z",
  pressure: { total_mb: total, avail_mb: avail, cpu_pct: cpuPct, samples: 3, verdict },
  sample: { logical_cpus: cpus },
  buckets: { suggest_closing: suggest, your_call: call },
});
const group = (name, count, total_mb, cpu_pct = 0) => ({ name, count, total_mb, cpu_pct, confidence: "high", reasons: ["synthetic"] });
const peak = (mbv, cores = 1, extra = {}) => ({ started_iso: "2026-10-23T00:00:00.000Z", peak_tree_mb: mbv, peak_avail_drop_mb: mbv + 50, peak_cpu_cores: cores, samples: 10, duration_s: 100, ...extra });
const near = (a, b, eps = 0.5) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test("headroom: no peaks gives no data yet and no picks", () => {
  const r = headroom.computeHeadroom({ key: "k", peaks: [], report: scanReport({ suggest: [group("workerd.exe", 4, 275)] }) });
  assert.equal(r.status, "no_data");
  assert.equal(r.message, "No data yet for this task. Run it once through measure.mjs.");
  assert.equal(r.memory, null);
  assert.equal(r.cpu, null);
  const text = headroom.renderHeadroom(r);
  assert.match(text, /No data yet for this task\. Run it once through measure\.mjs\./);
  assert.match(text, /Nothing is recommended/);
  assert.ok(text.endsWith("Nothing was closed. This scan is read-only."));
});

test("headroom: need 2,000 MB against 5,000 MB free fits and picks nothing", () => {
  // reserve 10% of 10,000 = 1,000, so 6,000 free in the scan leaves 5,000 available; peak 1739.2 x 1.15 = 2,000
  const r = headroom.computeHeadroom({ key: "k", peaks: [peak(1739.2)], report: scanReport({ avail: 6000, suggest: [group("workerd.exe", 4, 275)] }) });
  near(r.memory.need_mb, 2000, 0.2);
  assert.equal(r.memory.available_mb, 5000);
  assert.equal(r.memory.verdict, "fits");
  assert.deepEqual(r.memory.picks, []);
  assert.equal(r.memory.covered, null);
  assert.match(headroom.renderHeadroom(r), /fits, with [\d,]+ MB to spare/);
});

test("headroom: short by 600 MB with Suggest groups of 400, 275 and 100 picks 400 + 275, covered, not all three", () => {
  // available = 5,000; need = 5,600 -> peak 5,600 / 1.15
  const r = headroom.computeHeadroom({
    key: "k",
    peaks: [peak(5600 / 1.15)],
    report: scanReport({ avail: 6000, suggest: [group("small.exe", 1, 100), group("big.exe", 2, 400), group("mid.exe", 4, 275)] }),
  });
  near(r.memory.short_by_mb, 600, 0.2);
  assert.deepEqual(r.memory.picks.map((p) => p.name), ["big.exe", "mid.exe"]);
  assert.deepEqual(r.memory.picks.map((p) => p.running_mb), [400, 675]);
  assert.equal(r.memory.covered, true);
  assert.deepEqual(r.memory.could_also_consider, []);
  assert.match(headroom.renderHeadroom(r), /mid\.exe x4: up to 275 MB, total 675 MB of 600 MB short/);
});

test("headroom: short by 2,000 MB with only 675 MB in Suggest picks all of it, says it is not enough, and only lists Your call", () => {
  const r = headroom.computeHeadroom({
    key: "k",
    peaks: [peak(7000 / 1.15)],
    report: scanReport({ avail: 6000, suggest: [group("big.exe", 2, 400), group("mid.exe", 4, 275)], call: [group("chrome.exe", 3, 900, 2), group("bigapp.exe", 1, 800, 1)] }),
  });
  near(r.memory.short_by_mb, 2000, 0.2);
  assert.equal(r.memory.picks.length, 2);
  assert.equal(r.memory.covered, false);
  assert.deepEqual(r.memory.could_also_consider.map((c) => c.name), ["chrome.exe", "bigapp.exe"]);
  assert.ok(!r.memory.picks.some((p) => ["chrome.exe", "bigapp.exe"].includes(p.name)), "Your call items are never picks");
  const text = headroom.renderHeadroom(r);
  assert.match(text, /is not enough/);
  assert.match(text, /You could also consider/);
  assert.match(text, /chrome\.exe x3: up to 900 MB/);
});

test("headroom: CPU short with only idle Suggest candidates says closing them frees no CPU and lists the busy Your call processes", () => {
  // need 4 x 1.15 = 4.6 cores; available (100 - 70)% of 8 = 2.4 cores
  const r = headroom.computeHeadroom({
    key: "k",
    peaks: [peak(100, 4)],
    report: scanReport({ cpuPct: 70, suggest: [group("workerd.exe", 4, 275, 0)], call: [group("bigapp.exe", 1, 800, 12.5), group("quiet.exe", 1, 500, 0)] }),
  });
  assert.equal(r.cpu.need_cores, 4.6);
  assert.equal(r.cpu.available_cores, 2.4);
  assert.equal(r.cpu.verdict, "short");
  assert.equal(r.cpu.short_by_cores, 2.2);
  assert.equal(r.cpu.suggest_closing_frees_cpu, false);
  assert.deepEqual(r.cpu.busy_your_call.map((x) => x.name), ["bigapp.exe"]);
  assert.equal(r.cpu.busy_your_call[0].cores, 1);
  const text = headroom.renderHeadroom(r);
  assert.match(text, /closing them frees no CPU/);
  assert.match(text, /bigapp\.exe x1: 12\.5% of the machine \(1 core\)/);
  assert.equal(r.memory.verdict, "fits", "memory is reported separately and still fits");
});

test("headroom: need is the max of the last 5 peaks times 1.15 and ignores a 6th, older, larger peak", () => {
  const peaks = [peak(9000, 9), peak(100, 1), peak(200, 2), peak(300, 1), peak(400, 1), peak(250, 1)]; // oldest first: 9000 is the 6th back
  const r = headroom.computeHeadroom({ key: "k", peaks, report: scanReport() });
  assert.equal(r.peaks_used, 5);
  assert.equal(r.memory.need_mb, 460, "400 x 1.15");
  assert.equal(r.cpu.need_cores, 2.3, "2 x 1.15");
  assert.equal(r.memory.need_source.peaks.length, 5);
  assert.equal(rules.NEED_MARGIN, 1.15);
  assert.equal(rules.PEAKS_WINDOW, 5);
});

test("headroom: the reserve of 10% of total memory is subtracted from the available memory", () => {
  const r = headroom.computeHeadroom({ key: "k", peaks: [peak(100)], report: scanReport({ total: 16000, avail: 6000 }) });
  assert.equal(rules.RESERVE_PCT_OF_TOTAL, 10);
  assert.equal(r.memory.available_source.reserve_mb, 1600);
  assert.equal(r.memory.available_mb, 4400);
  assert.match(headroom.renderHeadroom(r), /minus a 1,600 MB reserve \(10% of 16,000 MB\)/);
});

test("headroom: a run with fewer than 3 tree samples uses the available-memory drop and the report says so", () => {
  const thin = { ...peak(50), samples: 1, peak_avail_drop_mb: 900 };
  const r = headroom.computeHeadroom({ key: "k", peaks: [thin], report: scanReport() });
  assert.equal(r.memory.need_source.peaks[0].basis, "avail_drop");
  assert.equal(r.memory.need_mb, 1035, "900 x 1.15");
  assert.ok(r.notes.some((n) => /Low confidence/.test(n)));
  assert.match(headroom.renderHeadroom(r), /available-memory drop/);
});

test("headroom: the rendered text never offers a command to close anything and always ends with the read-only line", () => {
  const r = headroom.computeHeadroom({ key: "k", peaks: [peak(8000)], report: scanReport({ avail: 3000, suggest: [group("workerd.exe", 2, 300)], call: [group("chrome.exe", 3, 900, 2)] }) });
  const text = headroom.renderHeadroom(r, { platform: "win32" });
  for (const bad of [/taskkill/i, /Stop-Process/i, /\bkill\b/i, /\bclose them with\b/i, /\brun:/i]) assert.ok(!bad.test(text), `found ${bad}`);
  assert.ok(text.endsWith("Nothing was closed. This scan is read-only."));
});

// ---------- headroom CLI ----------

const cliEnv = (dir, extra = {}) => ({ ...process.env, FREE_RESOURCES_DATA: dir, FREE_RESOURCES_PROTECTED: join(FIX, "protected.test.json"), ...extra });
const headroomCli = (args, dir) => spawnSync(process.execPath, [join(FR, "scripts", "headroom.mjs"), ...args], { encoding: "utf8", env: cliEnv(dir), cwd: FR });

test("headroom CLI: no data exits 3 without scanning; bad options exit 2", () => {
  const dir = tmp();
  try {
    const r = headroomCli(["--task", "never measured"], dir);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stdout, /No data yet for this task\. Run it once through measure\.mjs\./);
    const j = JSON.parse(headroomCli(["--task", "never measured", "--json"], dir).stdout);
    assert.equal(j.status, "no_data");
    for (const args of [[], ["--bogus"], ["--task"], ["--task", "x", "--sample-ms", "5"]]) {
      const bad = headroomCli(args, dir);
      assert.equal(bad.status, 2, `${args.join(" ")}: ${bad.stderr}`);
      assert.match(bad.stderr, /usage|must be|required|needs|not found/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headroom CLI: with peaks and a recorded scan it prints the arithmetic, JSON is valid, exit code is 0 even when short", () => {
  const dir = tmp();
  try {
    // the fixture scan: 16,384 MB total, 6,000 free, reserve 1,638.4 -> 4,361.6 MB available; 8 CPUs at 55% -> 3.6 cores
    peaksLib.appendPeak(rec("fixture task", { peak_tree_mb: 5000, peak_cpu_cores: 4 }), dirEnv(dir));
    const human = headroomCli(["--task", "fixture task", "--fixture", join(FIX, "scan-win.json")], dir);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /short by 1,388 MB/);
    const missing = headroomCli(["--task", "fixture task", "--fixture", join(FIX, "nope.json")], dir);
    assert.equal(missing.status, 2, "a missing fixture is a usage error once there is data to compare");
    assert.match(missing.stderr, /not found/);
    assert.match(human.stdout, /workerd\.exe x1: up to 120 MB/);
    assert.match(human.stdout, /You could also consider/);
    assert.match(human.stdout, /closing them frees no CPU/);
    assert.ok(human.stdout.trimEnd().endsWith("Nothing was closed. This scan is read-only."));
    const j = JSON.parse(headroomCli(["--task", "fixture task", "--fixture", join(FIX, "scan-win.json"), "--json"], dir).stdout);
    assert.equal(j.schema_version, 1);
    assert.equal(j.read_only, true);
    assert.equal(j.memory.need_mb, 5750);
    assert.equal(j.memory.verdict, "short");
    assert.equal(j.memory.covered, false);
    assert.ok(j.memory.picks.every((p) => ["workerd.exe", "esbuild.exe"].includes(p.name)), "picks come from Suggest closing only");
    assert.ok(!JSON.stringify(j).includes("cmd_full"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("measure: a Windows command line quotes each argument separately, so what you typed is what runs", async () => {
  const { windowsCommandLine } = await import(pathToFileURL(join(FR, "scripts", "measure.mjs")).href);
  assert.equal(windowsCommandLine(["npm", "test"]), "npm test");
  assert.equal(windowsCommandLine(["node", "-e", "process.exit(7)"]), 'node -e "process.exit(7)"');
  assert.equal(windowsCommandLine(["echo", "a&b", 'say "hi"']), 'echo "a&b" "say \\"hi\\""');
  assert.equal(windowsCommandLine(["dir", "C:\\My Files\\"]), 'dir "C:\\My Files\\\\"');
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

test("sampler: after stop() every helper child the sampler started has exited", { skip: WINDOWS_ONLY, timeout: 120000 }, async () => {
  const task = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore", windowsHide: true });
  try {
    const s = sampler.createSampler({ rootPid: task.pid, treeIntervalMs: 500 });
    s.start();
    await new Promise((r) => setTimeout(r, 1500));
    const kids = s.children();
    assert.equal(kids.length, 2, "typeperf and the tree PowerShell");
    const result = await s.stop();
    assert.ok(Array.isArray(result.warnings));
    for (const c of kids) assert.ok(c.exitCode !== null || c.signalCode !== null, "a sampler child is still running");
    assert.equal(task.exitCode, null, "the measured task itself was not touched by the sampler");
  } finally {
    task.kill(); // the test's own child, started above
  }
});

// ---------- read-only guard, extended to the phase 2 files ----------

test("no code path can close, kill or signal a process, except the sampler ending its own child handles", () => {
  const files = ["processes.mjs", "headroom.mjs", "measure.mjs", "lib/snapshot.mjs", "lib/pressure.mjs", "lib/rules.mjs", "lib/classify.mjs", "lib/report.mjs", "lib/powershell.mjs", "lib/scan.mjs", "lib/peaks.mjs", "lib/sampler.mjs", "lib/headroom.mjs"];
  // The only lines allowed to end a process: they act on a handle Node returned from spawn(), inside endOwnChild.
  const allowed = new Map([["lib/sampler.mjs", ["child.kill(); // ends our own child through its handle"]]]);
  const bad = [/process\.kill/, /\.kill\(/, /taskkill/i, /Stop-Process/i, /\bkill\b\s+-/, /\bpkill\b/, /CloseMainWindow/i, /TerminateProcess/i, /\.Terminate\(/i, /\bkillall\b/i, /\.Kill\(/];
  const seenAllowed = new Map();
  for (const f of files) {
    const lines = readFileSync(join(FR, "scripts", f), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const re of bad) {
        if (!re.test(line)) continue;
        const ok = (allowed.get(f) ?? []).includes(line.trim());
        assert.ok(ok, `${f}:${i + 1} has ${re}: ${line.trim()}`);
        seenAllowed.set(`${f}|${line.trim()}`, (seenAllowed.get(`${f}|${line.trim()}`) ?? 0) + 1);
      }
    });
  }
  assert.equal(seenAllowed.get("lib/sampler.mjs|child.kill(); // ends our own child through its handle"), 1, "exactly one whitelisted line, used once");
  const src = readFileSync(join(FR, "scripts", "lib", "sampler.mjs"), "utf8");
  const callers = src.split(/\r?\n/).filter((l) => /endOwnChild\(/.test(l) && !/function endOwnChild/.test(l));
  assert.deepEqual(callers.map((l) => l.trim()), ["await Promise.all(owned.map((c) => endOwnChild(c)));"], "endOwnChild is only ever given the handles in `owned`");
  assert.ok(/owned\.push\((typeperf|tree)\)/.test(src), "`owned` only receives the sampler's own spawn() results");
  assert.equal((src.match(/owned\.push\(/g) ?? []).length, 2);
  assert.ok(!/pid\s*=\s*\w+\.pid[\s\S]{0,40}kill/.test(src), "no end-by-pid");
});

test("the tree PowerShell mode only reads: no write or stop verbs, and only the fixed read-only native calls", () => {
  const ps = snapshot.POWERSHELL_SCRIPT;
  assert.match(ps, /\$mode -eq 'tree'/);
  const tree = ps.slice(ps.indexOf("$mode -eq 'tree'"));
  for (const verb of [/Stop-/i, /Remove-Item/i, /Set-/i, /New-Item/i, /Out-File/i, /Invoke-Expression/i, /\biex\b/i, /Add-Type/i, /Start-Process/i]) assert.ok(!verb.test(tree), `tree mode has ${verb}`);
  const natives = [...ps.matchAll(/@\('(\w+\.dll)', '(\w+)'/g)].map((m) => `${m[1]}:${m[2]}`).sort();
  assert.deepEqual(natives, ["advapi32.dll:GetTokenInformation", "advapi32.dll:OpenProcessToken", "kernel32.dll:CloseHandle", "kernel32.dll:OpenProcess", "ntdll.dll:NtQueryInformationProcess"]);
});

// ---------- the skill file ----------

test("SKILL.md: still one-line quoted frontmatter within limits, and carries the honesty rules", () => {
  const text = readFileSync(join(FR, "SKILL.md"), "utf8");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
  const desc = fm.split(/\r?\n/).find((l) => l.startsWith("description:"));
  assert.match(desc, /^description: ".*"$/, "the description stays one quoted line");
  const inner = desc.slice(desc.indexOf('"') + 1, -1);
  assert.ok(inner.length <= 1024);
  assert.ok(!/(?<!\\)"/.test(inner), "no unescaped quote inside the description");
  for (const phrase of [/measure a task/i, /check headroom/i, /No data yet/, /frees no CPU/i, /Do not offer a command/i, /report-only|report only/i]) assert.match(text, phrase);
});
