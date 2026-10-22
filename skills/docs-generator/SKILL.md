---
name: docs-generator
description: Create and update project documentation — flowcharts (Mermaid), TDD, FRD, user guides, API docs, ERDs, architecture diagrams, changelogs, and release notes. TRIGGER when the user asks to create, update, or generate any documentation.
argument-hint: "[doc type: flowchart|tdd|frd|user-guide|api|erd|architecture|changelog|release-notes]"
disable-model-invocation: true
license: MIT
metadata:
  title: "Docs Generator"
  tags: "docs,diagrams,changelog"
  featured: "false"
  order: "3"
  version: "1.0.0"
---

# Skill: Documentation Generator

Create, update, and maintain all project documentation in Markdown under `docs/`.

---

## Folder Structure

```
docs/
  flowcharts/          # Mermaid-based flow diagrams
  tdd/                 # Technical Design Documents
  frd/                 # Functional Requirements Documents
  user-guides/         # End-user guides and walkthroughs
  api/                 # API endpoint documentation
  erd/                 # Entity Relationship Diagrams
  architecture/        # Architecture diagrams and overviews
  changelog/           # CHANGELOG.md (single file, append-style)
  release-notes/       # Per-release notes (e.g., v1.2.0.md)
```

Create subfolders on first use. Do NOT dump all docs in a flat `docs/` root.

---

## Before Writing Any Doc

Reflect the **actual codebase**, not assumptions. Before writing:

1. **Read the schema** — the DB schema file is the source of truth for tables and columns.
2. **Read relevant routes** — scan backend route files for endpoints, request/response shapes, middleware.
3. **Read relevant pages/components** — scan frontend pages for UI flows.
4. **Check existing docs** — read the target file first if it exists; update in place, don't overwrite.

Zero hallucinated details. Every table name, column, endpoint, and component must come from code you actually read.

---

## Doc Type Templates

### 1. Flowchart (`docs/flowcharts/<feature-name>.md`)

```markdown
# <Feature Name> — Flow

## Overview
Brief one-liner on what this flow covers.

## Diagram

` ``mermaid
flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action]
    B -->|No| D[Other Action]
    C --> E[End]
    D --> E
` ``

## Notes
- Any edge cases, gotchas, or branching logic worth calling out.
```

---

### 2. TDD — Technical Design Document (`docs/tdd/<feature-name>.md`)

```markdown
# TDD: <Feature Name>

## 1. Context & Problem
Why this feature exists. What problem it solves.

## 2. Goals & Non-Goals
| Goals | Non-Goals |
|-------|-----------|
| ...   | ...       |

## 3. Architecture Overview
` ``mermaid
flowchart LR
    Client --> API --> DB[(Database)]
` ``

## 4. Data Model
Tables involved, new columns/tables if any.

| Table | Column | Type | Notes |
|-------|--------|------|-------|
| ...   | ...    | ...  | ...   |

## 5. API Changes
New or modified endpoints with request/response shapes.

## 6. Frontend Changes
Pages, components, modals affected. Key state flows.

## 7. Sequence Diagram
` ``mermaid
sequenceDiagram
    User->>+Web: Action
    Web->>+API: POST /endpoint
    API->>+DB: INSERT
    DB-->>-API: OK
    API-->>-Web: 200 response
    Web-->>-User: Success feedback
` ``

## 8. Edge Cases & Risks

## 9. Migration Plan (if schema changes needed)
```

---

### 3. FRD — Functional Requirements Document (`docs/frd/<feature-name>.md`)

```markdown
# FRD: <Feature Name>

## 1. Overview

## 2. Background & Motivation

## 3. Scope
### In Scope
### Out of Scope

## 4. Functional Requirements

### FR-1: <Requirement Title>
**Description:** ...
**Acceptance Criteria:**
- [ ] ...

## 5. User Stories
| # | As a... | I want to... | So that... |
|---|---------|-------------|------------|

## 6. UI/UX Requirements

## 7. Data Requirements

## 8. Dependencies

## 9. Open Questions
```

---

### 4. User Guide (`docs/user-guides/<feature-name>.md`)

Plain language, no code blocks unless showing UI text.

```markdown
# <Feature Name> — User Guide

## What is <Feature>?

## How to Use It

### Step 1: <Action>

### Step 2: <Action>

## Tips

## FAQ

## Troubleshooting
| Problem | Solution |
|---------|----------|
```

---

### 5. API Docs (`docs/api/<domain>.md`)

Generate from actual route files. Group by domain.

```markdown
# API: <Domain>

## Endpoints

### `POST /endpoint`
**Auth:** Required
**Description:** What it does.

**Request Body:**
` ``json
{ "field": "type" }
` ``

**Response (200):**
` ``json
{ "success": true, "data": {} }
` ``

**Errors:**
| Code | Message | When |
|------|---------|------|
| 400  | ...     | ...  |
| 401  | ...     | ...  |
```

---

### 6. ERD (`docs/erd/<scope>.md`)

Use Mermaid `erDiagram` syntax. Generate from actual schema files.

```markdown
# ERD: <Scope>

## Diagram

` ``mermaid
erDiagram
    USERS ||--o{ ITEMS : has
    ITEMS }o--|| CATEGORIES : "categorized by"
` ``

## Table Details

### items
| Column | Type | Notes |
|--------|------|-------|
| id     | TEXT | PK    |
```

---

### 7. Architecture Diagram (`docs/architecture/<topic>.md`)

```markdown
# Architecture: <Topic>

## Diagram

` ``mermaid
flowchart TB
    subgraph Client
        Web[Frontend SPA]
    end
    subgraph Backend
        API[API Server]
        DB[(Database)]
    end
    Web -->|fetch| API
    API --> DB
` ``

## Components
Brief description of each box and its responsibility.
```

---

### 8. Changelog (`docs/changelog/CHANGELOG.md`)

Single file, newest entries at the top. [Keep a Changelog](https://keepachangelog.com) format.

```markdown
# Changelog

## [Unreleased]

### Added
### Changed
### Fixed

---

## [YYYY-MM-DD]

### Added
- <Feature description>

### Fixed
- <Bug fix description>
```

When updating: read git log and recent completed tasks, then append to `[Unreleased]`.

---

### 9. Release Notes (`docs/release-notes/<version-or-date>.md`)

User-facing summary. Less technical than changelog.

```markdown
# Release Notes — <Version or Date>

## Highlights

## New Features
- **<Feature>:** Plain-language description.

## Improvements

## Bug Fixes

## Known Issues
```

---

## Update Rules

- **Changelogs / release notes** — update after every major feature ship or significant bug fix.
- **API docs** — update whenever a route is added, changed, or removed.
- **ERDs** — update whenever the schema changes.
- **TDDs / FRDs** — mark as "Implemented" in the header once shipped.
- When updating an existing doc, **read it first** and surgically update — don't rewrite unless asked.

## Naming Conventions

- kebab-case filenames: `budget-allocation.md`, not `BudgetAllocation.md`
- Release notes: use date or version (`2026-04-16.md`, `v2.1.0.md`)

## Quality Checklist

```
□ All table/column names match the actual schema
□ All endpoints match actual route files
□ Mermaid diagrams have valid syntax
□ No "TBD" or "TODO" placeholders — fill or mark as Open Question
□ New docs linked from docs/README.md (if one exists)
```
