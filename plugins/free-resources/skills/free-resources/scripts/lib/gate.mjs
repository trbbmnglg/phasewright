// The stop gate. A pure function: from facts read about one process at this moment, it decides whether that process may
// be stopped. It is separate from the classifier on purpose: the classifier decides what a report shows; the gate decides
// again, freshly, right before anything is signalled. No I/O, no clock, no randomness, no environment.
//
// Every check answers yes, no or unknown, and a process may be stopped only when every check says yes. A field that is
// missing, null, of the wrong type or has a value the check does not expect is "unknown", and unknown refuses. Nothing on
// the command line or in the environment changes a rule; the protected lists and the "stop": false setting can only add
// refusals. Facts come from lib/facts.mjs (and, on Windows, from a handle held open on the process: lib/pin-windows.mjs).
import { normName, protectedCategory, localProtectedReason, projectPaths, ancestorsAndDescendants, devTool as recognise } from "./classify.mjs";
import { isSystemPath, isAbsolutePath, isUnder, normalizePath } from "./paths.mjs";
import { DEV_RUNTIMES, SHELLS } from "./rules.mjs";
import { safeName } from "./sanitize.mjs";
import { baseName } from "./text.mjs";

export const YES = "yes";
export const NO = "no";
export const UNKNOWN = "unknown";

// Walking up from a process to whatever started it: a shell or terminal is a person's own launcher, so reaching one
// first is fine. Reaching one of these first means an editor, an assistant, a security or remote-access tool or the
// operating system started it, and it is theirs to manage.
export const LAUNCHER_CATEGORIES = new Set(["terminals and shells"]);
export const BLOCKING_CATEGORIES = new Set([
  "operating system core", "Linux system services and desktop", "security and endpoint protection", "editors and IDEs",
  "ssh, VPN and remote desktop", "coding assistants and this tool",
]);
// The nearest of these above this tool is the session it runs in (the editor or assistant), and everything below that is
// off limits while it runs.
export const SESSION_ROOT_CATEGORIES = new Set(["editors and IDEs", "coding assistants and this tool"]);
// Windows mandatory integrity level of a normal, unelevated program (SECURITY_MANDATORY_MEDIUM_RID).
export const INTEGRITY_MEDIUM = 0x2000;
// The scan's start time and the start time read now may differ by rounding (Windows reports them in different units).
export const START_TOLERANCE_MS = 2000;
const MAX_CHAIN = 64;
const PLATFORMS = new Set(["win32", "linux", "darwin"]);
// Process states as /proc/<pid>/stat gives them (proc_pid_stat(5)), and as macOS `ps -o stat` gives them (a state letter
// and flags). Anything else is not a state, so it is unknown.
const LINUX_STATES = /^[RSDZTtWXxKPI]$/;
const MAC_STATES = /^[IRSTUZ][+<>AELNSsuVWX]*$/;

const isInt = (v) => Number.isSafeInteger(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isBool = (v) => typeof v === "boolean";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const yes = (id, detail) => ({ id, result: YES, detail });
const no = (id, detail) => ({ id, result: NO, detail });
const unknown = (id, detail) => ({ id, result: UNKNOWN, detail });

// Linux user and group ids: real, effective, saved and file-system, each a non-negative integer.
const idsOk = (ids) => isObj(ids) && ["real", "effective", "saved", "fs"].every((k) => isInt(ids[k]) && ids[k] >= 0);
// A capability mask from /proc/<pid>/status: true when empty, false when any capability is held, null when unreadable.
const capsEmpty = (v) => (typeof v === "string" && /^[0-9a-fA-F]{16}$/.test(v) ? /^0{16}$/.test(v) : null);

// The program's path as the facts give it.
export const programPath = (platform, facts) => (platform === "win32" ? facts?.image_path : facts?.exe);

// ---------- the checks ----------

function stoppingOn(protection) {
  const id = "stopping_on";
  if (!isObj(protection) || !isBool(protection.stop_allowed)) return unknown(id, "the protected lists could not be read");
  if (!protection.stop_allowed) {
    const why = Array.isArray(protection.stop_blockers) && protection.stop_blockers.length ? protection.stop_blockers.join("; ") : "a protected list";
    return no(id, `stopping is switched off (${why})`);
  }
  return yes(id, "no protected list switches stopping off");
}

function notElevated(platform, me) {
  const id = "not_elevated";
  const f = me?.facts;
  if (!isObj(f)) return unknown(id, "this tool's own rights could not be read");
  if (platform === "win32") {
    if (!isBool(f.elevated) || !isInt(f.integrity_rid) || !isBool(f.debug_privilege)) return unknown(id, "this tool's own rights could not be read");
    if (f.elevated) return no(id, "this runs elevated (as administrator); run it as yourself, in a normal terminal");
    if (f.integrity_rid !== INTEGRITY_MEDIUM) return no(id, "this does not run at the normal (medium) integrity level");
    if (f.debug_privilege) return no(id, "this runs with the debug privilege");
    return yes(id, "runs as you, not elevated");
  }
  if (!isBool(me.sudo)) return unknown(id, "could not tell whether this was started through sudo");
  if (platform === "linux") {
    const caps = capsEmpty(f.cap_eff);
    if (!idsOk(f.uid) || caps === null) return unknown(id, "this tool's own ids could not be read");
    if (f.uid.real === 0 || f.uid.effective === 0) return no(id, "this runs as root");
    if (f.uid.effective !== f.uid.real) return no(id, "this runs with another user's rights");
    if (me.sudo) return no(id, "this was started through sudo");
    if (!caps) return no(id, "this holds capabilities");
    return yes(id, "runs as you, not root");
  }
  if (!isInt(f.uid) || !isInt(f.ruid)) return unknown(id, "this tool's own ids could not be read");
  if (f.uid === 0 || f.ruid === 0) return no(id, "this runs as root");
  if (f.uid !== f.ruid) return no(id, "this runs with another user's rights");
  if (me.sudo) return no(id, "this was started through sudo");
  return yes(id, "runs as you, not root");
}

function devTool(platform, decision, record, facts) {
  const id = "dev_tool";
  if (!isObj(decision)) return unknown(id, "the scan did not see this process");
  const leftover = decision.bucket === "suggest" && decision.category === "dev_leftover";
  const busy = decision.bucket === "your_call" && decision.category === "dev_busy";
  if (!(leftover || busy) || !isStr(decision.tool)) return no(id, "not a recognised dev tool that is left over or busy; only those can be stopped");
  // The label is worked out again from the program read now, not taken from the scan: a name or a command line alone
  // must not make a program look like a dev tool.
  const path = programPath(platform, facts);
  if (!isStr(path)) return unknown(id, "its program could not be read");
  if (recognise({ name: baseName(path), exe: path, cmd_full: record?.cmd_full ?? null }) !== decision.tool) return no(id, "its program is not the recognised dev tool the scan named");
  return yes(id, `a recognised dev tool (${safeName(decision.tool)}) that is ${leftover ? "left over" : "busy"}`);
}

function sameProcess(record, facts) {
  const id = "same_process";
  if (!isObj(record) || !isObj(facts) || !isInt(record.pid) || !isInt(facts.pid)) return unknown(id, "the process could not be read");
  if (record.pid !== facts.pid) return no(id, "the facts read are for another process");
  const a = Date.parse(record.start_iso ?? "");
  const b = Date.parse(facts.start_iso ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return unknown(id, "its start time could not be read");
  if (Math.abs(a - b) > START_TOLERANCE_MS) return no(id, "the process with this number is not the one the scan saw (that one ended and the number was reused)");
  return yes(id, "the same process the scan saw");
}

function notProtected(platform, record, facts, protection) {
  const id = "not_protected";
  const path = programPath(platform, facts);
  if (!isStr(record?.name) || !isStr(path)) return unknown(id, "its name or program could not be read");
  for (const n of [record.name, baseName(path), facts?.name].filter(isStr)) {
    const cat = protectedCategory(n);
    if (cat) return no(id, `protected: ${cat}`);
  }
  if (!isObj(protection) || !Array.isArray(protection.names) || !Array.isArray(protection.paths)) return unknown(id, "the protected lists could not be read");
  if (localProtectedReason({ name: record.name, exe: path, cmd_full: record.cmd_full }, protection) || localProtectedReason({ name: baseName(path), exe: path, cmd_full: null }, protection)) {
    return no(id, "in a protected list that you or your organization set");
  }
  return yes(id, "not on any protected list");
}

// A home folder the exception below can trust: absolute, not a system folder and at least two levels deep (never a drive
// or file-system root). The caller passes the account's own profile folder, not one taken from the environment.
const usableHome = (home, platform) => isStr(home) && isAbsolutePath(home, platform) && !isSystemPath(home, platform) && normalizePath(home).split("/").filter(Boolean).length >= 2;

function notSystemPath(platform, record, facts, home, canonicalPath) {
  const id = "not_system_path";
  const path = programPath(platform, facts);
  if (!isStr(path) || !isAbsolutePath(path, platform)) return unknown(id, "its program's path could not be read");
  if (!isSystemPath(path, platform)) return yes(id, "runs from a folder of yours");
  // A runtime (node, bun, deno) installed in a system folder running a dev tool from your own home folder is your dev
  // server. Anything else in a system folder is a system program. The project folder does not count here: it comes from
  // the command line. Paths are compared in their long form (a short 8.3 spelling of the home folder is still home).
  const runtime = DEV_RUNTIMES.includes(normName(baseName(path)));
  if (!runtime) return no(id, "runs from a system or program-install folder");
  const canon = typeof canonicalPath === "function" ? canonicalPath : (p) => p;
  const homeLong = isStr(home) ? canon(home) : home;
  if (!usableHome(homeLong, platform)) return unknown(id, "your home folder could not be read");
  const paths = projectPaths(record, platform).map(canon);
  if (paths.length && paths.every((p) => isUnder(p, homeLong) && !isSystemPath(p, platform))) return yes(id, "a runtime in a system folder, running your own dev tool from your home folder");
  return no(id, "runs from a system or program-install folder");
}

function sameOwner(platform, facts, me) {
  const id = "same_owner";
  const mine = me?.facts;
  if (!isObj(facts) || !isObj(mine)) return unknown(id, "the owner could not be read");
  if (platform === "win32") {
    if (!isStr(facts.sid) || !isStr(mine.sid)) return unknown(id, "the owner could not be read");
    return facts.sid === mine.sid ? yes(id, "owned by your account") : no(id, "owned by another account");
  }
  if (platform === "linux") {
    if (!idsOk(facts.uid) || !idsOk(facts.gid) || !idsOk(mine.uid) || !idsOk(mine.gid)) return unknown(id, "the owner could not be read");
    const u = mine.uid.real;
    const g = mine.gid.real;
    const all = [facts.uid.real, facts.uid.effective, facts.uid.saved].every((v) => v === u) && [facts.gid.real, facts.gid.effective, facts.gid.saved].every((v) => v === g);
    return all ? yes(id, "your user and group, with no other ids") : no(id, "its user or group ids are not all yours (another user's, or a setuid or setgid program)");
  }
  const keys = ["uid", "ruid", "svuid", "gid", "rgid", "svgid"];
  if (!keys.every((k) => isInt(facts[k]) && facts[k] >= 0 && isInt(mine[k]) && mine[k] >= 0)) return unknown(id, "the owner could not be read");
  if (mine.uid !== mine.ruid || mine.uid !== mine.svuid || mine.gid !== mine.rgid || mine.rgid !== mine.svgid) return no(id, "this tool itself runs with mixed user or group ids");
  const all = [facts.uid, facts.ruid, facts.svuid].every((v) => v === mine.uid) && [facts.gid, facts.rgid, facts.svgid].every((v) => v === mine.rgid);
  return all ? yes(id, "your user and group, with no other ids") : no(id, "its user or group ids are not all yours (another user's, or a setuid or setgid program)");
}

// Outside Windows the first process adopts every orphan, and on Linux the user's own systemd does too: they are where the
// chain of an orphan ends, not what started it.
const isAdopter = (platform, a) => (platform !== "win32" && a.pid === 1) || (platform === "linux" && normName(a.name) === "systemd" && a.ppid === 1);

// The records above `record`, nearest first. It stops where the chain ends: a parent that is gone, a parent that started
// after its child (the number was reused), or, outside Windows, the first process (pid 1). `complete` is false when a
// parent number could not be read (missing, negative or 0 below the first process) or the chain was too long to follow.
export function ancestorsOf(record, records, platform = "win32") {
  const byPid = new Map((records ?? []).map((r) => [r.pid, r]));
  const out = [];
  let child = record;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const p = child?.ppid;
    if (!isInt(p) || p <= 0) return { chain: out, complete: false, end: "its parent could not be read" };
    const parent = byPid.get(p);
    if (!parent) return { chain: out, complete: true, end: "its parent is gone" };
    const ps = Date.parse(parent.start_iso ?? "");
    const cs = Date.parse(child.start_iso ?? "");
    if (Number.isFinite(ps) && Number.isFinite(cs) && ps > cs) return { chain: out, complete: true, end: "its parent is gone (the number was reused)" };
    out.push(parent);
    if (platform !== "win32" && parent.pid === 1) return { chain: out, complete: true, end: "adopted by the first process" };
    child = parent;
  }
  return { chain: out, complete: false, end: "the chain is too long to follow" };
}

// Categories that are never the session this tool runs in: a shell or terminal is a launcher, and the system is the system.
const NOT_A_SESSION = new Set(["terminals and shells", "operating system core", "Linux system services and desktop"]);

// The processes whose whole subtree is this tool's own session: the nearest editor or assistant above it (by name), and,
// whatever its name, the nearest process above it that is not a shell or terminal (the program that runs this tool,
// through however many shells: Git Bash on Windows nests three). An assistant installed through npm runs as plain
// `node`, so a name alone would miss it. In a person's own terminal that walk reaches the system (explorer, login,
// launchd), which is no session. Null when this tool cannot see what started it: its own parent is missing or is the
// first process, or the chain ends after shells alone, with no terminal window (started detached).
function sessionRoots(platform, records, mePid) {
  const meRec = records.find((r) => r?.pid === mePid);
  const { chain } = ancestorsOf(meRec, records, platform);
  if (!chain.length || isAdopter(platform, chain[0])) return null;
  const roots = [];
  const named = chain.find((a) => SESSION_ROOT_CATEGORIES.has(protectedCategory(a.name)));
  if (named) roots.push(named);
  let i = 0;
  let sawTerminal = false;
  while (i < chain.length && LAUNCHER_CATEGORIES.has(protectedCategory(chain[i].name))) {
    if (!SHELLS.includes(normName(chain[i].name))) sawTerminal = true;
    i += 1;
  }
  const beyond = chain[i];
  if (!beyond || isAdopter(platform, beyond)) return sawTerminal ? roots : null;
  if (!NOT_A_SESSION.has(protectedCategory(beyond.name))) roots.push(beyond);
  return roots;
}

function notSession(platform, record, records, me) {
  const id = "not_session";
  if (!isInt(record?.pid) || !isInt(me?.pid) || !Array.isArray(records)) return unknown(id, "this tool's own process could not be found");
  if (record.pid === me.pid) return no(id, "this is the tool itself");
  // Without its own process in the scan, this tool cannot tell its session apart from anything else.
  if (!records.some((r) => r?.pid === me.pid)) return unknown(id, "this tool's own process is not in the scan");
  if (ancestorsAndDescendants(records, me.pid).has(record.pid)) return no(id, "this tool, a process that started it, or one it started");
  const roots = sessionRoots(platform, records, me.pid);
  if (!roots) return unknown(id, "this tool cannot see what started it (it was started detached), so it cannot tell its own session apart");
  if (roots.length) {
    const { chain, complete } = ancestorsOf(record, records, platform);
    if (!complete) return unknown(id, "its chain of parent processes could not be followed");
    const root = roots.find((r) => chain.some((a) => a.pid === r.pid));
    if (root) return no(id, `part of the ${safeName(root.name)} session this runs in`);
  }
  return yes(id, "not part of this tool's own session");
}

function launcher(platform, record, records) {
  const id = "launcher";
  if (!isObj(record) || !Array.isArray(records)) return unknown(id, "its parent processes could not be read");
  const { chain, complete, end } = ancestorsOf(record, records, platform);
  for (const a of chain) {
    if (platform !== "win32" && a.pid === 1) return yes(id, "left behind: adopted by the first process");
    if (platform === "linux" && isAdopter(platform, a)) return yes(id, "left behind: adopted by your service manager");
    const cat = protectedCategory(a.name);
    if (LAUNCHER_CATEGORIES.has(cat)) return yes(id, `started from ${safeName(a.name)}, a shell or terminal`);
    if (BLOCKING_CATEGORIES.has(cat)) return no(id, `started by ${safeName(a.name)} (${cat}), which manages it`);
  }
  if (!complete) return unknown(id, end);
  return yes(id, `left behind: ${end}`);
}

function notManagedWindows(facts, me) {
  const id = "not_managed";
  const mine = me?.facts;
  if (!isInt(facts.session) || !isInt(mine?.session)) return unknown(id, "its sign-in session could not be read");
  if (facts.session === 0) return no(id, "runs in session 0, where services run");
  if (facts.session !== mine.session) return no(id, "runs in another sign-in session");
  if (!isBool(facts.critical)) return unknown(id, "could not tell whether it is a critical process");
  if (facts.critical) return no(id, "a critical system process");
  if (!isInt(facts.protection)) return unknown(id, "could not tell whether it is a protected process");
  if (facts.protection !== 0) return no(id, "a protected process (as antimalware services are)");
  if (!isInt(facts.integrity_rid) || !isBool(facts.elevated)) return unknown(id, "its integrity level could not be read");
  if (facts.elevated) return no(id, "runs elevated");
  if (facts.integrity_rid !== INTEGRITY_MEDIUM) return no(id, "does not run at the normal (medium) integrity level");
  if (facts.parent_state === "other_owner") return no(id, "started by a process of another account (a service, or another user)");
  if (facts.parent_state !== "gone" && facts.parent_state !== "same_owner") return unknown(id, "the account of the process that started it could not be read");
  return yes(id, "an ordinary program in your own session");
}

function notManagedLinux(facts, me) {
  const id = "not_managed";
  const uid = me?.facts?.uid?.real;
  if (!isInt(facts.pid) || !isBool(facts.kernel_thread) || !LINUX_STATES.test(facts.state ?? "")) return unknown(id, "its state could not be read");
  if (facts.pid <= 2 || facts.kernel_thread) return no(id, "a kernel or init process");
  if (["Z", "X", "D"].includes(facts.state)) return no(id, `in state ${facts.state} (ended, or waiting on the kernel), so it cannot be stopped safely`);
  if (!isInt(facts.nspid_count) || facts.nspid_count < 1) return unknown(id, "its PID namespace could not be read");
  if (facts.nspid_count !== 1) return no(id, "runs in another PID namespace (a container)");
  if (!isInt(facts.tracer_pid)) return unknown(id, "could not tell whether a debugger traces it");
  if (facts.tracer_pid !== 0) return no(id, "a debugger is attached to it");
  const prm = capsEmpty(facts.cap_prm);
  const eff = capsEmpty(facts.cap_eff);
  if (prm === null || eff === null) return unknown(id, "its capabilities could not be read");
  if (!prm || !eff) return no(id, "holds capabilities");
  if (!isInt(facts.oom_score_adj)) return unknown(id, "its out-of-memory setting could not be read");
  if (facts.oom_score_adj < 0) return no(id, "shielded from the out-of-memory killer, a sign something manages it");
  if (!isInt(facts.session) || !isInt(facts.tty_nr) || facts.session < 0 || facts.tty_nr < 0) return unknown(id, "its session could not be read");
  if (facts.session === facts.pid && facts.tty_nr !== 0) return no(id, "leads a terminal session (a shell)");
  if (!isStr(facts.cgroup) || !isInt(uid)) return unknown(id, "its control group could not be read (cgroup v2 is needed)");
  const parts = facts.cgroup.split("/").filter(Boolean);
  const leaf = parts[parts.length - 1] ?? "";
  if (!facts.cgroup.startsWith(`/user.slice/user-${uid}.slice/`)) return no(id, "not in your user slice (a system service, another user, or a container)");
  if (parts.includes("session.slice")) return no(id, "part of your desktop session's services");
  if (leaf === "init.scope") return no(id, "your service manager itself");
  // Any service in the path, not only the last part: a process in a sub-group of a service is still that service's.
  if (parts.some((p) => p.endsWith(".service") && p !== `user@${uid}.service`)) return no(id, "runs inside a systemd service, which would start it again");
  return yes(id, "an ordinary program in your own user slice");
}

function notManagedMac(facts, record, records) {
  const id = "not_managed";
  if (!MAC_STATES.test(facts.state ?? "")) return unknown(id, "its state could not be read");
  if (facts.state.startsWith("Z")) return no(id, "it has already ended");
  if (!isInt(facts.codesign_exit)) return unknown(id, "its code signature could not be checked");
  if (facts.codesign_exit === 0) return no(id, "signed by Apple: part of macOS");
  // codesign exits 3 when the signature is valid but does not satisfy the requirement; anything else (1: unsigned or
  // invalid, 2: a usage error, a timeout) means the check did not say "not Apple", so it refuses.
  if (facts.codesign_exit !== 3) return no(id, "its code signature could not be checked as not Apple's");
  // A launchd job (a LaunchAgent, a Homebrew service) has the first process as its parent, just like a process that was
  // left behind; `launchctl list` tells them apart. An app opened from the Finder or the Dock is "application".
  if (facts.launchd === "job") return no(id, "a launchd job, which launchd would start again");
  if (facts.launchd !== "none" && facts.launchd !== "application") return unknown(id, "could not tell whether launchd manages it");
  // A process a launchd job started (vite under `npm run dev` in a LaunchAgent) belongs to that job too.
  if (!Array.isArray(facts.launchd_jobs) || !facts.launchd_jobs.every(isInt)) return unknown(id, "could not read the jobs launchd runs");
  const { chain } = ancestorsOf(record, records, "darwin");
  const job = chain.find((a) => facts.launchd_jobs.includes(a.pid));
  if (job) return no(id, `started by ${safeName(job.name)}, a launchd job, which launchd would start again`);
  return yes(id, "not an Apple program, and not a launchd job or started by one");
}

function notManaged(platform, facts, me, record, records) {
  if (!isObj(facts)) return unknown("not_managed", "the process could not be read");
  if (platform === "win32") return notManagedWindows(facts, me);
  if (platform === "linux") return notManagedLinux(facts, me);
  return notManagedMac(facts, record, records);
}

// ---------- identity: what the plan records and the stop compares ----------

// The values that pin one process: its number, its exact start, its program, its owner, and on Linux the boot. A plan
// stores these; a stop reads them again and refuses on any difference. Null when any is missing.
export function identityOf(platform, facts) {
  if (!isObj(facts) || !isInt(facts.pid)) return null;
  let id;
  if (platform === "win32") id = { pid: facts.pid, start: facts.creation, path: facts.image_path, owner: facts.sid };
  else if (platform === "linux") id = { pid: facts.pid, start: isInt(facts.starttime) ? String(facts.starttime) : null, path: facts.exe, owner: idsOk(facts.uid) ? String(facts.uid.real) : null, boot: facts.boot_id };
  else if (platform === "darwin") id = { pid: facts.pid, start: facts.lstart, path: facts.exe, owner: isInt(facts.uid) ? String(facts.uid) : null };
  else return null;
  return Object.entries(id).every(([k, v]) => (k === "pid" ? isInt(v) : isStr(v))) ? id : null;
}

function sameIdentity(platform, facts, expected) {
  const id = "identity";
  const now = identityOf(platform, facts);
  if (!now || !isObj(expected)) return unknown(id, "the process could not be pinned to the one in the plan");
  for (const [k, v] of Object.entries(now)) {
    if (expected[k] !== v) return no(id, `not the process the plan listed: its ${k === "start" ? "start time" : k === "path" ? "program" : k} is different`);
  }
  if (Object.keys(expected).length !== Object.keys(now).length) return no(id, "not the process the plan listed");
  return yes(id, "the same process the plan listed");
}

// ---------- the gate ----------

// input: { platform, decision, record, records, me: { pid, facts, sudo }, facts, protection, home, expected }
//   decision  the classifier's decision for this pid in a fresh scan   record   that scan's record for it
//   records   the whole scan (for parent chains)                       facts    read now, by lib/facts.mjs
//   me        this tool: its pid, its own facts, and whether SUDO_UID or SUDO_USER is set
//   home      the account's own profile folder, from the system (os.userInfo), never from HOME or USERPROFILE
//   canonicalPath  optional: the long form of a path (lib/canonical.mjs), so a short 8.3 spelling still compares equal
//   expected  the identity the plan recorded, or null when making the plan
// Returns { allowed, refused_by, reason, checks }. A check that throws counts as unknown.
export function evaluate(input) {
  const { platform, decision, record, records, me, facts, protection, home, expected = null, canonicalPath } = input ?? {};
  if (!PLATFORMS.has(platform)) {
    const c = unknown("platform", "this system is not supported");
    return { allowed: false, refused_by: c.id, reason: c.detail, checks: [c] };
  }
  const steps = [
    ["stopping_on", () => stoppingOn(protection)],
    ["not_elevated", () => notElevated(platform, me)],
    ["dev_tool", () => devTool(platform, decision, record, facts)],
    ["same_process", () => sameProcess(record, facts)],
    ["not_protected", () => notProtected(platform, record, facts, protection)],
    ["not_system_path", () => notSystemPath(platform, record, facts, home, canonicalPath)],
    ["same_owner", () => sameOwner(platform, facts, me)],
    ["not_session", () => notSession(platform, record, records, me)],
    ["launcher", () => launcher(platform, record, records)],
    ["not_managed", () => notManaged(platform, facts, me, record, records)],
    ...(expected === null ? [] : [["identity", () => sameIdentity(platform, facts, expected)]]),
  ];
  const checks = steps.map(([id, run]) => {
    try {
      const c = run();
      return c && [YES, NO, UNKNOWN].includes(c.result) ? c : unknown(id, "the check gave no answer");
    } catch {
      return unknown(id, "the check could not be completed");
    }
  });
  const first = checks.find((c) => c.result !== YES);
  return { allowed: !first, refused_by: first ? first.id : null, reason: first ? first.detail : null, checks };
}

// How a process is stopped, decided when the plan is made and shown to the person before they pick:
//   close  Windows, a windowed program (PE subsystem 2) with a main window: taskkill without /F asks it to close, as
//          clicking its X does
//   end    Windows, anything else: it can only be ended at once, like End task. A console program cannot be asked, and
//          closing its console window would end every other program attached to that console.
//   term   macOS and Linux: SIGTERM asks it to stop; a second yes sends SIGKILL
export function methodFor(platform, facts) {
  if (platform === "win32") return facts?.has_window === true && facts?.subsystem === 2 ? "close" : "end";
  return "term";
}
export const METHOD_LABELS = { close: "asks it to close", end: "ends it at once", term: "asks it to stop" };
