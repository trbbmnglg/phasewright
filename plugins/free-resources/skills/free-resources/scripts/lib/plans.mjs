// The plan free.mjs makes and the log of what it did, both in the skill's data folder (lib/peaks.mjs dataDir) and never
// inside the project folder. The plan is how a stop knows the processes are still the ones the person saw (the same
// number, start time, program and owner) and that the list is recent; it is not what makes a stop safe. The stop gate
// is, and it runs again at stop time.
import { randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { dataDir, dataInsideProject, openAppend, privateDir } from "./peaks.mjs";
import { safeName } from "./sanitize.mjs";

export const PLAN_FILE = "plan.json";
export const ACTIONS_FILE = "actions.jsonl";
export const PLAN_SCHEMA_VERSION = 1;
// Ten minutes: long enough to read the plan and pick, short enough that the processes are still the ones it lists.
export const PLAN_TTL_MS = 10 * 60 * 1000;
export const PLAN_ID = /^[0-9a-f]{12}$/;
export const METHODS = new Set(["close", "end", "term"]);

export const newPlanId = (rand = randomBytes) => rand(6).toString("hex");

const INSIDE = "the data folder is inside the project folder, so nothing was written; set FREE_RESOURCES_DATA to a folder outside it";

function storeDir(opts) {
  const dir = dataDir(opts);
  if (dataInsideProject(dir, opts.project, opts.platform, opts.profile)) throw new Error(INSIDE);
  return privateDir(dir);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A plan as written by makePlan. Anything else is not a plan: it lasts exactly PLAN_TTL_MS, and every item has a process
// number above 2, an identity and one of the three ways to stop.
export function isPlan(p) {
  return isObj(p) && p.schema_version === PLAN_SCHEMA_VERSION && typeof p.id === "string" && PLAN_ID.test(p.id) &&
    Number.isSafeInteger(p.created_ms) && p.expires_ms === p.created_ms + PLAN_TTL_MS && typeof p.platform === "string" && Array.isArray(p.items) &&
    p.items.every((i) => isObj(i) && Number.isSafeInteger(i.pid) && i.pid > 2 && isObj(i.identity) && METHODS.has(i.method) && typeof i.name === "string");
}

// Writes the plan, replacing any earlier one: only the newest plan can be used. It goes to a new temporary file opened
// exclusively, then is renamed over plan.json; a rename replaces a link itself, never the file a link points to.
export function savePlan(plan, opts = {}) {
  if (!isPlan(plan)) throw new Error("not a plan");
  const dir = storeDir(opts);
  const tmp = join(dir, `${PLAN_FILE}.${plan.id}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(fd, JSON.stringify(plan), null, "utf8");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, PLAN_FILE));
  return join(dir, PLAN_FILE);
}

// The current plan, or null when there is none, when the data folder is inside the project, when it is a link, a second
// name for another file or (on macOS and Linux) another user's file, or when it cannot be read as a plan.
export function loadPlan(opts = {}) {
  const dir = dataDir(opts);
  if (dataInsideProject(dir, opts.project, opts.platform, opts.profile)) return null;
  const file = join(dir, PLAN_FILE);
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.nlink > 1) return null;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    const p = JSON.parse(readFileSync(file, "utf8"));
    return isPlan(p) ? p : null;
  } catch {
    return null;
  }
}

// Whether `plan` can be used for a stop now: it exists, it is the newest plan, it is under ten minutes old, and it was
// made on this system. Returns { ok, reason }.
export function checkPlan(plan, id, { now, platform }) {
  if (!plan) return { ok: false, reason: "there is no plan; run free.mjs plan first" };
  if (plan.id !== id) return { ok: false, reason: "that is not the newest plan; use the plan id the last free.mjs plan printed" };
  if (plan.platform !== platform) return { ok: false, reason: "the plan was made on another system" };
  if (!(now >= plan.created_ms - 60000)) return { ok: false, reason: "the plan's time is in the future; run free.mjs plan again" };
  if (now > plan.expires_ms || now - plan.created_ms > PLAN_TTL_MS) return { ok: false, reason: "the plan is more than 10 minutes old; run free.mjs plan again" };
  return { ok: true, reason: null };
}

// Appends one action to actions.jsonl: when, which plan, which process (cleaned name, never a command line), what was
// done and what happened. Opened without following a link, like peaks.jsonl.
export function appendAction(record, opts = {}) {
  const dir = storeDir(opts);
  const file = join(dir, ACTIONS_FILE);
  const line = {
    schema_version: 1,
    at: new Date(opts.now ?? Date.now()).toISOString(),
    plan: record.plan,
    command: record.command,
    pid: record.pid,
    name: safeName(record.name),
    tool: record.tool == null ? null : safeName(record.tool),
    method: record.method,
    outcome: record.outcome,
    rule: record.rule ?? null,
  };
  const fd = openAppend(file, ACTIONS_FILE);
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`, null, "utf8");
  } finally {
    closeSync(fd);
  }
  return file;
}
