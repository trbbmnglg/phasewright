// PreToolUse hook: stops a phased-shipping agent from running commands outside its job.
// Reads the hook JSON on stdin and prints a deny decision, or nothing to allow.
//
//   node guard.mjs                    plugin install: the role comes from "agent_type"
//   node guard.mjs --agent <role>     personal copy: the role comes from the argument
//
// It reads nothing but the call, writes no files and uses no network. The main session and any
// other agent are never restricted: with no role it allows (and never loads the rules). The role is
// worked out here first, from the argument or agent_type, before anything else is loaded. When the
// role is known and anything goes wrong (unreadable input, a missing or half-synced rules file, an
// error while judging) it denies with "guard error: ...", because these agents fail closed. With
// --agent, unreadable input is denied too, since the role is known from the argument. With no
// readable role, unreadable input allows. It always exits 0, because any other exit code lets the
// call go ahead. The decision itself lives in guard-rules.mjs (evaluate), so the tests can run it
// without starting a process.
import { readFileSync } from "node:fs";

// The same pattern as guard-rules.mjs (a test keeps them identical). It lives here so the role is
// known before the rules file is loaded, and a missing rules file can still deny.
const ROLE_PATTERN = /^phased-shipping:(builder|checker|shipper|model-scout)$/;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }) + "\n");
}

let text = "";
try {
  text = readFileSync(0, "utf8");
} catch {
  // unreadable input: only matters when the role is known from --agent
}
const argv = process.argv.slice(2);

// Is this call made inside one of the four agents?
let known = argv.includes("--agent");
if (!known) {
  try {
    const input = JSON.parse(text);
    known = input !== null && typeof input === "object" && typeof input.agent_type === "string" && ROLE_PATTERN.test(input.agent_type);
  } catch {
    // unreadable and no --agent: an unknown role
  }
}

if (known) {
  try {
    const { evaluate } = await import("./guard-rules.mjs");
    const reason = evaluate(text, argv);
    if (reason) deny(reason);
  } catch (e) {
    deny(`guard error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
