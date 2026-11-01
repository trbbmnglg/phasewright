// Text helpers shared by every collector: masking secrets in command lines, shortening profile paths, and the
// one-line summary of a command. Pure functions, no I/O. snapshot.mjs re-exports them, so older imports keep working.
import { homedir } from "node:os";

const SECRET_FLAG = /(--?[\w-]*(?:token|password|passwd|secret|key))(=|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_ASSIGN = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)=)("[^"]*"|'[^']*'|[^\s&]+)/gi;
const BEARER = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi;

// Masks the values of secret-looking flags and assignments. Used on every command line before
// anything is stored, so a secret never reaches the report, the JSON or a test failure message.
export function maskSecrets(text) {
  if (!text) return text;
  return text.replace(SECRET_FLAG, "$1$2***").replace(SECRET_ASSIGN, "$1***").replace(BEARER, "$1***");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Shows paths inside the user's profile folder as ~ so a report can be shared without the account name.
export function relativizePaths(text, home = homedir()) {
  if (!text || !home) return text;
  const variants = new Set([home, home.split("\\").join("/"), home.split("/").join("\\")]);
  let out = text;
  for (const v of variants) out = out.replace(new RegExp(escapeRe(v), "gi"), "~");
  return out;
}

export function baseName(p) {
  return p ? p.split(/[\\/]/).pop() : p;
}

// The executable name plus its arguments, masked, profile paths relative, cut to 120 characters.
export function summarizeCmd(cmd, { name = "", exe = "", home = homedir(), max = 120 } = {}) {
  if (!cmd || !cmd.trim()) return name || baseName(exe) || "";
  let rest;
  let head;
  const c = cmd.trim();
  if (exe && c.toLowerCase().startsWith(exe.toLowerCase())) {
    head = baseName(exe);
    rest = c.slice(exe.length);
  } else if (exe && c.toLowerCase().startsWith(`"${exe.toLowerCase()}"`)) {
    head = baseName(exe);
    rest = c.slice(exe.length + 2);
  } else if (c.startsWith('"') && c.indexOf('"', 1) > 0) {
    const end = c.indexOf('"', 1);
    head = baseName(c.slice(1, end));
    rest = c.slice(end + 1);
  } else {
    const m = c.match(/^(\S+)([\s\S]*)$/);
    head = baseName(m[1]);
    rest = m[2];
  }
  const text = relativizePaths(maskSecrets(`${head}${rest}`.replace(/\s+/g, " ").trim()), home);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
