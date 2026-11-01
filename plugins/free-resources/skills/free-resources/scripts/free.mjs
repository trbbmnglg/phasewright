#!/usr/bin/env node
// Stops recognised dev tools of yours that you pick, and nothing else. Run it as yourself: it refuses to run elevated.
//
//   node free.mjs plan [--json] [--project <dir>]
//   node free.mjs stop --plan <plan id> --pid <pid> [--pid <pid> ...] [--json]
//   node free.mjs force --plan <plan id> --pid <pid> [--json]
//
//   plan   scans, checks every left-over or busy dev tool of yours against the stop gate, and writes a plan (valid for
//          10 minutes; only the newest plan counts). It stops nothing.
//   stop   for each picked process, one after another: checks it again and, only if every check still passes, asks it to
//          stop (Windows: taskkill without /F, for a windowed program; elsewhere: SIGTERM), then waits up to 10 s.
//          A process that can only be ended at once is refused here: that is what force is for.
//   force  ends one process at once (taskkill /F, or SIGKILL), after the same checks. Run it only after a second yes.
//
// Exit codes: 0 every picked process ended; 1 one or more did not; 2 usage; 4 refused before anything was done (it runs
// elevated, its self-check failed, stopping is switched off, the plan is missing, old or not the newest, or a process is
// not in the plan as one that can be stopped). It reads only its own options: no --fixture, no environment switches.
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { collectState } from "./lib/scan.mjs";
import { factsFor, factsForMany } from "./lib/facts.mjs";
import { selfCheck } from "./lib/selfcheck.mjs";
import { makePlan, stopPids, EXIT, MAX_STOP_PIDS } from "./lib/free-core.mjs";
import { newPlanId, savePlan, loadPlan, appendAction } from "./lib/plans.mjs";
import { profileDir } from "./lib/peaks.mjs";
import { taskkill, signal } from "./lib/terminate.mjs";
import { warnIfInsideSkillDir } from "./lib/skilldir.mjs";

const USAGE = [
  "usage: node free.mjs plan [--json] [--project <dir>]",
  "       node free.mjs stop --plan <plan id> --pid <pid> [--pid <pid> ...] [--json]",
  "       node free.mjs force --plan <plan id> --pid <pid> [--json]",
].join("\n");

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(EXIT.usage);
}

function parseArgs(argv, cwd = process.cwd()) {
  const [command, ...rest] = argv;
  if (!["plan", "stop", "force"].includes(command)) return { error: "the first word must be plan, stop or force" };
  const o = { command, json: false, project: cwd, planId: null, pids: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => (i + 1 < rest.length ? rest[++i] : null);
    if (a === "--json") o.json = true;
    else if (a === "--project" && command === "plan") {
      const v = next();
      if (v == null || v === "") return { error: "--project needs a folder" };
      o.project = resolve(cwd, v);
    } else if (a === "--plan" && command !== "plan") {
      const v = next();
      if (v == null || !/^[0-9a-f]{12}$/.test(v) || o.planId) return { error: "--plan needs the plan id free.mjs plan printed (12 characters, 0-9 and a-f), once" };
      o.planId = v;
    } else if (a === "--pid" && command !== "plan") {
      const v = next();
      if (v == null || !/^[1-9][0-9]{0,9}$/.test(v)) return { error: "--pid needs a whole number (a process number)" };
      o.pids.push(Number(v));
    } else return { error: `unknown option ${a}` };
  }
  if (command !== "plan") {
    if (!o.planId) return { error: "--plan is needed" };
    if (o.pids.length === 0) return { error: "--pid is needed" };
    if (o.pids.length > MAX_STOP_PIDS) return { error: `at most ${MAX_STOP_PIDS} processes per stop` };
    if (command === "force" && o.pids.length !== 1) return { error: "force takes exactly one --pid" };
  }
  return o;
}

const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function renderPlan(r) {
  const L = [`# Free resources: what can be stopped (plan ${r.plan_id}, valid until ${time(r.expires_iso)})`, ""];
  if (r.stoppable.length) {
    L.push("Recognised dev tools of yours that passed every check:", "");
    L.push(table(["Pid", "Name", "Tool", "MB", "How", "State"], r.stoppable.map((i) => [i.pid, i.name, i.tool ?? "", i.mb, i.needs_second_yes ? `${i.how} (needs a second yes)` : i.how, i.busy ? "busy right now" : "idle"])));
  } else L.push("Nothing can be stopped: no recognised dev tool of yours passed every check.");
  if (r.refused.length) {
    L.push("", "Checked and refused (never stopped):", "");
    L.push(table(["Pid", "Name", "Tool", "MB", "Why not"], r.refused.map((i) => [i.pid, i.name, i.tool ?? "", i.mb, i.reason])));
  }
  if (r.not_checked) L.push("", `${r.not_checked} more dev tool process(es) were not checked; stop some of the above and plan again.`);
  L.push("", "Nothing was stopped. Browsers, chat apps, anything not recognised, and everything protected are never stopped: close those yourself.");
  return L.join("\n");
}

const OUTCOMES = { ended: "ended", already_gone: "had already ended", still_running: "still running", failed: "failed", refused: "refused (left alone)", unknown: "unknown: check it yourself" };
function renderStop(r) {
  const L = [`# Free resources: ${r.command} (plan ${r.plan_id})`, ""];
  L.push(table(["Pid", "Name", "Tool", "Result", "Why"], r.results.map((x) => [x.pid, x.name, x.tool ?? "", OUTCOMES[x.outcome] ?? x.outcome, x.reason ?? ""])));
  if (r.results.some((x) => x.log)) L.push("", "The action log could not be written.");
  return L.join("\n");
}

function renderRefusal(r) {
  return [`Refused, nothing was done (${r.refused}):`, ...r.reasons.map((x) => `- ${x}`)].join("\n");
}

async function main() {
  warnIfInsideSkillDir();
  const o = parseArgs(process.argv.slice(2));
  if (o.error) usage(o.error);
  const platform = process.platform;
  if (!["win32", "linux", "darwin"].includes(platform)) usage(`Platform ${platform} is not supported. Windows, macOS and Linux only.`);
  const storeOpts = { project: o.project, platform };
  const deps = {
    platform,
    now: () => Date.now(),
    self: { self: process.pid, parent: process.ppid },
    selfCheck: () => selfCheck({ platform }),
    // The gate's home folder is the account's own profile, from the system, never HOME or USERPROFILE.
    state: async () => ({ ...(await collectState({ project: o.project })), home: profileDir() }),
    factsFor: (pid, { light = false } = {}) => factsFor(platform, pid, { withSignature: !light }),
    factsForMany: (pids) => factsForMany(platform, pids),
    store: { save: (p) => savePlan(p, storeOpts), load: () => loadPlan(storeOpts), append: (rec) => appendAction(rec, storeOpts) },
    act: { taskkill: (pid, { force }) => taskkill(pid, { force }), signal: (pid, sig) => signal(pid, sig) },
    sleep: (ms) => sleep(ms),
    randomId: () => newPlanId(),
  };
  const { code, result } = o.command === "plan" ? await makePlan(deps) : await stopPids({ command: o.command, planId: o.planId, pids: o.pids }, deps);
  if (code === EXIT.usage) usage(result.error);
  if (o.json) console.log(JSON.stringify({ schema_version: 1, exit_code: code, ...result }, null, 2));
  else console.log(result.refused ? renderRefusal(result) : o.command === "plan" ? renderPlan(result) : renderStop(result));
  process.exitCode = code;
}

main().catch((e) => {
  console.error(`free.mjs failed: ${e.message}`);
  process.exit(EXIT.failed);
});
