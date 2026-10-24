// Frontmatter rules shared by the root items and the plugin items. Used by lint.mjs.
// Field lists and values come from the Claude Code docs (read 2026-10-24):
//   https://code.claude.com/docs/en/sub-agents and https://code.claude.com/docs/en/skills
// The lists grow between releases, so an unknown key only warns; a wrong value still fails.

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Agent `model:` aliases the subagent docs list. `best` is a session alias, not listed for subagents.
const AGENT_MODELS = new Set(["opus", "sonnet", "haiku", "fable", "inherit"]);
// Skill `model:` takes the same aliases plus `best` (valid for /model).
const SKILL_MODELS = new Set([...AGENT_MODELS, "best"]);
// Documented effort levels.
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Subagent frontmatter fields. metadata and license are this repo's own convention, so they're accepted.
const AGENT_KEYS = new Set([
  "name", "description", "tools", "disallowedTools", "model", "permissionMode", "maxTurns", "autoCompactWindow",
  "skills", "mcpServers", "hooks", "memory", "background", "omitClaudeMd", "effort", "isolation", "color",
  "initialPrompt", "experimental", "metadata", "license",
]);
// Skill frontmatter fields.
const SKILL_KEYS = new Set([
  "name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable",
  "allowed-tools", "disallowed-tools", "model", "effort", "context", "agent", "background", "hooks", "paths", "shell",
  "metadata", "license", "compatibility",
]);
// Plugin subagents ignore these fields, so having them would look like protection while doing nothing.
const PLUGIN_AGENT_IGNORED = ["hooks", "mcpServers", "permissionMode", "initialPrompt"];
const META_KEYS = ["title", "tags", "featured", "order", "version"];

export function makeRules({ fail, warn }) {
  // Real YAML rejects some plain scalars that the lenient parser accepts, and Claude Code then
  // drops every frontmatter field silently. Catch the common causes: ": " or " #" inside an
  // unquoted value, or a value that starts with a YAML indicator.
  function checkYaml(where, text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return;
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^\s*([A-Za-z][\w-]*):\s+(.+)$/);
      if (!kv) continue;
      const v = kv[2].trim();
      if (/^["'[{|>]/.test(v)) continue;
      if (/^[*&!%@`]/.test(v)) fail(where, `frontmatter "${kv[1]}" starts with a YAML indicator; quote the value`);
      else if (/: |\s#/.test(v)) fail(where, `frontmatter "${kv[1]}" has an unquoted ": " or " #"; wrap the value in double quotes`);
    }
  }

  // The metadata block and license are required on root items only.
  function checkMeta(where, data, withLicense) {
    if (!data) return fail(where, "missing frontmatter");
    const md = data.metadata;
    if (!md || typeof md !== "object") fail(where, "missing metadata block");
    else for (const k of META_KEYS) if (!md[k]) fail(where, `metadata.${k} is missing`);
    if (md?.featured && !["true", "false"].includes(md.featured)) fail(where, 'metadata.featured must be "true" or "false"');
    if (md?.order && !/^\d+$/.test(md.order)) fail(where, "metadata.order must be a whole number");
    if (withLicense && data.license !== "MIT") fail(where, "license must be MIT");
  }

  function checkDescription(where, d) {
    if (!d) return fail(where, "description is missing");
    if (d.length > 1024) fail(where, `description is ${d.length} characters (max 1024)`);
  }

  // effort, maxTurns and unknown keys, the same for agents and skills.
  function checkCommon(where, data, keys) {
    if (data.effort !== undefined && !EFFORTS.has(data.effort)) fail(where, `effort "${data.effort}" must be one of ${[...EFFORTS].join(", ")}`);
    if (data.maxTurns !== undefined && !/^[1-9]\d*$/.test(String(data.maxTurns))) fail(where, `maxTurns "${data.maxTurns}" must be a positive whole number`);
    for (const k of Object.keys(data)) if (!keys.has(k)) warn(where, `unknown frontmatter field "${k}" (ignored by Claude Code; a typo?)`);
  }

  // data is the parsed frontmatter, slug the file name without .md.
  function checkAgent(where, data, slug, { plugin = false } = {}) {
    if (data.name !== slug) fail(where, `name "${data.name}" must match the file name`);
    if (typeof data.name === "string" && data.name.includes(":")) fail(where, 'agent name must not contain ":"');
    checkDescription(where, data.description);
    if (data.model === "best") warn(where, 'model "best" is not listed for subagent frontmatter; use fable or opus');
    else if (!AGENT_MODELS.has(data.model)) fail(where, `model "${data.model}" must be an alias (${[...AGENT_MODELS].join(", ")})`);
    checkCommon(where, data, AGENT_KEYS);
    if (plugin) {
      for (const k of PLUGIN_AGENT_IGNORED) if (k in data) fail(where, `"${k}" is ignored in plugin agents; remove it`);
    }
  }

  function checkSkill(where, data, slug) {
    if (data.name !== slug) fail(where, `name "${data.name}" must match the folder "${slug}"`);
    checkDescription(where, data.description);
    if (data.model !== undefined && !SKILL_MODELS.has(data.model)) fail(where, `model "${data.model}" must be an alias (${[...SKILL_MODELS].join(", ")})`);
    checkCommon(where, data, SKILL_KEYS);
    if ("allowed-tools" in data) warn(where, '"allowed-tools" pre-approves those tools for the turn; confirm that is intended');
  }

  return { checkYaml, checkMeta, checkAgent, checkSkill };
}
