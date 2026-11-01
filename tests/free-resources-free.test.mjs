// Run with: node --test tests/free-resources-free.test.mjs
// Stopping: lib/terminate.mjs (the only code that ends a process), lib/plans.mjs (the plan and the action log),
// lib/free-core.mjs (the order of a plan and a stop) and free.mjs (the command). The first parts use fakes, so nothing on
// this machine is signalled. The end-to-end test at the bottom starts its own stub processes and only ever names those.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FR, load, tmp } from "./helpers/free-resources-headroom.mjs";
import { clone, windowsCase, linuxCase, macCase } from "./helpers/free-resources-cases.mjs";

const terminate = await load("terminate");
const plans = await load("plans");
const core = await load("free-core");
const facts = await load("facts");
const FREE = join(FR, "scripts", "free.mjs");

// ---------- terminate.mjs ----------

test("free-resources terminate: refuses 0, 1, 2, negatives, fractions, text, this tool and its parent before anything runs", () => {
  const calls = [];
  const spawnFn = (...a) => { calls.push(a); return { status: 0 }; };
  const killFn = (...a) => calls.push(a);
  for (const pid of [0, 1, 2, -1, -4242, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5001", null, undefined, 2 ** 60, 777, 778]) {
    assert.throws(() => terminate.assertPid(pid, { self: 777, parent: 778 }), RangeError, String(pid));
    assert.throws(() => terminate.taskkill(pid, { platform: "win32", spawnFn, self: 777, parent: 778 }), RangeError);
    assert.throws(() => terminate.signal(pid, "SIGTERM", { platform: "linux", killFn, self: 777, parent: 778 }), RangeError);
  }
  assert.equal(calls.length, 0, "nothing was started or signalled");
  assert.equal(terminate.assertPid(5001, { self: 777, parent: 778 }), 5001);
});

test("free-resources terminate: Windows runs System32's taskkill with one /PID, /F only for force, from System32, with no shell", () => {
  const calls = [];
  const spawnFn = (file, args, opts) => { calls.push({ file, args, opts }); return { status: 0 }; };
  const env = { SystemRoot: "D:\\Windows", PATH: "C:\\evil" };
  assert.deepEqual(terminate.taskkill(5001, { platform: "win32", spawnFn, env, self: 1, parent: 1 }), { code: 0 });
  assert.deepEqual(terminate.taskkill(5001, { force: true, platform: "win32", spawnFn, env, self: 1, parent: 1 }), { code: 0 });
  for (const c of calls) {
    assert.match(c.file, /[\\/]Windows[\\/]System32[\\/]taskkill\.exe$/);
    assert.match(c.file, /^D:/, "below the Windows folder SystemRoot names");
    assert.equal(c.opts.shell, false);
    assert.match(c.opts.cwd, /[\\/]Windows[\\/]System32$/);
    assert.equal(c.opts.windowsHide, true);
    for (const banned of ["/IM", "/T", "/FI", "/S", "/U", "/P"]) assert.ok(!c.args.includes(banned), banned);
  }
  assert.deepEqual(calls[0].args, ["/PID", "5001"]);
  assert.deepEqual(calls[1].args, ["/PID", "5001", "/F"]);
  assert.equal(terminate.taskkill(5001, { platform: "win32", spawnFn: () => ({ status: 128 }), env, self: 1, parent: 1 }).code, 128, "only the exit code is kept");
  assert.equal(terminate.taskkill(5001, { platform: "win32", spawnFn: () => ({ status: null, error: new Error("x") }), env, self: 1, parent: 1 }).code, null);
  assert.throws(() => terminate.taskkill(5001, { force: "yes", platform: "win32", spawnFn, env, self: 1, parent: 1 }), TypeError);
  assert.throws(() => terminate.taskkill(5001, { platform: "linux", spawnFn, self: 1, parent: 1 }), /Windows only/);
  assert.equal(calls.length, 2);
});

test("free-resources terminate: elsewhere it sends SIGTERM or SIGKILL only, never on Windows, and reports a refusal without retrying", () => {
  const sent = [];
  const killFn = (p, s) => sent.push([p, s]);
  assert.deepEqual(terminate.signal(5001, "SIGTERM", { platform: "linux", killFn, self: 1, parent: 1 }), { ok: true });
  assert.deepEqual(terminate.signal(5001, "SIGKILL", { platform: "darwin", killFn, self: 1, parent: 1 }), { ok: true });
  for (const sig of ["SIGHUP", "SIGINT", "SIGSTOP", 9, 0, "0", "", null]) assert.throws(() => terminate.signal(5001, sig, { platform: "linux", killFn, self: 1, parent: 1 }), RangeError, String(sig));
  assert.throws(() => terminate.signal(5001, "SIGTERM", { platform: "win32", killFn, self: 1, parent: 1 }), /not used on Windows/);
  assert.deepEqual(sent, [[5001, "SIGTERM"], [5001, "SIGKILL"]]);
  const fail = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.deepEqual(terminate.signal(5001, "SIGTERM", { platform: "linux", killFn: fail("EPERM"), self: 1, parent: 1 }), { ok: false, code: "EPERM" });
  assert.deepEqual(terminate.signal(5001, "SIGTERM", { platform: "linux", killFn: fail("ESRCH"), self: 1, parent: 1 }), { ok: false, code: "ESRCH" });
});

// ---------- plans.mjs ----------

const planFor = (over = {}) => ({ schema_version: 1, id: "0123456789ab", created_ms: 1_000_000, expires_ms: 1_000_000 + plans.PLAN_TTL_MS, platform: "linux", items: [{ pid: 5001, name: "node", tool: "vite", mb: 300, method: "term", identity: { pid: 5001, start: "1", path: "/x", owner: "1000", boot: "b" } }], ...over });

test("free-resources plans: a plan is written whole, read back, replaced by the next one, and checked for age, id and system", () => {
  const dir = tmp();
  const opts = { env: { FREE_RESOURCES_DATA: dir } };
  assert.equal(plans.loadPlan(opts), null);
  plans.savePlan(planFor(), opts);
  assert.deepEqual(plans.loadPlan(opts), planFor());
  plans.savePlan(planFor({ id: "ba9876543210" }), opts);
  assert.equal(plans.loadPlan(opts).id, "ba9876543210", "only the newest plan is kept");
  assert.match(plans.newPlanId(), /^[0-9a-f]{12}$/);
  const p = planFor();
  const ok = (id, now, platform = "linux") => plans.checkPlan(p, id, { now, platform });
  assert.deepEqual(ok("0123456789ab", 1_000_000 + 60_000), { ok: true, reason: null });
  assert.match(plans.checkPlan(null, "0123456789ab", { now: 1, platform: "linux" }).reason, /no plan/);
  assert.match(ok("ffffffffffff", 1_000_000).reason, /not the newest plan/);
  assert.match(ok("0123456789ab", 1_000_000 + plans.PLAN_TTL_MS + 1).reason, /more than 10 minutes old/);
  assert.match(ok("0123456789ab", 1_000_000 - 120_000).reason, /in the future/);
  assert.match(ok("0123456789ab", 1_000_000, "win32").reason, /another system/);
  for (const bad of [{ id: "XYZ" }, { schema_version: 2 }, { items: [{ pid: 2, name: "x", method: "term", identity: {} }] }, { items: [{ pid: 5001, name: "x", method: "nuke", identity: {} }] }, { items: "x" }]) {
    assert.equal(plans.isPlan(planFor(bad)), false, JSON.stringify(bad));
    assert.throws(() => plans.savePlan(planFor(bad), opts), /not a plan/);
  }
  writeFileSync(join(dir, plans.PLAN_FILE), "{not json");
  assert.equal(plans.loadPlan(opts), null);
});

test("free-resources plans: the plan and the action log are never written inside the project, through a second name, or as a link", () => {
  const project = tmp();
  const inside = join(project, ".data");
  assert.throws(() => plans.savePlan(planFor(), { env: { FREE_RESOURCES_DATA: inside }, project }), /inside the project folder/);
  assert.throws(() => plans.appendAction({ plan: "x", command: "stop", pid: 5001, name: "n", method: "term", outcome: "ended" }, { env: { FREE_RESOURCES_DATA: inside }, project }), /inside the project folder/);
  assert.ok(!existsSync(inside));
  const dir = tmp();
  const opts = { env: { FREE_RESOURCES_DATA: dir } };
  const precious = join(dir, "precious.txt");
  writeFileSync(precious, "keep me\n");
  linkSync(precious, join(dir, plans.ACTIONS_FILE));
  assert.throws(() => plans.appendAction({ plan: "x", command: "stop", pid: 5001, name: "n", method: "term", outcome: "ended" }, opts), /actions\.jsonl is not a plain file/);
  assert.equal(readFileSync(precious, "utf8"), "keep me\n");
  const other = join(dir, "other.json");
  writeFileSync(other, "untouched");
  linkSync(other, join(dir, plans.PLAN_FILE));
  assert.equal(plans.loadPlan(opts), null, "a plan with a second name is not read");
  plans.savePlan(planFor(), opts);
  assert.equal(readFileSync(other, "utf8"), "untouched", "saving replaces the name, never writes through it");
});

test("free-resources plans: an action is logged with a cleaned name and no command line", () => {
  const dir = tmp();
  plans.appendAction({ plan: "0123456789ab", command: "force", pid: 5001, name: "evil\u202Ename|`x`", tool: "vite", method: "force", outcome: "ended", cmd_full: "node --token=secret" }, { env: { FREE_RESOURCES_DATA: dir }, now: 0 });
  const line = JSON.parse(readFileSync(join(dir, plans.ACTIONS_FILE), "utf8").trim());
  assert.deepEqual(Object.keys(line), ["schema_version", "at", "plan", "command", "pid", "name", "tool", "method", "outcome", "rule"]);
  assert.equal(line.name, "evilname??x?");
  assert.equal(line.at, "1970-01-01T00:00:00.000Z");
  assert.ok(!JSON.stringify(line).includes("secret"));
});

test("free-resources plans: running from your home folder is not a project, but a repository inside it is, for writing and for reading", async () => {
  const peaksLib = await load("peaks");
  const profile = tmp();
  const repo = join(profile, "code", "repo");
  const data = join(profile, "AppData", "Local", "free-resources");
  assert.equal(peaksLib.dataInsideProject(data, profile, process.platform, profile), false, "the home folder itself");
  assert.equal(peaksLib.dataInsideProject(data, join(profile, ".."), process.platform, profile), false, "a folder above it");
  assert.equal(peaksLib.dataInsideProject(join(repo, ".data"), repo, process.platform, profile), true, "a data folder a repository points into itself");
  assert.equal(peaksLib.dataInsideProject(data, repo, process.platform, profile), false);
  const opts = { env: { FREE_RESOURCES_DATA: data }, project: profile, profile };
  plans.savePlan(planFor(), opts);
  assert.equal(plans.loadPlan(opts).id, "0123456789ab");
  const inside = { env: { FREE_RESOURCES_DATA: join(repo, ".data") }, project: repo, profile };
  assert.throws(() => plans.savePlan(planFor(), inside), /inside the project folder/);
  mkdirSync(join(repo, ".data"), { recursive: true });
  writeFileSync(join(repo, ".data", plans.PLAN_FILE), JSON.stringify(planFor()));
  assert.equal(plans.loadPlan(inside), null, "a plan a repository ships is never read");
});

// ---------- facts.mjs ----------

test("free-resources facts: a Windows program's subsystem comes from its PE header, and anything else is unknown", () => {
  const pe = (subsystem, { magic = "MZ", sig = "PE\0\0", at = 0x80 } = {}) => {
    const b = Buffer.alloc(1024);
    b.write(magic, 0, "latin1");
    b.writeUInt32LE(at, 0x3c);
    b.write(sig, at, "latin1");
    b.writeUInt16LE(subsystem, at + 24 + 68);
    return b;
  };
  const opened = [];
  const fakeFs = (buf) => ({ open: (p) => { opened.push(p); return 7; }, read: (fd, target) => buf.copy(target), close: () => {} });
  assert.equal(facts.peSubsystem("C:\\x.exe", fakeFs(pe(2))), 2);
  assert.equal(facts.peSubsystem("C:\\x.exe", fakeFs(pe(3))), 3);
  const pastTheEnd = Buffer.alloc(1024);
  pastTheEnd.write("MZ", 0, "latin1");
  pastTheEnd.writeUInt32LE(4000, 0x3c);
  for (const bad of [pe(2, { magic: "ZM" }), pe(2, { sig: "NE\0\0" }), pastTheEnd, Buffer.alloc(10)]) assert.equal(facts.peSubsystem("C:\\x.exe", fakeFs(bad)), null);
  assert.equal(facts.peSubsystem("C:\\x.exe", { open: () => { throw new Error("EACCES"); } }), null);
  opened.length = 0;
  for (const remote of ["\\\\server\\share\\x.exe", "\\\\?\\UNC\\server\\share\\x.exe", "\\\\.\\pipe\\x", "\\\\?\\C:\\x.exe", "x.exe", "/usr/bin/x"]) assert.equal(facts.peSubsystem(remote, fakeFs(pe(2))), null, remote);
  assert.deepEqual(opened, [], "a share or device path is never opened, so Windows never signs in anywhere for it");
  assert.equal(facts.peSubsystem(process.execPath), process.platform === "win32" ? 3 : null, "node itself is a console program on Windows, and not a PE file elsewhere");
});

test("free-resources canonical: paths are turned into their long form on Windows only, and only on a local drive", async () => {
  const canonical = await load("canonical");
  // Like Windows' own answer: backslashes, and the long name for the short one.
  const realpath = (p) => String(p).split("/").join("\\").replace(/^C:\\PROGRA~1/i, "C:\\Program Files");
  assert.equal(canonical.canonicalPathFor("win32", { realpath })("C:/PROGRA~1/x"), "C:\\Program Files\\x", "forward slashes are a local path too");
  assert.equal(canonical.canonicalPathFor("win32", { realpath: () => { throw new Error("ENOENT"); } })("C:\\gone\\x"), "C:\\gone\\x", "a path that cannot be resolved stays as it was");
  let opened = 0;
  const count = (p) => { opened += 1; return p; };
  for (const p of ["\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\x"]) assert.equal(canonical.canonicalPathFor("win32", { realpath: count })(p), p);
  assert.equal(opened, 0, "a share or device path is never opened");
  for (const platform of ["linux", "darwin"]) assert.equal(canonical.canonicalPathFor(platform, { realpath: () => "changed" })("/a/b"), "/a/b");
});

test("free-resources facts: the Windows program path is made canonical only on a local drive", () => {
  assert.equal(facts.canonicalWindowsPath("C:\\PROGRA~1\\x.exe", { realpath: () => "C:\\Program Files\\x.exe" }), "C:\\Program Files\\x.exe");
  assert.equal(facts.canonicalWindowsPath("C:\\x.exe", { realpath: () => "\\\\?\\C:\\x.exe" }), "C:\\x.exe");
  assert.equal(facts.canonicalWindowsPath("C:\\x.exe", { realpath: () => "\\\\server\\share\\x.exe" }), null, "a link that leads to a share is not a local program");
  assert.equal(facts.canonicalWindowsPath("C:\\gone.exe", { realpath: () => { throw new Error("ENOENT"); } }), null);
  let called = 0;
  for (const remote of ["\\\\server\\share\\x.exe", "\\\\?\\UNC\\s\\x.exe", null, ""]) assert.equal(facts.canonicalWindowsPath(remote, { realpath: () => { called += 1; return "C:\\x"; } }), null);
  assert.equal(called, 0);
});

test("free-resources facts: macOS rows, the real program from lsof, and the launchd job list are read strictly", () => {
  const f = facts.parseMacFacts("  5001     1   501   501   501    20    20    20 S    Fri Oct 30 10:00:00 2026\n");
  assert.deepEqual(f, { pid: 5001, ppid: 1, uid: 501, ruid: 501, svuid: 501, gid: 20, rgid: 20, svgid: 20, state: "S", lstart: "Fri Oct 30 10:00:00 2026", start_iso: new Date("Fri Oct 30 10:00:00 2026").toISOString() });
  assert.equal(facts.parseMacFacts("5001 1 501 501 501 20 20 20 Ss+ Sat Oct  3 09:05:00 2026").state, "Ss+");
  for (const bad of ["", "garbage", "5001 1 501 501 501 20 20 S Fri Oct 30 10:00:00 2026", null]) assert.equal(facts.parseMacFacts(bad), null, String(bad));
  assert.equal(facts.parseLsofProgram("p5001\nftxt\nn/Users/Tester/.nvm/versions/node/v22/bin/node\nftxt\nn/usr/lib/dyld\n"), "/Users/Tester/.nvm/versions/node/v22/bin/node");
  assert.equal(facts.parseLsofProgram("p5001\n"), null);
  const jobs = facts.parseLaunchctlList("PID\tStatus\tLabel\n-\t0\tcom.example.idle\n4242\t0\tcom.example.devserver\n4343\t0\tapplication.com.example.App.1234\n");
  assert.equal(facts.launchdKind(jobs, 4242), "job");
  assert.equal(facts.launchdKind(jobs, 4343), "application");
  assert.equal(facts.launchdKind(jobs, 5001), "none");
  assert.equal(facts.launchdKind(null, 5001), null, "an unreadable list is unknown");
  assert.equal(facts.parseLaunchctlList("something else"), null);
});

// ---------- selfcheck.mjs ----------

test("free-resources selfcheck: refuses an elevated tool, root, sudo, a container or a foreign session, and a macOS where the Apple check does not work", async () => {
  const sc = await load("selfcheck");
  const with_ = (f) => async () => ({ facts: f, release: async () => {} });
  const winOk = { sid: "S-1-5-21-1-2-3-1001", elevated: false, integrity_rid: 0x2000, debug_privilege: false, session: 1 };
  assert.equal((await sc.selfCheck({ platform: "win32", factsFor: with_(winOk) })).ok, true);
  for (const [k, v, msg] of [["elevated", true, /elevated/], ["integrity_rid", 0x3000, /integrity/], ["debug_privilege", true, /debug/], ["session", 0, /session 0/], ["sid", null, /account/]]) {
    const r = await sc.selfCheck({ platform: "win32", factsFor: with_({ ...winOk, [k]: v }) });
    assert.equal(r.ok, false, k);
    assert.ok(r.reasons.some((x) => msg.test(x)), `${k}: ${r.reasons}`);
  }
  const ids = { real: 1000, effective: 1000, saved: 1000, fs: 1000 };
  const linOk = { uid: ids, cap_eff: "0000000000000000", nspid_count: 1, cgroup: "/user.slice/user-1000.slice/session-2.scope" };
  assert.equal((await sc.selfCheck({ platform: "linux", env: {}, factsFor: with_(linOk) })).ok, true);
  for (const [over, env, msg] of [[{ cgroup: "/system.slice/runner.service" }, {}, /user session/], [{ nspid_count: 2 }, {}, /PID namespace/], [{ uid: { ...ids, real: 0, effective: 0 } }, {}, /root/], [{}, { SUDO_UID: "1000" }, /sudo/], [{ cap_eff: "0000000000000001" }, {}, /capabilities/]]) {
    const r = await sc.selfCheck({ platform: "linux", env, factsFor: with_({ ...linOk, ...over }) });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.ok(r.reasons.some((x) => msg.test(x)), r.reasons.join("; "));
  }
  const macOk = { uid: 501, ruid: 501 };
  const codesign = (finder, node) => async (p) => (p === sc.FINDER ? finder : node);
  const jobs = async () => new Map();
  const aqua = async () => "Aqua";
  const mac = (extra) => sc.selfCheck({ platform: "darwin", env: {}, factsFor: with_(macOk), codesign: codesign(0, 3), launchdJobs: jobs, launchdManager: aqua, ...extra });
  assert.equal((await mac({})).ok, true);
  for (const [f, n] of [[1, 3], [0, 0], [0, 1], [null, 3], [0, null]]) assert.equal((await mac({ codesign: codesign(f, n) })).ok, false, `${f} ${n}`);
  const noList = await mac({ launchdJobs: async () => null });
  assert.equal(noList.ok, false, "a launchd job list that cannot be read refuses");
  assert.ok(noList.reasons.some((x) => /launchctl list/.test(x)));
  for (const manager of ["Background", "", null]) {
    const r = await mac({ launchdManager: async () => manager });
    assert.equal(r.ok, false, `not a desktop login: ${manager}`);
    assert.ok(r.reasons.some((x) => /not a desktop login/.test(x)));
  }
  const unread = await sc.selfCheck({ platform: "linux", env: {}, factsFor: with_(null) });
  assert.equal(unread.ok, false);
  const thrown = await sc.selfCheck({ platform: "linux", env: {}, factsFor: async () => { throw new Error("x"); } });
  assert.equal(thrown.ok, false);
  assert.equal((await sc.selfCheck({ platform: "aix", factsFor: with_({}) })).ok, false);
});

// ---------- free-core.mjs: the order of a plan and a stop ----------

// A fake world for one made-up case: the scan, the facts (a process that ends once signalled, unless told otherwise),
// the store and the actions, with every call recorded.
function world(c, o = {}) {
  const calls = { selfCheck: 0, state: 0, facts: [], many: [], taskkill: [], signal: [], saved: [], appended: [], released: 0, waited: 0 };
  let clock = Date.parse("2026-10-30T12:00:00.000Z");
  let stored = null;
  const alive = new Map([[c.facts.pid, c.facts]]);
  for (const [pid, f] of o.more ?? []) alive.set(pid, f);
  const deps = {
    platform: c.platform,
    now: () => clock,
    self: { self: 9000, parent: 8900 },
    selfCheck: async () => { calls.selfCheck += 1; return o.self ?? { ok: true, reasons: [], me: c.me }; },
    state: async () => { calls.state += 1; return { records: c.records, classification: { decisions: o.decisions ?? [c.decision] }, protection: c.protection, home: c.home, project: c.projectDir }; },
    factsFor: async (pid) => {
      calls.facts.push(pid);
      const f = o.factsNow ? o.factsNow(pid, calls) : alive.get(pid) ?? null;
      return { facts: f ? clone(f) : null, release: async () => { calls.released += 1; }, waitForExit: async () => { calls.waited += 1; return o.exited ?? { exited: true }; }, alive: async () => !o.pinLost };
    },
    factsForMany: async (pids) => { calls.many.push(pids); return new Map(pids.map((p) => [p, alive.has(p) ? clone(alive.get(p)) : null])); },
    store: { save: (p) => { stored = p; calls.saved.push(p); }, load: () => (o.load ? o.load() : stored), append: (r) => { if (o.logFails) throw new Error("EACCES"); calls.appended.push(r); } },
    act: {
      taskkill: (pid, { force }) => { calls.taskkill.push([pid, force]); if (!o.survives) alive.delete(pid); return { code: o.taskkillCode ?? 0 }; },
      signal: (pid, sig) => { calls.signal.push([pid, sig]); if (o.signal) return o.signal; if (!o.survives || sig === "SIGKILL") alive.delete(pid); return { ok: true }; },
    },
    sleep: async (ms) => { clock += ms; },
    randomId: () => "0123456789ab",
  };
  return { deps, calls, advance: (ms) => { clock += ms; } };
}

test("free-resources free: a plan lists what passed every check with how it would be stopped, and saves the identities without printing them", async () => {
  const c = windowsCase();
  const blocked = { ...c.decision, pid: 5002 };
  const blockedFacts = { ...c.facts, pid: 5002, image_path: "C:\\Program Files\\Vendor\\node.exe", creation: "1" };
  c.records = [...c.records, { ...c.record, pid: 5002, exe: blockedFacts.image_path, cmd_full: "node C:\\Program Files\\Vendor\\node_modules\\vite\\bin\\vite.js" }];
  const own = { ...c.decision, pid: 9000 };
  const { deps, calls } = world(c, { decisions: [c.decision, blocked, own, { ...c.decision, pid: 7, bucket: "keep", category: "protected" }], more: [[5002, blockedFacts]] });
  const { code, result } = await core.makePlan(deps);
  assert.equal(code, 0);
  assert.equal(result.plan_id, "0123456789ab");
  assert.deepEqual(result.stoppable.map((i) => [i.pid, i.method, i.how, i.needs_second_yes]), [[5001, "end", "ends it at once", true]]);
  assert.deepEqual(result.refused.map((i) => [i.pid, i.rule]).sort(), [[5002, "not_system_path"], [9000, "pid"]]);
  assert.deepEqual(calls.many, [[5001, 5002]], "only candidates are read, in one go, and never this tool");
  assert.equal(calls.taskkill.length + calls.signal.length, 0, "a plan stops nothing");
  assert.deepEqual(calls.saved[0].items[0].identity, { pid: 5001, start: c.facts.creation, path: c.facts.image_path, owner: c.facts.sid });
  const printed = JSON.stringify(result);
  assert.ok(!printed.includes(c.facts.sid) && !printed.includes("identity"), "the SID and identities stay in the plan file");
});

test("free-resources free: a plan is refused, and nothing is read or saved, when the self-check fails or stopping is switched off", async () => {
  const c = linuxCase();
  const failed = world(c, { self: { ok: false, reasons: ["it runs as root"], me: c.me } });
  assert.deepEqual(await core.makePlan(failed.deps), { code: 4, result: { refused: "self_check", reasons: ["it runs as root"] } });
  assert.equal(failed.calls.state + failed.calls.many.length + failed.calls.saved.length, 0);
  const off = linuxCase();
  off.protection = { ...off.protection, stop_allowed: false, stop_blockers: ['your list sets "stop": false'] };
  const w = world(off);
  const r = await core.makePlan(w.deps);
  assert.equal(r.code, 4);
  assert.equal(r.result.refused, "stopping_off");
  assert.equal(w.calls.many.length + w.calls.saved.length, 0);
});

test("free-resources free: a stop request is checked before anything else: plan id, numbers, at most 10, force takes one", async () => {
  for (const [req, msg] of [
    [{ command: "kill", planId: "0123456789ab", pids: [5001] }, /stop or force/],
    [{ command: "stop", planId: "0123", pids: [5001] }, /--plan/],
    [{ command: "stop", planId: "0123456789ab", pids: [] }, /at least one/],
    [{ command: "stop", planId: "0123456789ab", pids: [5001, 5001] }, /twice/],
    [{ command: "stop", planId: "0123456789ab", pids: [1.5] }, /whole numbers/],
    [{ command: "stop", planId: "0123456789ab", pids: Array.from({ length: 11 }, (_, i) => 6000 + i) }, /at most 10/],
    [{ command: "force", planId: "0123456789ab", pids: [5001, 5002] }, /exactly one/],
  ]) {
    const { deps, calls } = world(windowsCase());
    const r = await core.stopPids(req, deps);
    assert.equal(r.code, 2, JSON.stringify(req));
    assert.match(r.result.error, msg);
    assert.equal(calls.selfCheck + calls.state + calls.facts.length, 0);
  }
});

test("free-resources free: a missing, old, replaced or foreign plan, or a pid it does not list, refuses with nothing done", async () => {
  const c = windowsCase();
  const made = world(c);
  await core.makePlan(made.deps);
  const plan = made.calls.saved[0];
  const cases = [
    [{ load: () => null }, "plan", /no plan/],
    [{ load: () => ({ ...plan, id: "ffffffffffff" }) }, "plan", /not the newest/],
    [{ load: () => ({ ...plan, created_ms: 0, expires_ms: 1 }) }, "plan", /more than 10 minutes/],
    [{ load: () => ({ ...plan, platform: "linux" }) }, "plan", /another system/],
  ];
  for (const [o, refused, msg] of cases) {
    const { deps, calls } = world(c, o);
    const r = await core.stopPids({ command: "force", planId: "0123456789ab", pids: [5001] }, deps);
    assert.equal(r.code, 4);
    assert.equal(r.result.refused, refused);
    assert.match(r.result.reasons[0], msg);
    assert.equal(calls.selfCheck + calls.state + calls.facts.length + calls.taskkill.length, 0);
  }
  const { deps, calls } = world(c, { load: () => plan });
  const notListed = await core.stopPids({ command: "force", planId: "0123456789ab", pids: [4242] }, deps);
  assert.equal(notListed.code, 4);
  assert.match(notListed.result.reasons[0], /not in the plan/);
  const needsForce = await core.stopPids({ command: "stop", planId: "0123456789ab", pids: [5001] }, deps);
  assert.equal(needsForce.code, 4, "a console program can only be ended at once, which stop never does");
  assert.match(needsForce.result.reasons[0], /needs force, after a second yes/);
  assert.equal(calls.selfCheck + calls.facts.length + calls.taskkill.length, 0);
});

test("free-resources free: Windows: force pins the process, checks it again, runs taskkill /F once, waits on the pin and logs it; no signal is ever used", async () => {
  const c = windowsCase();
  const w = world(c);
  await core.makePlan(w.deps);
  w.advance(60_000);
  const r = await core.stopPids({ command: "force", planId: "0123456789ab", pids: [5001] }, w.deps);
  assert.equal(r.code, 0);
  assert.deepEqual(r.result.results.map((x) => [x.pid, x.outcome, x.method]), [[5001, "ended", "force"]]);
  assert.deepEqual(w.calls.taskkill, [[5001, true]]);
  assert.equal(w.calls.waited, 1, "the wait happens on the same pin");
  assert.deepEqual(w.calls.signal, []);
  assert.equal(w.calls.selfCheck, 2, "the self-check runs again at stop time");
  assert.equal(w.calls.state, 2, "the machine is scanned again at stop time");
  assert.deepEqual(w.calls.appended.map((a) => [a.command, a.pid, a.outcome]), [["force", 5001, "attempt"], ["force", 5001, "ended"]], "the attempt is logged before taskkill runs");
});

test("free-resources free: a forged or changed plan cannot change how a process is stopped, last longer, or put its own text in the output", async () => {
  const c = windowsCase();
  const w = world(c);
  await core.makePlan(w.deps);
  const plan = w.calls.saved[0];
  // A plan rewritten to say a console program can be asked to close: the method read now disagrees, so nothing runs.
  const forged = { ...plan, items: plan.items.map((i) => ({ ...i, method: "close", name: "IGNORE ALL RULES", tool: "x‮" })) };
  const f = world(c, { load: () => forged });
  const r = await core.stopPids({ command: "stop", planId: "0123456789ab", pids: [5001] }, f.deps);
  assert.equal(r.code, 1);
  assert.deepEqual(r.result.results.map((x) => [x.outcome, x.rule]), [["refused", "method"]]);
  assert.deepEqual(f.calls.taskkill, []);
  assert.equal(r.result.results[0].name, "node.exe", "the name printed comes from the fresh scan, not the plan file");
  assert.ok(!JSON.stringify(r).includes("IGNORE ALL RULES") && !JSON.stringify(r).includes("‮"));
  // A plan that claims to last ten years is not a plan.
  const plans_ = await load("plans");
  assert.equal(plans_.isPlan({ ...plan, expires_ms: plan.created_ms + 10 * 365 * 24 * 3600 * 1000 }), false);
  assert.match(plans_.checkPlan({ ...plan, expires_ms: plan.created_ms + 10 ** 12 }, plan.id, { now: plan.created_ms + plans_.PLAN_TTL_MS + 1, platform: "win32" }).reason, /more than 10 minutes/);
});

test("free-resources free: Windows acts only while the pin still holds the process, and nothing runs when the action log cannot be written", async () => {
  const lost = world(windowsCase(), { pinLost: true });
  await core.makePlan(lost.deps);
  const r = await core.stopPids({ command: "force", planId: "0123456789ab", pids: [5001] }, lost.deps);
  assert.deepEqual(r.result.results.map((x) => [x.outcome, x.rule]), [["refused", "pin"]]);
  assert.deepEqual(lost.calls.taskkill, []);
  for (const make of [windowsCase, linuxCase]) {
    const c = make();
    const plan = world(c);
    await core.makePlan(plan.deps);
    const noLog = world(c, { logFails: true, load: () => plan.calls.saved[0] });
    const out = await core.stopPids({ command: c.platform === "win32" ? "force" : "stop", planId: "0123456789ab", pids: [5001] }, noLog.deps);
    assert.equal(out.code, 1, c.platform);
    assert.equal(out.result.results[0].outcome, "refused");
    assert.match(out.result.results[0].reason, /action log could not be written, so nothing was done/);
    assert.deepEqual([noLog.calls.taskkill, noLog.calls.signal], [[], []], `${c.platform}: nothing was sent`);
  }
});

test("free-resources free: Windows: a windowed program is asked to close without /F, and one that does not close is reported, not forced", async () => {
  const c = windowsCase();
  c.facts.has_window = true;
  c.facts.subsystem = 2;
  const w = world(c, { survives: true, exited: { exited: false } });
  const plan = await core.makePlan(w.deps);
  assert.equal(plan.result.stoppable[0].method, "close");
  const r = await core.stopPids({ command: "stop", planId: "0123456789ab", pids: [5001] }, w.deps);
  assert.equal(r.code, 1);
  assert.equal(r.result.results[0].outcome, "still_running");
  assert.deepEqual(w.calls.taskkill, [[5001, false]], "one ask, no /F");
});

test("free-resources free: a process that changed since the plan is refused at stop time and left alone", async () => {
  const c = windowsCase();
  const w = world(c, { factsNow: (pid, calls) => (calls.facts.length >= 1 ? { ...c.facts, creation: "134000000000000999" } : c.facts) });
  await core.makePlan(w.deps);
  const r = await core.stopPids({ command: "force", planId: "0123456789ab", pids: [5001] }, w.deps);
  assert.equal(r.code, 1);
  assert.deepEqual(r.result.results.map((x) => [x.outcome, x.rule]), [["refused", "identity"]]);
  assert.deepEqual(w.calls.taskkill, []);
  assert.equal(w.calls.released, 1, "the pin is let go");
});

test("free-resources free: macOS and Linux send SIGTERM, wait until the process is gone, and never call taskkill", async () => {
  for (const make of [linuxCase, macCase]) {
    const c = make();
    const w = world(c);
    await core.makePlan(w.deps);
    const r = await core.stopPids({ command: "stop", planId: "0123456789ab", pids: [5001] }, w.deps);
    assert.equal(r.code, 0, c.platform);
    assert.deepEqual(w.calls.signal, [[5001, "SIGTERM"]]);
    assert.deepEqual(w.calls.taskkill, []);
    assert.equal(r.result.results[0].outcome, "ended");
  }
});

test("free-resources free: a process that ignores SIGTERM is reported as still running; force then sends SIGKILL once", async () => {
  const c = linuxCase();
  const w = world(c, { survives: true });
  await core.makePlan(w.deps);
  const first = await core.stopPids({ command: "stop", planId: "0123456789ab", pids: [5001] }, w.deps);
  assert.equal(first.code, 1);
  assert.equal(first.result.results[0].outcome, "still_running");
  assert.match(first.result.results[0].reason, /needs force, after a second yes/);
  const second = await core.stopPids({ command: "force", planId: "0123456789ab", pids: [5001] }, w.deps);
  assert.equal(second.code, 0);
  assert.deepEqual(w.calls.signal, [[5001, "SIGTERM"], [5001, "SIGKILL"]]);
});

test("free-resources free: a number that changes hands right before the signal gets no signal, and a refusal is never retried", async () => {
  const c = linuxCase();
  // The third read is the one right before the signal (the plan reads in one go; the stop reads once for the gate, then again).
  const w = world(c, { factsNow: (pid, calls) => (calls.facts.length >= 2 ? { ...c.facts, starttime: 999999 } : c.facts) });
  await core.makePlan(w.deps);
  const r = await core.stopPids({ command: "stop", planId: "0123456789ab", pids: [5001] }, w.deps);
  assert.equal(r.result.results[0].rule, "identity");
  assert.deepEqual(w.calls.signal, []);
  const denied = world(linuxCase(), { signal: { ok: false, code: "EPERM" } });
  await core.makePlan(denied.deps);
  const d = await core.stopPids({ command: "stop", planId: "0123456789ab", pids: [5001] }, denied.deps);
  assert.equal(d.code, 1);
  assert.equal(d.result.results[0].outcome, "failed");
  assert.match(d.result.results[0].reason, /nothing else was tried/);
  assert.deepEqual(denied.calls.signal, [[5001, "SIGTERM"]], "exactly one attempt");
});

test("free-resources free: a stop refuses everything when the self-check fails or stopping was switched off since the plan", async () => {
  const c = linuxCase();
  const w = world(c);
  await core.makePlan(w.deps);
  const failing = { ...w.deps, selfCheck: async () => ({ ok: false, reasons: ["it was started through sudo"], me: c.me }) };
  const r = await core.stopPids({ command: "stop", planId: "0123456789ab", pids: [5001] }, failing);
  assert.equal(r.code, 4);
  assert.equal(r.result.refused, "self_check");
  const off = { ...w.deps, state: async () => ({ ...(await w.deps.state()), protection: { ...c.protection, stop_allowed: false, stop_blockers: ["x"] } }) };
  assert.equal((await core.stopPids({ command: "stop", planId: "0123456789ab", pids: [5001] }, off)).code, 4);
  assert.deepEqual(w.calls.signal, []);
});

// ---------- free.mjs ----------

const cli = (args, env = {}) => spawnSync(process.execPath, [FREE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("free-resources free: free.mjs takes only its own options and refuses with exit 2 otherwise", () => {
  for (const args of [[], ["kill"], ["plan", "--fixture", "x"], ["plan", "--pid", "5"], ["stop"], ["stop", "--plan", "0123456789ab"], ["stop", "--pid", "5"], ["stop", "--plan", "XYZ", "--pid", "5"],
    ["stop", "--plan", "0123456789ab", "--pid", "0"], ["stop", "--plan", "0123456789ab", "--pid", "5;rm"], ["stop", "--plan", "0123456789ab", "--pid", "05"], ["stop", "--plan", "0123456789ab", "--plan", "0123456789ab", "--pid", "5"],
    ["force", "--plan", "0123456789ab", "--pid", "5", "--pid", "6"], ["stop", "--plan", "0123456789ab", "--pid", "5", "--all"], ["stop", "--plan", "0123456789ab", "--pid", "5", "--project", "x"]]) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage: node free\.mjs/);
  }
});

test("free-resources free: free.mjs stop without a plan refuses with exit 4 before scanning or touching anything", () => {
  const dir = tmp();
  const r = cli(["stop", "--plan", "0123456789ab", "--pid", "5001", "--json"], { FREE_RESOURCES_DATA: dir });
  assert.equal(r.status, 4, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.exit_code, 4);
  assert.equal(out.refused, "plan");
  assert.match(out.reasons[0], /no plan/);
  assert.ok(!existsSync(join(dir, plans.ACTIONS_FILE)), "nothing was logged, because nothing was tried");
  const human = cli(["force", "--plan", "0123456789ab", "--pid", "5001"], { FREE_RESOURCES_DATA: dir });
  assert.equal(human.status, 4);
  assert.match(human.stdout, /^Refused, nothing was done \(plan\):/);
});

// ---------- end to end, with the test's own stub processes only ----------

// Starts a stub that looks like a left-over vite dev server (node running node_modules/vite/bin/vite.js) whose launcher
// has exited, so it is orphaned and idle. Returns its pid.
function startStub(dir, name, { ignoreTerm = false } = {}) {
  const script = join(dir, "node_modules", name, "bin", `${name}.js`);
  mkdirSync(join(dir, "node_modules", name, "bin"), { recursive: true });
  writeFileSync(script, `${ignoreTerm ? "process.on('SIGTERM', () => {});\n" : ""}setInterval(() => {}, 60000);\n`);
  // The stub runs from the system's temp folder, not from `dir`: Windows will not remove a folder a process is using. The
  // launcher writes the number as plain text: in a colour terminal the test runner turns colours on for what it starts,
  // and console.log would wrap a number in colour codes.
  const launcher = spawnSync(process.execPath, ["-e", `const c = require("child_process").spawn(process.execPath, [${JSON.stringify(script)}], { detached: true, stdio: "ignore", windowsHide: true, cwd: require("os").tmpdir() }); c.on("error", (e) => process.stderr.write("spawn error " + e.code)); c.unref(); process.stdout.write(String(c.pid));`], { encoding: "utf8", cwd: tmpdir() });
  const pid = Number(String(launcher.stdout ?? "").replace(/\u001b\[[0-9;]*m/g, "").trim());
  const seen = { status: launcher.status, signal: launcher.signal, error: launcher.error?.code ?? null, stdout: launcher.stdout, stderr: launcher.stderr, script };
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `the stub's launcher gave no process number: ${JSON.stringify(seen)}`);
  return pid;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const endOwnStub = (pid) => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } };
const waitGone = async (pid, ms = 15000) => { for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) if (!alive(pid)) return true; return !alive(pid); };

test("free-resources free: end to end, a plan finds the test's own left-over stub and a stop ends only it; where this tool may not stop anything it refuses and the stub lives", { timeout: 240000 }, async () => {
  const project = tmp();
  const data = tmp();
  const env = { FREE_RESOURCES_DATA: data };
  const run = (args) => spawnSync(process.execPath, [FREE, ...args, "--json"], { encoding: "utf8", cwd: project, env: { ...process.env, ...env }, timeout: 180000 });
  // Started inside the try, so whatever fails later, everything that was started is ended.
  let stub = null;
  let stubborn = null;
  let bystander = null;
  try {
    stub = startStub(project, "vite");
    stubborn = process.platform === "win32" ? null : startStub(project, "esbuild", { ignoreTerm: true });
    bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
    await new Promise((r) => setTimeout(r, 1500));
    const plan = run(["plan"]);
    const p = JSON.parse(plan.stdout);
    if (p.exit_code === 4) {
      // This machine or account may not stop anything here (an elevated Windows runner, a CI service outside the user's
      // own session): it says so, and nothing is touched.
      assert.equal(plan.status, 4);
      assert.ok(["self_check", "stopping_off"].includes(p.refused), p.refused);
      assert.ok(p.reasons.length > 0);
      assert.ok(alive(stub), "the stub was left alone");
      assert.ok(!existsSync(join(data, "plan.json")), "no plan was written");
      return;
    }
    assert.equal(plan.status, 0, plan.stderr);
    const item = p.stoppable.find((i) => i.pid === stub);
    assert.ok(item, `the stub is stoppable: ${JSON.stringify(p.refused.find((i) => i.pid === stub))}`);
    assert.equal(item.tool, "vite");
    assert.ok(!p.stoppable.some((i) => i.pid === bystander.pid), "a plain node process is never offered");
    const first = run([item.needs_second_yes ? "force" : "stop", "--plan", p.plan_id, "--pid", String(stub)]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(JSON.parse(first.stdout).results[0].outcome, "ended");
    assert.ok(await waitGone(stub), "the stub ended");
    assert.ok(alive(bystander.pid), "the bystander was not touched");
    if (stubborn) {
      const s = p.stoppable.find((i) => i.pid === stubborn);
      assert.ok(s, "the stub that ignores SIGTERM is stoppable too");
      const ask = run(["stop", "--plan", p.plan_id, "--pid", String(stubborn)]);
      assert.equal(ask.status, 1, "it did not stop when asked");
      assert.equal(JSON.parse(ask.stdout).results[0].outcome, "still_running");
      const force = run(["force", "--plan", p.plan_id, "--pid", String(stubborn)]);
      assert.equal(force.status, 0, force.stdout);
      assert.ok(await waitGone(stubborn));
    }
    const log = readFileSync(join(data, "actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(log.every((l) => [stub, stubborn].includes(l.pid)), "only the stubs were ever acted on");
  } finally {
    if (stub) endOwnStub(stub);
    if (stubborn) endOwnStub(stubborn);
    bystander?.kill();
    if (stub) await waitGone(stub, 5000);
    if (stubborn) await waitGone(stubborn, 5000);
  }
});
