---
name: performance
description: Frontend and API performance patterns — AbortController, useCallback, useMemo, Promise.all, pagination, batch inserts. TRIGGER when optimizing renders, parallel fetches, waterfall queries, or slow pages.
license: MIT
metadata:
  title: "Performance Patterns"
  tags: "performance,react,api"
  featured: "false"
  order: "7"
  version: "1.0.0"
---

# Skill: Performance Optimization

---

## Frontend

### 1. AbortController on Every Fetch

Every `useEffect` that fetches data must clean up with `AbortController`.

```typescript
useEffect(() => {
  const controller = new AbortController();

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get<Item[]>("/items", { signal: controller.signal });
      if (res.success) setItems(res.data!);
      else setError(res.error ?? "Failed to load");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Failed to load");
    } finally {
      setLoading(false);
    }
  };

  load();
  return () => controller.abort();
}, [/* stable deps only */]);
```

**Flag:** Any `useEffect` with an async fetch that does NOT have `return () => controller.abort()`.

---

### 2. useCallback for All Handler Functions

All event handlers and callbacks passed to child components must be wrapped in `useCallback`.

```tsx
// BAD — new function reference every render → child always re-renders
<Button onClick={() => setOpen(true)}>Add</Button>

// GOOD
const handleOpen = useCallback(() => setOpen(true), []);
<Button onClick={handleOpen}>Add</Button>

// BAD — inline async in JSX
<Button onClick={async () => { setSaving(true); await api.post(...); setSaving(false); }}>Save</Button>

// GOOD
const handleSave = useCallback(async () => {
  setSaving(true);
  try {
    const res = await api.post("/items", payload);
    if (!res.success) { toast.error(res.error ?? "Failed"); return; }
    toast.success("Saved");
  } finally {
    setSaving(false);
  }
}, [payload]);
```

---

### 3. useMemo for Derived/Computed Values

Wrap expensive computations — filtering, sorting, reducing large arrays — in `useMemo`.

```tsx
// BAD — re-filters on every render
const filtered = items.filter((i) => i.active);

// GOOD
const filtered = useMemo(
  () => items.filter((i) => i.active),
  [items]
);
```

**When NOT to use useMemo:**
- Simple property access or single-condition filter on < 50 items
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

Every list endpoint must use `limit`/`offset`.

```typescript
const PAGE_SIZE = 20;
const [page, setPage] = useState(0);
const res = await api.get(`/items?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
```

---

### 6. Avoid Inline Objects and Arrays in JSX

```tsx
// BAD — new array every render
<Select options={["a", "b"].map(v => ({ value: v, label: v }))} />

// GOOD — stable reference outside component
const OPTIONS = [
  { value: "a", label: "Option A" },
  { value: "b", label: "Option B" },
] as const;

<Select options={OPTIONS} />
```

---

### 7. Stable useEffect Dependencies

```typescript
// BAD — object/array dep causes infinite loop
useEffect(() => { fetchData(); }, [{ year, month }]);

// GOOD — primitive deps only
useEffect(() => { fetchData(year, month); }, [year, month]);
```

---

### 8. Avoid Redundant State

Derived values should not be stored in `useState`.

```tsx
// BAD — totalAmount is derived, shouldn't be state
const [items, setItems] = useState<Item[]>([]);
const [total, setTotal] = useState(0);
useEffect(() => { setTotal(items.reduce((s, i) => s + i.amount, 0)); }, [items]);

// GOOD
const [items, setItems] = useState<Item[]>([]);
const total = useMemo(() => items.reduce((s, i) => s + i.amount, 0), [items]);
```

---

## API / Backend

### 9. Parallel DB Reads

Multiple independent DB queries must use `Promise.all`.

```typescript
// BAD — sequential: 3× latency
const items    = await db.select().from(schema.items)...;
const settings = await db.select().from(schema.settings)...;
const tags     = await db.select().from(schema.tags)...;

// GOOD — parallel
const [items, settings, tags] = await Promise.all([
  db.select().from(schema.items).where(...),
  db.select().from(schema.settings).where(...),
  db.select().from(schema.tags).where(...),
]);
```

---

### 10. Always LIMIT Queries

Never run unbounded queries.

```typescript
// BAD
const all = await db.select().from(schema.items);

// GOOD
const MAX = Math.min(parseInt(c.req.query("limit") ?? "100"), 500);
const records = await db.select().from(schema.items)
  .where(eq(schema.items.userId, userId))
  .limit(MAX)
  .offset(offset);
```

---

### 11. Batch Inserts — Chunk at 100

When using batch APIs (e.g., D1), stay under the statement limit.

```typescript
for (let i = 0; i < stmts.length; i += 100) {
  await db.batch(stmts.slice(i, i + 100) as any);
}
```

---

### 12. Avoid O(n²) Loops

```typescript
// BAD — O(n²) on large arrays
for (const a of allRecords) {
  for (const b of allRecords) { /* compare */ }
}

// GOOD — Map for O(1) lookup
const recordMap = new Map(allRecords.map((r) => [r.id, r]));
for (const a of allRecords) {
  const match = recordMap.get(a.relatedId);
}
```

---

## Performance Review Checklist

```
Frontend:
□ Every data-fetching useEffect has AbortController cleanup
□ All event handlers in JSX use useCallback
□ Expensive filters/reduces use useMemo
□ Multiple independent fetches use Promise.all
□ All list fetches are paginated (limit + offset)
□ No inline object/array literals in JSX props
□ useEffect deps are primitives — no object/array deps
□ No redundant useState for derived values

API:
□ Multiple independent DB reads use Promise.all
□ All list queries have a LIMIT — max 500
□ Batch inserts are chunked at 100
□ No sequential inserts in loops
□ No O(n²) loops on unbounded data sets
```
