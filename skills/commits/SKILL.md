---
name: commits
description: Conventional Commits format, types, scopes and splitting rules. Run /commits when writing a commit message or deciding how to split commits.
argument-hint: "[optional: describe the change to get a suggested commit message]"
disable-model-invocation: true
license: MIT
metadata:
  title: "Conventional Commits"
  tags: "git,commits"
  featured: "false"
  order: "8"
  version: "1.1.0"
---

# Skill: Conventional Commits

Follow the repository's own CLAUDE.md for attribution. Add no attribution trailers (such as `Co-Authored-By`) unless asked, and never commit or push unless asked.

## Format

```
<type>[(scope)][!]: <description>

[optional body]

[optional footer(s)]
```

## Types

| Type | When to use |
|------|-------------|
| `feat` | New feature or new route |
| `fix` | Bug fix |
| `refactor` | Code restructure with no behavior change |
| `perf` | Performance improvement |
| `style` | Formatting only (whitespace, semicolons), no change in meaning. Visual or CSS changes are `feat` or `fix` |
| `chore` | Config, tooling, housekeeping |
| `docs` | Documentation, README, spec updates |
| `test` | Adding or updating tests |
| `build` | Build system, dependencies, build scripts |
| `ci` | CI/CD pipeline changes |
| `revert` | Reverts an earlier commit; name it in the body (`This reverts commit <hash>.`) |

These eleven types are the default `type-enum` of `@commitlint/config-conventional`, which is also the source for the `style` wording. The Conventional Commits specification itself requires only `feat` and `fix` and allows other types. A repository that overrides `type-enum` replaces the whole list, so a custom type must be added together with all eleven.

Release tools read the type. With semantic-release's default rules, `feat` makes a minor release, `fix`, `perf` and revert commits make a patch release and a breaking change makes a major release (the default preset reads a breaking change from the `BREAKING CHANGE:` footer). `docs`, `chore`, `refactor`, `style`, `test`, `build` and `ci` make no release unless the repository adds `releaseRules`. A security fix that must be released should therefore be a `fix`.

## Scopes

Use the layer or module that changed. Common examples:

| Scope | Meaning |
|-------|---------|
| `api` | Backend / server-side changes |
| `web` | Frontend / client-side changes |
| `db` | Schema, migration, or query changes |
| `auth` | Auth middleware or session logic |
| `config` | Configuration or environment changes |
| `shared` | Shared types, utilities, packages |

Adapt scopes to match the project's folder structure.

## Examples

```
feat(api): add archive endpoint for items
fix(web): correct filter pill overflow on mobile
refactor(web): extract EditItemModal from SettingsPage
feat(db): add archivedAt column to items table
docs: update README with deploy instructions
test(api): add integration tests for archive endpoint
perf(web): memoize derived item totals with useMemo
```

A security fix is a `fix` with a `Security:` footer:

```
fix(api): add ownership filter to item route

Security: users could read items owned by other users.
```

## Rules

- Description starts with a **lowercase letter** (identifiers keep their spelling), **imperative mood, no trailing period**: `add`, `fix`, `extract`, `remove`
- Aim for a short header: Git's own guidance is a soft limit of 50 characters for the summary line. If the repository runs commitlint, its limit applies (`@commitlint/config-conventional` allows a header of 100 characters)
- Put a blank line before the body and before the footers
- Multi-package change → see "When to split commits" below
- Breaking changes → add `!` after the scope: `feat(api)!: change response shape`
- A `BREAKING CHANGE: <what breaks and how to migrate>` footer marks the same thing and can carry the details; write it whenever a release tool reads the commits, because semantic-release's default preset did not recognise a header `!` on its own (see Limitations)
- DB migrations → use the type of the change the migration supports: a feature → `feat`, an index for speed → `perf`, pure infrastructure → `chore(db)`
- Security fixes → `fix(scope):` with a `Security:` footer (the footer is this skill's convention); add `!` and a `BREAKING CHANGE:` footer if the fix breaks compatibility

## When to split commits

Split into separate commits only when each commit builds and passes tests on its own. Otherwise make one commit with the primary scope and list the other scopes in the body.

Typical splits, when each part stands alone:

- API change + frontend change (two separate scopes)
- Schema migration + route change (an additive migration goes first, as its own commit)
- Refactor + bug fix in the same file (keeps history clean and bisectable)
- New feature + new tests (or combine only if small)

## If an argument is provided

Generate a suggested commit message for the described change. Ask clarifying questions only if the scope or type is ambiguous. If the argument still shows as an unreplaced placeholder (a dollar sign followed by the word ARGUMENTS), treat it as not provided (see Limitations).

## Limitations

- These instructions guide behavior; nothing enforces them. A repository's own commit rules (commitlint configuration, CLAUDE.md) take precedence.
- Some rules are this skill's own conventions, and no source below states them: the `Security:` footer (not part of the specification), "visual or CSS changes are `feat` or `fix`", and the lowercase, imperative, no-trailing-period description. The specification gives no definition of `style`; the wording comes from the commitlint preset.
- Git's `git-commit` and `SubmittingPatches` pages state no width for the body. Wrapping it at about 72 columns is a common convention only, so this skill gives no wrap rule.
- The release effect of a type holds for semantic-release's default rules (commit-analyzer 13.0.1). A repository can add `releaseRules`, and other release tools can differ. That a header `!` alone triggers no release in the default preset (a `BREAKING CHANGE:` footer gives a major release) was observed by running `commit-analyzer` 13.0.1 with `conventional-changelog-angular` 9.4.0; their documentation does not state it, and a newer preset may differ.
- Argument substitution (a placeholder written as a dollar sign followed by the word ARGUMENTS) is documented for Claude Code. The open skill standard that Claude Code's skills follow does not define it, so other tools may not substitute it; no source says which tools do. That is why an unreplaced placeholder is treated as not provided. The placeholder is not written out in this file, because Claude Code would replace it with the user's text.
- Version numbers and download counts are as of the access date and change.

## Sources

Accessed 2026-11-07.

- Conventional Commits 1.0.0, the primary specification: only `feat` and
  `fix` are defined, other types are allowed, scope is optional, a breaking
  change is marked with `!` before the colon or a `BREAKING CHANGE:` footer,
  and a blank line separates the description, body and footers.
  https://www.conventionalcommits.org/en/v1.0.0/
- commitlint, `@commitlint/config-conventional` 21.2.4: the `type-enum` list
  (the eleven types above, no `security`), a `header-max-length` of 100, and
  the description of `style` as changes that do not affect the meaning of the
  code (white-space, formatting, missing semi-colons). Adoption: 15,313,730 npm
  downloads in the week 2026-10-30 to 2026-11-05 (api.npmjs.org). The npm page
  could not be fetched, and it does not show the `style` wording; that wording
  and the list were read from the published files of this package version
  (the package's own README and prompt text), and are not stated on a page a
  reader can open at this address.
  https://www.npmjs.com/package/@commitlint/config-conventional
- commitlint, *Configuration*: rules set in a project override the rules of
  the extended preset, and an override of `type-enum` replaces the list instead
  of adding to it.
  https://commitlint.js.org/reference/configuration.html
- commitlint, *Rules*: `header-max-length` means the header has `value` or
  fewer characters. The 72 on that page is an illustrative value, not the
  preset's.
  https://commitlint.js.org/reference/rules.html
- semantic-release documentation: its default commit analysis maps `fix` to a
  patch release, `feat` to a minor release and a `BREAKING CHANGE:` footer to a
  major release. Adoption: 4,211,763 npm downloads in the same week.
  https://semantic-release.gitbook.io/semantic-release/#commit-message-format
- `@semantic-release/commit-analyzer` 13.0.1: the default release rules also
  make `perf` a patch release, and a commit that matches no rule gets no
  release type.
  https://www.npmjs.com/package/@semantic-release/commit-analyzer
- Git, `git-commit` documentation: "Though not required, it's a good idea to
  begin the commit message with a single short (no more than 50 characters)
  line summarizing the change, followed by a blank line".
  https://git-scm.com/docs/git-commit
- Git, `SubmittingPatches`: the first line should be a short description, with
  50 characters as the soft limit.
  https://git-scm.com/docs/SubmittingPatches
- Claude Code documentation, *Skills*: `argument-hint` is the autocomplete
  hint, and an argument placeholder in the skill text is replaced with all
  arguments passed when the skill is invoked. The page says Claude Code skills
  follow an open standard and extend it; that standard's specification page
  lists no such placeholder, so substitution in other tools is not specified.
  https://code.claude.com/docs/en/skills
