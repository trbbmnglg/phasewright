// The scripts treat the current folder as the user's project. If that folder is the skill's own folder
// (or inside it), the scan and the measured command would be about the wrong place, so the three CLIs
// print one warning on stderr. It only warns: it never stops the run.
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/lib/skilldir.mjs -> the skill folder is two levels up.
export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function insideSkillDir(cwd = process.cwd(), skillDir = SKILL_DIR) {
  const rel = relative(resolve(skillDir), resolve(cwd));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export const SKILL_DIR_WARNING =
  "free-resources: warning: the current folder is inside this skill's own folder, and it is used as your project. " +
  "Run the script from your project folder, by its full path.";

export function warnIfInsideSkillDir(cwd = process.cwd()) {
  if (insideSkillDir(cwd)) console.error(SKILL_DIR_WARNING);
}
