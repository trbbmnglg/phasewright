// Before every plan and every stop, free.mjs checks itself: that it runs as the person, not elevated, and that the facts
// the stop gate relies on can be read and mean what the gate assumes on this machine. Any failure refuses every stop and
// says why. Read-only.
//   Windows  pinning its own process gives an account, the medium integrity level, a session other than 0, no elevation
//            and no debug privilege
//   Linux    its own process is in one PID namespace, in the user's own slice (cgroup v2), with no capabilities, not root,
//            and not started through sudo
//   macOS    Finder's program passes `codesign -R="anchor apple"` (exit 0) and this Node does not (exit 3), so the
//            Apple check works here; `launchctl list` can be read in a desktop login (`launchctl managername` is
//            Aqua); not root, not through sudo
import { factsFor as realFactsFor, codesignExit as realCodesign, launchdJobs as realLaunchdJobs, launchdManager as realLaunchdManager } from "./facts.mjs";
import { INTEGRITY_MEDIUM } from "./gate.mjs";

export const FINDER = "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder";

const isStr = (v) => typeof v === "string" && v.length > 0;
const sudoIn = (env) => ["SUDO_UID", "SUDO_USER", "SUDO_COMMAND"].some((k) => typeof env[k] === "string" && env[k] !== "");

// Returns { ok, reasons, me: { pid, facts, sudo } }. me is what the gate needs about this tool.
export async function selfCheck({ platform = process.platform, pid = process.pid, env = process.env, execPath = process.execPath, factsFor = realFactsFor, codesign = realCodesign, launchdJobs = realLaunchdJobs, launchdManager = realLaunchdManager } = {}) {
  const reasons = [];
  const sudo = platform === "win32" ? false : sudoIn(env);
  let facts = null;
  try {
    const got = await factsFor(platform, pid, { withSignature: false });
    facts = got.facts;
    await got.release();
  } catch {
    facts = null;
  }
  if (!facts) {
    reasons.push("this tool could not read its own process, so it cannot check any other");
    return { ok: false, reasons, me: { pid, facts: null, sudo } };
  }
  if (platform === "win32") {
    if (!isStr(facts.sid)) reasons.push("its own account could not be read");
    if (facts.elevated !== false) reasons.push("it runs elevated (as administrator); run it as yourself in a normal terminal");
    if (facts.integrity_rid !== INTEGRITY_MEDIUM) reasons.push("it does not run at the normal (medium) integrity level");
    if (facts.debug_privilege !== false) reasons.push("it runs with the debug privilege");
    if (!Number.isSafeInteger(facts.session) || facts.session === 0) reasons.push("it runs in session 0, where services run");
  } else if (platform === "linux") {
    const uid = facts.uid?.real;
    if (!Number.isSafeInteger(uid) || uid === 0 || facts.uid?.effective !== uid) reasons.push("it runs as root or with another user's rights");
    if (sudo) reasons.push("it was started through sudo");
    if (facts.cap_eff !== "0000000000000000") reasons.push("it holds capabilities");
    if (facts.nspid_count !== 1) reasons.push("it runs in a PID namespace of its own (a container), where process numbers are not the machine's");
    if (!isStr(facts.cgroup) || !facts.cgroup.startsWith(`/user.slice/user-${uid}.slice/`)) {
      reasons.push("it does not run in your own user session (its control group is not under your user slice, or cgroup v2 is missing); containers, CI runners and some remote shells look like this");
    }
  } else if (platform === "darwin") {
    if (!Number.isSafeInteger(facts.uid) || facts.uid === 0 || facts.uid !== facts.ruid) reasons.push("it runs as root or with another user's rights");
    if (sudo) reasons.push("it was started through sudo");
    const finder = await codesign(FINDER);
    const node = await codesign(execPath);
    if (finder !== 0) reasons.push("the Apple signature check did not recognise Finder as Apple's, so it cannot tell Apple programs apart here");
    if (node !== 3) reasons.push("the Apple signature check did not answer 'not Apple' for this Node, so it cannot tell other programs apart here");
    if (!(await launchdJobs())) reasons.push("`launchctl list` could not be read, so a launchd job could not be told apart from a left-over");
    if ((await launchdManager()) !== "Aqua") reasons.push("this is not a desktop login (launchd does not say Aqua), so launchd's list of jobs here would leave the desktop's out");
  } else {
    reasons.push("this system is not supported");
  }
  return { ok: reasons.length === 0, reasons, me: { pid, facts, sudo } };
}
