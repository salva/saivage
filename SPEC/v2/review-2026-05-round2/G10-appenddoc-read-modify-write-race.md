# G10 — `appendDoc` has a read-modify-write race and exists only for tests

**Subsystem:** src/store/
**Category:** dead code / architecture
**Severity:** low-medium
**Transversality:** local

## Summary

`src/store/documents.ts` exports `appendDoc<T>` which loads an array, pushes one element, and writes the whole file back via `writeDoc`. There is no per-path mutex, so two concurrent appends to the same document silently lose one entry. Grep across `src/` shows zero callers — the only callers are in `tests/store/documents.test.ts`. The function is dead code in production and a tempting future trap.

## Evidence

[src/store/documents.ts](src/store/documents.ts#L107) (function `appendDoc`):

```ts
export async function appendDoc<T extends z.ZodType<unknown[]>>(
  filePath: string,
  schema: T,
  item: z.infer<T> extends Array<infer U> ? U : never,
): Promise<void> {
  const existing = await readDocOrNull(filePath, schema);
  const arr = (existing ?? []) as unknown[];
  arr.push(item);
  await writeDoc(filePath, arr as z.infer<T>, schema);
}
```

Three problems in one ~10-line function:

1. **Read-modify-write race.** Two concurrent `appendDoc(p, schema, x)` and `appendDoc(p, schema, y)` calls both read the same `existing` (length N), both push to local copies (length N+1), both write — last writer wins, loses one element. `writeDoc` is atomic per call (tmp+rename), but atomicity at the file-write step doesn't help when the *value being written* is computed from a stale read.
2. **Schema constraint loophole.** The generic constraint `T extends z.ZodType<unknown[]>` ensures the top-level is an array, but the cast `arr as z.infer<T>` after `arr.push(item)` is a free unchecked cast. Nothing forces the appended item to satisfy the array element schema at call time.
3. **Dead code.** Grep for `appendDoc(` across `src/` returns no hits outside the export site; grep across `tests/` returns hits only in `documents.test.ts`. Production code that needs append semantics uses bespoke routines (notes, plan history, audit JSONL) that are append-only by construction.

The `documents.ts` module *does* offer atomic single-writer writes (`writeDoc`) and even a `renameDoc` helper that's used correctly elsewhere — the append abstraction is the odd one out.

## Why this matters

- The function is a future-bug source: a casual reader sees a helpful "atomic append" name, uses it for plan-history appends or audit log appends, and silently loses entries under concurrent runs.
- It's also a maintenance cost — the test file exists to test code that nothing else uses.
- The bigger architectural question this raises: the store module does **not** offer a per-path async mutex for any compound update (append, read-modify-write, conditional-write). The next time someone needs one they'll either roll a fresh broken one or paste this one's pattern.

## Rough remediation direction

Pick one:

a) **Delete.** Remove `appendDoc` and the dedicated `documents.test.ts` case for it. Production has no caller.

b) **Fix and document.** If we want a real append, introduce a per-path async mutex (`Map<string, Promise<void>>`-based serializer) in `documents.ts` and have `appendDoc` acquire it. Then the function becomes safe and worth keeping. Add a test that fires 100 concurrent appends and asserts the final length is 100.

The architecture-first guideline ("no backward compatibility, remove rather than maintain") points at (a) unless we identify a real near-term caller.

## Cross-links

- Adjacent to G06 (stash sync fs) and G08 (seedProject schema bypass) — all three are about store-module hygiene.
- The hypothetical per-path async mutex from option (b) would also help any future "read-then-write" plan-history compaction logic.
