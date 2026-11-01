// The protected lists a person or an organization adds, and the setting that switches stopping off.
//
// Every setting here can only ADD protection or switch stopping OFF. Nothing in any file can remove a built-in
// protection or switch anything on, so it does not matter who can write these files, or who can point an environment
// variable at one. A file that exists but cannot be read as the format below does not fail open: stop_allowed is false
// and the reason is reported. This version only reports and ends nothing; the setting is read now so a policy file
// written today keeps its meaning if a later version can stop processes.
//
// Where the files are (all optional, all read, the entries are added together):
//   organization policy   Windows  %ProgramData%\free-resources\policy.json
//                         macOS    /Library/Application Support/free-resources/policy.json
//                         Linux    /etc/free-resources/policy.json
//   your list             Windows  %APPDATA%\free-resources\protected.json
//                         macOS and Linux  $XDG_CONFIG_HOME/free-resources/protected.json, else ~/.config/free-resources/protected.json
//   FREE_RESOURCES_PROTECTED   a file named by this variable (a missing file switches stopping off)
//   the plugin's own folder  scripts/protected.local.json (the older location; never published)
//
// Format: { "names": ["agent*", "vpnhelper"], "paths": ["d:/corp-tools/"], "stop": false }. names may end in * as a
// wildcard; paths match anywhere in the program's path or command line. "stop" can only be false.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { relativizePaths } from "./text.mjs";

const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 500;
const MAX_ENTRY_CHARS = 200;
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");

export function configPaths({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (platform === "win32") {
    return {
      policy: win32.join(env.ProgramData || "C:\\ProgramData", "free-resources", "policy.json"),
      user: win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "free-resources", "protected.json"),
    };
  }
  const configHome = env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : posix.join(home, ".config");
  return {
    policy: platform === "darwin" ? "/Library/Application Support/free-resources/policy.json" : "/etc/free-resources/policy.json",
    user: posix.join(configHome, "free-resources", "protected.json"),
  };
}

const clean = (v) =>
  (Array.isArray(v) ? v : [])
    .filter((x) => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x && x.length <= MAX_ENTRY_CHARS)
    .slice(0, MAX_ENTRIES);

// One file: { status: "absent" | "ok" | "bad", names, paths, stop_off, reason }. Never throws.
export function readList(file, { read = readFileSync, exists = existsSync, size = (f) => statSync(f).size } = {}) {
  const base = { names: [], paths: [], stop_off: false, reason: null };
  if (!exists(file)) return { status: "absent", ...base };
  try {
    if (size(file) > MAX_BYTES) return { status: "bad", ...base, reason: "it is larger than 256 KB" };
    const raw = JSON.parse(read(file, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { status: "bad", ...base, reason: "it is not a JSON object" };
    if (raw.stop !== undefined && typeof raw.stop !== "boolean") return { status: "bad", ...base, reason: '"stop" must be true or false' };
    return { status: "ok", ...base, names: clean(raw.names), paths: clean(raw.paths), stop_off: raw.stop === false };
  } catch (e) {
    return { status: "bad", ...base, reason: e instanceof SyntaxError ? "it is not valid JSON" : `it could not be read (${e.code ?? "error"})` };
  }
}

// All lists together. Result:
//   names, paths   the merged entries, ready for the classifier
//   sources        [{ label, status, names, paths }] one per place looked at; counts only, never the entries
//   warnings       what went wrong, in words
//   stop_allowed   false when any list is unreadable, or any list says "stop": false
//   stop_blockers  why stop_allowed is false, one line each
export function loadProtection({ env = process.env, platform = process.platform, home = homedir(), skillScripts = SCRIPTS, io = {} } = {}) {
  const { policy, user } = configPaths({ env, platform, home });
  const places = [
    { label: "organization policy", file: policy },
    { label: "your list", file: user },
  ];
  const named = env.FREE_RESOURCES_PROTECTED;
  if (named) places.push({ label: "the file named by FREE_RESOURCES_PROTECTED", file: named, required: true });
  places.push({ label: "the plugin folder list", file: join(skillScripts, "protected.local.json") });

  const names = [];
  const paths = [];
  const sources = [];
  const warnings = [];
  const stop_blockers = [];
  const seenNames = new Set();
  const seenPaths = new Set();
  const add = (list, seen, v) => {
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      list.push(v);
    }
  };
  for (const p of places) {
    const r = readList(p.file, io);
    if (r.status === "absent" && p.required) {
      warnings.push(`${p.label} does not exist`);
      stop_blockers.push(`${p.label} does not exist`);
      sources.push({ label: p.label, status: "bad", names: 0, paths: 0 });
      continue;
    }
    if (r.status === "absent") continue;
    if (r.status === "bad") {
      warnings.push(`${p.label} (${relativizePaths(p.file, home)}) could not be used: ${r.reason}. It was ignored`);
      stop_blockers.push(`${p.label} could not be used`);
      sources.push({ label: p.label, status: "bad", names: 0, paths: 0 });
      continue;
    }
    for (const n of r.names) add(names, seenNames, n);
    for (const x of r.paths) add(paths, seenPaths, x);
    if (r.stop_off) stop_blockers.push(`${p.label} sets "stop": false`);
    sources.push({ label: p.label, status: "ok", names: r.names.length, paths: r.paths.length });
  }
  return { names, paths, sources, warnings, stop_allowed: stop_blockers.length === 0, stop_blockers };
}
