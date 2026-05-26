# G38 — Analysis r1

## Functional analysis

The knowledge store advertises a per-record mutual-exclusion contract
via two module-scoped `Map<string, Promise<void>>` chains in
[src/knowledge/store.ts](../../../../src/knowledge/store.ts#L67-L82):

- `recordLocks` — keyed by `recordLockKey({kind, scope, scope_ref, id})`,
  intended to serialise writers of a single record JSON
  ([src/knowledge/store.ts](../../../../src/knowledge/store.ts#L68-L82)).
- `scopeLocks` — keyed by `scopeLockKey(kind, scope, scope_ref)`,
  intended to serialise index rebuilds of a whole scope subtree
  (`<scope>/index.json`).

Both helpers (`acquireRecordLock`, `acquireScopeLock`,
`acquireTwoRecordLocks`) are pure in-process primitives; they never
touch the filesystem and provide no protection across Node processes
that share the same `.saivage/` tree.

### Where the locks are actually used

The locks are *exported* but the call graph is much smaller than the
file's comments suggest. A workspace-wide grep for the acquire
helpers shows:

- [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L23) /
  [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L587-L597)
  — `supersedeMemory` is the **only** lifecycle entry point that
  takes a record lock. It acquires a single per-record lock around the
  load-modify-write sequence on the old record.
- [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts#L21-L98)
  — primitive tests for the lock helpers.
- [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts#L10-L85)
  — store-layer tests.

Every other authoring path — `createSkill`, `updateSkill`,
`archiveSkill`, `deleteSkill`, `supersedeSkill`, `createMemory`,
`updateMemory`, `archiveMemory`, `deleteMemory`, `archiveStage`,
`archiveSession` (collectively
[src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L222-L948))
— writes the record JSON + body + audit + rebuilt index **without
acquiring any lock at all**. The "atomicity" guarantee these paths
rely on is the per-file rename-after-fsync inside `writeDoc`
([src/store/documents.ts](../../../../src/store/documents.ts#L73-L102)),
plus the POSIX `O_APPEND` guarantee for `audit.jsonl` (capped at
`PIPE_BUF`, see
[src/knowledge/store.ts](../../../../src/knowledge/store.ts#L60-L62) and
[src/knowledge/store.ts](../../../../src/knowledge/store.ts#L260-L296)).

The eager-loader read path ([src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L1-L100))
takes no locks either — design §C.3 expects readers to tolerate the
brief window during an atomic rename.

### What the locks really protect

Given the call graph above, today's `recordLocks`/`scopeLocks` provide
exactly one real guarantee: when **two concurrent same-process
`supersedeMemory` calls target the same old id**, exactly one wins and
the other is rejected with `INVALID_SUPERSEDE_TARGET`. That guarantee
is asserted by
[src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts#L186-L221).
Everything else the comments imply — "per-record mutex serialising all
writes", "two-key supersede lock", "per-scope index lock" — is
documentation aspiration, not behaviour.

### What the locks fail to protect, in theory

`recordLocks`/`scopeLocks` are `Map` instances on the V8 module
graph. A second Node process attaching to the same `.saivage/` tree
sees its own empty maps. Therefore, if two processes ever write to
the same scope at the same time, the only on-disk protection is:

- `writeDoc` rename atomicity per file (record JSON, `index.json`).
- `O_APPEND` short-line atomicity per `audit.jsonl` line.

Concretely, two processes racing on the same scope can:

- **Lose an index rebuild.** Both compute their own `entries` array
  from the current `records/` directory and call `writeDoc` on
  `index.json`. Last writer wins; the loser's entries are lost. Next
  reader sees a stale index that omits records present on disk. The
  next mutation will rebuild and silently repair it.
- **Lose a `supersede_*`.** Both call `supersedeMemory` with the same
  `old_id`; both pass the "is active" check on disk (no atomic CAS),
  both write a `NEW` record JSON, both rewrite `OLD.status =
  superseded` with **different** `superseded_by` fields. Last writer
  wins on `OLD.json`; the loser's chain head dangles. The two-key
  invariant the design promises (`OLD.superseded_by → NEW`,
  `NEW.supersedes → OLD`) is broken.
- **Duplicate `name`/`topic`.** Two concurrent `createSkill` calls on
  the same scope pass the in-memory active-name check on different
  process snapshots; both write their record JSON. Active-scope
  uniqueness (FR-29 corollary) is violated.

These are real algorithmic windows. None of them have ever been
reported because, in practice, no two processes share `.saivage/`.

### What today's operational layout actually does

Verified live container layout (per workspace handoff and
`/home/salva/g/ml/.github/copilot-instructions.md`):

| Container | IP | Project root targeted | `.saivage/` shared? |
| --- | --- | --- | --- |
| `saivage` | 10.0.3.111 | `/opt/saivage` (binary tree, not a Saivage *project*) | no |
| `saivage-v3` | 10.0.3.112 | `/work/saivage-v3` | no |
| `saivage-v3-getrich-v2` | 10.0.3.170 | `/work/getrich-v2` | no |
| `diedrico` | 10.0.3.113 | `/work/diedrico` | no |

Bind mounts on the `saivage` container map host
`/home/salva/g/ml/saivage` → `/opt/saivage`. That directory is the
saivage source/build tree; it is never a target project, and `.saivage/`
under it (if any) is a developer artefact. The other three containers
each own a distinct `/work/<name>` project, and the host does not run
a daemon against any of them.

Within a single Saivage daemon, multi-writer is already prevented by
the runtime-lock primitive
[src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L83-L150):
`acquireRuntimeLock(saivageDir)` does `openSync(lockPath, "wx")` on
`.saivage/tmp/state/runtime.lock` and refuses to start if a live PID
holds it. Every entry point that can write to the knowledge tree goes
through `bootstrap()` and therefore through `acquireRuntimeLock`:

- `saivage serve` — [src/server/cli.ts](../../../../src/server/cli.ts#L64-L70).
- `saivage inspect …` — [src/server/cli.ts](../../../../src/server/cli.ts#L224-L229).
- `runPlanner` and all in-process child agents
  ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts) spawns
  agents *in the same Node process* via `ChildSpawner`).

So the cross-process race the finding describes does **not** occur
today on any supported deployment. It is theoretical, and the design
document already acknowledges it as a non-goal:

> **Cross-process concurrency on the same `.saivage/` (C.3):**
> explicit non-goal. … Running two `saivage` CLIs against the same
> project is unsupported and may corrupt indexes/audits.
> ([SPEC/v2/skills-memory/01-DESIGN.md](../../skills-memory/01-DESIGN.md#L965-L975))

### What is actually broken

The misalignment is between **what the code's comments and helper
names promise** and **what the code delivers**:

1. The header comment of [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L1-L11)
   says the file implements "per-record + per-scope mutexes, and the
   two-key supersede lock". The two-key lock is half-implemented:
   `acquireTwoRecordLocks` exists and is tested, but no production
   caller uses it (`supersedeMemory` takes only one record lock and
   `supersedeSkill` takes none, see
   [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L398-L450)).
2. The lock helpers are exported as if they were the store's
   concurrency primitive, but the only enforcement vs concurrent
   processes is the runtime-lock at `.saivage/tmp/state/runtime.lock`.
   The store layer has no awareness of that lock.
3. The design's "non-goal" documentation is buried in §K of a 1100-line
   spec; nothing at the code boundary fails fast if an operator
   accidentally creates a second process against the same `.saivage/`.
   The first symptom would be a corrupted `index.json` or a broken
   supersede chain, which is exactly the silent-corruption mode the
   finding warns about.

### Failure scenarios that can occur today

- **Operator accidentally runs `saivage inspect <p>` while
  `saivage serve <p>` is running.** `bootstrap()` calls
  `acquireRuntimeLock` → `EEXIST` → throws "Another Saivage instance
  is already running" ([src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L140-L143)).
  No knowledge writes happen. **Safe today, by accident.** The runtime
  lock catches it before it can race on the knowledge store.
- **Operator deletes a stale `runtime.lock` manually and starts a
  second daemon.** Both daemons accept tools; both may concurrently
  authoring to skills/memory; corruption possible per the list above.
  This is currently the only path to the failure mode the finding
  describes, and it requires explicit operator misconfiguration.
- **A test file (e.g. a future `lifecycle.race.test.ts`) writes to a
  shared `.saivage/` from two child processes.** No production
  deployment does this; vitest tests use fresh `mkdtempSync` roots.

### Cross-finding coupling (G39)

The same `acquire()` helper at
[src/knowledge/store.ts](../../../../src/knowledge/store.ts#L88-L100)
is the subject of G39 (lock-chain poisoning on rejection). Whatever
remediation G38 picks must not regress G39: if we keep the
`Map<Promise>` chain we must also fix the poison bug; if we delete
the chain in favour of a different primitive, G39 dissolves with it.

## Affected code

- [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L67-L82) — `recordLocks`, `scopeLocks` module-scoped maps.
- [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L74-L100) — `recordLockKey`, `scopeLockKey`, `acquire`, `acquireRecordLock`, `acquireScopeLock`, `acquireTwoRecordLocks`.
- [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L1-L11) — header comment claiming "per-record + per-scope mutexes, and the two-key supersede lock".
- [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L23-L34) — imports of the lock helpers.
- [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L585-L600) — sole production use (`supersedeMemory`).
- [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L398-L450) — `supersedeSkill`, which lacks the lock entirely (same hazard).
- [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts#L21-L98) — primitive tests.
- [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts#L10-L85) — store-layer tests of the same primitives.
- [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L83-L150) — existing runtime-lock primitive (the actual single-writer enforcer).
- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L180) — only call site of `acquireRuntimeLock`.
- [SPEC/v2/skills-memory/01-DESIGN.md](../../skills-memory/01-DESIGN.md#L965-L975) — explicit non-goal §K.

## Constraints

- Architecture-first, no migration shims, no backward compatibility:
  the fix is allowed (and expected) to delete code rather than wrap
  it in compatibility shims.
- The skills/memory design (`01-DESIGN.md` §K) explicitly rejects
  `flock(2)` as redundant under the single-writer invariant. Any
  remediation that introduces filesystem locks must justify
  overturning that decision and update §K accordingly.
- Live daemons (`saivage`, `saivage-v3`, `saivage-v3-getrich-v2`,
  `diedrico`) all enforce single-writer via `runtime.lock` already;
  the operational layout never points two daemons at the same
  `.saivage/`. The fix must not break that working invariant.
- G39 lives in the same `acquire()` helper. Whichever remediation we
  pick for G38 must coordinate with G39 (either both keep the chain
  and fix its poison bug, or both drop the chain together).
- Tests in [src/knowledge/concurrency.test.ts](../../../../src/knowledge/concurrency.test.ts)
  and [src/knowledge/store.test.ts](../../../../src/knowledge/store.test.ts)
  pin the current primitive API; deleting the helpers requires
  rewriting those test files (no migration shim).

## Theoretical vs real risk — summary

| Failure | Reachable on supported deployment? | Caught today by | If unprotected, blast radius |
| --- | --- | --- | --- |
| Two daemons on one `.saivage/` racing on `index.json` | No (blocked by `runtime.lock`) | `acquireRuntimeLock` `EEXIST` | corrupted `index.json` (auto-healed on next mutation) |
| Two daemons racing on `supersedeMemory` | No (same) | same | broken supersede chain, dangling `OLD.superseded_by` |
| Two daemons racing on `createSkill` name | No (same) | same | duplicate active name in scope |
| Single daemon, two same-process `supersedeMemory` | Yes (in-process child agents) | `acquireRecordLock` in `supersedeMemory` | nothing — already serialised |
| Single daemon, two same-process `createSkill` | Yes | (nothing) | both writes succeed; `NAME_COLLISION` check is racy in-process |
| Operator removes `runtime.lock` and starts second daemon | Yes (manual misconfig) | nothing | full corruption per first three rows |

The gap is therefore narrower than "process-local locks are unsafe":
the actual gap is **the store layer trusts that some upstream
primitive enforces single-writer, but nothing in the store layer
asserts or documents that contract**, and the existing in-process
locks paper over the contract in a way that misleads readers.
