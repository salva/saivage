# G10 — Design r1

**Finding**: [../G10-appenddoc-read-modify-write-race.md](../G10-appenddoc-read-modify-write-race.md)
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

Three proposals follow. **Proposal C (delete) is recommended.** A and B are spelled out at design fidelity so the reviewer can see exactly what they cost relative to C.

---

## Proposal A — In-place fix: private per-path async mutex inside `appendDoc`

### Sketch

Add a module-private `Map<string, Promise<void>>` to [src/store/documents.ts](../../../../src/store/documents.ts) and wrap the read-modify-write body in a `withChainLock(path, fn)` that uses the G38-style `prev.catch(()=>{}).then(()=>next)` shape ([../G38/02-design-r2.md](../G38/02-design-r2.md)). Helper and map are not exported.

### Files touched

- [src/store/documents.ts](../../../../src/store/documents.ts#L104-L128) — wrap the body of `appendDoc` in `withChainLock(path, async () => { … existing body … })`. Add `const docMutexes = new Map<string, Promise<void>>();` and a `withChainLock(key, fn)` helper, both file-private.
- [src/store/documents.test.ts](../../../../src/store/documents.test.ts) — add one new test case: fire 100 concurrent `appendDoc(p, "stages", { id: i }, schema, { } as never)` calls; assert `stages.length === 100` and all ids present.

### What it does not fix

- Same-machine **cross-process** concurrent writers (e.g. two CLI invocations) still race; an in-process map is the wrong primitive for that. G36 had to reach for `flock`-style lockfiles for exactly this reason ([../G36/APPROVED.md](../G36/APPROVED.md)).
- The `item: unknown` argument is still type-unchecked at call time; the lock does not address the "schema constraint loophole" raised in the finding.
- The function still has no production caller. The lock exists to protect a write path that nothing in `src/` invokes.

### Why this is in the design at all

It is the minimum diff that closes the documented race assuming we keep the function. It is rejected below.

---

## Proposal B — One conceptual level up: shared `withDocLock(path, fn)` primitive

### Sketch

Promote the per-path mutex of Proposal A into a publicly exported helper of [src/store/documents.ts](../../../../src/store/documents.ts), then route every existing read-modify-write writer through it:

```ts
export async function withDocLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
```

Convert callers:

- [src/auth/store.ts](../../../../src/auth/store.ts) `mutateProfiles` — would become `withDocLock(profilesPath, () => …)`. **Collides with G36 APPROVED** ([../G36/APPROVED.md](../G36/APPROVED.md)), which has already landed a lockfile (cross-process) — an in-process `Map` is strictly weaker.
- [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts) `withChainLock`/`withScopeLifecycleLock`/`withSupersedeLock` — would become path-keyed `withDocLock` calls. **Collides with G38 APPROVED** ([../G38/APPROVED.md](../G38/APPROVED.md)), which deliberately keys per-scope and per-record-id rather than per-file (the file is `index.json` for every scope under a kind, so a per-path key collapses scopes that today proceed in parallel and serialises them serially). It would also re-trigger G39's lock-chain poisoning unless the helper is implemented with `prev.catch(()=>{})`.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) — already single-writer with an in-memory cache; the lock would be pure overhead.

### Files touched (intent)

- [src/store/documents.ts](../../../../src/store/documents.ts) — new exported `withDocLock` + module-private map. Wrap `appendDoc`.
- [src/auth/store.ts](../../../../src/auth/store.ts) — replace G36's `withProfilesLock` with `withDocLock`. **Requires re-opening G36.**
- [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts) — replace G38's two queues with `withDocLock`. **Requires re-opening G38.** Re-introduces the G39 risk surface unless `withDocLock` adopts the G38 chain shape exactly.

### Why rejected

- Both call-site conversions contradict APPROVED designs that explicitly kept their lock primitives module-private because the consistency boundary differs (cross-process vs same-process; per-scope vs per-record-id vs per-file). A "shared primitive" only saves code when the shape genuinely matches; here it does not, and the analysis (§3) shows the precedent is to keep them private.
- It is the canonical "generalise for hypothetical callers" anti-pattern. There is no current call site outside G36/G38 that needs locked compound writes, and the project rule is "no over-engineering".
- The G36 lockfile and the G38 chain disagree on a fundamental contract (cross-process vs same-process). One `withDocLock` cannot satisfy both without becoming a polymorphic switch, which is more code than the two private helpers combined.

---

## Proposal C — Delete `appendDoc` and its tests (recommended)

### Sketch

Remove the function, the import, the two `describe("appendDoc")` cases, and rewrite the one round-trip test that uses `appendDoc` to use `writeDoc` directly (it was only asserting that `PlanHistorySchema` round-trips; that property is preserved). Regenerate typedoc.

### Direction rationale

- Production has zero callers (analysis §2). No subsystem owns a use case that needs the function. The two real read-modify-write loci in the codebase have already shipped the right primitive for their boundary (G36 lockfile, G38 per-scope chain).
- Workspace rule "remove rather than maintain, no migration shims, no over-engineering" ([WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md)) applies directly.
- Removes the attractive-nuisance trap the finding flags: future contributor uses the name expecting compound-update atomicity and silently drops entries.
- Eliminates the schema-constraint loophole entirely by removing the surface, not by patching it.

### Files touched

1. [src/store/documents.ts](../../../../src/store/documents.ts) — delete the `appendDoc` JSDoc + function body (lines 104–128). No other code in the file references it.
2. [src/store/documents.test.ts](../../../../src/store/documents.test.ts) — three edits, see [03-plan-r1.md](03-plan-r1.md) for exact strings:
   - line 14: remove `appendDoc,` from the import group.
   - lines 133–163: delete the `// ─── Append tests …` block and the entire `describe("appendDoc", …)` it introduces.
   - lines 396–419: rewrite the "appends to PlanHistory" round-trip test to use `writeDoc(path, { stages: [entry] }, PlanHistorySchema)` instead of `appendDoc(...)`; assertion remains `stages.length === 1` and `stages[0].id === "stg-1"`. The rename of the test name to "writes and reads a PlanHistory" reflects the new shape.
3. Docs:
   - [docs/api/store/documents/functions/appendDoc.md](../../../../docs/api/store/documents/functions/appendDoc.md) — typedoc-generated, will be removed by `npm run docs:api` (the `docs:api` script regenerates the whole `api/` tree per [package.json](../../../../package.json#L22)).
   - Hashmap and sidebar entries (`docs/.vitepress/dist/hashmap.json`, `docs/api/typedoc-sidebar.json`) are also typedoc/build outputs and regenerate together.
   - No hand-edits to `docs/api/` are part of this change; the regeneration step is mentioned as an optional follow-up in [03-plan-r1.md](03-plan-r1.md) because the `dist/` artefacts are only produced by `npm run docs:build` and are not on the test/build critical path.

### Public-API impact

- `appendDoc` is removed from [src/store/documents.ts](../../../../src/store/documents.ts) exports. There is no [src/index.ts](../../../../src/index.ts) re-export of it (verified: [src/index.ts](../../../../src/index.ts) re-exports `PlanHistory` but nothing from `store/documents`). External consumers that imported via deep import `saivage/dist/store/documents` would break, but per the architecture-first / no-backward-compat rule and the fact that no in-tree caller exists, this is the intended outcome.

### Daemon impact

None. The function is unreachable from any served entrypoint. No `saivage`, `diedrico`, or `saivage-v3` restart is required by the code change. (Operator-gated rebuild + restart is still listed in the plan as the standard sanity step, but it is not blocking.)

### Coordination

- G06 ([../G06/APPROVED.md](../G06/APPROVED.md)) — disjoint file ([src/runtime/stash.ts](../../../../src/runtime/stash.ts)). Land in any order.
- G36 ([../G36/APPROVED.md](../G36/APPROVED.md)) — disjoint file ([src/auth/store.ts](../../../../src/auth/store.ts)). Land in any order.
- G38 ([../G38/APPROVED.md](../G38/APPROVED.md)) — disjoint file ([src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts)). Land in any order.
- G08 — same module ([src/store/documents.ts](../../../../src/store/documents.ts) is unrelated to `seedProject` edits in [src/store/project.ts](../../../../src/store/project.ts)). Order-independent; no merge conflict expected.

### Risk

- Risk 1: An out-of-tree consumer (e.g. an in-progress patch on a feature branch) imports `appendDoc`. Mitigation: tsc will surface the import as `TS2305: Module '"./documents.js"' has no exported member 'appendDoc'`. No silent breakage.
- Risk 2: Typedoc fails because the sidebar JSON references the now-missing function. Mitigation: typedoc regenerates the sidebar from source on every `docs:api` run, so this resolves itself the next time docs are built. Not a critical-path failure for `npm test` or `npm run build`.

---

## Recommendation

**Proposal C.** It is the only proposal consistent with the analysis (no production caller, no shared-primitive opportunity that doesn't contradict G36/G38) and with the workspace's architecture-first rule. Implementation plan in [03-plan-r1.md](03-plan-r1.md).
