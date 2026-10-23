// Run with: node --test tests/free-resources.test.mjs
// Every fixture is synthetic (invented names and paths), never real process data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const FR = join(REPO, "plugins", "free-resources", "skills", "free-resources");
const FIX = join(HERE, "fixtures");
const fix = (name) => readFileSync(join(FIX, name), "utf8");
const load = (mod) => import(pathToFileURL(join(FR, "scripts", "lib", `${mod}.mjs`)).href);

const snapshot = await load("snapshot");
const pressureLib = await load("pressure");
const { classify } = await load("classify");
const rules = await load("rules");
const report = await load("report");

const HOME = "D:\\Profiles\\tester";
const NOW = Date.parse("2026-10-23T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3.6e6).toISOString();

// ---------- Windows parser ----------

test("Windows parser: CIM JSON becomes normalized records with converted dates and CPU units", () => {
  const { taken_ms, records } = snapshot.parseCim(fix("win-cim.json"), { home: HOME });
  assert.equal(taken_ms, 1790000000000);
  assert.equal(records.length, 5);
  const node = records.find((r) => r.pid === 100);
  assert.equal(node.name, "node.exe");
  assert.equal(node.ppid, 4);
  assert.equal(node.rss_mb, 100);
  assert.equal(node.cpu_s_total, 3); // (20000000 + 10000000) x 100 ns
  assert.equal(node.start_iso, "2026-10-23T02:30:00.000Z");
  assert.equal(node.owner, null);
  assert.ok(!("password" in node));
  // the three date forms: ISO, /Date(ms)/ and the CIM text form (UTC+8 here)
  assert.equal(records.find((r) => r.pid === 200).start_iso, new Date(1789000000000).toISOString());
  assert.equal(records.find((r) => r.pid === 300).start_iso, "2026-10-23T02:30:00.000Z");
});

test("Windows parser: a missing CommandLine or ExecutablePath does not throw", () => {
  const { records } = snapshot.parseCim(fix("win-cim.json"), { home: HOME });
  const system = records.find((r) => r.pid === 4);
  assert.equal(system.exe, null);
  assert.equal(system.cmd_summary, "System");
  assert.equal(system.start_iso, null);
  const bare = records.find((r) => r.pid === 400);
  assert.equal(bare.cmd_summary, "nocmd.exe");
  assert.equal(bare.cpu_s_total, 0);
  assert.deepEqual(snapshot.parseCim({ processes: [] }).records, []);
  assert.deepEqual(snapshot.parseCim("{}").records, []);
  assert.equal(snapshot.parseCim({ processes: { ProcessId: 9, Name: "solo.exe" } }).records.length, 1);
});

test("Windows parser: the summary is masked, short and shows profile paths relative", () => {
  const { records } = snapshot.parseCim(fix("win-cim.json"), { home: HOME });
  const node = records.find((r) => r.pid === 100);
  assert.ok(node.cmd_summary.startsWith("node.exe "));
  assert.ok(node.cmd_summary.length <= 120);
  assert.ok(!node.cmd_summary.includes("abc123") && !node.cmd_summary.includes("XYZ"));
  assert.ok(node.cmd_summary.includes("~\\work\\demo"));
  assert.ok(!node.cmd_summary.includes("Profiles"));
  assert.ok(!node.cmd_full.includes("abc123"), "the stored full command line is masked too");
  const helper = records.find((r) => r.pid === 200);
  assert.ok(!helper.cmd_summary.includes("--password=p "));
  assert.match(helper.cmd_summary, /--password=\*\*\*/);
  const long = snapshot.summarizeCmd(`C:\\x\\tool.exe ${"a".repeat(300)}`, { name: "tool.exe", exe: "C:\\x\\tool.exe", home: HOME });
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("..."));
});

// ---------- masking ----------

test("masking: tokens, keys, passwords and bearer values are masked; a profile path becomes relative", () => {
  const m = snapshot.maskSecrets;
  assert.equal(m("tool --token abc123 --x"), "tool --token *** --x");
  assert.equal(m("tool --token=abc123"), "tool --token=***");
  assert.equal(m("run api_key=XYZ other"), "run api_key=*** other");
  assert.equal(m("curl -H 'Authorization: Bearer abc.def-1' x"), "curl -H 'Authorization: Bearer ***' x");
  assert.equal(m("Bearer abc"), "Bearer ***");
  assert.equal(m("db --password=p"), "db --password=***");
  assert.equal(m("db --password 'two words' end"), "db --password *** end");
  assert.equal(m("x --secret s1 --key k1 token=t1"), "x --secret *** --key *** token=***");
  assert.equal(m("x --access-token ghost"), "x --access-token ***");
  assert.equal(m("tool --keyboard us --verbose"), "tool --keyboard us --verbose", "unrelated flags are left alone");
  for (const secret of ["abc123", "XYZ", "p"]) {
    assert.ok(!snapshot.summarizeCmd(`x.exe --token ${secret} api_key=${secret} --password=${secret}`, { name: "x.exe", home: HOME }).split(/[\s=]/).includes(secret));
  }
  assert.equal(snapshot.relativizePaths("D:\\Profiles\\tester\\AppData\\x and d:/profiles/tester/y", HOME), "~\\AppData\\x and ~/y");
});

// ---------- Mac parser ----------

test("Mac parser: ps output becomes records, joined to the executable path by pid", () => {
  const records = snapshot.parseMacPs(fix("mac-ps.txt"), fix("mac-ps-comm.txt"), { home: "/Volumes/Data/tester" });
  assert.equal(records.length, 3, "the non-process line is ignored");
  const app = records.find((r) => r.pid === 501);
  assert.equal(app.name, "Fake App");
  assert.equal(app.owner, "tester");
  assert.equal(app.rss_mb, 200);
  assert.equal(app.cpu_s_total, 3723.5); // 1:02:03.50
  assert.ok(app.cmd_summary.startsWith("Fake App "));
  assert.ok(!app.cmd_summary.includes("abc123"));
  assert.equal(new Date(app.start_iso).getFullYear(), 2026);
  const vite = records.find((r) => r.pid === 777);
  assert.equal(vite.name, "node");
  assert.ok(vite.cmd_summary.includes("~/dev/demo"));
  assert.equal(snapshot.parseCpuTime("0:12.34"), 12.34);
  assert.equal(snapshot.parseCpuTime("2:00:00"), 7200);
});

test("Mac parser: vm_stat, memory_pressure, swap usage and top become numbers", () => {
  const vm = pressureLib.parseVmStat(fix("mac-vmstat.txt"));
  assert.equal(vm.page_size, 16384);
  assert.equal(vm.avail_mb, 4375); // (50000 free + 200000 inactive + 10000 speculative + 20000 purgeable) x 16384 B
  assert.equal(vm.swapins, 4444);
  assert.equal(pressureLib.parseVmStat(fix("mac-vmstat.txt"), 4096).avail_mb, 1093.75, "an explicit page size wins");
  assert.equal(pressureLib.parseMemoryPressure(fix("mac-memory-pressure.txt")), 62);
  assert.equal(pressureLib.parseTopCpu(fix("mac-top.txt")), 9.6, "the second sample is used");
  assert.deepEqual(pressureLib.parseSwapUsage("vm.swapusage: total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)"), { total_mb: 2048, used_mb: 1024 });
  assert.equal(pressureLib.parseMemoryPressure("nothing here"), null);
});

test("listening ports and Windows counters parse from sample output", () => {
  const netstat = "  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    1004\n  TCP    10.0.0.5:5000   10.0.0.9:443   ESTABLISHED   2222\n  TCP    [::]:8080   [::]:0   LISTENING   3333\n";
  assert.deepEqual([...snapshot.parseNetstat(netstat)].sort(), [1004, 3333], "listening rows only, IPv4 and IPv6");
  assert.deepEqual([...snapshot.parseLsof("p123\nn*:3000\np456\nn*:80\n")], [123, 456]);
  const c = pressureLib.parseTypeperf(fix("typeperf.txt"));
  assert.deepEqual(c.avail_mb, [8192, 8100, 8000]);
  assert.deepEqual(c.paging_per_s, [10, 20, 30]);
  assert.deepEqual(c.cpu_pct, [40, 50, 60]);
  assert.deepEqual(pressureLib.parseTypeperf("Error: no valid counters"), { avail_mb: [], paging_per_s: [], cpu_pct: [] });
});

test("CPU sampling: per-process CPU and owners merge by pid, and a reused pid is rejected", () => {
  const rec = (pid, name, start) => ({ pid, name, start_iso: start, owner: null, cpu_pct: null });
  const records = [rec(1, "a.exe", "2026-10-23T01:00:00.000Z"), rec(2, "b.exe", "2026-10-23T01:00:00.000Z"), rec(3, "c.exe", null)];
  const s0 = { taken_ms: 0, processes: [
    { id: 1, name: "a", cpu_s: 10, start: "2026-10-23T01:00:01.000Z", owner: "HOST\\tester" },
    { id: 2, name: "b", cpu_s: 5, start: "2026-10-20T01:00:00.000Z", owner: "HOST\\other" }, // different start: pid was reused
    { id: 3, name: "c", cpu_s: 1, start: null, owner: null },
  ] };
  const s1 = { taken_ms: 4000, processes: [
    { id: 1, name: "a", cpu_s: 14, start: "2026-10-23T01:00:01.000Z" },
    { id: 2, name: "b", cpu_s: 9, start: "2026-10-20T01:00:00.000Z" },
    { id: 3, name: "c", cpu_s: 1, start: null },
  ] };
  snapshot.mergeWindowsSamples(records, s0, s1, 4, 2);
  assert.equal(records[0].cpu_pct, 50, "4 s of CPU over 4 s on 2 cores is 50% of the machine");
  assert.equal(records[0].owner, "HOST\\tester");
  assert.equal(records[1].cpu_pct, null);
  assert.equal(records[1].owner, null);
  assert.equal(records[2].cpu_pct, 0);
});

// ---------- classifier ----------

let nextPid = 10000;
const rec = (o) => ({
  pid: nextPid++, ppid: 1, name: "thing.exe", exe: null, owner: "WORKGROUP\\tester", cmd_summary: "", rss_mb: 100, cpu_s_total: 0,
  start_iso: hoursAgo(5), cmd_full: null, cpu_pct: 0, ...o,
});
const ctx = (o = {}) => ({
  me: { user: "tester", pid: 4000 }, home: HOME, platform: "win32", logical_cpus: 8, now_ms: NOW, localProtected: { names: [], paths: [] },
  projectDir: "D:\\Work\\current", listening: [], pathExists: () => true, all: false, ...o,
});
const only = (result, pid) => result.decisions.find((d) => d.pid === pid);
const DEV_EXE = `${HOME}\\AppData\\Roaming\\npm\\workerd.exe`;
const devCmd = (project) => `"${DEV_EXE}" serve ${project}\\wrangler.toml`;

test("classifier: an orphaned, idle dev leftover whose project folder is gone is Suggest closing, high confidence", () => {
  const r = rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 99999, cmd_full: devCmd("D:\\Work\\gone") });
  const out = classify([r], ctx({ pathExists: (p) => p !== "D:/Work/gone" }));
  const d = only(out, r.pid);
  assert.equal(d.bucket, "suggest");
  assert.equal(d.confidence, "high");
  assert.ok(d.reasons.length >= 3, d.reasons.join("; "));
  assert.match(d.reasons.join(";"), /orphaned/);
  assert.match(d.reasons.join(";"), /idle/);
  assert.match(d.reasons.join(";"), /no longer exists/);
  assert.equal(out.suggest[0].name, "workerd.exe");
});

test("classifier: Suggest closing needs two signals, and the confidence is medium unless all three line up", () => {
  const parent = rec({ name: "bash.exe" });
  const idleOnly = rec({ name: "esbuild.exe", exe: `${HOME}\\AppData\\esbuild.exe`, ppid: parent.pid, start_iso: hoursAgo(3) });
  const orphanYoung = rec({ name: "esbuild.exe", exe: `${HOME}\\AppData\\esbuild.exe`, ppid: 99999, start_iso: hoursAgo(0.2) });
  const nothing = rec({ name: "esbuild.exe", exe: `${HOME}\\AppData\\esbuild.exe`, ppid: parent.pid, start_iso: hoursAgo(0.2) });
  const out = classify([parent, idleOnly, orphanYoung, nothing], ctx());
  assert.equal(only(out, idleOnly.pid).bucket, "suggest");
  assert.equal(only(out, idleOnly.pid).confidence, "medium");
  assert.equal(only(out, orphanYoung.pid).bucket, "suggest");
  assert.equal(only(out, orphanYoung.pid).confidence, "medium");
  assert.equal(only(out, nothing.pid).bucket, "keep", "a fresh dev tool with a running parent shows only one signal");
  assert.equal(only(out, nothing.pid).category, "dev_active");
});

test("classifier: a dev tool started through node is recognised from its arguments", () => {
  const viteNode = rec({ name: "node.exe", exe: "D:\\Tools\\node\\node.exe", ppid: 99999, cmd_full: `"D:\\Tools\\node\\node.exe" D:\\Work\\demo\\node_modules\\vite\\bin\\vite.js` });
  const plainNode = rec({ name: "node.exe", exe: "D:\\Tools\\node\\node.exe", ppid: 99999, cmd_full: `"D:\\Tools\\node\\node.exe" D:\\Work\\demo\\server.js next` });
  const out = classify([viteNode, plainNode], ctx());
  assert.equal(only(out, viteNode.pid).bucket, "suggest");
  assert.equal(only(out, viteNode.pid).tool, "vite");
  assert.equal(only(out, plainNode.pid).bucket, "keep");
});

test("classifier: the same process as a descendant of the current process is Keep (in use)", () => {
  const me = rec({ pid: 4000, name: "node.exe", exe: "D:\\Tools\\node\\node.exe", ppid: 3900 });
  const child = rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 4000, cmd_full: devCmd("D:\\Work\\gone") });
  const grandchild = rec({ name: "esbuild.exe", exe: `${HOME}\\AppData\\esbuild.exe`, ppid: child.pid });
  const out = classify([me, child, grandchild], ctx({ pathExists: () => false }));
  for (const r of [me, child, grandchild]) {
    assert.equal(only(out, r.pid).bucket, "keep");
    assert.equal(only(out, r.pid).category, "in_use");
  }
  assert.equal(out.suggest.length, 0);
});

test("classifier: a process active in the project folder is Keep (in use); the same idle one is not", () => {
  const busy = rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 99999, cpu_pct: 3, cmd_full: devCmd("D:\\Work\\current") });
  const idle = rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 99999, cpu_pct: 0, cmd_full: devCmd("D:\\Work\\current") });
  const listening = rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 99999, cpu_pct: 0, cmd_full: devCmd("D:\\Work\\current") });
  const out = classify([busy, idle, listening], ctx({ listening: [listening.pid] }));
  assert.equal(only(out, busy.pid).category, "in_use");
  assert.equal(only(out, listening.pid).category, "in_use");
  assert.equal(only(out, idle.pid).bucket, "suggest");
});

test("classifier: a busy dev tool is Your call, never Suggest closing", () => {
  const r = rec({ name: "esbuild.exe", exe: `${HOME}\\AppData\\esbuild.exe`, ppid: 99999, cpu_pct: 2 });
  const d = only(classify([r], ctx()), r.pid);
  assert.equal(d.bucket, "your_call");
  assert.equal(d.category, "dev_busy");
});

test("classifier: a process owned by another user is Keep and hidden without --all", () => {
  const other = rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 99999, owner: "WORKGROUP\\someoneelse" });
  const svc = rec({ name: "svc.exe", owner: "NT AUTHORITY\\SYSTEM" });
  const out = classify([other, svc], ctx());
  assert.equal(only(out, other.pid).category, "other_user");
  assert.equal(only(out, svc.pid).reasons[0], "system or service account");
  assert.equal(out.suggest.length, 0);
  assert.equal(out.keep.hidden_other_user, 2);
  assert.equal(out.keep.groups.length, 0, "not listed by name");
  const all = classify([other, svc], ctx({ all: true }));
  assert.equal(all.keep.hidden_other_user, 0);
  assert.equal(all.keep.groups.length, 2);
});

test("classifier: an unknown process under Program Files or Windows is Keep, even a big one", () => {
  const pf = rec({ name: "vendorsvc.exe", exe: "C:\\Program Files\\Vendor\\vendorsvc.exe", rss_mb: 900 });
  const x86 = rec({ name: "other.exe", exe: "C:\\Program Files (x86)\\Vendor\\other.exe", rss_mb: 900 });
  const win = rec({ name: "winthing.exe", exe: "C:\\Windows\\System32\\winthing.exe", rss_mb: 900 });
  const devInPf = rec({ name: "workerd.exe", exe: "C:\\Program Files\\Tool\\workerd.exe", ppid: 99999 });
  const out = classify([pf, x86, win, devInPf], ctx());
  for (const r of [pf, x86, win, devInPf]) {
    assert.equal(only(out, r.pid).bucket, "keep");
    assert.equal(only(out, r.pid).category, "protected");
  }
});

test("classifier: an unknown 800 MB process of the user in a user-writable folder is Your call", () => {
  const big = rec({ name: "bigapp.exe", exe: `${HOME}\\AppData\\Local\\bigapp\\bigapp.exe`, rss_mb: 800 });
  const bigElsewhere = rec({ name: "bigapp2.exe", exe: "D:\\Apps\\bigapp2.exe", rss_mb: 800 });
  const smallApp = rec({ name: "smallapp.exe", exe: `${HOME}\\AppData\\Local\\smallapp.exe`, rss_mb: 80 });
  const cpuHog = rec({ name: "hog.exe", exe: `${HOME}\\AppData\\Local\\hog.exe`, rss_mb: 80, cpu_pct: 9 });
  const out = classify([big, bigElsewhere, smallApp, cpuHog], ctx());
  assert.equal(only(out, big.pid).bucket, "your_call");
  assert.equal(only(out, big.pid).category, "heavy");
  assert.equal(only(out, bigElsewhere.pid).bucket, "keep", "outside a user-writable location it stays Keep");
  assert.equal(only(out, smallApp.pid).bucket, "keep");
  assert.equal(only(out, cpuHog.pid).bucket, "your_call");
});

test("classifier: a browser group is Your call, with counts and total MB; embedded web views are not browsers", () => {
  const chrome = (mb) => rec({ name: "chrome.exe", exe: "C:\\Program Files\\Browser\\chrome.exe", rss_mb: mb });
  const group = [chrome(300), chrome(200), chrome(100)];
  const edge = rec({ name: "msedge.exe", exe: "C:\\Program Files (x86)\\Microsoft\\Edge\\msedge.exe", rss_mb: 150 });
  const webview = rec({ name: "msedgewebview2.exe", exe: "C:\\Program Files (x86)\\Microsoft\\Edge\\msedgewebview2.exe", rss_mb: 150 });
  const playwright = rec({ name: "chrome.exe", exe: `${HOME}\\AppData\\Local\\ms-playwright\\chromium\\chrome.exe`, ppid: 99999 });
  const out = classify([...group, edge, webview, playwright], ctx());
  const g = out.your_call.find((x) => x.name === "chrome.exe");
  assert.equal(g.count, 3);
  assert.equal(g.total_mb, 600);
  assert.equal(g.category, "browser");
  assert.ok(out.your_call.some((x) => x.name === "msedge.exe"));
  assert.equal(only(out, webview.pid).bucket, "keep");
  assert.equal(only(out, playwright.pid).tool, "playwright browser");
  assert.equal(only(out, playwright.pid).bucket, "suggest", "a playwright browser is a dev leftover, not a person's browser");
});

test("classifier: a name or path in the local protected list is Keep even when it matches a dev-leftover name", () => {
  const byName = rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 99999 });
  const wild = rec({ name: "fakesvc-agent.exe", exe: `${HOME}\\AppData\\Local\\fakesvc-agent.exe`, rss_mb: 900 });
  const byPath = rec({ name: "workerd.exe", exe: "D:\\corp-tools\\workerd.exe", ppid: 99999 });
  const unprotected = rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 99999 });
  const out = classify([byName, wild, byPath, unprotected], ctx({ localProtected: { names: ["workerd"], paths: [] } }));
  assert.equal(only(out, byName.pid).category, "protected");
  assert.equal(only(out, unprotected.pid).category, "protected", "the name rule covers every workerd");
  const out2 = classify([wild, byPath, unprotected], ctx({ localProtected: { names: ["fakesvc*"], paths: ["D:/corp-tools/"] } }));
  assert.equal(only(out2, wild.pid).bucket, "keep");
  assert.equal(only(out2, wild.pid).category, "protected");
  assert.equal(only(out2, byPath.pid).category, "protected");
  assert.equal(only(out2, unprotected.pid).bucket, "suggest");
  assert.match(only(out2, wild.pid).reasons[0], /local protected list/);
});

test("classifier: generic protected categories are Keep (shells, editors, security, git, VPN, coding tools)", () => {
  const names = ["powershell.exe", "Code.exe", "claude.exe", "MsMpEng.exe", "git.exe", "tailscaled", "svchost.exe", "Code Helper (Renderer)", "SenseCE.exe"];
  const recs = names.map((name) => rec({ name, exe: `${HOME}\\AppData\\Local\\${name}`, rss_mb: 900 }));
  const out = classify(recs, ctx());
  for (const r of recs) assert.equal(only(out, r.pid).category, "protected", r.name);
});

test("classifier: an unclassifiable process, with unknown or missing fields, is Keep", () => {
  const unknown = rec({ name: "mystery.exe", exe: "D:\\Apps\\mystery.exe", rss_mb: 200 });
  const bare = { pid: 77, ppid: 0, name: "bare", exe: null, owner: null, rss_mb: 0, start_iso: null, cmd_full: null, cpu_pct: null };
  const noOwner = rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 99999, owner: null });
  const tiny = rec({ name: "tiny.exe", exe: "D:\\Apps\\tiny.exe", rss_mb: 4 });
  const out = classify([unknown, bare, noOwner, tiny], ctx());
  assert.equal(only(out, unknown.pid).bucket, "keep");
  assert.equal(only(out, bare.pid).bucket, "keep");
  assert.equal(only(out, noOwner.pid).bucket, "keep", "an unconfirmed owner is never suggested");
  assert.equal(only(out, tiny.pid).category, "small");
  assert.equal(out.suggest.length + out.your_call.length, 0);
});

test("classifier: it is a pure function: same input, same output, input untouched", () => {
  const records = [rec({ name: "workerd.exe", exe: DEV_EXE, ppid: 99999 }), rec({ name: "chrome.exe", exe: "C:\\Program Files\\B\\chrome.exe" })];
  const before = JSON.stringify(records);
  const c = ctx();
  const a = classify(records, c);
  const b = classify(records, c);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(records), before);
});

test("classifier: Suggest closing is only ever a dev leftover (nothing else can reach it)", () => {
  const names = ["bigapp.exe", "chrome.exe", "mystery.exe", "node.exe", "python.exe", "java.exe"];
  const recs = names.map((name) => rec({ name, exe: `${HOME}\\AppData\\Local\\${name}`, rss_mb: 2000, ppid: 99999, start_iso: hoursAgo(100), cmd_full: `${name} server.js` }));
  assert.equal(classify(recs, ctx()).suggest.length, 0);
});

// ---------- pressure verdict ----------

test("pressure verdict: each threshold and its boundary", () => {
  const v = (m) => pressureLib.verdict(m).verdict;
  assert.equal(v({ avail_pct: 12, paging_per_s: 10, cpu_pct: 30 }), "memory");
  assert.equal(v({ avail_pct: 40, paging_per_s: 400, cpu_pct: 30 }), "memory");
  assert.equal(v({ avail_pct: 40, paging_per_s: 10, cpu_pct: 90 }), "cpu");
  assert.equal(v({ avail_pct: 40, paging_per_s: 10, cpu_pct: 30 }), "none");
  assert.equal(v({ avail_pct: 10, paging_per_s: 10, cpu_pct: 90 }), "memory+cpu");
  // boundaries: below 15% is memory pressure, 15% is not; above 200 is, 200 is not; 85% or more is CPU pressure
  assert.equal(v({ avail_pct: 14.99 }), "memory");
  assert.equal(v({ avail_pct: 15 }), "none");
  assert.equal(v({ paging_per_s: 200.1 }), "memory");
  assert.equal(v({ paging_per_s: 200 }), "none");
  assert.equal(v({ cpu_pct: 85 }), "cpu");
  assert.equal(v({ cpu_pct: 84.9 }), "none");
  assert.equal(v({}), "none", "nothing measured is no verdict of pressure");
  const r = pressureLib.verdict({ avail_pct: 12, paging_per_s: 400, cpu_pct: 90 });
  assert.equal(r.reasons.length, 3);
  assert.deepEqual(r.thresholds, { memory_available_pct_below: 15, paging_per_s_above: 200, cpu_avg_pct_at_least: 85 });
  assert.equal(rules.MEM_AVAILABLE_PCT_LOW, 15);
  assert.equal(rules.PAGING_PER_S_HIGH, 200);
  assert.equal(rules.CPU_AVG_PCT_HIGH, 85);
});

// ---------- local protected list ----------

test("local protected list: loads from FREE_RESOURCES_PROTECTED, and a missing or broken file never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "fr-protected-"));
  const good = join(dir, "list.json");
  writeFileSync(good, JSON.stringify({ names: ["alpha*", " beta ", 7], paths: ["d:/x/"] }));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  const ok = rules.loadLocalProtected({ FREE_RESOURCES_PROTECTED: good });
  assert.deepEqual(ok.names, ["alpha*", "beta"]);
  assert.deepEqual(ok.paths, ["d:/x/"]);
  assert.equal(ok.warning, null);
  assert.match(rules.loadLocalProtected({ FREE_RESOURCES_PROTECTED: bad }).warning, /could not be read/);
  assert.match(rules.loadLocalProtected({ FREE_RESOURCES_PROTECTED: join(dir, "missing.json") }).warning, /does not exist/);
  rmSync(dir, { recursive: true });
});

// ---------- CLI ----------

const cli = (args, env = {}) =>
  spawnSync(process.execPath, [join(FR, "scripts", "processes.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, FREE_RESOURCES_PROTECTED: join(FIX, "protected.test.json"), ...env },
  });

test("CLI: --fixture f --json prints valid JSON with schema_version 1 and the three buckets", () => {
  const r = cli(["--fixture", join(FIX, "scan-win.json"), "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.schema_version, 1);
  assert.equal(j.read_only, true);
  assert.deepEqual(Object.keys(j.buckets).sort(), ["keep", "suggest_closing", "your_call"]);
  const suggest = j.buckets.suggest_closing;
  const workerd = suggest.find((g) => g.name === "workerd.exe");
  assert.ok(workerd && workerd.confidence === "high" && workerd.count === 1, "the orphaned workerd with a missing project is suggested");
  assert.ok(workerd.members.every((m) => !("cmd_full" in m)));
  assert.ok(suggest.some((g) => g.name === "esbuild.exe" && g.confidence === "medium"));
  assert.ok(!suggest.some((g) => g.members.some((m) => m.pid === 7003)), "the local-path-protected workerd is not suggested");
  const call = j.buckets.your_call;
  assert.equal(call.find((g) => g.name === "chrome.exe").count, 3);
  assert.equal(call.find((g) => g.name === "chrome.exe").total_mb, 900);
  assert.ok(call.some((g) => g.name === "bigapp.exe"));
  const bucketsText = JSON.stringify(j.buckets);
  assert.ok(!bucketsText.includes("vendorsvc"), "a protected Program Files process is not in any bucket");
  assert.ok(!bucketsText.includes("fakesvc"), "a locally protected process is not in any bucket");
  assert.ok(!JSON.stringify(j).includes("otheruser"), "other users' processes are not listed without --all");
  assert.equal(j.buckets.keep.hidden_other_user, 1);
  assert.equal(j.pressure.verdict, "none");
  assert.equal(j.pressure.thresholds_are_starting_values, true);
  assert.equal(j.task_need.available, false);
  assert.equal(j.mac_untested, false);
  const numbers = [...suggest, ...call].map((g) => g.n);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), "rows are numbered 1..n across the two tables");
});

test("CLI: --all lists other users' processes; the default hides them", () => {
  const all = JSON.parse(cli(["--fixture", join(FIX, "scan-win.json"), "--json", "--all"]).stdout);
  assert.ok(all.buckets.keep.listed.some((g) => g.name === "otheruser.exe"));
  assert.equal(all.buckets.keep.hidden_other_user, 0);
  assert.equal(all.top_consumers.scope, "all processes");
});

test("CLI: the human output has the pressure numbers, the numbered tables and ends with the read-only line", () => {
  const r = cli(["--fixture", join(FIX, "scan-win.json"), "--top", "3"]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trimEnd();
  assert.ok(out.endsWith("Nothing was closed. This scan is read-only."));
  assert.match(out, /Pressure now: no pressure/);
  assert.match(out, /Memory pressure below 15% available/);
  assert.match(out, /above 200 pages\/s/);
  assert.match(out, /at 85% or more/);
  assert.match(out, /starting values/);
  assert.match(out, /phase 2/);
  assert.match(out, /\| # \| Name \| Count \| MB \| CPU % \| Reasons \| Confidence \|/);
  assert.match(out, /\| 1 \| workerd\.exe \|/);
  assert.ok(!out.includes("Mac support is untested"));
  assert.ok(!out.includes("otheruser"));
});

test("CLI: a Mac report says Mac support is untested", () => {
  const human = cli(["--fixture", join(FIX, "scan-mac.json")]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Mac support is untested/);
  assert.ok(human.stdout.trimEnd().endsWith("Nothing was closed. This scan is read-only."));
  const json = JSON.parse(cli(["--fixture", join(FIX, "scan-mac.json"), "--json"]).stdout);
  assert.equal(json.mac_untested, true);
  assert.ok(json.notes.some((n) => /untested/.test(n)));
  assert.equal(json.buckets.suggest_closing[0].name, "esbuild");
});

test("CLI: bad options exit 2 with a usage line and never scan", () => {
  for (const args of [["--bogus"], ["--top", "0"], ["--sample-ms", "5"], ["--fixture", join(FIX, "nope.json")]]) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage|not found|must be/);
  }
});

test("no code path can close, kill or signal a process", () => {
  const src = ["processes.mjs", "lib/snapshot.mjs", "lib/pressure.mjs", "lib/rules.mjs", "lib/classify.mjs", "lib/report.mjs"]
    .map((f) => readFileSync(join(FR, "scripts", f), "utf8")).join("\n");
  for (const bad of [/process\.kill/, /\.kill\(/, /taskkill/i, /Stop-Process/i, /\bkill\b\s+-/, /\bpkill\b/, /CloseMainWindow/i, /TerminateProcess/i, /\.Terminate\(/i]) {
    assert.ok(!bad.test(src), `found ${bad}`);
  }
});

test("a report never prints a command line: only the masked summary appears", () => {
  const r = cli(["--fixture", join(FIX, "scan-win.json"), "--json", "--all"]);
  assert.ok(!r.stdout.includes("cmd_full"));
  assert.ok(!r.stdout.includes("wrangler.toml"));
  assert.ok(report.READ_ONLY_LINE.endsWith("read-only."));
});

// ---------- lib.mjs and lint: *.local.* files ----------

const META = 'metadata:\n  title: "T"\n  tags: "a,b"\n  featured: "false"\n  order: "1"\n  version: "1.0.0"';
const skillMd = `---\nname: good-skill\ndescription: Does a thing. Use when asked.\nlicense: MIT\n${META}\n---\n\n# Skill\n`;
const agentMd = `---\nname: helper\ndescription: "An agent."\nmodel: sonnet\n${META}\n---\n\nBody\n`;

function libraryFixture(extra) {
  const root = mkdtempSync(join(tmpdir(), "fr-lib-"));
  const files = { "skills/good-skill/SKILL.md": skillMd, "agents/claude/helper.md": agentMd, ...extra };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const script = (name, root) =>
  spawnSync(process.execPath, [join(REPO, "scripts", name)], { encoding: "utf8", env: { ...process.env, LIBRARY_ROOT: root, LIBRARY_DENYLIST: join(root, "none.txt") } });

test("lib.mjs: a *.local.* file is excluded from the manifest files, other files are kept", () => {
  const root = libraryFixture({ "skills/good-skill/notes.txt": "kept", "skills/good-skill/protected.local.json": '{"names":["x"]}', "skills/good-skill/scripts/team.local.mjs": "// local" });
  assert.equal(script("build-manifest.mjs", root).status, 0);
  const manifest = JSON.parse(readFileSync(join(root, "library.json"), "utf8"));
  const files = manifest.items.find((i) => i.slug === "good-skill").files;
  assert.ok(files.includes("skills/good-skill/notes.txt"));
  assert.ok(files.includes("skills/good-skill/SKILL.md"));
  assert.ok(!files.some((f) => f.includes(".local.")), files.join(", "));
  assert.ok(!readFileSync(join(root, "library.json"), "utf8").includes("protected.local"));
  rmSync(root, { recursive: true });
});

test("lint: *.local.* files are not scanned, and the PII scan still catches the same text in other files", () => {
  const email = "someone" + "@company.com";
  const root = libraryFixture({ "skills/good-skill/team.local.txt": `contact ${email}`, "skills/good-skill/extra.txt": "clean" });
  const clean = script("lint.mjs", root);
  assert.equal(clean.status, 0, clean.stdout);
  writeFileSync(join(root, "skills", "good-skill", "extra.txt"), `contact ${email}`);
  const dirty = script("lint.mjs", root);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /email address found/);
  assert.match(dirty.stdout, /skills\/good-skill\/extra\.txt/);
  assert.ok(!dirty.stdout.includes("team.local.txt"));
  rmSync(root, { recursive: true });
});
