#!/usr/bin/env node
// Ships an approved phase in one run: the ship block of the plan's "## Commands" section, bound to the preview.
//
//   node ship.mjs run --plan <plan> --root <project folder> --roadmap <PHASES.md> --data <data folder>
//
// Nothing runs until all of these pass, in order:
// 1. The binding: the same check as `commands-hash.mjs <plan> --check previewed --root <dir> --roadmap <file>`, in-process.
//    The Commands section, the project folder, the code tree (only the plan and the roadmap fixed at the preview may
//    differ) and the commit message files must be the ones that were previewed, and the record's text must match its hash.
//    The ship block is parsed from the RECORDED section text, and every command runs in the bound real project folder.
// 2. The guard: every command (steps, checks, rollbacks) must pass decide("shipper", "Bash", { command }, root) from the
//    plugin's hooks/guard-rules.mjs, so the shipper's rules hold where hooks are off. The rules file is the plugin's
//    (../../../hooks, beside .claude-plugin/plugin.json) or, for the personal copies, <claude home>/phased-shipping/hooks
//    (its first line must be the sync-personal marker), and it must export DANGEROUS_ENV. The secret matcher is survey.mjs's
//    secretShapeIn, from the onboard skill (onboard, or ps-onboard for the personal copies). If either is missing, nothing runs.
// 3. bash: on Windows the Git Bash bash.exe found from `git --exec-path` (never cmd.exe, never a shell option, never
//    PowerShell); elsewhere bash on the PATH.
// 4. The branch: `git rev-parse --abbrev-ref HEAD` must be the block's branch, and HEAD must be the commit the preview recorded
//    (`head` in the record; a record without one is refused like a record without a tree).
//
// Each command then runs as `bash --noprofile --norc -c <command>` (an argument array) in the project folder, with stdin
// closed, GIT_TERMINAL_PROMPT=0 and without every GIT_* variable, every name on the guard's DANGEROUS_ENV list and the other
// names in commandEnv (hook skips, BASH_ENV and exported bash functions, LD_PRELOAD, NODE_OPTIONS, interpreter options); the home
// folders and PATH stay. The names left out are printed, never their values. stdout and stderr go to one log file per
// command in a fresh folder in the OS temp folder, which is kept for the owner to read. A command that runs past the
// block's timeout is killed with its process tree (taskkill /T /F on Windows, its process group elsewhere).
//
// Only a strict commit step commits (shipBlock in commands-hash.mjs: exactly `git commit` with -q, -s, --no-edit and one
// -F <file>). Right before one, the bound message files are resolved again and hashed (a re-pointed folder link or a
// changed file stops the run), the message files and the staged diff (`git diff --cached --text`) are scanned for secret shapes, and every path
// the commit would change must hold the previewed content (git diff --cached against HEAD and against the previewed tree;
// the plan and the roadmap may differ). HEAD is read before and after every step and check: a step that moves HEAD without
// being a strict commit step, a commit step that makes more than one commit or a merge, and a check that moves HEAD stop
// the run; after a commit step the new commit's own diff is scanned and checked against the previewed tree the same way.
// A git push the script can read must be a strict push step (exactly `git push [-q] origin <the block's branch>`, see pushStep), run
// only while `git symbolic-ref HEAD` is that branch; after one, origin's branch must be HEAD, or the run stops. A push it can't read
// shows only in origin's branches and tags (`git ls-remote origin`, LS_REMOTE_TIMEOUT_MS, OWN_REFS), read before the run, after every
// step (a failed one too), check and rollback line, and once more SETTLE_MS after the last command: a ref that changed with no
// strict push to explain it (whoever changed it), or refs that can't be read, stop the run (exit 3, the ref names printed). The
// snapshot sees origin at those moments only; commands-hash.mjs refuses the background jobs it can read, and on POSIX each
// command's process group is ended when the command exits (defaultReap; a job that started its own session is not in it). A
// program that detaches itself can still push after the last ref check. Steps run in order and stop at the first failure. Then
// the checks run in order; only a check that failed rolls back: its rollback lines run once each, in order, stopping at a
// rollback that fails, and a ref change after a check or a rollback line is reported (the later rollback lines still run). A
// check that passed while its ref check tripped stops the run (exit 3) with nothing rolled back. The checks are not run again
// after a rollback: they test the new version.
//
// It prints one line per command, `step|check|rollback N exit E seconds S` (a timeout is exit 124), the last 20 lines of a
// failed command's log with every secret-shaped line withheld (raw, with its CRs joined and with escape sequences removed, the part
// line a 64 KB read starts in, and every line of a PEM block), and `total seconds N` once something has run. On exit 0 it prints
// `shipped <commit>` only when origin's branch is HEAD (otherwise `checked, but origin's <branch> is ..., not HEAD ...`) and the
// Commands hash. When it stops after a step ran, it says how many steps ran (what
// they did stays done) and whether HEAD moved (a local commit). It never writes the plan, the roadmap or the data folder.
//
// Exit codes. "nothing ran" (2, 5, 6, and 1, 3 or 7 when it says "nothing ran" or "no step ran") means nothing was shipped; 3 or 7 after a
// step ran is a failed ship, like 1, 4 and 8:
//   0 every step and check passed (`shipped <commit>` only when origin's branch is HEAD)
//   1 a step failed (no rollback ran), or HEAD is on another branch or unreadable (then nothing ran)
//   2 usage, no valid ship block, or no log folder (nothing ran)
//   3 the binding failed, HEAD is not the previewed commit, or origin's refs could not be read (nothing ran); or during the run: a ref of
//     origin that changed with no strict push to explain it or could not be read after a step, a passing check (nothing rolled back) or the last command, origin's branch moved but not to HEAD
//     at the end, a push after which origin's branch is not HEAD, a commit message file moved or changed, the staged changes are
//     not the previewed code (nothing was committed), a commit that is not the previewed code or that no strict commit step
//     made, or a check that moved HEAD (no later command ran, and this run pushed nothing after it)
//   4 a check failed and every rollback line passed (a ref change seen meanwhile is reported, not a stop)
//   5 the guard refused a command, or the guard rules or the secret matcher were not found (nothing ran)
//   6 no bash (nothing ran)
//   7 secret-shaped text, or a diff that could not be read, in a message file or the staged changes (nothing was committed) or in the commit a
//     step just made (no later step ran, so this run did not push it); only file names and categories are printed
//   8 a check failed and a rollback line failed: roll back by hand
//
// main(argv, io) is the test seam: io.out; io.git(args, { cwd, env }) (default: tree-state.mjs defaultGit); io.spawn(file,
// args, options) (default: child_process.spawn); io.killTree(child); io.now() (epoch ms); io.platform; io.tmpdir; io.env;
// io.loadSafety() (resolves { decide, secretShapeIn, secretShapes, dangerousEnv } or null); io.findBash() (a path or null); io.bind
// (default: commands-hash.mjs checkPreviewed, same arguments); io.reap(child) (default: defaultReap); io.settleMs and io.sleep(ms)
// (the wait before the last ref check). They exist for the tests in this process only: the command line has no
// way to set them.
// node: built-ins only.

import { spawn as nodeSpawn, execFile } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkPreviewed, messageChanged, shipBlock } from "./commands-hash.mjs";
import { defaultGit } from "./tree-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PERSONAL_MARKER = "// Generated from the phased-shipping plugin by scripts/sync-personal.mjs.";
export const TIMEOUT_EXIT = 124;
export const TAIL_LINES = 20;
export const WITHHELD = "[a line is withheld: it looks like a secret]";
const USAGE = "usage: ship.mjs run --plan <plan> --root <project folder> --roadmap <PHASES.md> --data <data folder>";
const OPTIONS = ["--plan", "--root", "--roadmap", "--data"];
const GRACE_MS = 10000;

const ch = (n) => String.fromCodePoint(n);
const UNPRINTABLE = new RegExp(`[${ch(0)}-${ch(8)}${ch(0xa)}-${ch(0x1f)}${ch(0x7f)}-${ch(0x9f)}${ch(0x61c)}${ch(0x200b)}-${ch(0x200f)}${ch(0x2028)}-${ch(0x202e)}${ch(0x2060)}-${ch(0x2069)}${ch(0xfeff)}]`, "gu");
const ANSI = new RegExp(`${ch(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
// Text from git or a log, made safe to print: escape sequences dropped, control and format characters shown as "?".
export const printable = (s) => String(s).replace(ANSI, "").replace(UNPRINTABLE, "?");

// ---------- where the guard rules and the secret matcher are ----------

// The two layouts: the plugin (skills/run/scripts -> ../../../hooks) and the personal copies made by sync-personal.mjs
// (<claude home>/skills/ps-run/scripts -> <claude home>/phased-shipping/hooks; the onboard skill is ps-onboard).
export function safetyFiles(here = HERE) {
  const up = join(here, "..", "..", "..");
  return [
    { layout: "plugin", guard: join(up, "hooks", "guard-rules.mjs"), manifest: join(up, ".claude-plugin", "plugin.json"), survey: join(here, "..", "..", "onboard", "scripts", "survey.mjs") },
    { layout: "personal", guard: join(up, "phased-shipping", "hooks", "guard-rules.mjs"), marker: true, survey: join(here, "..", "..", "ps-onboard", "scripts", "survey.mjs") },
  ];
}

// { decide, secretShapeIn, dangerousEnv, layout } from the first layout whose files are all there and export them, or null.
export async function loadSafety(here = HERE, { exists = existsSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  for (const c of safetyFiles(here)) {
    if (!exists(c.guard) || !exists(c.survey) || (c.manifest && !exists(c.manifest))) continue;
    if (c.marker) {
      let first = "";
      try { first = read(c.guard).split(/\r?\n/, 1)[0]; } catch { /* not readable: not this layout */ }
      if (!first.startsWith(PERSONAL_MARKER)) continue;
    }
    try {
      const guard = await import(pathToFileURL(c.guard).href);
      const survey = await import(pathToFileURL(c.survey).href);
      if (typeof guard.decide === "function" && guard.DANGEROUS_ENV instanceof RegExp && typeof survey.secretShapeIn === "function") {
        return { decide: guard.decide, secretShapeIn: survey.secretShapeIn, secretShapes: Array.isArray(survey.SECRET_SHAPES) ? survey.SECRET_SHAPES : null, dangerousEnv: guard.DANGEROUS_ENV, layout: c.layout };
      }
    } catch { /* try the next layout */ }
  }
  return null;
}

// ---------- bash and the environment ----------

const isFile = (p, executable = false) => {
  try {
    if (!statSync(p).isFile()) return false;
    if (executable) accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
};

// The environment of each command: the parent's, without the names that make git, a hook runner, bash, node or the dynamic
// loader do something else. Every GIT_* variable goes (GIT_DIR and GIT_CONFIG_COUNT/KEY_n/VALUE_n can point git at another
// repository or set core.hooksPath; GIT_SSH_COMMAND and GIT_EXEC_PATH run another program), every name on the guard's
// DANGEROUS_ENV list (`dangerous`, from guard-rules.mjs) and the fixed names below (they go even without the list). The home
// folders and PATH stay: git reads its config through them. PATH from the session is a known limit (a program earlier on it
// runs instead). Returns { env, dropped }: dropped is the sorted list of names left out, for printing; never their values.
const DROPPED = /^(GIT_\w*|HUSKY\w*|SKIP|LEFTHOOK\w*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_FUNC_.+|PROMPT_COMMAND|SSH_ASKPASS|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w+|NODE_OPTIONS|OVERCOMMIT_DISABLE|PRE_COMMIT_ALLOW_NO_CONFIG|PERL5OPT|RUBYOPT|PYTHONSTARTUP|JAVA_TOOL_OPTIONS|npm_config_script_shell)$/i;
const KEPT = /^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|PATH|GIT_TERMINAL_PROMPT)$/i;
export function commandEnv(env, dangerous = null) {
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(env)) {
    if (!KEPT.test(k) && (DROPPED.test(k) || (dangerous instanceof RegExp && dangerous.test(k)))) dropped.push(k);
    else out[k] = v;
  }
  return { env: { ...out, GIT_TERMINAL_PROMPT: "0" }, dropped: dropped.sort() };
}

// The parent's environment for this script's own git calls: the fixed names of commandEnv left out.
export const gitEnv = (env) => commandEnv(env).env;

// The bash to run the commands with, or null. Windows: Git Bash from the git install (`git --exec-path` is
// <git>/<mingw64 or similar>/libexec/git-core; bin/bash.exe first, it sets up the PATH, then usr/bin/bash.exe). Never a bash
// from the PATH there (it can be another product's). Elsewhere: the first bash on the PATH.
export function findBash({ platform = process.platform, git = defaultGit, env = process.env, cwd, exists = isFile } = {}) {
  if (platform === "win32") {
    let execPath = "";
    try { execPath = String(git(["--exec-path"], { cwd, env: gitEnv(env) })).trim(); } catch { return null; }
    if (!execPath) return null;
    const top = win32.resolve(execPath, "..", "..", "..");
    for (const p of [win32.join(top, "bin", "bash.exe"), win32.join(top, "usr", "bin", "bash.exe")]) if (exists(p)) return p;
    return null;
  }
  for (const dir of String(env.PATH ?? "").split(":")) {
    if (!dir || !dir.startsWith("/")) continue;
    const p = `${dir.replace(/\/+$/, "")}/bash`;
    if (exists(p, true)) return p;
  }
  return null;
}

// Kills a command and everything it started.
export function defaultKillTree(child, platform = process.platform) {
  if (!child?.pid) return;
  if (platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => { /* gone already */ });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone already */ } }
}

// After a command exits, ends what it left running in its process group (POSIX: each command runs in a group of its own), so a
// job that stayed in the group can't act after the checks. A job that started its own session (setsid, a daemon) is not in the
// group and is not reached. On Windows there is no such group, and a taskkill of a process that has exited could hit an
// unrelated process that reuses its id, so nothing is done there: a job that leaves the tree can outlive its command. Ship lines
// refuse & and the shell-level detachers the reader can see (checkReadable in commands-hash.mjs), not a program that detaches itself.
export function defaultReap(child, platform = process.platform) {
  if (!child?.pid || platform === "win32") return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is empty: nothing left */ }
}

// ---------- one command ----------

function runCommand(ctx, kind, n, command) {
  const log = join(ctx.logDir, `${kind}-${n}.log`);
  let fd;
  // A new file, opened to write ("wx"): Git Bash on Windows writes nothing to a handle opened to append.
  try { fd = openSync(log, "wx"); } catch { return Promise.resolve({ code: 127, seconds: 0, log, timedOut: false }); }
  const started = ctx.now();
  return new Promise((done) => {
    let finished = false;
    let timedOut = false;
    let grace;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      try { closeSync(fd); } catch { /* closed already */ }
      done({ code: timedOut ? TIMEOUT_EXIT : code, timedOut, log, seconds: Math.max(0, Math.round((ctx.now() - started) / 1000)) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      ctx.killTree(child);
      grace = setTimeout(() => finish(TIMEOUT_EXIT), GRACE_MS);
    }, ctx.timeout * 1000);
    let child;
    try {
      child = ctx.spawn(ctx.bash, ["--noprofile", "--norc", "-c", command], {
        cwd: ctx.root, env: ctx.env, stdio: ["ignore", fd, fd], windowsHide: true, detached: ctx.platform !== "win32", shell: false,
      });
    } catch { finish(127); return; }
    child.on("error", () => finish(127));
    child.on("exit", (code, signal) => {
      if (!timedOut) ctx.reap(child);
      finish(typeof code === "number" ? code : signal ? 137 : 1);
    });
  });
}

// The last lines of a log (at most its last 64 KB), each secret-shaped line withheld. A line is withheld when the matcher
// finds a secret shape in it as written, as a terminal shows it (terminalForms: escape sequences, control characters and
// backspaces can glue a token to a word or cut it in two) or as it would be printed, and every line of a PEM block is withheld (BEGIN to END; a BEGIN with no END runs to
// the end, an END with no BEGIN from the start). When the read starts inside the file, its first line is a part line and is
// never shown: it can be the end of a secret whose start was cut off.
const PEM_BEGIN = /-----BEGIN [^-\n]*-----/;
const PEM_END = /-----END [^-\n]*-----/;
// What a terminal shows for a line, in the ways a token can be cut by what it hides. Every string sequence (OSC such as a title or
// a hyperlink, DCS, SOS, PM and APC, ended by ST or BEL, in their 7-bit and 8-bit forms), CSI sequence (a colour), other ESC pair
// and control character is removed with the rest joined, tabs too (`ghp_AB<DCS>CD` shows ghp_ABCD); each one is replaced by a space
// (`a<colour>ghp_...` shows a, then the token, which the matcher needs apart from the a); and a carriage return goes back to column 0
// and overwrites (`<36 chars>\rghp_` shows ghp_ and the 36 chars). Backspaces are applied first (`ghp_ABX<BS>CD` shows ghp_ABCD).
// The joined text is also read percent-decoded (`ghp%5F...`). nF escapes (`ESC ( B`, `ESC # 8`) are removed whole. A string
// sequence that is never ended runs to the end of the line, so the line is also read with only the introducers, their numeric
// parameters and the terminators removed and the payload kept (`ghp_AB<ESC ] 0;>CD` reads ghp_ABCD): nothing a sequence covers can
// hide a token.
const ESC = ch(0x1b);
const STRING_SEQ = new RegExp(`(?:${ESC}[\\]PX^_]|[${ch(0x90)}${ch(0x98)}${ch(0x9d)}-${ch(0x9f)}])[^${ch(7)}${ESC}${ch(0x9c)}]*(?:${ch(7)}|${ESC}\\\\|${ch(0x9c)})?`, "g");
const CSI_SEQ = new RegExp(`(?:${ESC}\\[|${ch(0x9b)})[0-9;?]*[ -/]*[@-~]`, "g");
const ESC_PAIR = new RegExp(`${ESC}[ -/]*[0-~]?`, "g");
const STRING_INTRO = new RegExp(`(?:${ESC}[\\]PX^_]|[${ch(0x90)}${ch(0x98)}${ch(0x9d)}-${ch(0x9f)}])[0-9;]*|${ch(7)}|${ESC}\\\\|${ch(0x9c)}`, "g");
const CONTROLS = new RegExp(`[${ch(0)}-${ch(8)}${ch(0xb)}-${ch(0x1f)}${ch(0x7f)}-${ch(0x9f)}]`, "g");
const applyBackspaces = (t) => { const out = []; for (const c of t) { if (c === "\b") out.pop(); else out.push(c); } return out.join(""); };
// A carriage return: back to column 0, and what follows writes over what is there.
const applyReturns = (t) => {
  const cells = [];
  let col = 0;
  for (const c of t) {
    if (c === "\r") { col = 0; continue; }
    cells[col++] = c;
  }
  return cells.join("");
};
const withoutSequences = (l, sep) => applyBackspaces(l.replace(STRING_SEQ, sep).replace(CSI_SEQ, sep).replace(ESC_PAIR, sep));
const percentDecoded = (t) => t.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const terminalForms = (l) => {
  const joined = withoutSequences(l, "").replace(CONTROLS, "").replace(/\t/g, "");
  const spaced = withoutSequences(l, " ").replace(CONTROLS, " ");
  const overwritten = applyReturns(withoutSequences(l, "")).replace(CONTROLS, "");
  const introducersOnly = applyBackspaces(l.replace(STRING_INTRO, "").replace(CSI_SEQ, "").replace(ESC_PAIR, "")).replace(CONTROLS, "").replace(/\t/g, "");
  return [joined, spaced, overwritten, introducersOnly, percentDecoded(joined), percentDecoded(l)];
};

export function logTail(file, secretShapeIn, count = TAIL_LINES) {
  let text = "";
  let cut = false;
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      cut = size > len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return ["  (the log could not be read)"]; }
  // Lines end at \n only: a lone CR (a progress bar redrawing its line) stays inside its line, so it never splits a token in two.
  let lines = text.replace(/\n$/, "").split("\n").map((l) => l.replace(/\r$/, ""));
  if (cut) lines = lines.slice(1);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return [cut ? "  (the end of the log is one long line; read the log file)" : "  (the log is empty)"];
  const pem = new Set();
  let open = -1;
  let last = -1;
  lines.forEach((l, i) => {
    const s = l.replace(ANSI, "");
    if (PEM_BEGIN.test(s) && open < 0) open = i;
    if (PEM_END.test(s)) {
      for (let k = open >= 0 ? open : last + 1; k <= i; k++) pem.add(k);
      open = -1;
      last = i;
    }
  });
  if (open >= 0) for (let k = open; k < lines.length; k++) pem.add(k);
  const secret = (l) => [l, ...terminalForms(l), printable(l)].some((v) => secretShapeIn(v, { names: true }));
  return lines.map((l, i) => (pem.has(i) || secret(l) ? `  ${WITHHELD}` : `  ${printable(l).slice(0, 400)}`)).slice(-count);
}

// ---------- the staged diff and the commits ----------

// The diff that is scanned: every file as text (--text: a .gitattributes "-diff" or "binary" can't hide a file's lines), no
// external diff, no textconv driver, no colour. Then --cached (the staged changes) or two commits.
const DIFF_ARGS = ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "diff", "--text", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=0", "--src-prefix=a/", "--dst-prefix=b/"];
// The names of the changed paths, as git writes them (-z: never quoted).
const NAME_ARGS = ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff"];
const HEX_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// `git ls-remote origin` gets this long before it counts as failed (then the run stops: it can't show what was pushed).
const LS_REMOTE_TIMEOUT_MS = 60 * 1000;
// The refs of origin the ref check compares: branches and tags. The rest belong to the hosting service or to other tools and change
// on their own (refs/pull/N/merge is recomputed after a push to the base branch; refs/merge-requests, refs/changes, refs/notes,
// refs/remotes, refs/keep-around, refs/pipelines and the like), and HEAD follows the default branch.
const OWN_REFS = /^refs\/(heads|tags)\//;
// The default wait before the ref check after the last command, for a push that lands a moment late.
const SETTLE_MS = 3000;

// Lockfiles and checksum lists: their 64-hex lines are content checksums, not secrets. Only the 64-hex shape is skipped there, and
// only with the survey's shape list at hand (every other shape still applies to them; the 64-hex shape still applies everywhere else).
const CHECKSUM_FILES = new Set(["Cargo.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "poetry.lock", "Gemfile.lock", "composer.lock", "SHA256SUMS"]);
const HEX_SHAPE = "a 64-character hex string";
const checksumFile = (file) => { const base = String(file).split("/").pop(); return CHECKSUM_FILES.has(base) || base.endsWith(".sha256"); };
const FORMAT_CHARS = /\p{Cf}/gu;

// [{ file, category }] for every added line of a diff with a secret shape (one entry per file and category). `shapes` is the survey's
// SECRET_SHAPES list ([regex, category] pairs): with it, a 64-hex match in a checksum file is looked at again with every other shape.
export function stagedSecrets(diffText, secretShapeIn, shapes = null) {
  const hits = [];
  const seen = new Set();
  let file = null;
  let hunk = false;
  for (const line of String(diffText).split("\n")) {
    if (line.startsWith("diff --git ")) { hunk = false; file = null; continue; }
    if (!hunk) {
      if (line.startsWith("+++ ")) file = line.slice(4) === "/dev/null" ? null : line.slice(4).replace(/^b\//, "");
      else if (line.startsWith("@@")) hunk = true;
      continue;
    }
    if (line.startsWith("@@") || !line.startsWith("+")) continue;
    let category = secretShapeIn(line.slice(1));
    if (category === HEX_SHAPE && Array.isArray(shapes) && file !== null && checksumFile(file)) {
      const text = line.slice(1);
      const views = [text, text.replace(FORMAT_CHARS, "")];
      category = shapes.filter(([, label]) => label !== HEX_SHAPE).find(([re]) => views.some((v) => re.test(v)))?.[1] ?? null;
    }
    if (!category) continue;
    const name = file ?? "(a file)";
    if (seen.has(`${name}\0${category}`)) continue;
    seen.add(`${name}\0${category}`);
    hits.push({ file: name, category });
  }
  return hits;
}

// ---------- the run ----------

function parse(argv) {
  if (argv[0] !== "run") return null;
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!OPTIONS.includes(a) || opts[a] !== undefined) return null;
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith("--") || argv[i + 1] === "") return null;
    opts[a] = argv[++i];
  }
  return OPTIONS.every((o) => opts[o] !== undefined) ? opts : null;
}

// A stop during the run: why it stopped, with detail lines (names, never content). main adds how many steps ran and where
// HEAD is, so the owner knows what is done.
class Stop extends Error {
  constructor(code, line, details = [], extra = {}) { super(line); this.code = code; this.details = details; Object.assign(this, extra); }
}

export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const say = (s) => out(`${s}\n`);
  const now = io.now ?? Date.now;
  const started = now();
  const platform = io.platform ?? process.platform;
  const git = io.git ?? defaultGit;
  const env = io.env ?? process.env;
  const total = () => say(`total seconds ${Math.max(0, Math.round((now() - started) / 1000))}`);

  const opts = parse(argv);
  if (!opts) { say(USAGE); say("nothing ran (exit 2)"); return 2; }

  // 1. The binding, and the ship block from the recorded text.
  const bind = io.bind ?? checkPreviewed;
  const bound = bind(opts["--plan"], opts["--data"], "previewed", { root: resolve(opts["--root"]), roadmap: opts["--roadmap"] }, { git: io.git, tmpdir: io.tmpdir });
  if (bound.code !== 0) {
    for (const text of [bound.out, bound.err]) if (text) out(text);
    say("nothing ran: the approval is not bound to this plan and this code; run the preview again (exit 3)");
    return 3;
  }
  if (typeof bound.root !== "string" || !Array.isArray(bound.allowed)) { say("nothing ran: the binding named no project folder; run the preview again (exit 3)"); return 3; }
  // Every command and every git call runs in the bound real project folder, never in another spelling of --root.
  const rootSlash = bound.root;
  const root = resolve(rootSlash);
  const fold = (s) => (process.platform === "win32" ? String(s).toLowerCase() : String(s));
  const allowed = bound.allowed.map(fold);
  let block;
  try { block = shipBlock(bound.saved.text); } catch (e) {
    say(`nothing ran: the ship block is invalid: ${printable(e.message)} (exit 2)`);
    return 2;
  }
  if (!block) { say("nothing ran: the previewed Commands section has no ship block; brief the shipper instead (exit 2)"); return 2; }

  // 2. The guard, for every command, before anything runs.
  const safety = io.loadSafety ? await io.loadSafety() : await loadSafety();
  if (!safety) { say("nothing ran: the guard rules or the secret matcher were not found; brief the shipper instead (exit 5)"); return 5; }
  const all = [
    ...block.steps.map((c, i) => ["step", i + 1, c]),
    ...block.checks.map((c, i) => ["check", i + 1, c]),
    ...block.rollbacks.map((c, i) => ["rollback", i + 1, c]),
  ];
  for (const [kind, n, command] of all) {
    let verdict;
    try { verdict = safety.decide("shipper", "Bash", { command }, root); } catch (e) { verdict = { rule: "guard-error", reason: e instanceof Error ? e.message : String(e) }; }
    if (verdict) { say(`nothing ran: the guard refused ${kind} ${n} (${printable(verdict.rule)}): ${printable(verdict.reason)} (exit 5)`); return 5; }
  }

  // 3. bash.
  const bash = io.findBash ? io.findBash() : findBash({ platform, git, env, cwd: root });
  if (!bash) { say(`nothing ran: no bash was found${platform === "win32" ? " in the Git install (git --exec-path)" : " on the PATH"} (exit 6)`); return 6; }

  // 4. The branch, and HEAD.
  const own = gitEnv(env);
  const git1 = (args) => git(args, { cwd: root, env: own });
  let branch = "";
  try { branch = String(git1(["rev-parse", "--abbrev-ref", "HEAD"])).trim(); } catch { branch = ""; }
  if (branch !== block.branch) {
    say(`nothing ran: HEAD is on ${branch ? printable(branch) : "no readable branch"}, and the ship block says ${block.branch} (exit 1)`);
    return 1;
  }
  const readHead = () => { try { const h = String(git1(["rev-parse", "HEAD"])).trim(); return HEX_COMMIT.test(h) ? h : null; } catch { return null; } };
  const startHead = readHead();
  if (!startHead) { say("nothing ran: HEAD could not be read (exit 1)"); return 1; }
  // The commit the preview was made on: a commit made since then is refused even when its tree is the previewed one (what is pushed
  // is history, not only a tree).
  const boundHead = bound.saved.head;
  if (typeof boundHead !== "string") { say("nothing ran: the previewed record holds no HEAD commit (it was made before that check); run the preview again (exit 3)"); return 3; }
  if (boundHead !== startHead) { say(`nothing ran: HEAD is ${startHead}, and the preview bound ${printable(boundHead)}; run the preview again (exit 3)`); return 3; }
  // origin's refs (`git ls-remote origin`, with a timeout of its own): a Map from ref name to commit, the HEAD line left out (it
  // follows the default branch). Throws when git can't say. Read before the run and after every step, check and rollback line:
  // whatever a command did that the script can't read (a script file, a deploy tool), a ref it changed shows here.
  const branchRef = `refs/heads/${block.branch}`;
  const remoteRefs = () => {
    const refs = new Map();
    for (const line of String(git(["ls-remote", "origin"], { cwd: root, env: own, timeout: LS_REMOTE_TIMEOUT_MS })).split(/\r?\n/)) {
      const [id, ref] = line.split("\t");
      if (ref && OWN_REFS.test(ref) && HEX_COMMIT.test(id)) refs.set(ref, id);
    }
    return refs;
  };
  let refs;
  try { refs = remoteRefs(); } catch {
    say("nothing ran: origin's refs could not be read (git ls-remote failed or timed out), so the run could not show what it pushed; run it when origin can be reached (exit 3)");
    return 3;
  }
  const startBranch = refs.get(branchRef);

  let logDir;
  try { logDir = mkdtempSync(join(io.tmpdir ?? osTmpdir(), "ship-")); } catch { say("nothing ran: the log folder could not be made in the OS temp folder (exit 2)"); return 2; }
  say(`log folder ${logDir}`);
  const commands = commandEnv(env, safety.dangerousEnv);
  if (commands.dropped.length) say(`left out of the commands' environment: ${commands.dropped.map(printable).join(", ")}`);
  const ctx = {
    spawn: io.spawn ?? nodeSpawn, killTree: io.killTree ?? ((c) => defaultKillTree(c, platform)), reap: io.reap ?? ((c) => defaultReap(c, platform)), now, platform, root, env: commands.env,
    bash, timeout: block.timeout, logDir,
  };
  const run = async (kind, n, command) => {
    const r = await runCommand(ctx, kind, n, command);
    say(`${kind} ${n} exit ${r.code} seconds ${r.seconds}`);
    if (r.timedOut) say(`${kind} ${n} ran past ${block.timeout} seconds and was killed with its process tree`);
    if (r.code !== 0) for (const l of logTail(r.log, safety.secretShapeIn)) say(l);
    return r.code;
  };

  // What the steps did so far, for a stop after the checks above: how many ran and whether HEAD moved.
  let stepsRan = 0;
  let pushed = false; // a strict push step ran and origin's branch became HEAD
  const done = () => {
    if (stepsRan === 0) return "no step ran, so nothing was shipped";
    const head = readHead();
    const where = head === startHead ? `HEAD is still ${startHead}, so this run made no commit` : head ? `HEAD is now ${head} (it was ${startHead})` : "HEAD could not be read";
    return `${stepsRan} step${stepsRan === 1 ? "" : "s"} ran (what ${stepsRan === 1 ? "it" : "they"} did stays done); ${where}`;
  };
  // The paths a commit would change or did change (changeArgs) whose content is not the previewed content there (the
  // previewed tree differs from it at that path: previewArgs), leaving out the paths that may change. Throws when git can't
  // compare. A previewed change that is not staged is fine; a staged change that was not previewed is not.
  const savedTree = bound.saved.tree;
  const notPreviewed = (changeArgs, previewArgs) => {
    const names = (args) => String(git1([...NAME_ARGS, ...args])).split("\0").filter(Boolean);
    const differs = new Set(names(previewArgs).map(fold));
    return names(changeArgs).filter((n) => differs.has(fold(n)) && !allowed.includes(fold(n)));
  };
  const scan = (args) => stagedSecrets(git1([...DIFF_ARGS, ...args]), safety.secretShapeIn, safety.secretShapes);
  const hitLines = (hits) => hits.map((h) => `  ${printable(h.file)}: ${h.category}`);
  const nameLines = (names) => [...names.slice(0, 50).map((x) => `  ${printable(x)}`), ...(names.length > 50 ? [`  and ${names.length - 50} more`] : [])];
  // origin's refs after a command, against the ones before it. Only a strict push (a push step, or a rollback line with the strict
  // push) may change one, and only the block's branch, to HEAD. Anything else stops the run (exit 3), naming the refs, never a URL;
  // a ref changed by someone else (CI, a bot, a person) looks the same and stops it too. The snapshot moves on to what was seen, so a
  // later check compares with it.
  const OTHERS = "  (a ref changed by something else (CI, another person) is indistinguishable from a push this run did not intend)";
  const refsAfter = (what, pushed, later) => {
    let now;
    try { now = remoteRefs(); } catch {
      throw new Stop(3, `after ${what} origin's refs could not be read (git ls-remote failed or timed out), so it can't be shown that nothing was pushed: stopped; no later ${later} ran`, [], { unread: true });
    }
    const head = readHead();
    const changed = [...new Set([...refs.keys(), ...now.keys()])].filter((r) => refs.get(r) !== now.get(r)).sort();
    const unexplained = changed.filter((r) => !(pushed && r === branchRef && head && now.get(r) === head));
    refs = now;
    if (unexplained.length) throw new Stop(3, `after ${what} origin's refs changed, and no strict push step can explain it: stopped; no later ${later} ran`, [...nameLines(unexplained), OTHERS]);
  };
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  try {
    // The steps, in order, stopping at the first failure.
    for (let i = 0; i < block.steps.length; i++) {
      const n = i + 1;
      const commit = block.commits[i];
      const before = readHead();
      if (!before) throw new Stop(3, `step ${n} was not run: HEAD could not be read`);
      if (commit) {
        const notRun = `step ${n} was not run, so nothing was committed:`;
        for (const m of bound.saved.messages ?? []) {
          const changed = messageChanged(rootSlash, m);
          if (changed?.why === "moved") throw new Stop(3, `${notRun} the commit message file ${printable(m.file)} is not at its previewed real path (a folder on its way changed)`);
          if (changed) throw new Stop(3, `${notRun} the commit message file ${printable(m.file)} changed during the run`);
          // The message is committed too: scanned like the staged lines, name and category only.
          let text = "";
          try { text = readFileSync(m.path, "utf8"); } catch { throw new Stop(3, `${notRun} the commit message file ${printable(m.file)} could not be read`); }
          const category = text.split(/\r?\n/).map((l) => safety.secretShapeIn(l, { names: true })).find(Boolean) ?? safety.secretShapeIn(text, { names: true });
          if (category) throw new Stop(7, `${notRun} secret-shaped text in a commit message file`, [`  ${printable(m.file)}: ${category}`]);
        }
        let hits;
        try { hits = scan(["--cached"]); } catch { throw new Stop(7, `${notRun} the staged diff could not be read for the secret scan`); }
        if (hits.length) throw new Stop(7, `${notRun} secret-shaped text in the staged changes`, hitLines(hits));
        if (typeof savedTree !== "string") throw new Stop(3, `${notRun} the previewed record holds no tree id to check the staged changes against`);
        let other;
        try { other = notPreviewed(["--cached", before], ["--cached", savedTree]); } catch { throw new Stop(3, `${notRun} the staged changes could not be compared with the previewed code`); }
        if (other.length) throw new Stop(3, `${notRun} the staged changes are not the previewed code (only the plan and the roadmap may differ)`, nameLines(other));
      }
      if (block.pushes[i]) {
        // A push step pushes the current branch's HEAD: HEAD must be on the block's branch, not detached or on another one.
        let sym = "";
        try { sym = String(git1(["symbolic-ref", "-q", "HEAD"])).trim(); } catch { sym = ""; }
        if (sym !== branchRef) throw new Stop(3, `step ${n} was not run: HEAD is ${sym ? printable(sym) : "detached or unreadable"}, not ${branchRef}`);
      }
      const ok = (await run("step", n, block.steps[i])) === 0;
      stepsRan++;
      if (!ok) {
        // A failed or timed-out step gets its ref check too: what it pushed before it failed is named (the exit stays 1).
        let seen = [];
        try { refsAfter(`step ${n}`, block.pushes[i], "step or check"); } catch (e) {
          if (!(e instanceof Stop)) throw e;
          seen = e.unread ? [`  origin's refs could not be read after step ${n}`] : [`  origin's refs changed during step ${n}:`, ...e.details];
        }
        throw new Stop(1, "a step failed: the ship stopped there and no rollback ran", seen);
      }
      const after = readHead();
      if (!after) throw new Stop(3, `step ${n} ran, and HEAD could not be read after it: stopped; no later step ran`);
      if (after !== before) {
        const kept = "stopped; no later step ran, so this run did not push it";
        if (!commit) throw new Stop(3, `step ${n} moved HEAD to ${after}, a commit that no bound commit step made: ${kept} unless step ${n} did`);
        let parents = [];
        try { parents = String(git1(["rev-list", "--parents", "-n", "1", after])).trim().split(/\s+/); } catch { parents = []; }
        if (parents.length !== 2 || parents[0] !== after || parents[1] !== before) throw new Stop(3, `step ${n} made more than one commit, or a merge (HEAD is now ${after}): ${kept}`);
        let hits;
        try { hits = scan([before, after]); } catch { throw new Stop(7, `step ${n} made the local commit ${after}, and its diff could not be read for the secret scan: ${kept}`); }
        if (hits.length) throw new Stop(7, `step ${n} made the local commit ${after}, and it holds secret-shaped text: ${kept}`, hitLines(hits));
        let other;
        try { other = notPreviewed([before, after], [savedTree, after]); } catch { throw new Stop(3, `step ${n} made the local commit ${after}, and it could not be compared with the previewed code: ${kept}`); }
        if (other.length) throw new Stop(3, `step ${n} made the local commit ${after}, and it holds code that was not previewed: ${kept}`, nameLines(other));
      }
      refsAfter(`step ${n}`, block.pushes[i], "step or check");
      // A strict push step pushes HEAD to origin's branch: origin must now have exactly HEAD there.
      if (block.pushes[i] && refs.get(branchRef) !== after) {
        throw new Stop(3, `step ${n} pushed, but origin's ${block.branch} is ${refs.get(branchRef) ?? "not there"}, not HEAD ${after}: stopped; no later step or check ran`);
      }
      if (block.pushes[i]) pushed = true;
    }

    // The checks, in order; at the first failure, the rollback lines once each. A check that moves HEAD stops everything:
    // the rollback lines would then undo a commit nobody previewed. Only a check that failed rolls back: when a passing check's
    // ref check trips (origin changed, or can't be read), the run stops with exit 3 and rolls nothing back; a failing check's
    // ref trip is reported and the rollback lines run as for any failed check (exit 4, or 8).
    for (let i = 0; i < block.checks.length; i++) {
      const before = readHead();
      const ok = (await run("check", i + 1, block.checks[i])) === 0;
      const after = readHead();
      if (!after || after !== before) throw new Stop(3, `check ${i + 1} moved HEAD to ${after ?? "a commit that could not be read"}: stopped before any later check or rollback`);
      let tripped = null;
      try { refsAfter(`check ${i + 1}`, false, "check"); } catch (e) {
        if (!(e instanceof Stop)) throw e;
        tripped = e;
      }
      if (ok && !tripped) continue;
      const what = (e, n) => (e.unread ? `${n} origin's refs could not be read (git ls-remote failed or timed out)` : `${n} origin's refs changed, and no strict push step can explain it`);
      if (ok) {
        // The check passed: a ref someone else may have changed (a release tag, a bot branch) is no reason to undo a good deploy.
        // Nothing is rolled back; the run stops and says whether origin's branch is still the commit it shipped.
        const now = readHead();
        const remote = refs.get(branchRef);
        const where = tripped.unread ? `origin's ${block.branch} could not be read`
          : remote === now ? `origin's ${block.branch} is HEAD`
            : !pushed && remote === startBranch ? `origin's ${block.branch} is unchanged; this run did not push HEAD`
            : `origin's ${block.branch} is ${remote ?? "not there"}, not HEAD ${now ?? "(not readable)"}: the deployed commit is not what was shipped; check origin by hand`;
        throw new Stop(3, `${what(tripped, `after check ${i + 1}`)}; the check passed, so nothing was rolled back; ${where}`, tripped.details);
      }
      if (tripped) {
        say(`${what(tripped, `after check ${i + 1}`)} (reported; the check failed, so the rollback lines run)`);
        for (const l of tripped.details) say(l);
      }
      say(`check ${i + 1} failed: rolling back`);
      for (let j = 0; j < block.rollbacks.length; j++) {
        const code = await run("rollback", j + 1, block.rollbacks[j]);
        // A ref changed after a rollback line is reported, and the later rollback lines still run (they finish undoing the
        // deploy). After a ref read failed, a rollback line can't be checked either.
        if (!tripped?.unread) {
          try { refsAfter(`rollback ${j + 1}`, block.rollbackPushes[j], "rollback line"); } catch (e) {
            if (!(e instanceof Stop)) throw e;
            say(`${what(e, `after rollback ${j + 1}`)} (reported; the later rollback lines still run)`);
            for (const l of e.details) say(l);
          }
        }
        if (code === 0) continue;
        const left = block.rollbacks.length - j - 1;
        say(`rollback ${j + 1} failed${left ? ` and ${left} later rollback line${left === 1 ? " was" : "s were"} not run` : ""}: roll back by hand (exit 8)`);
        total();
        return 8;
      }
      say("a check failed and every rollback line passed (exit 4)");
      total();
      return 4;
    }
    // One more ref check after the last command, after a short wait: a push that lands a moment late is seen too.
    await sleep(io.settleMs ?? SETTLE_MS);
    refsAfter("the last command", false, "command");
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    say(`${e.message}; ${done()} (exit ${e.code})`);
    for (const l of e.details) say(l);
    total();
    return e.code;
  }

  // `shipped` names a commit only when origin's branch is that commit: a block that pushes nothing, or a push that did not land, says so.
  // origin's refs were checked after every command, so they are the last snapshot.
  const head = readHead();
  const remote = refs.get(branchRef);
  if (head && remote === head) say(`shipped ${head}`);
  else if (remote !== startBranch) {
    // Not reachable while every command is followed by the ref check; kept so a run never ends 0 with origin's branch moved elsewhere.
    say(`origin's ${block.branch} moved during the run to ${remote ?? "nothing"}, which is not HEAD ${head ?? "(not readable)"}: check origin by hand (exit 3)`);
    total();
    return 3;
  } else say(`checked, but origin's ${block.branch} is ${remote ?? "not there"}, not HEAD ${head ?? "(not readable)"}: this run did not put HEAD on origin, and origin's branches and tags were as before at every ref check`);
  say(`Commands hash: ${bound.hash.slice(0, 12)}`);
  total();
  return 0;
}

// Run as a script, not when a test imports it (paths resolved through links, as in the other scripts).
const realOf = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stdout.write(`ship: stopped by an error: ${printable(e instanceof Error ? e.message : String(e))}; check the project by hand\n`);
    process.exitCode = 1;
  });
}
