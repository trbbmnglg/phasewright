// The long, canonical form of a Windows path. Windows can name the same file or folder in more than one way: a short
// 8.3 form (a profile folder TESTER~1.JR) next to the long one (tester.long.name), or a link. The temporary
// folder is often given in the short form, so a dev server started from it would not look like it is in the home folder.
// Read-only: realpath asks Windows for the file's final name through a handle opened for that; nothing is written. A
// share or device path (\\server\..., \\?\..., \\.\...) is never opened, because opening one can make Windows sign in to
// another machine with your account. On macOS and Linux paths are compared as they are.
import { realpathSync } from "node:fs";

// A path on a local drive letter ("C:\..." or "C:/..."), and nothing else.
export const isLocalDrivePath = (p) => typeof p === "string" && /^[A-Za-z]:[\\/]/.test(p) && !p.includes("\0");

// The canonical long path, or null when it is not a local path or cannot be resolved (it does not exist, or access is
// denied).
export function canonicalWindowsPath(p, { realpath = realpathSync.native } = {}) {
  if (!isLocalDrivePath(p)) return null;
  try {
    const r = String(realpath(p)).replace(/^\\\\\?\\/, "");
    return isLocalDrivePath(r) ? r : null;
  } catch {
    return null;
  }
}

// For the classifier and the stop gate: a function that gives a path's canonical form on this platform, or the path as
// it was when there is none.
export function canonicalPathFor(platform, opts = {}) {
  if (platform !== "win32") return (p) => p;
  return (p) => canonicalWindowsPath(p, opts) ?? p;
}
