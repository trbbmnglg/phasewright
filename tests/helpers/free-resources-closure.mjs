// Shared by the free-resources guard tests. Not a test file (no .test.mjs).
// closure(entries) returns every script the entries can reach through static imports and re-exports, so a guard reads the
// code that can actually run instead of a hand-written list that new modules slip past.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { FR } from "./free-resources-headroom.mjs";

export const SCRIPTS = join(FR, "scripts");
const REF = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

// Path of a script relative to scripts/, always with forward slashes ("lib/report.mjs").
export const rel = (file) => relative(SCRIPTS, file).split(sep).join("/");

export function allScripts(dir = SCRIPTS) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allScripts(join(dir, e.name)) : e.name.endsWith(".mjs") ? [join(dir, e.name)] : []));
}

// { files: Set of absolute paths, bare: [{ file, spec }] }  bare = imports that are not relative paths (node: built-ins, packages)
export function closure(entries) {
  const files = new Set();
  const bare = [];
  const visit = (file) => {
    if (files.has(file)) return;
    if (!existsSync(file)) throw new Error(`an import points at a file that is not there: ${rel(file)}`);
    files.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(REF)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith("./") || spec.startsWith("../")) visit(resolve(dirname(file), spec));
      else bare.push({ file: rel(file), spec });
    }
  };
  for (const e of entries) visit(join(SCRIPTS, ...posix.normalize(e).split("/")));
  return { files, bare };
}
