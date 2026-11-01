// The only module that can end a process. It is called by free.mjs, and only after the stop gate (lib/gate.mjs) has
// said yes for that one process, read freshly. It never decides anything itself, apart from refusing numbers that can
// never be right.
//
// Windows: taskkill.exe from System32, started by its absolute path, from System32, with no shell, for ONE process
// number: `/PID <n>` asks a windowed program to close, `/PID <n> /F` ends it at once. Never /IM, /T, /FI or /S, never
// two numbers in one call. Its text is never read (it is in the system's language); only its exit code is kept. Node's
// process.kill is never used on Windows, where it always ends the process at once.
// macOS and Linux: SIGTERM, or SIGKILL when the person said yes a second time. The caller re-reads the start time right
// before calling, so a number that went to another process in the meantime is not signalled.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { helperOptions, windowsDir } from "./bin.mjs";

export const SIGNALS = new Set(["SIGTERM", "SIGKILL"]);

// Refuses a number that is not a whole number above 2 (0 is "the whole process group" to kill(2), 1 is init or launchd,
// 2 is the kernel thread daemon on Linux), and this script's own number and its parent's.
export function assertPid(pid, { self = process.pid, parent = process.ppid } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 2) throw new RangeError(`refused: ${String(pid)} is not a process number that can be stopped`);
  if (pid === self || pid === parent) throw new RangeError("refused: that is this tool or the program that started it");
  return pid;
}

export const taskkillPath = (env = process.env) => join(windowsDir(env), "System32", "taskkill.exe");

// Windows only. Returns { code } with taskkill's exit code (0 when it did what was asked), or null when it could not run.
export function taskkill(pid, { force = false, platform = process.platform, spawnFn = spawnSync, env = process.env, self, parent } = {}) {
  if (platform !== "win32") throw new Error("taskkill is used on Windows only");
  assertPid(pid, { self, parent });
  if (typeof force !== "boolean") throw new TypeError("force must be true or false");
  const args = ["/PID", String(pid), ...(force ? ["/F"] : [])];
  const r = spawnFn(taskkillPath(env), args, { ...helperOptions({}, { platform: "win32", base: env }), encoding: "utf8", timeout: 30000 });
  return { code: Number.isInteger(r?.status) ? r.status : null };
}

// macOS and Linux only. Sends one signal to one process. Returns { ok: true } or { ok: false, code } with the error's code
// (ESRCH: it is already gone; EPERM: not allowed, which ends the attempt: no retry, no other method).
export function signal(pid, sig, { platform = process.platform, killFn = (p, s) => process.kill(p, s), self, parent } = {}) {
  if (platform === "win32") throw new Error("signals are not used on Windows");
  assertPid(pid, { self, parent });
  if (!SIGNALS.has(sig)) throw new RangeError(`refused: ${String(sig)} is not a signal this tool sends`);
  try {
    killFn(pid, sig);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: typeof e?.code === "string" ? e.code : "ERROR" };
  }
}
