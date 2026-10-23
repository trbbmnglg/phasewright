// Builds the report: stable JSON (schema_version 1) and the human text with numbered tables.
// Only the normalized fields are printed. The full command line never leaves the scanner.
import { DEFAULT_TOP, IDLE_CORE_PCT, IDLE_MIN_AGE_H, BIG_RSS_MB, BIG_CPU_MACHINE_PCT, SMALL_MB } from "./rules.mjs";

export const SCHEMA_VERSION = 1;
export const READ_ONLY_LINE = "Nothing was closed. This scan is read-only.";
export const MAC_NOTE = "Mac support is untested: it was written from documented commands and checked against sample data only.";

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
    .map((g) => ({ ...g, total_mb: round1(g.total_mb), cpu_pct: round1(g.cpu_pct) }));
}

// input: { platform, records, classification, pressure, me:{user}, opts:{all,top}, meta:{now_iso, scan_seconds,
//          interval_s, logical_cpus, local_protected:{source,warning}, project_dir} }
export function buildReport({ platform, records, classification, pressure, me, opts = {}, meta = {} }) {
  const top = Number.isInteger(opts.top) && opts.top > 0 ? opts.top : DEFAULT_TOP;
  const visible = opts.all ? records : records.filter((r) => r.owner != null && ownerUser(r.owner) === ownerUser(me?.user));
  const notes = [];
  if (platform === "darwin") notes.push(MAC_NOTE);
  if (meta.local_protected?.warning) notes.push(meta.local_protected.warning);
  for (const w of pressure.warnings ?? []) notes.push(w);
  let n = 0;
  const number = (g) => ({ n: ++n, ...g });
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
      total_mb: pressure.total_mb,
      avail_mb: pressure.avail_mb,
      avail_pct: pressure.avail_pct,
      paging_per_s: pressure.paging_per_s,
      cpu_pct: pressure.cpu_pct,
      samples: pressure.samples,
      thresholds: pressure.thresholds,
      thresholds_are_starting_values: true,
    },
    task_need: { available: false, note: "No task need is attached yet. The need-versus-available verdict arrives in phase 2." },
    top_consumers: {
      scope: opts.all ? "all processes" : "your own processes",
      by_memory: topGroups(visible, "total_mb", top),
      by_cpu: topGroups(visible, "cpu_pct", top),
      not_shown: records.length - visible.length,
    },
    buckets: {
      suggest_closing: classification.suggest.map(number),
      your_call: classification.your_call.map(number),
      keep: {
        summary: classification.keep.summary,
        listed: classification.keep.groups.map((g) => ({ ...g, members: undefined })),
        hidden_other_user: classification.keep.hidden_other_user,
      },
    },
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

export function renderHuman(r) {
  const p = r.pressure;
  const t = p.thresholds;
  const L = [];
  L.push(`# Free-resources scan (${r.platform}, ${r.generated_iso ?? "no timestamp"})`);
  if (r.mac_untested) L.push("", `> ${MAC_NOTE}`);
  L.push("", `## Pressure now: ${p.verdict === "none" ? "no pressure" : `${p.verdict} pressure`}`);
  const num = (v, unit) => (v == null ? "not measured" : `${v}${unit}`);
  L.push(
    `- Memory available: ${p.avail_mb == null ? "not measured" : `${fmtMb(p.avail_mb)} of ${fmtMb(p.total_mb)} (${num(p.avail_pct, "%")})`}. Memory pressure below ${t.memory_available_pct_below}% available.`,
    `- Paging: ${num(p.paging_per_s, " pages/s")}. Memory pressure above ${t.paging_per_s_above} pages/s.`,
    `- CPU: ${num(p.cpu_pct, "%")} average over ${p.samples || "no"} sample(s). CPU pressure at ${t.cpu_avg_pct_at_least}% or more.`,
    "- These thresholds are starting values, not tuned for this machine.",
  );
  if (p.reasons.length) L.push(`- Why: ${p.reasons.join("; ")}.`);
  L.push(`- ${r.task_need.note} Until then, Suggest closing carries no task need: closing nothing is a fine outcome.`);

  const tc = r.top_consumers;
  L.push("", `## Top consumers (${tc.scope}; grouped by name)`);
  L.push("", "By memory:", "", table(["Name", "Count", "MB", "CPU %"], tc.by_memory.map((g) => [g.name, g.count, Math.round(g.total_mb), g.cpu_pct])));
  L.push("", "By CPU:", "", tc.by_cpu.length ? table(["Name", "Count", "MB", "CPU %"], tc.by_cpu.map((g) => [g.name, g.count, Math.round(g.total_mb), g.cpu_pct])) : "Nothing measurable over the sample.");
  if (tc.not_shown > 0) L.push("", `${tc.not_shown} other process(es) are not shown (other users, or owner not checked). Use --all to include them.`);

  const b = r.buckets;
  L.push("", "## Suggest closing", "", `Needs two or more signals: a recognised dev leftover that is orphaned or idle over ${IDLE_MIN_AGE_H} h (under ${IDLE_CORE_PCT}% of one core).`, "", bucketTable(b.suggest_closing));
  L.push("", "## Your call", "", `Browsers, and unrecognised processes of yours in user-writable folders above ${BIG_RSS_MB} MB or ${BIG_CPU_MACHINE_PCT}% of the machine's CPU. Only you know which matter.`, "", bucketTable(b.your_call));

  L.push("", "## Keep");
  const s = b.keep.summary;
  const labels = { protected: "protected (system, security, shells, editors, git, VPN, coding tools, local list)", in_use: "in use", dev_active: "dev tools that look active", not_recognized: "not recognised", small: `small (under ${SMALL_MB} MB)`, owner_unknown: "owner not confirmed", other_user: "other users or service accounts" };
  const rows = Object.entries(labels).filter(([k]) => s[k]).map(([k, label]) => `- ${label}: ${s[k].count} process(es), ${fmtMb(s[k].total_mb)}`);
  L.push(rows.length ? rows.join("\n") : "- nothing");
  if (b.keep.hidden_other_user > 0) L.push(`- ${b.keep.hidden_other_user} process(es) owned by other users are hidden. Use --all to list them.`);
  if (b.keep.listed.length) {
    L.push("", "Listed Keep groups:", "", table(["Name", "Count", "MB", "Why kept"], b.keep.listed.map((g) => [g.name, g.count, Math.round(g.total_mb), g.reasons.join("; ")])));
  }
  if (r.notes.length) L.push("", "## Notes", ...r.notes.map((x) => `- ${x}`));
  L.push("", `Scan took ${r.scan_seconds ?? "?"} s over ${r.totals.processes} processes.`, "", READ_ONLY_LINE);
  return L.join("\n");
}
