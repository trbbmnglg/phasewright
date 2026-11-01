// Run with: node --test tests/free-resources-gate.test.mjs
// The stop gate (lib/gate.mjs): a pure function, so every case here is made-up facts for made-up processes; nothing is
// read from or done to this machine. One allowed case per system, then one refusal per rule, then the fail-closed sweep:
// every field the gate reads, set to missing, null, empty, NaN, -1, the wrong type or a stray word, must refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/free-resources-headroom.mjs";
import { T_OLD, T_SHELL, T_TOOL, SID, clone, windowsCase, linuxCase, macCase, CASES } from "./helpers/free-resources-cases.mjs";

const gate = await load("gate");
const AT = String.fromCharCode(64); // "@", built so the personal-data lint does not read a systemd unit name as an email address
const run = (c) => gate.evaluate(c);
const refusedBy = (c) => run(c).refused_by;

test("free-resources gate: a left-over dev tool of yours passes every check on Windows, Linux and macOS", () => {
  for (const [platform, make] of Object.entries(CASES)) {
    const c = make();
    const r = run(c);
    assert.equal(r.allowed, true, `${platform}: ${r.refused_by} ${r.reason}`);
    assert.ok(r.checks.every((x) => x.result === "yes"));
    assert.deepEqual(r.checks.map((x) => x.id), ["stopping_on", "not_elevated", "dev_tool", "same_process", "not_protected", "not_system_path", "same_owner", "not_session", "launcher", "not_managed", "identity"]);
    const assess = run({ ...c, expected: null });
    assert.equal(assess.allowed, true, `${platform}: a plan (no identity yet) is assessed too`);
    assert.ok(!assess.checks.some((x) => x.id === "identity"));
  }
});

// ---------- one refusal per rule ----------

test("free-resources gate: stopping switched off, an elevated tool, sudo, root or capabilities refuse every stop", () => {
  const off = windowsCase();
  off.protection = { ...off.protection, stop_allowed: false, stop_blockers: ['organization policy sets "stop": false'] };
  assert.equal(refusedBy(off), "stopping_on");
  assert.match(run(off).reason, /organization policy/);
  for (const [key, value] of [["elevated", true], ["integrity_rid", 0x3000], ["debug_privilege", true]]) {
    const c = windowsCase();
    c.me.facts[key] = value;
    assert.equal(refusedBy(c), "not_elevated", key);
  }
  const sudo = linuxCase();
  sudo.me.sudo = true;
  assert.equal(refusedBy(sudo), "not_elevated");
  const root = linuxCase();
  root.me.facts.uid = { real: 0, effective: 0, saved: 0, fs: 0 };
  assert.equal(refusedBy(root), "not_elevated");
  const setuid = linuxCase();
  setuid.me.facts.uid.effective = 0;
  assert.equal(refusedBy(setuid), "not_elevated");
  const caps = linuxCase();
  caps.me.facts.cap_eff = "0000000000000400";
  assert.equal(refusedBy(caps), "not_elevated");
  const macRoot = macCase();
  macRoot.me.facts.uid = 0;
  assert.equal(refusedBy(macRoot), "not_elevated");
});

test("free-resources gate: only a recognised dev tool that the classifier put in Suggest closing, or a busy one, can be stopped", () => {
  for (const decision of [
    { bucket: "keep", category: "protected" }, { bucket: "keep", category: "dev_active" }, { bucket: "your_call", category: "browser" },
    { bucket: "your_call", category: "heavy" }, { bucket: "suggest", category: "dev_leftover", tool: null }, { bucket: "suggest", category: "browser" },
  ]) {
    const c = windowsCase();
    c.decision = { ...c.decision, ...decision };
    assert.equal(refusedBy(c), "dev_tool", JSON.stringify(decision));
  }
  const busy = windowsCase();
  busy.decision = { ...busy.decision, bucket: "your_call", category: "dev_busy" };
  assert.equal(run(busy).allowed, true);
  const missing = windowsCase();
  missing.decision = undefined;
  assert.equal(refusedBy(missing), "dev_tool");
});

test("free-resources gate: a number now used by another process is refused", () => {
  const c = windowsCase();
  c.facts.start_iso = "2026-10-30T10:00:05.000Z";
  assert.equal(refusedBy(c), "same_process");
  const near = windowsCase();
  near.facts.start_iso = "2026-10-30T10:00:01.500Z";
  assert.notEqual(refusedBy(near), "same_process", "rounding between the two readings is not a different process");
  const other = windowsCase();
  other.facts.pid = 5002;
  assert.equal(refusedBy(other), "same_process");
});

test("free-resources gate: protected names, the protected lists and system folders refuse, whatever the classifier said", () => {
  for (const name of ["MsMpEng.exe", "svchost.exe", "Code.exe", "claude.exe", "pwsh.exe"]) {
    const c = windowsCase();
    c.record = { ...c.record, name };
    c.records = c.records.map((r) => (r.pid === 5001 ? c.record : r));
    assert.equal(refusedBy(c), "not_protected", name);
  }
  const listed = windowsCase();
  listed.protection = { ...listed.protection, names: ["node*"] };
  assert.equal(refusedBy(listed), "not_protected");
  assert.equal(run(listed).reason, "in a protected list that you or your organization set", "the entry itself is not quoted");
  const byPath = windowsCase();
  byPath.protection = { ...byPath.protection, paths: ["d:/profiles/tester/node/"] };
  assert.equal(refusedBy(byPath), "not_protected");
  const renamed = windowsCase();
  renamed.facts.image_path = "D:\\Profiles\\tester\\x\\MsMpEng.exe";
  assert.equal(run(renamed).allowed, false, "the program's own file name counts, not only the process name");
  const renamedTool = windowsCase();
  renamedTool.record = { ...renamedTool.record, name: "esbuild.exe", cmd_full: "esbuild.exe --serve" };
  renamedTool.records = renamedTool.records.map((r) => (r.pid === 5001 ? renamedTool.record : r));
  renamedTool.decision = { ...renamedTool.decision, tool: "esbuild", name: "esbuild.exe" };
  renamedTool.facts.image_path = "D:\\Profiles\\tester\\x\\esbuild.exe";
  renamedTool.expected = gate.identityOf("win32", renamedTool.facts);
  assert.equal(run(renamedTool).allowed, true);
  renamedTool.protection = { ...renamedTool.protection, names: ["esbuild"] };
  assert.equal(refusedBy(renamedTool), "not_protected", "a protected list matches the program's own file name");
});

test("free-resources gate: every spelling of a system folder refuses, and a runtime there running your own tool does not", () => {
  for (const path of ["C:\\Windows\\System32\\esbuild.exe", "C:\\Program Files\\Vendor\\esbuild.exe", "C:\\PROGRA~1\\Vendor\\esbuild.exe", "C:\\Program Files (Arm)\\V\\esbuild.exe", "\\\\?\\C:\\Program Files\\V\\esbuild.exe", "\\\\server\\share\\esbuild.exe", "C:\\ProgramData\\V\\esbuild.exe"]) {
    const c = windowsCase();
    c.facts.image_path = path;
    c.expected = gate.identityOf("win32", c.facts);
    c.record = { ...c.record, name: "esbuild.exe", cmd_full: "esbuild.exe --serve" };
    c.records = c.records.map((r) => (r.pid === 5001 ? c.record : r));
    c.decision = { ...c.decision, tool: "esbuild", name: "esbuild.exe" };
    assert.equal(refusedBy(c), "not_system_path", path);
  }
  const runtime = windowsCase();
  runtime.facts.image_path = "C:\\Program Files\\nodejs\\node.exe";
  runtime.expected = gate.identityOf("win32", runtime.facts);
  assert.equal(run(runtime).allowed, true, "Program Files node running vite from your project");
  const foreign = windowsCase();
  foreign.facts.image_path = "C:\\Program Files\\nodejs\\node.exe";
  foreign.expected = gate.identityOf("win32", foreign.facts);
  foreign.record = { ...foreign.record, cmd_full: "node C:\\Program Files\\Vendor\\node_modules\\vite\\bin\\vite.js" };
  foreign.records = foreign.records.map((r) => (r.pid === 5001 ? foreign.record : r));
  assert.equal(refusedBy(foreign), "not_system_path", "the same runtime running a vendor's script stays protected");
  const relative = windowsCase();
  relative.facts.image_path = "node.exe";
  assert.equal(refusedBy(relative), "not_system_path");
  const linuxOpt = linuxCase();
  linuxOpt.facts.exe = "/opt/vendor/bin/vite";
  linuxOpt.expected = gate.identityOf("linux", linuxOpt.facts);
  linuxOpt.record = { ...linuxOpt.record, cmd_full: "/opt/vendor/bin/vite" };
  linuxOpt.records = linuxOpt.records.map((r) => (r.pid === 5001 ? linuxOpt.record : r));
  assert.equal(refusedBy(linuxOpt), "not_system_path");
});

test("free-resources gate: the owner is compared by SID or by every user and group id, never by name", () => {
  const otherDomain = windowsCase();
  otherDomain.facts.sid = "S-1-5-21-9999999999-8888888888-7777777777-1001";
  otherDomain.expected = gate.identityOf("win32", otherDomain.facts);
  assert.equal(refusedBy(otherDomain), "same_owner", "the same user number in another domain is another account");
  for (const [k, v] of [["uid", "saved"], ["uid", "effective"], ["gid", "effective"], ["gid", "saved"]]) {
    const c = linuxCase();
    c.facts[k][v] = 1001;
    c.expected = gate.identityOf("linux", c.facts);
    assert.equal(refusedBy(c), "same_owner", `${k}.${v}`);
  }
  const mac = macCase();
  mac.facts.svuid = 0;
  assert.equal(refusedBy(mac), "same_owner");
});

test("free-resources gate: this tool, its parents and children, and the editor or assistant session it runs in are never stopped", () => {
  const self = windowsCase();
  self.record = { ...self.records.find((r) => r.pid === 9000), cmd_full: self.record.cmd_full };
  self.records = self.records.map((r) => (r.pid === 9000 ? self.record : r));
  self.facts = { ...self.facts, pid: 9000 };
  self.decision = { ...self.decision, pid: 9000 };
  assert.equal(refusedBy(self), "not_session");
  // This tool runs inside an assistant (claude) inside an editor; a dev server the assistant started is part of that session.
  const c = windowsCase();
  c.records = [
    { pid: 100, ppid: 50, name: "Code.exe", start_iso: T_OLD, exe: "D:\\Apps\\Code\\Code.exe" },
    { pid: 200, ppid: 100, name: "claude.exe", start_iso: T_OLD, exe: "D:\\Apps\\claude.exe" },
    { pid: 210, ppid: 200, name: "bash.exe", start_iso: T_SHELL, exe: "D:\\Apps\\Git\\bash.exe" },
    { pid: 9000, ppid: 210, name: "node.exe", start_iso: T_TOOL, exe: "D:\\Profiles\\tester\\node\\node.exe", cmd_full: "node free.mjs plan" },
    { ...c.record, ppid: 210 },
  ];
  c.record = c.records[4];
  assert.equal(refusedBy(c), "not_session");
  assert.match(run(c).reason, /claude\.exe session/);
  // The same dev server, left behind earlier (its parent gone), is not part of the session any more.
  const left = windowsCase();
  left.records = [...c.records.slice(0, 4), { ...c.record, ppid: 4999 }];
  left.record = left.records[4];
  assert.equal(run(left).allowed, true);
});

test("free-resources gate: a process must have been started from a shell or terminal, or left behind; an editor, assistant, service or security tool refuses", () => {
  const withParent = (name, extra = {}) => {
    const c = windowsCase();
    c.records = [...c.records.filter((r) => r.pid !== 5001), { pid: 4999, ppid: 4000, name, start_iso: T_OLD, exe: "D:\\Apps\\x.exe", ...extra }, { ...c.record, ppid: 4999 }];
    c.record = c.records[c.records.length - 1];
    return c;
  };
  for (const name of ["Code.exe", "cursor.exe", "svchost.exe", "services.exe", "MsMpEng.exe", "explorer.exe", "copilot.exe", "tailscaled.exe"]) {
    assert.equal(refusedBy(withParent(name)), "launcher", name);
  }
  assert.equal(run(withParent("pwsh.exe")).allowed, true, "a shell");
  assert.equal(run(withParent("WindowsTerminal.exe")).allowed, true, "a terminal");
  assert.equal(run(withParent("npm.exe")).allowed, true, "an unrecognised program between it and the end of the chain");
  const newer = withParent("Code.exe", { start_iso: "2026-10-30T11:00:00.000Z" });
  assert.equal(run(newer).allowed, true, "a parent that started after it is not its parent: the number was reused");
  const unreadable = windowsCase();
  unreadable.record = { ...unreadable.record, ppid: null };
  unreadable.records = unreadable.records.map((r) => (r.pid === 5001 ? unreadable.record : r));
  assert.equal(refusedBy(unreadable), "launcher", "a parent that cannot be read is unknown, not orphaned");
  const loop = windowsCase();
  loop.records = [...loop.records.filter((r) => r.pid !== 5001), ...Array.from({ length: 70 }, (_, i) => ({ pid: 20000 + i, ppid: 20001 + i, name: "x.exe", start_iso: T_OLD }))];
  loop.record = { ...loop.record, ppid: 20000 };
  loop.records.push(loop.record);
  assert.equal(refusedBy(loop), "launcher", "a chain too long to follow is unknown");
  const linuxService = linuxCase();
  linuxService.records = linuxService.records.map((r) => (r.pid === 5001 ? { ...r, ppid: 1 } : r));
  linuxService.record = linuxService.records.find((r) => r.pid === 5001);
  assert.equal(run(linuxService).allowed, true, "adopted by pid 1 on Linux");
});

test("free-resources gate: Windows refuses session 0, another session, critical, protected, elevated, other integrity and a parent of another account", () => {
  for (const [key, value, rule] of [
    ["session", 0, "not_managed"], ["session", 2, "not_managed"], ["critical", true, "not_managed"], ["protection", 0x31, "not_managed"],
    ["elevated", true, "not_managed"], ["integrity_rid", 0x1000, "not_managed"], ["integrity_rid", 0x3000, "not_managed"],
    ["parent_state", "other_owner", "not_managed"], ["parent_state", "unreadable", "not_managed"],
  ]) {
    const c = windowsCase();
    c.facts[key] = value;
    assert.equal(refusedBy(c), rule, `${key} = ${value}`);
  }
  const sameOwnerParent = windowsCase();
  sameOwnerParent.facts.parent_state = "same_owner";
  assert.equal(run(sameOwnerParent).allowed, true);
});

test("free-resources gate: Linux refuses kernel threads, zombies, containers, tracing, capabilities, OOM shields, session leaders and anything outside your user slice", () => {
  const cases = [
    ["kernel_thread", true], ["state", "Z"], ["state", "D"], ["state", "X"], ["nspid_count", 2], ["tracer_pid", 4242], ["cap_prm", "0000000000000400"],
    ["cap_eff", "0000000000200000"], ["oom_score_adj", -500], ["cgroup", "/system.slice/ssh.service"], ["cgroup", "/user.slice/user-1001.slice/session-2.scope"],
    ["cgroup", "/user.slice/user-1000.slice/user" + AT + "1000.service/app.slice/vite.service"], ["cgroup", "/user.slice/user-1000.slice/user" + AT + "1000.service/init.scope"],
    ["cgroup", "/user.slice/user-1000.slice/user" + AT + "1000.service/session.slice/pipewire.scope"], ["cgroup", "/docker/abc"], ["cgroup", null],
  ];
  for (const [key, value] of cases) {
    const c = linuxCase();
    c.facts[key] = value;
    assert.equal(refusedBy(c), "not_managed", `${key} = ${value}`);
  }
  const leader = linuxCase();
  leader.facts.session = 5001;
  leader.facts.tty_nr = 34816;
  assert.equal(refusedBy(leader), "not_managed", "a shell leading a terminal session");
  const ssh = linuxCase();
  ssh.facts.cgroup = "/user.slice/user-1000.slice/session-4.scope";
  assert.equal(run(ssh).allowed, true, "a login session's scope is yours");
  const pid2 = linuxCase();
  pid2.facts.pid = 2;
  pid2.record = { ...pid2.record, pid: 2 };
  pid2.decision = { ...pid2.decision, pid: 2 };
  assert.equal(run(pid2).allowed, false);
});

test("free-resources gate: on macOS only codesign's exit 3 (signed, but not by Apple) allows; Apple, unsigned, errors and timeouts refuse", () => {
  for (const [code, allowed] of [[3, true], [0, false], [1, false], [2, false], [null, false], [137, false]]) {
    const c = macCase();
    c.facts.codesign_exit = code;
    assert.equal(run(c).allowed, allowed, `codesign exit ${code}`);
    if (!allowed) assert.equal(refusedBy(c), "not_managed");
  }
  const zombie = macCase();
  zombie.facts.state = "Z";
  assert.equal(refusedBy(zombie), "not_managed");
  const flags = macCase();
  flags.facts.state = "Ss+";
  assert.equal(run(flags).allowed, true, "state letters with flags");
});

test("free-resources gate: a stop refuses when anything that pins the process differs from the plan", () => {
  for (const [platform, fields] of [["win32", ["creation", "image_path", "sid"]], ["linux", ["starttime", "exe", "boot_id"]], ["darwin", ["lstart", "exe", "uid"]]]) {
    for (const f of fields) {
      const c = CASES[platform]();
      c.expected = { ...c.expected, [f === "creation" || f === "starttime" || f === "lstart" ? "start" : f === "image_path" || f === "exe" ? "path" : f === "boot_id" ? "boot" : "owner"]: "something else" };
      assert.equal(run(c).allowed, false, `${platform} ${f}`);
    }
    const extra = CASES[platform]();
    extra.expected = { ...extra.expected, more: "x" };
    assert.equal(refusedBy(extra), "identity", `${platform}: an identity with another field`);
    const none = CASES[platform]();
    none.expected = "not an identity";
    assert.equal(refusedBy(none), "identity");
  }
});

// ---------- fail closed ----------

const DELETE = Symbol("delete");
const BAD = [DELETE, undefined, null, "", Number.NaN, -1, 0, {}, [], "yes", true, Number.POSITIVE_INFINITY];
const show = (v) => (v === DELETE ? "(missing)" : typeof v === "number" ? String(v) : JSON.stringify(v) ?? String(v));
const setAt = (obj, path, v) => {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  if (v === DELETE) delete target[last];
  else target[last] = v;
};
// The places the gate reads, per system.
const FIELDS = {
  win32: ["facts.pid", "facts.creation", "facts.start_iso", "facts.image_path", "facts.sid", "facts.session", "facts.critical", "facts.protection", "facts.integrity_rid", "facts.elevated", "facts.parent_state",
    "me.facts.sid", "me.facts.elevated", "me.facts.integrity_rid", "me.facts.debug_privilege", "me.facts.session", "me.pid"],
  linux: ["facts.pid", "facts.start_iso", "facts.starttime", "facts.exe", "facts.uid", "facts.uid.real", "facts.uid.saved", "facts.gid", "facts.gid.effective", "facts.state", "facts.kernel_thread", "facts.nspid_count", "facts.tracer_pid",
    "facts.cap_prm", "facts.cap_eff", "facts.oom_score_adj", "facts.session", "facts.tty_nr", "facts.cgroup", "facts.boot_id", "me.facts.uid", "me.facts.uid.real", "me.facts.gid", "me.facts.cap_eff", "me.sudo", "me.pid"],
  darwin: ["facts.pid", "facts.start_iso", "facts.lstart", "facts.exe", "facts.uid", "facts.ruid", "facts.svuid", "facts.gid", "facts.rgid", "facts.svgid", "facts.state", "facts.codesign_exit", "facts.launchd", "facts.launchd_jobs",
    "me.facts.uid", "me.facts.ruid", "me.facts.svuid", "me.facts.gid", "me.facts.rgid", "me.facts.svgid", "me.sudo", "me.pid"],
};
const SHARED = ["protection.stop_allowed", "protection.names", "protection.paths", "decision.bucket", "decision.category", "record.pid", "record.start_iso", "record.ppid", "record.name"];
// Values that are genuinely valid for a field, so trying them proves nothing: a word is a fine process name, true is what
// stop_allowed should be, an empty protected list is a list, and 0 is the normal value of a few counters.
const VALID = {
  "record.name": (v) => v === "yes", "protection.stop_allowed": (v) => v === true, "protection.names": Array.isArray, "protection.paths": Array.isArray,
  "darwin:facts.launchd_jobs": (v) => Array.isArray(v) && v.length === 0,
  "win32:facts.protection": (v) => v === 0, "linux:facts.tracer_pid": (v) => v === 0, "linux:facts.oom_score_adj": (v) => v === 0, "linux:facts.tty_nr": (v) => v === 0, "linux:facts.session": (v) => v === 0,
};

test("free-resources gate: fails closed: every field it reads, missing or wrong, refuses (and nothing it reads can throw it open)", () => {
  let tried = 0;
  for (const [platform, make] of Object.entries(CASES)) {
    for (const path of [...FIELDS[platform], ...SHARED]) {
      for (const v of BAD) {
        if (VALID[path]?.(v) || VALID[`${platform}:${path}`]?.(v)) continue;
        const c = clone(make());
        c.records = c.records.map((r) => (r.pid === c.record.pid ? c.record : r));
        setAt(c, path, v);
        if (path.startsWith("record.")) c.records = c.records.map((r) => (r === c.records.find((x) => x.pid === 5001) ? c.record : r));
        const r = run(c);
        tried += 1;
        assert.equal(r.allowed, false, `${platform}: ${path} = ${show(v)} was allowed`);
        assert.ok(r.refused_by && r.reason, `${platform}: ${path} = ${show(v)} says why`);
      }
    }
    // Throwing getters inside the facts are unknown, not a crash and not an allow.
    const c = make();
    Object.defineProperty(c.facts, "pid", { get() { throw new Error("boom"); }, enumerable: true });
    assert.equal(run(c).allowed, false);
  }
  assert.ok(tried > 600, `tried ${tried} mutations`);
  for (const bad of [undefined, null, {}, { platform: "aix" }, { platform: "win32" }]) assert.equal(gate.evaluate(bad).allowed, false, JSON.stringify(bad));
});

// ---------- how a process is stopped ----------

test("free-resources gate: only a windowed Windows program with a main window is asked to close; every other Windows program needs force; elsewhere SIGTERM first", () => {
  assert.equal(gate.methodFor("win32", { has_window: true, subsystem: 2 }), "close");
  for (const f of [{ has_window: true, subsystem: 3 }, { has_window: false, subsystem: 2 }, { has_window: null, subsystem: 2 }, { has_window: true, subsystem: null }, {}, null]) {
    assert.equal(gate.methodFor("win32", f), "end", JSON.stringify(f));
  }
  assert.equal(gate.methodFor("linux", {}), "term");
  assert.equal(gate.methodFor("darwin", null), "term");
  assert.deepEqual(Object.keys(gate.METHOD_LABELS).sort(), ["close", "end", "term"]);
});

test("free-resources gate: an identity has every field or is nothing", () => {
  const w = windowsCase();
  assert.deepEqual(gate.identityOf("win32", w.facts), { pid: 5001, start: "134000000000000000", path: "D:\\Profiles\\tester\\node\\node.exe", owner: SID });
  assert.deepEqual(Object.keys(gate.identityOf("linux", linuxCase().facts)), ["pid", "start", "path", "owner", "boot"]);
  assert.deepEqual(Object.keys(gate.identityOf("darwin", macCase().facts)), ["pid", "start", "path", "owner"]);
  for (const k of ["creation", "image_path", "sid", "pid"]) {
    const f = clone(w.facts);
    delete f[k];
    assert.equal(gate.identityOf("win32", f), null, k);
  }
  assert.equal(gate.identityOf("aix", w.facts), null);
});

// ---------- found by the security review ----------

test("free-resources gate: a program that only mentions a Playwright folder is not a Playwright browser, and the label is checked against the program", async () => {
  const classify = await load("classify");
  assert.equal(classify.devTool({ name: "postgres.exe", exe: "D:\\Apps\\pg\\postgres.exe", cmd_full: "postgres -D C:\\src\\ms-playwright-demo\\pgdata" }), null);
  assert.equal(classify.devTool({ name: "chrome.exe", exe: "D:\\Profiles\\tester\\AppData\\Local\\ms-playwright\\chromium-1140\\chrome-win\\chrome.exe", cmd_full: "chrome.exe" }), "playwright browser");
  assert.equal(classify.devTool({ name: "notes.exe", exe: "D:\\Profiles\\tester\\AppData\\Local\\ms-playwright\\chromium-1140\\notes.exe", cmd_full: "" }), null, "only a browser program in that layout");
  assert.equal(classify.devTool({ name: "chrome.exe", exe: "D:\\x\\ms-playwright\\chrome.exe", cmd_full: "" }), null, "without the <browser>-<build> folder it is not Playwright's");
  const c = windowsCase();
  c.decision = { ...c.decision, tool: "playwright browser" };
  assert.equal(refusedBy(c), "dev_tool", "a label the program does not bear out refuses");
});

test("free-resources gate: an assistant that runs as plain node still owns its session, and a tool started detached refuses everything", () => {
  // An assistant installed through npm runs as node. This tool runs in the shell it started; a dev server it started in
  // another shell is part of its session even though no process is named like an assistant.
  const c = windowsCase();
  c.records = [
    { pid: 100, ppid: 50, name: "WindowsTerminal.exe", start_iso: T_OLD, exe: "D:\\Apps\\Terminal\\WindowsTerminal.exe" },
    { pid: 200, ppid: 100, name: "node.exe", start_iso: T_OLD, exe: "D:\\Profiles\\tester\\node\\node.exe", cmd_full: "node D:\\Profiles\\tester\\npm\\node_modules\\some-assistant\\cli.js" },
    { pid: 210, ppid: 200, name: "bash.exe", start_iso: T_SHELL, exe: "D:\\Apps\\Git\\bash.exe" },
    { pid: 9000, ppid: 210, name: "node.exe", start_iso: T_TOOL, exe: "D:\\Profiles\\tester\\node\\node.exe", cmd_full: "node free.mjs plan" },
    { pid: 220, ppid: 200, name: "bash.exe", start_iso: T_SHELL, exe: "D:\\Apps\\Git\\bash.exe" },
    { ...c.record, ppid: 220 },
  ];
  c.record = c.records[5];
  assert.equal(refusedBy(c), "not_session");
  assert.match(run(c).reason, /node\.exe session/);
  const detached = windowsCase();
  detached.records = detached.records.map((r) => (r.pid === 9000 ? { ...r, ppid: 77 } : r));
  assert.equal(refusedBy(detached), "not_session", "this tool's parent is not in the scan");
  assert.match(run(detached).reason, /started detached/);
  const adopted = linuxCase();
  adopted.records = adopted.records.map((r) => (r.pid === 9000 ? { ...r, ppid: 1 } : r));
  assert.equal(refusedBy(adopted), "not_session", "this tool adopted by the first process");
});

test("free-resources gate: the runtime exception follows the account's own home folder, never the project folder or a root", () => {
  const outside = windowsCase();
  outside.facts.image_path = "C:\\Program Files\\nodejs\\node.exe";
  outside.expected = gate.identityOf("win32", outside.facts);
  outside.record = { ...outside.record, cmd_full: "node D:\\work\\proj\\node_modules\\vite\\bin\\vite.js" };
  outside.records = outside.records.map((r) => (r.pid === 5001 ? outside.record : r));
  outside.projectDir = "D:\\work\\proj";
  assert.equal(refusedBy(outside), "not_system_path", "a project folder outside your home folder does not count");
  for (const home of ["C:\\", "/", "D:", "relative\\home", "C:\\Program Files", null]) {
    const c = windowsCase();
    c.facts.image_path = "C:\\Program Files\\nodejs\\node.exe";
    c.expected = gate.identityOf("win32", c.facts);
    c.home = home;
    assert.equal(refusedBy(c), "not_system_path", String(home));
  }
  const mixed = windowsCase();
  mixed.facts.image_path = "C:\\Program Files\\nodejs\\node.exe";
  mixed.expected = gate.identityOf("win32", mixed.facts);
  mixed.record = { ...mixed.record, cmd_full: "node D:\\Profiles\\tester\\proj\\node_modules\\vite\\bin\\vite.js C:\\Program Files\\x.js" };
  mixed.records = mixed.records.map((r) => (r.pid === 5001 ? mixed.record : r));
  assert.equal(refusedBy(mixed), "not_system_path", "every folder it names must be yours");
});

test("free-resources gate: Linux refuses a process inside any systemd service, not only one whose last part is a service", () => {
  const c = linuxCase();
  c.facts.cgroup = "/user.slice/user-1000.slice/user" + AT + "1000.service/app.slice/devd.service/payload";
  assert.equal(refusedBy(c), "not_managed");
  const ok = linuxCase();
  ok.facts.cgroup = "/user.slice/user-1000.slice/user" + AT + "1000.service/app.slice/app-term-12.scope";
  assert.equal(run(ok).allowed, true, "your own service manager's service is the one allowed");
});

test("free-resources gate: the session is found through any number of shells, and a tool that ends in shells alone was started detached", () => {
  // Git Bash on Windows nests three bash processes between the assistant and this tool.
  const gitBash = windowsCase();
  gitBash.records = [
    { pid: 100, ppid: 50, name: "WindowsTerminal.exe", start_iso: T_OLD, exe: "D:\\Apps\\Terminal\\WindowsTerminal.exe" },
    { pid: 200, ppid: 100, name: "node.exe", start_iso: T_OLD, exe: "D:\\Profiles\\tester\\node\\node.exe", cmd_full: "node D:\\Profiles\\tester\\npm\\node_modules\\some-assistant\\cli.js" },
    { pid: 210, ppid: 200, name: "bash.exe", start_iso: T_SHELL, exe: "D:\\Apps\\Git\\bin\\bash.exe" },
    { pid: 211, ppid: 210, name: "bash.exe", start_iso: T_SHELL, exe: "D:\\Apps\\Git\\usr\\bin\\bash.exe" },
    { pid: 212, ppid: 211, name: "bash.exe", start_iso: T_SHELL, exe: "D:\\Apps\\Git\\usr\\bin\\bash.exe" },
    { pid: 9000, ppid: 212, name: "node.exe", start_iso: T_TOOL, exe: "D:\\Profiles\\tester\\node\\node.exe", cmd_full: "node free.mjs plan" },
    { pid: 220, ppid: 200, name: "bash.exe", start_iso: T_SHELL, exe: "D:\\Apps\\Git\\bin\\bash.exe" },
    { ...gitBash.record, ppid: 220 },
  ];
  gitBash.record = gitBash.records[7];
  assert.equal(refusedBy(gitBash), "not_session");
  assert.match(run(gitBash).reason, /node\.exe session/);
  // A shell whose own parent is gone, with no terminal window: started detached on purpose (cmd /c start cmd /k ...).
  const detached = windowsCase();
  detached.records = detached.records.map((r) => (r.pid === 8900 ? { ...r, name: "cmd.exe", ppid: 77 } : r));
  assert.equal(refusedBy(detached), "not_session");
  const setsid = linuxCase();
  setsid.records = setsid.records.map((r) => (r.pid === 3000 ? { ...r, ppid: 1 } : r));
  assert.equal(refusedBy(setsid), "not_session", "setsid bash -c ..., adopted by the first process");
  // A person's own desktop terminal adopted by their systemd (the base Linux case): no session to protect, nothing unknown.
  assert.equal(run(linuxCase()).allowed, true);
  const noTerminal = linuxCase();
  noTerminal.records = noTerminal.records.map((r) => (r.pid === 3000 ? { ...r, ppid: 1200 } : r));
  assert.equal(refusedBy(noTerminal), "not_session", "shells straight under the service manager, with no terminal window: detached");
  // The same tool run by hand in Windows Terminal, which the desktop started: the walk reaches the system, no session.
  const byHand = windowsCase();
  byHand.records = [...byHand.records, { pid: 700, ppid: 600, name: "explorer.exe", start_iso: T_OLD, exe: "C:\\Windows\\explorer.exe" }];
  assert.equal(run(byHand).allowed, true);
});

test("free-resources gate: macOS refuses a process that a launchd job started, not only the job itself", () => {
  const c = macCase();
  c.records = [...c.records.filter((r) => r.pid !== 5001), { pid: 77, ppid: 1, name: "npm", start_iso: T_OLD, exe: "/Users/Tester/.nvm/npm" }, { ...c.record, ppid: 77 }];
  c.record = c.records[c.records.length - 1];
  assert.equal(refusedBy(c), "not_managed");
  assert.match(run(c).reason, /started by npm, a launchd job/);
});

test("free-resources gate: macOS refuses a launchd job and an unknown answer, allows an app opened from the Dock, and compares the effective group", () => {
  for (const [kind, allowed] of [["none", true], ["application", true], ["job", false], [null, false], ["", false]]) {
    const c = macCase();
    c.facts.launchd = kind;
    assert.equal(run(c).allowed, allowed, String(kind));
  }
  const gid = macCase();
  gid.facts.gid = 0;
  assert.equal(refusedBy(gid), "same_owner");
  const mine = macCase();
  mine.me.facts.gid = 0;
  assert.equal(refusedBy(mine), "same_owner", "this tool with an effective group of its own");
});

