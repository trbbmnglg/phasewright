// The peaks store: one JSON line per measured run, in a folder that belongs to this skill (not to any
// other tool). Append-only. Read-only towards processes: it only reads and writes its own file.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
// `npm test @ phasewright`.
export function taskKey({ task = null, argv = [], project = process.cwd(), home = homedir() } = {}) {
  if (task && task.trim()) return mask(task.trim(), home);
  const words = argv.join(" ").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
  const folder = baseName(String(project).replace(/[\\/]+$/, "")) || String(project);
  return mask(`${words || "(no command)"} @ ${folder}`, home);
}

// Adds one record. The command summary is masked again here, so a caller that forgot cannot store a secret.
export function appendPeak(record, opts = {}) {
  const dir = dataDir(opts);
  mkdirSync(dir, { recursive: true });
  const safe = { schema_version: PEAK_SCHEMA_VERSION, ...record, cmd_summary: mask(record.cmd_summary, opts.home ?? homedir()), key: mask(record.key, opts.home ?? homedir()) };
  appendFileSync(join(dir, PEAKS_FILE), `${JSON.stringify(safe)}\n`, "utf8");
  return join(dir, PEAKS_FILE);
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
