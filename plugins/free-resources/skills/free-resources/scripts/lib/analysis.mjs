// The analysis part of the report: for each process group the report lists, what it is, why it is heavy, what to do about
// it and what closing it would give; and a summary of the pressure, the freeable total, the heaviest things that are off
// limits and why, and advice for virtual machines and background daemons. A pure function over the report's own numbers.
//
// What a thing IS comes from fixed tables keyed by the recognised tool or category, never from text the process
// supplies about itself. Every name that is printed passes through safeName. Nothing here runs anything: the advice
// names a tool's own stop command for the person to run, the way that tool's own documentation gives it.
import { normName, protectedCategory } from "./classify.mjs";
import { safeName } from "./sanitize.mjs";
import { ADVICE_MIN_MB } from "./rules.mjs";

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const fmtMb = (mb) => (mb >= 1024 ? `${round1(mb / 1024)} GB` : `${Math.round(mb)} MB`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What a recognised dev tool is. Plain descriptions of the tools; "left over" is the classifier's judgement, not the table's.
const WHAT_TOOL = {
  workerd: "workerd, the local runtime that Cloudflare's wrangler dev runs a Worker in",
  esbuild: "esbuild, a JavaScript bundler that dev servers and build watchers keep running",
  vite: "a Vite dev server",
  wrangler: "Cloudflare's wrangler tool (a dev server or a command)",
  nodemon: "nodemon, which restarts a Node program when its files change",
  "ts-node": "ts-node, which runs TypeScript directly",
  webpack: "webpack, a bundler or dev server",
  next: "a Next.js dev server or build",
  tsx: "tsx, which runs TypeScript and ESM directly",
  "playwright browser": "a browser that Playwright downloaded for tests",
};
const WHAT_CATEGORY = {
  browser: "a web browser: its tabs, extensions and background pages use the memory",
  heavy: "a program of yours that is not recognised and uses a lot of memory or CPU",
  dev_busy: "a dev tool that is working right now",
};

function whatIs(g) {
  if (g.category === "dev_leftover" || g.category === "dev_busy") return WHAT_TOOL[g.tool] ?? (g.tool ? `the dev tool ${safeName(g.tool)}` : WHAT_CATEGORY[g.category]);
  return WHAT_CATEGORY[g.category] ?? "a process that is not recognised";
}

function actionFor(bucket, g) {
  if (bucket === "suggest_closing") return "Close it yourself where you started it (the terminal or the editor task that runs it). This skill only reports.";
  if (g.category === "browser") return "Close the tabs and windows you do not need; only you know which matter.";
  if (g.category === "dev_busy") return "It is working right now. Leave it, or stop it where you started it once it has finished.";
  return "Find out what it is. If you do not need it, close it from the program itself.";
}

function gainFor(bucket, g) {
  if (bucket === "suggest_closing") return { memory_up_to_mb: g.total_mb, cpu: "none: it is idle" };
  return { memory_up_to_mb: g.total_mb, cpu: g.cpu_pct > 0 ? `${g.cpu_pct}% of the machine's CPU, if it is the one using it` : "none measured" };
}

function whyHeavy(g, totalMb) {
  const share = totalMb > 0 ? ` (${round1((g.total_mb / totalMb) * 100)}% of this machine's memory)` : "";
  const cpu = g.cpu_pct > 0 ? ` and ${g.cpu_pct}% of the machine's CPU` : ", with no measurable CPU";
  return `${plural(g.count, "process", "processes")} using ${fmtMb(g.total_mb)}${share}${cpu}. ${g.reasons.join("; ")}.`;
}

// One sentence for the pressure verdict, naming anything that was not measured.
export function pressureLine(p) {
  const missing = p.unmeasured?.length ? ` (${p.unmeasured.join(" and ")} not measured)` : "";
  if (p.verdict === "not_measured") return "Pressure could not be measured on this machine, so nothing here is judged against it.";
  if (p.verdict === "none") return `No memory, paging or CPU pressure in what was measured${missing}.`;
  return `Pressure: ${p.verdict}${p.reasons.length ? ` (${p.reasons.join("; ")})` : ""}${missing}.`;
}

// Virtual machines and daemons that have their own way to stop. Each entry names the command as the tool's own
// documentation gives it and says only what that documentation says it ends. `checked` is the date the page was read.
export const ADVICE = [
  {
    id: "wsl",
    label: "the WSL 2 virtual machine",
    match: (r) => ["vmmem", "vmmemwsl"].includes(normName(r.name)),
    command: "wsl --shutdown",
    ends: "all running WSL distributions and the WSL 2 virtual machine, and so everything running inside them (an editor's remote session, a Docker engine that lives in WSL)",
    source: "https://learn.microsoft.com/en-us/windows/wsl/basic-commands",
    checked: "2026-10-31",
  },
  {
    id: "docker-desktop",
    label: "Docker Desktop",
    match: (r) => ["com.docker.backend", "docker desktop", "com.docker.build"].includes(normName(r.name)),
    command: "docker desktop stop",
    ends: "Docker Desktop. Its containers run inside it, and its documentation does not say what happens to them, so save their work first",
    source: "https://docs.docker.com/reference/cli/docker/desktop/stop/",
    checked: "2026-11-01",
  },
  {
    id: "podman",
    label: "the Podman virtual machine",
    match: (r) => normName(r.name) === "podman" || /\bpodman machine\b/i.test(r.cmd_full ?? ""),
    command: "podman machine stop",
    ends: "the Linux virtual machine where Podman's containers run; the documentation does not say what happens to running containers, so save their work first",
    source: "https://docs.podman.io/en/latest/markdown/podman-machine-stop.1.html",
    checked: "2026-11-01",
  },
  {
    id: "gradle",
    label: "Gradle daemons",
    match: (r) => /org\.gradle\.launcher\.daemon\.bootstrap\.GradleDaemon/.test(r.cmd_full ?? ""),
    command: "gradle --stop",
    ends: "all Gradle daemons that were started with the same Gradle version",
    note: "Gradle also stops an idle daemon by itself after 3 hours.",
    source: "https://docs.gradle.org/current/userguide/gradle_daemon.html",
    checked: "2026-10-31",
  },
  {
    id: "kotlin",
    label: "the Kotlin compile daemon",
    match: (r) => /KotlinCompileDaemon/.test(r.cmd_full ?? ""),
    command: "gradle --stop",
    ends: "the Gradle daemons; the Kotlin daemon stops with the Gradle daemon",
    note: "It also stops by itself after two idle hours.",
    source: "https://kotlinlang.org/docs/gradle-compilation-and-caches.html",
    checked: "2026-10-31",
  },
  {
    id: "android-emulator",
    label: "the Android emulator",
    match: (r) => /^qemu-system-/.test(normName(r.name)) && /\bavd\b|android/i.test(r.cmd_full ?? ""),
    command: null,
    ends: "the emulator",
    note: "Close the emulator window, as the Android documentation says.",
    source: "https://developer.android.com/studio/run/emulator-commandline",
    checked: "2026-10-31",
  },
];

function adviceFor(records) {
  const out = [];
  for (const a of ADVICE) {
    const hits = records.filter(a.match);
    const mb = hits.reduce((s, r) => s + (r.rss_mb ?? 0), 0);
    if (!hits.length || mb < ADVICE_MIN_MB) continue;
    out.push({ id: a.id, target: a.label, processes: hits.length, memory_mb: round1(mb), command: a.command, ends: a.ends, note: a.note ?? null, source: a.source, checked: a.checked });
  }
  return out.sort((x, y) => y.memory_mb - x.memory_mb);
}

const SECURITY = "security and endpoint protection";
// A protected-list match names the entry that matched; the summary says only that a list did, since it is the part most
// likely to be copied into a ticket. The Keep tables and --explain still show the matching entry for that one process.
const whyOffLimits = (reason) => (/^in the local protected list/.test(reason) ? "in a protected list that you or your organization set" : reason);

// The heaviest groups that are protected or belong to another account, with the reason each is never offered.
// Other people's processes are counted but not named (the report hides them without --all); the names that are shown are
// your own protected processes and system or service accounts, which is where security and management agents run.
function offLimits(decisions, showAll) {
  const groups = new Map();
  const shown = (d) => showAll || d.category === "protected" || d.reasons[0] === "system or service account";
  const hidden = { count: 0, total_mb: 0 };
  for (const d of decisions) {
    if (d.bucket !== "keep" || (d.category !== "protected" && d.category !== "other_user")) continue;
    if (!shown(d)) {
      hidden.count += 1;
      hidden.total_mb += d.rss_mb ?? 0;
      continue;
    }
    const key = `${normName(d.name)}|${d.category}`;
    const g = groups.get(key) ?? { name: safeName(d.name), count: 0, total_mb: 0, why: whyOffLimits(d.reasons[0] ?? ""), category: d.category, security: protectedCategory(d.name) === SECURITY };
    g.count += 1;
    g.total_mb += d.rss_mb ?? 0;
    groups.set(key, g);
  }
  const all = [...groups.values()];
  const heaviest = all.sort((a, b) => b.total_mb - a.total_mb).slice(0, 5).map((g) => ({ name: g.name, count: g.count, total_mb: round1(g.total_mb), why: g.why, security: g.security }));
  return {
    processes: all.reduce((s, g) => s + g.count, 0) + hidden.count,
    total_mb: round1(all.reduce((s, g) => s + g.total_mb, 0) + hidden.total_mb),
    heaviest,
    other_users: { processes: hidden.count, total_mb: round1(hidden.total_mb) },
    note: "These are never offered for closing. If one of them is the problem, ask whoever manages this machine.",
  };
}

// report: the pieces buildReport has already made. Returns { summary, items }.
export function analyze({ records, classification, pressure, numbered, all = false }) {
  const totalMb = pressure.total_mb ?? 0;
  const items = [];
  for (const [bucket, groups] of [["suggest_closing", numbered.suggest_closing], ["your_call", numbered.your_call]]) {
    for (const g of groups) {
      items.push({
        ref: `${bucket}#${g.n}`,
        name: safeName(g.name),
        what: whatIs(g),
        why_heavy: whyHeavy(g, totalMb),
        action: actionFor(bucket, g),
        gain: gainFor(bucket, g),
      });
    }
  }
  return {
    summary: {
      pressure: pressureLine(pressure),
      freeable_up_to_mb: round1(numbered.suggest_closing.reduce((s, g) => s + g.total_mb, 0)),
      freeable_note: "Up to, because a process's working set counts pages it shares with others. Only the Suggest closing groups are counted.",
      off_limits: offLimits(classification.decisions, all),
      advice: adviceFor(records),
    },
    items,
  };
}
