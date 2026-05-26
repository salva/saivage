# G37 — Analysis (r1)

**Finding**: [../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md)
**Subsystem**: config (Types & config row in [../00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md))
**Severity**: medium — bad-design, module-level transversality
**Sibling findings**: G30 (mcp builtins sync fs — APPROVED, see
[../G30/APPROVED.md](../G30/APPROVED.md)), G36 (auth store sync fs —
APPROVED, see [../G36/APPROVED.md](../G36/APPROVED.md)), F22 round-1
(store/documents async migration — already landed).

---

## 1. What the code actually does today

[src/config.ts](../../../src/config.ts) is the only loader for
`SaivageConfig` and is consumed by bootstrap, CLI subcommands, the
three OAuth driver modules, and tests.

Sync-fs surface (only four call sites in this file):

- [src/config.ts](../../../src/config.ts#L2) imports `readFileSync`,
  `existsSync`, `mkdirSync` from `node:fs` — the only `node:fs` named
  imports left in this module after F22.
- [src/config.ts](../../../src/config.ts#L208) inside
  `resolveProjectRoot`: walks parent directories with
  `existsSync(join(saivage, "config.json"))` to anchor the
  project root.
- [src/config.ts](../../../src/config.ts#L268-L269) inside
  `loadConfig`: `existsSync(fp) && readFileSync(fp, "utf-8")`.
- [src/config.ts](../../../src/config.ts#L279-L281) exported
  `ensureDir(p)`: `existsSync(p) || mkdirSync(p, { recursive: true })`.
  Re-exported from [src/index.ts](../../../src/index.ts#L35) but never
  imported by `src/` after F22 (see audit below).

Cache surface:

- Module-level `cached: SaivageConfig | null` and
  `cachedConfigDir: string | null` at
  [src/config.ts](../../../src/config.ts#L259-L260).
- `loadConfig(force = false, projectRoot?)` returns the cached object
  when `!force && cachedConfigDir === dir`. No mtime check, no
  `fs.watch`, no API to invalidate from outside the module.
- `force=true` is passed by [bootstrap](../../../src/server/bootstrap.ts#L128),
  by the `models` CLI subcommand
  [src/server/cli.ts](../../../src/server/cli.ts#L289), and by every
  test fixture that wants a clean load. It still performs sync fs.

## 2. Call graph (every caller in `src/` after F22)

| Caller | Site | Pattern | Already async context? |
|---|---|---|---|
| `bootstrap` | [src/server/bootstrap.ts](../../../src/server/bootstrap.ts#L128) | `loadConfig(true, project.projectRoot)` once per boot | yes (`async function bootstrap`) |
| `models` CLI | [src/server/cli.ts](../../../src/server/cli.ts#L289) | `loadConfig(true, root)` once per invocation | yes (`.action(async …)`) |
| `login` CLI (Copilot headers branch) | [src/server/cli.ts](../../../src/server/cli.ts#L431-L432) | `loadConfig()` in a try/catch fallback | yes |
| `auth/anthropic.ts` `exchangeCode` | [src/auth/anthropic.ts](../../../src/auth/anthropic.ts#L51) | `loadConfig().oauth.anthropic.clientId` | yes (`async function exchangeCode`) |
| `auth/anthropic.ts` `refreshAccessToken` | [src/auth/anthropic.ts](../../../src/auth/anthropic.ts#L82) | same | yes |
| `auth/anthropic.ts` (third site) | [src/auth/anthropic.ts](../../../src/auth/anthropic.ts#L166) | same | yes |
| `auth/openai-codex.ts` (three sites) | [src/auth/openai-codex.ts](../../../src/auth/openai-codex.ts#L61) [L92](../../../src/auth/openai-codex.ts#L92) [L176](../../../src/auth/openai-codex.ts#L176) | `loadConfig().oauth.openaiCodex.clientId` | yes (all OAuth driver functions are async) |
| `auth/github-copilot.ts` (two sites) | [src/auth/github-copilot.ts](../../../src/auth/github-copilot.ts#L67) [L114](../../../src/auth/github-copilot.ts#L114) | `loadConfig().oauth.githubCopilot.clientId` | yes |
| Tests | [src/config.test.ts](../../../src/config.test.ts), [src/store/project.test.ts](../../../src/store/project.test.ts#L79), [src/auth/defaults.test.ts](../../../src/auth/defaults.test.ts#L51), [src/mcp/builtins.test.ts](../../../src/mcp/builtins.test.ts#L54), [src/mcp/fsGuard.test.ts](../../../src/mcp/fsGuard.test.ts#L22) | `loadConfig(true, projectRoot)` | all vitest `async` |

Important: **no synchronous caller exists.** Every consumer of
`loadConfig` is already in an `async` context. Making the function
async is a pure cascade with no new colour boundary.

## 3. What the cache actually buys, and what it costs

### Cache hit ratio under realistic workloads

- Bootstrap: one call with `force=true`. Cache miss.
- CLI `models`/`login`: one call. Cache miss (process exits).
- Auth flows during OAuth handshake: 2–3 calls within a single
  `exchangeCode`/`refreshAccessToken` invocation; each reads
  `oauth.<provider>.clientId`. Realistic hit rate during a refresh
  storm is "two reads per token expiry, < once per hour".

The cache exists for the three reads of `oauth.*.clientId` inside an
OAuth refresh. That is the entire benefit. Cost:

1. **Stale-data hazard.** Once the cache is populated, no edit to
   `saivage.json` is ever observed by an in-process consumer until a
   long-running daemon (`saivage`, `saivage-v3`, `diedrico` per
   [../00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)) is restarted.
   The issue ([../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md))
   correctly calls this out.
2. **Per-process global state.** `cached` is module-level, so unit
   tests that create multiple project fixtures share the same slot
   and depend on `force=true` plus `cachedConfigDir` discrimination
   to avoid cross-contamination. Subtle, undocumented invariant.
3. **`force=true` is sync-fs anyway.** Even when callers opt out of
   the cache, the read still blocks the event loop.

### Stale-cache scope — what propagates and what does not

This is the architectural reality the issue's "rough remediation
direction" elides: even with `fs.watch`-backed cache invalidation,
**most consumers would still see stale data** because they capture a
config snapshot at construction time. Specifically:

- `ModelRouter` (provider list, equivalence indices) is built once
  from `config.providers` at
  [bootstrap](../../../src/server/bootstrap.ts#L128) and never
  re-reads it.
- `ModelRoutingResolver` reads `config.models` once.
- `RuntimeSupervisor` reads `config.supervisor` once.
- MCP `builtins` reads `config.mcp.shellTimeoutMs` etc. at register
  time.

The only consumers that actually re-read on every call are the
three `oauth.*.clientId` accessors in `auth/`. Everything else is a
boot-time snapshot. Therefore "operators expect to swap providers
without a restart" is a promise the current architecture cannot
keep, and an `fs.watch` plus `dirty` flag on `loadConfig` alone
would not deliver it. Honouring it would require turning the entire
provider/router/resolver/supervisor surface reactive — a
cross-subsystem refactor that is far outside the scope of a medium-
severity bad-design finding.

That conclusion drives the design choice (see
[02-design-r1.md](02-design-r1.md#L0)): **delete the cache instead
of trying to keep it fresh.**

## 4. Audit of the `node:fs` allow-list across `src/`

For consistency with G30's audit table approach
([../G30/APPROVED.md](../G30/APPROVED.md)) and to plug this finding
into the same lint-rule surface, the table below records every
remaining `node:fs` named import in `src/` after F22 + G30 (assumed
landed; G36 still pending).

| File | Imports | Status after G37 |
|---|---|---|
| [src/config.ts](../../../src/config.ts#L2) | `readFileSync, existsSync, mkdirSync` | **Removed by G37** — replaced by `fs/promises` and `pathExists` from store/documents. |
| [src/server/bootstrap.ts](../../../src/server/bootstrap.ts#L16) | `writeFileSync` | Out of scope (fatal-handler path). Tracked elsewhere or carve-out. |
| [src/runtime/stash.ts](../../../src/runtime/stash.ts) | sync `ensureDir` helper | Out of scope — sibling sync-fs leak (own finding). |
| [src/auth/store.ts](../../../src/auth/store.ts) | sync surface | **Removed by G36** (sibling). |
| [src/mcp/builtins.ts](../../../src/mcp/builtins.ts) | only `createWriteStream` | **Allow-listed by G30**. |

`config.ts` is the third entry in the round-2 sync-fs cleanup arc
(G30 → G36 → G37). After all three land, the only remaining
`node:fs` named imports in `src/` should be the G30 allow-list
(`createWriteStream`) plus any explicit out-of-scope carve-outs
(bootstrap fatal handler, runtime/stash).

## 5. `ensureDir` re-export: dead code

`config.ts` exports `ensureDir(p: string): void` at
[L279-L281](../../../src/config.ts#L279-L281). It is re-exported
from [src/index.ts](../../../src/index.ts#L35).

Grep across `src/` (excluding `*.test.ts`) finds **zero** importers
of this symbol from `../config.js`. Every runtime caller that needs
to create a directory uses the async `ensureDir` from
[src/store/documents.ts](../../../src/store/documents.ts) (F22
migration). The sync export is residue from before F22.

Per the project rule "remove obsolete code rather than keeping
migration shims", G37 deletes both the export from `config.ts` and
the re-export from `index.ts`.

## 6. Sequencing constraints

- **After G30**: G37 reuses
  [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts)
  (landed by G30 per [../G30/APPROVED.md](../G30/APPROVED.md)) for the
  CI guard that pins `src/config.ts` to async-only.
- **With G36**: independent. G36 rewrites `auth/store.ts` (profile
  read/write); G37 rewrites the `loadConfig()` calls in
  `auth/anthropic.ts`, `auth/openai-codex.ts`,
  `auth/github-copilot.ts` (client-id lookup). Different functions,
  different files. Either can land first; the second one rebases
  trivially.
- **Daemon impact**: same three daemons as G30/G36 — `saivage`
  (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112).

## 7. Risk inventory

1. **`bootstrap` and CLI now `await loadConfig`.** Both are already
   async; cascade is mechanical and `tsc` enforces it.
2. **OAuth driver functions become slightly less synchronous.** Each
   gains one extra microtask before issuing the `fetch` for token
   refresh. Negligible (< 1 ms).
3. **Removal of `force` parameter** is a breaking signature change
   for tests, but tests run on the same branch and are rewritten in
   the same patch. No downstream consumers outside the repo.
4. **`resolveProjectRoot` stays sync.** It performs a bounded parent
   walk only when neither `PROJECT_ROOT` nor `SAIVAGE_ROOT` env vars
   are set. Bootstrap sets both before any subsequent call, so in
   the long-running daemon it is invoked exactly once with at most
   ~10 stat probes. Converting it to async would cascade into
   `configPath()` — used inside `throw new MissingModelForRoleError(
   ..., configPath())` at [src/providers/router.ts](../../../src/providers/router.ts#L204),
   [src/routing/resolver.ts](../../../src/routing/resolver.ts) and
   [src/runtime/supervisor.ts](../../../src/runtime/supervisor.ts#L62)
   — and that cascade is unjustified for a path helper. Documented
   as an explicit boundary, not a follow-up.
