---
name: error-handling
description: API response shapes, Zod validation patterns, database error handling, frontend fetch wrappers, AbortController, loading/empty states, and silent failure rules. Examples use Hono, Drizzle, Zod and React; the rules apply to other stacks. TRIGGER when writing API routes, handling errors, or displaying loading/empty states.
license: MIT
metadata:
  title: "Error Handling"
  tags: "errors,api,resilience"
  featured: "false"
  order: "6"
  version: "1.1.0"
---

# Skill: Error Handling & Resilience

The examples use Hono, Drizzle, Zod and React; the rules apply to other stacks. Each snippet is the body of a route handler or a component and assumes names such as `c` (the Hono context), `db` and `api` (the fetch wrapper) are already in scope.

## API — Response Shape (STRICT)

Every route must return one of these two shapes, except `204`, which has no body. No bare arrays. No bare objects.

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
| Success, nothing to return (e.g. DELETE) | `204` (no body) |
| Validation failure (Zod; this skill uses `400`, see below) | `400` |
| Unauthenticated (send a `WWW-Authenticate` header) | `401` |
| Forbidden (role or permission missing; the resource's existence is not secret) | `403` |
| Not found, or not yours | `404` |
| Conflict / invariant violated (including a unique-constraint violation from the database) | `409` |
| Precondition failed (a conditional request such as `If-Match`) | `412` |
| Rate limited (may include a `Retry-After` header) | `429` |
| Server / unexpected DB error | `500` |

RFC 9110 does not require `400` or `422` for validation failures: `400` is for a request perceived as malformed (for example unparsable JSON), `422` for well-formed content the server cannot process. This skill uses `400` for both; pick one convention per API and document it. When an `If-Match` precondition fails, the server must not run the method and usually answers `412`; RFC 9110 also allows a `2xx` if the same change was already applied.

---

## API — Zod Validation Pattern

```typescript
const createSchema = z.object({
  name:        z.string().min(1).max(200),
  amount:      z.number().positive(),
  description: z.string().max(500).optional(),
});

// An empty or malformed body becomes null, so safeParse fails and the route answers 400
const body = await c.req.json().catch(() => null);
const parsed = createSchema.safeParse(body);
if (!parsed.success) {
  return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
}
const data = parsed.data;
```

`c.req.json()` rejects with a `SyntaxError` on an empty or malformed body, and Hono's default error handler turns an unhandled one into `500` (see Limitations), which is why the `.catch` is there. The alternative is Hono's `validator("json", ...)` or `zValidator("json", schema)` (the `@hono/zod-validator` package): it parses the body for you and answers malformed JSON with `400` "Malformed JSON in request body" (also observed in code only). Per the Hono docs, a request without a matching JSON `content-type` header is not parsed and the validator yields `{}`.

**Rules:**
- `amount` → always `.positive()` (strictly greater than 0) — never allow 0 or negative. In Zod 4, `z.number()` already rejects NaN, Infinity and -Infinity, so `.finite()` is not needed (it is a deprecated no-op); see Limitations for Zod 3
- `userId`, `createdAt`, `id` → never accepted from client body — set server-side only
- `z.object` strips unrecognized keys by default, so extra fields never reach `data`; use `z.strictObject` to reject unknown keys with an error instead
- `parsed.error.issues` is an array, and each item has `code`, `path` and `message`. The default messages are technical (for example "Too small: expected number to be >0"), so map them to friendly text before showing them to a user

---

## API — Database Errors

```typescript
try {
  const result = await db.insert(schema.items).values(payload).returning();
  return c.json({ success: true, data: result[0] }, 201);
} catch (err) {
  console.error("Failed to insert item:", err instanceof Error ? err.name : "unknown error");
  return c.json({ success: false, error: "Failed to save record" }, 500);
}
```

**Rules:**
- Log failures with `console.error` (error level), so they can be filtered from routine output
- Log a short label plus the error class (`err.name`) or the driver's error code, never the raw error object or `err.message`: drizzle-orm 0.x query errors put the bound parameter values into `message` and `params` (1.0 leaves them out unless `paramsInErrors: true`)
- A unique-constraint violation is a conflict, not a server fault: detect it with the check your driver supports and return `409` with a generic message (for example "Already exists"); every other database error stays `500`
- Error message to client must be generic — never expose SQL error text, stack traces, or table names
- For multi-step writes that must succeed or fail together, use `db.batch([...])` (Drizzle's batch API, or `batch()` on the D1 binding): on D1 the statements run in order as one transaction, and if one fails the whole sequence is rolled back. D1 runs every query inside an implicit transaction, and its documentation offers no `BEGIN`/`COMMIT` from a Worker. Drizzle's documentation does not cover `db.transaction()` on the D1 driver, so test it before relying on it (see Limitations)

---

## API — Ownership / Not Found

```typescript
const record = await db.query.items.findFirst({
  where: and(eq(schema.items.id, id), eq(schema.items.userId, userId)),
});
if (!record) {
  // Return 404 whether it doesn't exist OR belongs to another user
  // Never return 403 for another user's record — that leaks the existence of the record
  return c.json({ success: false, error: "Not found" }, 404);
}
```

A role gate is the opposite case: a non-admin calling an admin route gets `403`, because nothing about a record is being hidden.

---

## Frontend — Fetch Wrapper

The wrapper (`api`) has one contract:
- It resolves to `{ success, data, error, status }`; an HTTP error response (4xx, 5xx) is returned with `success: false`, the server's `error` text and the HTTP `status`
- Network failures and aborts are thrown, not returned, so each call sits in a `try`/`catch` (the snippets below leave it out; the AbortController example shows it)

```typescript
// GET
const listRes = await api.get<Item[]>("/items");
if (!listRes.success) {
  setError(listRes.error);
  return;
}
setData(listRes.data!);

// POST
const createRes = await api.post<Item>("/items", payload);
if (!createRes.success) {
  toast.error(createRes.error ?? "Something went wrong");
  return;
}
toast.success("Saved");
```

**What the UI does with a failure:**
- Retry automatically only network failures and timeouts, `408`, `429` and `5xx`; use exponential backoff with jitter, and wait as long as a `Retry-After` header says when the response has one
- Retry automatically only idempotent requests (GET, HEAD, PUT, DELETE, or a POST sent with an idempotency key); a failed POST without one is not repeated for you
- `401` goes to sign-in
- `403` and `404` are terminal states ("no access", "not found") with no retry; no other `4xx` is retried either, because the same request is not expected to give a different result (`401` and `403` need new credentials, `404` needs a different request)
- Do not collapse every failure into "Failed to load data": show the server's message for an HTTP error and a separate "could not reach the server" message for a network failure

---

## Frontend — AbortController (all data-fetching pages)

```typescript
useEffect(() => {
  const controller = new AbortController();

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Item[]>("/items", { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.success) { setError(res.error); return; }
      setData(res.data!);
    } catch {
      if (controller.signal.aborted) return;
      setError("Could not reach the server");
    } finally {
      // an aborted request must not clear the loading flag of the request that replaced it
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  fetchData();
  return () => controller.abort();
}, [deps]); // deps: the values the request depends on
```

An abort from our own controller (cleanup, or a newer request replacing this one) is not an error: test `controller.signal.aborted` (or compare `err` with `controller.signal.reason`), not `err.name === "AbortError"`. `abort()` with no argument rejects the fetch with a `DOMException` named `AbortError`, but `abort(reason)` rejects with that `reason`, whatever it is, so a name check misses it. `AbortSignal.timeout(ms)` is a separate signal that rejects with a `TimeoutError`; that is a failure and shows the error. To apply both to one request, pass `AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`; its reason is whichever signal fired, and `controller.signal.aborted` stays false for a timeout.

React's docs say the cleanup should abort the request or ignore its result, and that aborting alone does not protect against race conditions. So check `controller.signal.aborted` before every `setState`, in `try`, `catch` and `finally`; React's docs do not spell that last step out, it follows from their guidance.

---

## Frontend — User-Facing Error Display

| Situation | Pattern |
|-----------|---------|
| Mutation failure (create/update/delete) | `toast.error(message)` |
| Page load failure | Inline error state; retry option only for the retryable failures above (network, `408`, `429`, `5xx`) |
| Form validation | Inline below the field, error color |
| Never | `alert()`, `window.confirm()`, silent fail |

```tsx
{error && (
  <div role="alert" className="text-red-700 text-sm text-center py-4">
    {error}
  </div>
)}
```

Text must have a contrast ratio of at least 4.5:1 against its background (WCAG 2.2 level AA, success criterion 1.4.3; 3:1 for large text). `text-red-700` and `text-gray-600` are the choices used here; re-check them for your palette (see Limitations).

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

{!loading && !error && data.length === 0 && (
  <div className="text-center py-12 text-gray-600">
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
try {
  await doSomething();
} catch (err) {
  console.error("[scope] operation failed:", err instanceof Error ? err.name : "unknown error");
  return c.json({ success: false, error: "Failed to process request" }, 500);
}
```

Always pair a `console.error` (server) or `toast.error` (client), or an inline error state like the page-load example above, with every catch block, except the abort from our own controller.

---

## Limitations

- These instructions guide behavior; tools do not enforce them. They were checked against Zod 4, Hono 4, drizzle-orm 0.45 (the 1.0 behavior is noted where it differs), Cloudflare D1 and the React docs current on 2026-11-07; other major versions can differ. On Zod 3, check your version's documentation for `NaN` and infinite values before dropping `.finite()`; no Zod 3 statement was found.
- Observed in package code, not stated by the documentation (no link): in hono 4.13.17, `c.req.json()` rejects with a `SyntaxError` on an empty or malformed body, the default error handler answers `500` for it, and the json validator answers malformed JSON with `400`; in zod 4.6.7, the typings mark `.finite()` as a deprecated no-op; in drizzle-orm 0.45.4, a query error carries the bound values in `message` and `params`, and `db.transaction()` on D1 sends a raw `begin`, then `commit` or `rollback`, as separate queries. Re-check after upgrading.
- No documentation was found for: whether Drizzle's `db.transaction()` works on D1 (neither supported nor unsupported, so test it); an explicit statement that D1 refuses `BEGIN`/`COMMIT` from a Worker (the D1 pages only say every query runs in an implicit transaction); skipping `setState` after an abort as a quoted React rule (it follows from React's abort-or-ignore guidance); and that retrying a `404` never helps (RFC 9110 says only that it does not indicate whether the absence is temporary or permanent, so the skill treats it as terminal by convention).
- `400` for validation, `409` for a unique-constraint violation and `404` for another user's record are this skill's conventions. RFC 9110 allows alternatives, such as `422`, so pick one per API and document it.
- Contrast: `text-red-700` and `text-gray-600` were computed with the WCAG formula at about 6.4:1 and 7.6:1 against white in Tailwind v4.3's default palette (defined in OKLCH); the figures are not from Tailwind. Re-run the contrast check for your palette, theme overrides, dark mode and the actual background, such as the gray skeleton.
- The skill gives no backoff constants; choose them for your service.

## Sources

Accessed 2026-11-07.

- IETF, *RFC 9110, HTTP Semantics* (Internet Standard, June 2022; replaces
  RFC 7231): `401` must send `WWW-Authenticate`; `403` means understood but
  refused; `404` may hide that a resource exists; `409` is a conflict with
  the current state; a failed precondition may be answered `412`; `204` has no
  content; idempotent requests can be repeated after a communication failure,
  other methods should not be retried automatically; `Retry-After` says how
  long to wait. It never requires `400` or `422` for validation.
  https://www.rfc-editor.org/rfc/rfc9110.html
- IETF, *RFC 6585, Additional HTTP Status Codes* (April 2012): `429` means too
  many requests in a given amount of time, and the response may include
  `Retry-After`.
  https://www.rfc-editor.org/rfc/rfc6585.html
- Google Cloud, *Cloud Storage retry strategy* (official guidance for its
  client libraries): retry `408`, `429` and `5xx` and socket or connection
  failures with exponential backoff and jitter, and only when the request is
  idempotent; authorization failures and invalid requests are persistent.
  https://docs.cloud.google.com/storage/docs/retry-strategy
- WHATWG, *DOM Standard*, AbortController and AbortSignal: the default abort
  reason is an `AbortError` `DOMException`, `AbortSignal.timeout` aborts with a
  `TimeoutError`, `AbortSignal.any` takes the reason of the signal that fired,
  and `aborted` reports whether the controller has signaled. Adoption: a living
  standard implemented in all major browsers and in Node.js.
  https://dom.spec.whatwg.org/#interface-abortcontroller
- WHATWG, *Fetch Standard*: aborting a `fetch()` rejects its promise with the
  signal's abort reason.
  https://fetch.spec.whatwg.org/#fetch-method
- React, *Synchronizing with Effects* (react.dev, current React 19.x docs):
  an effect that fetches should abort the request or ignore its result in the
  cleanup, and aborting by itself is not enough against race conditions.
  https://react.dev/learn/synchronizing-with-effects#fetching-data
- Hono, *Validation*: a request must carry a matching `content-type` header or
  the body is not parsed and the value is `{}`; a third-party validator such as
  the Zod validator middleware is recommended. Adoption: `hono` had
  103,334,097 and `@hono/zod-validator` 7,516,504 npm downloads in the week
  2026-10-30 to 2026-11-05 (api.npmjs.org).
  https://hono.dev/docs/guides/validation
- Zod, *API reference*: `z.number()` allows any finite number, `.positive()` is
  an alias of `.gt(0)`, and unrecognized object keys are stripped by default
  (`z.strictObject` rejects them). Adoption: `zod` had 453,207,139 npm
  downloads in the same week.
  https://zod.dev/api
- Cloudflare, *D1 Database (Worker API), batch*: batched statements run
  sequentially, are SQL transactions, and a failing statement rolls back the
  whole sequence.
  https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
- Drizzle ORM, *v0 to v1 changes*: in 1.0, `DrizzleQueryError` no longer
  includes query parameters unless `paramsInErrors: true`, which also puts
  parameter values in the error message. Adoption: `drizzle-orm` had 47,360,683
  npm downloads in the same week.
  https://orm.drizzle.team/docs/sqlite/v0-v1-changes
- W3C, *WCAG 2.2*, success criterion 1.4.3 Contrast (Minimum), level AA: text
  needs a contrast ratio of at least 4.5:1, or 3:1 for large-scale text.
  Adoption: a W3C Recommendation (12 December 2024).
  https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- Tailwind CSS, *Colors* (v4.3): the default palette is defined in OKLCH.
  Adoption: `tailwindcss` had 172,937,919 npm downloads in the same week.
  https://tailwindcss.com/docs/colors
