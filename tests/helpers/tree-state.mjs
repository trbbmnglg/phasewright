// Shared helpers of tests/tree-state.test.mjs and tests/tree-state-process.test.mjs. Not a test file (no .test.mjs). Temp folders and temp git repos are
// made under the OS temp folder and removed after each test file's run.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../plugins/phased-shipping/skills/run/scripts/tree-state.mjs";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCRIPT = join(HERE, "..", "plugins", "phased-shipping", "skills", "run", "scripts", "tree-state.mjs");
export const made = [];
export const scratch = () => { const d = mkdtempSync(join(tmpdir(), "tree-state-test-")); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
export const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
};
export const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Tester", "-c", "user.email=tester@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, env: cleanEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export function makeRepo() {
  const dir = scratch();
  git(dir, "init", "-q");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  writeFileSync(join(dir, "sub", "b.txt"), "beta\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}
export const PLAN = [
  "# Phase 1: sample",
  "",
  "## Commands",
  "- **Full verify** (baseline and final compare): `npm run verify`",
  "- **Fast verify** (after the build and each fix round): `npm run lint`",
  "- Deploy, in order: `git push origin main`",
  "- Rollback (required before deploy): `git revert --no-edit HEAD`",
  "",
  "## Risks",
  "- slow",
  "",
].join("\n");
export const writePlan = (dir, text, name = "plan.md") => { const p = join(dir, name); writeFileSync(p, text); return p; };
