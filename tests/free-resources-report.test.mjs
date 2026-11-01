// Run with: node --test tests/free-resources-report.test.mjs
// The analysis part of the free-resources report and the pieces it rests on: cleaning names, the path rules, "not measured"
// instead of "none", the per-group analysis, advice for virtual machines and daemons, and --explain. Every fixture is
// invented (names, numbers, paths); none is real process data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FR, FIX, load } from "./helpers/free-resources-headroom.mjs";

// The shared fixture's protected list, so a machine's own list cannot change what these tests expect.
process.env.FREE_RESOURCES_PROTECTED = join(FIX, "protected.test.json");
const sanitize = await load("sanitize");
const paths = await load("paths");
const scanLib = await load("scan");
const reportLib = await load("report");
const analysisLib = await load("analysis");

const base = JSON.parse(readFileSync(join(FIX, "scan-win.json"), "utf8"));
const dirs = [];
const variant = (patch) => {
  const dir = mkdtempSync(join(tmpdir(), "fr-report-"));
  dirs.push(dir);
  const file = join(dir, "fixture.json");
  writeFileSync(file, JSON.stringify({ ...base, ...patch(base) }));
  return file;
};
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scanOf = (fixture, opts = {}) => scanLib.scan({ fixture, project: "D:\\Profiles\\tester\\proj", ...opts });
const cli = (args) => spawnSync(process.execPath, [join(FR, "scripts", "processes.mjs"), ...args], { encoding: "utf8", env: { ...process.env, FREE_RESOURCES_PROTECTED: join(FIX, "protected.test.json") } });

// ---------- cleaning names ----------

test("free-resources report: a name is cleaned before it is printed, and a clean name is left alone", () => {
  const safe = sanitize.safeName;
  for (const ok of ["node.exe", "Code Helper (Renderer)", "esbuild", "my-tool_2+x#1@host~", "Café", "日本語アプリ"]) assert.equal(safe(ok), ok, ok);
  assert.equal(safe("bad\u202Ename|`$(rm)`\nrow"), "badname???(rm)?row", "bidi control and line break removed; shell and Markdown characters become ?");
  assert.equal(safe("zero\u200Bwidth\u00ADname"), "zerowidthname");
  assert.equal(safe("a\u2028b\u2029c\u0000d\u007fe"), "abcde", "line and paragraph separators and controls are removed");
  assert.equal(safe("e\u0301"), "\u00e9", "NFC: a letter and its accent become one character");
  assert.equal(safe("<img src=x onerror=1>"), "?img src?x onerror?1?");
  assert.equal(safe(""), "(unnamed)");
  assert.equal(safe(null), "(unnamed)");
  assert.equal(safe("\n\u200b"), "(unnamed)");
  const long = safe("x".repeat(80));
  assert.equal(Array.from(long).length, 40);
  assert.ok(long.endsWith("…"));
  assert.equal(Array.from(safe("😀".repeat(60))).length, 40, "cut by characters, never in the middle of a surrogate pair");
});

// ---------- the path rules ----------

test("free-resources report: the path rules cover Windows short and long forms, shares, Linux folders and macOS folders", () => {
  const sys = (p, platform) => paths.isSystemPath(p, platform);
  for (const p of ["C:\\Windows\\System32\\x.exe", "C:\\Program Files\\V\\x.exe", "C:\\Program Files (x86)\\V\\x.exe", "C:\\Program Files (Arm)\\V\\x.exe", "C:\\PROGRA~1\\V\\x.exe", "C:\\PROGRA~2\\V\\x.exe", "C:\\ProgramData\\V\\x.exe", "\\\\?\\C:\\Program Files\\V\\x.exe", "\\\\?\\UNC\\server\\share\\x.exe", "\\\\server\\share\\x.exe", "\\Device\\HarddiskVolume3\\Windows\\x.exe"]) assert.equal(sys(p, "win32"), true, p);
  for (const p of ["D:\\Tools\\node\\node.exe", "C:\\Users\\zork\\app\\x.exe", "D:\\Apps\\x.exe"]) assert.equal(sys(p, "win32"), false, p);
  for (const p of ["/usr/bin/x", "/opt/vendor/a", "/etc/x", "/var/lib/x", "/proc/1/exe", "/snap/x/y", "/usr/bin/node (deleted)"]) assert.equal(sys(p, "linux"), true, p);
  for (const p of ["/people/zork/bin/x", "/tmp/x", "/var/tmp/x", "/srv/app/x"]) assert.equal(sys(p, "linux"), false, p);
  for (const p of ["/System/Library/x", "/usr/libexec/x", "/Library/x", "/bin/sh"]) assert.equal(sys(p, "darwin"), true, p);
  assert.equal(sys("/Users/Zork/x", "darwin"), false);
  assert.equal(sys(null, "linux"), false);
  assert.equal(paths.normalizePath("\\\\?\\C:\\a\\b"), "C:/a/b");
  assert.equal(paths.normalizePath("\\\\?\\UNC\\s\\sh"), "//s/sh");
  assert.equal(paths.normalizePath("/opt/x (deleted)"), "/opt/x");
  assert.equal(paths.isUserWritable("/people/zork/x", "/people/zork", "linux"), true);
  assert.equal(paths.isUserWritable("/var/tmp/x", "/people/zork", "linux"), true);
  assert.equal(paths.isUserWritable("/usr/bin/x", "/people/zork", "linux"), false);
  assert.equal(paths.isUserWritable("C:\\Users\\zork\\AppData\\Local\\Temp\\x.exe", "D:\\h", "win32"), true);
  assert.equal(paths.isAbsolutePath("/a/b", "linux"), true);
  assert.equal(paths.isAbsolutePath("C:\\a", "linux"), false);
  assert.equal(paths.isAbsolutePath("C:\\a", "win32"), true);
  assert.equal(paths.isAbsolutePath("a/b", "win32"), false);
  assert.equal(paths.isUnder("/people/a/x", "/people/a"), true);
  assert.equal(paths.isUnder("/people/ab/x", "/people/a"), false, "a folder with a longer name is not inside");
  assert.equal(paths.isUnder("D:\\Profiles\\Tester\\p", "d:/profiles/tester"), true, "case and separators do not matter");
  assert.equal(paths.isUnder("/x", ""), false);
});

// ---------- not measured ----------

test("free-resources report: nothing measured says 'not measured', one missing reading is named, and a full reading is unchanged", async () => {
  const none = await scanOf(variant(() => ({ pressure: {} })));
  assert.equal(none.pressure.verdict, "not_measured");
  assert.deepEqual(none.pressure.unmeasured, ["memory", "paging", "CPU"]);
  assert.match(reportLib.renderHuman(none), /## Pressure now: not measured/);
  assert.match(none.analysis.summary.pressure, /could not be measured/);
  const partial = await scanOf(variant(() => ({ pressure: { total_mb: 16384, avail_mb: 8000, cpu_pct: 20, samples: 3 } })));
  assert.equal(partial.pressure.verdict, "none");
  assert.deepEqual(partial.pressure.unmeasured, ["paging"]);
  const text = reportLib.renderHuman(partial);
  assert.match(text, /## Pressure now: no pressure in what was measured/);
  assert.match(text, /Not measured: paging\. The verdict covers only what was measured\./);
  assert.match(partial.analysis.summary.pressure, /No memory, paging or CPU pressure in what was measured \(paging not measured\)\./);
  const full = await scanOf(join(FIX, "scan-win.json"));
  assert.equal(full.pressure.verdict, "none");
  assert.deepEqual(full.pressure.unmeasured, []);
  assert.match(reportLib.renderHuman(full), /## Pressure now: no pressure\n/);
  assert.equal(full.pressure.memory_stall_pct, null);
});

// ---------- the analysis ----------

test("free-resources report: every listed group gets what, why, what to do and what it would give, in the same numbers as the tables", async () => {
  const r = await scanOf(join(FIX, "scan-win.json"));
  const groups = [...r.buckets.suggest_closing, ...r.buckets.your_call];
  assert.equal(r.analysis.items.length, groups.length);
  for (const g of groups) {
    const bucket = r.buckets.suggest_closing.includes(g) ? "suggest_closing" : "your_call";
    const item = r.analysis.items.find((i) => i.ref === `${bucket}#${g.n}`);
    assert.ok(item, `an item for ${bucket} ${g.n}`);
    assert.equal(item.name, g.name);
    for (const key of ["what", "why_heavy", "action"]) assert.ok(typeof item[key] === "string" && item[key].length > 10, `${g.name}: ${key}`);
    assert.equal(item.gain.memory_up_to_mb, g.total_mb);
  }
  const workerd = r.analysis.items.find((i) => i.name === "workerd.exe");
  assert.match(workerd.what, /workerd/);
  assert.equal(workerd.gain.cpu, "none: it is idle");
  assert.match(workerd.action, /Close it yourself where you started it .*or have free\.mjs stop it: its plan checks it again, and nothing is stopped until you pick it/);
  assert.match(r.analysis.items.find((i) => i.name === "chrome.exe").what, /web browser/);
  assert.match(r.analysis.items.find((i) => i.name === "chrome.exe").why_heavy, /3 processes using 900 MB \(5\.5% of this machine's memory\)/);
  assert.equal(r.analysis.summary.freeable_up_to_mb, r.buckets.suggest_closing.reduce((s, g) => s + g.total_mb, 0));
  const text = reportLib.renderHuman(r);
  assert.match(text, /## Analysis/);
  assert.match(text, /- What it is: /);
  assert.match(text, /^Suggest closing \d+: workerd\.exe$/m, "headings use the table names");
  assert.match(text, /^Your call \d+: chrome\.exe$/m);
  assert.match(text, /Closing everything under Suggest closing would free up to \d+ MB of memory and no CPU/);
  const empty = await scanOf(variant((b) => ({ records: b.records.filter((x) => x.name !== "workerd.exe" && x.name !== "esbuild.exe") })));
  assert.equal(empty.analysis.summary.freeable_up_to_mb, 0);
  assert.match(reportLib.renderHuman(empty), /Nothing is under Suggest closing, so there is nothing to free by closing\./);
});

test("free-resources report: off-limits names are your protected processes and service accounts; other people's processes are only counted", async () => {
  const r = await scanOf(variant((b) => ({
    records: [...b.records,
      { pid: 7100, ppid: 1, name: "msmpeng.exe", owner: "NT AUTHORITY\\SYSTEM", rss_mb: 700, exe: "C:\\ProgramData\\Microsoft\\Defender\\msmpeng.exe" },
      { pid: 7101, ppid: 1, name: "svchost.exe", owner: "NT AUTHORITY\\SYSTEM", rss_mb: 300, exe: "C:\\Windows\\System32\\svchost.exe" }],
  })));
  const o = r.analysis.summary.off_limits;
  const names = o.heaviest.map((h) => h.name);
  assert.ok(names.includes("msmpeng.exe") && names.includes("svchost.exe") && names.includes("vendorsvc.exe"), names.join(","));
  assert.equal(o.heaviest.find((h) => h.name === "msmpeng.exe").security, true, "a security agent is flagged as such, though its owner is SYSTEM");
  assert.equal(o.heaviest.find((h) => h.name === "svchost.exe").security, false);
  assert.match(reportLib.renderHuman(r), /msmpeng\.exe \(700 MB; system or service account; a security or endpoint agent\)/);
  assert.ok(!JSON.stringify(r).includes("otheruser"), "another person's process is not named without --all");
  assert.equal(o.other_users.processes, 1);
  assert.match(reportLib.renderHuman(r), /1 of them belongs to other users and is not named here; --all lists them\./);
  const all = await scanOf(variant((b) => ({ records: b.records })), { all: true });
  assert.ok(all.analysis.summary.off_limits.heaviest.some((h) => h.name === "otheruser.exe"), "with --all they are named");
});

test("free-resources report: virtual machines and daemons with their own stop command are advised, from a fixed table, above a size", async () => {
  const records = (extra) => ({ records: [...base.records, ...extra] });
  const r = await scanOf(variant(() => records([
    { pid: 8101, ppid: 1, name: "vmmemWSL", owner: "NT VIRTUAL MACHINE\\1234", rss_mb: 4096 },
    { pid: 8102, ppid: 3900, name: "java.exe", owner: "WORKGROUP\\tester", rss_mb: 600, cmd_full: "java.exe -Xmx512m org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.5" },
    { pid: 8103, ppid: 1, name: "com.docker.backend.exe", owner: "WORKGROUP\\tester", rss_mb: 400 },
    { pid: 8104, ppid: 1, name: "qemu-system-x86_64.exe", owner: "WORKGROUP\\tester", rss_mb: 2000, cmd_full: "qemu-system-x86_64.exe -avd Pixel_8 -memory 2048" },
    { pid: 8105, ppid: 1, name: "podman.exe", owner: "WORKGROUP\\tester", rss_mb: 120 },
  ])));
  const advice = r.analysis.summary.advice;
  const by = Object.fromEntries(advice.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(by).sort(), ["android-emulator", "docker-desktop", "gradle", "wsl"], "podman is under the size limit; kotlin is absent");
  assert.equal(by.wsl.command, "wsl --shutdown");
  assert.match(by.wsl.ends, /all running WSL distributions and the WSL 2 virtual machine/);
  assert.equal(by.gradle.command, "gradle --stop");
  assert.match(by.gradle.note, /after 3 hours/);
  assert.equal(by["docker-desktop"].command, "docker desktop stop");
  assert.match(by["docker-desktop"].ends, /does not say what happens to them/, "says only what the documentation says");
  assert.equal(by["android-emulator"].command, null);
  assert.match(by["android-emulator"].note, /Close the emulator window/);
  assert.deepEqual(advice.map((a) => a.memory_mb), [...advice.map((a) => a.memory_mb)].sort((x, y) => y - x), "largest first");
  for (const a of advice) assert.match(a.source, /^https:\/\//);
  const text = reportLib.renderHuman(r);
  assert.match(text, /you run these yourself; this skill never does/);
  assert.match(text, /Run `wsl --shutdown` yourself: it ends all running WSL distributions/);
  assert.ok(analysisLib.ADVICE.every((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.checked)), "every entry says when its page was read");
  const small = await scanOf(variant(() => records([{ pid: 8106, ppid: 1, name: "vmmem", owner: "x", rss_mb: 100 }])));
  assert.deepEqual(small.analysis.summary.advice, []);
});

test("free-resources report: a hostile process name cannot break a table or reach the output as anything but plain text", async () => {
  const evil = "bad\u202Ename|`$(rm)`\nrow";
  const r = await scanOf(variant((b) => ({ records: [...b.records, { pid: 9001, ppid: 3900, name: evil, owner: "WORKGROUP\\tester", rss_mb: 900, cpu_pct: 0.1, exe: "D:\\Profiles\\tester\\AppData\\Local\\evil\\evil.exe" }] })));
  const json = JSON.stringify(r);
  assert.ok(json.includes("badname???(rm)?row"), "the cleaned name is in the report");
  assert.ok(!json.includes("\u202e") && !json.includes("`") && !json.includes("$("), "none of the raw characters survive");
  const text = reportLib.renderHuman(r);
  assert.ok(!text.includes("`$(rm)`") && !text.includes("\u202e"));
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes("badname???(rm)?row"));
  assert.ok(at > 0 && lines[at].startsWith("|"), "it sits in a table row");
  let top = at;
  while (top > 0 && lines[top - 1].startsWith("|")) top -= 1;
  assert.equal(lines[at].split("|").length, lines[top].split("|").length, "with the same number of cells as that table's header");
});

// ---------- the protected-list note ----------

test("free-resources report: the report says how many entries each protected list gave, and the summary never copies the entries", async () => {
  const r = await scanOf(join(FIX, "scan-win.json"));
  const named = r.protection.lists.find((l) => l.label === "the file named by FREE_RESOURCES_PROTECTED");
  assert.deepEqual(named, { label: "the file named by FREE_RESOURCES_PROTECTED", status: "ok", names: 2, paths: 1 });
  assert.ok(r.notes.some((n) => /^Protected lists loaded: .*the file named by FREE_RESOURCES_PROTECTED \(2 names, 1 path\)/.test(n)));
  const summary = JSON.stringify({ protection: r.protection, notes: r.notes, analysis: r.analysis });
  for (const entry of ["fakesvc*", "workerd-corp", "corp-tools"]) assert.ok(!summary.includes(entry), `the entry ${entry} is not in the lists note or the analysis`);
  const off = r.analysis.summary.off_limits.heaviest.filter((h) => /protected list/.test(h.why));
  assert.ok(off.length >= 2 && off.every((h) => h.why === "in a protected list that you or your organization set"), "a list match is described, not quoted");
  const analysisText = reportLib.renderHuman(r).split("## Analysis")[1].split("\n## ")[0];
  assert.ok(!analysisText.includes("corp-tools") && !analysisText.includes("fakesvc*"));
  assert.equal(r.protection.stopping, "through free.mjs, for the dev tools you pick");
});

// ---------- --explain ----------

test("free-resources report: --explain says why one process is where it is, and a number that is not there says so", async () => {
  const r = await scanOf(join(FIX, "scan-win.json"), { explain: 5001 });
  assert.equal(r.explain.found, true);
  assert.equal(r.explain.name, "workerd.exe");
  assert.equal(r.explain.bucket, "suggest");
  assert.equal(r.explain.category, "dev_leftover");
  assert.ok(r.explain.reasons.some((x) => /orphaned: the process that started it is gone/.test(x)));
  assert.match(reportLib.renderHuman(r), /## Why pid 5001\n\n- workerd\.exe is in Suggest closing \(category: dev_leftover, confidence: high\)\./);
  const vendor = await scanOf(join(FIX, "scan-win.json"), { explain: 6002 });
  assert.equal(vendor.explain.bucket, "keep");
  assert.match(vendor.explain.reasons[0], /system or program-install folder/);
  const gone = await scanOf(join(FIX, "scan-win.json"), { explain: 424242 });
  assert.deepEqual(gone.explain, { pid: 424242, found: false });
  assert.match(reportLib.renderHuman(gone), /Pid 424242 was not among the processes scanned/);
  assert.equal((await scanOf(join(FIX, "scan-win.json"))).explain, undefined, "nothing is added without --explain");
});

test("free-resources report: --explain takes only a whole number from 1 to 10 digits", () => {
  const fx = join(FIX, "scan-win.json");
  for (const bad of ["0", "-1", "1.5", "abc", "12345678901", "01", ""]) assert.equal(cli(["--fixture", fx, "--explain", bad]).status, 2, `--explain ${bad}`);
  assert.equal(cli(["--fixture", fx, "--explain"]).status, 2, "a missing value");
  const ok = cli(["--fixture", fx, "--explain", "5001"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /## Why pid 5001/);
  const json = JSON.parse(cli(["--fixture", fx, "--explain", "5001", "--json"]).stdout);
  assert.equal(json.explain.found, true);
});
