// Every helper program the scripts start, by absolute path. On Windows a bare program name is looked up in
// the current folder before PATH, and the scripts run from the user's project folder, so a repository that
// contains a file named like a helper would have it run. A changed PATH has the same effect elsewhere.
// Nothing here starts anything; it only says where the real helper is and how to start it safely.
import { existsSync } from "node:fs";
import { join } from "node:path";

// The Windows folder. SystemRoot is used only when it looks like X:\Windows; anything else (another folder,
// a share, a relative path) falls back to C:\Windows, so the environment cannot point the helpers elsewhere.
export function windowsDir(env = process.env) {
  const value = env.SystemRoot ?? env.SYSTEMROOT ?? "";
  return /^[A-Za-z]:\\Windows$/i.test(value) ? value : "C:\\Windows";
}

// Where each helper lives, below the Windows folder on Windows and as fixed candidates elsewhere (the first
// one that exists is used; there is no PATH lookup).
const WINDOWS = {
  powershell: ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
  typeperf: ["System32", "typeperf.exe"],
  netstat: ["System32", "netstat.exe"],
  cmd: ["System32", "cmd.exe"],
};
const POSIX = {
  darwin: {
    ps: ["/bin/ps"],
    lsof: ["/usr/sbin/lsof"],
    sysctl: ["/usr/sbin/sysctl"],
    memory_pressure: ["/usr/bin/memory_pressure"],
    top: ["/usr/bin/top"],
    vm_stat: ["/usr/bin/vm_stat"],
    // Only free.mjs: checks whether a program is signed by Apple, so no part of macOS is ever stopped, and lists the jobs
    // launchd runs for you (its "list" command, which only reads), so a job it keeps running is never taken for a left-over.
    codesign: ["/usr/bin/codesign"],
    launchctl: ["/bin/launchctl"],
  },
  // The Linux process table is read from /proc, so only the tick rate comes from a helper.
  linux: {
    getconf: ["/usr/bin/getconf", "/bin/getconf"],
  },
};

// The names the scripts may ask for, per platform (tests check every call site against this).
export const HELPERS = { win32: Object.keys(WINDOWS), ...Object.fromEntries(Object.entries(POSIX).map(([p, t]) => [p, Object.keys(t)])) };

// The absolute path of a helper, or null when this platform has no such helper or it is missing.
// An unknown name is a programming error, so it throws instead of quietly returning null.
export function bin(name, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const known = new Set(Object.values(HELPERS).flat());
  if (!known.has(name)) throw new Error(`unknown helper ${name}`);
  if (platform === "win32") {
    const parts = WINDOWS[name];
    if (!parts) return null;
    const path = join(windowsDir(env), ...parts);
    return exists(path) ? path : null;
  }
  for (const candidate of POSIX[platform]?.[name] ?? []) if (exists(candidate)) return candidate;
  return null;
}

// Options every helper is started with: a fixed working folder (never the project), no shell, a hidden window
// on Windows, and the C locale elsewhere so dates and numbers come out in one format whatever the user's
// language. `env` adds to the environment the helper gets.
// On Windows environment names are case-insensitive and Node passes only the first spelling in sorted order,
// so an inherited variant (PSMODULEPATH beside PSModulePath) is dropped before a value is set.
export function helperOptions(env = {}, { platform = process.platform, base = process.env } = {}) {
  if (platform === "win32") {
    const replaced = new Set(Object.keys(env).map((k) => k.toUpperCase()));
    const kept = Object.fromEntries(Object.entries(base).filter(([k]) => !replaced.has(k.toUpperCase())));
    return { cwd: join(windowsDir(base), "System32"), windowsHide: true, shell: false, env: { ...kept, ...env } };
  }
  return { cwd: "/", shell: false, env: { ...base, ...env, LC_ALL: "C", LANG: "C" } };
}

// Windows PowerShell's own module folder. The scripts' PowerShell gets only this one, so a module folder
// added to PSModulePath (for example by a repository's settings) cannot replace the commands it uses.
export function powershellModulePath(env = process.env) {
  return join(windowsDir(env), "System32", "WindowsPowerShell", "v1.0", "Modules");
}
