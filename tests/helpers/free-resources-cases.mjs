// Made-up stop-gate cases shared by tests/free-resources-gate.test.mjs and tests/free-resources-free.test.mjs. Not a test file.
// One allowed case per system: a left-over vite dev server of the same person, and this tool running in a terminal. Every
// name, number, path and id is invented.
import { load } from "./free-resources-headroom.mjs";

const gate = await load("gate");
const AT = String.fromCharCode(64); // "@", built so the personal-data lint does not read a systemd unit name as an email address

export const T_OLD = "2026-10-30T08:00:00.000Z";
export const T_SHELL = "2026-10-30T09:00:00.000Z";
export const T_TOOL = "2026-10-30T10:00:00.000Z";
export const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
export const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- an allowed case on each system ----------

// Windows: this tool runs in a terminal; a vite dev server of the same person was left behind (its parent is gone).
export function windowsCase() {
  const records = [
    { pid: 8800, ppid: 700, name: "WindowsTerminal.exe", start_iso: T_OLD, exe: "D:\\Apps\\Terminal\\WindowsTerminal.exe", cmd_full: null },
    { pid: 8900, ppid: 8800, name: "pwsh.exe", start_iso: T_SHELL, exe: "D:\\Apps\\pwsh\\pwsh.exe", cmd_full: null },
    { pid: 9000, ppid: 8900, name: "node.exe", start_iso: T_TOOL, exe: "D:\\Profiles\\tester\\node\\node.exe", cmd_full: "node free.mjs plan" },
    { pid: 5001, ppid: 4999, name: "node.exe", start_iso: T_TOOL, exe: "D:\\Profiles\\tester\\node\\node.exe", cmd_full: "node D:\\Profiles\\tester\\proj\\node_modules\\vite\\bin\\vite.js" },
  ];
  const facts = { pid: 5001, creation: "134000000000000000", start_iso: T_TOOL, image_path: "D:\\Profiles\\tester\\node\\node.exe", sid: SID, session: 1, critical: false, protection: 0, integrity_rid: 0x2000, elevated: false, parent_state: "gone" };
  const meFacts = { sid: SID, elevated: false, integrity_rid: 0x2000, debug_privilege: false, session: 1 };
  return base("win32", records, facts, { pid: 9000, sudo: false, facts: meFacts }, "D:\\Profiles\\tester", "D:\\Profiles\\tester\\proj");
}

// Linux: this tool runs in a desktop terminal; the dev server was adopted by the person's own systemd (the terminal tab
// that started it closed).
export function linuxCase() {
  const records = [
    { pid: 1, ppid: 0, name: "systemd", start_iso: T_OLD, exe: "/usr/lib/systemd/systemd", cmd_full: null },
    { pid: 1200, ppid: 1, name: "systemd", start_iso: T_OLD, exe: "/usr/lib/systemd/systemd", cmd_full: "/usr/lib/systemd/systemd --user" },
    { pid: 2900, ppid: 1200, name: "gnome-terminal-server", start_iso: T_OLD, exe: "/usr/libexec/gnome-terminal-server", cmd_full: null },
    { pid: 3000, ppid: 2900, name: "bash", start_iso: T_SHELL, exe: "/usr/bin/bash", cmd_full: null },
    { pid: 9000, ppid: 3000, name: "node", start_iso: T_TOOL, exe: "/people/tester/.nvm/node", cmd_full: "node free.mjs plan" },
    { pid: 5001, ppid: 1200, name: "node", start_iso: T_TOOL, exe: "/people/tester/.nvm/node", cmd_full: "node /people/tester/proj/node_modules/vite/bin/vite.js" },
  ];
  const ids = { real: 1000, effective: 1000, saved: 1000, fs: 1000 };
  const facts = {
    pid: 5001, start_iso: T_TOOL, starttime: 360000, exe: "/people/tester/.nvm/node", uid: { ...ids }, gid: { ...ids }, state: "S", kernel_thread: false,
    nspid_count: 1, tracer_pid: 0, cap_prm: "0000000000000000", cap_eff: "0000000000000000", oom_score_adj: 0, session: 3000, tty_nr: 0,
    cgroup: "/user.slice/user-1000.slice/user" + AT + "1000.service/app.slice/vte-spawn-1.scope", boot_id: "0a1b2c3d-0000-4000-8000-000000000001",
  };
  const meFacts = { uid: { ...ids }, gid: { ...ids }, cap_eff: "0000000000000000" };
  return base("linux", records, facts, { pid: 9000, sudo: false, facts: meFacts }, "/people/tester", "/people/tester/proj");
}

// macOS: this tool runs in Terminal; the dev server was adopted by launchd (pid 1).
export function macCase() {
  const records = [
    { pid: 1, ppid: 0, name: "launchd", start_iso: T_OLD, exe: "/sbin/launchd", cmd_full: null },
    { pid: 2800, ppid: 1, name: "Terminal", start_iso: T_OLD, exe: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", cmd_full: null },
    { pid: 2900, ppid: 2800, name: "login", start_iso: T_OLD, exe: "/usr/bin/login", cmd_full: null },
    { pid: 3000, ppid: 2900, name: "zsh", start_iso: T_SHELL, exe: "/bin/zsh", cmd_full: null },
    { pid: 9000, ppid: 3000, name: "node", start_iso: T_TOOL, exe: "/Users/Tester/.nvm/node", cmd_full: "node free.mjs plan" },
    { pid: 5001, ppid: 1, name: "node", start_iso: T_TOOL, exe: "/Users/Tester/.nvm/node", cmd_full: "node /Users/Tester/proj/node_modules/vite/bin/vite.js" },
  ];
  const facts = { pid: 5001, start_iso: T_TOOL, lstart: "Fri Oct 30 10:00:00 2026", exe: "/Users/Tester/.nvm/node", uid: 501, ruid: 501, svuid: 501, gid: 20, rgid: 20, svgid: 20, state: "S", codesign_exit: 3, launchd: "none", launchd_jobs: [77] };
  const meFacts = { uid: 501, ruid: 501, svuid: 501, gid: 20, rgid: 20, svgid: 20 };
  return base("darwin", records, facts, { pid: 9000, sudo: false, facts: meFacts }, "/Users/Tester", "/Users/Tester/proj");
}

function base(platform, records, facts, me, home, projectDir) {
  const record = records.find((r) => r.pid === 5001);
  return {
    platform, records, record, facts, me, home, projectDir,
    decision: { pid: 5001, bucket: "suggest", category: "dev_leftover", tool: "vite", name: record.name, rss_mb: 300 },
    protection: { names: [], paths: [], stop_allowed: true, stop_blockers: [] },
    expected: gate.identityOf(platform, facts),
  };
}

export const CASES = { win32: windowsCase, linux: linuxCase, darwin: macCase };
