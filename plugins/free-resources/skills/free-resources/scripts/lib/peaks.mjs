// The peaks store: one JSON line per measured run, in a folder that belongs to this skill (not to any
// other tool). Append-only. Read-only towards processes: it only reads and writes its own file.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { maskSecrets, relativizePaths, baseName } from "./snapshot.mjs";
import { PEAKS_WINDOW } from "./rules.mjs";

export const PEAKS_FILE = "peaks.jsonl";
export const PEAK_SCHEMA_VERSION = 1;

// FREE_RESOURCES_DATA wins. Otherwise %LOCALAPPDATA%\free-resources on Windows and
// ~/.local/state/free-resources elsewhere.
export function dataDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.FREE_RESOURCES_DATA) return env.FREE_RESOURCES_DATA;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "free-resources");
  return join(home, ".local", "state", "free-resources");
}

export const peaksFile = (opts) => join(dataDir(opts), PEAKS_FILE);

const mask = (text, home) => relativizePaths(maskSecrets(String(text ?? "")), home);

// The command as stored: secrets masked and profile paths relative, cut to 200 characters. Never the raw line.
export function summarizeCommand(argv, { home = homedir(), max = 200 } = {}) {
  const text = mask(argv.join(" ").replace(/\s+/g, " ").trim(), home);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

// --task name if given, else the first two words of the command plus the project folder name:
// `npm test @ zork`.
export function taskKey({ task = null, argv = [], project = process.cwd(), home = homedir() } = {}) {
  if (task && task.trim()) return mask(task.trim(), home);
  const words = argv.join(" ").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
  const folder = baseName(String(project).replace(/[\\/]+$/, "")) || String(project);
  return mask(`${words || "(no command)"} @ ${folder}`, home);
}

// True when `path` is `folder` or inside it (both resolved, compared case-insensitively on Windows). The path
// rules follow `platform` (Windows paths use \ and drive letters, others use /), not the machine running this.
export function isInside(path, folder, platform = process.platform) {
  const rules = platform === "win32" ? win32 : posix;
  const norm = (p) => (platform === "win32" ? rules.resolve(p).toLowerCase() : rules.resolve(p));
  const rel = rules.relative(norm(folder), norm(path));
  return rel === "" || (!rel.startsWith("..") && !rules.isAbsolute(rel));
}

// Opens the store for appending without following a link. A repository being measured, or an environment
// variable it sets, could otherwise point the store at another file of yours (a link, or a second hard link
// to it), and the record would be appended there. Anything that is not a plain file with one name is refused.
function openStore(file) {
  let st = null;
  try {
    st = lstatSync(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (st && (!st.isFile() || st.nlink > 1)) throw new Error(`${PEAKS_FILE} is not a plain file (a link or a second name for another file), so nothing was written`);
  // O_NOFOLLOW is not available on Windows; there the lstat check above is the guard.
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  return openSync(file, flags, 0o600);
}

// Adds one record. The command summary is masked again here, so a caller that forgot cannot store a secret.
// opts.project: the folder being measured. The store is never written inside it (a repository could ship a link
// there, or set FREE_RESOURCES_DATA to point into itself).
export function appendPeak(record, opts = {}) {
  const dir = dataDir(opts);
  if (opts.project && isInside(dir, opts.project, opts.platform)) throw new Error("the data folder is inside the project folder, so nothing was written; set FREE_RESOURCES_DATA to a folder outside it");
  mkdirSync(dir, { recursive: true });
  const safe = { schema_version: PEAK_SCHEMA_VERSION, ...record, cmd_summary: mask(record.cmd_summary, opts.home ?? homedir()), key: mask(record.key, opts.home ?? homedir()) };
  const file = join(dir, PEAKS_FILE);
  const fd = openStore(file);
  try {
    writeSync(fd, `${JSON.stringify(safe)}\n`, null, "utf8");
  } finally {
    closeSync(fd);
  }
  return file;
}

// The last n records for a key, oldest first. A missing file is an empty list and a corrupt line is skipped.
export function readLast(key, n = PEAKS_WINDOW, opts = {}) {
  const file = peaksFile(opts);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec && typeof rec === "object" && rec.key === key) out.push(rec);
  }
  return out.slice(-n);
}
