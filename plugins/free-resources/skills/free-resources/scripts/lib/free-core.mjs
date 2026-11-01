// What free.mjs does: make a plan of the processes that may be stopped, and stop the ones the person picked. Everything it
// touches is passed in (`deps`), so the tests drive it with made-up processes and fake actions; free.mjs passes the real
// ones. The order of a stop is fixed: the plan is checked, then this tool checks itself, then the machine is scanned
// again, then for each picked process, one after another: read it now (pinned on Windows), run the stop gate against the
// identity in the plan, act only on yes, wait, record.
import { evaluate, identityOf, methodFor, METHOD_LABELS } from "./gate.mjs";
import { checkPlan, PLAN_ID, PLAN_TTL_MS, PLAN_SCHEMA_VERSION } from "./plans.mjs";
import { safeName } from "./sanitize.mjs";
import { assertPid } from "./terminate.mjs";

// At most this many processes are checked for a plan (the largest first): each check reads the process and, on Windows,
// starts one PowerShell.
export const MAX_CANDIDATES = 20;
// At most this many processes per stop, one after another.
export const MAX_STOP_PIDS = 10;
// How long a stop waits for a process to end before it reports it as still running.
export const STOP_WAIT_MS = 10000;
const POLL_MS = 250;
export const EXIT = { done: 0, failed: 1, usage: 2, refused: 4 };

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const candidate = (d) => (d.bucket === "suggest" && d.category === "dev_leftover") || (d.bucket === "your_call" && d.category === "dev_busy");
const view = (d) => ({ pid: d.pid, name: safeName(d.name), tool: d.tool == null ? null : safeName(d.tool), mb: round1(d.rss_mb), busy: d.category === "dev_busy" });
const sameIdentity = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

// deps: { platform, now(), self: { self, parent } (this script's pid and its parent's, which are never stopped), selfCheck(),
//         state(), factsFor(pid, { light }) (one process, pinned on Windows; light: no signature check, for re-reads),
//         factsForMany(pids) (a Map, holding nothing), store: { save, load, append }, randomId() }
export async function makePlan(deps) {
  const self = await deps.selfCheck();
  if (!self.ok) return { code: EXIT.refused, result: { refused: "self_check", reasons: self.reasons } };
  const st = await deps.state();
  if (st.protection?.stop_allowed !== true) return { code: EXIT.refused, result: { refused: "stopping_off", reasons: st.protection?.stop_blockers ?? ["the protected lists could not be read"] } };
  const byPid = new Map(st.records.map((r) => [r.pid, r]));
  const picked = st.classification.decisions.filter(candidate).sort((a, b) => b.rss_mb - a.rss_mb);
  const items = [];
  const refused = [];
  const pool = [];
  for (const d of picked.slice(0, MAX_CANDIDATES)) {
    try {
      assertPid(d.pid, deps.self);
      pool.push(d);
    } catch {
      refused.push({ ...view(d), rule: "pid", reason: "this tool, or the program that started it" });
    }
  }
  // A plan only assesses, so the processes are read in one go and nothing is held; the stop reads and pins each again.
  let read;
  try {
    read = await deps.factsForMany(pool.map((d) => d.pid));
  } catch {
    read = new Map();
  }
  for (const d of pool) {
    try {
      const facts = read.get(d.pid) ?? null;
      const verdict = evaluate({ platform: deps.platform, decision: d, record: byPid.get(d.pid), records: st.records, me: self.me, facts, protection: st.protection, home: st.home, canonicalPath: st.canonicalPath, expected: null });
      const identity = verdict.allowed ? identityOf(deps.platform, facts) : null;
      if (verdict.allowed && identity) items.push({ ...view(d), method: methodFor(deps.platform, facts), identity });
      else refused.push({ ...view(d), rule: verdict.refused_by ?? "identity", reason: verdict.reason ?? "it could not be pinned to one process" });
    } catch {
      refused.push({ ...view(d), rule: "error", reason: "it could not be checked" });
    }
  }
  const now = deps.now();
  const plan = { schema_version: PLAN_SCHEMA_VERSION, id: deps.randomId(), created_ms: now, expires_ms: now + PLAN_TTL_MS, platform: deps.platform, items };
  deps.store.save(plan);
  const notChecked = Math.max(0, picked.length - MAX_CANDIDATES);
  return {
    code: EXIT.done,
    result: {
      plan_id: plan.id,
      expires_iso: new Date(plan.expires_ms).toISOString(),
      stoppable: items.map(({ identity, ...rest }) => ({ ...rest, how: METHOD_LABELS[rest.method], needs_second_yes: rest.method === "end" })),
      refused,
      not_checked: notChecked,
    },
  };
}

// command: "stop" (asks: taskkill without /F for a windowed program, SIGTERM elsewhere) or "force" (ends at once:
// taskkill /F, SIGKILL). force takes exactly one process: it is only ever run after a second yes for that process.
export function checkRequest({ command, planId, pids }) {
  if (command !== "stop" && command !== "force") return "the command must be stop or force";
  if (typeof planId !== "string" || !PLAN_ID.test(planId)) return "--plan needs the plan id that free.mjs plan printed (12 characters, 0-9 and a-f)";
  if (!Array.isArray(pids) || pids.length === 0) return "--pid needs at least one process number";
  if (!pids.every((p) => Number.isSafeInteger(p) && p > 0)) return "--pid needs whole numbers";
  if (new Set(pids).size !== pids.length) return "the same process number was given twice";
  if (pids.length > MAX_STOP_PIDS) return `at most ${MAX_STOP_PIDS} processes per stop`;
  if (command === "force" && pids.length !== 1) return "force takes exactly one process, each after its own second yes";
  return null;
}

async function waitUntilGone(deps, pid, identity) {
  const until = deps.now() + STOP_WAIT_MS;
  for (;;) {
    const again = await deps.factsFor(pid, { light: true });
    await again.release();
    const f = again.facts;
    if (!f || !sameIdentity(identityOf(deps.platform, f), identity) || (typeof f.state === "string" && /^[ZX]/.test(f.state))) return true;
    if (deps.now() >= until) return false;
    await deps.sleep(POLL_MS);
  }
}

// deps as for makePlan, plus act: { taskkill(pid, { force }), signal(pid, sig) } and sleep(ms).
export async function stopPids({ command, planId, pids }, deps) {
  const bad = checkRequest({ command, planId, pids });
  if (bad) return { code: EXIT.usage, result: { error: bad } };
  const force = command === "force";
  const plan = deps.store.load();
  const ok = checkPlan(plan, planId, { now: deps.now(), platform: deps.platform });
  if (!ok.ok) return { code: EXIT.refused, result: { refused: "plan", reasons: [ok.reason] } };
  const items = new Map(plan.items.map((i) => [i.pid, i]));
  const problems = [];
  for (const pid of pids) {
    const item = items.get(pid);
    if (!item) problems.push(`process ${pid} is not in the plan as one that can be stopped`);
    else if (!force && item.method === "end") problems.push(`process ${pid} can only be ended at once; that needs force, after a second yes`);
  }
  if (problems.length) return { code: EXIT.refused, result: { refused: "not_in_plan", reasons: problems } };

  const self = await deps.selfCheck();
  if (!self.ok) return { code: EXIT.refused, result: { refused: "self_check", reasons: self.reasons } };
  const st = await deps.state();
  if (st.protection?.stop_allowed !== true) return { code: EXIT.refused, result: { refused: "stopping_off", reasons: st.protection?.stop_blockers ?? ["the protected lists could not be read"] } };
  const byPid = new Map(st.records.map((r) => [r.pid, r]));
  const decisions = new Map(st.classification.decisions.map((d) => [d.pid, d]));

  const results = [];
  for (const pid of pids) {
    const item = items.get(pid);
    const decision = decisions.get(pid);
    // Names come from the fresh scan, cleaned; the plan file's own text is never printed as it is.
    const out = { pid, name: safeName(decision?.name ?? item.name), tool: (decision?.tool ?? item.tool) == null ? null : safeName(decision?.tool ?? item.tool), method: force ? "force" : item.method, outcome: "refused", rule: null, reason: null };
    const log = (outcome) => {
      try {
        deps.store.append({ plan: planId, command, pid, name: out.name, tool: out.tool, method: out.method, outcome, rule: out.rule });
      } catch {
        throw Object.assign(new Error("the action log could not be written"), { logFailed: true });
      }
    };
    const refuse = (rule, reason) => { out.rule = rule; out.reason = reason; };
    let pinned = null;
    try {
      assertPid(pid, deps.self);
      pinned = await deps.factsFor(pid);
      const verdict = evaluate({ platform: deps.platform, decision, record: byPid.get(pid), records: st.records, me: self.me, facts: pinned.facts, protection: st.protection, home: st.home, canonicalPath: st.canonicalPath, expected: item.identity });
      // How to stop it is worked out again from what was read now; the plan's word for it must agree.
      const method = verdict.allowed ? methodFor(deps.platform, pinned.facts) : null;
      if (!verdict.allowed) refuse(verdict.refused_by, verdict.reason);
      else if (method !== item.method) refuse("method", "it is not the kind of program the plan said (how it would be stopped changed)");
      else if (!force && method === "end") refuse("method", "it can only be ended at once; that needs force, after a second yes");
      else if (deps.platform === "win32") {
        // The process stays pinned from the gate's check through taskkill to the wait, so its number cannot change hands.
        if (!(await pinned.alive())) refuse("pin", "the hold on the process was lost, so nothing was done");
        else {
          log("attempt");
          const r = deps.act.taskkill(pid, { force });
          const w = await pinned.waitForExit();
          pinned = null;
          out.outcome = w.exited === true ? "ended" : w.exited === false ? "still_running" : "unknown";
          if (out.outcome !== "ended") out.reason = r.code === 0 ? "it was asked but has not ended yet" : "Windows did not let it be stopped (access denied, or it can only be ended at once)";
        }
      } else {
        await pinned.release();
        pinned = null;
        // Read once more right before the signal: the number must still belong to the process the plan listed.
        const again = await deps.factsFor(pid, { light: true });
        await again.release();
        if (!sameIdentity(identityOf(deps.platform, again.facts), item.identity)) refuse("identity", "it changed just before the signal, so nothing was sent");
        else {
          log("attempt");
          const s = deps.act.signal(pid, force ? "SIGKILL" : "SIGTERM");
          if (!s.ok) {
            out.outcome = s.code === "ESRCH" ? "already_gone" : "failed";
            out.reason = s.code === "EPERM" ? "not allowed (it is not yours after all); nothing else was tried" : s.code === "ESRCH" ? "it had already ended" : "the signal could not be sent";
          } else {
            out.outcome = (await waitUntilGone(deps, pid, item.identity)) ? "ended" : "still_running";
            if (out.outcome === "still_running") out.reason = force ? "it has not ended yet" : "it did not stop when asked; ending it at once needs force, after a second yes";
          }
        }
      }
    } catch (e) {
      // A log that cannot be written before acting means nothing was done.
      if (out.outcome === "refused") out.reason = out.reason ?? (e?.logFailed ? "the action log could not be written, so nothing was done" : "it could not be checked");
      else out.reason = out.reason ?? "it could not be completed";
    } finally {
      await pinned?.release?.();
    }
    try {
      log(out.outcome);
    } catch {
      out.log = "the action log could not be written";
    }
    results.push(out);
  }
  const allDone = results.every((r) => r.outcome === "ended" || r.outcome === "already_gone");
  return { code: allDone ? EXIT.done : EXIT.failed, result: { plan_id: planId, command, results } };
}
