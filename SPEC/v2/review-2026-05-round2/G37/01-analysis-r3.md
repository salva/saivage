# G37 — Analysis (r3)

**Finding**: [../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md)
**Subsystem**: config (Types & config row in [../00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md))
**Severity**: medium — bad-design, module-level transversality
**Round-2 review**: [04-review-r2.md](04-review-r2.md) — CHANGES_REQUESTED.
**Sibling findings**: G30 ([../G30/APPROVED.md](../G30/APPROVED.md)),
G36 ([../G36/APPROVED.md](../G36/APPROVED.md)),
F22 round-1 (`store/documents.ts` — landed).

---

## Round-3 deltas

The round-2 review left a single, narrow blocker
([04-review-r2.md](04-review-r2.md#L11-L19)): the regression-guard
test contract did not match the G30 scanner contract. The scanner
shipped in [../G30/02-design-r2.md](../G30/02-design-r2.md#L167-L215)
emits **two** violation kinds for an unallowed named import that is
also called: `disallowed-named-import` *and* `sync-call`. The r2
design asserted only one. There are no other open issues
([04-review-r2.md](04-review-r2.md#L23-L29) records every prior
blocker as resolved).

This round changes only the regression-guard assertion in
[02-design-r3.md](02-design-r3.md) §"Regression guard" and the
matching Step 6 in [03-plan-r3.md](03-plan-r3.md). The analysis
below is unchanged in substance from r2; §4 adds one sentence
explaining why the new assertion shape is the G30-consistent
choice. Everything else is restated verbatim for self-
containment.

---

## Round-2 deltas (retained from r2)

Reviewer-required corrections traced into r2
([04-review-r1.md](04-review-r1.md#L13-L33)):

- **§5 + §6 rewritten.** The `ensureDir` symbol exported from
  [src/config.ts](../../../src/config.ts#L279-L281) is **not** dead
  code. Live consumer: [src/auth/store.ts](../../../src/auth/store.ts#L10)
  imports it and [L59-L60](../../../src/auth/store.ts#L59-L60) calls
  it from `saveProfiles`. The round-1 grep was wrong (likely scoped
  to "from `../config.js`" with the wrong path prefix).
- **§5 also corrected on barrel ownership.** The `ensureDir,`
  re-export at [src/index.ts](../../../src/index.ts#L35) comes from
  `./store/documents.js` ([L28-L36](../../../src/index.ts#L28-L36)),
  the F22 async helper — *not* from `./config.js`. The barrel does
  not re-export the sync `config.ensureDir` at all.
- **§6 sequencing**: with the corrected ownership, G36 becomes a
  **hard** prerequisite for G37 (not "independent / either order").
  G36's approved design ([../G36/02-design-r3.md](../G36/02-design-r3.md#L74-L84))
  rewrites [src/auth/store.ts](../../../src/auth/store.ts#L8-L10) to
  use `node:fs/promises` and drops the `node:fs` + `ensureDir`
  imports; once G36 lands, the live `ensureDir` consumer is gone and
  G37 can safely delete the export.

The remaining call-graph, cache-cost discussion, and rationale for
keeping `resolveProjectRoot` sync are unchanged from r1; they are
restated below so r3 is the canonical analysis.

---

## 1. What the code actually does today

[src/config.ts](../../../src/config.ts) is the only loader for
`SaivageConfig` and is consumed by bootstrap, CLI subcommands, the
three OAuth driver modules, the auth store, and tests.

Sync-fs surface (four call sites in this file):

- [src/config.ts](../../../src/config.ts#L2) imports `readFileSync`,
  `existsSync`, `mkdirSync` from `node:fs` — the only `node:fs`
  named imports left in this module after F22.
- [src/config.ts](../../../src/config.ts#L208) inside
  `resolveProjectRoot`: walks parent directories with
  `existsSync(join(saivage, "config.json"))` to anchor the project
  root.
- [src/config.ts](../../../src/config.ts#L268-L270) inside
  `loadConfig`: `existsSync(fp) && readFileSync(fp, "utf-8")`.
- [src/config.ts](../../../src/config.ts#L279-L281) exported
  `ensureDir(p)`: `existsSync(p) || mkdirSync(p, { recursive: true })`.

Cache surface:

- Module-level `cached: SaivageConfig | null` and
  `cachedConfigDir: string | null` at
  [src/config.ts](../../../src/config.ts#L259-L260).
- `loadConfig(force = false, projectRoot?)` returns the cached
  object when `!force && cachedConfigDir === dir`. No mtime check,
  no `fs.watch`, no API to invalidate from outside the module.
- `force=true` is passed by
  [bootstrap](../../../src/server/bootstrap.ts#L128), by the
  `models` CLI subcommand
  [src/server/cli.ts](../../../src/server/cli.ts#L289), and by every
  test fixture that wants a clean load. It still performs sync fs.

## 2. Call graph (every caller in `src/` after F22)

| Caller | Site | Pattern | Already async? |
|---|---|---|---|
| `bootstrap` | [src/server/bootstrap.ts](../../../src/server/bootstrap.ts#L128) | `loadConfig(true, project.projectRoot)` once per boot | yes (`async function bootstrap`) |
| `models` CLI | [src/server/cli.ts](../../../src/server/cli.ts#L289) | `loadConfig(true, root)` once per invocation | yes (`.action(async …)`) |
| `login` CLI (Copilot headers branch) | [src/server/cli.ts](../../../src/server/cli.ts#L431-L432) | `loadConfig()` in a try/catch fallback | yes |
| `auth/anthropic.ts` `exchangeCode` | [src/auth/anthropic.ts](../../../src/auth/anthropic.ts#L51) | `loadConfig().oauth.anthropic.clientId` | yes |
| `auth/anthropic.ts` `refreshAccessToken` | [src/auth/anthropic.ts](../../../src/auth/anthropic.ts#L82) | same | yes |
| `auth/anthropic.ts` third site | [src/auth/anthropic.ts](../../../src/auth/anthropic.ts#L166) | same | yes |
| `auth/openai-codex.ts` (three sites) | [src/auth/openai-codex.ts](../../../src/auth/openai-codex.ts#L61), [L92](../../../src/auth/openai-codex.ts#L92), [L176](../../../src/auth/openai-codex.ts#L176) | `.oauth.openaiCodex.clientId` | yes |
| `auth/github-copilot.ts` (two sites) | [src/auth/github-copilot.ts](../../../src/auth/github-copilot.ts#L67), [L114](../../../src/auth/github-copilot.ts#L114) | `.oauth.githubCopilot.clientId` | yes |
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
   `saivage.json` is ever observed by an in-process consumer until
   the daemon is restarted. The issue
   ([../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md))
   correctly calls this out.
2. **Per-process global state.** `cached` is module-level, so unit
   tests share the same slot and depend on `force=true` plus
   `cachedConfigDir` discrimination to avoid cross-contamination.
3. **`force=true` is sync-fs anyway.** Even when callers opt out of
   the cache, the read still blocks the event loop.

### Stale-cache scope — what propagates and what does not

This is the architectural reality the issue's "rough remediation
direction" elides: even with `fs.watch`-backed invalidation, **most
consumers would still see stale data** because they capture a config
snapshot at construction time. Specifically:

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
cross-subsystem refactor far outside the scope of a medium-severity
bad-design finding.

That drives the design choice
([02-design-r3.md](02-design-r3.md)): **delete the cache instead
of trying to keep it fresh.**

## 4. Audit of the `node:fs` allow-list across `src/`

For consistency with G30's audit-table approach
([../G30/APPROVED.md](../G30/APPROVED.md)) and to plug this finding
into the same lint-rule surface, the table below records every
remaining `node:fs` named import in `src/` after F22 + G30 (landed)
+ G36 (landed; **prerequisite of G37**, see §6).

| File | Imports | Status after G37 |
|---|---|---|
| [src/config.ts](../../../src/config.ts#L2) | `readFileSync, existsSync, mkdirSync` | **Reduced by G37** — only `existsSync` remains (used by `resolveProjectRoot`); `readFileSync` and `mkdirSync` go away (`loadConfig` switches to `node:fs/promises`, `ensureDir` export is deleted). |
| [src/server/bootstrap.ts](../../../src/server/bootstrap.ts#L16) | `writeFileSync` | Out of scope (fatal-handler path). Tracked elsewhere. |
| [src/runtime/stash.ts](../../../src/runtime/stash.ts) | sync `ensureDir` helper | Out of scope — sibling sync-fs leak (own finding). |
| [src/auth/store.ts](../../../src/auth/store.ts) | (none after G36) | **Already removed by G36** ([../G36/02-design-r3.md](../G36/02-design-r3.md#L74-L84)). |
| [src/mcp/builtins.ts](../../../src/mcp/builtins.ts) | only `createWriteStream` | **Allow-listed by G30**. |

`config.ts` is the third entry in the round-2 sync-fs cleanup arc
(G30 → G36 → G37).

Note (r3): the remaining `existsSync` in `config.ts` is **both** a
named import and a sync call. Under the G30 scanner contract
([../G30/02-design-r2.md](../G30/02-design-r2.md#L167-L215)), the
two surface separately as `disallowed-named-import existsSync` and
`sync-call existsSync`. The regression guard in
[02-design-r3.md](02-design-r3.md) asserts both. Suppressing only
the call (e.g. by replacing the named import with `import fs from
"node:fs"` and calling `fs.existsSync`) would swap one violation
kind for another (`default-import`), not eliminate it. Broadening
`allowedNamedImports` to include `existsSync` globally is explicitly
rejected by [04-review-r2.md](04-review-r2.md#L18) and would defeat
the G30 audit. Adding a per-file allow-list capability is out of
scope (it is a change to the APPROVED G30 contract). Keeping the
named import and asserting both violations is the minimal, G30-
consistent option.

## 5. `ensureDir` export — live consumer and how it disappears

[src/config.ts](../../../src/config.ts#L279-L281) exports
`ensureDir(p: string): void`. **Round-1 incorrectly called this
dead code.** The actual situation is:

- **Live consumer**:
  [src/auth/store.ts](../../../src/auth/store.ts#L10) imports
  `ensureDir` from `../config.js` and
  [L59-L60](../../../src/auth/store.ts#L59-L60) calls
  `ensureDir(saivageDir())` inside `saveProfiles`. This is the
  **only** runtime caller in `src/`.
- **Tests**: no test imports `config.ensureDir` (tests that need to
  create directories use `mkdirSync` directly from `node:fs` or
  helpers in their own subsystem).
- **Barrel**: [src/index.ts](../../../src/index.ts#L28-L36)
  re-exports `ensureDir` from `./store/documents.js` (F22 async
  helper), **not** from `./config.js`. Round-1 mistakenly proposed
  deleting the barrel entry; live ownership shows that line is
  unrelated to this finding and must stay.

Sequencing consequence: G37 cannot delete `config.ensureDir` until
the `auth/store.ts` consumer is gone. G36
([../G36/02-design-r3.md](../G36/02-design-r3.md#L74-L84)) rewrites
`auth/store.ts` to use `node:fs/promises` and drops the import. So
**G37 depends on G36 having landed first** (see §6); after G36 the
config-level `ensureDir` has no callers in `src/` and can be
deleted per the project rule "remove obsolete code rather than
keeping migration shims".

## 6. Sequencing constraints (revised)

- **G30 (APPROVED) — hard prerequisite.** Supplies
  [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts)
  ([../G30/APPROVED.md](../G30/APPROVED.md#L7)) used by the
  regression guard added in this finding.
- **G36 (APPROVED) — hard prerequisite (revised from r1).** G36
  rewrites [src/auth/store.ts](../../../src/auth/store.ts#L8-L10)
  and removes the import of
  `ensureDir from "../config.js"`
  ([../G36/02-design-r3.md](../G36/02-design-r3.md#L74-L84)). Only
  after G36 lands does the `config.ensureDir` export have zero
  callers. If G37 landed first it would either:
  - leave `config.ensureDir` in place (violating "remove obsolete
    code") and require a follow-up to delete it after G36, or
  - delete it and break the pre-G36 tree at
    [src/auth/store.ts](../../../src/auth/store.ts#L10).
  Both options are worse than just gating on G36. The PR for G37
  rebases on top of G36's merge commit.
- **Daemon impact**: same three daemons as G30/G36 — `saivage`
  (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3`
  (10.0.3.112). `saivage-v3-getrich-v2` (10.0.3.170) does not
  bind-mount the host `saivage/` tree and is unaffected.

## 7. Risk inventory

1. **`bootstrap` and CLI now `await loadConfig`.** Both are already
   async; cascade is mechanical and `tsc` enforces it.
2. **OAuth driver functions become slightly less synchronous.** Each
   gains one extra microtask before issuing the `fetch` for token
   refresh. Negligible (< 1 ms).
3. **Removal of `force` parameter** is a breaking signature change
   for tests, but tests run on the same branch and are rewritten in
   the same patch. No downstream consumers outside the repo.
4. **`resolveProjectRoot` stays sync.** Bounded parent walk invoked
   at most once per process when `PROJECT_ROOT` and `SAIVAGE_ROOT`
   are unset; bootstrap sets both before any subsequent call.
   Converting it to async would cascade into `configPath()` — used
   from synchronous `throw` statements at
   [src/providers/router.ts](../../../src/providers/router.ts#L204),
   [src/routing/resolver.ts](../../../src/routing/resolver.ts), and
   [src/runtime/supervisor.ts](../../../src/runtime/supervisor.ts#L62)
   — which is unjustified for a path helper. The lint rule's
   `existsSync` carve-out is **scoped to `src/config.ts`** via a
   post-filter on scanner output (see
   [02-design-r3.md](02-design-r3.md) §"Regression guard"); it is
   never widened workspace-wide.
5. **Race on direct edits of `saivage.json`.** F22 and G36 use tmp
   + atomic rename for *writers*; operators editing the file
   directly with a non-atomic editor (`>` shell redirect) can race a
   concurrent `loadConfig` read. Out of scope — pre-existing
   condition; the existing
   [memory note about `.saivage/saivage.json` mode preservation](file:///home/salva/g/ml/.github/copilot-instructions.md)
   already documents operator-side atomicity expectations.
