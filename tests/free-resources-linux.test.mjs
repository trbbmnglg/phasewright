// Run with: node --test tests/free-resources-linux.test.mjs
// Linux support of the free-resources plugin: the /proc parsers, the process-table reader and the pressure reading, run
// against a made-up /proc (every name, number and path here is invented), plus the classifier rules that changed with
// Linux (system folders, system services, orphans, a runtime in a system folder running the user's own dev tool).
// The live tests at the end read the real machine. They run on Linux and macOS and are skipped on Windows, where the
// existing live tests cover it; the CI runners are what make them real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FR, load } from "./helpers/free-resources-headroom.mjs";

const linux = await load("linux");
const AT = String.fromCharCode(64); // "@", built so the personal-data lint does not read a systemd unit name as an email address
const pressureLib = await load("pressure");
const classifyLib = await load("classify");
const sampler = await load("sampler");
const SCRIPTS = join(FR, "scripts");

// ---------- a made-up /proc ----------

const BTIME = 1_700_000_000;
const CLK = 100;
const isoOf = (starttime) => new Date((BTIME + starttime / CLK) * 1000).toISOString();

// A stat line with the fields proc_pid_stat(5) lists: after "(comm)", state is field 3 and starttime is field 22.
const statLine = ({ pid, comm, state = "S", ppid = 1, flags = 4194304, utime = 0, stime = 0, starttime = 100, rss = 0 }) =>
  `${pid} (${comm}) ${state} ${ppid} ${pid} 1 0 -1 ${flags} 10 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${starttime} 123456 ${rss} 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`;
const statusText = ({ name, uid = 1000, vmrss, nspid, capEff = "0000000000000000", tracer = 0 }) =>
  [`Name:\t${name}`, "State:\tS (sleeping)", `Uid:\t${uid}\t${uid}\t${uid}\t${uid}`, `Gid:\t${uid}\t${uid}\t${uid}\t${uid}`, ...(vmrss == null ? [] : [`VmRSS:\t  ${vmrss} kB`]), `NSpid:\t${nspid ?? 0}`, `CapPrm:\t${capEff}`, `CapEff:\t${capEff}`, `TracerPid:\t${tracer}`].join("\n");

function fakeProc(list, extra = {}) {
  const files = { "/proc/stat": `cpu  100 0 50 800 20 0 5 0 0 0\nbtime ${BTIME}\n`, ...extra.files };
  const links = {};
  const dirs = { "/proc": ["self", "net", "sys", ...list.map((p) => String(p.pid))], ...extra.dirs };
  for (const p of list) {
    const d = `/proc/${p.pid}`;
    if (p.gone) continue;
    files[`${d}/stat`] = statLine(p);
    if (!p.noStatus) files[`${d}/status`] = statusText({ name: p.name ?? p.comm, uid: p.uid, vmrss: p.vmrss, nspid: p.pid });
    if (p.exe) links[`${d}/exe`] = p.exe;
    if (p.cmdline != null) files[`${d}/cmdline`] = p.cmdline;
    if (p.cgroup != null) files[`${d}/cgroup`] = p.cgroup;
  }
  const missing = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
  const fsApi = {
    readFileSync: (p) => { if (p in files) return typeof files[p] === "function" ? files[p]() : files[p]; throw missing(p); },
    readdirSync: (p) => { if (p in dirs) return dirs[p]; throw missing(p); },
    readlinkSync: (p) => { if (p in links) return links[p]; throw missing(p); },
  };
  return { fsApi, files, links, dirs };
}

// ---------- parsers ----------

test("free-resources linux: parseStat counts fields from the last ')', so a command name with spaces and brackets is safe", () => {
  const plain = linux.parseStat(statLine({ pid: 42, comm: "node", ppid: 7, utime: 150, stime: 50, starttime: 360000, rss: 900 }));
  assert.deepEqual(plain, { pid: 42, comm: "node", state: "S", ppid: 7, pgrp: 42, session: 1, tty_nr: 0, flags: 4194304, utime: 150, stime: 50, starttime: 360000, rss_pages: 900 });
  const odd = linux.parseStat(statLine({ pid: 43, comm: "my (odd) app", ppid: 9, starttime: 55 }));
  assert.equal(odd.comm, "my (odd) app");
  assert.equal(odd.ppid, 9);
  assert.equal(odd.starttime, 55);
  for (const bad of ["", null, "garbage", "1 (x) S 1 2", "(x) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23", "1 (x) S a b c d e f g h i j k l m n o p q r s t u v"]) assert.equal(linux.parseStat(bad), null, String(bad));
});

test("free-resources linux: parseStatus reads ids, memory, namespaces, capabilities and tracer; a kernel thread has no VmRSS", () => {
  const s = linux.parseStatus(statusText({ name: "node", uid: 1000, vmrss: 204800, nspid: 4242 }));
  assert.equal(s.name, "node");
  assert.deepEqual(s.uid, { real: 1000, effective: 1000, saved: 1000, fs: 1000 });
  assert.equal(s.vmrss_kb, 204800);
  assert.deepEqual(s.nspid, [4242]);
  assert.equal(s.cap_eff, "0000000000000000");
  assert.equal(s.tracer_pid, 0);
  const kthread = linux.parseStatus(statusText({ name: "kworker/0:1", uid: 0 }));
  assert.equal(kthread.vmrss_kb, null);
  const nested = linux.parseStatus("Name:\tx\nNSpid:\t812\t12\nUid:\t1\t2\t3\t4\n");
  assert.deepEqual(nested.nspid, [812, 12], "two entries mean a nested PID namespace");
  assert.deepEqual(nested.uid, { real: 1, effective: 2, saved: 3, fs: 4 });
  assert.equal(linux.parseStatus("Uid:\tx\ty").uid, null);
  assert.equal(linux.parseStatus(null).name, null);
});

test("free-resources linux: meminfo, vmstat, proc stat, pressure, passwd, listening sockets and cgroup units parse", () => {
  const mem = linux.parseMeminfo("MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       2097148 kB\nSwapFree:        2097148 kB\n");
  assert.deepEqual(mem, { total_kb: 16384000, available_kb: 8192000, free_kb: 1000000, swap_total_kb: 2097148, swap_free_kb: 2097148 });
  assert.equal(linux.parseMeminfo("MemTotal: 5 kB").available_kb, null, "an old kernel without MemAvailable");
  assert.deepEqual(linux.parseVmstat("pgfault 9\npswpin 1200\npswpout 300\npgmajfault 77\n"), { pswpin: 1200, pswpout: 300, pgmajfault: 77 });
  assert.equal(linux.parseVmstat("nothing here").pswpin, null);
  const ps = linux.parseProcStat(`cpu  100 0 50 800 20 0 5 0 0 0\ncpu0 1 1 1 1 1 1 1 1 1 1\nbtime ${BTIME}\n`);
  assert.equal(ps.btime_s, BTIME);
  assert.deepEqual(ps.cpu, { idle: 820, total: 975 });
  assert.deepEqual(linux.parsePressure("some avg10=3.25 avg60=1.50 avg300=0.40 total=12345\nfull avg10=0.10 avg60=0.00 avg300=0.00 total=99\n"), { some: { avg10: 3.25, avg60: 1.5, avg300: 0.4 }, full: { avg10: 0.1, avg60: 0, avg300: 0 } });
  assert.equal(linux.parsePressure(""), null);
  const passwd = linux.parsePasswd("root:x:0:0:root:/root:/bin/bash\nzork:x:1000:1000::/people/zork:/bin/bash\nbad line\n");
  assert.equal(passwd.get(0), "root");
  assert.equal(passwd.get(1000), "zork");
  const net = linux.parseNetTcp("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 0\n   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 55502 1 0\n   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0\n");
  assert.deepEqual([...net], ["55501"], "only state 0A with a real inode");
  assert.equal(linux.parseCgroupUnit("0::/user.slice/user-1000.slice/user\u00401000.service/app.slice/app-foo.service\n"), "app-foo.service");
  assert.equal(linux.parseCgroupUnit("0::/user.slice/user-1000.slice/session-2.scope\n"), "session-2.scope");
  assert.equal(linux.parseCgroupUnit("0::/\n"), null);
  assert.equal(linux.parseCgroupUnit("12:memory:/a\n0::/b/c.service\n"), null, "cgroup v1 or hybrid: not read");
  assert.equal(linux.parseCgroupUnit(null), null);
  assert.equal(linux.cleanExe("/usr/bin/node (deleted)"), "/usr/bin/node");
  assert.equal(linux.cleanExe(null), null);
});

// ---------- reading a /proc ----------

test("free-resources linux: the process table is read from /proc with owner, memory, start time, command and unit; nothing unreadable throws", () => {
  const list = [
    { pid: 1, comm: "systemd", ppid: 0, uid: 0, vmrss: 11000, exe: "/usr/lib/systemd/systemd", cmdline: "/sbin/init\0splash\0", cgroup: "0::/init.scope\n", starttime: 10 },
    { pid: 100, comm: "node", ppid: 1, uid: 1000, vmrss: 204800, exe: "/people/zork/.nvm/bin/node (deleted)", cmdline: "node\0/people/zork/proj/server.js\0--token=abc123\0", cgroup: "0::/user.slice/user-1000.slice/vte-spawn-1.scope\n", utime: 150, stime: 50, starttime: 360000 },
    { pid: 200, comm: "kworker/0:1", ppid: 2, uid: 0, flags: 0x04208060, starttime: 20 },
    { pid: 300, comm: "other-svc", ppid: 1, uid: 33, vmrss: 5000, starttime: 30 },
    { pid: 400, comm: "vanished", gone: true },
    { pid: 500, comm: "nostatus", ppid: 1, noStatus: true, rss: 2560, starttime: 40 },
  ];
  const { fsApi } = fakeProc(list);
  const records = linux.readProcessTable({ fsApi, clkTck: CLK, btimeS: BTIME, passwd: new Map([[0, "root"], [33, "www-data"]]), self: { uid: 1000, user: "zork" }, home: "/people/zork" });
  const by = Object.fromEntries(records.map((r) => [r.pid, r]));
  assert.deepEqual(Object.keys(by).map(Number).sort((a, b) => a - b), [1, 100, 200, 300, 500], "the vanished pid and the non-numeric entries are skipped");
  const node = by[100];
  assert.equal(node.name, "node");
  assert.equal(node.exe, "/people/zork/.nvm/bin/node", " (deleted) is removed");
  assert.equal(node.owner, "zork", "your own uid is named with your own user name");
  assert.equal(node.ppid, 1);
  assert.equal(node.rss_mb, 200);
  assert.equal(node.cpu_s_total, 2);
  assert.equal(node.start_iso, isoOf(360000));
  assert.equal(node.unit, "vte-spawn-1.scope");
  assert.match(node.cmd_full, /node \/people\/zork\/proj\/server\.js --token=\*\*\*/, "NUL-separated arguments are joined and the secret is masked");
  assert.doesNotMatch(JSON.stringify(node), /abc123/);
  assert.match(node.cmd_summary, /server\.js/);
  assert.equal(by[1].owner, "root");
  assert.equal(by[1].exe, "/usr/lib/systemd/systemd");
  assert.equal(by[300].owner, "www-data");
  assert.equal(by[300].exe, null, "another user's exe link cannot be read");
  assert.equal(by[300].name, "other-svc", "the name falls back to the status name");
  assert.equal(by[200].cmd_full, null, "a kernel thread has no command line");
  assert.equal(by[200].rss_mb, 0);
  assert.equal(by[500].owner, null, "no status file: the owner is unknown, never guessed");
  assert.equal(by[500].rss_mb, 10, "without VmRSS the stat page count times the page size is used");
  const unknown = linux.readProcessTable({ fsApi, clkTck: CLK, btimeS: BTIME, passwd: new Map(), self: { uid: 1, user: "x" } });
  assert.equal(unknown.find((r) => r.pid === 300).owner, "uid-33", "a uid with no passwd entry is named by number");
  assert.equal(linux.readProcessTable({ fsApi: { readdirSync() { throw new Error("EACCES"); } } }).length, 0, "an unreadable /proc gives an empty table");
});

test("free-resources linux: the second sample is light, and CPU is matched by pid and start time so a reused pid is never mixed up", () => {
  const first = [
    { pid: 100, comm: "node", ppid: 1, uid: 1000, vmrss: 1, exe: "/x/node", cmdline: "node\0", utime: 100, stime: 0, starttime: 500 },
    { pid: 101, comm: "gone", ppid: 1, uid: 1000, vmrss: 1, exe: "/x/gone", cmdline: "gone\0", utime: 0, stime: 0, starttime: 600 },
  ];
  const a = fakeProc(first);
  const full = linux.readProcessTable({ fsApi: a.fsApi, clkTck: CLK, btimeS: BTIME, self: { uid: 1000, user: "zork" } });
  const b = fakeProc([
    { pid: 100, comm: "node", ppid: 1, uid: 1000, vmrss: 1, utime: 300, stime: 0, starttime: 500 },
    { pid: 101, comm: "reused", ppid: 1, uid: 1000, vmrss: 1, utime: 9999, stime: 0, starttime: 77777 },
  ]);
  const light = linux.readProcessTable({ fsApi: b.fsApi, clkTck: CLK, btimeS: BTIME, light: true });
  assert.deepEqual(Object.keys(light[0]).sort(), ["cpu_s_total", "pid", "start_iso"]);
  linux.applyLaterCpu(full, light, 2, 4);
  assert.equal(full.find((r) => r.pid === 100).cpu_pct, 25, "2 CPU seconds in 2 s on 4 CPUs is 25% of the machine");
  assert.equal(full.find((r) => r.pid === 101).cpu_pct, null, "same pid, different start time: not the same process");
});

test("free-resources linux: the measure sampler reads only the root's tree, with resident memory and CPU seconds", () => {
  const list = [
    { pid: 10, comm: "sh", ppid: 1, vmrss: 100, utime: 10, stime: 0 },
    { pid: 11, comm: "node", ppid: 10, vmrss: 2000, utime: 100, stime: 100 },
    { pid: 12, comm: "child", ppid: 11, vmrss: 500, utime: 50, stime: 0 },
    { pid: 13, comm: "sibling", ppid: 1, vmrss: 9999, utime: 1, stime: 0 },
  ];
  const { fsApi } = fakeProc(list);
  const rows = linux.readTreeRows({ fsApi, clkTck: CLK, rootPid: 11 });
  assert.deepEqual(rows.map((r) => r.pid).sort(), [11, 12]);
  assert.deepEqual(rows.find((r) => r.pid === 11), { pid: 11, ppid: 10, ws_bytes: 2000 * 1024, cpu_s: 2 });
  assert.deepEqual(linux.readTreeRows({ fsApi, clkTck: CLK, rootPid: 999 }), [], "a missing root gives no rows");
  const { rows: _ignored } = { rows };
  // the sampler's own tick math accepts these rows as they are
  const agg = new sampler.Aggregator();
  agg.addTree({ t: 1000, self_cpu_s: null, rows }, 11);
  assert.equal(agg.result().peak_tree_mb, Math.round(((2000 + 500) / 1024) * 10) / 10);
});

test("free-resources linux: the stop gate's facts come from /proc, and anything unreadable is null, never a guess", () => {
  const { fsApi, files, links } = fakeProc([{ pid: 300, comm: "node", ppid: 1, uid: 1000, exe: "/people/zork/.nvm/node (deleted)", cgroup: "0::/user.slice/user-1000.slice/user" + AT + "1000.service/app.slice/vte-spawn-2.scope\n", starttime: 4242 }]);
  files["/proc/300/oom_score_adj"] = "0\n";
  files["/proc/sys/kernel/random/boot_id"] = "0a1b2c3d-0000-4000-8000-000000000001\n";
  const f = linux.readLinuxFacts(300, { fsApi });
  assert.deepEqual({ ...f, uid: f.uid.real, gid: f.gid.real }, {
    pid: 300, name: "node", state: "S", ppid: 1, session: 1, tty_nr: 0, starttime: 4242, kernel_thread: false, uid: 1000, gid: 1000, nspid_count: 1,
    cap_eff: "0000000000000000", cap_prm: "0000000000000000", tracer_pid: 0, oom_score_adj: 0,
    cgroup: "/user.slice/user-1000.slice/user" + AT + "1000.service/app.slice/vte-spawn-2.scope", exe: "/people/zork/.nvm/node", boot_id: "0a1b2c3d-0000-4000-8000-000000000001",
  });
  delete files["/proc/300/oom_score_adj"];
  delete files["/proc/300/status"];
  delete links["/proc/300/exe"];
  files["/proc/300/cgroup"] = "12:memory:/x\n0::/\n";
  files["/proc/sys/kernel/random/boot_id"] = "not an id";
  const thin = linux.readLinuxFacts(300, { fsApi });
  for (const k of ["oom_score_adj", "uid", "gid", "nspid_count", "cap_eff", "cap_prm", "tracer_pid", "exe", "cgroup", "boot_id"]) assert.equal(thin[k], null, k);
  assert.equal(linux.readLinuxFacts(301, { fsApi }), null, "a process that is gone");
  for (const bad of [0, -1, 1.5, "300", null]) assert.equal(linux.readLinuxFacts(bad, { fsApi }), null, String(bad));
  const kthread = fakeProc([{ pid: 2, comm: "kthreadd", ppid: 0, flags: 0x00208040 }]);
  assert.equal(linux.readLinuxFacts(2, { fsApi: kthread.fsApi }).kernel_thread, true);
  assert.equal(linux.parseCgroupPath("0::/user.slice/a.scope\n"), "/user.slice/a.scope");
  for (const bad of ["", "0::relative", "1:name=systemd:/x\n0::/y\n", null]) assert.equal(linux.parseCgroupPath(bad), null, String(bad));
});

test("free-resources linux: listening sockets are matched to your own processes through their open files", () => {
  const { fsApi } = fakeProc([{ pid: 100, comm: "node" }, { pid: 200, comm: "other" }], {
    files: {
      "/proc/net/tcp": "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 0\n",
      "/proc/net/tcp6": "  sl  local_address rem_address   st\n",
    },
    dirs: { "/proc/100/fd": ["0", "1", "7"] },
  });
  const links = { "/proc/100/fd/0": "/dev/null", "/proc/100/fd/1": "pipe:[1]", "/proc/100/fd/7": "socket:[55501]" };
  const withLinks = { ...fsApi, readlinkSync: (p) => { if (p in links) return links[p]; throw new Error("ENOENT"); } };
  assert.deepEqual([...linux.readListeningPids({ fsApi: withLinks })], [100], "pid 200's fd folder cannot be read, so it is skipped");
  const none = fakeProc([{ pid: 100, comm: "node" }], { files: { "/proc/net/tcp": "header\n", "/proc/net/tcp6": "header\n" } });
  assert.equal(linux.readListeningPids({ fsApi: none.fsApi }).size, 0);
});

// ---------- pressure on Linux ----------

test("free-resources linux: pressure uses MemAvailable, pages swapped in per second, and the kernel's memory stall figure", async () => {
  let vm = 0;
  const { fsApi } = fakeProc([], {
    files: {
      "/proc/meminfo": "MemTotal:       16384000 kB\nMemAvailable:    1638400 kB\n",
      "/proc/vmstat": () => `pswpin ${vm++ === 0 ? 1000 : 1600}\npswpout 5\n`,
      "/proc/pressure/memory": "some avg10=4.50 avg60=2.00 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    },
  });
  const m = await pressureLib.measure("linux", { fsApi, cpu: async () => 90 });
  assert.equal(m.total_mb, 16000);
  assert.equal(m.avail_mb, 1600);
  assert.equal(m.avail_pct, 10);
  assert.equal(m.paging_per_s, 1200, "600 pages in the 0.5 s minimum interval");
  assert.equal(m.memory_stall_pct, 4.5);
  assert.equal(m.cpu_pct, 90);
  assert.equal(m.verdict, "memory+cpu");
  assert.deepEqual(m.unmeasured, []);
  assert.deepEqual(m.warnings, []);
  // nothing readable: every missing reading is named and the verdict does not pretend
  const bare = fakeProc([]);
  const n = await pressureLib.measure("linux", { fsApi: bare.fsApi, cpu: async () => null });
  assert.equal(n.paging_per_s, null);
  assert.equal(n.memory_stall_pct, null);
  assert.ok(n.unmeasured.includes("paging") && n.unmeasured.includes("CPU"));
  assert.ok(n.warnings.some((w) => /MemAvailable/.test(w)) && n.warnings.some((w) => /paging was not measured/.test(w)));
});

// ---------- the classifier on Linux ----------

const NOW = Date.parse("2026-01-02T12:00:00Z");
const ctx = (extra = {}) => ({ me: { user: "tester", pid: 99999 }, home: "/people/tester", platform: "linux", logical_cpus: 4, now_ms: NOW, localProtected: { names: [], paths: [] }, projectDir: "/people/tester/proj", listening: [], pathExists: () => false, all: false, ...extra });
const rec = (o) => ({ pid: 1000, ppid: 1, name: "x", exe: null, owner: "tester", cmd_summary: "x", rss_mb: 100, cpu_s_total: 0, start_iso: "2026-01-02T05:00:00.000Z", cmd_full: null, cpu_pct: 0, unit: null, ...o });
const bucketOf = (records, pid, c = ctx()) => classifyLib.classify(records, c).decisions.find((d) => d.pid === pid);

test("free-resources linux: system folders and system services are protected; /var/tmp is not a system folder", () => {
  for (const exe of ["/usr/bin/foo", "/opt/vendor/agent", "/snap/x/y", "/var/lib/z", "/etc/q", "/sbin/init", "/run/x"]) {
    const d = bucketOf([rec({ name: "someprog", exe, rss_mb: 900 })], 1000);
    assert.equal(d.category, "protected", exe);
  }
  assert.notEqual(bucketOf([rec({ name: "someprog", exe: "/var/tmp/someprog", rss_mb: 900 })], 1000).category, "protected");
  for (const name of ["systemd", "dbus-daemon", "gnome-shell", "pipewire", "polkitd", "systemd-journal", "gvfsd-fuse", "xdg-desktop-portal", "wdavdaemon"]) {
    assert.equal(bucketOf([rec({ name })], 1000).category, "protected", name);
  }
  assert.equal(bucketOf([rec({ name: "someprog", owner: "root" })], 1000).category, "other_user");
});

test("free-resources linux: a runtime in a system folder that runs your own dev tool is your dev server; a system script or another tool binary stays protected", () => {
  const vite = (exe, script) => rec({ name: "node", exe, cmd_full: `${exe} ${script} --port 5173`, rss_mb: 300 });
  const mine = bucketOf([vite("/usr/bin/node", "/people/tester/proj/node_modules/vite/bin/vite.js")], 1000);
  assert.equal(mine.bucket, "suggest", "orphaned (adopted by pid 1), idle and over an hour old");
  assert.equal(mine.tool, "vite");
  assert.equal(bucketOf([vite("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\tester\\proj\\node_modules\\vite\\bin\\vite.js")].map((r) => ({ ...r, name: "node.exe" })), 1000, ctx({ platform: "win32", home: "C:\\Users\\tester", projectDir: "C:\\Users\\tester\\proj" })).bucket, "suggest", "the same on Windows under Program Files");
  assert.equal(bucketOf([vite("/usr/bin/node", "/opt/app/node_modules/vite/bin/vite.js")], 1000).category, "protected", "the script is not in your folder");
  assert.equal(bucketOf([rec({ name: "workerd", exe: "/usr/bin/workerd", cmd_full: "/usr/bin/workerd serve", rss_mb: 300 })], 1000).category, "protected", "not a runtime: the folder rule still applies");
});

test("free-resources linux: an orphan is one adopted by pid 1, or by your own systemd while in a scope, and never a process that a .service keeps", () => {
  const tool = (o) => rec({ pid: 901, name: "node", exe: "/people/tester/.nvm/bin/node", cmd_full: "/people/tester/.nvm/bin/node /people/tester/proj/node_modules/vite/bin/vite.js", start_iso: "2026-01-02T11:30:00.000Z", ...o });
  const manager = rec({ pid: 900, ppid: 1, name: "systemd", exe: "/usr/lib/systemd/systemd", start_iso: "2026-01-01T00:00:00.000Z" });
  const orphanedText = (d) => d.reasons.join(";");
  const ORPHAN = /orphaned: the process that started it is gone/;
  assert.match(orphanedText(bucketOf([manager, tool({ ppid: 900, unit: "vte-spawn-abc.scope" })], 901)), ORPHAN, "in a scope under your systemd");
  assert.doesNotMatch(orphanedText(bucketOf([manager, tool({ ppid: 900, unit: "myvite.service" })], 901)), ORPHAN, "a service's own process is not left behind");
  assert.match(orphanedText(bucketOf([tool({ ppid: 1 })], 901)), ORPHAN, "adopted by pid 1");
  assert.doesNotMatch(orphanedText(bucketOf([rec({ pid: 800, ppid: 1, name: "bash", exe: "/usr/bin/bash", start_iso: "2026-01-01T00:00:00.000Z" }), tool({ ppid: 800 })], 901)), ORPHAN, "its shell is still there");
  const mac = bucketOf([tool({ ppid: 1 })], 901, ctx({ platform: "darwin" }));
  assert.match(orphanedText(mac), ORPHAN, "launchd (pid 1) adopts orphans on macOS too");
  const win = bucketOf([rec({ pid: 902, ppid: 1, name: "node.exe", exe: "C:\\Users\\tester\\nvm\\node.exe", cmd_full: "node.exe C:\\Users\\tester\\proj\\node_modules\\vite\\bin\\vite.js", start_iso: "2026-01-02T11:30:00.000Z" }), rec({ pid: 1, ppid: 0, name: "System", owner: "NT AUTHORITY\\SYSTEM", start_iso: "2026-01-01T00:00:00.000Z" })], 902, ctx({ platform: "win32", home: "C:\\Users\\tester", projectDir: "C:\\Users\\tester\\proj" }));
  assert.doesNotMatch(orphanedText(win), ORPHAN, "on Windows pid 1 is not special: the parent must be missing or newer");
});

// ---------- live: the real machine (Linux and macOS; Windows has its own live tests) ----------

const LIVE = process.platform === "linux" || process.platform === "darwin" ? false : "live test: Linux and macOS only";

test("free-resources linux: a live scan of this machine reads real processes, finds itself in use, and prints nothing unsafe", { skip: LIVE }, async () => {
  const scanLib = await load("scan");
  const report = await scanLib.scan({ sampleMs: 500, project: process.cwd() });
  assert.equal(report.platform, process.platform);
  assert.equal(report.read_only, true);
  assert.ok(report.totals.processes > 3, `${report.totals.processes} processes`);
  assert.ok(report.pressure.total_mb > 0 && report.pressure.avail_mb > 0, "memory was read");
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /cmd_full/, "no command line leaves the scanner");
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, "no control character in the output");
  const inUse = report.buckets.keep.listed.filter((g) => g.reasons.some((r) => /this scan, or its parent or child/.test(r)));
  assert.ok(inUse.length >= 1, "the scan itself is kept as in use");
  assert.ok(Array.isArray(report.analysis.items) && typeof report.analysis.summary.pressure === "string");
});

test("free-resources linux: a live measure run records the peak of a real command on Linux and macOS", { skip: LIVE }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fr-live-"));
  try {
    const env = { ...process.env, FREE_RESOURCES_DATA: dir };
    const r = spawnSync(process.execPath, [join(SCRIPTS, "measure.mjs"), "--task", "live-check", "--interval-ms", "500", "--json", "--", process.execPath, "-e", "const b = Buffer.alloc(40 * 1024 * 1024, 1); setTimeout(() => {}, 3000);"], { encoding: "utf8", env, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const rec = JSON.parse(readFileSync(join(dir, "peaks.jsonl"), "utf8").trim().split("\n").pop());
    assert.equal(rec.key, "live-check");
    assert.equal(rec.platform, process.platform);
    assert.ok(rec.samples >= 1, `tree samples: ${rec.samples}`);
    assert.ok(rec.peak_tree_mb > 20, `peak tree MB: ${rec.peak_tree_mb}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
