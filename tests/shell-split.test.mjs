// Run with: node --test tests/shell-split.test.mjs
// Covers plugins/phased-shipping/hooks/lib/shell.mjs: splitting a command line into simple commands,
// including every evasion form the guard has to see through. Commands are only parsed, never run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitCommands, programName, pkgBin } from "../plugins/phased-shipping/hooks/lib/shell.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = join(HERE, "..", "plugins", "phased-shipping", "hooks", "lib", "shell.mjs");

// "program arg arg" for each command, globals first, so a whole result reads as one list of strings.
const flat = (cmd) => splitCommands(cmd).map((c) => [c.program, ...c.globals, ...c.args].join(" "));
const has = (cmd, line) => assert.ok(flat(cmd).includes(line), `${JSON.stringify(cmd)} -> ${JSON.stringify(flat(cmd))} lacks "${line}"`);

test("programName reduces paths, extensions and case", () => {
  assert.equal(programName("/usr/bin/git"), "git");
  assert.equal(programName("git.exe"), "git");
  assert.equal(programName(String.raw`C:\Program Files\Git\bin\GIT.EXE`), "git");
  assert.equal(programName("./node_modules/.bin/vitest"), "vitest");
  assert.equal(programName("tool.cmd"), "tool");
});

test("it splits on && || ; | & and newlines", () => {
  assert.deepEqual(flat("a && b || c; d | e & f\ng"), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.deepEqual(flat(""), []);
  assert.deepEqual(flat("   "), []);
});

test("separators inside quotes do not split", () => {
  assert.deepEqual(flat('echo "a && git push; b | c"'), ["echo a && git push; b | c"]);
  assert.deepEqual(flat("echo 'x; git push'"), ["echo x; git push"]);
  assert.deepEqual(flat(String.raw`echo a\;b`), ["echo a;b"]);
});

test("redirections are not separators", () => {
  assert.deepEqual(flat("git status 2>&1"), ["git status 2>&1"]);
  assert.deepEqual(flat("git status &> out.txt"), ["git status &> out.txt"]);
  assert.deepEqual(flat("git status >&2"), ["git status >&2"]);
  assert.deepEqual(flat("git status > out.txt"), ["git status > out.txt"]);
  // A redirection in front of the program does not hide it.
  has(">out.txt git push", "git push");
  has("> out.txt git push", "git push");
  has("2>&1 git push", "git push");
});

test("git global options move to globals and leave the subcommand first", () => {
  const [c] = splitCommands("git -C ../repo -c core.x=y --no-pager push --force");
  assert.equal(c.program, "git");
  assert.deepEqual(c.globals, ["-C", "../repo", "-c", "core.x=y", "--no-pager"]);
  assert.deepEqual(c.args, ["push", "--force"]);
  const [d] = splitCommands("git --git-dir=x/.git --work-tree=x status");
  assert.deepEqual(d.globals, ["--git-dir=x/.git", "--work-tree=x"]);
  assert.deepEqual(d.args, ["status"]);
  assert.deepEqual(splitCommands("git")[0].args, []);
});

test("evasion: separators, global options, assignments, paths", () => {
  has("cd x && git push", "git push");
  has("git -C ../repo push", "git -C ../repo push");
  has("git -c core.x=y commit -m m", "git -c core.x=y commit -m m");
  has("FOO=1 git push", "git push");
  has("A=1 B=2 git push", "git push");
  has("/usr/bin/git push", "git push");
  has("git.exe push", "git push");
  has(String.raw`"C:\Program Files\Git\bin\git.exe" push`, "git push");
  // bash drops single backslashes outside quotes, so an unquoted C:\Git\bin\git.exe is not a path that runs:
  // it comes out as "C:Gitbingit.exe", and the splitter flags it instead of reading it as some other program.
  assert.ok(splitCommands(String.raw`C:\Git\bin\git.exe push`).some((c) => c.exotic), "single backslashes");
  assert.ok(splitCommands(String.raw`C:\Program Files\Git\cmd\git.exe push`).some((c) => c.exotic), "unquoted with a space: two words, flagged");
  assert.ok(splitCommands(String.raw`.\git.exe push`).every((c) => c.program !== "git"), ".\\git.exe is .git.exe in bash: not git, and not run either");
  // Escaped backslashes and an escaped space give the real path (what bash runs).
  has(String.raw`C:\\Program\ Files\\Git\\cmd\\git.exe push -f`, "git push -f");
  has(String.raw`"C:\Program Files\Git\cmd\git.exe" push -f`, "git push -f");
  has(String.raw`'C:\Program Files\Git\cmd\git.exe' push -f`, "git push -f");
  has(String.raw`C:/Program\ Files/Git/cmd/git.exe push -f`, "git push -f");
  assert.equal(splitCommands(String.raw`C:\\Program\ Files\\Git\\cmd\\git.exe push`).some((c) => c.exotic), false);
  has("true; git commit -m x", "git commit -m x");
  has("true\ngit push", "git push");
  has("\\git push", "git push");
  has("g\\it push", "git push");
  has("'git' push", "git push");
  has('"git" push', "git push");
});

test("evasion: shells, PowerShell, cmd, eval", () => {
  has('bash -c "git push"', "git push");
  has("sh -c 'npm publish'", "npm publish");
  has('bash -lc "git push"', "git push");
  has('zsh -c "cd x && git push"', "git push");
  has('powershell -Command "git push"', "git push");
  has("powershell -NoProfile -c git push", "git push");
  has('pwsh -Command "git push"', "git push");
  has('cmd /c "git push"', "git push");
  has("cmd /c git push", "git push");
  has('CMD.EXE /C "g^it push"', "git push");
  has('eval "git push"', "git push");
  has('iex "git push"', "git push");
  has('Invoke-Expression "git push"', "git push");
  has("& git push", "git push");
  has('& "git" push', "git push");
  const encoded = Buffer.from("git push", "utf16le").toString("base64");
  has(`powershell -EncodedCommand ${encoded}`, "git push");
  has(`pwsh -enc ${encoded}`, "git push");
  has('Start-Process git -ArgumentList "push origin main"', "git push origin main");
});

test("evasion: command substitution, backticks, process substitution", () => {
  has("echo $(git push)", "git push");
  has("echo `git push`", "git push");
  has("`git push`", "git push");
  has('echo "result: $(git push)"', "git push");
  has('echo "result: `git push`"', "git push");
  has("diff <(git push) x", "git push");
  has("echo $(echo $(git push))", "git push");
  has("echo $(echo ')' ; git push)", "git push");
});

test("evasion: wrappers", () => {
  has("sudo git push", "git push");
  has("sudo -u deploy git push", "git push");
  has("env FOO=1 git push", "git push");
  has("env -i git push", "git push");
  has("command git push", "git push");
  has("nohup git push", "git push");
  has("time git push", "git push");
  has("exec git push", "git push");
  has("sudo env FOO=1 nohup git push", "git push");
  has("timeout 30 git push", "git push");
  has("nice -n 5 git push", "git push");
  has("echo x | xargs git push", "git push");
  has("echo x | xargs -I{} git push {}", "git push {}");
  has("find . -exec git push {} \\;", "git push {}");
  has("find . -name x -execdir git commit -m x {} +", "git commit -m x {}");
  has("wsl git push", "git push");
  has("npx -y wrangler deploy", "wrangler deploy");
  has("npx wrangler deploy", "wrangler deploy");
  has("pnpm exec wrangler deploy", "wrangler deploy");
  has("pnpm --filter app exec wrangler deploy", "wrangler deploy");
  has("pnpm dlx wrangler deploy", "wrangler deploy");
  has("npm exec -- wrangler deploy", "wrangler deploy");
  has("bunx wrangler deploy", "wrangler deploy");
  has("bun x wrangler deploy", "wrangler deploy");
  has("pnpm wrangler deploy", "wrangler deploy");
  has("yarn vercel --prod", "vercel --prod");
});

test("control words and groups do not hide a command", () => {
  has("if true; then git push; fi", "git push");
  has("for f in a b; do git push; done", "git push");
  has("(git push)", "git push");
  has("{ git push; }", "git push");
  has("! git push", "git push");
  has("foo() { git push; }", "git push");
});

test("heredocs: a quoted body is text, an unquoted body runs its substitutions, a shell runs the body", () => {
  assert.deepEqual(flat("cat > f.sh <<'EOF'\ngit push\nnpm publish\nEOF"), ["cat > f.sh"]);
  assert.deepEqual(flat('cat > f.sh <<"EOF"\ngit push\nEOF'), ["cat > f.sh"]);
  assert.deepEqual(flat("cat > f.txt <<EOF\ngit push\nEOF"), ["cat > f.txt"]);
  has("cat <<EOF\nbuild $(git push)\nEOF", "git push");
  has("cat <<EOF\nbuild `git push`\nEOF", "git push");
  has("bash <<EOF\ngit push\nEOF", "git push");
  has("bash <<'EOF'\ngit push\nEOF", "git push");
  has("sh <<-EOF\n\tgit push\n\tEOF", "git push");
  has('bash <<< "git push"', "git push");
  // Commands after the heredoc are still seen.
  has("cat <<'EOF'\nhello\nEOF\ngit push", "git push");
  has("cat <<'EOF' && git push\nhello\nEOF", "git push");
});

test("comments are skipped, and an apostrophe in one does not hide the next line", () => {
  assert.deepEqual(flat("echo hi # git push"), ["echo hi"]);
  assert.deepEqual(flat("# git push\nls"), ["ls"]);
  has("echo a # don't\ngit push", "git push");
  assert.deepEqual(flat("echo a#b"), ["echo a#b"]);
});

test("an unterminated quote does not hide the rest of the text", () => {
  has('echo "oops; git push', "git push");
  has("echo 'oops; git push", "git push");
  has("echo $(git push", "git push");
  has("echo `git push", "git push");
});

test("an unquoted lookalike is not a command: arguments stay arguments", () => {
  assert.deepEqual(flat("echo git push"), ["echo git push"]);
  assert.deepEqual(flat('git commit -m "git push"'), ['git commit -m git push']);
  assert.deepEqual(flat("grep -r 'git push' ."), ["grep -r git push ."]);
});

test("nesting that is too deep throws, and so does a non-string", () => {
  const deep = "$(".repeat(30) + "ls" + ")".repeat(30);
  assert.throws(() => splitCommands(deep), /too deep/);
  assert.throws(() => splitCommands(5), TypeError);
  assert.throws(() => splitCommands(undefined), TypeError);
});

test("shell.mjs has no imports beyond node: built-ins", () => {
  const text = readFileSync(SHELL, "utf8");
  const specifiers = [...text.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)].map((m) => m[1] ?? m[2]);
  for (const s of specifiers) assert.ok(s.startsWith("node:"), `import of ${s}`);
  assert.ok(!/\brequire\s*\(|\bimport\s*\(/.test(text), "no require or dynamic import");
});

// ---------- fix round 1: env, exotic syntax, modes, wrappers, linear time ----------

test("leading assignments come back in env, including those given through env and sudo", () => {
  assert.deepEqual(splitCommands("FOO=1 git push")[0].env, ["FOO=1"]);
  assert.deepEqual(splitCommands("A=1 B+=2 git push")[0].env, ["A=1", "B+=2"]);
  assert.deepEqual(splitCommands("A=1 env B=2 sudo -u zork C=3 git push")[0].env, ["A=1", "B=2", "C=3"]);
  assert.deepEqual(splitCommands("git push")[0].env, []);
  assert.deepEqual(splitCommands("echo hi A=1")[0].env, [], "an assignment after the program is an argument");
  // A bare assignment is still reported, so a rule can look at it.
  assert.deepEqual(splitCommands("GIT_DIR=x")[0], { program: "", args: [], globals: [], env: ["GIT_DIR=x"] });
});

test("exotic syntax is flagged on the command that uses it", () => {
  const flagged = (cmd) => splitCommands(cmd).filter((c) => c.exotic).map((c) => c.exotic);
  assert.deepEqual(flagged("$'git' push"), ["$'...' or $\"...\" quoting"]);
  assert.deepEqual(flagged("git $\"push\""), ["$'...' or $\"...\" quoting"]);
  assert.deepEqual(flagged("{git,push}"), ["brace expansion"]);
  assert.deepEqual(flagged("echo a{b,c}d"), ["brace expansion"]);
  assert.deepEqual(flagged("echo {1..3}"), ["brace expansion"]);
  assert.deepEqual(flagged("foo() { :; }"), ["function definition"]);
  assert.deepEqual(flagged("foo ( ) { :; }"), ["function definition"]);
  assert.deepEqual(flagged("function foo { :; }"), ["function definition"]);
  // Not exotic: quoted braces, parameter expansion, plain groups and subshells, find's {}.
  for (const cmd of ["echo '{a,b}'", 'echo "{a,b}"', "echo ${x,,}", "echo ${x:-a,b}", "{ ls; }", "(ls)", "echo {}", "echo \\{a,b\\}", "echo $(ls)", "echo \"$'x'\""]) assert.deepEqual(flagged(cmd), [], cmd);
});

test("bash -c skips its options and --, and env -S parses its value", () => {
  has("bash -c -- 'git push'", "git push");
  has("bash -x -c 'git push'", "git push");
  has("bash --norc -c 'git push'", "git push");
  has("bash -o pipefail -c 'git push'", "git push");
  has("env -S 'git push -f'", "git push -f");
  has("env --split-string='git push -f'", "git push -f");
  has("env -iS'git push -f'", "git push -f");
  has("env A=1 B=2 git push", "git push");
});

test("more wrappers: busybox, script, su, winpty, flock, strace, ltrace, parallel, start", () => {
  has("busybox git push", "git push");
  has("winpty git push", "git push");
  has("strace -o out -f git push", "git push");
  has("ltrace git push", "git push");
  has("flock lockfile git push", "git push");
  has("flock -c 'git push' lockfile", "git push");
  has("su -c 'git push' zork", "git push");
  has("script -qc 'git push' /dev/null", "git push");
  has("parallel git push ::: a b", "git push");
  has("start git push -f", "git push -f"); // start keeps the flags
  has("start /b git push -f", "git push -f");
  has("Start-Process git -ArgumentList push,-f", "git push -f");
  has("Start-Process -FilePath git -ArgumentList 'push -f' -NoNewWindow -Wait", "git push -f");
  // The launcher itself is reported for the ones a guard may refuse outright.
  for (const p of ["busybox", "winpty", "strace", "flock", "su", "script", "parallel"]) assert.ok(splitCommands(`${p} ls`).some((c) => c.program === p), p);
});

test("launchers: versions, package names, -c, --call, exec, x, pnpm options, yarn workspace, uv and pipx", () => {
  has("npx wrangler@latest deploy", "wrangler deploy");
  has("npx -y wrangler@4.1.0 deploy", "wrangler deploy");
  has("npx @cloudflare/wrangler@1 deploy", "wrangler deploy");
  has("npx netlify-cli deploy", "netlify deploy");
  has("npx firebase-tools@13 deploy", "firebase deploy");
  has("npx -p wrangler wrangler deploy", "wrangler deploy");
  has("npx -c 'wrangler deploy'", "wrangler deploy");
  has("npx --call='wrangler deploy'", "wrangler deploy");
  has("npm x -- wrangler deploy", "wrangler deploy");
  has("npm exec wrangler@latest deploy", "wrangler deploy");
  has("npm exec --call 'wrangler deploy'", "wrangler deploy");
  has("npm exec -c \"wrangler deploy\"", "wrangler deploy");
  has("pnpm -C app exec wrangler deploy", "wrangler deploy");
  has("pnpm --filter app -s -r exec wrangler deploy", "wrangler deploy");
  has("pnpm --dir app dlx wrangler deploy", "wrangler deploy");
  has("pnpm -C app wrangler deploy", "wrangler deploy");
  has("yarn workspace web wrangler deploy", "wrangler deploy");
  has("yarn workspace web exec wrangler deploy", "wrangler deploy");
  has("yarn run wrangler deploy", "wrangler deploy");
  has("bunx wrangler@latest deploy", "wrangler deploy");
  has("corepack pnpm exec wrangler deploy", "wrangler deploy");
  has("python -m twine upload dist/*", "twine upload dist/*");
  has("py -m twine upload x", "twine upload x");
  has("uv run twine upload x", "twine upload x");
  has("uv tool run twine upload x", "twine upload x");
  has("uvx twine upload x", "twine upload x");
  has("pipx run twine upload x", "twine upload x");
  has("poetry run twine upload x", "twine upload x");
  assert.equal(pkgBin("wrangler@latest"), "wrangler");
  assert.equal(pkgBin("@cloudflare/wrangler@1.2"), "@cloudflare/wrangler");
  assert.equal(pkgBin("netlify-cli@1"), "netlify");
});

test("PowerShell mode: backticks, curly quotes, Unicode spaces, CR, backslash, block comments, script blocks", () => {
  const ps = (text) => splitCommands(text, "ps").map((c) => [c.program, ...c.globals, ...c.args].join(" "));
  assert.ok(ps("g`it push -f").includes("git push -f"));
  assert.ok(ps("git `\n push -f").includes("git push -f"), "a backtick continues the line");
  assert.ok(ps("‘git’ “push” -f").includes("git push -f"));
  assert.ok(ps("git\u00A0push\u2003-f").includes("git push -f"));
  assert.ok(ps("git status\rgit push -f").includes("git push -f"), "a bare CR ends a statement");
  assert.ok(ps("git status\u2028git push -f").includes("git push -f"));
  assert.ok(ps("git <# a comment; git status #> push -f").includes("git push -f"));
  assert.ok(ps("echo \"a\\\" ; git push -f ; \"").includes("git push -f"), "a backslash before a quote is a plain character in PowerShell");
  assert.ok(ps("Start-Job -ScriptBlock {git push -f}").includes("git push -f"));
  assert.ok(ps("1 | % { git push -f }").includes("git push -f"));
  assert.ok(ps("if ($true) { git push -f }").includes("git push -f"));
  assert.ok(ps("& 'git' push -f").includes("git push -f"));
  assert.ok(ps(".\\git.exe push -f").includes("git push -f"));
  assert.ok(ps("C:\\Git\\bin\\git.exe push -f").includes("git push -f"));
  assert.throws(() => ps("git status <# never ends"), /block comment never ends/);
  const exotic = (text) => splitCommands(text, "ps").some((c) => c.exotic);
  for (const text of ["& $x push", "& ($x) push", ". $x push", ".$x push", "$sb.Invoke()", "&$x push", "[Diagnostics.Process]::Start('git')", "Set-Alias g git", "function g { }", "New-Object x", "Add-Type x", "gcm git"]) assert.ok(exotic(text), text);
  for (const text of ["$x = 1", "$x=1", "$LASTEXITCODE -ne 0", "$true", "$x -eq 1", "$env:A = 'b'", "& git status", "& 'git' status", "git status", "Write-Output hi"]) assert.ok(!exotic(text), text);
});

test("PowerShell and cmd launched from a shell: the first plain argument is the command, -EncodedCommand has many spellings", () => {
  has("powershell git push -f", "git push -f");
  has("powershell -NoProfile git push -f", "git push -f");
  has("powershell -NoProfile -ExecutionPolicy Bypass -Command git push -f", "git push -f");
  has("pwsh -wd C:\\x -c git push -f", "git push -f");
  has("powershell /c git push -f", "git push -f");
  has("powershell -Co git push -f", "git push -f");
  for (const flag of ["-EncodedCommand", "-EncodedC", "-Enc", "-en", "-e", "-ec", "/enc"]) has(`powershell ${flag} ${Buffer.from("git push -f", "utf16le").toString("base64")}`, "git push -f");
  // -File runs a script: the words after it are the script's arguments, not a command.
  assert.ok(!flat("powershell -File x.ps1 git push -f").includes("git push -f"));
});

test("cmd mode: //c, glued /c, carets, only double quotes, %variables%", () => {
  has("cmd //c git push -f", "git push -f");
  has("cmd ///c git push -f", "git push -f");
  has("cmd /cgit push -f", "git push -f");
  has("cmd /K git push -f", "git push -f");
  has("cmd /d /s /c \"git push -f\"", "git push -f");
  has("cmd /c \"echo a & git push -f\"", "git push -f");
  has("cmd /c g^it push -f", "git push -f");
  const cmd = (text) => splitCommands(text, "cmd");
  assert.deepEqual(cmd("echo 'a' & git push -f").map((c) => [c.program, ...c.args].join(" ")), ["echo 'a'", "git push -f"]);
  assert.deepEqual(cmd("echo a^&b").map((c) => c.program), ["echo", "b"], "carets are dropped before parsing, so an escaped & over-splits (the cautious side)");
  assert.ok(splitCommands("cmd /c git push %X%").some((c) => c.exotic));
  assert.ok(splitCommands("cmd /v:on /c \"git push !X!\"").some((c) => c.exotic));
  assert.ok(!splitCommands("cmd /c git push 100").some((c) => c.exotic));
});

test("every tokenizer loop is linear: 80000-word inputs are split in well under a second", () => {
  const timed = (text) => { const t0 = performance.now(); const out = splitCommands(text); return { out, ms: performance.now() - t0 }; };
  for (const text of ["A=1 ".repeat(80000) + "git push", "! ".repeat(80000) + "git push", "{ ".repeat(80000) + "git push", "> x ".repeat(40000) + "git push", "a ".repeat(100000), "echo ".repeat(100000) + "| git push", "\"\" ".repeat(60000) + "git push", "'' ".repeat(60000) + "git push"]) {
    const { out, ms } = timed(text);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${JSON.stringify(text.slice(0, 16))}`);
    assert.ok(out.length >= 1, "something was found");
  }
  for (const text of ["A=1 ".repeat(80000) + "git push", "! ".repeat(80000) + "git push"]) {
    const { out } = timed(text);
    assert.ok(out.some((c) => c.program === "git" && c.args[0] === "push"), "the push is still found");
  }
  // Pathological quotes, braces and comments.
  for (const text of ["{" + ",".repeat(100000), "a{,".repeat(50000), "<#".repeat(40000), "`".repeat(100000), "\\".repeat(100000), "$(".repeat(9) + "x".repeat(60000), "<<A ".repeat(30000) + "\nx"]) {
    for (const mode of ["sh", "ps", "cmd"]) {
      const t0 = performance.now();
      try { splitCommands(text, mode); } catch { /* too deep or unterminated: fine */ }
      assert.ok(performance.now() - t0 < 1000, `${mode} ${JSON.stringify(text.slice(0, 10))}`);
    }
  }
});

// ---------- fix round 2 ----------

test("fix round 2: arguments with an expansion are marked (not enumerable), by the word's text", () => {
  const [c] = splitCommands("git push $F \"a$(b)c\" plain '$x' \"$y\" `z` ${W} <(q)");
  assert.deepEqual(c.args, ["push", "$F", "ac", "plain", "$x", "$y", "", "${W}", ""]);
  assert.deepEqual(c.expanded, [false, true, true, false, false, true, true, true, true]);
  assert.deepEqual(Object.keys(c), ["program", "args", "globals", "env"]);
  assert.deepEqual(splitCommands("git commit -m \"$(cat m)\"")[0].expanded, [false, false, true]);
  assert.deepEqual(splitCommands("echo plain")[0].expanded, [false]);
  // Inside bash -c text the inner words are marked too.
  assert.ok(splitCommands("bash -c 'git push $F'").find((e) => e.program === "git").expanded[1]);
});

test("fix round 2: a shell with no -c text and no script file reads stdin and says so", () => {
  const stdin = (t) => splitCommands(t).filter((e) => e.stdinShell).length;
  for (const t of ["bash", "sh -s", "bash -", "echo x | sh", "bash -ls", "zsh -i", "ksh", "dash -s a b", "bash <<< 'echo hi'", "cat <<E | bash\necho\nE", "sudo -s", "sudo -i", "/bin/bash", "bash.exe -s", "busybox sh", "env bash", "timeout 5 bash <<E\necho\nE"]) {
    assert.equal(stdin(t), 1, t);
  }
  for (const t of ["bash -c 'echo hi'", "bash -lc 'echo hi'", "bash script.sh", "sh ./x.sh a b", "bash -n x.sh", "bash --version", "sh --help", "bash -x -- script.sh", "bash -o pipefail script.sh", "echo bash", "bash -c"]) {
    assert.equal(stdin(t), 0, t);
  }
});

test("fix round 2: a heredoc or here-string reaches the program behind a wrapper", () => {
  const pushes = (t) => splitCommands(t).filter((e) => e.program === "git" && e.args[0] === "push").length;
  for (const w of ["nohup", "timeout 5", "sudo", "env", "exec", "command", "time", "nice", "setsid", "stdbuf -o0", "env X=1", "sudo -u x"]) {
    assert.equal(pushes(`${w} bash <<< 'git push -f'`), 1, w);
    assert.equal(pushes(`${w} bash <<E\ngit push -f\nE`), 1, w);
    assert.equal(pushes(`${w} sh <<'E'\ngit push -f\nE`), 1, w);
  }
  assert.equal(pushes("nohup nohup timeout 5 bash <<< 'git push -f'"), 1);
});

test("fix round 2: coproc is a program of its own, and node follows a tool path under node_modules or .bin", () => {
  assert.equal(splitCommands("coproc X { git push -f; }")[0].program, "coproc");
  assert.equal(splitCommands("coproc git push -f")[0].program, "coproc");
  const programs = (t) => splitCommands(t).map((e) => e.program);
  assert.ok(programs("node node_modules/.bin/wrangler deploy").includes("wrangler"));
  assert.ok(programs("node ./node_modules/wrangler/bin/wrangler.js deploy").includes("wrangler"));
  assert.ok(programs("node -r dotenv/config ../node_modules/netlify-cli/bin/run.js deploy").includes("netlify"));
  assert.ok(programs("node --no-warnings --import x node_modules/.bin/vercel --prod").includes("vercel"));
  assert.deepEqual(splitCommands("node node_modules/.bin/wrangler deploy")[1].args, ["deploy"]);
  // Not a tool path, inline code, or an option value: nothing extra.
  assert.deepEqual(programs("node scripts/lint.mjs"), ["node"]);
  assert.deepEqual(programs("node -e 'x'"), ["node"]);
  assert.deepEqual(programs("node --test tests/"), ["node"]);
  assert.deepEqual(programs("node"), ["node"]);
});

test("fix round 2: PowerShell mode drops an assignment target and follows every script block", () => {
  const ps = (t) => splitCommands(t, "ps").map((e) => [e.program, ...e.args, e.env.join()].join(" ").trim());
  assert.deepEqual(ps("$null = git push -f"), ["git push -f"]);
  assert.deepEqual(ps("$x=git push --force"), ["git push --force"]);
  assert.deepEqual(ps("[string]$x = git push -f"), ["git push -f"]);
  assert.deepEqual(ps("$a,$b = git push -f"), ["git push -f"]);
  assert.deepEqual(ps("$x += git push -f"), ["git push -f"]);
  assert.deepEqual(ps("${x} = git push -f"), ["git push -f"]);
  assert.deepEqual(ps("$x = Invoke-Expression 'git push -f'"), ["invoke-expression git push -f", "git push -f"]);
  assert.deepEqual(ps("${env:GIT_DIR} = 'x'"), ["x GIT_DIR="]);
  assert.deepEqual(ps("1 | % { echo } { git push -f }").filter((l) => l.startsWith("git")), ["git push -f"]);
  assert.deepEqual(ps("try { echo } finally { git push -f }").filter((l) => l.startsWith("git")), ["git push -f"]);
  assert.deepEqual(ps("ForEach-Object -Begin { echo } -Process { git push -f }").filter((l) => l.startsWith("git")), ["git push -f"]);
});

test("fix round 2: cmd mode reads call, @, if and for /f", () => {
  const cmd = (t) => splitCommands(t, "cmd");
  for (const t of ["call git push -f", "@git push -f", "if exist x git push -f", "if not defined V git push -f", "if errorlevel 1 git push -f", "if /i a==a git push -f", "if a == b git push -f", "if 1 gtr 0 git push -f"]) {
    assert.ok(cmd(t).some((e) => e.program === "git" && e.args.join(" ") === "push -f"), t);
  }
  assert.ok(cmd("if foo").some((e) => e.exotic));
  assert.ok(cmd("for /f %i in ('x') do echo").some((e) => e.exotic));
  assert.equal(cmd("if exist x git status").some((e) => e.exotic), false);
});
