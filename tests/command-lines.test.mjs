// Run with: node --test tests/
// Every command line a skill tells the model to build puts a path in single quotes, never double quotes, and every
// non-path value is bare only with a stated pattern. The checker is in tests/helpers/command-lines.mjs and runs in-process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommandLines, checkTree, scopeFiles, scriptLines, RULE_PIECES } from "./helpers/command-lines.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PS = "plugins/phased-shipping/skills";
const SKILLS = [`${PS}/run/SKILL.md`, `${PS}/plan/SKILL.md`, `${PS}/roadmap/SKILL.md`, `${PS}/onboard/SKILL.md`, `${PS}/dashboard/SKILL.md`, "plugins/free-resources/skills/free-resources/SKILL.md"];
// every piece of the rule, as the skills say it
const ROOT_RULE = "A value that is empty, or is a drive or file-system root (`/`, `C:\\`, `C:/`, `C:` or a `\\\\server\\share` share), is not run; check this on the value as given and again after a trailing separator is dropped.";
const RULE = `A path is single-quoted. A call is not run when the path holds a single quote, a double quote, a control or format character or any of U+2018 to U+201B, or ends in a slash: drop a trailing separator. ${ROOT_RULE} Run the calls with the Bash tool.`;
const doc = (...lines) => lines.join("\n");
const read = (f) => readFileSync(join(REPO, f), "utf8");
const fails = (file, text, expect) => {
  const problems = checkCommandLines(file, text);
  assert.ok(problems.length >= 1, `expected a problem in: ${text}`);
  if (expect) assert.ok(problems.some((p) => expect.test(p)), `no problem matched ${expect}: ${problems.join(" | ")}`);
  return problems;
};
const passes = (text) => assert.deepEqual(checkCommandLines("a.md", text), []);
const esc = (s) => s.replace(/[.\\^$*+?()|[\]{}/]/g, "\\$&");

test("the real tree: every script command line in every skill and agent file follows the quoting rule", () => {
  const files = scopeFiles(REPO);
  for (const f of [...SKILLS, `${PS}/roadmap/references/format.md`, `${PS}/dashboard/references/status.md`]) assert.ok(files.includes(f), `${f} is in scope`);
  assert.ok(files.length >= 20, `${files.length} files in scope`);
  assert.deepEqual(checkTree(REPO), []);
  // the check has something to look at in the skills that run scripts
  for (const f of SKILLS) assert.ok(scriptLines(read(f)).length >= 3, `${f} has script lines`);
  // every skill with a script line states every piece of the unsafe-character rule
  for (const f of SKILLS) for (const piece of RULE_PIECES) assert.ok(read(f).includes(piece), `${f}: ${piece}`);
});

test("scope: the .md files under plugins/*/skills, plugins/*/agents, skills and agents, and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "zork-scope-"));
  try {
    for (const rel of ["plugins/acmecorp/skills/a/SKILL.md", "plugins/acmecorp/skills/a/references/r.md", "plugins/acmecorp/agents/x.md", "skills/b/SKILL.md", "agents/y.md",
      "plugins/acmecorp/README.md", "README.md", "docs/wiki/Page.md", "plugins/acmecorp/skills/a/scripts/s.mjs", "tests/fixtures/z.md"]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), "x\n");
    }
    assert.deepEqual([...scopeFiles(root)].sort(), ["agents/y.md", "plugins/acmecorp/agents/x.md", "plugins/acmecorp/skills/a/SKILL.md", "plugins/acmecorp/skills/a/references/r.md", "skills/b/SKILL.md"].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("what counts as a script line: a span or a fenced line that runs a .mjs script, not prose or other spans", () => {
  const text = doc(
    "Run `node x/scripts/zork.mjs check '<file>'` now.",
    "A span with an option and a placeholder: `--root \"<folder>\"` counts, `--root=\"<folder>\"` too.",
    "Prose names zork.mjs and <file> but has no code span.",
    "A span with no script, no option: `recorded previewed <12 hex>` and `reuse <tree> <date>`.",
    "```",
    "node x/zork.mjs one '<a>'",
    "echo plain",
    "node x/zork.mjs two \\",
    "  --root '<b>'",
    "```",
    "After the fence: `node y/zork.mjs two`.",
    "<code>node z/zork.mjs go '<c>'</code>",
    "    node w/zork.mjs indented '<d>'",
    "~~~",
    "node v/zork.mjs tilde '<e>'",
    "~~~",
    "A git line: `git diff --name-only <one tree> <other tree>`.",
  );
  assert.deepEqual(scriptLines(text).map((l) => l.line), [1, 2, 2, 6, 8, 11, 12, 13, 15]);
  assert.equal(scriptLines(text).find((l) => l.line === 8).text, "node x/zork.mjs two --root '<b>'");
  // a ``` fence is not closed by ~~~, and the other way round
  assert.deepEqual(scriptLines(doc("```", "~~~", "node a.mjs x", "```", "`node b.mjs y`")).map((l) => l.line), [3, 5]);
});

test("a double-quoted placeholder fails, named by file and line, in a span and in a fenced block", () => {
  for (const bad of [
    "`node \"${CLAUDE_SKILL_DIR}/scripts/zork.mjs\" check \"<file>\" --root '<project folder>'`",
    "`node \"${CLAUDE_SKILL_DIR}/scripts/zork.mjs\" check '<file>' --root \"<project folder>\"`",
    "`node zork.mjs run --exclude \"<path>\"`",
    "`node zork.mjs set \"<PHASES.md>\" <phase id>`",
    "`restore \"<file>\" --from '<choice>' --root '<project folder>'`",
    "`--root=\"<dir>\"`",
    "`--root \"<project folder>\"`",
    "<code>node zork.mjs go \"<file>\"</code>",
  ]) {
    const ps = fails("plugins/acmecorp/skills/a/SKILL.md", doc("Intro.", `Run ${bad}.`, RULE, "Phase ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`."), /^plugins\/acmecorp\/skills\/a\/SKILL\.md:2: a double-quoted placeholder/);
    assert.ok(ps.every((p) => p.startsWith("plugins/acmecorp/skills/a/SKILL.md:2:")), ps.join(" | "));
  }
  fails("skills/zork/SKILL.md", doc("```", "node zork.mjs", "node zork.mjs hash \"<plan>\" --record planned", "```", RULE), /^skills\/zork\/SKILL\.md:3: a double-quoted placeholder/);
  fails("a.md", doc("Steps:", "", "    node zork.mjs hash \"<plan>\"", RULE), /a\.md:3: a double-quoted placeholder/);
  fails("a.md", doc("~~~", "node zork.mjs hash \"<plan>\"", "~~~", RULE), /a\.md:2: a double-quoted placeholder/);
  // a placeholder beside the allowed variable on the same line still fails
  fails("a.md", doc("`node \"${CLAUDE_SKILL_DIR}/scripts/zork.mjs\" --data \"${CLAUDE_PLUGIN_DATA}\" --root \"<dir>\"`", RULE), /a\.md:1: a double-quoted placeholder/);
});

test("a fenced command that continues on the next line is checked as one line", () => {
  const text = doc("```", "node zork.mjs go \\", "  --root \"<dir>\" \\", "  --plans '<x>'", "```", RULE);
  fails("a.md", text, /a\.md:2: a double-quoted placeholder/);
  // the script name on the first line, the unsafe value on the last
  fails("a.md", doc("```sh", "node zork.mjs go \\", "  --label \\", "  <phase title>", "```"), /a\.md:2: a bare <phase title>/);
  // a good continuation passes, and one that breaks the rule on a later line is caught there too
  passes(doc("```", "node zork.mjs go \\", "  --root '<dir>'", "```", RULE));
  fails("a.md", doc("```", "node zork.mjs go \\", "  --root $DIR", "```"), /a\.md:2: a \$ or a backtick outside single quotes/);
});

test("a double-quoted string is allowed only around a Claude Code variable or fixed lowercase text", () => {
  const line = (s) => `\`node zork.mjs go ${s}\``;
  for (const bad of ['"$PLAN_FILE"', '"{plan}"', '"PLAN_PATH"', "\"'<plan>'\"", '"$(date)"', '"a;b"', '"${HOME}/x"', '"${CLAUDE_SKILL_DIR}/<x>"', '"${CLAUDE_SKILL_DIR}/$(x)"', '"${CLAUDE_PLUGIN_DATA}x;y"']) {
    fails("a.md", doc(line(bad), RULE), /a\.md:1: a double-quoted/);
  }
  for (const good of ['"${CLAUDE_SKILL_DIR}"', '"${CLAUDE_PLUGIN_DATA}"', '"${CLAUDE_SKILL_DIR}/../run/scripts/zork.mjs"', '"${CLAUDE_PLUGIN_DATA}/history.jsonl"', '"in progress"']) passes(doc(line(good)));
  // a $ or a backtick outside single quotes, in a fence, outside those two variables
  for (const bad of ["node zork.mjs go $HOME", "node zork.mjs go $(date)", "node zork.mjs go `date`", "node zork.mjs go ${CLAUDE_SKILL_DIR}", "node zork.mjs go ${OTHER}"]) {
    fails("a.md", doc("```", bad, "```"), /a\.md:2: a \$ or a backtick outside single quotes/);
  }
  passes(doc("```", "node \"${CLAUDE_SKILL_DIR}/scripts/zork.mjs\" go '$(date)' '`x`' \"${CLAUDE_PLUGIN_DATA}\"", "```"));
});

test("a bare placeholder fails unless it is on the validated list and the file states its pattern", () => {
  const stated = doc("A phase id matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`; a commit `^[0-9a-f]{7,40}$`; hours `^\\d{1,3}(\\.\\d{1,2})?$`; a list digest `^[0-9a-f]{12,64}$`; an id `^[0-9a-f]{12}$`;",
    "a relative path `^[A-Za-z0-9._/-]{1,100}$`; seconds are a whole number from 5 to 300; an index `^\\d{1,3}$`; a step or a state is a word from the fixed lists;",
    "`<command>` is one of `read`, `check`, `standardize`, `set`, `restore` or `adopt`; the words after `--` are the user's own command.");
  // not on the list
  for (const name of ["file", "plan", "project folder", "sha", "title", "name", "path", "dir", "started", "folder", "relative-path"]) {
    fails("a.md", doc(`\`node zork.mjs go --root <${name}>\``, stated), new RegExp(`a\\.md:1: a bare <${name}> that is not on the validated list`));
  }
  // each name, after its own option, with its pattern stated: passes
  const uses = { "phase id": "--phase", label: "--label", "history label": "--label", commit: "--commit", hours: "--actual", "list digest": "--list-digest", id: "unregister", "relative path": "--roadmap", seconds: "--refresh-s", index: "--table", step: "--step", state: "--state", command: "roadmap.mjs", "command...": "--" };
  for (const [name, before] of Object.entries(uses)) {
    const ok = doc(`\`node zork.mjs ${before} <${name}>\``, stated);
    passes(before === "roadmap.mjs" ? doc("`node roadmap.mjs <command>`", stated) : ok);
    // the same name after another option fails
    if (before !== "--") fails("a.md", doc(`\`node zork.mjs --other <${name}>\``, stated), new RegExp(`a\\.md:1: a bare <${esc(name)}> that does not follow`));
  }
  passes(doc("`node zork.mjs set '<PHASES.md>' <phase id>`", stated, RULE));
  // on the list, in the right place, pattern not stated: each one fails on its own
  for (const [name, before] of Object.entries(uses)) {
    if (before === "roadmap.mjs") continue;
    fails("a.md", doc(`\`node zork.mjs ${before} <${name}>\``, "Nothing stated here."), new RegExp(`a\\.md:1: a bare <${esc(name)}> but the file does not state its pattern or word list`));
  }
  fails("a.md", doc("`node roadmap.mjs <command>`", "Nothing stated here."), /a\.md:1: a bare <command> but the file does not state/);
});

test("the classes the first version of this test missed all fail now", () => {
  const stated = doc("Labels match `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`; a relative path `^[A-Za-z0-9._/-]{1,100}$`; an index `^\\d{1,3}$`.");
  const cases = [
    ["a quoted path in a span with an option and no script name", "`restore \"<file>\" --from '<choice>' --root '<project folder>'`", /a double-quoted placeholder/],
    ["a bare relative path after the wrong option", "`--exclude <relative path>`", /a bare <relative path> that does not follow --roadmap/],
    ["a bare folder", "`--plans <folder>`", /a bare <folder> that is not on the validated list/],
    ["a bare file after --into", "`--into <roadmap file>`", /a bare <roadmap file> that is not on the validated list/],
    ["a bare label after --project", "`--project <label>`", /a bare <label> that does not follow --label/],
    ["an equals sign and double quotes", "`--root=\"<dir>\"`", /a double-quoted placeholder/],
    ["a bare started time", "`node zork.mjs check --since <started>`", /a bare <started> that is not on the validated list/],
    ["a variable in double quotes", "`node zork.mjs go --root \"$PLAN_FILE\"`", /a double-quoted value that is not a Claude Code variable/],
    ["a placeholder in braces", "`node zork.mjs go --root \"{plan}\"`", /a double-quoted value/],
  ];
  for (const [what, line, expect] of cases) fails("a.md", doc(`Run ${line}.`, stated, RULE), expect);
  // the same lines written the safe way pass
  passes(doc("`restore '<file>' --from '<choice>' --root '<project folder>'`", "`--exclude '<relative path>'`", "`--plans '<folder>'`", "`--into '<roadmap file>'`", "`--project '<label>'`", "`--root='<dir>'`", "`node zork.mjs check --since '<started>'`", stated, RULE));
});

test("single-quoted placeholders need the unsafe-character rule in the same file, each piece of it", () => {
  const line = "`node \"${CLAUDE_SKILL_DIR}/scripts/zork.mjs\" check '<file>' --root '<project folder>'`";
  passes(doc(line, RULE));
  const none = fails("skills/zork/SKILL.md", doc("Intro", line, "Nothing about quotes."), /^skills\/zork\/SKILL\.md:2: single-quoted placeholders, but the file does not state the unsafe-character rule/);
  assert.equal(none.length, RULE_PIECES.length, "each missing piece is named");
  assert.deepEqual(RULE_PIECES, ["single quote", "double quote", "control or format character", "U+2018 to U+201B", "trailing separator", "file-system root", "is empty", "Bash tool"]);
  for (const piece of RULE_PIECES) {
    // every copy of the piece goes ("trailing separator" is said twice)
    const ps = fails("a.md", doc(line, RULE.replaceAll(piece, "something")), new RegExp(`missing "${esc(piece)}"`));
    assert.equal(ps.length, 1, ps.join(" | "));
  }
  // a file with no single-quoted placeholder owes no rule
  passes("`node \"${CLAUDE_SKILL_DIR}/scripts/zork.mjs\" state --data \"${CLAUDE_PLUGIN_DATA}\"`");
});

test("exempt: \"${CLAUDE_SKILL_DIR}\" and \"${CLAUDE_PLUGIN_DATA}\" in double quotes, with or without a path after them", () => {
  passes(doc(
    "`node \"${CLAUDE_SKILL_DIR}/scripts/zork.mjs\" state --data \"${CLAUDE_PLUGIN_DATA}\"`",
    "`node \"${CLAUDE_SKILL_DIR}/../run/scripts/zork.mjs\" stats \"${CLAUDE_PLUGIN_DATA}/history.jsonl\"`",
    "```",
    "node \"${CLAUDE_SKILL_DIR}/scripts/acmecorp.mjs\"",
    "```",
  ));
  // double quotes around fixed text are fine too: no placeholder, nothing from a file
  passes("`node zork.mjs set --status \"in progress\"`");
});

test("mutation proof on synthetic text: the good form passes, and each bad form of it fails with the file and line", () => {
  const good = doc(
    "# Zork skill",
    "Quote paths. " + RULE,
    "A phase id matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`.",
    "Run `node \"${CLAUDE_SKILL_DIR}/scripts/zork.mjs\" set '<PHASES.md>' <phase id> --root '<folder of PHASES.md>' --data \"${CLAUDE_PLUGIN_DATA}\"`.",
  );
  passes(good);
  const mutations = [
    ["a path in double quotes", (s) => s.replace("'<PHASES.md>'", "\"<PHASES.md>\""), /good\.md:4: a double-quoted placeholder/],
    ["a bare path", (s) => s.replace("'<PHASES.md>'", "<PHASES.md>"), /good\.md:4: a bare <PHASES\.md> that is not on the validated list/],
    ["a bare title", (s) => s.replace("<phase id>", "<phase title>"), /good\.md:4: a bare <phase title>/],
    ["the pattern removed", (s) => s.replace("`^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`", "a short word"), /good\.md:4: a bare <phase id> but the file does not state its pattern/],
    ["the rule removed", (s) => s.replace(RULE, "Nothing."), /good\.md:4: single-quoted placeholders, but the file does not state the unsafe-character rule/],
    ["the Bash tool piece removed", (s) => s.replace("Run the calls with the Bash tool.", ""), /missing "Bash tool"/],
    ["the folder in double quotes", (s) => s.replace("'<folder of PHASES.md>'", "\"<folder of PHASES.md>\""), /good\.md:4: a double-quoted placeholder/],
    ["the phase id after the wrong option", (s) => s.replace("<phase id> --root", "--note <phase id> --root"), /good\.md:4: a bare <phase id> that does not follow/],
    ["a shell variable", (s) => s.replace("'<PHASES.md>'", "$PHASES"), /good\.md:4: a \$ or a backtick outside single quotes/],
    ["a backslash-escaped quote", (s) => s.replace("'<PHASES.md>'", "\\'<PHASES.md>\\'"), /good\.md:4: a backslash escape outside single quotes/],
    ["a %name% placeholder", (s) => s.replace("'<PHASES.md>'", "%phases%"), /good\.md:4: a %name% placeholder/],
    ["a placeholder that starts with a digit", (s) => s.replace("'<PHASES.md>'", "<2PHASES.md>"), /good\.md:4: a bare <2PHASES\.md> that is not on the validated list/],
    ["text glued after the phase id", (s) => s.replace("<phase id> --root", "<phase id>x --root"), /good\.md:4: a bare <phase id> with text glued after it/],
    ["the span wrapped onto the next row with a double-quoted path", (s) => s.replace(" set '<PHASES.md>'", "\nset \"<PHASES.md>\""), /good\.md:4: a double-quoted placeholder/],
    ["the empty-value piece removed", (s) => s.replace("empty, or is a", ""), /good\.md:4: .*missing "is empty"/],
  ];
  for (const [what, mutate, expect] of mutations) {
    const mutated = mutate(good);
    assert.notEqual(mutated, good, `${what}: the mutation changed the text`);
    fails("good.md", mutated, expect);
  }
});

test("mutation proof on the real skills: turning one single-quoted path into a double-quoted one fails in that file", () => {
  for (const f of SKILLS) {
    const text = read(f);
    assert.deepEqual(checkCommandLines(f, text), [], f);
    const lines = text.split("\n");
    const at = lines.findIndex((l) => /\.mjs[^`\n]*'<[^'>]*>'/.test(l));
    assert.ok(at >= 0, `${f} has a single-quoted placeholder on a script line`);
    lines[at] = lines[at].replace(/'(<[^'>]*>)'/, '"$1"');
    const ps = fails(f, lines.join("\n"), new RegExp(`^${esc(f)}:${at + 1}: a double-quoted placeholder`));
    assert.ok(ps.every((p) => p.startsWith(`${f}:${at + 1}:`)), ps.join(" | "));
  }
});

test("mutation proof on the real skills: the lines the first review found fail when written the old way", () => {
  const mutate = (f, from, to) => {
    const text = read(f);
    assert.ok(text.includes(from), `${f} has ${from}`);
    return text.replace(from, to);
  };
  const named = (f, expect, from, to) => fails(f, mutate(f, from, to), expect);
  named(`${PS}/roadmap/SKILL.md`, /a double-quoted placeholder/, "`restore '<file>' --from '<choice>' --root '<project folder>'`", "`restore \"<file>\" --from '<choice>' --root '<project folder>'`");
  named(`${PS}/roadmap/SKILL.md`, /a bare <folder> that is not on the validated list/, "`--plans '<folder>'`", "`--plans <folder>`");
  named(`${PS}/roadmap/SKILL.md`, /a bare <roadmap file> that is not on the validated list/, "`--into '<roadmap file>'`", "`--into <roadmap file>`");
  named(`${PS}/roadmap/SKILL.md`, /a bare <label> that does not follow --label/, "`--project '<label>'`", "`--project <label>`");
  named(`${PS}/onboard/SKILL.md`, /a bare <relative path> that does not follow --roadmap/, "`--exclude '<relative path>'`", "`--exclude <relative path>`");
  named(`${PS}/run/SKILL.md`, /a bare <started> that is not on the validated list/, "--since '<started>'", "--since <started>");
  named(`${PS}/run/SKILL.md`, /a double-quoted placeholder/, "--plan '<plan>' --data", "--plan \"<plan>\" --data");
  named(`${PS}/roadmap/references/format.md`, /a bare <id>=<status>|a bare <id>/, "`--set-status '<id>=<status>'`", "`--set-status <id>=<status>`");
  named(`${PS}/roadmap/references/format.md`, /a bare <file> that is not on the validated list/, "`--history '<file>'`", "`--history <file>`");
  named(`${PS}/dashboard/SKILL.md`, /a bare <history label> that does not follow --label|a bare <relative path>/, "--roadmap <relative path>", "--label <relative path>");
});

test("the old unsafe command lines are all caught", () => {
  const old = [
    "`node \"${CLAUDE_SKILL_DIR}/../roadmap/scripts/roadmap.mjs\" set \"<PHASES.md>\" <phase id> --status \"in progress\" --root \"<folder of PHASES.md>\"`",
    "`node \"${CLAUDE_SKILL_DIR}/scripts/commands-hash.mjs\" \"<plan>\" --check planned --data \"${CLAUDE_PLUGIN_DATA}\"`",
    "`node \"${CLAUDE_SKILL_DIR}/scripts/survey.mjs\" list --root \"<project folder>\"`",
    "`node \"${CLAUDE_SKILL_DIR}/scripts/roadmap.mjs\" standardize \"<file>\" --root \"<project folder>\"`",
    "`node \"${CLAUDE_SKILL_DIR}/scripts/headroom.mjs\" --task <name> --project <dir>`",
    "`node \"${CLAUDE_SKILL_DIR}/../plan/scripts/history.mjs\" record \"${CLAUDE_PLUGIN_DATA}/history.jsonl\" --from <temp-file>`",
  ];
  for (const line of old) fails("old.md", doc(line, RULE), /old\.md:1:/);
});

const PATTERNS = doc("Labels match `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`; an index `^\\d{1,3}$`; a commit `^[0-9a-f]{7,40}$`; hours `^\\d{1,3}(\\.\\d{1,2})?$`; `<command>` is one of `read`, `check`, `standardize`, `set`, `restore` or `adopt`.");

test("bracketed options, positional-only spans and spans with a quote or a $ are script lines too", () => {
  const cases = [
    ["a bracketed option with a double-quoted placeholder", "`[--plans \"<dir>\"]...`", /a double-quoted placeholder/],
    ["a bracketed option with a command substitution", "`[--into \"$(touch pwn)\"]`", /a double-quoted value/],
    ["a bracketed option with a bare placeholder", "`[--history <file>]`", /a bare <file> that is not on the validated list/],
    ["a bracketed status with double quotes", "`[--set-status \"<id>=<status>\"]`", /a double-quoted placeholder/],
    ["a subcommand with a double-quoted path", "`restore \"<file>\"`", /a double-quoted placeholder/],
    ["a subcommand with a bare path", "`read <file>`", /a bare <file> that is not on the validated list/],
    ["a subcommand with two bare values", "`set <file> <id>`", /a bare <file>/],
    ["a bare placeholder after a bracket", "`x [--root <dir>]`", /a bare <dir> that is not on the validated list/],
    ["a bare placeholder after a parenthesis", "`x (--root <dir>)`", /a bare <dir> that is not on the validated list/],
    ["a bare placeholder after a pipe", "`a|--root <dir>`", /a bare <dir> that is not on the validated list/],
    ["a placeholder beside a quote and no option", "`check '<a>' <b>`", /a bare <b> that is not on the validated list/],
    ["a placeholder beside a $", "`echo $HOME <dir>`", /a \$ or a backtick outside single quotes/],
  ];
  for (const [what, line, expect] of cases) fails("a.md", doc(`Run ${line}.`, PATTERNS, RULE), expect);
  // the safe forms of the same lines pass
  passes(doc("`[--plans '<dir>']...`", "`[--into 'x']`", "`[--history '<file>']`", "`[--set-status '<id>=<status>']`", "`restore '<file>'`", "`read '<file>'`", "`set '<file>' '<id>' --commit <commit>`", "`x [--root '<dir>']`", PATTERNS, RULE));
  // prose spans, JSON samples and git lines are not script lines
  passes(doc("`page not rebuilt (<reason>)`", "`{ \"declined\": \"<date>\" }`", "`git diff --name-only <a> <b>`", "`reuse <tree> <date>`", "`recorded previewed <12 hex>`"));
});

test("the format page's table rows are checked: the adopt row with a double-quoted bracketed option fails", () => {
  const f = `${PS}/roadmap/references/format.md`;
  const text = read(f);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("| `adopt '<project folder>'"));
  assert.ok(at >= 0, "the adopt row is there");
  for (const [from, to] of [["[--plans '<dir>']...", "[--plans \"<dir>\"]..."], ["[--history '<file>']", "[--history <file>]"], ["[--set-status '<id>=<status>']...", "[--set-status \"<id>=<status>\"]..."], ["[--into '<roadmap file>']", "[--into \"$(touch pwn)\"]"]]) {
    assert.ok(lines[at].includes(from), from);
    const mutated = [...lines];
    mutated[at] = lines[at].replace(from, to);
    fails(f, mutated.join("\n"), new RegExp(`^${esc(f)}:${at + 1}:`));
  }
  // so do the read, check, standardize, set and restore rows
  for (const start of ["| `read '<file>'", "| `check '<file>'", "| `standardize '<file>'", "| `set '<file>'", "| `restore '<file>'"]) {
    const row = lines.findIndex((l) => l.startsWith(start));
    assert.ok(row >= 0, start);
    const mutated = [...lines];
    mutated[row] = lines[row].replace("'<file>'", "\"<file>\"");
    fails(f, mutated.join("\n"), new RegExp(`^${esc(f)}:${row + 1}: a double-quoted placeholder`));
  }
});

test("unbracketed placeholders and loose double quotes fail: {name}, ALL_CAPS, [bracketed words], and any fixed word not on the list", () => {
  const line = (s) => `\`node zork.mjs check ${s}\``;
  for (const [bad, expect] of [["{plan}", /a \{name\} placeholder/], ["PLAN_FILE", /an ALL_CAPS placeholder PLAN_FILE/], ["[plan path]", /a \[bracketed words\] placeholder/], ["\"shipped\"", /a double-quoted value/], ["\"in progres\"", /a double-quoted value/], ["\"in  progress\"", /a double-quoted value/]]) {
    fails("a.md", doc(line(bad), RULE), new RegExp(`a\\.md:1: ${expect.source}`));
  }
  // the fixed literals still pass: the one listed word, the options and single letters
  passes(doc(line("--status \"in progress\" [--json] [--interval-ms N]"), RULE));
  // the format page's set row writes every value with a quote or a stated pattern
  const row = read(`${PS}/roadmap/references/format.md`).split("\n").find((l) => l.startsWith("| `set '<file>'"));
  for (const part of ["--status '<status>'", "--commit <commit>", "--actual <hours>", "--plan-file '<plan file>'", "--note '<note>'"]) assert.ok(row.includes(part), part);
  fails("a.md", doc("`set '<file>' '<id>' --commit <sha>`", PATTERNS, RULE), /a bare <sha> that is not on the validated list/);
  fails("a.md", doc("`set '<file>' '<id>' --commit <commit>`", "Nothing stated.", RULE), /a bare <commit> but the file does not state its pattern/);
});

test("quotes are paired left to right in three states, so a quote inside the other kind does not end it", () => {
  const cases = [
    ["a double-quoted word with an apostrophe, then a substitution", "`node zork.mjs go \"it's\" $(touch pwn) 'ok'`", /a \$ or a backtick outside single quotes/],
    ["a double-quoted word with an apostrophe, then a quoted placeholder", "`node zork.mjs go \"it's\" \"<plan>\" 'ok'`", /a double-quoted placeholder/],
    ["a double-quoted word with an apostrophe", "`node zork.mjs go \"it's\"`", /a double-quoted value/],
    ["an unbalanced single quote", "`node zork.mjs go 'a`", /an unbalanced ' quote/],
    ["an unbalanced double quote", "`node zork.mjs go \"a`", /an unbalanced " quote/],
    ["a backslash-escaped quote inside double quotes", "`node zork.mjs go \"a\\\"b\" $(x)`", /a double-quoted value/],
  ];
  for (const [what, line, expect] of cases) fails("a.md", doc(line, RULE), expect);
  // a double quote inside single quotes, and the other way round, are plain text
  passes(doc("`node zork.mjs go 'say \"hi\" <x>' 'it'`", RULE));
  passes(doc("`node zork.mjs go \"in progress\" 'a \"b\"'`", RULE));
});

test("hidden forms fail: curly quotes, entities, <code> and <pre> with attributes, <pre> blocks, indented code with a backtick, double-backtick spans", () => {
  fails("a.md", doc("`node zork.mjs go ’<a>’`", RULE), /a\.md:1: a curly quote/);
  for (let c = 0x2018; c <= 0x201e; c++) fails("a.md", doc(`\`node zork.mjs go ${String.fromCharCode(c)}x\``, RULE), /a curly quote/);
  fails("a.md", doc("`node zork.mjs go &quot;x&quot; &lt;a&gt;`", RULE), /a\.md:1: an HTML entity/);
  fails("a.md", doc("<code class=\"x\">node zork.mjs go 'a'</code>", RULE), /a\.md:1: a <code> element with attributes/);
  fails("a.md", doc("<pre class=\"x\">", "node zork.mjs go \"<a>\"", "</pre>", RULE), /a\.md:1: a <pre> element with attributes/);
  fails("a.md", doc("<pre>", "node zork.mjs go \"<a>\"", "</pre>", RULE), /a\.md:2: a double-quoted placeholder/);
  fails("a.md", doc("<pre>node zork.mjs go \"<a>\"</pre>", RULE), /a\.md:1: a double-quoted placeholder/);
  fails("a.md", doc("    node zork.mjs go '<a>' `touch pwn`", RULE), /a\.md:1: an indented code line that also holds a backtick/);
  fails("a.md", doc("`` node zork.mjs go `touch pwn` ``", RULE), /a\.md:1: a \$ or a backtick outside single quotes/);
  // an indented list item is not code, a plain <pre> and <code> and a double-backtick span with no backtick inside are fine
  passes(doc("    - `node zork.mjs go '<a>'` first", "<pre>", "node zork.mjs go '<a>'", "</pre>", "<code>node zork.mjs go '<a>'</code>", "`` node zork.mjs go '<a>' ``", RULE));
  // a <pre> block closes, and the text after it is not code
  assert.deepEqual(scriptLines(doc("<pre>", "node a.mjs x", "</pre>", "node b.mjs y")).map((l) => l.line), [2]);
});

test("every scan is linear: 32,000 repeats of the shapes that made a regex rescan the text finish at once", () => {
  const n = 32000;
  const shapes = {
    "<code>": `<code>`.repeat(n),
    "--label <label>": `\`node zork.mjs ${"--label <label> ".repeat(n)}\``,
    "<a ": `\`node zork.mjs ${"<a ".repeat(n)}\``,
    "an open <code> with a placeholder": `${"<code>".repeat(n)} node zork.mjs <x>`,
    "backtick runs of one length": `${"` ".repeat(n)}node zork.mjs`,
    "backtick runs of growing length": Array.from({ length: 400 }, (_, i) => "`".repeat(i + 1)).join(" "),
    "single quotes": `\`node zork.mjs ${"' ".repeat(n)}\``,
    "double quotes": `\`node zork.mjs ${"\" ".repeat(n)}\``,
    "placeholders after options": `\`node zork.mjs ${"--commit <commit> ".repeat(n)}\``,
    "a long fenced continuation": ["```", ...Array.from({ length: n }, () => "node zork.mjs go \\"), "x", "```"].join("\n"),
    "many rows": Array.from({ length: n }, () => "`node zork.mjs go '<a>'`").join("\n"),
    "a span left open over many rows": ["`` node zork.mjs go", ...Array.from({ length: n }, () => "node zork.mjs go '<a>' `")].join("\n"),
    "a <code> left open over many rows": Array.from({ length: n }, () => "<code>node zork.mjs go '<a>'").join("\n"),
    "<CODE> in capitals": "<CODE>".repeat(n),
    "<pre> elements in a row": `| ${"<pre>node zork.mjs x</pre> ".repeat(n)} |`,
    "open <pre> tags in a row": `| ${"<PRE>x ".repeat(n)} |`,
    "blockquote markers": `${"> ".repeat(n)}\`\`\``,
    "backslash escapes": `\`node zork.mjs ${"\\' \\| ".repeat(n)}\``,
    "%name% placeholders": `\`node zork.mjs ${"%ab %a ".repeat(n)}\``,
    "placeholders with a space or an arrow": `\`node zork.mjs ${"< a <- b -".repeat(n)}\``,
  };
  for (const [what, text] of Object.entries(shapes)) {
    const start = performance.now();
    checkCommandLines("a.md", doc(text, PATTERNS, RULE));
    const ms = performance.now() - start;
    assert.ok(ms < 3000, `${what}: ${Math.round(ms)} ms`);
  }
});

test("the rule has the empty-value and root piece, and each skill states it", () => {
  assert.ok(RULE_PIECES.includes("file-system root"));
  assert.ok(RULE_PIECES.includes("is empty"));
  const line = "`node \"${CLAUDE_SKILL_DIR}/scripts/zork.mjs\" check '<file>'`";
  assert.ok(RULE.includes(ROOT_RULE));
  fails("a.md", doc(line, RULE.replace(ROOT_RULE, "")), /missing "file-system root"/);
  // the empty value alone removed: only that piece is named
  const noEmpty = RULE.replace("empty, or is a", "");
  assert.notEqual(noEmpty, RULE);
  const ps = fails("a.md", doc(line, noEmpty), /missing "is empty"/);
  assert.equal(ps.length, 1, ps.join(" | "));
  // the whole sentence replaced by another one fails too
  fails("a.md", doc(line, RULE.replace(ROOT_RULE, "A file-system root is fine.")), /missing "is empty"/);
  for (const f of [...SKILLS, `${PS}/roadmap/references/format.md`]) assert.ok(read(f).includes("file-system root"), f);
  // each skill states the sentence word for word
  for (const f of SKILLS) assert.ok(read(f).includes(ROOT_RULE), `${f} states: ${ROOT_RULE}`);
});

test("a backslash escape outside single quotes fails; a Markdown table escape and a backslash inside single quotes pass", () => {
  const cases = [
    ["an escaped single quote", "`node zork.mjs go --root \\'<dir>\\'`"],
    ["an escaped double quote", "`node zork.mjs go \\\"<plan>\\\"`"],
    ["an escaped $", "`node zork.mjs go --root \\$HOME`"],
    ["an escaped backtick", "`` node zork.mjs go \\`date\\` ``"],
    ["in a fenced block", doc("```", "node zork.mjs go --root \\'<dir>\\'", "```")],
  ];
  for (const [what, text] of cases) {
    const ps = fails("a.md", doc(text, RULE), /a\.md:[12]: a backslash escape outside single quotes: write the value in single quotes/);
    // the escaped quote opens no quoted span, so nothing is called unbalanced
    assert.ok(!ps.some((p) => /unbalanced/.test(p)), `${what}: ${ps.join(" | ")}`);
  }
  // the escaped single quotes no longer hide the bare placeholder between them
  fails("a.md", doc("`node zork.mjs go --root \\'<dir>\\'`", RULE), /a bare <dir> that is not on the validated list/);
  // the table escape of a pipe, and backslashes inside single quotes, are fine
  passes(doc("| `restore '<file>' --from original\\|prev\\|'<name>'` | x |", "`node zork.mjs go 'a\\b' 'C:\\x' 'C:\\'`", RULE));
  // an escaped backslash escapes nothing after it: the quote that follows opens a quoted value
  passes(doc("`node zork.mjs go \\\\'<a>'`", RULE));
});

test("a code span or <code> that wraps onto the next row is one script line, reported at its first row; a blank line or a block ends it", () => {
  const lines = (text) => scriptLines(text).map(({ line, text: t }) => [line, t]);
  assert.deepEqual(lines(doc("Run `node zork.mjs go", "\"<plan>\"` now.")), [[1, "node zork.mjs go \"<plan>\""]]);
  fails("a.md", doc("Intro.", "Run `node zork.mjs go", "\"<plan>\"` now.", RULE), /a\.md:2: a double-quoted placeholder/);
  assert.deepEqual(lines(doc("Run <code>node zork.mjs go", "\"<plan>\"</code> now.")), [[1, "node zork.mjs go \"<plan>\""]]);
  fails("a.md", doc("Run <CODE>node zork.mjs go", "\"<plan>\"</CODE> now."), /a\.md:1: a double-quoted placeholder/);
  // over three rows, and the spans after the close on the last row are still found there
  assert.deepEqual(lines(doc("Run `node zork.mjs go", "--root", "'<a>'` then `node zork.mjs go \"<b>\"`.")), [[1, "node zork.mjs go --root '<a>'"], [3, "node zork.mjs go \"<b>\""]]);
  // a closed span before the open one on the first row is found once
  assert.deepEqual(lines(doc("`node zork.mjs a` and `node zork.mjs go", "'<b>'` x")), [[1, "node zork.mjs a"], [1, "node zork.mjs go '<b>'"]]);
  // a blank line ends the carry: the backtick was literal, and the next row is not part of a span
  assert.deepEqual(lines(doc("Run `node zork.mjs go", "", "\"<plan>\"` now.")), []);
  passes(doc("Run `node zork.mjs go", "", "\"<plan>\"` now."));
  // so does a block start: a fence, a <pre> or indented code
  assert.deepEqual(lines(doc("Run `node zork.mjs go", "```", "\"<plan>\"` x", "```")), []);
  assert.deepEqual(lines(doc("Run `node zork.mjs go", "<pre>", "x", "</pre>", "\"<plan>\"` x")), []);
  assert.deepEqual(lines(doc("Run <code>node zork.mjs go", "    x", "\"<plan>\"</code> x")), []);
  // a backtick left open at the end of the document is literal text
  assert.deepEqual(lines("Run `node zork.mjs go \"<plan>\""), []);
  // a fence between the rows ends the carry even when the fence closes before the next text row
  assert.deepEqual(lines(doc("Run `node zork.mjs go", "```", "x", "```", "\"<plan>\"` x")), []);
});

test("a stray backtick does not hide the command lines after it: the carry only adds, and a heading, a rule, a table row or a list item ends it", () => {
  const lines = (text) => scriptLines(text).map(({ line, text: t }) => [line, t]);
  const bad = "run `node zork.mjs go --root \"<p>\"` then.";
  const cell = "| b | `node zork.mjs go \"<p>\"` |";
  // each one is what the checker before the carry reported
  for (const [text, at, t] of [
    [doc("A value with a ` is refused, and", bad), 2, "node zork.mjs go --root \"<p>\""],
    [doc("A value with a ` is refused,", "and so on, and", bad), 3, "node zork.mjs go --root \"<p>\""],
    [doc("| a | the ` character |", cell), 2, "node zork.mjs go \"<p>\""],
    [doc("- a ` b", "- `node zork.mjs go \"<p>\"`"), 2, "node zork.mjs go \"<p>\""],
    [doc("A stray ` here.", "## Run", bad), 3, "node zork.mjs go --root \"<p>\""],
    [doc("A stray ` here.", "---", bad), 3, "node zork.mjs go --root \"<p>\""],
  ]) {
    assert.deepEqual(lines(text), [[at, t]], text);
    const ps = fails("a.md", text, new RegExp(`^a\\.md:${at}: a double-quoted placeholder`));
    assert.equal(ps.length, 1, ps.join(" | "));
  }
  // a heading, a thematic break, a table row or a list item is not joined to the span before it
  for (const next of ["# Head \"<plan>\"` x", "***", "| \"<plan>\"` x |", "- \"<plan>\"` x", "1. \"<plan>\"` x"]) {
    const rows = next === "***" ? ["Run `node zork.mjs go", next, "\"<plan>\"` x"] : ["Run `node zork.mjs go", next];
    assert.deepEqual(lines(doc(...rows)), [], next);
  }
  // a span the row reads on its own, and the joined text reads again, is reported once
  assert.deepEqual(lines(doc("Run ``node zork.mjs go", "`node zork.mjs b` x")), [[2, "node zork.mjs b"]]);
});

test("intended trade-off: unquoted redirection, an a < b && c > d test and a %d%m%Y_%H%M%S% format on a script line fail like a bare placeholder", () => {
  fails("a.md", "`node zork.mjs go < in.txt > out.txt`", /a\.md:1: a bare < in\.txt > that is not on the validated list/);
  fails("a.md", "`node zork.mjs go; test a < b && c > d`", /a\.md:1: a bare < b && c > that is not on the validated list/);
  fails("a.md", "`node zork.mjs go --at %d%m%Y_%H%M%S%`", /a\.md:1: a %name% placeholder/);
});

test("placeholder forms beyond <name> fail when bare: %name%, a digit, _, - or a space first, <...>, and text glued after an allowed one", () => {
  for (const name of ["2plan", "_plan", "-plan", " plan ", "...", "…"]) {
    fails("a.md", doc(`\`node zork.mjs go --root <${name}>\``, RULE), new RegExp(`a\\.md:1: a bare <${esc(name)}> that is not on the validated list`));
  }
  fails("a.md", doc("`node zork.mjs go --root %plan%`", RULE), /a\.md:1: a %name% placeholder, write it in single quotes/);
  fails("a.md", doc("`node zork.mjs go --label <label>x`", PATTERNS), /a\.md:1: a bare <label> with text glued after it, write it in single quotes/);
  fails("a.md", doc("`node zork.mjs go --commit <commit>'x'`", PATTERNS, RULE), /a\.md:1: a bare <commit> with text glued after it/);
  // the single-quoted forms pass, and so do an allowed placeholder before a space, a bracket or the end
  passes(doc("`node zork.mjs go --root '<2plan>' '<_plan>' '<-plan>' '< plan >' '<...>' '<…>' '%plan%' --label '<label>x'`", "`[--table <index>]...` and `node zork.mjs --label <label> --commit <commit>`", PATTERNS, RULE));
  // not placeholders: a heredoc, a redirect from a numbered descriptor, arrows, a date format, and bare words
  passes(doc("```", "node zork.mjs go <<end > out.txt", "node zork.mjs go 2<in.txt >out.txt", "```", "`node zork.mjs go --day %Y%m%d`", "`--plans a <- b -> c`", "Prose: plan <- run -> ship."));
  passes("`node zork.mjs go --x ... Plan plan_file ~ * @ #`");
  // glued on either side, or ending in - or =: still a placeholder
  fails("a.md", doc("`node zork.mjs go --label v1<label>`", PATTERNS), /a\.md:1: a bare <label> that does not follow --label/);
  for (const [line, name] of [["`node zork.mjs go --out run-2<suffix>`", "suffix"], ["`node zork.mjs go --x <plan->`", "plan-"], ["`node zork.mjs go --x <plan=>`", "plan="]]) {
    fails("a.md", line, new RegExp(`a\\.md:1: a bare <${esc(name)}> that is not on the validated list`));
  }
  // <= and <- open no placeholder even with a > later on the line, and an HTML comment is not one
  passes(doc("`node zork.mjs go --x <= 3 > --y <- a >`", "`node zork.mjs go <!-- note -->`"));
});

test("fences and <pre> only where Markdown makes them: a one-line fence, <pre> in prose, a span or a cell, capitals, a blockquote", () => {
  const lines = (text) => scriptLines(text).map(({ line, text: t }) => [line, t]);
  const bad = "node zork.mjs go \"<b>\"";
  const badSpan = `Run \`${bad}\`.`;
  // a ``` with a backtick in its info string is an inline span, not a fence that never closes
  assert.deepEqual(lines(doc("```node zork.mjs go \"<plan>\"```", badSpan)), [[1, "node zork.mjs go \"<plan>\""], [2, bad]]);
  fails("a.md", doc("```node zork.mjs go \"<plan>\"```", RULE), /a\.md:1: a double-quoted placeholder/);
  // a bare <pre> in prose is not a block
  assert.deepEqual(lines(doc("Use a <pre> element in HTML.", badSpan)), [[2, bad]]);
  // nor is a <pre> inside a code span
  assert.deepEqual(lines(doc("Write a `<pre>` block.", badSpan)), [[2, bad]]);
  // a <pre> in a table cell is checked, and so are the other cells
  assert.deepEqual(lines(`| <pre>node zork.mjs go '<a>'</pre> | \`${bad}\` |`), [[1, "node zork.mjs go '<a>'"], [1, bad]]);
  fails("a.md", doc(`| <pre>node zork.mjs go '<a>'</pre> | \`${bad}\` |`, RULE), /a\.md:1: a double-quoted placeholder/);
  fails("a.md", doc("| <pre class=\"x\">node zork.mjs go '<a>'</pre> |", RULE), /a\.md:1: a <pre> element with attributes/);
  // capitals: </PRE> closes the block, <CODE> is checked
  assert.deepEqual(lines(doc("<PRE>", "node zork.mjs go '<a>'", "</PRE>", badSpan)), [[2, "node zork.mjs go '<a>'"], [4, bad]]);
  assert.deepEqual(lines("<CODE>node zork.mjs go \"<a>\"</CODE>"), [[1, "node zork.mjs go \"<a>\""]]);
  fails("a.md", "<CODE>node zork.mjs go \"<a>\"</CODE>", /a\.md:1: a double-quoted placeholder/);
  // a fence and indented code inside a blockquote
  assert.deepEqual(lines(doc("> ```", "> node zork.mjs go \"<a>\"", "> ```", "Run `node zork.mjs go '<b>'`.")), [[2, "node zork.mjs go \"<a>\""], [4, "node zork.mjs go '<b>'"]]);
  fails("a.md", doc("> Note:", ">", ">     node zork.mjs go \"<a>\""), /a\.md:3: a double-quoted placeholder/);
  // a fence opened in a blockquote ends with the blockquote: the rows after it are read as before
  assert.deepEqual(lines(doc("> ```", "> x", "", "Use `read \"<p>\" now`.", "<code>check \"<q>\"</code>")), [[4, "read \"<p>\" now"], [5, "check \"<q>\""]]);
  // a <pre> with no </pre> in a cell: the rest of the row is a block line; in prose it runs no script and is ignored
  assert.deepEqual(lines("| <pre>node zork.mjs go \"<p>\" | x |"), [[1, "node zork.mjs go \"<p>\" | x |"]]);
  fails("a.md", "| <pre>node zork.mjs go \"<p>\" | x |", /a\.md:1: a double-quoted placeholder/);
  assert.deepEqual(lines(doc("Prose with a <pre> tag in it.", "node zork.mjs go \"<p>\"")), []);
  // a <PRE> element in capitals inside a cell is read too
  assert.deepEqual(lines("| <PRE>node zork.mjs go '<a>'</PRE> | x |"), [[1, "node zork.mjs go '<a>'"]]);
  // <codex> is another tag, not <code>
  assert.deepEqual(lines("<codex>node zork.mjs go \"<a>\"</code>"), []);
  // still fences: an info string with no backtick, a ~~~ fence with one; a > line in a plain fence is kept as it is
  assert.deepEqual(lines(doc("```sh", bad, "```", "~~~ `x`", "node a.mjs go", "~~~", "```", "> node zork.mjs x", "```")), [[2, bad], [5, "node a.mjs go"], [8, "> node zork.mjs x"]]);
});

test("mutation proof on the real docs: the new rules catch their forms in real lines", () => {
  const mutate = (f, from, to) => {
    const text = read(f);
    assert.ok(text.includes(from), `${f} has ${from}`);
    const out = text.replace(from, to);
    assert.notEqual(out, text);
    return out;
  };
  const at = (f, from) => read(f).split("\n").findIndex((l) => l.includes(from)) + 1;
  const format = `${PS}/roadmap/references/format.md`;
  const restore = "--from original\\|prev\\|'<name>'";
  fails(format, mutate(format, restore, "--from original\\|prev\\|\\'<name>\\'"), new RegExp(`^${esc(format)}:${at(format, restore)}: a backslash escape outside single quotes`));
  fails(format, mutate(format, "--commit <commit>", "--commit <commit>x"), new RegExp(`^${esc(format)}:${at(format, "--commit <commit>")}: a bare <commit> with text glued after it`));
  fails(format, mutate(format, "--note '<note>'", "--note %note%"), /a %name% placeholder/);
  // a real span wrapped onto the next row with its path double-quoted is reported at the row it opens on
  for (const f of SKILLS) {
    const lines = read(f).split("\n");
    const i = lines.findIndex((l) => /`[^`\n]*(?:\.mjs|--)[^`\n]* '<[^'>]*>'/.test(l));
    assert.ok(i >= 0, `${f} has a span with a single-quoted placeholder`);
    lines[i] = lines[i].replace(/ '(<[^'>]*>)'/, '\n"$1"');
    fails(f, lines.join("\n"), new RegExp(`^${esc(f)}:${i + 1}: a double-quoted placeholder`));
  }
});
