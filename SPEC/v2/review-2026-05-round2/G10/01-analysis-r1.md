# G10 — Analysis r1

**Finding**: [../G10-appenddoc-read-modify-write-race.md](../G10-appenddoc-read-modify-write-race.md)
**Subsystem**: store ([../00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) row "Store")
**Coordinates with**: G06 ([../G06/APPROVED.md](../G06/APPROVED.md)), G36 ([../G36/APPROVED.md](../G36/APPROVED.md)), G38 ([../G38/APPROVED.md](../G38/APPROVED.md))

## 1. What the function actually is today

[src/store/documents.ts](../../../../src/store/documents.ts#L104-L128):

- Signature is `appendDoc<T extends Record<string, unknown>>(path, itemKey, item, schema, defaultDoc?)`. The finding text quotes an older single-array shape; the live code wraps the array inside a named field. The race surface is the same.
- Body sequence: `await readDocOrNull(path, schema)` → optional `defaultDoc` seed → `arr.push(item)` → `await writeDoc(path, doc, schema)`. Two concurrent calls observe the same `existing`, both push to private copies, last `writeDoc` wins, one entry is lost. `writeDoc` ([src/store/documents.ts](../../../../src/store/documents.ts#L73-L102)) provides atomic single-write semantics (tmp+fsync+rename+parent fsync) but cannot rescue a stale-read input.
- The cast `doc[itemKey]` then `arr.push(item)` ([src/store/documents.ts](../../../../src/store/documents.ts#L121-L126)) accepts `unknown` for `item`; the item is not type-checked against the array-element schema at call time. The full `writeDoc(..., schema)` call does re-parse the whole document, so a bad `item` will throw at write time rather than silently corrupt — that part of the finding (loophole #2) is partially mitigated by the post-F22 design but the misuse risk remains because the API contract is permissive.

## 2. Who calls it

Lexical search inside [src/](../../../../src/):

- Definition: [src/store/documents.ts](../../../../src/store/documents.ts#L107).
- Test callers only:
  - [src/store/documents.test.ts](../../../../src/store/documents.test.ts#L14) — import.
  - [src/store/documents.test.ts](../../../../src/store/documents.test.ts#L146) — `describe("appendDoc")` case 1 (append to existing).
  - [src/store/documents.test.ts](../../../../src/store/documents.test.ts#L158) — `describe("appendDoc")` case 2 (default-doc seed).
  - [src/store/documents.test.ts](../../../../src/store/documents.test.ts#L409) — round-trip "appends to PlanHistory".

Nearest production analogue, plan-history mutation, does not go through `appendDoc`. [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L243) mutates the cached `nextHistory.stages` and then writes the whole document via `writeDoc` under the service's own in-memory cache; the service is the only writer of `plan-history.json` ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts)).

Conclusion: `appendDoc` is dead in production and is the only export of [src/store/documents.ts](../../../../src/store/documents.ts) whose tests exist only to keep itself alive.

## 3. How the codebase already handles read-modify-write loci

There is no shared "doc mutex" surface in [src/store/](../../../../src/store/). Each subsystem that genuinely owns a read-modify-write file has reached for the locking primitive that fits its constraints:

- Auth profile store: cross-process readers/writers because login subcommands run in short-lived CLIs while a daemon may be running. G36 ([../G36/APPROVED.md](../G36/APPROVED.md)) lands a lockfile-based `withProfilesLock` + reload-inside-CS `mutateProfiles` helper module-private to [src/auth/store.ts](../../../../src/auth/store.ts).
- Knowledge lifecycle: same-process orchestration only, but two scope-level invariants that require ordering (name collisions, supersede). G38 ([../G38/APPROVED.md](../G38/APPROVED.md)) lands `assertRuntimeLockHeld` for cross-process exclusion plus a module-private `withChainLock` (per-scope queue, per-record-id queue) inside [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts).
- Runtime stash: G06 ([../G06/APPROVED.md](../G06/APPROVED.md)) does no locking at all — files are UUID-unique, so the only fix is the in-place async-fs migration.

The pattern across all three: locking primitives are **module-private and shaped to their consistency boundary**. None of them is re-exported from a generic helper file. There is no caller that today asks `documents.ts` for a `withDocLock(path, fn)` primitive.

## 4. Why the function exists at all

Two historical reasons, both gone:

- `plan-history.json` was originally appended to entry-by-entry. After F34 it is owned by `PlanService` with an in-memory cache; the cache and `writeDoc` together are the only writer ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L243)). `appendDoc` was never re-targeted.
- Audit JSONL streams (knowledge, notes) are append-only by construction and use line-oriented `appendFile` rather than `appendDoc`; they live in [src/knowledge/store.ts](../../../../src/knowledge/store.ts) and friends.

So the API has been an attractive nuisance: a helpful-looking name with the only safety property a future caller would assume (compound-update atomicity) absent, and no current consumer to anchor the design.

## 5. What changes if we leave it as-is

- It will keep showing up in [docs/api/store/documents/functions/appendDoc.md](../../../../docs/api/store/documents/functions/appendDoc.md) and in the typedoc sidebar, where it advertises a footgun.
- The next reviewer who lands a "small" plan-history compaction or runtime-log rotation has an existing tempting helper one import away.
- It blocks no other approved work — G06/G36/G38 do not touch it.

## 6. Constraints from the approved batch

- G06 already adds a `noSyncFsScanner` carve-out for `recovery.ts` only ([../G06/APPROVED.md](../G06/APPROVED.md)). Any solution for G10 must remain async-fs (no `node:fs` re-introduction).
- G36 reserves the lockfile word for cross-process auth state; nothing else in [src/store/](../../../../src/store/) is cross-process today, so reusing G36's lockfile shape here would over-state the guarantee.
- G38 's `withChainLock` is intentionally module-private. Promoting an identically-shaped primitive into [src/store/documents.ts](../../../../src/store/documents.ts) "for everyone to share" would contradict G38's r2 decision to keep the primitive scoped to its consistency boundary ([../G38/02-design-r2.md](../G38/02-design-r2.md)).
- Architecture-first / no over-engineering / remove rather than maintain (workspace rule): a same-file fix or generalisation cannot be justified for a function with zero production consumers.

## 7. Boundary check vs adjacent findings

- G08 ([../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)) — adjacent (same module) but disjoint surface (`seedProject` in [src/store/project.ts](../../../../src/store/project.ts), not `appendDoc`). Safe to land in parallel.
- G28 ([../G28-plan-server-cross-doc-atomicity-gap.md](../G28-plan-server-cross-doc-atomicity-gap.md)), G29 ([../G29-plan-server-serialize-blocks-reads.md](../G29-plan-server-serialize-blocks-reads.md)) — plan-server atomicity / serialisation. These are the only place "atomic append to plan-history" could ever matter, and they are scoped to PlanService's cache, not to `appendDoc`. Disjoint.
- G30 ([../G30-builtins-filesystem-sync-fs.md](../G30-builtins-filesystem-sync-fs.md)), G36, G06 — async-fs migration family. Disjoint.

No coordination edges force G10 to keep the function alive.
