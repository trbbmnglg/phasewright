// Pure: (recorded peaks, a scan report) -> what the task needs, what is free, and the smallest set of
// "Suggest closing" processes that would cover a memory shortfall. Nothing here touches a process.
//
// Honesty rules built in:
//   no peaks                    -> "no data yet", nothing is picked
//   picks come from Suggest only, largest first, and never from Your call (those are only listed)
//   Suggest candidates are idle by definition, so they free no CPU: a CPU shortfall says so
//   memory freed is "up to" the working set, because shared pages are counted in it
import { NEED_MARGIN, PEAKS_WINDOW, RESERVE_PCT_OF_TOTAL, MIN_TREE_SAMPLES } from "./rules.mjs";
import { READ_ONLY_LINE } from "./report.mjs";

export const NO_DATA_MESSAGE = "No data yet for this task. Run it once through measure.mjs.";

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const mb = (v) => `${Math.round(v).toLocaleString("en-US")} MB`;
const cores = (v) => `${round2(v)} core${round2(v) === 1 ? "" : "s"}`;

// The memory figure one recorded run contributes: the tree peak, or (fewer than 3 tree samples) the machine-level drop.
function memoryOf(peak) {
  const thin = !(peak.samples >= MIN_TREE_SAMPLES);
  if (!thin && isNum(peak.peak_tree_mb)) return { value: peak.peak_tree_mb, basis: "tree", started_iso: peak.started_iso ?? null };
  if (isNum(peak.peak_avail_drop_mb)) return { value: peak.peak_avail_drop_mb, basis: "avail_drop", started_iso: peak.started_iso ?? null };
  if (isNum(peak.peak_tree_mb)) return { value: peak.peak_tree_mb, basis: "tree", started_iso: peak.started_iso ?? null };
  return null;
}

// peaks: the records for one task key, oldest first (peaks.mjs readLast). Only the last PEAKS_WINDOW count.
// report: the scan report (scan.mjs). Returns a plain object; renderHeadroom turns it into text.
export function computeHeadroom({ key, peaks = [], report = null }) {
  const used = peaks.slice(-PEAKS_WINDOW);
  const base = { schema_version: 1, read_only: true, key, status: "ok", peaks_used: used.length, notes: [] };
  const memRows = used.map(memoryOf).filter(Boolean);
  const cpuVals = used.map((p) => p.peak_cpu_cores).filter(isNum);
  if (!used.length || (!memRows.length && !cpuVals.length)) {
    return { ...base, status: "no_data", message: NO_DATA_MESSAGE, memory: null, cpu: null, scan: null };
  }

  const notes = base.notes;
  const p = report?.pressure ?? {};
  const logical = report?.sample?.logical_cpus ?? null;
  const scan = {
    generated_iso: report?.generated_iso ?? null,
    total_mb: p.total_mb ?? null,
    avail_mb: p.avail_mb ?? null,
    cpu_pct: p.cpu_pct ?? null,
    samples: p.samples ?? null,
    logical_cpus: logical,
    verdict: p.verdict ?? null,
    reasons: Array.isArray(p.reasons) ? p.reasons : [],
  };

  // ----- memory -----
  const thinAll = used.every((x) => !(x.samples >= MIN_TREE_SAMPLES));
  if (thinAll) notes.push("Low confidence: every recorded run had fewer than 3 tree samples, so the memory figure comes from the machine-level available-memory drop, which also includes other programs' growth.");
  else if (used.some((x) => !(x.samples >= MIN_TREE_SAMPLES))) notes.push("Some recorded runs had fewer than 3 tree samples; for those the machine-level available-memory drop was used instead of the tree peak.");
  const lateRuns = used.filter((x) => isNum(x.sampled_from_s) && isNum(x.duration_s) && x.duration_s > 0 && x.sampled_from_s / x.duration_s > 0.25);
  if (lateRuns.length) notes.push(`In ${lateRuns.length} of ${used.length} run(s) the first tree sample arrived more than a quarter of the way into the run, so early use is not in those peaks.`);

  let memory = null;
  if (memRows.length) {
    const max = Math.max(...memRows.map((r) => r.value));
    const need = max * NEED_MARGIN;
    const reserve = scan.total_mb == null ? null : (scan.total_mb * RESERVE_PCT_OF_TOTAL) / 100;
    const available = scan.avail_mb == null ? null : scan.avail_mb - (reserve ?? 0);
    memory = {
      need_mb: round1(need),
      need_source: { peaks: memRows.map((r) => ({ value_mb: r.value, basis: r.basis, started_iso: r.started_iso })), max_mb: round1(max), margin: NEED_MARGIN, window: PEAKS_WINDOW },
      available_mb: available == null ? null : round1(available),
      available_source: { scan_avail_mb: scan.avail_mb, reserve_mb: round1(reserve), reserve_pct_of_total: RESERVE_PCT_OF_TOTAL, total_mb: scan.total_mb },
      verdict: available == null ? "unknown" : need <= available ? "fits" : "short",
      short_by_mb: available != null && need > available ? round1(need - available) : 0,
      spare_mb: available != null && need <= available ? round1(available - need) : 0,
      picks: [],
      covered: null,
      could_also_consider: [],
    };
    if (memory.verdict === "short") {
      const suggest = [...(report?.buckets?.suggest_closing ?? [])].sort((a, b) => b.total_mb - a.total_mb || String(a.name).localeCompare(String(b.name)));
      let running = 0;
      for (const g of suggest) {
        if (running >= memory.short_by_mb) break;
        running += g.total_mb;
        memory.picks.push({ name: g.name, count: g.count, up_to_mb: round1(g.total_mb), running_mb: round1(running), confidence: g.confidence ?? null });
      }
      memory.covered = running >= memory.short_by_mb;
      if (!memory.covered) {
        memory.could_also_consider = [...(report?.buckets?.your_call ?? [])]
          .filter((g) => g.total_mb > 0)
          .sort((a, b) => b.total_mb - a.total_mb)
          .map((g) => ({ name: g.name, count: g.count, up_to_mb: round1(g.total_mb), cpu_pct: g.cpu_pct ?? null, reasons: g.reasons ?? [] }));
      }
    }
  } else {
    notes.push("No memory figure was recorded for this task (no tree samples and no machine samples).");
  }

  // ----- CPU -----
  let cpu = null;
  if (cpuVals.length) {
    const need = Math.max(...cpuVals) * NEED_MARGIN;
    const available = scan.cpu_pct == null || logical == null ? null : ((100 - scan.cpu_pct) / 100) * logical;
    cpu = {
      need_cores: round2(need),
      need_source: { peaks_cores: cpuVals, max_cores: round2(Math.max(...cpuVals)), margin: NEED_MARGIN, window: PEAKS_WINDOW },
      available_cores: available == null ? null : round2(available),
      available_source: { cpu_pct: scan.cpu_pct, logical_cpus: logical },
      verdict: available == null ? "unknown" : need <= available ? "fits" : "short",
      short_by_cores: available != null && need > available ? round2(need - available) : 0,
      suggest_closing_frees_cpu: false,
      suggest_cpu_cores: null,
      busy_your_call: [],
      note: null,
    };
    notes.push("CPU is a lower bound: a process that starts and ends between two samples (2 s apart) leaves no CPU in the figure, so a task made of many short processes needs more than shown.");
    if (cpu.verdict === "short") {
      const toCores = (pct) => (logical == null ? null : round2((pct / 100) * logical));
      const suggest = report?.buckets?.suggest_closing ?? [];
      cpu.suggest_cpu_cores = toCores(suggest.reduce((a, g) => a + (g.cpu_pct ?? 0), 0));
      cpu.busy_your_call = [...(report?.buckets?.your_call ?? [])]
        .filter((g) => (g.cpu_pct ?? 0) > 0)
        .sort((a, b) => b.cpu_pct - a.cpu_pct)
        .map((g) => ({ name: g.name, count: g.count, cpu_pct: g.cpu_pct, cores: toCores(g.cpu_pct) }));
      cpu.note = suggest.length
        ? "The Suggest closing candidates are idle by definition, so closing them frees no CPU."
        : "There are no Suggest closing candidates, and they would be idle anyway, so they would free no CPU.";
    }
  } else {
    notes.push("No CPU figure was recorded for this task (it needs at least two tree samples), so CPU is not compared.");
  }

  if (scan.verdict && scan.verdict !== "none") notes.push(`The scan says the machine is under ${scan.verdict} pressure right now${scan.reasons.length ? `: ${scan.reasons.join("; ")}` : ""}.`);
  return { ...base, memory, cpu, scan, picks_from: "Suggest closing only" };
}

// Human text for a computeHeadroom result. Ends with the phase 1 read-only line.
export function renderHeadroom(r, { platform = "", generatedIso = null } = {}) {
  const L = [];
  L.push(`# Headroom for "${r.key}"${platform ? ` (${platform}${generatedIso ? `, ${generatedIso}` : ""})` : ""}`);
  if (r.status === "no_data") {
    L.push("", r.message, "", "Nothing is recommended without a measurement.", "", READ_ONLY_LINE);
    return L.join("\n");
  }
  L.push("", `Based on the last ${r.peaks_used} run(s) of this task and one scan${r.scan?.generated_iso ? ` taken at ${r.scan.generated_iso}` : ""}. The margin, reserve and window are starting values, not tuned.`);

  const m = r.memory;
  if (m) {
    const src = m.need_source;
    L.push("", "## Memory");
    L.push(`- Need: ${mb(m.need_mb)} = the largest of the last ${src.peaks.length} recorded peak(s) (${src.peaks.map((x) => `${mb(x.value_mb)} ${x.basis === "tree" ? "tree peak" : "available-memory drop"}`).join(", ")}) = ${mb(src.max_mb)}, times ${src.margin} margin.`);
    if (m.available_mb == null) L.push("- Available: not measured.");
    else {
      const a = m.available_source;
      L.push(`- Available: ${mb(m.available_mb)} = ${mb(a.scan_avail_mb)} available in the scan, minus a ${mb(a.reserve_mb ?? 0)} reserve (${a.reserve_pct_of_total}% of ${a.total_mb == null ? "total" : mb(a.total_mb)}) kept for the operating system.`);
    }
    if (m.verdict === "fits") L.push(`- Verdict: fits, with ${mb(m.spare_mb)} to spare. Nothing needs closing for memory.`);
    else if (m.verdict === "short") {
      L.push(`- Verdict: short by ${mb(m.short_by_mb)}.`);
      if (m.picks.length) {
        L.push("", "Smallest set from Suggest closing (largest first; each figure is \"up to\" because shared pages are counted in a working set):");
        m.picks.forEach((x, i) => L.push(`  ${i + 1}. ${x.name} x${x.count}: up to ${mb(x.up_to_mb)}, total ${mb(x.running_mb)} of ${mb(m.short_by_mb)} short`));
        L.push(m.covered ? `- This set would cover the shortfall (up to ${mb(m.picks[m.picks.length - 1].running_mb)} against ${mb(m.short_by_mb)}).` : `- Even all of Suggest closing (up to ${mb(m.picks[m.picks.length - 1].running_mb)}) is not enough.`);
      } else L.push("- Suggest closing is empty, so there is nothing safe to pick.");
      if (m.could_also_consider.length) {
        L.push("", "You could also consider these (your call; they are not picked, and only you know which matter):");
        for (const x of m.could_also_consider) L.push(`  - ${x.name} x${x.count}: up to ${mb(x.up_to_mb)}${x.cpu_pct ? `, ${x.cpu_pct}% of the machine's CPU` : ""}`);
      }
    } else L.push("- Verdict: unknown (available memory was not measured).");
  }

  const c = r.cpu;
  if (c) {
    const src = c.need_source;
    L.push("", "## CPU");
    L.push(`- Need: ${cores(c.need_cores)} = the largest of the last ${src.peaks_cores.length} recorded peak(s) (${src.peaks_cores.map(cores).join(", ")}) = ${cores(src.max_cores)}, times ${src.margin} margin.`);
    if (c.available_cores == null) L.push("- Available: not measured.");
    else L.push(`- Available: ${cores(c.available_cores)} = (100 - ${c.available_source.cpu_pct}% busy in the scan) of ${c.available_source.logical_cpus} logical CPUs.`);
    if (c.verdict === "fits") L.push("- Verdict: fits.");
    else if (c.verdict === "short") {
      L.push(`- Verdict: short by ${cores(c.short_by_cores)}.`);
      L.push(`- ${c.note}${c.suggest_cpu_cores != null && c.suggest_cpu_cores > 0 ? ` (they use ${cores(c.suggest_cpu_cores)} between them.)` : ""}`);
      if (c.busy_your_call.length) {
        L.push("", "Busy processes of yours that use CPU right now (your call; they are not picked):");
        for (const x of c.busy_your_call) L.push(`  - ${x.name} x${x.count}: ${x.cpu_pct}% of the machine${x.cores != null ? ` (${cores(x.cores)})` : ""}`);
      } else L.push("- No Your call process is using CPU right now either, so the load is from processes this tool does not list (protected or other users').");
    } else L.push("- Verdict: unknown (CPU was not measured).");
  }

  if (r.notes.length) L.push("", "## Notes", ...r.notes.map((x) => `- ${x}`));
  L.push("", READ_ONLY_LINE);
  return L.join("\n");
}
