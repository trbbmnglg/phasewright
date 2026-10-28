// Shared helpers of tests/plugin-split.test.mjs and tests/plugin-split-guard.test.mjs. Not a test file (no .test.mjs). Temp folders are made under the OS temp
// folder and removed after each test file's run; the personal sync is always run against a temp home, never the real ~/.claude.
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = join(HERE, "..");
// Each test removes what it made; the after hook removes whatever a failing or careless test leaves behind.
export const scratch = [];
export const tmp = (label) => { const d = mkdtempSync(join(tmpdir(), `${label}-`)); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// ---------- personal sync, against a temp home ----------

export const SYNC = join(REPO, "scripts", "sync-personal.mjs");
export const sync = (home, ...args) => spawnSync(process.execPath, [SYNC, ...args], { encoding: "utf8", env: { ...process.env, SYNC_PERSONAL_CLAUDE_HOME: home } });
export const marker = (name) => `<!-- Generated from the ${name} plugin by scripts/sync-personal.mjs. Edit the plugin, then re-run the script. -->`;
export const put = (home, rel, text) => {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
};
export const read = (home, rel) => readFileSync(join(home, rel), "utf8");
