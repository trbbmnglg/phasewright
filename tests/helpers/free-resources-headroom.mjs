// Shared helpers of tests/free-resources-headroom.test.mjs and tests/free-resources-measure.test.mjs. Not a test file (no .test.mjs). Temp folders are made under
// the OS temp folder and removed after each test file's run.
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = join(HERE, "..");
export const FR = join(REPO, "plugins", "free-resources", "skills", "free-resources");
export const FIX = join(HERE, "fixtures");
export const load = (mod) => import(pathToFileURL(join(FR, "scripts", "lib", `${mod}.mjs`)).href);
export const WINDOWS_ONLY = process.platform === "win32" ? false : "live test: Windows only";
export const sampler = await load("sampler");
// Each test removes its folder; the after hook below removes whatever a failing test leaves behind.
export const scratch = [];
export const tmp = () => { const d = mkdtempSync(join(tmpdir(), "fr-test-")); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
export const peak = (mbv, cores = 1, extra = {}) => ({ started_iso: "2026-10-23T00:00:00.000Z", peak_tree_mb: mbv, peak_avail_drop_mb: mbv + 50, peak_cpu_cores: cores, samples: 10, duration_s: 100, ...extra });

// ---------- headroom CLI ----------

export const cliEnv = (dir, extra = {}) => ({ ...process.env, FREE_RESOURCES_DATA: dir, FREE_RESOURCES_PROTECTED: join(FIX, "protected.test.json"), ...extra });
