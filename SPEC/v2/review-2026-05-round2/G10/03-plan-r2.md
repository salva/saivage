# G10 — Plan r2

**Finding**: [../G10-appenddoc-read-modify-write-race.md](../G10-appenddoc-read-modify-write-race.md)
**Design**: [02-design-r2.md](02-design-r2.md) (Proposal C — delete)
**Reviewer r1 verdict**: CHANGES_REQUESTED — see [04-review-r1.md](04-review-r1.md). Required change: `npm run docs:api` is now a mandatory step. Minor note: corrected pre-change test-file match count from 3 to 5.

## Edits

### Edit 1 — Remove `appendDoc` from [src/store/documents.ts](../../../../src/store/documents.ts)

Delete lines 104–128 inclusive (the `/** Append … */` JSDoc plus the `export async function appendDoc<…>(…) { … }` block). The preceding `}` on line 102 (closing `writeDoc`) and the following `/** List files in a directory … */` on line 130 stay; the deletion removes the blank line on 103 as well to keep one blank line between the two surviving functions.

Old string (exact, includes the surrounding context required by the edit tool):

```
    // Some platforms (Windows) don't allow opening directories for fsync.
  }
}

/**
 * Append an item to a JSON array document.
 */
export async function appendDoc<T extends Record<string, unknown>>(
  path: string,
  itemKey: string & keyof T,
  item: unknown,
  schema: z.ZodType<T>,
  defaultDoc?: Omit<T, typeof itemKey>,
): Promise<void> {
  let doc: T;
  const existing = await readDocOrNull(path, schema);
  if (existing !== null) {
    doc = existing as T;
  } else {
    doc = { ...defaultDoc, [itemKey]: [] } as unknown as T;
  }
  const arr = doc[itemKey];
  if (!Array.isArray(arr)) {
    throw new Error(`Field "${itemKey}" is not an array`);
  }
  arr.push(item);
  await writeDoc(path, doc, schema);
}

/** List files in a directory (returns filenames, not full paths). */
```

New string:

```
    // Some platforms (Windows) don't allow opening directories for fsync.
  }
}

/** List files in a directory (returns filenames, not full paths). */
```

### Edit 2 — Drop the `appendDoc` import in [src/store/documents.test.ts](../../../../src/store/documents.test.ts)

At lines 11–20 the import group reads:

```
import {
  readDoc,
  readDocOrNull,
  writeDoc,
  appendDoc,
  listDir,
  deleteDoc,
  ensureDir,
} from "./documents.js";
```

Replace with:

```
import {
  readDoc,
  readDocOrNull,
  writeDoc,
  listDir,
  deleteDoc,
  ensureDir,
} from "./documents.js";
```

### Edit 3 — Delete the `describe("appendDoc")` block at [src/store/documents.test.ts](../../../../src/store/documents.test.ts#L133-L163)

Old string (exact, with anchoring `});` of the preceding `describe`):

```
  it("listDir returns empty for missing directory", async () => {
    expect(await listDir(join(tmpDir, "nope"))).toEqual([]);
  });
});

// ─── Append tests ────────────────────────────────────────────────────────────

describe("appendDoc", () => {
  it("appends to existing array field", async () => {
    const path = join(tmpDir, "history.json");
    await writeDoc(
      path,
      { stages: [{ id: "stg-1" }] },
      z.object({ stages: z.array(z.object({ id: z.string() })) }),
    );
    const schema = z.object({
      stages: z.array(z.object({ id: z.string() })),
    });
    await appendDoc(path, "stages", { id: "stg-2" }, schema);

    const result = await readDoc(path, schema);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[1]).toEqual({ id: "stg-2" });
  });

  it("creates file with default doc if missing", async () => {
    const path = join(tmpDir, "new.json");
    const schema = z.object({
      stages: z.array(z.object({ id: z.string() })),
    });
    await appendDoc(path, "stages", { id: "stg-1" }, schema, {} as never);

    const result = await readDoc(path, schema);
    expect(result.stages).toEqual([{ id: "stg-1" }]);
  });
});

// ─── ID Generator tests ─────────────────────────────────────────────────────
```

New string:

```
  it("listDir returns empty for missing directory", async () => {
    expect(await listDir(join(tmpDir, "nope"))).toEqual([]);
  });
});

// ─── ID Generator tests ─────────────────────────────────────────────────────
```

### Edit 4 — Rewrite the "appends to PlanHistory" round-trip test ([src/store/documents.test.ts](../../../../src/store/documents.test.ts#L396-L419))

The test exists in the "Document Store + Schema round-trip" describe; its real value is asserting that `PlanHistorySchema` accepts a complete entry. Replace `appendDoc` with a direct `writeDoc` of the same entry wrapped in a one-stage history and rename the case to match.

Old string:

```
  it("appends to PlanHistory", async () => {
    const path = join(tmpDir, "plan-history.json");
    const entry = {
      id: "stg-1",
      objective: "Setup",
      expected_outcomes: ["structure"],
      actual_outcomes: ["structure created"],
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      result: "completed" as const,
      summary: "All done",
    };

    await appendDoc(
      path,
      "stages",
      entry,
      PlanHistorySchema,
      {} as never,
    );

    const result = await readDoc(path, PlanHistorySchema);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].id).toBe("stg-1");
  });
});
```

New string:

```
  it("writes and reads a PlanHistory", async () => {
    const path = join(tmpDir, "plan-history.json");
    const entry = {
      id: "stg-1",
      objective: "Setup",
      expected_outcomes: ["structure"],
      actual_outcomes: ["structure created"],
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      result: "completed" as const,
      summary: "All done",
    };

    await writeDoc(path, { stages: [entry] }, PlanHistorySchema);

    const result = await readDoc(path, PlanHistorySchema);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].id).toBe("stg-1");
  });
});
```

### Edit 5 — Regenerate the TypeDoc API tree

Run `npm run docs:api` (script defined at [package.json](../../../../package.json#L22): `typedoc && node docs/.vitepress/scripts/sanitize-typedoc.mjs`). Workflow is the one documented at [docs/internals/development.md](../../../../docs/internals/development.md#L68-L73). The expected generated diffs to commit alongside Edits 1–4:

- [docs/api/store/documents/functions/appendDoc.md](../../../../docs/api/store/documents/functions/appendDoc.md) is deleted by the generator (no source export remains).
- [docs/api/typedoc-sidebar.json](../../../../docs/api/typedoc-sidebar.json) is rewritten by the generator with the `appendDoc` sidebar entry under `store/documents` removed.
- Any other incidental whitespace / link-target normalisation the sanitize step emits is accepted as-is; no hand edits to [docs/api/](../../../../docs/api/).

This step is **required**, not optional. Do not commit Edits 1–4 without the regenerated docs.

## Validation

Run from [/home/salva/g/ml/saivage](../../../../).

1. Pre-change baseline (confirm the lexical surface to be removed; for the record):

   ```bash
   grep -n "appendDoc" src/store/documents.test.ts | wc -l
   ```

   Expected before applying Edits 2–4: **5** matches in this test file — the import (line 15), the `describe("appendDoc", …)` suite header (line 135), and the three calls (lines 146, 158, 409). The production export at [src/store/documents.ts](../../../../src/store/documents.ts#L107) is the only other lexical match in `src/`.

2. Type check:

   ```bash
   npx tsc -p tsconfig.json --noEmit
   ```

   Expected: clean. Any `TS2305: Module '"./documents.js"' has no exported member 'appendDoc'` would indicate a stray caller; analysis §2 says there is none, but the check is the safety net.

3. Focused vitest (the only file that exercises the deleted surface):

   ```bash
   npx vitest run src/store/documents.test.ts
   ```

   Expected: the `describe("appendDoc")` block is gone, the rewritten round-trip case `"writes and reads a PlanHistory"` passes, the remaining cases unchanged.

4. Full vitest:

   ```bash
   npm test
   ```

   Expected: green. No other test imports `appendDoc`.

5. Build:

   ```bash
   npm run build
   ```

   Expected: clean `dist/cli.js` emission via `tsup` + Vite SPA bundle.

6. Regenerate API docs (mandatory):

   ```bash
   npm run docs:api
   ```

   Expected: TypeDoc rewrites [docs/api/](../../../../docs/api/) from source. [docs/api/store/documents/functions/appendDoc.md](../../../../docs/api/store/documents/functions/appendDoc.md) is removed; [docs/api/typedoc-sidebar.json](../../../../docs/api/typedoc-sidebar.json) no longer references `appendDoc`. Commit the generator's output.

7. Post-change zero-match assertion:

   ```bash
   grep -R "appendDoc" src/ tests/ docs/api/
   ```

   Expected: **zero** matches anywhere — source, tests, generated docs.

## Daemon impact and operator gating

`appendDoc` has no production caller (analysis §2). No runtime behaviour changes. **No restart of `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112), or `saivage-v3-getrich-v2` (10.0.3.170) is required by this change.**

The standard "rebuild + restart" hygiene is optional and operator-gated. If the operator chooses to refresh the bind-mounted bundles after merging this change, the shape is (host-side from the repo root):

```bash
npm run build
# then per host that bind-mounts /home/salva/g/ml/saivage:
ssh root@10.0.3.111 'systemctl restart saivage.service'
ssh root@10.0.3.112 'systemctl restart saivage.service'
ssh root@10.0.3.113 'systemctl restart saivage.service'
```

Do not run the restarts as part of landing this change; ask the operator first.

## Done criteria

- `grep -R "appendDoc" src/ tests/ docs/api/` returns zero matches.
- `npx tsc -p tsconfig.json --noEmit` clean.
- `npm test` green.
- `npm run build` clean.
- `npm run docs:api` ran cleanly and its generated diffs are committed; [docs/api/store/documents/functions/appendDoc.md](../../../../docs/api/store/documents/functions/appendDoc.md) is gone and [docs/api/typedoc-sidebar.json](../../../../docs/api/typedoc-sidebar.json) no longer mentions `appendDoc`.
- No new files in `src/`. No new exports. No new locks.

## r2 deltas vs r1

- **Required change addressed**: `npm run docs:api` is now Edit 5 and validation step 6, and it appears in the done-criteria with explicit per-file expectations ([docs/api/store/documents/functions/appendDoc.md](../../../../docs/api/store/documents/functions/appendDoc.md) deleted, [docs/api/typedoc-sidebar.json](../../../../docs/api/typedoc-sidebar.json) updated). r1's "Optional sanity" framing of `npm run docs:api` is removed. The post-change grep also now scans `docs/api/` so a missed regeneration fails the check.
- **Minor note addressed**: the pre-change baseline in validation step 1 now states the correct figure — 5 lexical matches in [src/store/documents.test.ts](../../../../src/store/documents.test.ts) (import L15, `describe("appendDoc", …)` L135, calls L146 / L158 / L409). r1 plan's "three matches" figure is corrected. The set of edits required to remove them all is unchanged.
- Edit 2 reference updated from "line 14" to "line 15" to match the live import position; line ranges in Edits 3 and 4 are unchanged.
- Done-criteria grep is widened from `src/ tests/` to `src/ tests/ docs/api/` to enforce that the regeneration step actually happened.
- Daemon-impact paragraph now also names `saivage-v3-getrich-v2` for completeness; restart instructions remain operator-gated.
- No content change to Edits 1, 3, 4 themselves — only surrounding line references and validation framing.
