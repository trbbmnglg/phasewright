---
name: error-handling
description: API response shapes, Zod validation patterns, database error handling, frontend fetch wrappers, AbortController, loading/empty states, and silent failure rules. TRIGGER when writing API routes, handling errors, or displaying loading/empty states.
license: MIT
metadata:
  title: "Error Handling"
  tags: "errors,api,resilience"
  featured: "false"
  order: "6"
  version: "1.0.0"
---

# Skill: Error Handling & Resilience

## API — Response Shape (STRICT)

Every route must return one of these two shapes. No bare arrays. No bare objects.

```typescript
// Success
return c.json({ success: true, data: result }, 200);

// Error
return c.json({ success: false, error: "Human-readable message" }, 400);
```

**HTTP status codes:**

| Situation | Code |
|-----------|------|
| Success | `200` |
| Created | `201` |
| Validation failure (Zod) | `400` |
| Unauthenticated | `401` |
| Forbidden (wrong user) | `403` |
| Not found | `404` |
| Conflict / invariant violated | `409` |
| Rate limited | `429` |
| Server / DB error | `500` |

---

## API — Zod Validation Pattern

```typescript
const createSchema = z.object({
  name:        z.string().min(1).max(200),
  amount:      z.number().positive().finite(),
  description: z.string().max(500).optional(),
});

const body = await c.req.json();
const parsed = createSchema.safeParse(body);
if (!parsed.success) {
  return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
}
const data = parsed.data;
```

**Rules:**
- `amount` → always `.positive().finite()` — never allow 0, negative, NaN, Infinity
- `userId`, `createdAt`, `id` → never accepted from client body — set server-side only
- Unknown fields are dropped silently (Zod v4 default strip behavior)

---

## API — Database Errors

```typescript
try {
  const result = await db.insert(schema.items).values(payload).returning();
  return c.json({ success: true, data: result[0] }, 201);
} catch (err) {
  console.error("Failed to insert item:", err);
  return c.json({ success: false, error: "Failed to save record" }, 500);
}
```

**Rules:**
- `console.error` only — never `console.log` in production
- Error message to client must be generic — never expose SQL error text, stack traces, or table names
- For multi-step writes, wrap in a transaction so partial failure doesn't leave inconsistent state

---

## API — Ownership / Not Found

```typescript
const record = await db.query.items.findFirst({
  where: and(eq(schema.items.id, id), eq(schema.items.userId, userId)),
});
if (!record) {
  // Return 404 whether it doesn't exist OR belongs to another user
  // Never return 403 — that leaks the existence of the record
  return c.json({ success: false, error: "Not found" }, 404);
}
```

---

## Frontend — Fetch Wrapper

```typescript
// GET
const res = await api.get<Item[]>("/items");
if (!res.success) {
  setError(res.error);
  return;
}
setData(res.data!);

// POST
const res = await api.post<Item>("/items", payload);
if (!res.success) {
  toast.error(res.error ?? "Something went wrong");
  return;
}
toast.success("Saved");
```

---

## Frontend — AbortController (all data-fetching pages)

```typescript
useEffect(() => {
  const controller = new AbortController();

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<T[]>("/route", { signal: controller.signal });
      if (!res.success) { setError(res.error); return; }
      setData(res.data!);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  fetchData();
  return () => controller.abort();
}, [deps]);
```

---

## Frontend — User-Facing Error Display

| Situation | Pattern |
|-----------|---------|
| Mutation failure (create/update/delete) | `toast.error(message)` |
| Page load failure | Inline error state with retry option |
| Form validation | Inline below the field, error color |
| Never | `alert()`, `window.confirm()`, silent fail |

```tsx
{error && (
  <div className="text-red-500 text-sm text-center py-4">
    {error}
  </div>
)}
```

---

## Frontend — Loading States

```tsx
{loading && (
  <div className="space-y-3">
    {[...Array(3)].map((_, i) => (
      <div key={i} className="animate-pulse bg-gray-100 rounded-xl h-16" />
    ))}
  </div>
)}

{!loading && data.length === 0 && (
  <div className="text-center py-12 text-gray-400">
    <p>No records yet</p>
  </div>
)}
```

---

## Silent Failure — Never Allowed

```typescript
// BAD — breach becomes invisible
try {
  await doSomething();
} catch (e) {
  // silence
}

// GOOD
catch (err) {
  console.error("[scope] operation failed:", err);
  return c.json({ success: false, error: "Failed to process request" }, 500);
}
```

Always pair a `console.error` (server) or `toast.error` (client) with every catch block.
