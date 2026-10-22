---
name: refactoring
description: Code refactoring guide — 300-line hard limit, hook extraction, modal extraction, tab extraction, constants extraction, and API route splitting. TRIGGER when a file approaches or exceeds 300 lines, or when extracting hooks/modals/tabs/constants.
argument-hint: "[optional: file path or area to refactor]"
license: MIT
metadata:
  title: "Refactoring Guide"
  tags: "refactoring,code-quality"
  featured: "false"
  order: "5"
  version: "1.0.0"
---

# Skill: Refactoring

The hard limit is **300 lines per file**. This applies to page components, tab components, modal components, and API route files. When a file exceeds 300 lines, split it before adding any new feature.

---

## Decision Tree — What to Extract First

```
File > 300 lines?
│
├── Has inline modal/dialog blocks with local state?
│   └── → Extract each to components/XModal.tsx (or equivalent)
│
├── Has > 5 useState hooks?
│   └── → Extract data fetching + state to hooks/useX.ts
│
├── Has multiple tab panels rendered inline?
│   └── → Each tab → pages/section/tabs/XTab.tsx
│
├── Has large constants / maps / config objects?
│   └── → Extract to a co-located constants.ts
│
├── Is an API route file with > 5 handlers?
│   └── → Split by sub-domain into routes/section/ folder
│
└── Has repeated JSX pattern 3+ times?
    └── → Extract to a local sub-component at top of same file
```

---

## Frontend: Custom Hook Extraction

Extract when a page has **> 5 useState hooks** or **> 2 useEffect hooks**.

```typescript
// hooks/useItems.ts
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export function useItems() {
  const [items, setItems]   = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Item[]>("/items");
      if (res.success) setItems(res.data!);
      else setError(res.error ?? "Failed to load");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  return { items, loading, error, refetch: fetch };
}
```

### What goes in the hook vs the page

| Hook | Page |
|------|------|
| `useState` for data, loading, error | `useState` for modal open/close |
| `useEffect` for fetching | `useState` for selected/editing record |
| `useCallback` for fetch/refetch | Toast calls |
| Filter/sort/derive logic | Which modal is open |
| AbortController + cleanup | Button handlers |

**Never put toast calls or modal state inside a data hook.**

---

## Frontend: Modal Extraction

Extract when a modal has **any local state** (form fields, loading, validation errors).

```
components/modals/AddItemModal.tsx       ← shared across pages
pages/section/modals/EditItemModal.tsx   ← scoped to one section
```

### Pattern

```tsx
interface Props {
  isOpen:    boolean;
  onClose:   () => void;
  onSuccess: () => void;
}

export function AddItemModal({ isOpen, onClose, onSuccess }: Props) {
  const [saving, setSaving] = useState(false);
  const [name, setName]     = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleClose = useCallback(() => {
    setName(""); setErrors({}); onClose();
  }, [onClose]);

  const handleSave = async () => {
    if (!name.trim()) { setErrors({ name: "Name is required" }); return; }
    setSaving(true);
    try {
      const res = await api.post("/items", { name: name.trim() });
      if (!res.success) { toast.error(res.error ?? "Failed to save"); return; }
      toast.success("Item created");
      onSuccess();
      handleClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Add Item">
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
      <div className="flex gap-3 justify-end pt-4">
        <Button variant="text" onClick={handleClose} disabled={saving}>Cancel</Button>
        <Button isLoading={saving} onClick={handleSave}>Save</Button>
      </div>
    </Modal>
  );
}
```

---

## Frontend: Tab Extraction

Every tab panel must be its own file. If a tab file itself exceeds 300 lines, split it further.

```
pages/settings/
├── SettingsPage.tsx        ← tab shell only, < 100 lines
└── tabs/
    ├── GeneralTab.tsx
    ├── IntegrationsTab.tsx
    └── AdvancedTab.tsx
```

---

## Frontend: Constants Extraction

Large maps/arrays inside components add lines and re-create on every render.

```typescript
// BAD — inside Component.tsx (re-created each render)
const OPTIONS = [{ value: "a", label: "A" }, { value: "b", label: "B" }];

// GOOD — pages/section/constants.ts
export const OPTIONS = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
] as const;
```

---

## API: Route File Splitting

Split when a route file exceeds 300 lines. Split by **resource sub-domain**.

```
routes/items.ts  →  routes/items/
                     ├── index.ts          (~30 lines — assembles routes)
                     ├── crud.ts           (~150 lines — CRUD)
                     └── bulk.ts           (~80 lines — bulk operations)
```

### API: Business Logic Extraction

Route handlers > 60 lines should extract business logic to `lib/`.

```typescript
// GOOD — lib/items.ts handles logic
export async function createItem(db: Database, params: CreateItemParams) {
  // all business logic here — testable, reusable
}

// routes/items/crud.ts — handler is < 20 lines
app.post("/", async (c) => {
  const parsed = createItemSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: parsed.error.flatten().fieldErrors }, 400);
  const result = await createItem(c.get("db"), parsed.data);
  return c.json({ success: true, data: result }, 201);
});
```

---

## Refactoring Checklist

```
□ No file in scope exceeds 300 lines (wc -l check)
□ All modals with local state are in their own files
□ All data-fetching logic is in custom hooks
□ All tab panels are in their own component files
□ Large constant maps/arrays are outside component functions
□ Page component contains only: layout JSX, modal open/close state, hook calls
□ API route handler bodies are < 60 lines each
□ No business logic duplicated — extracted to lib/ helpers
□ No functionality changed — same behavior, restructured files
□ Commit: refactor(scope): description — separate from any feat/fix commits
```
