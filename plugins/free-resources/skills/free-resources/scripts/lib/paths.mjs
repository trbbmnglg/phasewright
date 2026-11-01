// The path policy: what counts as a system location, what is a place the user can write, and what a path on a
// command line refers to. One module, so the classifier (and later the stop gate) decide the same way. Pure
// functions on strings, no file system access. Paths are first brought into one form: forward slashes, no \\?\
// prefix, no " (deleted)" suffix (Linux adds that after a package upgrade replaces a running program), NFC.
import { SYSTEM_PATHS_WIN, SYSTEM_PATHS_MAC, SYSTEM_PATHS_LINUX } from "./rules.mjs";

// "\\?\C:\x" and "\\?\UNC\server\share" are the long forms of C:\x and \\server\share.
export function normalizePath(p) {
  let s = String(p ?? "").normalize("NFC").trim();
  s = s.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\[?.]\\/, "");
  s = s.replace(/ \(deleted\)$/, "");
  return s.split("\\").join("/");
}

// Windows places that are system or shared by every user. 8.3 forms (PROGRA~1) name the same folders.
// A device path (\Device\HarddiskVolume3\...) or a share (\\server\...) is a place nothing here can vouch for, so it counts too.
const WIN_EXTRA = [/^[a-z]:\/progra~\d+\//i, /^[a-z]:\/program files \(arm\)\//i, /^[a-z]:\/windows\//i, /^\/device\//i, /^\/\//];

export function isSystemPath(exe, platform) {
  if (!exe) return false;
  const raw = String(exe);
  const p = normalizePath(raw);
  if (platform === "darwin") return SYSTEM_PATHS_MAC.some((re) => re.test(p));
  if (platform === "linux") return SYSTEM_PATHS_LINUX.some((re) => re.test(p));
  return [...SYSTEM_PATHS_WIN, ...WIN_EXTRA].some((re) => re.test(raw) || re.test(p));
}

const lower = (p) => normalizePath(p).toLowerCase();

// A place the user can write without special rights: the profile folder and the temporary folders.
export function isUserWritable(exe, home, platform) {
  if (!exe) return false;
  const e = lower(exe);
  const h = lower(home);
  if (h && e.startsWith(h.endsWith("/") ? h : `${h}/`)) return true;
  if (platform === "darwin") return e.startsWith("/tmp/") || e.startsWith("/private/var/folders/");
  if (platform === "linux") return e.startsWith("/tmp/") || e.startsWith("/var/tmp/") || e.startsWith("/dev/shm/");
  return /\/appdata\/local\/temp\//.test(e);
}

// True when a command-line token is an absolute path for this platform.
export function isAbsolutePath(token, platform) {
  const t = String(token ?? "");
  return platform === "darwin" || platform === "linux" ? /^\/[^/]/.test(t) : /^[A-Za-z]:[\\/]/.test(t);
}

// True when `path` is `folder` or inside it, in the normalized, case-folded form.
export function isUnder(path, folder) {
  const p = lower(path).replace(/\/+$/, "");
  const f = lower(folder).replace(/\/+$/, "");
  return !!f && (p === f || p.startsWith(`${f}/`));
}
