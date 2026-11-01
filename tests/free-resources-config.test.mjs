// Run with: node --test tests/free-resources-config.test.mjs
// The protected lists a person or an organization adds, and the "stop": false setting. Every file here is an in-memory
// fake read through the loader's io hooks, so no machine's own lists can change what these tests expect. Names and paths
// are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { FR, load } from "./helpers/free-resources-headroom.mjs";

const { configPaths, readList, loadProtection } = await load("config");
const classifyLib = await load("classify");

const key = (f) => String(f).split("\\").join("/");
// A fake disk: { "/etc/free-resources/policy.json": "{...}" }. A value that is an Error is thrown when read.
const disk = (files) => ({
  exists: (f) => Object.hasOwn(files, key(f)),
  read: (f) => { const v = files[key(f)]; if (v instanceof Error) throw v; return v; },
  size: (f) => { const v = files[key(f)]; return typeof v === "string" ? Buffer.byteLength(v) : 0; },
});
const json = (o) => JSON.stringify(o);
const HOME = "/people/zork";
const SCRIPTS = "/plugin/scripts";
const POLICY = "/etc/free-resources/policy.json";
const USER = "/people/zork/.config/free-resources/protected.json";
const LOCAL = "/plugin/scripts/protected.local.json";
const loadOn = (files, extra = {}) => loadProtection({ env: {}, platform: "linux", home: HOME, skillScripts: SCRIPTS, io: disk(files), ...extra });

// ---------- where the files are ----------

test("free-resources config: each system looks in its own place for the organization policy and the user's list", () => {
  assert.deepEqual(configPaths({ env: { ProgramData: "D:\\PD", APPDATA: "D:\\Roam" }, platform: "win32", home: "D:\\Users\\zork" }), { policy: "D:\\PD\\free-resources\\policy.json", user: "D:\\Roam\\free-resources\\protected.json" });
  assert.deepEqual(configPaths({ env: {}, platform: "win32", home: "D:\\Users\\zork" }), { policy: "C:\\ProgramData\\free-resources\\policy.json", user: "D:\\Users\\zork\\AppData\\Roaming\\free-resources\\protected.json" }, "defaults when the variables are missing");
  assert.deepEqual(configPaths({ env: {}, platform: "linux", home: HOME }), { policy: POLICY, user: USER });
  assert.equal(configPaths({ env: { XDG_CONFIG_HOME: "/cfg" }, platform: "linux", home: HOME }).user, "/cfg/free-resources/protected.json");
  assert.equal(configPaths({ env: { XDG_CONFIG_HOME: "cfg/relative" }, platform: "linux", home: HOME }).user, USER, "a relative XDG_CONFIG_HOME is ignored, as the XDG specification says");
  assert.deepEqual(configPaths({ env: {}, platform: "darwin", home: "/Users/Zork" }), { policy: "/Library/Application Support/free-resources/policy.json", user: "/Users/Zork/.config/free-resources/protected.json" });
});

// ---------- one file ----------

test("free-resources config: a file that is not there is absent, and a good file is trimmed and limited", () => {
  assert.equal(readList("/nope.json", disk({})).status, "absent");
  const many = Array.from({ length: 600 }, (_, i) => `n${i}`);
  const r = readList("/x.json", disk({ "/x.json": json({ names: ["  agent*  ", "", "   ", 7, null, "x".repeat(201), "ok", ...many], paths: ["d:/a/", {}, "d:/b/"] }) }));
  assert.equal(r.status, "ok");
  assert.equal(r.names[0], "agent*", "trimmed");
  assert.ok(!r.names.includes("") && !r.names.some((n) => typeof n !== "string") && !r.names.some((n) => n.length > 200), "empty, non-text and over-long entries are dropped");
  assert.equal(r.names.length, 500, "at most 500 entries");
  assert.deepEqual(r.paths, ["d:/a/", "d:/b/"]);
  assert.equal(r.stop_off, false);
});

test("free-resources config: a file that cannot be used is 'bad' with a reason, and never throws", () => {
  const cases = [
    ["not json", "{nope", /not valid JSON/],
    ["an array", "[1,2]", /not a JSON object/],
    ["null", "null", /not a JSON object/],
    ["text", '"hello"', /not a JSON object/],
    ["stop as text", json({ stop: "no" }), /"stop" must be true or false/],
    ["stop as number", json({ stop: 0 }), /"stop" must be true or false/],
    ["too large", json({ names: ["x".repeat(200)], pad: "y".repeat(300 * 1024) }), /larger than 256 KB/],
  ];
  for (const [label, text, reason] of cases) {
    const r = readList("/x.json", disk({ "/x.json": text }));
    assert.equal(r.status, "bad", label);
    assert.match(r.reason, reason, label);
    assert.deepEqual([r.names, r.paths], [[], []], `${label}: nothing is taken from a bad file`);
  }
  const denied = readList("/x.json", disk({ "/x.json": Object.assign(new Error("no"), { code: "EACCES" }) }));
  assert.equal(denied.status, "bad");
  assert.match(denied.reason, /could not be read \(EACCES\)/);
});

test("free-resources config: stop can be switched off and nothing else; true changes nothing", () => {
  assert.equal(readList("/x.json", disk({ "/x.json": json({ stop: false }) })).stop_off, true);
  assert.equal(readList("/x.json", disk({ "/x.json": json({ stop: true }) })).stop_off, false);
  assert.equal(readList("/x.json", disk({ "/x.json": json({}) })).stop_off, false);
});

// ---------- all lists together ----------

test("free-resources config: with no file anywhere there is nothing to add and stopping is not blocked", () => {
  const p = loadOn({});
  assert.deepEqual([p.names, p.paths, p.sources, p.warnings, p.stop_blockers], [[], [], [], [], []]);
  assert.equal(p.stop_allowed, true);
});

test("free-resources config: the lists are added together, without repeats, and the sources show counts only", () => {
  const p = loadOn({
    [POLICY]: json({ names: ["AgentX*", "vpnhelper"], paths: ["d:/corp-tools/"] }),
    [USER]: json({ names: ["agentx*", "mytool"], paths: ["D:/Corp-Tools/", "d:/mine/"] }),
    [LOCAL]: json({ names: ["VPNHELPER", "local1"] }),
  });
  assert.deepEqual(p.names, ["AgentX*", "vpnhelper", "mytool", "local1"], "first spelling kept, repeats dropped whatever the case");
  assert.deepEqual(p.paths, ["d:/corp-tools/", "d:/mine/"]);
  assert.deepEqual(p.sources, [
    { label: "organization policy", status: "ok", names: 2, paths: 1 },
    { label: "your list", status: "ok", names: 2, paths: 2 },
    { label: "the plugin folder list", status: "ok", names: 2, paths: 0 },
  ]);
  const shown = JSON.stringify([p.sources, p.warnings, p.stop_blockers]);
  for (const entry of ["agentx", "vpnhelper", "corp-tools", "mytool", "local1"]) assert.ok(!shown.toLowerCase().includes(entry), `${entry} is not in what the report shows about the lists`);
  assert.equal(p.stop_allowed, true);
});

test("free-resources config: a name and a path with the same text are kept apart", () => {
  const p = loadOn({ [USER]: json({ names: ["shared"], paths: ["shared"] }) });
  assert.deepEqual([p.names, p.paths], [["shared"], ["shared"]]);
});

test("free-resources config: 'stop': false in any list switches stopping off and says which", () => {
  for (const [file, label] of [[POLICY, "organization policy"], [USER, "your list"], [LOCAL, "the plugin folder list"]]) {
    const p = loadOn({ [file]: json({ names: ["a"], stop: false }) });
    assert.equal(p.stop_allowed, false, label);
    assert.deepEqual(p.stop_blockers, [`${label} sets "stop": false`], label);
    assert.deepEqual(p.names, ["a"], `${label}: its names still count`);
    assert.deepEqual(p.warnings, [], `${label}: choosing to switch stopping off is not a warning`);
  }
});

test("free-resources config: an unreadable list is ignored, switches stopping off, and the warning does not print the home folder", () => {
  const p = loadOn({ [POLICY]: json({ names: ["fine"] }), [USER]: "{broken" });
  assert.deepEqual(p.names, ["fine"], "the good list still counts");
  assert.equal(p.stop_allowed, false);
  assert.deepEqual(p.stop_blockers, ["your list could not be used"]);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /^your list \(.*protected\.json\) could not be used: it is not valid JSON\. It was ignored$/);
  assert.ok(!p.warnings[0].includes(HOME), "the home folder is shown as ~");
  assert.deepEqual(p.sources.find((s) => s.label === "your list"), { label: "your list", status: "bad", names: 0, paths: 0 });
});

test("free-resources config: the file named by FREE_RESOURCES_PROTECTED is read, and a missing one switches stopping off", () => {
  const ok = loadOn({ "/etc/mine.json": json({ names: ["envtool"] }) }, { env: { FREE_RESOURCES_PROTECTED: "/etc/mine.json" } });
  assert.deepEqual(ok.names, ["envtool"]);
  assert.equal(ok.stop_allowed, true);
  assert.equal(ok.sources[0].label, "the file named by FREE_RESOURCES_PROTECTED");
  const missing = loadOn({}, { env: { FREE_RESOURCES_PROTECTED: "/etc/gone.json" } });
  assert.equal(missing.stop_allowed, false);
  assert.deepEqual(missing.warnings, ["the file named by FREE_RESOURCES_PROTECTED does not exist"]);
  assert.deepEqual(missing.sources, [{ label: "the file named by FREE_RESOURCES_PROTECTED", status: "bad", names: 0, paths: 0 }]);
  const empty = loadOn({}, { env: { FREE_RESOURCES_PROTECTED: "" } });
  assert.deepEqual(empty.sources, [], "an empty variable is the same as none");
});

test("free-resources config: the committed example file is a valid list and uses made-up names", () => {
  const r = readList(join(FR, "scripts", "protected.example.json"));
  assert.equal(r.status, "ok", r.reason);
  assert.ok(r.names.length > 0 && r.paths.length > 0);
  assert.equal(r.stop_off, false, "the example does not switch anything off");
  for (const n of r.names) assert.match(n, /^example-/, `${n} is a made-up name`);
  for (const p of r.paths) assert.match(p, /example-corp/, `${p} is a made-up path`);
  assert.deepEqual(r.names.filter((n) => classifyLib.protectedCategory(n)), [], "an example name does not collide with a built-in protected name");
});

test("free-resources config: a list can only add protection; it cannot unprotect a built-in one", () => {
  const rec = (name, extra = {}) => ({ pid: 4100, ppid: 1, name, owner: "WORKGROUP\\tester", rss_mb: 300, cpu_pct: 0, exe: `D:\\Profiles\\tester\\bin\\${name}`, start_iso: "2026-10-01T00:00:00.000Z", ...extra });
  const ctx = (local) => ({ me: { user: "tester", pid: 9999 }, home: "D:\\Profiles\\tester", platform: "win32", logical_cpus: 4, now_ms: Date.parse("2026-10-30T00:00:00.000Z"), localProtected: local, projectDir: "D:\\Profiles\\tester\\proj", listening: [], pathExists: () => false });
  const bucketOf = (name, local) => classifyLib.classify([rec(name)], ctx(local)).decisions[0].bucket;
  const none = loadOn({});
  const added = loadOn({ [USER]: json({ names: ["workerd"], stop: true }) });
  assert.equal(bucketOf("workerd.exe", none), "suggest", "recognised leftover with no list");
  assert.equal(bucketOf("workerd.exe", added), "keep", "a name in a list protects it");
  const hostile = loadOn({ [USER]: json({ names: [], paths: [], unprotect: ["pwsh"], allow: ["msmpeng"], stop: true }) });
  assert.equal(bucketOf("pwsh.exe", hostile), "keep", "no field removes a built-in protection");
  assert.equal(bucketOf("msmpeng.exe", hostile), "keep");
});
