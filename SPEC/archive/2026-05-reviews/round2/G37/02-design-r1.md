# G37 — Design (r1)

**Finding**: [../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md)
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
**Sibling-pattern references**: [../G30/02-design-r2.md](../G30/02-design-r2.md), [../G36/02-design-r3.md](../G36/02-design-r3.md), F22 round-1 (already landed for `store/documents.ts`).

Two proposals. Both eliminate the sync-fs path through `loadConfig`
and the stale-cache hazard described in
[../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md).
They differ in how much architecture moves with the fix.

---

## Proposal A — Focused fix: async `loadConfig`, delete the cache

### Idea

`loadConfig` becomes async (`fs/promises`) and the module-level
`cached`/`cachedConfigDir` slots — together with the `force`
parameter — are **deleted**. There is no cache to invalidate, so
there is no stale-cache bug. Every call re-parses
`saivage.json` from disk; analysis §3 shows the realistic call rate
is "once per bootstrap plus a few per OAuth refresh", which makes
the parse cost trivial. The `ensureDir` export (sync, unused inside
`src/`) is deleted in the same patch per the project rule on
obsolete code.

Mirrors G36's "no cache; every locked critical section reloads from
disk" stance ([../G36/02-design-r3.md](../G36/02-design-r3.md#L41-L51)),
adapted for a read-mostly path (no lock needed because writers — F22
+ G36 — already use atomic rename + lockfile against the *target*
file).

### `loadConfig` — exact async shape

```ts
// src/config.ts (replaces L259-L281)

import { readFile } from "node:fs/promises";
import { pathExists } from "./store/documents.js"; // F22 helper

export async function loadConfig(projectRoot?: string): Promise<SaivageConfig> {
  const fp = configPath(projectRoot);
  let raw: unknown = {};
  if (await pathExists(fp)) {
    const text = await readFile(fp, "utf-8");
    raw = JSON.parse(text);
  }
  const interpolated = deepInterpolate(raw);
  return configSchema.parse(interpolated);
}
```

Key invariants:

1. No module-level state. The function is referentially transparent
   modulo the disk read and `process.env` interpolation. Concurrent
   callers each get an independent parsed object — safe by
   construction.
2. **`force` parameter removed.** Without a cache the parameter is
   dead. All call sites drop it.
3. `pathExists` is the async F22 primitive
   ([src/store/documents.ts](../../../src/store/documents.ts)). Using
   it lets `node:fs/promises` be imported only inside `config.ts`
   itself and keeps the dependency direction `config → store` —
   `store/documents.ts` does **not** import from `config.ts` today,
   so no cycle is introduced (verified by re-running `tsc`).
4. `JSON.parse` errors propagate. Today's behaviour silently parses
   a malformed file as `{}` because no try/catch wraps the parse
   either — this design preserves that semantics (the Zod
   `configSchema.parse` then runs against the parsed value;
   malformed JSON throws before Zod, which the existing tests
   already exercise on the happy path).

### `resolveProjectRoot` — left sync, scope-justified

`resolveProjectRoot` keeps `existsSync` at
[src/config.ts](../../../src/config.ts#L208). Justification: analysis
§7 risk 4. It is a path-discovery helper consumed by `configPath()`
which is itself called inside synchronous `throw` statements at
[src/providers/router.ts](../../../src/providers/router.ts#L204),
[src/routing/resolver.ts](../../../src/routing/resolver.ts) and
[src/runtime/supervisor.ts](../../../src/runtime/supervisor.ts#L62).
Converting it to async cascades into those error-paths and turns
synchronous error construction into async, which is a much bigger
cross-subsystem move than the finding warrants.

The lint rule (below) explicitly allow-lists `existsSync` in
`resolveProjectRoot`'s file via a per-line carve-out documented in
the regression test.

### `ensureDir` export — deleted

```ts
// DELETE from src/config.ts (L279-L281):
//   export function ensureDir(p: string): void { … }
// DELETE from src/index.ts (L35):
//   ensureDir,
```

Every caller already uses the async `ensureDir` from
[src/store/documents.ts](../../../src/store/documents.ts) (F22). If a
future file imports `ensureDir` from the barrel after the delete,
`tsc` fails the build.

### Files touched

- [src/config.ts](../../../src/config.ts) — full rewrite of L259-L281
  (`loadConfig` + cache + `ensureDir` export). The L1-L258 schema
  block is unchanged. Imports collapse from
  `readFileSync, existsSync, mkdirSync` to none from `node:fs` (the
  `existsSync` at L208 moves to a single `import { existsSync } from "node:fs"`
  reduced to one name; the lint rule allow-lists it for this file).
- [src/index.ts](../../../src/index.ts#L35) — drop `ensureDir`.
- [src/server/bootstrap.ts](../../../src/server/bootstrap.ts#L128) —
  `const config = await loadConfig(project.projectRoot);` (drop
  `true`).
- [src/server/cli.ts](../../../src/server/cli.ts#L289) —
  `const config = await loadConfig(root ?? undefined);`.
- [src/server/cli.ts](../../../src/server/cli.ts#L432) —
  `const cfg = await loadConfig();` (still inside the existing
  try/catch).
- [src/auth/anthropic.ts](../../../src/auth/anthropic.ts):
  L51 `const clientId = (await loadConfig()).oauth.anthropic.clientId;`.
  Same edit at L82 and L166. All three sites are already inside
  `async function` bodies.
- [src/auth/openai-codex.ts](../../../src/auth/openai-codex.ts):
  L61, L92, L176 — same shape.
- [src/auth/github-copilot.ts](../../../src/auth/github-copilot.ts):
  L67, L114 — same shape.
- [src/config.test.ts](../../../src/config.test.ts) — every
  `loadConfig(true, projectRoot)` becomes
  `await loadConfig(projectRoot)`. The two `expect(() => loadConfig(…)).toThrow`
  at L97, L102, L107 become
  `await expect(loadConfig(projectRoot)).rejects.toThrow(…)`.
- [src/store/project.test.ts](../../../src/store/project.test.ts#L79)
  and [L86](../../../src/store/project.test.ts#L86) — `await`.
- [src/auth/defaults.test.ts](../../../src/auth/defaults.test.ts#L51)
  and [L61](../../../src/auth/defaults.test.ts#L61),
  [L72](../../../src/auth/defaults.test.ts#L72) — `await`.
- [src/mcp/builtins.test.ts](../../../src/mcp/builtins.test.ts#L54)
  and [L285](../../../src/mcp/builtins.test.ts#L285) — `await`.
- [src/mcp/fsGuard.test.ts](../../../src/mcp/fsGuard.test.ts#L22) —
  `await`.
- **New** [src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts).
  Consumes `scanForSyncFs` from
  [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts)
  (landed by G30) with `roots: ["src"]`,
  `skipPathContains: [".test.ts", ".d.ts", "src/runtime/stash.ts",
  "src/server/bootstrap.ts", "src/auth/store.ts"]` (the last three
  are existing carve-outs not owned by this finding) and
  `allowedNamedImports: ["createWriteStream", "existsSync"]` —
  asserts the only `node:fs` named-import surface remaining in
  `src/config.ts` is the `existsSync` used by `resolveProjectRoot`.
  Closes the regression class for this module.

### Deletion list

- `let cached: SaivageConfig | null = null;` at
  [src/config.ts](../../../src/config.ts#L259).
- `let cachedConfigDir: string | null = null;` at
  [src/config.ts](../../../src/config.ts#L260).
- The `force` parameter on `loadConfig`
  ([src/config.ts](../../../src/config.ts#L261)) and the
  `if (cached && !force && cachedConfigDir === dir) return cached;`
  branch ([L263](../../../src/config.ts#L263)).
- `const dir = saivageDir(projectRoot);` ([L262](../../../src/config.ts#L262))
  — no longer needed once the cache lookup is gone.
- The `cached = …; cachedConfigDir = dir;` assignments at
  [L271-L272](../../../src/config.ts#L271).
- The `ensureDir` export at
  [L279-L281](../../../src/config.ts#L279) and the `mkdirSync`
  import at [L2](../../../src/config.ts#L2).
- The `ensureDir` re-export at
  [src/index.ts](../../../src/index.ts#L35).

### Public API impact

- `loadConfig` signature changes from
  `(force?: boolean, projectRoot?: string) => SaivageConfig` to
  `(projectRoot?: string) => Promise<SaivageConfig>`.
- `ensureDir` is removed from the `config` module and from the
  barrel.
- No new exports. No new types. No new classes.

### Test impact

Eight cases, all in
[src/config.test.ts](../../../src/config.test.ts) unless noted.

1. **Empty config dir** — `await loadConfig(projectRoot)` returns
   Zod defaults. (Existing test, signature updated.)
2. **Interpolates `${ENV_VAR}` strings** — existing test.
3. **MCP shellTimeoutMs floor validation** — existing test,
   rewritten to `await expect(...).rejects.toThrow(/WALL_CLOCK_HEADROOM_MS/)`.
4. **Two concurrent loaders see independent snapshots** — new test.
   `await Promise.all([loadConfig(projectRoot), loadConfig(projectRoot)])`;
   assert both succeed; assert mutating one returned object does not
   affect a third call. Regression guard for "someone reintroduces
   the cache".
5. **Edit-after-load sees the edit** — new test. Call
   `await loadConfig(projectRoot)`, write a new `saivage.json` with
   a different `mcp.shellTimeoutMs`, call again, assert the second
   call reflects the new value. Directly exercises the bug the
   finding describes (operator edits `saivage.json`; in-process
   readers should see the change at the next call).
6. **Malformed JSON rejects** — new test. Write
   `saivage.json` containing `"not json"`; assert
   `await loadConfig(...)` rejects with a `SyntaxError`. Documents
   the (preserved) crash-fast behaviour.
7. **No sync-fs in `src/config.ts`** —
   [src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts)
   per Files touched above.
8. **`ensureDir` is no longer in the barrel** — new test in
   [src/index.test.ts](../../../src/index.test.ts) (created if it
   does not exist; one assertion). Imports `* as barrel from "./index.js"`
   and asserts `"ensureDir" in barrel === false`. Cheap, but stops
   future accidental re-export.

### What it does NOT do (deliberately)

- **No `fs.watch`.** Analysis §3 explains why watch-based
  invalidation is a feature, not a bugfix: long-lived consumers
  (Router/Resolver/Supervisor) snapshot config at construction and
  do not re-read. Adding a watcher in `config.ts` would not change
  their behaviour; it would only mask the deeper architectural
  promise that "edit saivage.json, restart-free".
- **No `reloadConfig()` API.** Same reason. The deletion of the
  cache makes every call a fresh read; there is nothing to reload.
- **No SIGHUP handler.** Out of scope; would have the same propagation
  problem.
- **No HTTP `PUT /api/config` endpoint.** That belongs to a future
  reactive-config feature (Proposal B) or its own finding.
- **No conversion of `resolveProjectRoot` to async.** Justified in
  the section above; the lint rule documents the carve-out.

### Risk

1. **`tsc` cascade through three auth modules + bootstrap + cli +
   eight tests.** All mechanical, all caught at compile time.
2. **Per-call parse cost.** Profiling estimate: parsing the typical
   `saivage.json` (< 4 KB) plus Zod validation is < 1 ms. Called
   roughly once per bootstrap and 1–3 times per OAuth refresh
   (≤ once/hour per provider). Negligible.
3. **Race: a partial write of `saivage.json` could be observed by a
   concurrent `loadConfig`.** F22 (and G36 for the auth file) write
   via tmp + atomic rename; if operators edit `saivage.json`
   directly with a non-atomic editor (e.g. `>` shell redirect), a
   reader can race the write. Out of scope: operators already need
   atomic edits today (see the
   [memory note about `.saivage/saivage.json` mode preservation](file:///home/salva/g/ml/.github/copilot-instructions.md));
   nothing new.

---

## Proposal B — Level-up: reactive `ConfigStore` with `fs.watch` and listeners

### Idea

Introduce a `ConfigStore` singleton constructed at bootstrap with
the resolved project root. It owns the parsed `SaivageConfig`,
watches `saivage.json` via `fs.watch`, debounces change events,
re-parses on change, and notifies subscribers. `ModelRouter`,
`ModelRoutingResolver`, `RuntimeSupervisor`, and MCP builtins
subscribe and rebuild their derived state on change. A new
`PUT /api/config` endpoint validates an incoming JSON body against
`configSchema` and atomically writes `saivage.json`, which triggers
the same propagation path.

### Sketch

```ts
// src/config/store.ts (new)
export class ConfigStore {
  private current!: SaivageConfig;
  private listeners = new Set<(c: SaivageConfig) => void>();
  private watcher: FSWatcher | null = null;
  private constructor(private readonly projectRoot: string) {}

  static async create(projectRoot: string): Promise<ConfigStore> { … }
  snapshot(): SaivageConfig { return this.current; }
  onChange(fn: (c: SaivageConfig) => void): () => void { … }
  async update(next: SaivageConfig): Promise<void> { /* atomic write + reparse */ }
  close(): void { this.watcher?.close(); }
}
```

`bootstrap` instantiates one `ConfigStore`, places it on
`SaivageRuntime`. `ModelRouter` constructor takes a `ConfigStore`
instead of a `SaivageConfig`; same for `ModelRoutingResolver` and
`RuntimeSupervisor`. Each registers an `onChange` handler that
recomputes derived state (model assignments, provider index,
equivalence map, supervisor model).

### Files touched

- New: `src/config/store.ts`, `src/config/store.test.ts`,
  `src/config/index.ts` (barrel restored at module path
  `./config/index.ts` — moved from the current
  [src/config.ts](../../../src/config.ts) single-file shape).
- Renamed: `src/config.ts` → `src/config/loader.ts`.
- Rewritten: every site that takes `SaivageConfig` as a parameter
  becomes a `ConfigStore` consumer (~12 files: `ModelRouter`,
  `ModelRoutingResolver`, `RuntimeSupervisor`, bootstrap, server,
  MCP builtins, prompt-injection-cop, channels/telegram, plan
  service, etc.).
- New endpoint: `PUT /api/config` in
  [src/server/server.ts](../../../src/server/server.ts#L201).
- Test additions: store fs.watch determinism, debounce semantics,
  PUT validation, propagation to Router/Resolver/Supervisor.

### Why this is rejected

- **Scope creep.** The finding's severity is medium and the bug is
  "sync fs + cache that never invalidates". Proposal B addresses the
  *aspiration* in the finding's prose ("operators expect to swap
  providers without restart") which the current architecture cannot
  deliver from a `config.ts` change alone — analysis §3 enumerates
  every downstream snapshot that would need to become reactive.
- **Cost/benefit.** Routing decisions are encoded into long-lived
  agent loops; even with a reactive Router, in-flight agents would
  keep using the snapshot they were started with. The user-visible
  effect of "edit saivage.json without restart" is therefore
  inconsistent across agents in a way that hot-swap semantics make
  hard to reason about.
- **Cross-cutting.** Touches 12 files and the public WS/HTTP surface.
  Belongs in its own dedicated finding once an operator
  user-story justifies it.
- **Violates the project rule "avoid over-engineering".**

---

## Coordination

- **G30 (APPROVED).** Reuse
  [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts)
  verbatim for the new
  [src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts).
  No new shared infrastructure; one allow-list entry (`existsSync`)
  for the file.
- **G36 (APPROVED).** Independent. G36 owns `auth/store.ts` (profile
  read/write); G37 owns the `loadConfig()` calls in
  `auth/anthropic.ts`, `auth/openai-codex.ts`,
  `auth/github-copilot.ts` (client-id lookup). Different functions
  in different files; either order lands cleanly. If G36 lands
  first, G37 just adds three more `await`s in `auth/*.ts` alongside
  G36's already-async helpers. If G37 lands first, G36's edits
  rebase without touching G37's lines.
- **F22 round-1.** Reuses `pathExists` from
  [src/store/documents.ts](../../../src/store/documents.ts).

## Recommendation

**Proposal A.** Deleting the cache is the architecture-correct fix
for this finding because the cache is the source of the staleness
hazard and the only consumers that benefit from it (three
client-id reads per OAuth refresh) re-parse a 4 KB file in well
under a millisecond. The `force` parameter and the dead `ensureDir`
export die with it, satisfying the project rules on obsolete code
and architecture-first.
