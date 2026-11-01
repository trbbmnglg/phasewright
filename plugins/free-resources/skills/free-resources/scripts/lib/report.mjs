// Builds the report: stable JSON (schema_version 1) and the human text with numbered tables.
// Only the normalized fields are printed. The full command line never leaves the scanner.
import { DEFAULT_TOP, IDLE_CORE_PCT, IDLE_MIN_AGE_H, BIG_RSS_MB, BIG_CPU_MACHINE_PCT, SMALL_MB } from "./rules.mjs";
import { safeName } from "./sanitize.mjs";
import { analyze } from "./analysis.mjs";

export const SCHEMA_VERSION = 1;
export const READ_ONLY_LINE = "Nothing was closed. This scan is read-only.";
export const MAC_NOTE = "Mac support is untested: it was written from documented commands and checked against sample data only.";
export const LINUX_NOTE = "Linux support is new: it reads /proc, and it is checked against recorded samples and by a live test on a GitHub-hosted Ubuntu runner. Inside a container the memory figures can show the host's, not the container's limit.";

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const ownerUser = (owner) => String(owner ?? "").split(/[\\/]/).pop().toLowerCase();

function topGroups(records, key, n) {
  const map = new Map();
  for (const r of records) {
    const g = map.get(r.name) ?? { name: r.name, count: 0, total_mb: 0, cpu_pct: 0 };
    g.count += 1;
    g.total_mb += r.rss_mb;
    g.cpu_pct += r.cpu_pct ?? 0;
    map.set(r.name, g);
  }
  return [...map.values()]
    .filter((g) => (key === "cpu_pct" ? g.cpu_pct > 0 : true))
    .sort((a, b) => b[key] - a[key])
    .slice(0, n)
    .map((g) => ({ ...g, name: safeName(g.name), total_mb: round1(g.total_mb), cpu_pct: round1(g.cpu_pct) }));
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "organization policy (3 names, 1 path), your list (2 names, 0 paths)": counts only, never the entries.
function listsNote(sources) {
  const parts = sources.map((s) => (s.status === "ok" ? `${s.label} (${plural(s.names, "name", "names")}, ${plural(s.paths, "path", "paths")})` : `${s.label} (not usable)`));
  return `Protected lists loaded: ${parts.join(", ")}.`;
}

// What the scan knew about one pid: its decision, in words. Names are cleaned like every other name.
function explainPid(pid, decisions) {
  const d = decisions.find((x) => x.pid === pid);
  if (!d) return { pid, found: false };
  return { pid, found: true, name: safeName(d.name), bucket: d.bucket, category: d.category, confidence: d.confidence, tool: d.tool ?? null, reasons: d.reasons, rss_mb: d.rss_mb };
}

// input: { platform, records, classification, pressure, me:{user}, opts:{all,top,explain}, meta:{now_iso, scan_seconds,
//          interval_s, logical_cpus, protection:{sources,warnings,stop_allowed}, project_dir} }
export function buildReport({ platform, records, classification, pressure, me, opts = {}, meta = {} }) {
  const top = Number.isInteger(opts.top) && opts.top > 0 ? opts.top : DEFAULT_TOP;
  const visible = opts.all ? records : records.filter((r) => r.owner != null && ownerUser(r.owner) === ownerUser(me?.user));
  const notes = [];
  if (platform === "darwin") notes.push(MAC_NOTE);
  if (platform === "linux") notes.push(LINUX_NOTE);
  for (const w of meta.protection?.warnings ?? []) notes.push(w);
  if (meta.protection?.sources?.length) notes.push(listsNote(meta.protection.sources));
  for (const w of pressure.warnings ?? []) notes.push(w);
  let n = 0;
  const number = (g) => ({ n: ++n, ...g, name: safeName(g.name) });
  const numbered = { suggest_closing: classification.suggest.map(number), your_call: classification.your_call.map(number) };
  const analysis = analyze({ records, classification, pressure, numbered, all: !!opts.all });
  return {
    schema_version: SCHEMA_VERSION,
    generated_iso: meta.now_iso ?? null,
    platform,
    mac_untested: platform === "darwin",
    read_only: true,
    scan_seconds: meta.scan_seconds ?? null,
    sample: { interval_s: round1(meta.interval_s ?? null), logical_cpus: meta.logical_cpus ?? null },
    pressure: {
      verdict: pressure.verdict,
      reasons: pressure.reasons,
      unmeasured: pressure.unmeasured ?? [],
      memory_stall_pct: pressure.memory_stall_pct ?? null,
      total_mb: pressure.total_mb,
      avail_mb: pressure.avail_mb,
      avail_pct: pressure.avail_pct,
      paging_per_s: pressure.paging_per_s,
      cpu_pct: pressure.cpu_pct,
      samples: pressure.samples,
      thresholds: pressure.thresholds,
      thresholds_are_starting_values: true,
    },
    task_need: { available: false, note: "A plain scan carries no task need. To judge one task, measure it with measure.mjs and compare it with headroom.mjs." },
    top_consumers: {
      scope: opts.all ? "all processes" : "your own processes",
      by_memory: topGroups(visible, "total_mb", top),
      by_cpu: topGroups(visible, "cpu_pct", top),
      not_shown: records.length - visible.length,
    },
    buckets: {
      suggest_closing: numbered.suggest_closing,
      your_call: numbered.your_call,
      keep: {
        summary: classification.keep.summary,
        listed: classification.keep.groups.map((g) => ({ ...g, name: safeName(g.name), members: undefined })),
        hidden_other_user: classification.keep.hidden_other_user,
      },
    },
    analysis,
    protection: { lists: meta.protection?.sources ?? [], stopping: "not available in this version", stop_allowed_by_settings: meta.protection?.stop_allowed ?? true },
    ...(opts.explain != null ? { explain: explainPid(opts.explain, classification.decisions) } : {}),
    totals: classification.totals,
    notes,
  };
}

const cell = (v) => String(v ?? "").replace(/\|/g, "/");
const fmtMb = (mb) => (mb >= 1024 ? `${round1(mb / 1024)} GB` : `${Math.round(mb)} MB`);

function table(headers, rows) {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

function bucketTable(groups) {
  if (!groups.length) return "None.";
  return table(
    ["#", "Name", "Count", "MB", "CPU %", "Reasons", "Confidence"],
    groups.map((g) => [g.n, g.name, g.count, Math.round(g.total_mb), g.cpu_pct, g.reasons.join("; "), g.confidence]),
  );
}

function analysisLines(a) {
  if (!a) return [];
  const L = ["", "## Analysis", "", `- ${a.summary.pressure}`];
  const f = a.summary.freeable_up_to_mb;
  L.push(f > 0 ? `- Closing everything under Suggest closing would free up to ${fmtMb(f)} of memory and no CPU (they are idle). ${a.summary.freeable_note}` : "- Nothing is under Suggest closing, so there is nothing to free by closing.");
  const o = a.summary.off_limits;
  if (o.processes > 0) {
    L.push(`- Off limits: ${plural(o.processes, "process", "processes")} using ${fmtMb(o.total_mb)} are protected or belong to other accounts. ${o.note}`);
    if (o.heaviest.length) L.push(`  - Heaviest: ${o.heaviest.map((h) => `${h.name} (${fmtMb(h.total_mb)}${h.count > 1 ? `, ${h.count} processes` : ""}; ${h.why}${h.security ? "; a security or endpoint agent" : ""})`).join("; ")}.`);
    if (o.other_users?.processes > 0) L.push(`  - ${plural(o.other_users.processes, "of them belongs", "of them belong")} to other users and ${o.other_users.processes === 1 ? "is" : "are"} not named here; --all lists them.`);
  }
  if (a.items.length) {
    L.push("", "For each listed group:", "");
    for (const i of a.items) {
      const [bucket, n] = i.ref.split("#");
      L.push(`${bucket === "suggest_closing" ? "Suggest closing" : "Your call"} ${n}: ${i.name}`);
      L.push(`- What it is: ${i.what}.`, `- Why it is heavy: ${i.why_heavy}`, `- What to do: ${i.action}`, `- What closing it would give: up to ${fmtMb(i.gain.memory_up_to_mb)} of memory; CPU: ${i.gain.cpu}.`, "");
    }
    L.pop();
  }
  if (a.summary.advice.length) {
    L.push("", "Virtual machines and background programs with their own way to stop (you run these yourself; this skill never does):", "");
    for (const v of a.summary.advice) {
      L.push(`- ${v.target}: ${plural(v.processes, "process", "processes")}, ${fmtMb(v.memory_mb)}. ${v.command ? `Run \`${v.command}\` yourself: it ends ${v.ends}.` : `${v.note}`} ${v.command && v.note ? v.note : ""} (${v.source}, read ${v.checked})`.replace(/\s+/g, " ").trim());
    }
  }
  return L;
}

function explainLines(e) {
  if (!e) return [];
  if (!e.found) return ["", `## Why pid ${e.pid}`, "", `Pid ${e.pid} was not among the processes scanned (it may have ended, or never existed).`];
  const where = { suggest: "Suggest closing", your_call: "Your call", keep: "Keep" }[e.bucket] ?? e.bucket;
  return ["", `## Why pid ${e.pid}`, "", `- ${e.name} is in ${where} (category: ${e.category}, confidence: ${e.confidence}).`, ...e.reasons.map((x) => `- ${x}`), `- It uses ${fmtMb(e.rss_mb ?? 0)}.`];
}

export function renderHuman(r) {
  const p = r.pressure;
  const t = p.thresholds;
  const L = [];
  L.push(`# Free-resources scan (${r.platform}, ${r.generated_iso ?? "no timestamp"})`);
  if (r.mac_untested) L.push("", `> ${MAC_NOTE}`);
  const heading = p.verdict === "none" ? (p.unmeasured?.length ? "no pressure in what was measured" : "no pressure") : p.verdict === "not_measured" ? "not measured" : `${p.verdict} pressure`;
  L.push("", `## Pressure now: ${heading}`);
  const num = (v, unit) => (v == null ? "not measured" : `${v}${unit}`);
  L.push(
    `- Memory available: ${p.avail_mb == null ? "not measured" : `${fmtMb(p.avail_mb)} of ${fmtMb(p.total_mb)} (${num(p.avail_pct, "%")})`}. Memory pressure below ${t.memory_available_pct_below}% available.`,
    `- Paging: ${num(p.paging_per_s, " pages/s")}. Memory pressure above ${t.paging_per_s_above} pages/s.`,
    `- CPU: ${num(p.cpu_pct, "%")} average over ${p.samples || "no"} sample(s). CPU pressure at ${t.cpu_avg_pct_at_least}% or more.`,
    "- These thresholds are starting values, not tuned for this machine.",
  );
  if (p.memory_stall_pct != null) L.push(`- Memory stall (the kernel's own figure): some tasks waited for memory ${p.memory_stall_pct}% of the last 10 seconds. For information; it is not part of the verdict.`);
  if (p.reasons.length) L.push(`- Why: ${p.reasons.join("; ")}.`);
  if (p.unmeasured?.length && p.verdict !== "not_measured") L.push(`- Not measured: ${p.unmeasured.join(", ")}. The verdict covers only what was measured.`);
  L.push(`- ${r.task_need.note} Suggest closing carries no task need, so closing nothing is a fine outcome.`);

  const tc = r.top_consumers;
  L.push("", `## Top consumers (${tc.scope}; grouped by name)`);
  L.push("", "By memory:", "", table(["Name", "Count", "MB", "CPU %"], tc.by_memory.map((g) => [g.name, g.count, Math.round(g.total_mb), g.cpu_pct])));
  L.push("", "By CPU:", "", tc.by_cpu.length ? table(["Name", "Count", "MB", "CPU %"], tc.by_cpu.map((g) => [g.name, g.count, Math.round(g.total_mb), g.cpu_pct])) : "Nothing measurable over the sample.");
  if (tc.not_shown > 0) L.push("", `${tc.not_shown} other process(es) are not shown (other users, or owner not checked). Use --all to include them.`);

  const b = r.buckets;
  L.push("", "## Suggest closing", "", `Needs two or more signals: a recognised dev leftover that is orphaned or idle over ${IDLE_MIN_AGE_H} h (under ${IDLE_CORE_PCT}% of one core).`, "", bucketTable(b.suggest_closing));
  L.push("", "## Your call", "", `Browsers, and unrecognised processes of yours in user-writable folders above ${BIG_RSS_MB} MB or ${BIG_CPU_MACHINE_PCT}% of the machine's CPU. Only you know which matter.`, "", bucketTable(b.your_call));

  L.push(...analysisLines(r.analysis));

  L.push("", "## Keep");
  const s = b.keep.summary;
  const labels = { protected: "protected (system, security, shells, editors, git, VPN, coding tools, local list)", in_use: "in use", dev_active: "dev tools that look active", not_recognized: "not recognised", small: `small (under ${SMALL_MB} MB)`, owner_unknown: "owner not confirmed", other_user: "other users or service accounts" };
  const rows = Object.entries(labels).filter(([k]) => s[k]).map(([k, label]) => `- ${label}: ${s[k].count} process(es), ${fmtMb(s[k].total_mb)}`);
  L.push(rows.length ? rows.join("\n") : "- nothing");
  if (b.keep.hidden_other_user > 0) L.push(`- ${b.keep.hidden_other_user} process(es) owned by other users are hidden. Use --all to list them.`);
  if (b.keep.listed.length) {
    L.push("", "Listed Keep groups:", "", table(["Name", "Count", "MB", "Why kept"], b.keep.listed.map((g) => [g.name, g.count, Math.round(g.total_mb), g.reasons.join("; ")])));
  }
  L.push(...explainLines(r.explain));
  if (r.notes.length) L.push("", "## Notes", ...r.notes.map((x) => `- ${x}`));
  L.push("", `Scan took ${r.scan_seconds ?? "?"} s over ${r.totals.processes} processes.`, "", READ_ONLY_LINE);
  return L.join("\n");
}
