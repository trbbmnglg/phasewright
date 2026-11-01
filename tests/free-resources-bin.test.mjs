// Run with: node --test tests/free-resources-bin.test.mjs
// The free-resources helpers are started by absolute path from a fixed folder (scripts/lib/bin.mjs), so a
// repository that contains a file named like a helper, or a changed PATH or PSModulePath, cannot supply a
// different program; and the peaks store is never written through a link or inside the project.
// Every value here is synthetic. Nothing in this file starts a helper program.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FR, load, tmp } from "./helpers/free-resources-headroom.mjs";

const bins = await load("bin");
const powershell = await load("powershell");
const peaksLib = await load("peaks");
const SCRIPTS = join(FR, "scripts");

// Every .mjs file of the skill, so a new file is covered without editing this test.
const scriptFiles = (dir = SCRIPTS) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scriptFiles(join(dir, e.name)) : e.name.endsWith(".mjs") ? [join(dir, e.name)] : []));

test("free-resources bin: SystemRoot is used only when it looks like X:\\Windows", () => {
  assert.equal(bins.windowsDir({ SystemRoot: "D:\\Windows" }), "D:\\Windows");
  assert.equal(bins.windowsDir({ SYSTEMROOT: "c:\\windows" }), "c:\\windows");
  for (const bad of ["D:\\zork", "C:\\Windows\\..\\zork", "\\\\server\\share\\Windows", "Windows", "C:\\Windows\\", "", undefined]) {
    assert.equal(bins.windowsDir({ SystemRoot: bad }), "C:\\Windows", String(bad));
  }
});

test("free-resources bin: helpers resolve to fixed absolute paths, never through PATH", () => {
  const all = () => true;
  const env = { SystemRoot: "C:\\Windows", PATH: "C:\\zork\\bin" };
  assert.equal(bins.bin("powershell", { platform: "win32", env, exists: all }), join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.equal(bins.bin("typeperf", { platform: "win32", env, exists: all }), join("C:\\Windows", "System32", "typeperf.exe"));
  assert.equal(bins.bin("netstat", { platform: "win32", env, exists: all }), join("C:\\Windows", "System32", "netstat.exe"));
  assert.equal(bins.bin("cmd", { platform: "win32", env, exists: all }), join("C:\\Windows", "System32", "cmd.exe"));
  assert.equal(bins.bin("ps", { platform: "darwin", exists: all }), "/bin/ps");
  assert.equal(bins.bin("lsof", { platform: "darwin", exists: all }), "/usr/sbin/lsof");
  // Linux: the first fixed candidate that exists
  assert.equal(bins.bin("ps", { platform: "linux", exists: (p) => p === "/bin/ps" }), "/bin/ps");
  // missing, or not a helper of this platform: null, so callers treat it as not readable
  assert.equal(bins.bin("typeperf", { platform: "win32", env, exists: () => false }), null);
  assert.equal(bins.bin("typeperf", { platform: "darwin", exists: all }), null);
  assert.equal(bins.bin("ps", { platform: "freebsd", exists: all }), null);
  // a name outside the table is a programming error
  assert.throws(() => bins.bin("zorkctl", { platform: "win32", exists: all }), /unknown helper/);
});

test("free-resources bin: helpers start from a fixed folder with no shell; Windows drops other spellings of a variable it sets", () => {
  const win = bins.helperOptions({ PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules" }, {
    platform: "win32",
    base: { SystemRoot: "C:\\Windows", PSMODULEPATH: "C:\\zork\\modules", psmodulepath: "C:\\zork\\more", Path: "C:\\Windows\\System32" },
  });
  assert.equal(win.cwd, join("C:\\Windows", "System32"));
  assert.equal(win.shell, false);
  assert.equal(win.windowsHide, true);
  const spellings = Object.keys(win.env).filter((k) => k.toUpperCase() === "PSMODULEPATH");
  assert.deepEqual(spellings, ["PSModulePath"], "only the value this file sets is passed on");
  assert.equal(win.env.Path, "C:\\Windows\\System32");
  const posix = bins.helperOptions({}, { platform: "linux", base: { LANG: "zork_ZZ.UTF-8", HOME: "/srv/zork" } });
  assert.equal(posix.cwd, "/");
  assert.equal(posix.shell, false);
  assert.equal(posix.env.LC_ALL, "C");
  assert.equal(posix.env.LANG, "C");
  assert.equal(posix.env.HOME, "/srv/zork");
});

test("free-resources bin: PowerShell runs from the Windows folder with only its own module folder", async () => {
  const calls = [];
  const exec = (file, args, options, cb) => { calls.push({ file, args, options }); cb(null, "[]", ""); };
  const out = await powershell.runPowerShell("procs", { FR_AT: "5" }, { exec, path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" });
  assert.deepEqual(out, []);
  const [call] = calls;
  assert.equal(call.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(call.options.cwd, /[\\/]System32$/i);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.env.FR_MODE, "procs");
  assert.equal(call.options.env.FR_AT, "5");
  assert.equal(call.options.env.PSModulePath, bins.powershellModulePath());
  // PowerShell missing from the Windows folder: refused before anything starts
  const none = [];
  await assert.rejects(powershell.runPowerShell("procs", {}, { exec: (...a) => none.push(a), path: null }), /not found in the Windows folder/);
  assert.equal(none.length, 0);
  // the persistent tree loop takes the same path and options
  const spawned = [];
  const spawnFn = (file, args, options) => { spawned.push({ file, args, options }); return {}; };
  powershell.startTreeLoop({ rootPid: 1234, intervalMs: 2000, spawnFn, path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" });
  assert.equal(spawned[0].file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(spawned[0].options.env.FR_MODE, "tree");
  assert.equal(spawned[0].options.env.PSModulePath, bins.powershellModulePath());
  assert.throws(() => powershell.startTreeLoop({ rootPid: 1234, intervalMs: 2000, spawnFn, path: null }), /not found in the Windows folder/);
});

test("free-resources bin: no script starts a program by a bare name, through a shell flag, or through ComSpec", () => {
  const files = scriptFiles();
  assert.ok(files.length >= 10, `${files.length} script files`);
  const known = new Set(Object.values(bins.HELPERS).flat());
  for (const file of files) {
    // code only: whole-line comments may explain what is avoided
    const text = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
    const where = file.slice(SCRIPTS.length + 1);
    // a child-process call whose first argument is a quoted program name
    assert.doesNotMatch(text, /\b(?:execFile|execFileSync|spawn|spawnSync|spawnFn|exec|execSync)\(\s*["'`]/, `${where}: starts a program by a quoted name`);
    assert.doesNotMatch(text, /shell:\s*true/, `${where}: uses shell: true`);
    assert.doesNotMatch(text, /ComSpec/i, `${where}: uses ComSpec`);
    // every run("name") or runFn("name") asks for a helper from the table
    for (const m of text.matchAll(/\brun(?:Fn)?\(\s*["'`]([^"'`]+)["'`]/g)) assert.ok(known.has(m[1]), `${where}: run("${m[1]}") is not in the helper table`);
  }
});

test("free-resources bin: the peaks store is never written inside the project folder", () => {
  const project = tmp();
  const inside = join(project, ".data");
  const rec = { key: "k", cmd_summary: "npm test" };
  assert.throws(() => peaksLib.appendPeak(rec, { env: { FREE_RESOURCES_DATA: inside }, project }), /inside the project folder/);
  assert.equal(existsSync(join(inside, peaksLib.PEAKS_FILE)), false);
  assert.throws(() => peaksLib.appendPeak(rec, { env: { FREE_RESOURCES_DATA: project }, project }), /inside the project folder/);
  // outside the project it is written as before
  const outside = tmp();
  const file = peaksLib.appendPeak(rec, { env: { FREE_RESOURCES_DATA: outside }, project });
  assert.equal(JSON.parse(readFileSync(file, "utf8").trim()).key, "k");
  assert.equal(peaksLib.isInside("C:\\Zork\\Project\\data", "c:\\zork\\project", "win32"), true);
  assert.equal(peaksLib.isInside("C:\\Zork\\Project-other", "C:\\Zork\\Project", "win32"), false);
  assert.equal(peaksLib.isInside("/srv/zork/project/data", "/srv/zork/project", "linux"), true);
  assert.equal(peaksLib.isInside("/srv/zork/project2", "/srv/zork/project", "linux"), false);
});

test("free-resources bin: the peaks store refuses a second name for another file and leaves that file alone", () => {
  const dir = tmp();
  const target = join(tmp(), "keep.txt");
  writeFileSync(target, "original\n");
  // a hard link needs no special rights on NTFS or on Linux and macOS file systems
  linkSync(target, join(dir, peaksLib.PEAKS_FILE));
  assert.throws(() => peaksLib.appendPeak({ key: "k", cmd_summary: "x" }, { env: { FREE_RESOURCES_DATA: dir } }), /not a plain file/);
  assert.equal(readFileSync(target, "utf8"), "original\n");
});

test("free-resources bin: the peaks store refuses a link and leaves its target alone", (t) => {
  const dir = tmp();
  const target = join(tmp(), "keep.txt");
  writeFileSync(target, "original\n");
  try {
    symlinkSync(target, join(dir, peaksLib.PEAKS_FILE));
  } catch {
    t.skip("this system does not allow symbolic links");
    return;
  }
  assert.throws(() => peaksLib.appendPeak({ key: "k", cmd_summary: "x" }, { env: { FREE_RESOURCES_DATA: dir } }), /not a plain file/);
  assert.equal(readFileSync(target, "utf8"), "original\n");
  mkdirSync(join(dir, "sub"));
});

test("free-resources bin: the plugin is at 0.1.2, and the README and wiki say what changed", () => {
  const plugin = JSON.parse(readFileSync(join(FR, "..", "..", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.version, "0.1.2");
  const readme = readFileSync(join(FR, "..", "..", "README.md"), "utf8");
  assert.ok(readme.includes("Every program above is started from its absolute path"), "README: absolute paths");
  assert.ok(readme.includes("Before 0.1.2 the programs were started by name"), "README: what changed");
  assert.ok(readme.includes("so a repository cannot point the record at another file of yours"), "README: the store refusals");
  const wiki = readFileSync(join(FR, "..", "..", "..", "..", "docs", "wiki", "Free-resources.md"), "utf8");
  assert.ok(wiki.includes("The current plugin version is 0.1.2"), "wiki: current version");
  assert.ok(wiki.includes("Plugin version 0.1.2 is on main"), "wiki: what shipped when");
});
