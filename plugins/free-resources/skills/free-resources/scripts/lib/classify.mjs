// The classifier. A pure function: records + context in, buckets with evidence out. No I/O, no clock,
// no randomness. A model never classifies; these rules and the measured numbers do.
//
// Default is Keep. Only a recognised dev leftover with two or more signals is "Suggest closing".
// First match wins:
//   1 Keep, protected   another user, service account, protected name or path, system location
//   2 Keep, in use      this process, its ancestors and descendants, or active in the project folder
//   3 Suggest closing   dev-leftover name AND (orphaned OR idle for over an hour) AND not busy
//   4 Your call         a browser, or a big unrecognised process of this user in a user-writable place
//   5 Keep, not recognised
import {
  PROTECTED, PROTECTED_PATTERNS, SYSTEM_PATHS_WIN, SYSTEM_PATHS_MAC, SERVICE_OWNERS, DEV_LEFTOVER_NAMES, DEV_RUNTIMES, PLAYWRIGHT_PATH,
  BROWSER_NAMES, BROWSER_PREFIXES, NOT_BROWSER, IDLE_CORE_PCT, ACTIVE_CORE_PCT, IDLE_MIN_AGE_H, BIG_RSS_MB, BIG_CPU_MACHINE_PCT, SMALL_MB,
} from "./rules.mjs";

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
const round1 = (n) => Math.round(n * 10) / 10;

export const normName = (name) => String(name ?? "").toLowerCase().replace(/\.exe$/, "");
const slashes = (p) => String(p ?? "").split("\\").join("/");
const lower = (p) => slashes(p).toLowerCase();

const PROTECTED_BY_NAME = new Map();
for (const [category, names] of Object.entries(PROTECTED)) for (const n of names) PROTECTED_BY_NAME.set(n, category);

export function protectedCategory(name) {
  const n = normName(name);
  if (PROTECTED_BY_NAME.has(n)) return PROTECTED_BY_NAME.get(n);
  for (const [re, category] of PROTECTED_PATTERNS) if (re.test(n)) return category;
  return null;
}

const wildcard = (pattern) => new RegExp(`^${pattern.toLowerCase().replace(/\.exe$/, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

function localProtectedReason(rec, local) {
  const n = normName(rec.name);
  for (const p of local?.names ?? []) if (wildcard(p).test(n)) return `in the local protected list (name ${p})`;
  const exe = lower(rec.exe);
  const cmd = lower(rec.cmd_full);
  for (const p of local?.paths ?? []) {
    const q = lower(p);
    if (q && ((exe && exe.includes(q)) || (cmd && cmd.includes(q)))) return `in the local protected list (path ${p})`;
  }
  return null;
}

export function isBrowser(rec) {
  const n = normName(rec.name);
  if (NOT_BROWSER.includes(n)) return false;
  if (PLAYWRIGHT_PATH.test(rec.exe ?? "") || PLAYWRIGHT_PATH.test(rec.cmd_full ?? "")) return false;
  return BROWSER_NAMES.includes(n) || BROWSER_PREFIXES.some((p) => n.startsWith(p));
}

function splitArgs(cmd) {
  const out = [];
  for (const m of String(cmd ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const toolBase = (token) => slashes(token).split("/").pop().toLowerCase().replace(/\.(c|m)?js$|\.ts$|\.cmd$|\.exe$/, "");

// The dev tool this process is, or null. Playwright browsers are found by their download folder.
export function devTool(rec) {
  const n = normName(rec.name);
  if (PLAYWRIGHT_PATH.test(rec.exe ?? "") || PLAYWRIGHT_PATH.test(rec.cmd_full ?? "")) return "playwright browser";
  if (DEV_LEFTOVER_NAMES.includes(n)) return n;
  if (DEV_RUNTIMES.includes(n)) {
    const args = splitArgs(rec.cmd_full).slice(1, 4);
    for (const [i, t] of args.entries()) {
      const pathLike = /[\\/]/.test(t);
      const base = toolBase(t);
      if (DEV_LEFTOVER_NAMES.includes(base) && (pathLike || i === 0)) return base;
      const m = slashes(t).toLowerCase().match(/node_modules\/(?:\.bin\/)?([\w.-]+)/);
      if (m && DEV_LEFTOVER_NAMES.includes(m[1])) return m[1];
    }
  }
  return null;
}

const ownerUser = (owner) => String(owner ?? "").split(/[\\/]/).pop().toLowerCase();
const isMe = (owner, me) => owner != null && ownerUser(owner) === ownerUser(me?.user);
const isServiceOwner = (owner) => SERVICE_OWNERS.test(String(owner)) || SERVICE_OWNERS.test(ownerUser(owner));

function isSystemPath(exe, platform) {
  if (!exe) return false;
  const list = platform === "darwin" ? SYSTEM_PATHS_MAC : SYSTEM_PATHS_WIN;
  return list.some((re) => re.test(exe));
}

function isUserWritable(exe, home, platform) {
  if (!exe) return false;
  const e = lower(exe);
  const h = lower(home);
  if (h && e.startsWith(h.endsWith("/") ? h : `${h}/`)) return true;
  return platform === "darwin" ? e.startsWith("/tmp/") || e.startsWith("/private/var/folders/") : /\/appdata\/local\/temp\//.test(e);
}

// Folders named on the command line: the part before node_modules, or the folder of a file path.
export function projectPaths(rec, platform) {
  const out = [];
  const args = splitArgs(rec.cmd_full).slice(1);
  for (const t of args) {
    const abs = platform === "darwin" ? /^\/[^/]/.test(t) : /^[A-Za-z]:[\\/]/.test(t);
    if (!abs) continue;
    const p = slashes(t);
    const nm = p.toLowerCase().indexOf("/node_modules/");
    if (nm > 0) out.push(p.slice(0, nm));
    else out.push(/\.[A-Za-z0-9]{1,5}$/.test(p) ? p.slice(0, p.lastIndexOf("/")) : p);
  }
  return [...new Set(out.filter(Boolean))];
}

function ancestorsAndDescendants(records, mePid) {
  const byPid = new Map(records.map((r) => [r.pid, r]));
  const related = new Set([mePid]);
  for (let p = byPid.get(mePid)?.ppid, guard = 0; p && byPid.has(p) && !related.has(p) && guard < 64; p = byPid.get(p).ppid, guard++) related.add(p);
  const kids = new Map();
  for (const r of records) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const queue = [mePid];
  while (queue.length) for (const k of kids.get(queue.shift()) ?? []) if (!related.has(k)) { related.add(k); queue.push(k); }
  return related;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const d of items) {
    const k = keyFn(d);
    map.set(k, [...(map.get(k) ?? []), d]);
  }
  return [...map.values()];
}

const lowest = (items) => items.reduce((acc, d) => (CONFIDENCE_RANK[d.confidence] < CONFIDENCE_RANK[acc] ? d.confidence : acc), "high");

function summarizeGroup(members, tool) {
  const first = members[0];
  const reasons = [...new Set(members.flatMap((m) => m.reasons))];
  return {
    name: first.name,
    ...(tool ? { tool } : {}),
    count: members.length,
    total_mb: round1(members.reduce((a, m) => a + m.rss_mb, 0)),
    cpu_pct: round1(members.reduce((a, m) => a + (m.cpu_pct ?? 0), 0)),
    reasons,
    confidence: lowest(members),
    category: first.category,
    members: members.map((m) => ({ pid: m.pid, ppid: m.ppid, rss_mb: m.rss_mb, cpu_pct: m.cpu_pct, start_iso: m.start_iso, reasons: m.reasons, confidence: m.confidence })),
  };
}

// ctx: { me:{user,pid}, home, platform, logical_cpus, now_ms, localProtected:{names,paths},
//        projectDir, listening:Iterable<pid>, pathExists:(path)=>boolean|undefined, all:boolean }
export function classify(records, ctx) {
  const cpus = ctx.logical_cpus || 1;
  const listening = new Set(ctx.listening ?? []);
  const byPid = new Map(records.map((r) => [r.pid, r]));
  const related = ancestorsAndDescendants(records, ctx.me?.pid);
  const project = lower(ctx.projectDir).replace(/\/$/, "");
  const decisions = [];

  for (const rec of records) {
    const d = { pid: rec.pid, ppid: rec.ppid, name: rec.name, rss_mb: rec.rss_mb, cpu_pct: rec.cpu_pct, start_iso: rec.start_iso, reasons: [], bucket: "keep", category: "not_recognized", confidence: "medium", tool: null };
    decisions.push(d);
    const keep = (category, reason, confidence = "high") => { d.bucket = "keep"; d.category = category; d.reasons = [reason]; d.confidence = confidence; };

    // 1. Keep, protected
    if (rec.owner != null && !isMe(rec.owner, ctx.me)) {
      keep("other_user", isServiceOwner(rec.owner) ? "system or service account" : "owned by another user");
      continue;
    }
    const cat = protectedCategory(rec.name);
    if (cat) { keep("protected", `protected: ${cat}`); continue; }
    const local = localProtectedReason(rec, ctx.localProtected);
    if (local) { keep("protected", local); continue; }
    if (isSystemPath(rec.exe, ctx.platform) && !isBrowser(rec)) { keep("protected", "runs from a Windows, Program Files or system folder"); continue; }

    const coreCpu = rec.cpu_pct == null ? null : rec.cpu_pct * cpus;
    const active = (coreCpu != null && coreCpu > ACTIVE_CORE_PCT) || listening.has(rec.pid);
    const tool = devTool(rec);
    const paths = projectPaths(rec, ctx.platform);

    // 2. Keep, in use
    if (related.has(rec.pid)) { keep("in_use", "this scan, or its parent or child process"); continue; }
    const refsProject = project && (paths.some((p) => lower(p) === project || lower(p).startsWith(`${project}/`)) || lower(rec.cmd_full).includes(project));
    if (refsProject && active) { keep("in_use", "active and working in the project folder"); continue; }

    const me = isMe(rec.owner, ctx.me);

    // 3. Suggest closing: recognised dev leftover, two or more signals, owned by this user
    if (tool) {
      d.tool = tool;
      if (!me) { keep("owner_unknown", `dev tool (${tool}) but its owner could not be confirmed as you`, "medium"); continue; }
      const parent = byPid.get(rec.ppid);
      const orphaned = rec.ppid > 0 && (!parent || (parent.start_iso && rec.start_iso && Date.parse(parent.start_iso) > Date.parse(rec.start_iso)));
      const ageH = rec.start_iso && ctx.now_ms != null ? (ctx.now_ms - Date.parse(rec.start_iso)) / 3.6e6 : null;
      const idle = coreCpu != null && coreCpu < IDLE_CORE_PCT;
      const idleLong = idle && ageH != null && ageH > IDLE_MIN_AGE_H;
      const signals = [`dev leftover tool: ${tool}`];
      if (orphaned) signals.push(`orphaned: its parent process ${rec.ppid} is not running`);
      if (idleLong) signals.push(`idle: under ${IDLE_CORE_PCT}% of one core over the sample, running over ${IDLE_MIN_AGE_H} h`);
      if (active && !idle) {
        d.bucket = "your_call"; d.category = "dev_busy"; d.confidence = "low";
        d.reasons = [`dev leftover tool: ${tool}`, orphaned ? `orphaned, but busy right now (${round1(coreCpu ?? 0)}% of one core)` : "busy right now"];
        continue;
      }
      if (signals.length >= 2) {
        const gone = paths.length > 0 && typeof ctx.pathExists === "function" && paths.every((p) => ctx.pathExists(p) === false);
        if (gone) signals.push("its project folder no longer exists");
        d.bucket = "suggest"; d.category = "dev_leftover"; d.reasons = signals;
        d.confidence = orphaned && idleLong && gone ? "high" : "medium";
        continue;
      }
      keep("dev_active", `dev tool (${tool}) with no sign it is left over: not orphaned and not idle for over ${IDLE_MIN_AGE_H} h`, "medium");
      continue;
    }

    // 4. Your call
    if (me && isBrowser(rec)) {
      d.bucket = "your_call"; d.category = "browser"; d.confidence = "low"; d.reasons = ["browser: only you know which windows matter"];
      continue;
    }
    const big = rec.rss_mb > BIG_RSS_MB;
    const busy = rec.cpu_pct != null && rec.cpu_pct > BIG_CPU_MACHINE_PCT;
    if (me && (big || busy) && isUserWritable(rec.exe, ctx.home, ctx.platform)) {
      d.bucket = "your_call"; d.category = "heavy"; d.confidence = "low";
      d.reasons = [big ? `uses ${Math.round(rec.rss_mb)} MB` : `uses ${rec.cpu_pct}% of the machine's CPU`, "not recognised, runs from a user-writable folder"];
      continue;
    }

    // 5. Keep, not recognised
    keep(rec.rss_mb < SMALL_MB ? "small" : "not_recognized", me ? "not recognised, so kept" : "owner not checked, so kept", "medium");
  }

  const suggest = groupBy(decisions.filter((d) => d.bucket === "suggest"), (d) => `${d.name}|${d.tool}`).map((m) => summarizeGroup(m, m[0].tool));
  const yourCall = groupBy(decisions.filter((d) => d.bucket === "your_call"), (d) => `${d.name}|${d.category}`).map((m) => summarizeGroup(m, m[0].tool));
  const order = (a, b) => b.total_mb - a.total_mb;
  suggest.sort(order);
  yourCall.sort(order);

  const keepDecisions = decisions.filter((d) => d.bucket === "keep");
  const summary = {};
  for (const d of keepDecisions) {
    const s = (summary[d.category] ??= { count: 0, total_mb: 0 });
    s.count += 1;
    s.total_mb = round1(s.total_mb + d.rss_mb);
  }
  const keepGroups = ctx.all
    ? groupBy(keepDecisions, (d) => `${d.name}|${d.category}`).map((m) => summarizeGroup(m, null)).sort(order)
    : groupBy(keepDecisions.filter((d) => d.category === "in_use" || d.category === "dev_active"), (d) => `${d.name}|${d.category}`).map((m) => summarizeGroup(m, null)).sort(order);

  return {
    suggest,
    your_call: yourCall,
    keep: { summary, groups: keepGroups, hidden_other_user: ctx.all ? 0 : summary.other_user?.count ?? 0 },
    decisions,
    totals: { processes: records.length, suggest: suggest.reduce((a, g) => a + g.count, 0), your_call: yourCall.reduce((a, g) => a + g.count, 0), keep: keepDecisions.length },
  };
}
