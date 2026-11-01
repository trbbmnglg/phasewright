// The protected lists a person or an organization adds, and the setting that switches stopping off.
//
// Every setting here can only ADD protection or switch stopping OFF. Nothing in any file can remove a built-in
// protection or switch anything on, so it does not matter who can write these files, or who can point an environment
// variable at one. A file that exists but cannot be read as the format below, or holds entries that cannot be used, does
// not fail open: stop_allowed is false and the reason is reported. free.mjs refuses every stop while stop_allowed is false.
//
// Where the files are (all optional, all read, the entries are added together). The organization policy and your list
// are also read at the system's own places (fixedConfigPaths), so an environment variable cannot hide either:
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
import { homedir, userInfo } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { relativizePaths } from "./text.mjs";
import { windowsDir } from "./bin.mjs";

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

// The same two lists, at the places the system itself gives, whatever the environment says: the account's profile
// folder (os.userInfo, not HOME or USERPROFILE) and the Windows folder's drive. They are read as well as the places
// above, so pointing a variable elsewhere can never hide an organization's policy or your own list.
export function fixedConfigPaths({ platform = process.platform, profile = profileOf(), env = process.env } = {}) {
  if (platform === "win32") {
    return {
      policy: win32.join(`${windowsDir(env).slice(0, 2)}\\ProgramData`, "free-resources", "policy.json"),
      // SystemRoot comes from the environment too, so the usual place is always read as well.
      policyAlso: "C:\\ProgramData\\free-resources\\policy.json",
      user: profile ? win32.join(profile, "AppData", "Roaming", "free-resources", "protected.json") : null,
    };
  }
  return {
    policy: platform === "darwin" ? "/Library/Application Support/free-resources/policy.json" : "/etc/free-resources/policy.json",
    user: profile ? posix.join(profile, ".config", "free-resources", "protected.json") : null,
  };
}

function profileOf() {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
}

// Entries are kept only when they are text, not empty after trimming, and at most MAX_ENTRY_CHARS long, at most
// MAX_ENTRIES of them. Anything else is a problem: the good entries still count, and stopping is switched off.
function clean(v, key, problems) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    problems.push(`"${key}" is not a list`);
    return [];
  }
  const out = [];
  for (const x of v) {
    const t = typeof x === "string" ? x.trim() : null;
    if (!t) problems.push(`"${key}" has an entry that is not text, or is empty`);
    else if (t.length > MAX_ENTRY_CHARS) problems.push(`"${key}" has an entry longer than ${MAX_ENTRY_CHARS} characters`);
    else out.push(t);
  }
  if (out.length > MAX_ENTRIES) problems.push(`"${key}" has more than ${MAX_ENTRIES} entries`);
  return out.slice(0, MAX_ENTRIES);
}

// One file: { status: "absent" | "ok" | "bad", names, paths, stop_off, reason, problems }. Never throws.
export function readList(file, { read = readFileSync, exists = existsSync, size = (f) => statSync(f).size } = {}) {
  const base = { names: [], paths: [], stop_off: false, reason: null, problems: [] };
  if (!exists(file)) return { status: "absent", ...base };
  try {
    if (size(file) > MAX_BYTES) return { status: "bad", ...base, reason: "it is larger than 256 KB" };
    const raw = JSON.parse(read(file, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { status: "bad", ...base, reason: "it is not a JSON object" };
    if (raw.stop !== undefined && typeof raw.stop !== "boolean") return { status: "bad", ...base, reason: '"stop" must be true or false' };
    const problems = [];
    const names = clean(raw.names, "names", problems);
    const paths = clean(raw.paths, "paths", problems);
    return { status: "ok", ...base, names, paths, stop_off: raw.stop === false, problems: [...new Set(problems)] };
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
export function loadProtection({ env = process.env, platform = process.platform, home = homedir(), profile = profileOf(), skillScripts = SCRIPTS, io = {} } = {}) {
  const { policy, user } = configPaths({ env, platform, home });
  const fixed = fixedConfigPaths({ platform, profile, env });
  const same = (a, b) => (platform === "win32" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  const places = [
    { label: "organization policy", file: policy },
    ...(fixed.policy && !same(fixed.policy, policy) ? [{ label: "organization policy (the system's own place)", file: fixed.policy }] : []),
    ...(fixed.policyAlso && !same(fixed.policyAlso, policy) && !same(fixed.policyAlso, fixed.policy) ? [{ label: "organization policy (the usual place)", file: fixed.policyAlso }] : []),
    { label: "your list", file: user },
    ...(fixed.user && !same(fixed.user, user) ? [{ label: "your list (your profile's own place)", file: fixed.user }] : []),
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
    if (r.problems.length) {
      warnings.push(`${p.label} (${relativizePaths(p.file, home)}) has entries that could not be used: ${r.problems.join("; ")}. The others were read, and stopping is switched off`);
      stop_blockers.push(`${p.label} has entries that could not be used`);
    }
    sources.push({ label: p.label, status: "ok", names: r.names.length, paths: r.paths.length });
  }
  return { names, paths, sources, warnings, stop_allowed: stop_blockers.length === 0, stop_blockers };
}
