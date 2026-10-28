// What each phased-shipping agent may not do, as data plus small matchers. guard.mjs applies it.
// Every rule has an id (shown in the deny reason), a description, the reason text the agent sees,
// and sample commands that must be denied (the tests run every sample).
//
// git and gh are ALLOWLISTS: each role gets the subcommands it needs, and anything else (an unknown
// subcommand, an alias, a write form of an allowed command) is denied with a reason that names what
// is allowed. Over-denying costs the agent one retry; under-denying is the failure that matters.
// Publish and deploy tools are denylists, and they are not exhaustive. The guard is an extra layer on
// top of the agents' prompt rules and the run skill's gates. It stops direct commands, not a script
// an agent writes and then runs, and it can't see inside a variable that holds a program name or a script
// file. PowerShell and cmd are refused outright for every role (their syntax hides commands), and so is a
// shell that reads its commands from stdin.
import { posix } from "node:path";
import { splitCommands } from "./lib/shell.mjs";

export const GUARD_VERSION = "0.11.0";
export const PROBE_COMMAND = "echo phased-shipping-guard-probe";
export const ROLES = ["builder", "checker", "shipper", "model-scout"];
export const ROLE_PATTERN = /^phased-shipping:(builder|checker|shipper|model-scout)$/;
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
export const FILE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
export const MAX_COMMAND_LENGTH = 32768;

// ---------- helpers ----------

// Plain words (not options), "--" itself left out. Flags and their attached values are dropped; a
// flag's separate value stays, which only ever makes a matcher stricter.
const positionals = (args) => args.filter((a) => a === "-" || !a.startsWith("-"));
// A short-flag cluster (-fu, -n5) that holds a letter.
const shortFlag = (args, letter) => args.some((a) => /^-[A-Za-z][A-Za-z0-9]*$/.test(a) && a.includes(letter));
// `--x` counts as the long flag F when F starts with x: git (and many tools) accept any unique
// prefix of a long option. This takes every prefix, even a one-letter one, because an ambiguous
// prefix that git would reject only costs a retry.
const abbr = (a, F) => {
  if (!a.startsWith("--") || a.length < 3) return false;
  const name = a.slice(2).split("=", 1)[0];
  return name.length >= 1 && F.startsWith(name);
};
const lf = (args, ...names) => args.some((a) => names.some((F) => abbr(a, F)));
const hasAny = (list, ...words) => list.some((w) => words.includes(w));
const flagOn = (args, name) => args.some((a) => a === `--${name}` || a === `--${name}=true`);
const tokens = (pos, n) => pos.slice(0, n).flatMap((w) => w.split(":"));

// The words of a gh command with `-R <repo>` / `--repo <repo>` removed, as positionals.
const ghWords = (args) => {
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-R" || args[i] === "--repo") { i++; continue; }
    kept.push(args[i]);
  }
  return positionals(kept);
};

// ---------- shared rules: every role ----------

// Environment that changes what git (or a hook runner) does. Matches leading assignments, `env X=y`
// and `sudo X=y` (the splitter returns those in `env`), and export/set style commands.
const DANGEROUS_ENV = /^(GIT_\w*|HOME|XDG_CONFIG_HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|SSH_ASKPASS|HUSKY\w*|SKIP|LEFTHOOK\w*|BASH_ENV|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|LD_PRELOAD)$/i;
const ENV_SETTERS = new Set(["export", "declare", "typeset", "readonly", "local", "setenv", "set", "setx", "set-item", "si", "new-item", "ni", "set-variable", "sv"]);
const envName = (w) => w.replace(/^\$?env:\\?/i, "").split(/[=+]/, 1)[0];
// Commands that set a variable without an = : read and getopts (every plain word is a target), mapfile and
// readarray (the same), printf -v NAME. An option's own value counts as a word too, which only makes it stricter.
const VAR_TARGET_READERS = new Set(["read", "mapfile", "readarray", "getopts"]);
const targetName = (w) => String(w).split(/[[=+]/, 1)[0];
const assignsByTarget = (c) => {
  if (VAR_TARGET_READERS.has(c.program)) return c.args.some((w) => DANGEROUS_ENV.test(targetName(w)));
  if (c.program !== "printf") return false;
  return c.args.some((a, i) => (a === "-v" && DANGEROUS_ENV.test(targetName(c.args[i + 1] ?? "")))
    || (/^-v./.test(a) && DANGEROUS_ENV.test(targetName(a.slice(2)))));
};
const envOverride = (c) => {
  if (c.env.some((a) => DANGEROUS_ENV.test(envName(a)))) return true;
  if (/^\$env:/i.test(c.program)) return DANGEROUS_ENV.test(envName(c.program));
  if (assignsByTarget(c)) return true;
  return ENV_SETTERS.has(c.program) && c.args.some((w) => DANGEROUS_ENV.test(envName(w)));
};

const exoticSyntax = (c) => Boolean(c.exotic);

// Programs that run text, or that make later commands run something else (trap, alias, hash, coproc, enable).
const DYNAMIC = new Set(["eval", "iex", "invoke-expression", "start-process", "saps", "start", "start-job", "sajb", "start-threadjob", "invoke-command", "icm",
  "trap", "hash", "alias", "unalias", "coproc", "enable"]);
const OPAQUE = new Set(["busybox", "script", "su", "parallel", "winpty", "flock", "strace", "ltrace", "chroot", "runuser", "unshare", "nsenter", "systemd-run", "taskset", "numactl", "chrt", "proot", "fakeroot", "setpriv"]);
// A shell that reads its commands from stdin (c.stdinShell) is judged here too: nothing says what they are.
const dynamicExec = (c) => DYNAMIC.has(c.program) || OPAQUE.has(c.program) || c.stdinShell === true
  || (c.program === "shopt" && c.args.some((a) => /expand_aliases/i.test(a)));

// A .git or .husky folder in a path (any slash, any case, Windows short names and trailing dots or
// spaces), or one of git's global and system config files: .gitconfig, .config/git/config,
// $XDG_CONFIG_HOME/git/config, etc/gitconfig (/etc/gitconfig, Git\etc\gitconfig) and ProgramData/Git/config.
// Those can set core.hooksPath, remote.*.push, core.sshCommand and credential.helper. .gitignore, .github,
// .gitattributes, .gitmodules, .gitkeep, gitconfig.md and my.gitconfig.txt are not those names and don't
// match. The name may follow a redirection or an = glued to the word (x>.git/config, --git-dir=.git) or a
// quote. It only reads literal text: a path built from a variable or a glob is not matched.
export const PROTECTED_PATH = /(^|[\\/<>='"])(\.git|git~\d+|\.husky|husky~\d+|\.gitconfig|gitcon~\d+|\.config[\\/]git[\\/]config|\$?\{?XDG_CONFIG_HOME\}?[\\/]git[\\/]config|etc[\\/]gitconfig|programdata[\\/]git[\\/]config)[. ]*([\\/:]|$)/i;
const pathWord = (w) => PROTECTED_PATH.test(String(w));
const PROTECTED_REASON = "Agents don't read, write, move or delete anything inside a .git or .husky folder, or git's global and system config files (.gitconfig, .config/git/config, etc/gitconfig, ProgramData/Git/config): that is where git's hooks and config live, and changing them skips the checks. Use git's own commands instead.";
const protectedPath = (c) => [c.program, ...c.globals, ...c.args, ...c.env.map((e) => e.slice(e.indexOf("=") + 1))].some(pathWord);

// gh auth status prints the token with -t or --show-token.
const ghToken = (c) => c.program === "gh" && ghWords(c.args)[0] === "auth"
  && c.args.some((a) => /^-[A-Za-z]*t[A-Za-z]*$/.test(a) || lf([a], "show-token"));

const rule = (id, description, reason, samples, match) => ({ id, description, reason, samples, match });

const SHARED = [
  rule("env-override", "no environment that changes git's behaviour or skips hooks",
    "Agents don't set any GIT_* variable (GIT_CONFIG*, GIT_DIR, GIT_EXEC_PATH, GIT_SSH*, GIT_PAGER and so on), HOME, XDG_CONFIG_HOME, USERPROFILE, HOMEDRIVE, HOMEPATH (they move git's config; read, printf -v, mapfile and getopts that fill one count too), BASH_ENV and similar, or the hook skips HUSKY, SKIP and LEFTHOOK*. Run git as it is.",
    ["GIT_DIR=/tmp/x git status", "GIT_CONFIG_COUNT=1 git status", "GIT_SSH_COMMAND=zork git fetch", "GIT_EXTERNAL_DIFF=zork git diff", "GIT_PAGER=zork git log", "GIT_ASKPASS=zork git fetch",
      "env GIT_EXEC_PATH=/tmp git status", "sudo GIT_DIR=x git status", "export GIT_DIR=/tmp/x", "HUSKY=0 git status", "SKIP=lint git status", "A=1 GIT_TRACE=/tmp/t git status",
      "$env:GIT_DIR = 'x'", "setx GIT_PAGER zork", "set GIT_PAGER=zork", "HOME=/tmp/h git commit -m x", "XDG_CONFIG_HOME=/tmp/h git commit -m x", "USERPROFILE=C:/tmp git status", "GIT_AUTHOR_NAME=x git commit -m x", "BASH_ENV=/tmp/x ls", "export HOME=/tmp/h",
      "read HOME <<< /tmp/h", "read -r HOME <<< /tmp/h", "IFS= read -r USERPROFILE <<< C:/tmp", "read -p x XDG_CONFIG_HOME <<< /tmp", "read -a HOME <<< /tmp", "printf -v HOME %s /tmp/h", "printf -vHOME %s /tmp/h", "mapfile -t HOME <<< /tmp/h",
      "readarray HOME <<< /tmp/h", "getopts ab GIT_DIR", "read GIT_DIR <<< /tmp/x", "HOMEDRIVE=C: git status", "HOMEPATH=/tmp git status", "export HOMEDRIVE=C:", "read HOMEPATH <<< /tmp"],
    envOverride),
  rule("shell-syntax", "no $'..' quoting, brace expansion, function definitions, or PowerShell and cmd tricks that hide the command",
    "The guard can't read this syntax ($'..' or $\"..\" quoting, {a,b} brace expansion, function definitions, a Windows path with single backslashes outside quotes, a PowerShell .NET call, alias, script block or call through a variable, a cmd %variable%). Write the command in plain form.",
    ["$'git' status", "echo $'x'", "git $'status'", "{git,status}", "git{,}", "echo a{b,c}", "foo() { echo hi; }", "function f { echo hi; }", "f(){ echo hi;};f", "echo $\"x\"",
      "bash -c \"echo a{b,c}\"", "C:\\Git\\bin\\git.exe push", "C:\\Program Files\\Git\\cmd\\git.exe push"],
    exoticSyntax),
  rule("protected-path", "no touching .git or .husky (hooks, config) or git's global and system config files from the shell",
    PROTECTED_REASON,
    ["printf '[core]\n\thooksPath = /dev/null\n' >> .git/config", "echo x >.git/config", "echo x >> .git/hooks/pre-commit", "rm .git/hooks/pre-commit", "chmod -x .git/hooks/pre-commit", "mv .husky/pre-commit /tmp/", "git mv evil.sh .git/hooks/post-commit",
      "cat .git/config", "cd .git", "ls ../repo/.git/hooks", "git -C .git status", "cp x sub/.git/hooks/pre-push", "sed -i s/a/b/ .husky/_/husky.sh", "ls \"C:\\x\\.git\\hooks\"", "ls .GIT/hooks", "ls GIT~1/hooks", "ls .git./hooks", "ls .git", "ls .husky/",
      "printf '[core]\n\thooksPath = /dev/null\n' >> ~/.gitconfig", "echo x >> \"$HOME/.gitconfig\"", "echo x > ~/.config/git/config", "cp /tmp/x ~/.gitconfig", "cat ~/.gitconfig", "echo x >> /etc/gitconfig", "echo x >> \"C:\\Program Files\\Git\\etc\\gitconfig\"",
      "echo x >> \"C:\\ProgramData\\Git\\config\"", "echo x >> $XDG_CONFIG_HOME/git/config", "echo x >> .GITCONFIG", "cp x ~/.config/git/CONFIG"],
    protectedPath),
  rule("dynamic-exec", "no eval, Invoke-Expression, Start-Process, Start-Job, Invoke-Command, trap, alias, hash, coproc, shells that read stdin, or opaque launchers",
    "Agents don't run text as a command (eval, Invoke-Expression, Start-Process, Start-Job, Invoke-Command), set one to run later (trap, alias, hash, coproc), pipe commands into a shell (a shell that reads commands from stdin can't be checked) or hand a command to another launcher (busybox, su, script, parallel, flock, strace, taskset and similar). Run the command directly.",
    ["eval \"echo hi\"", "iex \"echo hi\"", "Invoke-Expression 'echo hi'", "Start-Process git", "start git", "Start-Job { echo hi }", "Invoke-Command { echo hi }", "busybox ls", "su -c ls", "script -qc ls /dev/null",
      "parallel echo ::: a b", "flock x ls", "strace ls", "winpty ls", "taskset 1 ls",
      "trap 'git push -f' EXIT", "hash -p /usr/bin/git g", "coproc X { git push -f; }", "coproc git push -f", "alias g='git push -f'", "unalias g", "shopt -s expand_aliases", "enable -f x.so x",
      "echo 'git push -f' | bash", "cat <<E | bash\ngit push -f\nE", "printf x | sh -s", "echo x | sh -", "echo x | bash -x", "bash", "bash <<< 'git push -f'", "bash <<E\ngit push -f\nE", "nohup bash <<< 'git push -f'", "timeout 5 bash <<E\ngit push -f\nE",
      "sudo bash <<< 'git push -f'", "env bash <<< 'git push -f'", "exec bash <<< 'git push -f'", "command bash <<< 'git push -f'", "time bash <<< 'git push -f'", "nice bash <<< 'git push -f'", "busybox sh <<< 'git push -f'", "sudo -s <<< 'git push -f'",
      "bash -s", "dash -s foo", "zsh -", "ksh", "fish"],
    dynamicExec),
  rule("gh-token", "no gh auth status -t or --show-token", "gh auth status -t and --show-token print the GitHub token. Agents never print a token.",
    ["gh auth status -t", "gh auth status --show-token", "gh auth status --show-t", "gh auth status -ht github.com", "gh auth status -a -t", "gh -R x/y auth status -t"], ghToken),
];

// ---------- git: allowlists by role ----------

const git = (c, fn) => c.program === "git" && fn(c.args[0], c.args.slice(1), c);

// `git -c key=value` is allowed only for keys that run nothing.
const SAFE_CONFIG_KEYS = new Set(["user.name", "user.email", "core.quotepath", "core.autocrlf", "core.safecrlf", "color.ui"]);
const globalsOk = (globals) => {
  for (let i = 0; i < globals.length; i++) {
    const g = globals[i];
    if (g === "-c") {
      const key = (globals[i + 1] ?? "").split("=", 1)[0].toLowerCase();
      if (!SAFE_CONFIG_KEYS.has(key)) return false;
      i++;
    } else if (g.startsWith("--config-env") || g.startsWith("--exec-path") || g.startsWith("--git-dir") || g.startsWith("--work-tree")) return false;
  }
  return true;
};

const OUTPUT_SUBS = new Set(["diff", "log", "show", "diff-tree"]);
const reader = (name) => (rest) => {
  if (OUTPUT_SUBS.has(name) && lf(rest, "output")) return false; // --output=<file> writes a file
  if (name === "grep" && (rest.some((a) => /^-[A-Za-z]*O/.test(a)) || lf(rest, "open-files-in-pager"))) return false; // runs a pager command
  return true;
};
const anything = () => true;
// fetch: no --force and no refspec that starts with + (it moves a local branch to wherever the remote says).
const fetchOk = (rest) => transport(rest) && !shortFlag(rest, "f") && !lf(rest, "force") && !positionals(rest).some((w) => w.startsWith("+"));
// Network commands: no --upload-pack / --receive-pack / --exec (they run a program) and no ext:: or fd:: URLs.
const transport = (rest) => !lf(rest, "upload-pack", "receive-pack", "exec") && !rest.some((a) => a.includes("::"));

// branch and tag in their listing forms: only these flags, and words only when a listing flag is present.
function listOnly(rest, { short, long, trigger }) {
  let triggered = false;
  let words = 0;
  for (const a of rest) {
    if (a === "--") return false;
    if (a.startsWith("--")) {
      const name = a.slice(2).split("=", 1)[0];
      if (!long.includes(name)) return false;
      if (trigger.includes(name)) triggered = true;
    } else if (a.startsWith("-") && a.length > 1) {
      if (!/^-[A-Za-z0-9]+$/.test(a)) return false;
      for (const ch of a.slice(1)) {
        if (/\d/.test(ch)) continue;
        if (!short.includes(ch)) return false;
        if (ch === "l") triggered = true;
      }
    } else words++;
  }
  return words === 0 || triggered;
}
const LIST_TRIGGER = ["list", "contains", "no-contains", "merged", "no-merged", "points-at"];
const branchList = (rest) => listOnly(rest, {
  short: "lavri",
  long: ["list", "all", "remotes", "show-current", "verbose", "ignore-case", "sort", "format", "column", "no-column", "abbrev", "no-abbrev", "color", "no-color", ...LIST_TRIGGER],
  trigger: LIST_TRIGGER,
});
const tagList = (rest) => listOnly(rest, {
  short: "lni",
  long: ["list", "ignore-case", "sort", "format", "column", "no-column", "color", "contains", "no-contains", "merged", "no-merged", "points-at"],
  trigger: LIST_TRIGGER,
});
// The shipper may create tags, but not delete or move them.
const tagCreateOrList = (rest) => !(shortFlag(rest, "d") || shortFlag(rest, "f") || lf(rest, "delete", "force"));

const stashOk = (rest) => {
  const w = rest[0];
  if (w === undefined) return true;
  if (w.startsWith("-")) return !rest.some((a) => ["drop", "clear", "apply", "branch", "create", "store", "save"].includes(a));
  return ["push", "list", "show", "pop"].includes(w);
};
const CONFIG_READ = ["get", "get-all", "get-regexp", "list"];
const CONFIG_HARMLESS = [...CONFIG_READ, "show-origin", "show-scope", "global", "local", "system", "worktree", "name-only", "null"];
const configRead = (rest) => {
  const flags = rest.filter((a) => a.startsWith("-"));
  const isRead = (a) => a === "-l" || lf([a], ...CONFIG_READ);
  const harmless = (a) => a === "-l" || a === "-z" || lf([a], ...CONFIG_HARMLESS);
  return flags.some(isRead) && flags.every(harmless) && positionals(rest).length <= 2;
};
const reflogOk = (rest) => {
  const w = rest[0];
  if (w === undefined || w === "show" || w === "list") return true;
  return w.startsWith("-") && !rest.some((a) => ["expire", "delete", "exists", "write"].includes(a));
};
const remoteOk = (args) => {
  const rest = args[0] === "-v" || args[0] === "--verbose" ? args.slice(1) : args;
  if (rest.length === 0) return true;
  const plain = (a) => !a.startsWith("-") && !a.includes("::");
  if (rest[0] === "show") return rest.slice(1).every((a) => a === "-n" || plain(a));
  if (rest[0] === "get-url") return rest.slice(1).every((a) => a === "--all" || a === "--push" || plain(a));
  return false;
};
const checkoutOk = (rest) => !(shortFlag(rest, "B") || shortFlag(rest, "C") || shortFlag(rest, "f") || lf(rest, "force", "orphan", "discard-changes", "force-create"));
const cleanDry = (rest) => (shortFlag(rest, "n") || lf(rest, "dry-run")) && !shortFlag(rest, "f") && !shortFlag(rest, "i") && !lf(rest, "force", "no-dry-run");

// Builder and checker: read, inspect and stage.
const BUILD_GIT = {
  status: reader("status"), diff: reader("diff"), log: reader("log"), show: reader("show"), blame: reader("blame"), grep: reader("grep"),
  "ls-files": reader("ls-files"), "ls-tree": reader("ls-tree"), "rev-parse": reader("rev-parse"), "rev-list": reader("rev-list"), describe: reader("describe"),
  "name-rev": reader("name-rev"), "merge-base": reader("merge-base"), "show-ref": reader("show-ref"), "cat-file": reader("cat-file"), shortlog: reader("shortlog"),
  "diff-tree": reader("diff-tree"), "check-ignore": reader("check-ignore"),
  "ls-remote": transport, fetch: fetchOk,
  add: anything, restore: anything, rm: anything, mv: anything, apply: anything,
  remote: remoteOk, stash: stashOk, branch: branchList, tag: tagList, config: configRead, reflog: reflogOk, checkout: checkoutOk, switch: checkoutOk, clean: cleanDry,
};
// Shipper: commit, push and look.
const SHIP_GIT = {
  add: anything, commit: anything, push: transport, revert: anything,
  status: reader("status"), diff: reader("diff"), log: reader("log"), show: reader("show"), "rev-parse": reader("rev-parse"), "rev-list": reader("rev-list"),
  describe: reader("describe"), "cat-file": reader("cat-file"),
  fetch: fetchOk, "ls-remote": transport, remote: remoteOk, branch: branchList, tag: tagCreateOrList, config: configRead,
};

const gitAllowed = (table, c) => {
  if (!globalsOk(c.globals)) return false;
  const sub = c.args[0];
  if (sub === undefined) return true;
  return Object.hasOwn(table, sub) ? table[sub](c.args.slice(1), c) : false;
};
// `git-push` and friends are programs of their own; write `git push` so the allowlist applies.
const notAllowedGit = (table) => (c) => (c.program === "git" ? !gitAllowed(table, c) : c.program.startsWith("git-"));

const listOf = (table) => Object.keys(table).join(", ");

// Skipping hooks or signing, or changing config on the command line so that git does it for us.
const gitSkipChecks = (c) => git(c, (sub, rest) => {
  const all = [...c.globals, ...c.args];
  if (lf(all, "no-verify", "no-gpg-sign")) return true;
  if (sub === "commit" && shortFlag(rest, "n")) return true;
  return c.globals.some((g) => /^commit\.gpgsign\s*=\s*(false|0|no|off)$/i.test(g) || /^core\.hookspath\s*=/i.test(g) || /^alias\./i.test(g) || /^--config-env/.test(g));
});

// ---------- gh ----------

const ghApiWrite = (c) => {
  if (c.program !== "gh" || ghWords(c.args)[0] !== "api") return false;
  const args = c.args;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let method;
    if (a === "-X" || a === "--method") method = args[i + 1];
    else if (a.startsWith("--method=")) method = a.slice(9);
    else if (/^-[A-Za-z]*X./.test(a) && !a.startsWith("--")) method = a.slice(a.indexOf("X") + 1);
    if (method !== undefined && method.toUpperCase() !== "GET") return true;
    if (/^-[A-Za-z]*[fF]/.test(a) && !a.startsWith("--")) return true;
    if (["--field", "--raw-field", "--input"].includes(a) || /^--(field|raw-field|input)=/.test(a)) return true;
  }
  return false;
};

// Builder and checker: read-only.
const GH_READ_GROUPS = ["pr", "issue", "run", "release", "repo", "workflow", "gist", "label", "project"];
const GH_READ_ACTIONS = ["view", "list", "status", "diff", "checks", "watch", "search", "download"];
const ghNotReadOnly = (c) => {
  if (c.program !== "gh") return false;
  const [a, b] = ghWords(c.args);
  if (a === undefined || a === "search" || a === "status") return false;
  if (a === "api") return ghApiWrite(c);
  if (a === "auth") return b !== "status";
  return !(GH_READ_GROUPS.includes(a) && GH_READ_ACTIONS.includes(b));
};
// Shipper: watch runs, close and reopen issues, look at the rest.
const GH_SHIP = { run: ["watch", "view", "list"], issue: ["view", "list", "close", "reopen"], pr: ["view", "list", "checks"], release: ["view", "list"], repo: ["view"], workflow: ["view", "list"], auth: ["status"] };
const ghNotShipperAllowed = (c) => {
  if (c.program !== "gh") return false;
  const [a, b] = ghWords(c.args);
  if (a === undefined) return false;
  if (a === "api") return ghApiWrite(c);
  return !(Object.hasOwn(GH_SHIP, a) && GH_SHIP[a].includes(b));
};
const ghDelete = (c) => c.program === "gh" && hasAny(ghWords(c.args).slice(0, 2), "delete");

// ---------- curl, wget, Invoke-WebRequest: no writes for builder and checker ----------

const NET = new Set(["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"]);
const CURL_DATA = ["data", "data-binary", "data-raw", "data-urlencode", "data-ascii", "form", "form-string", "upload-file", "json", "config"];
// Short options with a value (-H, -u, -o ...) and the ones that write (data, form, upload, config file).
// -X is handled apart. wget has no short option for a body, a form or an upload, so its short options need no walk.
const CURL_VALUE_SHORT = "AbcCDeEHmoPQrtuUwxyYz";
const CURL_WRITE_SHORT = "dFTK";
const WGET_DATA = ["post-data", "post-file", "body-data", "body-file", "upload-file", "config"];
const netWrite = (c) => {
  if (!NET.has(c.program)) return false;
  const args = c.args;
  const ps = c.program !== "curl" && c.program !== "wget";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (ps) {
      if (!/^[-/][A-Za-z]/.test(a)) continue;
      const name = a.slice(1).split(":", 1)[0].toLowerCase();
      if (name.length >= 2 && "method".startsWith(name)) {
        const value = a.includes(":") ? a.slice(a.indexOf(":") + 1) : args[i + 1];
        if (String(value).toLowerCase() !== "get") return true;
      }
      if ((name.length >= 2 && "body".startsWith(name)) || (name.length >= 3 && "infile".startsWith(name)) || (name.length >= 2 && "form".startsWith(name))) return true;
      continue;
    }
    if (a.startsWith("--")) {
      const name = a.slice(2).split("=", 1)[0];
      if (name.length >= 2 && ("request".startsWith(name) || "method".startsWith(name))) {
        const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
        if (String(value).toUpperCase() !== "GET") return true;
      }
      if (name.length >= 2 && (c.program === "curl" ? CURL_DATA : WGET_DATA).some((F) => F.startsWith(name))) return true;
    } else if (a.startsWith("-") && a.length > 1 && c.program === "curl") {
      // A short cluster is read letter by letter: the first letter that takes a value ends it (the rest
      // of the word is that value, as in -d@file or -Fa=b). A write letter before that point is a write.
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (CURL_WRITE_SHORT.includes(ch)) return true;
        if (ch === "X") {
          if ((a.slice(j + 1) || String(args[i + 1])).toUpperCase() !== "GET") return true;
          break;
        }
        if (CURL_VALUE_SHORT.includes(ch)) break;
      }
    }
  }
  return false;
};

// ---------- publish and deploy ----------

const PM = new Set(["npm", "pnpm", "yarn", "bun"]);
const SCRIPT_RE = /(deploy|release|publish)/i;
const RUN_VERBS = new Set(["run", "run-script", "rum", "urn"]);
const LAUNCH_VERBS = new Set(["exec", "dlx", "x"]);
// Task runners: a word that names a deploy, release or publish target anywhere in the command line.
const MAKERS = new Set(["make", "gmake", "just", "task", "rake", "gulp", "grunt", "turbo", "nx", "lerna", "rush", "npm-run-all", "npm-run-all2", "run-s", "run-p"]);
const SAFE_VERBS = new Set(["add", "install", "i", "remove", "rm", "uninstall", "update", "up", "upgrade", "info", "why", "list", "ls", "outdated", "audit", "view", "search", "link", "unlink", "dedupe", "prune", "rebuild", "store", "config", "cache", "init", "create", "pack"]);
// npm accepts any unique prefix of its command names.
const npmPrefix = (w, full, min) => w !== undefined && w.length >= min && full.startsWith(w);

const DOCKER_VALUED = ["--context", "-c", "-H", "--host", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"];
const dockerPush = (c) => {
  const words = [];
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i];
    if (a.startsWith("-")) { if (DOCKER_VALUED.includes(a)) i++; continue; }
    words.push(a);
  }
  const [a, b] = words;
  if (a === "push") return true;
  if ((a === "image" || a === "manifest") && b === "push") return true;
  if (a === "compose" || c.program === "docker-compose") return words.includes("push");
  if (a === "buildx" && words.slice(1, 3).includes("imagetools")) return true;
  if (c.args.some((x) => /(^|[=,])(push=true|type=registry)(,|$)/.test(x))) return true;
  return hasAny(words.slice(0, 2), "build", "buildx", "bake") && lf(c.args, "push");
};

const publish = (c) => {
  const pos = positionals(c.args);
  const p4 = pos.slice(0, 4);
  if (PM.has(c.program)) {
    if (hasAny(pos.slice(0, 6), "publish", "unpublish", "deprecate", "dist-tag", "dist-tags")) return true;
    const w = pos[0];
    if (npmPrefix(w, "publish", 2) || npmPrefix(w, "unpublish", 3) || npmPrefix(w, "deprecate", 3) || npmPrefix(w, "dist-tag", 4)) return true;
    // npm version patch (and pnpm, yarn) makes a commit and a tag.
    const words = pmWords(c.args);
    const v = words[0];
    if (c.program === "npm" ? npmPrefix(v, "version", 3) : v === "version") {
      return words[1] !== undefined || c.args.some((a) => /^--(new-version|major|minor|patch|premajor|preminor|prepatch|prerelease|immediate|deferred)/.test(a));
    }
    return false;
  }
  if (/^(python|pythonw|py)(\d+(\.\d+)?)?$/.test(c.program)) return c.args.some((a) => a.endsWith("setup.py")) && hasAny(pos, "upload", "register");
  switch (c.program) {
    case "cargo": return hasAny(p4, "publish", "yank", "owner", "release");
    case "gem": return hasAny(p4, "push", "yank", "owner");
    case "twine": return hasAny(p4, "upload");
    case "poetry": case "uv": case "hatch": case "pdm": case "flit": return hasAny(p4, "publish");
    case "maturin": return hasAny(p4, "publish", "upload");
    case "dotnet": return p4[0] === "nuget" && hasAny(p4, "push", "delete");
    case "nuget": return hasAny(p4, "push", "delete");
    case "vsce": return hasAny(p4, "publish", "unpublish");
    case "ovsx": case "deno": case "changeset": case "jsr": return hasAny(p4, "publish");
    case "lerna": return hasAny(p4, "publish", "version");
    case "goreleaser": return hasAny(p4, "release", "publish");
    case "mvn": case "mvnw": case "mvnd": return tokens(pos, 8).some((w) => w === "deploy" || w === "release" || w === "deploy-file");
    case "gradle": case "gradlew": return pos.some((w) => /^(publish(?!ToMavenLocal)|upload|release|closeAndRelease|bintrayUpload|artifactoryPublish)/i.test(w));
    case "docker": case "podman": case "buildah": case "docker-compose": return dockerPush(c);
    case "skopeo": return hasAny(p4, "copy", "sync");
    case "crane": return hasAny(p4, "push", "copy", "cp", "tag", "append", "mutate", "delete", "index");
    case "oras": return hasAny(p4, "push", "copy", "cp", "tag", "delete", "attach");
    case "ko": return hasAny(p4, "build", "publish", "apply", "resolve") && !c.args.includes("--push=false");
    default: return false;
  }
};

// The words of a package-manager command once its own options (and the values of the ones that take
// one) are dropped, up to a bare "--": `pnpm -C app run deploy` -> [run, deploy].
const PM_VALUED = ["-C", "--dir", "-F", "--filter", "--filter-prod", "--cwd", "--loglevel", "--reporter", "--prefix", "-w", "--workspace"];
const pmWords = (args) => {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a.startsWith("-") && a !== "-") { if (PM_VALUED.includes(a)) i++; continue; }
    words.push(a);
  }
  return words;
};
const deployScript = (c) => {
  if (MAKERS.has(c.program)) return positionals(c.args).some((w) => SCRIPT_RE.test(w));
  if (!PM.has(c.program)) return false;
  let words = pmWords(c.args);
  if (c.program === "yarn" && words[0] === "workspace") words = words.slice(2);
  const run = words.slice(0, 6).findIndex((w) => RUN_VERBS.has(w));
  if (run >= 0) return words.slice(run + 1).some((w) => SCRIPT_RE.test(w));
  if (c.program === "npm") return false;
  const head = words.slice(0, 3);
  if (head.some((w) => SAFE_VERBS.has(w) || LAUNCH_VERBS.has(w))) return false; // the command it launches is judged on its own
  return head.some((w) => SCRIPT_RE.test(w));
};

const WRANGLER_WRITE = ["deploy", "publish", "rollback", "delete", "upload", "put", "bulk", "create", "apply", "execute", "restore", "rename", "import", "promote", "push", "trigger"];
const wrangler = (pos, args) => {
  const t = tokens(pos, 5);
  if (!t.some((w) => WRANGLER_WRITE.includes(w))) return false;
  // Local-only storage commands (d1, kv, r2, queues with --local and no --remote) change nothing real.
  const local = t.some((w) => ["d1", "kv", "r2", "queues"].includes(w)) && flagOn(args, "local") && !flagOn(args, "remote");
  return !local;
};
const VERCEL_READ = ["ls", "list", "inspect", "whoami", "logs", "help", "build", "dev", "pull", "link"];
const vercel = (pos, args) => {
  if (args.includes("--prod") || args.includes("--production")) return true;
  if (hasAny(args, "--version", "-v", "--help", "-h")) return false;
  const t = pos.slice(0, 4);
  if (t.length === 0) return true; // a bare `vercel` deploys the folder
  if (hasAny(t, "deploy", "promote", "rollback", "redeploy", "alias", "remove", "rm", "add")) return true;
  if (t.includes("env")) return !hasAny(t, "ls", "list", "pull");
  return !hasAny(t, ...VERCEL_READ);
};
const KUBE_WRITE = ["apply", "delete", "rollout", "scale", "patch", "replace", "create", "edit", "set", "label", "annotate", "drain", "cordon", "uncordon", "taint", "run", "expose", "autoscale", "exec", "cp", "debug"];
const AWS_WRITE = /^(put|delete|create|update|remove|attach|detach|terminate|invoke|publish|deploy|register|deregister|modify|run|start|stop|reboot|send|set|enable|disable|import|restore|cancel|tag|untag|associate|disassociate|authorize|revoke|apply|upload|sync|execute|rm|mv|mb|rb|cp)(-|$)/;
const aws = (pos) => {
  const t = pos.slice(0, 4);
  if (t[0] === "s3") {
    const verb = t[1];
    const rest = pos.slice(2);
    if (["rm", "rb", "mb"].includes(verb)) return true;
    if (verb === "mv") return rest.some((w) => w.startsWith("s3://"));
    if (verb === "cp" || verb === "sync") return rest.length > 0 && rest[rest.length - 1].startsWith("s3://");
    return false;
  }
  return t.includes("deploy") || t.slice(1).some((w) => AWS_WRITE.test(w));
};
const GCLOUD_WRITE = /^(deploy|submit|create|delete|update|patch|import|set-.+|add-.+|remove-.+|replace|apply|publish|rollback|promote|ssh|scp|start|stop|restart|resize|enable|disable)$/;
const gcloud = (pos) => {
  const t = pos.slice(0, 6);
  if (t[0] === "storage") return hasAny(t.slice(1, 2), "rm", "mv", "rsync") || (t[1] === "cp" && pos[pos.length - 1].startsWith("gs://"));
  return t.some((w) => GCLOUD_WRITE.test(w));
};
const gsutil = (pos) => {
  const t = pos.slice(0, 3);
  return hasAny(t, "rm", "mv", "rsync", "rb", "mb") || (t.includes("cp") && pos[pos.length - 1].startsWith("gs://"));
};
const AZ_WRITE = /^(deploy|deployment|create|delete|update|set|add|remove|up|publish|restart|start|stop|scale|import|upload|invoke|swap|purge|assign)$/;

const deployTool = (c) => {
  const pos = positionals(c.args);
  const p3 = pos.slice(0, 3);
  const p4 = pos.slice(0, 4);
  const t = tokens(pos, 4);
  switch (c.program) {
    case "wrangler": return wrangler(pos, c.args);
    case "vercel": return vercel(pos, c.args);
    case "netlify": return hasAny(t, "deploy", "delete", "rollback", "restore");
    case "firebase": return hasAny(t, "deploy", "delete", "disable", "clone", "rollback", "set", "unset");
    case "fly": case "flyctl": return hasAny(p3, "deploy", "launch", "destroy", "scale", "secrets", "restart");
    case "railway": return hasAny(p3, "up", "deploy", "redeploy", "down", "delete");
    case "render": return hasAny(p3, "deploy", "deploys");
    case "heroku": return !hasAny(c.args, "--version", "--help") || pos.length > 0;
    case "terraform": case "tofu":
      return hasAny(p3, "apply", "destroy", "import", "taint", "untaint", "force-unlock") || (p3[0] === "state" && hasAny(p3, "rm", "mv", "push", "replace-provider")) || (p3[0] === "workspace" && p3.includes("delete"));
    case "kubectl": case "oc": return hasAny(p4, ...KUBE_WRITE);
    case "helm": return hasAny(p4, "install", "upgrade", "uninstall", "rollback", "delete", "push");
    case "pulumi": return hasAny(p3, "up", "destroy", "refresh", "import", "cancel") || (p3[0] === "stack" && hasAny(p3, "rm", "import"));
    case "cdk": return hasAny(p3, "deploy", "destroy", "bootstrap");
    case "sam": return hasAny(p3, "deploy", "delete", "sync", "publish");
    case "serverless": case "sls": return hasAny(p3, "deploy", "remove", "rollback", "publish");
    case "aws": return aws(pos);
    case "gcloud": return gcloud(pos);
    case "gsutil": return gsutil(pos);
    case "az": return pos.slice(0, 5).some((w) => AZ_WRITE.test(w));
    case "ng": return hasAny(p3, "deploy");
    case "amplify": return hasAny(p3, "publish", "push");
    case "gh-pages": case "surge": case "release-it": case "np": case "semantic-release": return !hasAny(c.args, "--version", "-V", "--help", "-h");
    default: return false;
  }
};

// ---------- the role rule lists ----------

// powershell, pwsh (and pwsh-preview, powershell_ise) and cmd.
const noOtherShell = (c) => /^((powershell|pwsh)([-_][a-z0-9_.-]+)?|cmd)$/.test(c.program);
const NO_OTHER_SHELL = rule("no-other-shell", "no powershell or cmd (use Bash)", "Agents in this role use Bash. powershell, pwsh and cmd are not part of it: use the Bash tool.",
  ["powershell -Command ls", "pwsh -c ls", "powershell.exe -NoProfile -EncodedCommand AAAA", "cmd /c dir", "cmd.exe /c dir", "cmd //c dir", "pwsh-preview -c ls", "powershell_ise x", "cmd /c call git push -f", "cmd /c @git push -f", "cmd /c if exist x git push -f", "cmd /c \"if 1==1 git push -f\"",
    "cmd /c if not exist x git push -f", "cmd /c if defined PATH git push -f", "cmd /c if errorlevel 0 git push -f", "cmd /c if /i a==a git push -f", "powershell -c '$null = git push -f'", "pwsh -c '$x=git push --force'", "powershell -c '1 | % { echo } { git push -f }'"],
  noOtherShell);
const gitCommit = (c) => git(c, (sub) => sub === "commit" || sub === "revert");
const gitPush = (c) => git(c, (sub) => sub === "push");
const gitHistory = (c) => git(c, (sub) => ["merge", "rebase", "cherry-pick", "reset", "pull", "am"].includes(sub));
const gitDestructive = (c) => git(c, (sub, rest) => (sub === "clean" && !cleanDry(rest))
  || (sub === "branch" && !branchList(rest) && (shortFlag(rest, "d") || shortFlag(rest, "D") || lf(rest, "delete", "force")))
  || (sub === "stash" && ["drop", "clear"].includes(rest[0])));
const gitTag = (c) => git(c, (sub, rest) => sub === "tag" && !tagList(rest));

const BUILD_REASON_GIT = `Builders and checkers use git only to read, inspect and stage: ${listOf(BUILD_GIT)} (branch, tag, config, remote, stash, checkout, switch and clean only in their read or safe forms). Anything else is not part of this role. Report it instead.`;
const SHIP_REASON_GIT = `The shipper uses git only for: ${listOf(SHIP_GIT)} (branch and config only to list or read, remote only -v, show and get-url). Anything else (pull, rebase, reset, stash, clean, update-ref, aliases and so on) is not part of shipping. Stop and report.`;

const API_WRITE = rule("gh-api-write", "no gh api calls that write", "gh api is for reads only (GET, no fields or input) in this role.",
  ["gh api -X POST repos/x/y/issues", "gh api --method DELETE repos/x/y", "gh api --method=PATCH repos/x/y", "gh api -XPATCH repos/x/y", "gh api -iXPOST repos/x/y", "gh api repos/x/y -f title=t", "gh api repos/x/y -F title=t",
    "gh api repos/x/y --field a=b", "gh api repos/x/y --input body.json"], ghApiWrite);

const NET_WRITE = rule("net-write", "no curl, wget or Invoke-WebRequest calls that write", "Network writes (a request method other than GET, a body, form or upload) are not part of this role.",
    ["curl -X POST https://example.com", "curl -XPOST https://example.com", "curl --request DELETE https://example.com", "curl --request=PUT https://example.com", "curl -d x https://example.com", "curl --data x https://example.com",
      "curl --data-binary @f https://example.com", "curl --dat x https://example.com", "curl -F a=b https://example.com", "curl --form a=b https://example.com", "curl -T f https://example.com", "curl --upload-file f https://example.com",
      "curl --json {} https://example.com", "curl -sd x https://example.com", "curl -K cfg https://example.com", "curl -d@body https://api.example.com/deploy", "curl -d1 https://example.com", "curl -d'{\"a\":1}' https://example.com", "curl -Fa=b https://example.com",
      "curl -sSd@f https://example.com", "curl -sSLd@f https://example.com", "curl -XPOST https://example.com", "curl -sXPUT https://example.com", "curl -sT f https://example.com", "curl -Tf https://example.com", "curl -Kcfg https://example.com", "curl -s -d@f https://example.com", "wget --post-data=x https://example.com", "wget --post-file=f https://example.com", "wget --method=POST https://example.com",
      "Invoke-WebRequest -Method Post -Uri https://example.com", "iwr -Method:Delete https://example.com", "irm https://example.com -Body x", "Invoke-RestMethod -Uri https://example.com -InFile f"], netWrite);

// Builder and checker: no commits, pushes, merges, publishes or deploys.
const BUILD_RULES = [
  ...SHARED,
  NO_OTHER_SHELL,
  rule("git-commit", "no git commit or revert", "Builders and checkers never commit. Report the change and let the shipper commit it after approval.",
    ["git commit -m x", "git revert --no-edit HEAD", "git commit --amen"], gitCommit),
  rule("git-push", "no git push", "Builders and checkers never push. The shipper pushes after approval.",
    ["git push", "git push origin main", "git push --forc"], gitPush),
  rule("git-history", "no merge, rebase, cherry-pick, reset, pull or am", "Builders and checkers don't rewrite or combine history. Report it instead.",
    ["git merge main", "git rebase main", "git cherry-pick abc123", "git reset --hard HEAD~1", "git reset --har", "git reset HEAD file", "git pull", "git am x.patch"], gitHistory),
  rule("git-destructive", "no forced clean, branch delete or force, or stash drop", "Builders and checkers don't delete work that git can't bring back. Report it instead.",
    ["git clean -fd", "git clean --force", "git clean -nf", "git clean -n --no-dry-run", "git clean", "git branch -D old", "git branch -d -f old", "git branch --delete --force old", "git branch --del old", "git stash drop", "git stash clear"], gitDestructive),
  rule("git-tag", "no creating or deleting tags (listing is fine)", "Builders and checkers don't create or delete tags. Listing them with git tag -l is fine.",
    ["git tag v1.0.0", "git tag -a v1.0.0 -m x", "git tag -d v1.0.0", "git tag --del v1.0.0", "git tag -f v1"], gitTag),
  rule("git-skip-checks", "no skipping hooks or signing", "No agent may skip git hooks or commit signing, or set git config on the command line to do so.",
    ["git log --no-verify", "git status --no-gpg-sign", "git status --no-veri", "git -c commit.gpgsign=false status", "git -c core.hooksPath=/dev/null status", "git -c alias.st=push st"], gitSkipChecks),
  rule("git-allowlist", "git only to read, inspect and stage", BUILD_REASON_GIT,
    ["git commit-tree abc", "git notes add -m x", "git update-ref refs/heads/x abc", "git send-pack x", "git subtree add x", "git svn fetch", "git reflog expire --all", "git gc", "git init", "git config user.name zork",
      "git config --unset user.name", "git config --global alias.x push", "git config --get-regexp --unset alias", "git branch new-name", "git branch -f x", "git branch -m a b", "git branch --set-upstream-to=origin/x", "git stash apply", "git stash save x",
      "git remote add x y", "git remote set-url x y", "git checkout -B x", "git checkout -f", "git checkout --force x", "git checkout --orphan x", "git switch -C x",
      "git diff --output=out.txt", "git log --out=out.txt", "git show --outp=out.txt", "git grep -Osh x", "git grep --open-files-in-pager=zork x", "git ls-remote --upload-pack=zork .", "git fetch --upload-pack zork",
      "git fetch ext::zork", "git fetch --force origin x", "git fetch -f", "git fetch --forc", "git fetch -fp origin", "git fetch origin +main:main", "git fetch origin -- +main:main", "git -c core.pager=zork log", "git -c core.sshCommand=zork fetch", "git --exec-path=/tmp status", "git frobnicate", "git-receive-pack x", "git-upload-pack x", "git help status", "git filter-branch",
      "git worktree add x", "git submodule update", "git bisect start", "git replace a b"], notAllowedGit(BUILD_GIT)),
  API_WRITE,
  rule("gh-allowlist", "gh only to read", "Builders and checkers use gh only to read: view, list, status, diff, checks, watch, search and download on pr, issue, run, release, repo, workflow, gist, label and project, gh auth status, and gh api with GET. Anything else is not part of this role.",
    ["gh pr create --fill", "gh pr merge 3", "gh pr close 3", "gh pr edit 3", "gh pr checkout 3", "gh release create v1", "gh release delete v1", "gh repo create x", "gh repo delete x", "gh repo edit x", "gh repo edit x --visibility public",
      "gh repo archive x", "gh repo sync x", "gh repo fork x", "gh secret set X", "gh secret delete X", "gh variable set X", "gh workflow run ci.yml", "gh workflow enable ci.yml", "gh workflow disable ci.yml",
      "gh issue create", "gh issue close 1", "gh issue edit 1", "gh issue reopen 1", "gh issue comment 1", "gh issue delete 1", "gh project item-edit", "gh project item-add 1", "gh alias set x y",
      "gh extension install x", "gh auth token", "gh gist create x", "gh run rerun 1", "gh run cancel 1", "gh -R x/y pr merge 3", "gh --repo x/y pr merge 3", "gh codespace create", "gh ssh-key add"], ghNotReadOnly),
  NET_WRITE,

  rule("publish", "no publishing packages or images", "Builders and checkers never publish. The shipper does that after approval.",
    ["npm publish", "npm pub", "npm unpublish x", "npm deprecate x y", "npm dist-tag add x@1 latest", "pnpm publish", "pnpm -r publish", "pnpm --filter x publish", "yarn publish", "yarn npm publish", "bun publish", "cargo publish", "cargo yank x",
      "twine upload dist/*", "python -m twine upload dist/*", "python3 setup.py sdist upload", "uv run twine upload dist/*", "pipx run twine upload dist/*", "uvx twine upload dist/*", "gem push x.gem", "dotnet nuget push x.nupkg", "poetry publish", "uv publish", "hatch publish",
      "vsce publish", "ovsx publish", "deno publish", "changeset publish", "npx changeset publish", "mvn deploy", "mvn clean deploy -DskipTests", "./mvnw deploy", "gradle publish", "./gradlew publishToSonatype",
      "docker push acmecorp/zork:1", "docker --context zork push acmecorp/zork:1", "docker image push acmecorp/zork:1", "docker compose push", "docker compose -f x.yml push", "docker-compose push", "docker buildx build --push .",
      "docker build --push .", "docker buildx build --output type=registry .", "podman push acmecorp/zork:1", "skopeo copy docker://a docker://b", "crane push x y",
      "npm version patch", "npm version minor", "npm version 1.2.3", "npm ver patch", "pnpm version patch", "yarn version patch", "yarn version --patch", "npm -w web version patch", "npx jsr publish", "jsr publish", "goreleaser release", "goreleaser release --clean", "lerna version", "lerna publish"], publish),
  rule("deploy-script", "no package scripts named deploy, release or publish", "Builders and checkers never deploy or release. The shipper does that after approval.",
    ["npm run deploy", "npm run deploy:prod", "npm run-script deploy", "npm rum deploy", "npm --prefix web run deploy", "npm run -w web deploy", "pnpm run release", "pnpm -C web run deploy", "pnpm --filter web deploy", "pnpm -F web release", "yarn run publish:all",
      "bun run deploy", "yarn deploy", "pnpm release", "yarn workspace web run deploy", "yarn workspace web wrangler deploy", "make deploy", "just release", "task publish",
      "turbo run deploy", "turbo deploy", "npx turbo run deploy", "pnpm turbo deploy", "nx run app:deploy", "nx deploy app", "nx run-many -t deploy", "lerna run deploy", "npm-run-all deploy", "run-s deploy", "run-p release", "npm-run-all --parallel build deploy", "gulp deploy", "grunt publish"], deployScript),
  rule("deploy-tool", "no deploy tools", "Builders and checkers never deploy or change infrastructure. The shipper does that after approval.",
    ["wrangler deploy", "wrangler publish", "wrangler pages deploy dist", "wrangler pages publish dist", "wrangler secret put KEY", "wrangler secret delete KEY", "wrangler secret bulk f.json", "wrangler d1 execute db --remote --command x",
      "wrangler d1 execute db --remote=true --command x", "wrangler d1 execute db --command x", "wrangler r2 object put b/k", "wrangler r2 object delete b/k", "wrangler versions deploy", "wrangler versions upload", "wrangler rollback", "wrangler delete",
      "wrangler kv key put k v --remote", "wrangler kv:key delete k", "wrangler d1 migrations apply db --remote",
      "npx wrangler deploy", "npx wrangler@latest deploy", "npx -y wrangler@4.1.0 deploy", "npx -y @cloudflare/wrangler deploy", "npx --yes netlify-cli deploy", "npx firebase-tools deploy", "npm x -- wrangler deploy", "npm exec -- wrangler deploy",
      "npx -c 'wrangler deploy'", "npm exec --call 'wrangler deploy'", "npm exec -c \"wrangler deploy\"", "pnpm -C app exec wrangler deploy", "pnpm --filter app -s exec wrangler deploy", "pnpm dlx wrangler deploy",
      "yarn dlx wrangler deploy", "bunx wrangler deploy", "env -S 'wrangler deploy'", "bash -c -- 'wrangler deploy'", "vercel deploy", "vercel --prod", "vercel promote x", "vercel", "vercel x", "netlify deploy --prod", "firebase deploy",
      "firebase hosting:channel:deploy x", "fly deploy", "flyctl deploy", "railway up", "render deploy", "heroku releases", "terraform apply", "terraform destroy", "tofu apply", "kubectl apply -f x.yaml", "kubectl delete pod x",
      "kubectl rollout restart deploy/x", "kubectl scale --replicas=0 deploy/x", "kubectl patch deploy x -p {}", "kubectl replace -f x.yaml", "kubectl create ns x", "kubectl --context a -n b delete pod x", "helm install x ./chart", "helm upgrade x ./chart",
      "helm uninstall x", "helm rollback x 1", "pulumi up", "pulumi destroy", "cdk deploy", "sam deploy", "serverless deploy", "sls deploy", "aws cloudformation deploy --stack-name x", "aws s3 sync . s3://zork", "aws s3 cp x s3://zork/x",
      "aws s3 rm s3://zork/x", "aws s3api put-object --bucket zork", "aws lambda invoke zork", "gcloud run deploy zork", "gcloud builds submit .", "az webapp deploy --name x", "az webapp up --name x", "gh-pages -d dist", "release-it", "surge dist",
      "wrangler workflows trigger x", "node node_modules/.bin/wrangler deploy", "node ./node_modules/wrangler/bin/wrangler.js deploy", "node ../node_modules/.bin/wrangler publish", "node --no-warnings node_modules/.bin/vercel --prod", "node -r dotenv/config node_modules/netlify-cli/bin/run.js deploy"], deployTool),
];

// Shipper: it commits and pushes, but never forces, skips checks or rewrites history.
const pushForce = (c) => git(c, (sub, rest) => {
  if (sub !== "push") return false;
  if (shortFlag(rest, "f") || shortFlag(rest, "d")) return true;
  if (lf(rest, "force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune")) return true;
  return positionals(rest).some((w) => w.startsWith(":") || w.startsWith("+"));
});
const rewrite = (c) => git(c, (sub, rest) => (sub === "commit" && lf(rest, "amend")) || ["rebase", "reset", "clean", "filter-branch"].includes(sub)
  || (sub === "branch" && !branchList(rest) && (shortFlag(rest, "d") || shortFlag(rest, "D") || lf(rest, "delete", "force"))));

// A flag or a refspec can hide in an expansion: `F=--force; git push $F`, `git push $(echo +main)`. For
// push, commit, revert and tag, any argument with an expansion is refused, except the text that follows
// -m, --message, -F or --file (`git commit -F "$TEMP/msg.txt"`, `-m "$(cat msg)"`).
const MESSAGE_FLAG = /^-[A-Za-z]*[mF]$/;
const shipperExpanded = (c) => {
  if (c.program !== "git" || !["push", "commit", "revert", "tag"].includes(c.args[0])) return false;
  return c.args.some((a, i) => {
    if (i === 0 || !c.expanded[i]) return false;
    const prev = c.args[i - 1];
    if (!c.expanded[i - 1] && !prev.includes("=") && (MESSAGE_FLAG.test(prev) || abbr(prev, "message") || abbr(prev, "file"))) return false;
    if (a.includes("=") && (abbr(a, "message") || abbr(a, "file"))) return false;
    return true;
  });
};

const SHIP_RULES = [
  ...SHARED,
  NO_OTHER_SHELL,
  rule("shipper-expanded", "no variable, command substitution or backticks in the arguments of git push, commit, revert or tag (except a -m or -F value)",
    "The guard can't see what a variable or a command substitution turns into, and it could be --force, --no-verify or +main. Write the arguments out in full. Only the text after -m, --message, -F or --file may use a variable or $(...).",
    ["F=--force; git push $F", "git push $(echo --force)", "git push `echo -f`", "git push origin $(printf +main)", "N=--no-verify; git commit -m x $N", "git commit -m x $(echo --amend)", "git push origin \"$BRANCH\"", "git push -- $X", "git tag v$(cat VERSION)", "git revert $(git rev-parse HEAD)",
      "git commit -m x -$X", "git commit $F -m x", "git commit -m \"x\" \"$(echo -n)\"", "git push --force-with-lease=$X", "git commit --message=x --$FLAG", "echo -f | { read x; git push $x; }"],
    shipperExpanded),
  rule("no-xargs", "no xargs", "The shipper runs git and gh itself, not through xargs: xargs would add arguments the guard can't see.",
    ["echo -f | xargs -I % git push %", "xargs git push", "echo x | xargs echo"], (c) => c.program === "xargs"),
  rule("shipper-force-push", "no force push, mirror, prune, delete or :branch refspec", "The shipper never force-pushes or deletes remote refs. Stop and report.",
    ["git push -f", "git push --force", "git push --force-with-lease", "git push --force-w", "git push --forc", "git push --force-if-includes", "git push --mirror", "git push --mirr", "git push --mi", "git push --delete origin x", "git push --del origin x",
      "git push --prune", "git push origin :main", "git push origin +main", "git push origin -- :main", "git push origin -- +main", "git push -fu origin main", "git push -d origin x"], pushForce),
  rule("git-skip-checks", "no skipping hooks or signing", "The shipper never skips git hooks or commit signing. If a hook fails, stop and report.",
    ["git commit --no-verify", "git commit --no-veri -m x", "git commit -n -m x", "git commit --no-gpg-sign", "git -c commit.gpgsign=false commit -m x", "git push --no-verify", "git push --no-ver"], gitSkipChecks),
  rule("shipper-rewrite", "no amend, rebase, reset, clean or branch delete", "The shipper never rewrites history or deletes work. Stop and report.",
    ["git commit --amend --no-edit", "git commit --amen --no-edit", "git rebase main", "git reset --hard HEAD~1", "git reset --har", "git reset HEAD file", "git clean -fd", "git branch -D old", "git branch --delete old"], rewrite),
  rule("shipper-gh-delete", "no gh delete commands", "The shipper never deletes a repository, a release, a secret or anything else on GitHub. Stop and report.",
    ["gh repo delete x --yes", "gh release delete v1", "gh secret delete X", "gh -R x/y repo delete x"], ghDelete),
  rule("git-allowlist", "git only to commit, push and look", SHIP_REASON_GIT,
    ["git pull", "git merge main", "git cherry-pick abc", "git stash", "git stash pop", "git checkout main", "git switch main", "git restore x", "git rm x", "git mv a b", "git apply x.patch", "git update-ref refs/heads/x abc",
      "git commit-tree abc", "git branch new-name", "git branch -m a b", "git branch -f x", "git tag -d v1", "git tag --delete v1", "git tag -f v1", "git config user.name zork", "git config --global alias.x push", "git remote add x y",
      "git remote set-url x y", "git -c core.sshCommand=zork push", "git -c core.pager=zork log", "git push --receive-pack=zork", "git push --exec=zork", "git push ext::zork", "git diff --output=out.txt", "git frobnicate", "git-push",
      "git notes add", "git init", "git gc", "git reflog expire --all", "git worktree add x"], notAllowedGit(SHIP_GIT)),
  API_WRITE,
  rule("gh-allowlist", "gh only for the shipper's runbook", "The shipper uses gh only for: gh run watch, view and list; gh issue view, list, close and reopen; gh pr view, list and checks; gh release view and list; gh repo view; gh workflow view and list; gh auth status; and gh api with GET. Anything else is not part of shipping. Stop and report.",
    ["gh pr create --fill", "gh pr merge 3", "gh pr close 3", "gh pr edit 3", "gh release create v1", "gh repo create x", "gh repo edit x --visibility public", "gh repo archive x", "gh repo sync x", "gh secret set X", "gh variable set X",
      "gh workflow run ci.yml", "gh workflow enable ci.yml", "gh issue create", "gh issue edit 1", "gh issue comment 1", "gh run rerun 1", "gh run cancel 1", "gh alias set x y", "gh extension install x", "gh auth token", "gh gist create x"], ghNotShipperAllowed),
  NET_WRITE,
];

// ---------- plan files: builder only ----------

// The approval binding (commands-hash.mjs) compares the plan's "## Commands" section at preview with the
// one at approve. The builder works before the preview, so it never edits the plan files: PHASES.md, or
// a phase-*.md inside a folder named `phases`. The shell rule is best effort: it reads literal paths in
// the common write forms, not a path built from a variable, a glob, or a cd followed by a bare file name.
const PLAN_FILE_REASON = "The builder doesn't edit the plan files (PHASES.md, or phase-*.md inside a folder named phases): the approval is bound to the commands the user saw at preview. Report what should change in the plan and let the main session edit it.";
const slashes = (p) => String(p).replace(/\\/g, "/");
// Slashes made forward, `.` and `..` segments and doubled slashes resolved, a trailing slash (or `/.`) dropped;
// a quote left at the end of a shell word stays. Drive letters are plain text here, so C:/r keeps working.
const norm = (p) => {
  const m = /^([\s\S]*?)(['"]*)$/.exec(slashes(p));
  return posix.normalize(m[1]).replace(/\/+$/, "") + m[2];
};
const PLAN_FILE_WORD = /(^|[\\/<>='"])(PHASES\.md|phases[\\/]phase-[^\\/\s'"]*\.md)['"]?[. ]*$/i;
const planFileWord = (w) => PLAN_FILE_WORD.test(String(w)) || PLAN_FILE_WORD.test(norm(w));
// A file tool's path: PHASES.md, or phase-*.md whose folder is named phases (any case, trailing dots and spaces ignored).
export const isPlanFilePath = (p) => {
  const parts = norm(p).split("/");
  const name = (parts.pop() ?? "").replace(/(\.md)[. ]*:.*$/i, "$1").replace(/[. ]+$/, "").toLowerCase(); // an NTFS stream suffix (PHASES.md::$DATA) is the same file
  if (name === "phases.md") return true;
  return /^phase-.*\.md$/.test(name) && (parts.pop() ?? "").replace(/[. ]+$/, "").toLowerCase() === "phases";
};
const REDIRECT_START = /^\d*(>>?|&>>?|>\|)/;
const REDIRECT_ONLY = /^\d*(>>?|&>>?|>\|)$/;
const shortInPlace = (args) => args.some((a) => /^-[A-Za-z]*i/.test(a));
const PS_WRITERS =new Set(["set-content", "add-content", "out-file", "clear-content", "sc", "ac"]);
// The shell write forms for the files `word` names: a redirect (also one glued to another word, where the
// part after the last > is the target), tee, in-place sed and perl, mv, rm, truncate, shred, cp, install,
// ln onto it, dd of=, and the PowerShell writers. A quoted literal like echo "a>PHASES.md" is denied too.
// The sources and the destination folder or file of cp, mv, install, ln, rsync and git mv: a -t, -tDIR,
// --target-directory DIR or --target-directory=DIR names the destination; otherwise it is the last word.
const baseName = (p) => norm(p).split("/").pop() ?? "";
function transfer(args) {
  const sources = [];
  let dir;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { sources.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      if (abbr(a, "target-directory")) dir = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
    } else if (/^-[A-Za-z]*t$/.test(a)) dir = args[++i];
    else if (/^-t./.test(a)) dir = a.slice(2);
    else if (!a.startsWith("-") || a === "-") sources.push(a);
  }
  if (dir === undefined) dir = sources.pop();
  return { sources, dir };
}
// Copying or moving into a folder: the destination is <dir>/<basename of each source>. `only` limits which
// source names count (the plan files need phase-*.md; PHASES.md copied into a folder is left alone).
const intoDir = (args, word, only) => {
  const { sources, dir } = transfer(args);
  if (dir === undefined) return false;
  return word(dir) || sources.some((s) => (!only || only(baseName(s))) && word(`${dir}/${baseName(s)}`));
};
const TRANSFER = new Set(["cp", "mv", "install", "ln", "rsync"]);
const writesTo = (c, word, only) => {
  const args = c.args;
  if (TRANSFER.has(c.program) && intoDir(args, word, only)) return true;
  if (c.program === "git" && c.args[0] === "mv" && intoDir(args.slice(1), word, only)) return true;
  // > file, >> file, 2> file, &> file, >|file, x>file, with or without a space after the operator.
  for (let i = 0; i < args.length; i++) {
    if (REDIRECT_ONLY.test(args[i])) { if (i + 1 < args.length && word(args[i + 1])) return true; }
    else if (REDIRECT_START.test(args[i]) && word(args[i])) return true;
    else if (args[i].includes(">") && word(args[i].slice(args[i].lastIndexOf(">") + 1))) return true;
  }
  const named = args.some(word);
  if (!named) return false;
  switch (c.program) {
    case "tee": return true;
    case "sed": return shortInPlace(args) || lf(args, "in-place");
    case "perl": return shortInPlace(args);
    case "mv": case "rm": case "truncate": case "shred": return true;
    case "cp": case "install": case "ln": return word(transfer(args).dir ?? ""); // onto it: the last word is the target (or the -t value)
    case "rsync": return true; // any argument that names it, source or target
    case "git": return args[0] === "apply" || args[0] === "mv"; // a patch can't be read, so any such argument is refused
    case "dd": return args.some((a) => /^of=/i.test(a) && word(a.slice(3)));
    default: return PS_WRITERS.has(c.program);
  }
};
// git checkout and git restore bring a file back from the index or a commit: onto a plan file that is a write.
// `git restore --staged` alone only unstages (it leaves the file as it is), so it is not one.
const gitRestoresPlanFile = (c) => {
  if (c.program !== "git" || (c.args[0] !== "checkout" && c.args[0] !== "restore")) return false;
  const rest = c.args.slice(1);
  const staged = shortFlag(rest, "S") || lf(rest, "staged");
  const worktree = shortFlag(rest, "W") || lf(rest, "worktree");
  if (staged && !worktree) return false;
  return rest.some(planFileWord);
};
const planFileWrite = (c) => writesTo(c, planFileWord, (name) => /^phase-.*\.md$/i.test(name)) || gitRestoresPlanFile(c);
const PLAN_FILE_RULE = rule("plan-file-write", "the builder doesn't write PHASES.md or phases/phase-*.md",
  PLAN_FILE_REASON,
  ["echo x >> PHASES.md", "echo x > PHASES.md", "echo x >.plans/phases/phase-7-x.md", "echo x 2> PHASES.md", "printf x | tee PHASES.md", "cat y | tee -a docs/phases/phase-3-x.md",
    "echo x>PHASES.md", "echo x>>PHASES.md", "echo x>.plans/phases/phase-7-x.md", "git show HEAD:PHASES.md>PHASES.md", "git checkout -- PHASES.md", "git checkout HEAD~1 -- .plans/phases/phase-7-x.md", "git restore PHASES.md", "git restore --source=HEAD~1 docs/phases/phase-3-x.md",
    "sed -i s/a/b/ .plans/phases/phase-6-agent-guard.md", "sed -i.bak s/a/b/ PHASES.md", "sed -ni s/a/b/p PHASES.md", "sed --in-place s/a/b/ PHASES.md", "perl -pi -e s/a/b/ PHASES.md",
    "mv x.md docs/phases/phase-1-a.md", "mv PHASES.md /tmp/old.md", "cp /tmp/x.md PHASES.md", "cp /tmp/x.md .plans/phases/phase-2-b.md", "cp x.md docs/phases/phase-4-d.md", "install -m 644 x.md PHASES.md",
    "rm .plans/phases/phase-3-c.md", "truncate -s 0 PHASES.md", "dd if=/tmp/x of=PHASES.md", "Set-Content PHASES.md x", "set-content -Path docs/phases/phase-3-x.md -Value y", "Out-File -FilePath PHASES.md", "Add-Content PHASES.md x",
    "cd x && echo y >> \"docs/phases/phase-5-e.md\"", "bash -c 'echo x >> PHASES.md'", "echo x >>PHASES.md", "echo x >> ./PHASES.md", "echo x >> sub/Phases.MD", "echo x >> 'PHASES.md'",
    "echo x >> C:/r/PHASES.md/.", "echo x >> .plans/phases/./phase-7-x.md", "echo x >> .plans/phases//phase-7-x.md", "echo x >> .plans/phases/x/../phase-7-x.md",
    "cp -t .plans/phases /tmp/phase-7-x.md", "cp --target-directory=.plans/phases /tmp/phase-7-x.md", "cp --target-directory .plans/phases /tmp/phase-7-x.md", "mv -t docs/phases /tmp/phase-3-x.md", "install -t .plans/phases /tmp/phase-7-x.md", "install -D -t .plans/phases/ x/phase-7-x.md",
    "cp /tmp/phase-7-x.md .plans/phases", "cp /tmp/phase-7-x.md .plans/phases/", "mv /tmp/phase-7-x.md phases",
    "rsync -a /tmp/x.md PHASES.md", "rsync -a /tmp/phase-7-x.md .plans/phases/phase-7-x.md", "rsync -a /tmp/phase-7-x.md .plans/phases/", "git apply PHASES.md", "git mv /tmp/x.md PHASES.md", "git mv phase-7-x.md .plans/phases", "git mv x.md .plans/phases/phase-7-x.md"],
  planFileWrite);

// The approval records (<data>/previews/<12 hex>.planned.json and .previewed.json) and the plugin's own
// data and installed copies are what the binding trusts, so the builder never writes them either. Reading
// stays allowed. A folder that is merely named `previews` is fine. Same best-effort reach as the plan files.
const PLUGIN_FILE_REASON = "The builder doesn't write the approval records (previews/<key>.planned.json and .previewed.json), the plugin's data folder (.claude/phased-shipping/), the installed copies of its skills and agents (.claude/skills/ps-run, .claude/skills/ps-plan, .claude/agents/ps-*), or the phased-shipping plugin install folders (.claude/plugins/cache, marketplaces and data), and it doesn't run commands-hash.mjs with --record (only the run skill records approval fingerprints): the approval binding depends on them. Report what should change and let the main session do it.";
const PLUGIN_FILE_WORD = /(^|[\\/<>='"])(previews\/[0-9a-f]{12}\.(planned|previewed)\.json['"]?[. ]*$|\.claude\/(phased-shipping|skills\/ps-(run|plan))(\/|['"]?[. ]*$)|\.claude\/agents\/ps-|\.claude\/plugins\/(cache|marketplaces|data)\/[^'" ]*phased-shipping)/i;
const pluginFileWord = (w) => PLUGIN_FILE_WORD.test(slashes(w)) || PLUGIN_FILE_WORD.test(norm(w));
// Recording an approval fingerprint is the run skill's step: the builder may hash (--short) or --check, never --record.
const HASH_SCRIPT = /(^|[\\/])commands-hash\.mjs['"]?$/i;
const recordsApproval = (c) => {
  const words = [c.program, ...c.args];
  return words.some((w) => HASH_SCRIPT.test(String(w))) && c.args.some((a) => a === "--record" || /^--record=/.test(a));
};
// node -e / --eval / -p / --print text that writes into a previews folder or the plugin's data folder.
const NODE_PROGRAM = /^(node|nodejs|node\.exe)$/i;
const forgesRecord = (c) => {
  if (!NODE_PROGRAM.test(c.program) || !c.args.some((a) => /^-[A-Za-z]*[ep]$/.test(a) || /^--(eval|print)(=|$)/.test(a))) return false;
  const text = slashes(c.args.join(" "));
  return /previews/i.test(text) && /(write(File|Stream|Sync)|\.claude\/phased-shipping)/i.test(text);
};
const PLUGIN_FILE_RULE = rule("protected-plugin-files", "the builder doesn't write the approval records, the plugin's own data, skills, agents and install folders, or run commands-hash.mjs --record",
  PLUGIN_FILE_REASON,
  ["echo x > /h/data/previews/0123456789ab.previewed.json", "echo x>>/h/data/previews/0123456789ab.planned.json", "rm /h/data/previews/0123456789ab.previewed.json", "cp /tmp/x.json /h/data/previews/0123456789ab.planned.json",
    "echo x >> ~/.claude/phased-shipping/hook.mjs", "echo x > ~/.claude/phased-shipping/previews/0123456789ab.previewed.json", "echo x >> ~/.claude/skills/ps-run/SKILL.md", "tee ~/.claude/skills/ps-plan/SKILL.md < x", "sed -i s/a/b/ ~/.claude/agents/ps-shipper.md",
    "echo x>~/.claude/agents/ps-builder.md", "mv /tmp/x ~/.claude/skills/ps-run", "rm -r ~/.claude/skills/ps-plan",
    "node ~/.claude/skills/ps-run/scripts/commands-hash.mjs .plans/phases/phase-7-x.md --record previewed --data ~/.claude/phased-shipping",
    "node plugins/phased-shipping/skills/run/scripts/commands-hash.mjs .plans/phases/phase-7-x.md --record previewed --data ~/.claude/phased-shipping",
    "node -e \"require('fs').writeSync(3,'{}','/d/previews/0123456789ab.previewed.json')\"", "node --eval \"x('/h/.claude/phased-shipping/previews/a.json')\"",
    "echo x >> ~/.claude/plugins/cache/mkt/phased-shipping/1.0.0/skills/run/scripts/commands-hash.mjs", "echo x > ~/.claude/plugins/marketplaces/x/phased-shipping/y", "cp /tmp/x ~/.claude/plugins/cache/mkt/phased-shipping/1.0.0/hooks/guard-rules.mjs",
    "echo x > ~/.claude/x/../phased-shipping/hooks/guard-rules.mjs", "echo x > ~/.claude/./phased-shipping/x", "echo x >> ~/.claude/skills/./ps-run/SKILL.md", "cp -t ~/.claude/skills/ps-run /tmp/SKILL.md", "rsync -a /tmp/x/ ~/.claude/phased-shipping/", "git apply ~/.claude/phased-shipping/x.patch"],
  (c) => writesTo(c, pluginFileWord) || recordsApproval(c) || forgesRecord(c));

const BUILDER_RULES = [...BUILD_RULES, PLAN_FILE_RULE, PLUGIN_FILE_RULE];

export const RULES = { builder: BUILDER_RULES, checker: BUILD_RULES, shipper: SHIP_RULES };

// model-scout has no shell. It may write only PHASES.md in the project folder.
export const SCOUT_RULES = {
  shell: { id: "scout-no-shell", description: "no shell commands", reason: "model-scout has no shell. It only reads, searches and writes PHASES.md.", samples: ["ls", "git status"] },
  path: { id: "scout-phases-only", description: "writes only <cwd>/PHASES.md (never inside .claude)", reason: "model-scout may change nothing but PHASES.md in the project folder.", samples: ["/x/README.md", "/x/src/app.ts", "/x/PHASES.md.bak", "/x/phases.md", "/x/sub/PHASES.md", "/y/PHASES.md", "/x/../y/PHASES.md", "/x/.claude/PHASES.md", "/x/.claude/agents/ps-builder.md", "sub/../../PHASES.md"] },
};

const normalized =(p) => posix.normalize(slashes(p)).replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);
// True when `path` is <cwd>/PHASES.md, with no .claude folder anywhere in it. No cwd means no.
function scoutMayWrite(path, cwd) {
  if (typeof cwd !== "string" || cwd === "") return false;
  const p = slashes(path);
  const base = slashes(cwd);
  const full = normalized(/^([A-Za-z]:)?\//.test(p) ? p : `${base}/${p}`);
  if (full.split("/").includes(".claude")) return false;
  return full === normalized(`${base}/PHASES.md`);
}

// ---------- the decision ----------

// Returns { rule, reason } to deny the call, or null to allow it. Throws on input it can't read, so
// the caller (which knows the role) can fail closed. `cwd` is the hook input's working folder.
export function decide(role, toolName, toolInput, cwd) {
  const input = toolInput ?? {};
  if (SHELL_TOOLS.has(toolName)) {
    if (typeof input.command !== "string") throw new TypeError("the command is missing or not text");
    const command = input.command;
    if (command.trim() === PROBE_COMMAND) {
      return { rule: "guard-probe", reason: `phased-shipping guard is active for ${role} (v${GUARD_VERSION}). This was a self-test; nothing ran.`, probe: true };
    }
    if (role === "model-scout") return { rule: SCOUT_RULES.shell.id, reason: SCOUT_RULES.shell.reason };
    if (toolName === "PowerShell") return { rule: "no-powershell", reason: "Agents in this role use the Bash tool. The PowerShell tool is not part of it: use Bash." };
    if (command.length > MAX_COMMAND_LENGTH) return { rule: "command-length", reason: `command too long to check (over ${MAX_COMMAND_LENGTH} characters). Split it into smaller commands.` };
    const rules = RULES[role];
    for (const cmd of splitCommands(command)) {
      for (const r of rules) if (r.match(cmd)) return { rule: r.id, reason: r.reason };
    }
    return null;
  }
  if (FILE_TOOLS.has(toolName) && role === "model-scout") {
    const paths = [input.file_path, input.notebook_path].filter((p) => p !== undefined);
    if (!paths.length || paths.some((p) => typeof p !== "string")) throw new TypeError("the file path is missing or not text");
    return paths.every((p) => scoutMayWrite(p, cwd)) ? null : { rule: SCOUT_RULES.path.id, reason: SCOUT_RULES.path.reason };
  }
  if (FILE_TOOLS.has(toolName)) {
    // The other roles may write files, but never inside .git or .husky (hooks and config).
    const paths = [input.file_path, input.notebook_path].filter((p) => p !== undefined);
    if (paths.some((p) => typeof p !== "string")) throw new TypeError("the file path is not text");
    if (paths.some((p) => PROTECTED_PATH.test(p))) return { rule: "protected-path", reason: PROTECTED_REASON };
    // The builder works before the preview and never edits the plan files (see PLAN_FILE_RULE).
    if (role === "builder" && paths.some(isPlanFilePath)) return { rule: PLAN_FILE_RULE.id, reason: PLAN_FILE_REASON };
    // Nor the approval records or the plugin's own data and installed files (see PLUGIN_FILE_RULE).
    if (role === "builder" && paths.some(pluginFileWord)) return { rule: PLUGIN_FILE_RULE.id, reason: PLUGIN_FILE_REASON };
  }
  return null;
}

// What guard.mjs does with the text it read from stdin: the deny reason, or null to allow.
// With --agent <role>, the role is known from the argument, so anything unreadable is denied. Without
// it the role comes from agent_type: unreadable text or an unknown role allows (it can't tell whose
// call this is); a known role whose call can't be judged is denied, because these agents fail closed.
export function evaluate(stdinText, argv = []) {
  let input = null;
  let readable = false;
  try { input = JSON.parse(stdinText); readable = true; } catch { /* handled below */ }
  const at = argv.indexOf("--agent");
  let role = null;
  if (at >= 0) {
    role = ROLES.includes(argv[at + 1]) ? argv[at + 1] : null;
    if (!role) return `guard error: --agent needs one of ${ROLES.join(", ")}`;
    if (!readable || input === null || typeof input !== "object" || Array.isArray(input)) return "guard error: the hook input is not a JSON object";
  } else {
    if (!readable || input === null || typeof input !== "object") return null;
    const m = typeof input.agent_type === "string" ? input.agent_type.match(ROLE_PATTERN) : null;
    if (!m) return null;
    role = m[1];
  }
  try {
    const v = decide(role, input.tool_name, input.tool_input, input.cwd);
    if (!v) return null;
    return v.probe ? v.reason : `${v.rule}: ${v.reason}`;
  } catch (e) {
    return `guard error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
