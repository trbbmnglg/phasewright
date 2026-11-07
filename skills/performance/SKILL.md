---
name: performance
description: Frontend and API performance patterns — measuring first, useCallback and useMemo only where they pay off, Promise.all, pagination, batch inserts. The frontend sections are React; the API examples use Hono and Drizzle, and the rules apply to other stacks. TRIGGER when optimizing renders, parallel fetches, waterfall queries, or slow pages.
license: MIT
metadata:
  title: "Performance Patterns"
  tags: "performance,react,api"
  featured: "false"
  order: "7"
  version: "1.1.0"
---

# Skill: Performance Optimization

The frontend sections (1-8) are React. The API sections (9-13) use Hono handlers and Drizzle queries as examples; the rules apply to other stacks. Sections 10 and 11 rely on SQLite and Cloudflare D1 behavior and say so. Snippets assume names such as `api`, `db`, `schema`, `eq` and `userId` are already in scope.

---

## Step 0 — Measure First

Profile before changing anything, and compare the numbers before and after:
- React renders: the React Profiler (in React DevTools)
- Page load and interaction: the browser's performance panel
- Database: the query plan (`EXPLAIN` or `EXPLAIN QUERY PLAN`, depending on the engine)

Optimize what the measurement shows. The patterns below are the usual fixes, not a to-do list.

---

## Frontend

### 1. AbortController on Every Fetch

Every `useEffect` that fetches data must abort its request on cleanup. (React's docs accept aborting or ignoring the stale result; this skill standardizes on aborting, plus a `signal.aborted` check before each `setState`.) The full pattern, including the abort-versus-timeout handling and the loading-flag guard, is in the `error-handling` skill under "Frontend — AbortController"; use it there instead of copying it, so the two cannot drift.

**Flag:** Any `useEffect` with an async fetch that does NOT have `return () => controller.abort()`.

---

### 2. useCallback — Only Where a Stable Function Matters

Wrap a handler in `useCallback` only when it is passed to a component wrapped in `memo`, or is a dependency of a hook (`useEffect`, `useMemo`, another `useCallback`). Measure first (React Profiler); otherwise leave it as a plain function.

**React Compiler:** React Compiler 1.0 has been stable since 2025-10-07. It supports React 17, 18 and 19 (17 and 18 need a `target` setting and the `react-compiler-runtime` package) and automatically applies the equivalent of manual memoization to components and hooks. It is optional. With it on, rely on it for new code and keep `useMemo`/`useCallback` as an escape hatch for precise control, for example for effect dependencies. Leave existing `useMemo`/`useCallback` in place unless you have tested removing them, because removal can change the compiler's output.

```tsx
import { memo, useCallback, useState } from "react";

type Item = { id: string; label: string };
type RowProps = { item: Item; selected: boolean; onSelect: (id: string) => void };

const Row = memo(function Row({ item, selected, onSelect }: RowProps) {
  return (
    <li className={selected ? "font-bold" : ""} onClick={() => onSelect(item.id)}>
      {item.label}
    </li>
  );
});

export function List({ items }: { items: Item[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Worth it: Row is memoized, so a stable onSelect lets it skip re-rendering
  // when only the selection changes. Without useCallback, every render of List
  // creates a new function and defeats memo.
  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  return (
    <ul>
      {items.map((item) => (
        <Row key={item.id} item={item} selected={item.id === selectedId} onSelect={handleSelect} />
      ))}
    </ul>
  );
}

// Not worth it: Button is not memoized, so a plain inline handler is fine
// <Button onClick={() => setOpen(true)}>Add</Button>
```

---

### 3. useMemo — For Expensive Work

Wrap a computation in `useMemo` only when it is expensive (sorting or grouping a large list, for example), or when its result is passed to a `memo` component or used as a hook dependency. Measure first (React Profiler); otherwise compute it inline. React's docs suggest memoizing a calculation when its measured time is significant (they give "1ms or more" as an example); time it with `console.time` in a production build, on a device like your users'.

```tsx
type Item = { id: string; category: string; name: string };

function groupByCategory(items: Item[]): Map<string, Item[]> {
  const groups = new Map<string, Item[]>();
  for (const item of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
    const group = groups.get(item.category) ?? [];
    group.push(item);
    groups.set(item.category, group);
  }
  return groups;
}

// BAD — sorts and groups the whole list on every render, even when only unrelated state changed
const groups = groupByCategory(items);

// GOOD — recomputed only when items changes
const groups = useMemo(() => groupByCategory(items), [items]);
```

**When NOT to use useMemo:**
- Cheap work: property access, or a simple filter over a short list
- Values that change on every render anyway

---

### 4. Parallel Fetches — No Waterfalls

Multiple independent API calls must be parallelized with `Promise.all`.

```typescript
// BAD — sequential: total time = t1 + t2 + t3
const items    = await api.get("/items");
const settings = await api.get("/settings");
const tags     = await api.get("/tags");

// GOOD — parallel: total time = max(t1, t2, t3)
const [itemsRes, settingsRes, tagsRes] = await Promise.all([
  api.get<Item[]>("/items"),
  api.get<Settings>("/settings"),
  api.get<Tag[]>("/tags"),
]);
```

**Exception:** Fetch B depends on the result of fetch A → sequential is required. Document why with a comment.

---

### 5. Pagination — Never Load Everything

Every list endpoint must be bounded and paginated. Prefer cursor (keyset) pagination for large or fast-changing sets: the cost of an offset grows with the offset, and rows can shift between pages. Return `hasMore` or a total so the client knows when to stop. Offset pagination, as below, is fine for small, slow-changing sets.

```typescript
const PAGE_SIZE = 20;
const [page, setPage] = useState(0);
const res = await api.get(`/items?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
```

---

### 6. Stable Object and Array Props for Memoized Components

An object or array literal is a new reference on every render. That matters only when it is passed to a `memo` component or used as a hook dependency; elsewhere leave the literal inline. When it does matter, build it once outside the component, or with `useMemo` if it depends on props or state.

```tsx
// BAD — new array every render, which defeats memo on Select
<Select options={["a", "b"].map((v) => ({ value: v, label: v }))} />

// GOOD — built once, outside the component
const OPTIONS = ["a", "b"].map((v) => ({ value: v, label: v }));

<Select options={OPTIONS} />
```

---

### 7. Stable useEffect Dependencies

An object, array or function created during render is new on every render, so listing it as a dependency re-runs the effect after every render. That becomes an infinite loop only if the effect also sets state that re-renders the component and changes that dependency again. Prefer primitive dependencies, or create the object inside the effect; wrap it in `useMemo` or `useCallback` only as a last resort.

```typescript
// BAD — a new object/array dep re-runs the effect on every render
useEffect(() => { fetchData(year, month); }, [{ year, month }]);

// GOOD — primitive deps only
useEffect(() => { fetchData(year, month); }, [year, month]);
```

---

### 8. Avoid Redundant State

Derived values should not be stored in `useState`.

```tsx
// BAD — total is derived, shouldn't be state
const [items, setItems] = useState<Item[]>([]);
const [total, setTotal] = useState(0);
useEffect(() => { setTotal(items.reduce((s, i) => s + i.amount, 0)); }, [items]);

// GOOD — computed during render; add useMemo only if measured to be slow (section 3)
const [items, setItems] = useState<Item[]>([]);
const total = items.reduce((s, i) => s + i.amount, 0);
```

---

## API / Backend

### 9. Parallel DB Reads

Multiple independent DB queries must use `Promise.all`.

```typescript
// BAD — sequential: each query waits for the one before it
const items    = await db.select().from(schema.items).where(eq(schema.items.userId, userId));
const settings = await db.select().from(schema.settings).where(eq(schema.settings.userId, userId));
const tags     = await db.select().from(schema.tags).where(eq(schema.tags.userId, userId));

// GOOD — parallel
const [items, settings, tags] = await Promise.all([
  db.select().from(schema.items).where(eq(schema.items.userId, userId)),
  db.select().from(schema.settings).where(eq(schema.settings.userId, userId)),
  db.select().from(schema.tags).where(eq(schema.tags.userId, userId)),
]);
```

On Cloudflare D1, each database processes queries one at a time, so `Promise.all` over one database may not shorten the database's own time; measure it (Step 0).

`Promise.all` rejects as soon as one query fails. When one failure must not reject the others (for example, an optional panel), use `Promise.allSettled`: each result is `{ status: "fulfilled", value }` or `{ status: "rejected", reason }`.

---

### 10. Always LIMIT Queries

Never run unbounded queries.

```typescript
// BAD
const all = await db.select().from(schema.items);

// GOOD — bounded; SQLite treats a negative LIMIT as "no upper bound", so bad input (limit=-1, limit=abc) must not reach the query unclamped
// `app`, `db`, `schema` and the auth middleware that sets `userId` come from your project
app.get("/items", async (c) => {
  const userId = c.get("userId");
  const limit = Math.max(1, Math.min(Number.parseInt(c.req.query("limit") ?? "", 10) || 100, 500));
  const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "", 10) || 0);

  // Read one extra row to learn whether there is another page
  const rows = await db.select().from(schema.items)
    .where(eq(schema.items.userId, userId))
    .orderBy(schema.items.id) // a stable order keeps pages from repeating or skipping rows
    .limit(limit + 1)
    .offset(offset);

  return c.json({ success: true, data: { items: rows.slice(0, limit), hasMore: rows.length > limit } }, 200);
});
```

---

### 11. Batch Inserts — Chunk by Bound Parameters

On Cloudflare D1, `batch()` sends several statements in one call. They run in order, and the whole batch is one transaction: if one statement fails, the entire sequence is rolled back. D1 documents no limit on the number of statements in a batch. The per-query limits apply to each statement in it, and the 30-second query limit applies to the entire batch call. Limits as D1's limits page lists them (updated 2026-10-30; read the page for current values):

| D1 limit | Value |
|----------|-------|
| Maximum bound parameters per query | 100 |
| Maximum SQL statement length | 100,000 bytes (100 KB) |
| Queries per Worker invocation | 1000 (Workers Paid), 50 (Free); a `batch()` call counts as one query |
| Maximum SQL query duration | 30 seconds |
| Maximum query result size | 50 MB |

A multi-row insert is one statement, and each row binds one parameter per column, so the bound-parameter limit caps the rows per statement: `floor(limit / columns)`.

```typescript
type NewItem = { id: string; userId: string; name: string; amount: number };

const MAX_BOUND_PARAMS = 100; // D1 "Maximum bound parameters per query"
// Values bound per row: the four provided columns, plus any omitted column that has a
// JS-side default (Drizzle binds those too; count with `.toSQL().params.length`).
const COLUMNS_PER_ROW = 4;
const ROWS_PER_STATEMENT = Math.floor(MAX_BOUND_PARAMS / COLUMNS_PER_ROW); // 25

async function insertItems(rows: NewItem[]) {
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    await db.insert(schema.items).values(rows.slice(i, i + ROWS_PER_STATEMENT));
  }
}
```

Each chunk above is a separate D1 query, so the chunks do not commit together. When they must, send the chunk statements in one `db.batch([...])` call.

---

### 12. Avoid O(n²) Loops

```typescript
type Rec = { id: string; relatedId: string };

// BAD — O(n²): scans the whole array for every record
function pairRelatedSlow(records: Rec[]): Array<[Rec, Rec]> {
  const pairs: Array<[Rec, Rec]> = [];
  for (const a of records) {
    const match = records.find((b) => b.id === a.relatedId);
    if (match) pairs.push([a, match]);
  }
  return pairs;
}

// GOOD — O(n): build a Map once, then look up in O(1); same result
function pairRelated(records: Rec[]): Array<[Rec, Rec]> {
  const byId = new Map(records.map((r) => [r.id, r] as const));
  const pairs: Array<[Rec, Rec]> = [];
  for (const a of records) {
    const match = byId.get(a.relatedId);
    if (match) pairs.push([a, match]);
  }
  return pairs;
}
```

---

### 13. No Sequential Inserts in Loops

Do not `await` an insert inside a loop (one round trip per row); build the rows first and insert them together, chunked by bound parameters as in section 11.

---

## Performance Review Checklist

```
Before optimizing:
□ Measured first (React Profiler, browser performance panel, query plan)

Frontend:
□ Every data-fetching useEffect has AbortController cleanup (pattern in the error-handling skill)
□ useCallback only for handlers passed to memo components or used as hook deps
□ useMemo only for measured-expensive work, memo props or hook deps
□ Multiple independent fetches use Promise.all
□ All list fetches are paginated (limit + offset, or a cursor for large sets)
□ Object/array props passed to memo components are stable (hoisted or memoized)
□ useEffect deps are primitives where possible — an object/array dep re-runs the effect on every render
□ No redundant useState for derived values

API:
□ Multiple independent DB reads use Promise.all
□ All list queries have a LIMIT — max 500
□ Multi-row inserts are chunked so rows × columns stays within the bound-parameter limit (section 11)
□ No sequential inserts in loops
□ No O(n²) loops on unbounded data sets
```

---

## Limitations

- These instructions guide behavior; tools do not enforce them. A pattern here is not a guaranteed gain: measure on your own project (Step 0).
- The React guidance follows the react.dev documentation current on 2026-11-07 (React 19.x); "1ms or more" is React's own illustrative figure, not a rule. React's `memo` page says `React.memo` can be removed safely when you use React Compiler, while the Compiler introduction advises leaving existing memoization in place or testing before removing it; this skill follows the introduction. The Compiler is optional.
- D1 limit values were read on 2026-11-07 from a page updated 2026-10-30 and can change; read the page. The page lists no statement-count limit for a batch; it says each statement stays within the per-query limits and the whole call within 30 seconds. No source was found for whether `Promise.all` over a single D1 database shortens total time.
- `floor(limit / columns)` is arithmetic from the documented bound-parameter limit, not a rule stated by Cloudflare or Drizzle. Count the values your driver actually binds per row.
- Sections 4, 5, 8 and 12 (parallel fetches, cursor against offset pagination, derived state, Map lookups) rest on general engineering practice; no source was gathered for them.

## Sources

Accessed 2026-11-07.

- React, *useCallback* (react.dev, current React 19.x docs): caching a function
  is valuable only when it is passed to a component wrapped in `memo` or used as
  a dependency of a Hook; elsewhere there is no benefit, and memoizing
  everything makes code less readable.
  https://react.dev/reference/react/useCallback
- React, *useMemo*: valuable when the calculation is noticeably slow and its
  dependencies rarely change, when the value is passed to a `memo` component, or
  when it is a Hook dependency; "1ms or more" is the example threshold; test
  production builds on a device like your users have.
  https://react.dev/reference/react/useMemo
- React, *memo*: use the React Developer Tools profiler to see which components
  benefit, and `memo` is useless if the props are always different.
  https://react.dev/reference/react/memo
- React, *React Compiler v1.0* (blog, 2025-10-07): the first stable release;
  compatible with React 17 and up, with `react-compiler-runtime` for versions
  before 19. Adoption: `babel-plugin-react-compiler` had 28,926,387 npm
  downloads in the week 2026-10-30 to 2026-11-05 (api.npmjs.org).
  https://react.dev/blog/2025/10/07/react-compiler-1
- React, *React Compiler introduction*: it applies the equivalent of manual
  memoization to components and hooks; `useMemo` and `useCallback` remain an
  escape hatch; leave existing memoization in place or test before removing it.
  https://react.dev/learn/react-compiler/introduction
- React, *Removing Effect Dependencies*: an object created on every render
  re-synchronizes the Effect, and unnecessary dependencies can run it too often.
  https://react.dev/learn/removing-effect-dependencies
- React, *useEffect*: an infinite cycle needs both an Effect that updates state
  and a state change that changes the Effect's dependencies; wrapping in
  `useMemo` or `useCallback` is a last resort.
  https://react.dev/reference/react/useEffect
- React, *Synchronizing with Effects*: the cleanup should abort the fetch or
  ignore its result.
  https://react.dev/learn/synchronizing-with-effects#fetching-data
- Cloudflare, *D1 Limits* (updated 2026-10-30): the limits in the table in
  section 11, that limits for individual queries apply to each statement in a
  batch, and that each D1 database "processes queries one at a time".
  https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare, *D1 Database (Worker API), batch*: batched statements run
  sequentially, are SQL transactions, and a failing statement rolls back the
  whole sequence.
  https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
- Drizzle ORM, *Batch API (SQLite)*: Drizzle runs SQL statements in a batch with
  the libSQL and Cloudflare D1 drivers. Adoption: `drizzle-orm` had 47,360,683
  npm downloads in the same week.
  https://orm.drizzle.team/docs/sqlite/batch-api
- SQLite, *SELECT*, LIMIT and OFFSET: a negative LIMIT means no upper bound on
  the rows returned, and a negative OFFSET behaves as zero.
  https://www.sqlite.org/lang_select.html#limitoffset
