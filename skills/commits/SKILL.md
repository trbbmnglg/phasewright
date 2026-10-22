---
name: commits
description: Conventional Commits format, types, scopes, and splitting rules. TRIGGER when writing a git commit message or deciding how to split commits.
argument-hint: "[optional: describe the change to get a suggested commit message]"
disable-model-invocation: true
license: MIT
metadata:
  title: "Conventional Commits"
  tags: "git,commits"
  featured: "false"
  order: "8"
  version: "1.0.0"
---

# Skill: Conventional Commits

## Format

```
<type>(<scope>): <description>

[optional body]
[optional footer]
```

## Types

| Type | When to use |
|------|-------------|
| `feat` | New feature or new route |
| `fix` | Bug fix |
| `refactor` | Code restructure with no behavior change |
| `perf` | Performance improvement |
| `style` | UI/CSS changes only, no logic |
| `chore` | Deps, config, tooling, build scripts |
| `docs` | Documentation, README, spec updates |
| `test` | Adding or updating tests |
| `security` | Security fix or hardening |
| `ci` | CI/CD pipeline changes |

## Scopes

Use the layer or module that changed. Common examples:

| Scope | Meaning |
|-------|---------|
| `api` | Backend / server-side changes |
| `web` or `ui` | Frontend / client-side changes |
| `db` | Schema, migration, or query changes |
| `auth` | Auth middleware or session logic |
| `config` | Configuration or environment changes |
| `ci` | Build, deploy, pipeline |
| `shared` | Shared types, utilities, packages |

Adapt scopes to match the project's folder structure.

## Examples

```
feat(api): add loan forgiveness endpoint
fix(ui): correct filter pill overflow on mobile
refactor(web): extract EditAccountModal from SavingsPage
chore(db): add forgivenAt column to loans table
security(api): add ownership filter to resource route
docs: update README with deploy instructions
test(api): add integration tests for forgive endpoint
perf(ui): memoize derived expense totals with useMemo
```

## Rules

- Description is **lowercase, imperative mood, no trailing period**: `add`, `fix`, `extract`, `remove`
- Keep description under **72 characters**
- Multi-package change → use the primary scope; list others in the body
- Breaking changes → add `!` after scope: `feat(api)!: change response shape`
- DB migrations → always `chore(db):` — never `feat` (they're infrastructure)
- Security fixes → always `security:` — never buried under `fix`

## When to split commits

Split into multiple commits when:

- API change + frontend change (two separate scopes)
- Schema migration + route change (migration is a separate commit)
- Refactor + bug fix in the same file (keeps history clean and bisectable)
- New feature + new tests (or combine only if small)

## If `$ARGUMENTS` is provided

Generate a suggested commit message for the described change. Ask clarifying questions only if the scope or type is ambiguous.
