// Shared helpers of tests/wiki.test.mjs and tests/wiki-publish.test.mjs. Not a test file (no .test.mjs). Temp folders are made under the OS temp
// folder and removed after each test file's run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WIKI = join(ROOT, "docs", "wiki");
export const SCRIPT = join(ROOT, "scripts", "publish-wiki.mjs");
export const scratch = [];
export const tmp = (label) => { const d = mkdtempSync(join(tmpdir(), `wiki-test-${label}-`)); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
export const git = (cwd, args, env = {}) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
};
export const read = (dir, name) => readFileSync(join(dir, name), "utf8");
export const repoIdentity = () => git(ROOT, ["log", "-1", "--format=%an%x00%ae"]).trim().split("\0");
export const publish = (bare, ...flags) => spawnSync(process.execPath, [SCRIPT, "--publish", ...flags], {
  cwd: ROOT, encoding: "utf8",
  env: { ...process.env, PUBLISH_WIKI_TEST: "1", PUBLISH_WIKI_TEST_REMOTE: bare, GH_TOKEN: "synthetic-value-for-the-leak-check" },
});
