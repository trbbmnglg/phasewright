// Splits a shell command line into simple commands, for hook scripts that must decide what a
// command would run. No dependencies. Shared source: other hook plugins copy this file as it is,
// and a test checks that the copies stay identical.
//
//   splitCommands('cd x && FOO=1 /usr/bin/git -C y push')
//     -> [ { program: "cd", args: ["x"], globals: [], env: [] },
//          { program: "git", args: ["push"], globals: ["-C", "y"], env: ["FOO=1"] } ]
//
// It splits on && || ; | & and newlines (quotes respected) and descends into $(...), backticks,
// <(...), heredocs piped to a shell, `bash -c "..."`, `powershell -Command ...`, `cmd /c ...`,
// `eval ...`, `xargs <cmd>`, `find -exec <cmd>` and `npx` / `pnpm exec` style launchers. For each
// simple command it returns the leading VAR=value assignments in `env` (also those given through
// `env` or `sudo`), drops redirections and wrappers (env, sudo, time, and so on), and reduces a path
// to the program name. For git it also moves git's global options (-C <dir>, -c <k=v>,
// --git-dir, ...) into `globals`, so `args[0]` is the subcommand.
//
// A command that uses syntax the splitter can't follow gets an `exotic` reason: $'..' quoting, brace
// expansion, a function definition, a Windows path with single backslashes outside quotes (bash
// drops them), and in PowerShell or cmd text a .NET call, an alias, a call through a variable or a
// %variable%. The caller decides what to do with it.
//
// Each entry also has two more things. `expanded` (not enumerable) is an array parallel to `args`:
// true for an argument that holds an expansion (a variable, a command substitution, backticks), whose
// value nothing here can know; it goes by the word's text, so a plain word with the same text is
// marked too. `stdinShell` is true on a shell that reads its commands from stdin (no -c text and no
// script file, or -s, or "-"), including `sudo -s`; the commands it will run can't be checked.
//
// splitCommands(text, mode): mode is "sh" (default), "ps" (PowerShell text) or "cmd" (cmd.exe text).
// It reads the command text as data and never runs it. Every loop is linear in the text. It throws
// when the nesting is too deep (or a PowerShell block comment never ends).

const MAX_DEPTH = 10;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const REDIR = /^\d*(>>?|<|>&|&>>?|>\|)/;
const REDIR_ONLY = /^\d*(>>?|<|>&|&>>?|>\|)$/;
const CONTROL = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh", "rbash", "mksh", "posh", "yash"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const EVALS = new Set(["eval", "iex", "invoke-expression"]);
const STARTERS = new Set(["start-process", "saps", "start"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NPX_LIKE = new Set(["npx", "bunx", "pnpx"]);
// Git global options that take a separate value.
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
// Package managers' own options that take a separate value (so `pnpm -C dir exec x` is read right).
const PM_VALUED = ["-C", "--dir", "-F", "--filter", "--filter-prod", "--cwd", "--loglevel", "--reporter", "--prefix", "-w", "--workspace"];
// Package names whose command has another name.
const PKG_BIN = {
  "netlify-cli": "netlify", "firebase-tools": "firebase", "aws-cdk": "cdk", "@angular/cli": "ng", "@aws-amplify/cli": "amplify",
  "@railway/cli": "railway", "@vscode/vsce": "vsce", "@changesets/cli": "changeset", "@vercel/cli": "vercel", "vercel-cli": "vercel",
};
// Start-Process / start options (PowerShell names without the dash). `plain` ones take no value.
const START_PLAIN = ["filepath", "argumentlist", "loaduserprofile", "nonewwindow", "passthru", "wait", "usenewenvironment"];
const START_VALUED = ["workingdirectory", "verb", "windowstyle", "credential", "redirectstandarderror", "redirectstandardinput", "redirectstandardoutput"];
// powershell.exe options that take a separate value.
const PS_VALUED = new Set(["executionpolicy", "ep", "windowstyle", "w", "outputformat", "o", "of", "inputformat", "in", "if", "workingdirectory", "wd",
  "configurationname", "config", "psconsolefile", "custompipename", "settingsfile", "version", "v"]);
// Launchers that run another program after fixed words: `uv run twine upload`, `pipx run twine ...`.
const LAUNCHERS = { uvx: [[]], uv: [["run"], ["tool", "run"]], pipx: [["run"]], poetry: [["run"]], pdm: [["run"]], pipenv: [["run"]], hatch: [["run"]], rye: [["run"]] };

// Programs that run another program. `valued` options take a separate value, `positional` is the
// number of plain words to skip before the wrapped command, `assign` allows VAR=value before it.
const WRAPPERS = {
  env: { valued: ["-u", "--unset", "-C", "--chdir"], assign: true },
  command: {},
  builtin: {},
  sudo: { valued: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-r", "-t", "-U", "--user", "--group", "--host"], assign: true },
  doas: { valued: ["-u", "-C"] },
  nohup: {},
  time: { valued: ["-f", "--format", "-o", "--output"] },
  exec: { valued: ["-a"] },
  setsid: {},
  nice: { valued: ["-n", "--adjustment"] },
  ionice: { valued: ["-c", "-n", "-p", "-P", "-u"] },
  timeout: { valued: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  stdbuf: { valued: ["-i", "-o", "-e"] },
  watch: { valued: ["-n", "--interval", "-d"] },
  xargs: { valued: ["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-lines", "--delimiter", "--arg-file", "--replace"] },
  wsl: { valued: ["-d", "--distribution", "-u", "--user", "--cd"] },
  corepack: {},
  busybox: {},
  winpty: {},
  flock: { valued: ["-w", "--timeout", "-E", "--conflict-exit-code"], positional: 1 },
  strace: { valued: ["-o", "-e", "-p", "-s", "-u", "-E", "-P", "-a", "-I", "-O", "-S", "-b", "-X", "-U", "-C"] },
  ltrace: { valued: ["-o", "-e", "-p", "-s", "-u", "-n", "-a", "-A", "-F", "-l", "-L", "-x"] },
};
// Wrappers that also appear in the result, because a guard may refuse them outright.
const KEEP = new Set(["busybox", "winpty", "flock", "strace", "ltrace", "script", "su", "parallel", "xargs"]);

// "C:\Program Files\Git\bin\git.exe", "/usr/bin/git", "git.exe", "GIT" -> "git"
export function programName(word) {
  const base = String(word).replace(/\\/g, "/").split("/").pop().toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com)$/, "");
}

// "wrangler@latest" -> "wrangler", "netlify-cli@1.0" -> "netlify", "@cloudflare/wrangler@1" -> "wrangler".
export function pkgBin(spec) {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  return PKG_BIN[name] ?? name;
}

// Text between "(" and its matching ")". `start` is the index just after the "(".
function readParen(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { inner: src.slice(start, i), end: i + 1 };
    i++;
  }
  return { inner: src.slice(start), end: src.length };
}

// Text between two backticks. `start` is the index just after the first one.
function readBacktick(src, start) {
  let i = start;
  while (i < src.length && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
  return { inner: src.slice(start, i).replace(/\\`/g, "`"), end: i + 1 };
}

// Command substitutions inside text that a shell would expand (an unquoted heredoc body).
function substitutions(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === "$" && text[i + 1] === "(") {
      const r = readParen(text, i + 2);
      found.push(r.inner);
      i = r.end;
    } else if (text[i] === "`") {
      const r = readBacktick(text, i + 1);
      found.push(r.inner);
      i = r.end;
    } else i++;
  }
  return found;
}

// {a,b} or {1..3} in unquoted text ("${x,,}" is a parameter expansion, not this). One pass.
function hasBraceExpansion(s) {
  for (let i = s.indexOf("{"); i >= 0; i = s.indexOf("{", i + 1)) {
    if (i > 0 && s[i - 1] === "$") continue;
    let j = i + 1;
    let inner = false;
    while (j < s.length && s[j] !== "{" && s[j] !== "}") {
      if (s[j] === "," || (s[j] === "." && s[j + 1] === ".")) inner = true;
      j++;
    }
    if (inner && j < s.length && s[j] === "}") return true;
  }
  return false;
}

// PowerShell text as the shell would read it: no backtick escapes or continuations, straight quotes,
// plain spaces and line ends, no <# #> comments.
function normalizePowerShell(text) {
  let t = text.replace(/`(\r\n|\n|\r)/g, "").replace(/`/g, "");
  t = t.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E]/g, '"');
  t = t.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\v\f]/g, " ");
  // A bare CR and the Unicode line ends may or may not end a statement in PowerShell: treat them as line ends.
  t = t.replace(/\r(?!\n)|[\u0085\u2028\u2029]/g, "\n");
  let at = t.indexOf("<#");
  if (at < 0) return t;
  let out = "";
  let from = 0;
  while (at >= 0) {
    const end = t.indexOf("#>", at + 2);
    if (end < 0) throw new Error("a PowerShell block comment never ends");
    out += `${t.slice(from, at)} `;
    from = end + 2;
    at = t.indexOf("<#", from);
  }
  return out + t.slice(from);
}

// PowerShell features that build or hide what runs: the guard can't follow them.
const PS_RISK = /\]\s*::|\b(?:Add-Type|New-Object|Invoke-Item|Set-Alias|New-Alias|Invoke-WmiMethod|Invoke-CimMethod|Get-Command|Set-Variable)\b|(?:^|[\s;|&(])(?:sal|nal|gcm|sv|ii)\s|\[\s*scriptblock\s*\]|\.\s*Invoke\s*\(|\bfunction\s|\bfilter\s/i;
const CMD_RISK = /%[^%\s]*%|![^!\s]+!/;

// One pass over the text: simple commands as word lists, plus the command strings found inside
// substitutions. `mode` is "sh", "ps" or "cmd": it decides what quotes, escapes and comments mean.
function parse(src, mode, marks) {
  const sh = mode === "sh";
  const ps = mode === "ps";
  const cmdMode = mode === "cmd";
  const commands = [];
  const nested = [];
  let command = { words: [], heredocs: [], exotic: undefined };
  let cur = "";
  let unq = ""; // the unquoted characters of the current word, for brace expansion
  let inWord = false;
  let varBrace = false; // inside ${...} in PowerShell text
  let wordExp = false; // the current word holds an expansion ($VAR, ${..}, $(..), backticks)
  let hereString = false;
  let pending = []; // heredocs waiting for the end of the line: { delim, strip, quoted, owner }
  let i = 0;
  const n = src.length;

  const endWord = () => {
    if (inWord) {
      if (sh && unq.length > 2 && hasBraceExpansion(unq)) command.exotic = "brace expansion";
      if (hereString) { command.heredocs.push({ body: cur, quoted: true }); hereString = false; }
      else {
        command.words.push(cur);
        if (wordExp) marks.exp.add(cur);
      }
    }
    cur = "";
    unq = "";
    inWord = false;
    varBrace = false;
    wordExp = false;
  };
  const markExp = () => { wordExp = true; };
  const endCommand = () => {
    endWord();
    if (command.words.length || command.heredocs.length || command.exotic) commands.push(command);
    command = { words: [], heredocs: [], exotic: undefined };
  };
  const readDouble = (open) => {
    let j = open + 1;
    while (j < n && src[j] !== '"') {
      const ch = src[j];
      if (sh && ch === "\\" && j + 1 < n) {
        const nx = src[j + 1];
        if (nx === "\n") { j += 2; continue; }
        if ('"\\$`'.includes(nx)) { cur += nx; j += 2; continue; }
        cur += ch;
        j++;
        continue;
      }
      if (!cmdMode && ch === "$" && src[j + 1] === "(") {
        markExp();
        const r = readParen(src, j + 2);
        nested.push(r.inner);
        j = r.end;
        continue;
      }
      if (sh && ch === "`") {
        markExp();
        const r = readBacktick(src, j + 1);
        nested.push(r.inner);
        j = r.end;
        continue;
      }
      if (!cmdMode && ch === "$") markExp();
      cur += ch;
      j++;
    }
    // An unterminated quote would hide the rest of the text, so look at the rest as well.
    if (j >= n) nested.push(src.slice(open + 1));
    return j + 1;
  };

  while (i < n) {
    const c = src[i];
    if (c === "'" && !cmdMode) {
      inWord = true;
      const j = src.indexOf("'", i + 1);
      if (j < 0) { nested.push(src.slice(i + 1)); cur += src.slice(i + 1); i = n; }
      else { cur += src.slice(i + 1, j); i = j + 1; }
      continue;
    }
    if (c === '"') { inWord = true; i = readDouble(i); continue; }
    if (c === "\\" && sh) {
      const nx = src[i + 1];
      if (nx === undefined) { i++; continue; }
      if (nx === "\n") { i += 2; continue; }
      if (nx === "\r" && src[i + 2] === "\n") { i += 3; continue; }
      inWord = true;
      // A backslash escapes the next character, as in bash. A Windows path with single backslashes
      // outside quotes loses them there, and command() flags a program that comes out that way.
      cur += nx;
      i += 2;
      continue;
    }
    if (sh && c === "$" && (src[i + 1] === "'" || src[i + 1] === '"')) {
      // $'..' and $".." quoting: the guard doesn't decode it, so it only flags it.
      command.exotic = "$'...' or $\"...\" quoting";
      inWord = true;
      markExp();
      if (src[i + 1] === '"') { i++; continue; }
      let j = i + 2;
      while (j < n && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      cur += src.slice(i + 2, Math.min(j, n));
      i = j + 1;
      continue;
    }
    if (!cmdMode && c === "$" && src[i + 1] === "(") {
      inWord = true;
      markExp();
      const r = readParen(src, i + 2);
      nested.push(r.inner);
      i = r.end;
      continue;
    }
    if (sh && c === "`") {
      inWord = true;
      markExp();
      const r = readBacktick(src, i + 1);
      nested.push(r.inner);
      i = r.end;
      continue;
    }
    if (sh && (c === "<" || c === ">") && src[i + 1] === "(") {
      inWord = true;
      markExp();
      const r = readParen(src, i + 2);
      nested.push(r.inner);
      i = r.end;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") { endWord(); i++; continue; }
    if (c === "\n") {
      endCommand();
      i++;
      for (const h of pending) {
        const lines = [];
        while (i < n) {
          let j = src.indexOf("\n", i);
          if (j < 0) j = n;
          let line = src.slice(i, j).replace(/\r$/, "");
          i = Math.min(j + 1, n);
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
        }
        h.owner.heredocs.push({ body: lines.join("\n"), quoted: h.quoted });
      }
      pending = [];
      continue;
    }
    if (ps && c === "{" && cur.endsWith("$")) varBrace = true;
    else if (ps && c === "}" && varBrace) varBrace = false;
    else if (ps && (c === "{" || c === "}")) {
      // A script block: keep the braces as words of their own so the commands inside show up.
      endWord();
      command.words.push(c);
      i++;
      continue;
    }
    if (c === "(") {
      // name() { ...; } defines a function: a later call of it can't be followed.
      if (sh && command.words.length + (inWord ? 1 : 0) === 1) {
        let k = i + 1;
        while (k < n && (src[k] === " " || src[k] === "\t")) k++;
        if (src[k] === ")") command.exotic = "function definition";
      }
      endCommand();
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === ")") { endCommand(); i++; continue; }
    if (c === "&") {
      // 2>&1, >&2 and &> are redirections; && and a lone & separate commands.
      if (src[i + 1] !== "&" && (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">")) { cur += c; unq += c; inWord = true; i++; continue; }
      endCommand();
      if (ps && src[i + 1] !== "&") {
        // The call operator: `& "git" push` is fine, `& $x push` and `& (expr) push` hide the program.
        let k = i + 1;
        while (k < n && (src[k] === " " || src[k] === "\t")) k++;
        if (src[k] === "(" || src[k] === "$") command.exotic = "call operator on an expression";
      }
      i += src[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "#" && !cmdMode && !inWord) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (sh && c === "<" && src.startsWith("<<<", i)) {
      endWord();
      hereString = true;
      inWord = false;
      i += 3;
      // The next word becomes the here-string body: mark it by reading it as a normal word.
      while (i < n && (src[i] === " " || src[i] === "\t")) i++;
      if (i >= n || "\n;&|()".includes(src[i])) hereString = false;
      else inWord = true;
      continue;
    }
    if (sh && c === "<" && src.startsWith("<<", i)) {
      endWord();
      i += 2;
      const strip = src[i] === "-";
      if (strip) i++;
      while (i < n && (src[i] === " " || src[i] === "\t")) i++;
      let delim = "";
      let quoted = false;
      while (i < n && !" \t\r\n;&|()<>".includes(src[i])) {
        const ch = src[i];
        if (ch === "'" || ch === '"') {
          quoted = true;
          const j = src.indexOf(ch, i + 1);
          const end = j < 0 ? n : j;
          delim += src.slice(i + 1, end);
          i = end + 1;
        } else if (ch === "\\") { quoted = true; delim += src[i + 1] ?? ""; i += 2; }
        else { delim += ch; i++; }
      }
      pending.push({ delim, strip, quoted, owner: command });
      continue;
    }
    inWord = true;
    if (c === "$" && !cmdMode) markExp();
    cur += c;
    unq += c;
    i++;
  }
  endCommand();
  return { commands, nested };
}

const isOption = (a) => a.startsWith("-") && a.length > 1;

// Drops a wrapper's own options and returns the command it runs. Assignments it allows go to envOut.
function stripWrapper(spec, args, envOut) {
  let i = 0;
  let skip = spec.positional ?? 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (spec.assign && ASSIGN.test(a)) { envOut?.push(a); i++; continue; }
    if (isOption(a)) { i += spec.valued?.includes(a) ? 2 : 1; continue; }
    if (skip > 0) { skip--; i++; continue; }
    break;
  }
  return args.slice(i);
}

function gitEntry(args, env, exotic) {
  const globals = [];
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    globals.push(args[i]);
    if (GIT_VALUED.has(args[i]) && i + 1 < args.length) { globals.push(args[i + 1]); i += 2; }
    else i++;
  }
  return entry("git", args.slice(i), globals, env, exotic);
}

function entry(program, args, globals, env, exotic) {
  const e = { program, args, globals, env };
  if (exotic) e.exotic = exotic;
  return e;
}

// Leading assignments, control words and redirections, walked with an index (never a copy per word).
function dropLeading(words, mode) {
  const env = [];
  let i = 0;
  const n = words.length;
  while (i < n) {
    const a = words[i];
    if (ASSIGN.test(a)) { env.push(a); i++; continue; }
    // cmd words are not case sensitive, and cmd's `if` is read by command(), not dropped.
    if (mode === "cmd" ? a.toLowerCase() !== "if" && CONTROL.has(a.toLowerCase()) : CONTROL.has(a)) { i++; continue; }
    if (REDIR.test(a)) { i += REDIR_ONLY.test(a) ? 2 : 1; continue; }
    break;
  }
  return { i, env };
}

// The text after `-c` (or --command) in `su -c 'cmd' user`, `script -qc 'cmd' file`, `flock f -c 'cmd'`.
function dashC(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--command") return args[k + 1];
    if (a.startsWith("--command=")) return a.slice(10);
    if (/^-[A-Za-z]*c$/.test(a)) return args[k + 1];
    if (/^-c./.test(a)) return a.slice(2);
  }
  return undefined;
}

// npx -c 'cmd', npm exec --call 'cmd'
function callPayload(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") break;
    if (a === "-c" || a === "--call") return args[k + 1];
    if (a.startsWith("--call=")) return a.slice(7);
    if (a.startsWith("-c=")) return a.slice(3);
  }
  return undefined;
}

// `env -S 'git push'`, `env --split-string=...`: the value is a command line.
function envSplit(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") break;
    if (a === "--split-string") return { value: args[k + 1] ?? "", rest: args.slice(k + 2) };
    if (a.startsWith("--split-string=")) return { value: a.slice(15), rest: args.slice(k + 1) };
    if (/^-[A-Za-z]*S$/.test(a)) return { value: args[k + 1] ?? "", rest: args.slice(k + 2) };
    if (/^-[A-Za-z]*S./.test(a)) return { value: a.slice(a.indexOf("S") + 1), rest: args.slice(k + 1) };
    if (a === "-u" || a === "-C" || a === "--unset" || a === "--chdir") { k++; continue; }
    if (!a.startsWith("-") && !ASSIGN.test(a)) break;
  }
  return undefined;
}

// What a shell will run: { text } for `bash -c ...` (the first plain word once -c is seen, "--" ends
// the options), { stdin: true } when it reads its commands from stdin (no -c text and no script file,
// or -s, or "-"), {} for a script file (not followed) and for --version / --help.
function shellKind(args) {
  let hasC = false;
  let hasS = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") {
      if (hasC) return args[k + 1] === undefined ? {} : { text: args[k + 1] };
      return args[k + 1] === undefined || hasS ? { stdin: true } : {};
    }
    if (a === "-" && !hasC) return { stdin: true };
    if (a === "--version" || a === "--help") return {};
    if (a.startsWith("-") || a.startsWith("+")) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) hasC = true;
      if (/^-[A-Za-z]*s[A-Za-z]*$/.test(a)) hasS = true;
      if (["-o", "-O", "+o", "+O", "--rcfile", "--init-file"].includes(a)) k++;
      continue;
    }
    if (hasC) return { text: a };
    return hasS ? { stdin: true } : {};
  }
  return hasC ? {} : { stdin: true };
}

// `node node_modules/.bin/wrangler deploy`, `node ./node_modules/wrangler/bin/wrangler.js deploy`: the
// names the tool could go by, and its arguments. Only paths through node_modules or .bin are followed.
const NODE_VALUED = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--input-type", "-C", "--conditions", "--env-file", "--title", "--stack-trace-limit"]);
function nodeTool(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "-e" || a === "-p" || a === "--eval" || a === "--print" || /^-[a-z]*[ep]$/.test(a)) return undefined;
    if (a.startsWith("-")) { if (NODE_VALUED.has(a)) k++; continue; }
    const path = a.replace(/\\/g, "/");
    if (!/(^|\/)(node_modules|\.bin)\//.test(path)) return undefined;
    const names = [path.split("/").pop().replace(/\.(c|m)?js$/, "")];
    const pkg = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);
    if (pkg) names.push(pkgBin(pkg[1]));
    return { names: [...new Set(names)], rest: args.slice(k + 1) };
  }
  return undefined;
}

// PowerShell assignment in front of a command: `$x = git push`, `[string]$x = ...`, `$a,$b = ...`,
// `$x += ...`, `${x} = ...`, `$env:NAME = ...`. Returns the words after it and the environment names it
// sets (`NAME=`), or undefined when the words don't start with an assignment.
const PS_PIECE = /^(?:\[[^\]\s]*\]|\$\{[^}]*\}|\$[\w:?^]+|,)+$/;
function psAssignment(words, from) {
  const stop = Math.min(words.length, from + 6);
  for (let k = from; k < stop; k++) {
    const w = words[k];
    const eq = w.indexOf("=");
    if (eq < 0) {
      if (!PS_PIECE.test(w)) return undefined;
      continue;
    }
    const pre = w.slice(0, eq).replace(/(?:[-+*/%]|\?\?)$/, "");
    if (pre === "" ? k === from : !PS_PIECE.test(pre)) return undefined;
    const target = [...words.slice(from, k), pre].join("");
    const env = [];
    for (const m of target.matchAll(/\$\{?env:([A-Za-z_][\w]*)/gi)) env.push(`${m[1]}=`);
    const rest = w.slice(eq + 1);
    return { rest: rest === "" ? words.slice(k + 1) : [rest, ...words.slice(k + 1)], env };
  }
  return undefined;
}

// The words after cmd's `if [/i] [not] <condition>`, or undefined when the condition isn't one it knows.
const CMD_COMPARE = new Set(["equ", "neq", "lss", "leq", "gtr", "geq"]);
function cmdIf(w) {
  let i = 0;
  if (w[i]?.toLowerCase() === "/i") i++;
  if (w[i]?.toLowerCase() === "not") i++;
  const k = w[i]?.toLowerCase();
  if (k === undefined) return undefined;
  if (["exist", "defined", "errorlevel", "cmdextversion"].includes(k)) return w.slice(i + 2);
  if (k.includes("==")) return w.slice(i + (k.endsWith("==") ? 2 : 1));
  const op = w[i + 1]?.toLowerCase();
  if (op === undefined) return undefined;
  if (op.startsWith("==")) return w.slice(i + (op === "==" ? 3 : 2));
  if (CMD_COMPARE.has(op)) return w.slice(i + 3);
  return undefined;
}

// The program and arguments of powershell.exe: the text of -Command (or the first plain word), or
// the decoded -EncodedCommand. Undefined for -File and when there is no command.
function powershellText(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.length > 1 && (a[0] === "-" || a[0] === "/")) {
      const name = a.slice(1).split(/[:=]/, 1)[0].toLowerCase();
      if (name && "command".startsWith(name)) return args.slice(k + 1).join(" ");
      if (name && ("encodedcommand".startsWith(name) || name === "ec")) {
        return args[k + 1] === undefined ? undefined : Buffer.from(args[k + 1], "base64").toString("utf16le");
      }
      if (name && "file".startsWith(name)) return undefined;
      if (PS_VALUED.has(name)) k++;
      continue;
    }
    return args.slice(k).join(" ");
  }
  return undefined;
}

// The program and arguments that Start-Process / start would launch, as a word list.
function starterWords(prog, args) {
  const out = [];
  const prefixOf = (name, list) => name.length >= 2 && list.some((o) => o.startsWith(name));
  let k = 0;
  if (prog === "start") while (k < args.length && /^\/[A-Za-z]+$/.test(args[k])) k++;
  for (; k < args.length; k++) {
    const a = args[k];
    const name = /^-[A-Za-z]+$/.test(a) ? a.slice(1).toLowerCase() : "";
    if (name && prefixOf(name, START_VALUED)) { k++; continue; }
    if (name && prefixOf(name, START_PLAIN)) continue;
    out.push(a);
  }
  if (!out.length) return out;
  return [out[0], ...out.slice(1).flatMap((a) => a.split(/[\s,]+/).filter(Boolean))];
}

function runMode(src, depth, out, mode) {
  const text = mode === "ps" ? normalizePowerShell(src) : mode === "cmd" ? src.replace(/\^/g, "") : src;
  run(text, depth, out, mode);
}

function run(src, depth, out, mode) {
  if (depth > MAX_DEPTH) throw new Error("command nesting is too deep to check");
  if (mode === "ps" && PS_RISK.test(src)) out.push(entry("", [], [], [], "PowerShell text with a .NET call, an alias, a function or a script block the guard can't follow"));
  if (mode === "cmd" && CMD_RISK.test(src)) out.push(entry("", [], [], [], "cmd text with a %variable% the guard can't read"));
  const { commands, nested } = parse(src, mode, out.marks);
  for (const c of commands) command(c.words, c.heredocs, depth, out, mode, c.exotic, undefined);
  for (const s of nested) run(s, depth + 1, out, mode);
}

function command(words, heredocs, depth, out, mode, exotic0, envIn) {
  if (depth > MAX_DEPTH) throw new Error("command nesting is too deep to check");
  const lead = dropLeading(words, mode);
  const env = envIn && envIn.length ? envIn.concat(lead.env) : lead.env;
  let exotic = exotic0;
  if (lead.i >= words.length) {
    if (exotic || env.length) out.push(entry("", [], [], env, exotic)); // a bare assignment: a rule may still care about it
    return;
  }
  if (mode === "ps") {
    // $x = git push, [string]$x = ..., $a,$b = ..., $x += ..., an env: target: the command follows the target.
    const a = psAssignment(words, lead.i);
    if (a) return command(a.rest, heredocs, depth, out, mode, exotic, env.concat(a.env));
  }
  if (mode === "cmd") {
    // cmd keywords that come before the program: @git, call git, if exist x git, if a==b git.
    const w0 = words[lead.i];
    const low = w0.toLowerCase();
    const after = words.slice(lead.i + 1);
    if (w0.startsWith("@")) return command(w0.length > 1 ? [w0.slice(1), ...after] : after, heredocs, depth, out, mode, exotic, env);
    if (low === "call") return command(after, heredocs, depth, out, mode, exotic, env);
    if (low === "if") {
      const rest = cmdIf(after);
      if (rest === undefined) out.push(entry("", [], [], env, "a cmd if condition the guard can't read"));
      else command(rest, heredocs, depth, out, mode, exotic, env);
      return;
    }
    if (low === "for" && after.some((a) => /^\/f$/i.test(a))) exotic = exotic || "a cmd for /f loop runs a command string the guard can't read";
  }
  if (mode === "sh" && /^[A-Za-z]:(?![\\/])/.test(words[lead.i])) exotic = exotic || "a Windows path with single backslashes outside quotes (bash drops the backslashes)";
  const prog = programName(words[lead.i]);
  const args = words.slice(lead.i + 1);
  // The closing brace of a PowerShell script block belongs to the block, not to the command before it.
  if (mode === "ps") while (args.length && args[args.length - 1] === "}") args.pop();
  const next = (rest, m = mode, ex = exotic, e = env, h = []) => command(rest, h, depth + 1, out, m, ex, e);

  if (prog === "function") exotic = exotic || "function definition";
  // In PowerShell a program is called through a variable only with & or . (the & case is flagged by the
  // parser); a $variable alone, with an operator or being assigned is not a call, but $x.Method() is.
  if (mode === "ps" && (prog === "." || prog.startsWith(".$") || (prog.startsWith("$") && /\.[A-Za-z]/.test(prog)))) exotic = exotic || "PowerShell call through a variable";

  if (prog === "env") {
    const s = envSplit(args);
    if (s) {
      out.push(entry("env", args, [], env, exotic));
      runMode([s.value, ...s.rest].join(" "), depth + 1, out, "sh");
      return;
    }
  }
  if (prog === "script" || prog === "su") {
    out.push(entry(prog, args, [], env, exotic));
    const payload = dashC(args);
    if (payload !== undefined) runMode(payload, depth + 1, out, "sh");
    return;
  }
  if (WRAPPERS[prog]) {
    if (KEEP.has(prog)) out.push(entry(prog, args, [], env, exotic));
    if (prog === "flock") {
      const payload = dashC(args);
      if (payload !== undefined) runMode(payload, depth + 1, out, "sh");
    }
    const wenv = env.slice();
    const inner = stripWrapper(WRAPPERS[prog], args, wenv);
    // sudo -s / sudo -i with no command start a shell that reads stdin.
    if (prog === "sudo" && inner.length === 0 && args.some((a) => /^-[A-Za-z]*[si][A-Za-z]*$/.test(a))) {
      const sh = entry("sudo", args, [], env, exotic);
      sh.stdinShell = true;
      out.push(sh);
    }
    // A heredoc or here-string belongs to the program the wrapper runs.
    return next(inner, mode, exotic, wenv, heredocs);
  }
  if (prog === "parallel") {
    out.push(entry(prog, args, [], env, exotic));
    let end = args.findIndex((a) => a === ":::" || a === "::::");
    if (end < 0) end = args.length;
    const rest = stripWrapper({ valued: ["-j", "--jobs", "-n", "-N", "-a", "--arg-file", "-S", "--sshlogin", "--colsep", "-d", "--delimiter", "-L", "-I", "-X"] }, args.slice(0, end), null);
    if (rest.length) {
      next(rest);
      if (rest.length === 1) runMode(rest[0], depth + 1, out, "sh");
    }
    return;
  }
  if (NPX_LIKE.has(prog)) {
    const call = callPayload(args);
    if (call !== undefined) runMode(call, depth + 1, out, "sh");
    const rest = stripWrapper({ valued: ["-p", "--package", "-w", "--workspace", "--node-options"] }, args, null);
    if (rest.length) next([pkgBin(rest[0]), ...rest.slice(1)]);
    return;
  }

  const self = prog === "git" ? gitEntry(args, env, exotic) : entry(prog, args, [], env, exotic);
  out.push(self);

  // PowerShell script blocks: `Start-Job { git push }`, `% { git push }`, `try { a } finally { git push }`. Every
  // top-level group is followed.
  if (mode === "ps") {
    for (let b = args.indexOf("{"); b >= 0; b = args.indexOf("{", b + 1)) {
      let level = 1;
      let end = b + 1;
      while (end < args.length && level > 0) {
        if (args[end] === "{") level++;
        else if (args[end] === "}") level--;
        end++;
      }
      next(args.slice(b + 1, level === 0 ? end - 1 : end));
      b = end - 1;
    }
  }

  if (SHELLS.has(prog)) {
    const k = shellKind(args);
    if (k.text !== undefined) runMode(k.text, depth + 1, out, "sh");
    for (const h of heredocs) runMode(h.body, depth + 1, out, "sh");
    if (k.stdin) self.stdinShell = true; // it reads its commands from stdin: nothing here can say what they are
    return;
  }
  if (prog === "node" || prog === "nodejs") {
    const t = nodeTool(args);
    if (t) for (const name of t.names) next([name, ...t.rest]);
    return;
  }
  if (POWERSHELLS.has(prog)) {
    const text = powershellText(args);
    if (text !== undefined) runMode(text, depth + 1, out, "ps");
    return;
  }
  if (prog === "cmd") {
    const k = args.findIndex((a) => /^\/+[ckr]/i.test(a));
    if (k >= 0) runMode([args[k].replace(/^\/+[ckr]/i, ""), ...args.slice(k + 1)].join(" "), depth + 1, out, "cmd");
    return;
  }
  if (EVALS.has(prog)) {
    runMode(args.join(" "), depth + 1, out, prog === "eval" ? "sh" : "ps");
    return;
  }
  if (prog === "find") {
    for (let i = 0; i < args.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(args[i])) continue;
      const run1 = [];
      for (i++; i < args.length && args[i] !== ";" && args[i] !== "+"; i++) run1.push(args[i]);
      next(run1);
    }
    return;
  }
  if (STARTERS.has(prog)) {
    const w = starterWords(prog, args);
    if (w.length) next(w);
    return;
  }
  if (/^(python|pythonw|py)(\d+(\.\d+)?)?$/.test(prog)) {
    // python -m twine upload: the module is the program.
    const k = args.indexOf("-m");
    if (k >= 0 && args[k + 1] !== undefined) next(args.slice(k + 1));
    return;
  }
  if (LAUNCHERS[prog]) {
    const plain = args.filter((a) => !isOption(a));
    for (const verbs of LAUNCHERS[prog]) {
      if (verbs.every((v, j) => plain[j] === v)) {
        const at = verbs.length === 0 ? 0 : args.indexOf(verbs[verbs.length - 1]) + 1;
        const rest = stripWrapper({ valued: ["--with", "-p", "--python", "--from", "--spec", "--with-requirements"] }, args.slice(at), null);
        if (rest.length) next(rest);
        break;
      }
    }
    return;
  }
  if (PACKAGE_MANAGERS.has(prog)) {
    const plain = [];
    for (let i = 0; i < args.length && plain.length < 8; i++) {
      if (args[i] === "--") break;
      if (!isOption(args[i])) plain.push(i);
    }
    if (prog === "yarn") {
      const w = plain.findIndex((ix) => args[ix] === "workspace");
      if (w >= 0 && plain[w + 1] !== undefined) return next(args.slice(plain[w + 1] + 1));
    }
    const at = plain.find((ix) => ["exec", "dlx", "x"].includes(args[ix]) || (prog === "npm" && args[ix].length >= 3 && "exec".startsWith(args[ix])));
    if (at !== undefined) {
      const rest = args.slice(at + 1);
      const call = callPayload(rest);
      if (call !== undefined) runMode(call, depth + 1, out, "sh");
      const cmd = stripWrapper({ valued: ["-p", "--package", "-w", "--workspace", "--node-options"] }, rest, null);
      if (cmd.length) next([pkgBin(cmd[0]), ...cmd.slice(1)]);
      return;
    }
    // pnpm, yarn and bun run a bin or a script by name: `pnpm wrangler deploy`, `pnpm -C app wrangler deploy`.
    if (prog !== "npm") {
      const rest = stripWrapper({ valued: PM_VALUED }, args, null);
      const r = rest[0] === "run" || rest[0] === "run-script" ? rest.slice(1) : rest;
      if (r.length) next(r);
    }
    return;
  }
  // Unquoted heredoc bodies are expanded by the shell, so their substitutions run.
  for (const h of heredocs) if (!h.quoted) for (const s of substitutions(h.body)) run(s, depth + 1, out, mode);
}

export function splitCommands(input, mode = "sh") {
  if (typeof input !== "string") throw new TypeError("command must be a string");
  const out = [];
  out.marks = { exp: new Set() };
  runMode(input, 0, out, mode);
  // For each argument: does it hold an expansion (a variable, a command substitution, backticks)? A
  // guard can't know what such a word turns into. The marks go by the word's text, so a plain word with
  // the same text is marked too (more denials, never fewer). Not enumerable, so the entries compare equal.
  for (const e of out) Object.defineProperty(e, "expanded", { value: e.args.map((a) => out.marks.exp.has(a)) });
  delete out.marks;
  return out;
}
