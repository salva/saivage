# G37 — Design (r3)

**Finding**: [../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md)
**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
**Round-2 review**: [04-review-r2.md](04-review-r2.md) — CHANGES_REQUESTED.
**Sibling-pattern references**: [../G30/02-design-r2.md](../G30/02-design-r2.md), [../G36/02-design-r3.md](../G36/02-design-r3.md), F22 round-1 (already landed for `store/documents.ts`).

## Round-3 deltas (reviewer-driven)

[04-review-r2.md](04-review-r2.md#L11-L19) raises one blocker: the
regression-guard assertion did not match the G30 scanner contract.
The G30 scanner emits a `disallowed-named-import` violation for any
named import from `node:fs` not in its allow-list, and *also* emits
a `sync-call` violation when that import is invoked. The r2 design
expected exactly one (`sync-call existsSync`); the actual run would
have produced two (`disallowed-named-import existsSync` plus
`sync-call existsSync`) and the assertion would fail on first run.

The reviewer enumerates three options
([04-review-r2.md](04-review-r2.md#L15-L18)); the architecture-
correct one is **(1) keep the config-only post-filter and assert
exactly the two violations the shipped scanner emits**:

- Switching to `import fs from "node:fs"` + `fs.existsSync(…)` only
  trades `disallowed-named-import` for `default-import` — the
  scanner flags both shapes
  ([../G30/02-design-r2.md](../G30/02-design-r2.md#L189-L199)).
- Adding a per-file allow-list capability to the scanner widens the
  G30 APPROVED contract for a single carve-out, which is heavier
  and reviewable as its own change. The G30 design deliberately
  ships a flat `allowedNamedImports` set
  ([../G30/02-design-r2.md](../G30/02-design-r2.md#L139-L156)).
- Broadening the workspace-wide allow-list to include `existsSync`
  is explicitly rejected by
  [04-review-r2.md](04-review-r2.md#L18).

Option (1) is the only one that keeps the G30 contract intact and
keeps the `existsSync` carve-out scoped to `src/config.ts` via the
post-filter. The change in this round is therefore narrow: only the
regression-guard test snippet (this file §"Regression guard") and
its Step 6 in [03-plan-r3.md](03-plan-r3.md) are touched. All
other r2 design content is restated verbatim for self-containment.

## Round-2 deltas (retained from r2)

Mapping prior reviewer-required changes
([04-review-r1.md](04-review-r1.md#L13-L42)) into this round:

1. **High finding #1** (barrel ownership + sequencing):
   - **Removed** the proposal to delete the `ensureDir,` line from
     [src/index.ts](../../../src/index.ts#L35). That export originates
     from `./store/documents.js`
     ([src/index.ts](../../../src/index.ts#L28-L36)), not from
     `./config.js`. Touching it is out of scope and was a round-1
     error.
   - **Removed** the barrel-cleanliness test (round-1 Step 8). It was
     predicated on the wrong barrel ownership.
   - **G36 promoted to hard prerequisite.** The config `ensureDir`
     export has one live caller — [src/auth/store.ts](../../../src/auth/store.ts#L10)
     and [L59-L60](../../../src/auth/store.ts#L59-L60). G36 rewrites
     that module to use `node:fs/promises`
     ([../G36/02-design-r3.md](../G36/02-design-r3.md#L74-L84)) and
     drops the `ensureDir` import. The config `ensureDir` export
     becomes deletable only after G36 lands; G37 rebases on G36.
2. **Medium finding #2** (regression guard scope) — see r3 update
   above; the test still scopes to `src/config.ts` only.
3. **Medium finding #3** (test fixture mechanics): the new test cases
   for `loadConfig` reuse the **same sync `mkdirSync` +
   `writeFileSync` helpers** already imported at
   [src/config.test.ts](../../../src/config.test.ts#L3). No new
   `node:fs/promises` import is added. The
   "edit-after-load reflects the edit" case wraps every write with
   `mkdirSync(saivageRoot, { recursive: true })` mirroring the
   existing pattern at
   [src/config.test.ts](../../../src/config.test.ts#L51-L52). Tests
   are exempt from the no-sync-fs guard (`.test.ts` is in the
   scanner's default `skipPathContains`).
4. **Low finding #4** (malformed-JSON prose): r1's "silently parses
   as `{}`" sentence was wrong. Live behaviour at
   [src/config.ts](../../../src/config.ts#L267-L270) has no
   `try/catch` around `JSON.parse`, so a malformed file **throws**.
   The proposed design preserves that semantics; the test case
   below documents it.

## Direction (unchanged from r1)

Two proposals were considered in round 1; Proposal A was selected
and survives r2/r3 unchanged in shape. Proposal B (reactive
`ConfigStore` with `fs.watch` + listeners) is rejected for the same
reasons given in r1 §"Why this is rejected"
([01-analysis-r3.md](01-analysis-r3.md) §3 enumerates every
downstream snapshot consumer that would have to become reactive —
out of scope).

---

## Proposal A — Focused fix: async `loadConfig`, delete the cache

### Idea

`loadConfig` becomes async (`node:fs/promises`) and the module-level
`cached`/`cachedConfigDir` slots — together with the `force`
parameter — are deleted. Without a cache there is no staleness
hazard. Every call re-parses `saivage.json`;
[01-analysis-r3.md](01-analysis-r3.md) §3 shows the realistic call
rate is "once per bootstrap plus a few per OAuth refresh", which
makes the parse cost trivial.

The `ensureDir` export at
[src/config.ts](../../../src/config.ts#L279-L281) is also deleted in
this PR, but **only after** G36 lands (which removes the lone live
caller at [src/auth/store.ts](../../../src/auth/store.ts#L10)).

This mirrors G36's "no cache; every locked critical section reloads
from disk" stance
([../G36/02-design-r3.md](../G36/02-design-r3.md#L41-L51)), adapted
for a read-mostly path (no lock needed because writers — F22 + G36
— already use atomic rename + lockfile against the *target* file).

### `loadConfig` — exact async shape

```ts
// src/config.ts (replaces L259-L273)

import { existsSync } from "node:fs";              // resolveProjectRoot only
import { readFile } from "node:fs/promises";       // loadConfig only
import { pathExists } from "./store/documents.js"; // F22 async helper

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

1. **No module-level state.** Concurrent callers each get an
   independent parsed object — safe by construction.
2. **`force` parameter removed.** Dead without the cache. All call
   sites drop it.
3. **`pathExists` is the F22 async primitive** in
   [src/store/documents.ts](../../../src/store/documents.ts). Import
   direction is `config → store/documents`;
   `store/documents.ts` does **not** import from `config.ts`, so
   the cycle check is clean (verified by `tsc`).
4. **`JSON.parse` errors propagate.** Live behaviour at
   [src/config.ts](../../../src/config.ts#L267-L270) has no
   `try/catch` around the parse; malformed JSON throws before Zod
   sees it. The new test documents this.

### `resolveProjectRoot` — left sync, scope-justified

`resolveProjectRoot` keeps `existsSync` at
[src/config.ts](../../../src/config.ts#L208). Justification:
[01-analysis-r3.md](01-analysis-r3.md) §7 risk 4 — it is a
path-discovery helper consumed by `configPath()` which is itself
called inside synchronous `throw` statements at
[src/providers/router.ts](../../../src/providers/router.ts#L204),
[src/routing/resolver.ts](../../../src/routing/resolver.ts), and
[src/runtime/supervisor.ts](../../../src/runtime/supervisor.ts#L62).
The regression guard explicitly **scopes** the `existsSync` carve-
out to `config.ts` only via a post-filter (see "Regression guard"
below).

### `ensureDir` export — deleted after G36

```ts
// DELETE from src/config.ts (L279-L281):
//   export function ensureDir(p: string): void { … }
//
// Also delete from src/config.ts (L2):
//   the `mkdirSync` named import.
```

**Do not edit** [src/index.ts](../../../src/index.ts#L35) — that
`ensureDir,` line is the F22 async re-export from
`./store/documents.js`
([src/index.ts](../../../src/index.ts#L28-L36)). G37 leaves it
untouched.

After G36 lands, `grep -rn "ensureDir" src` should show only:

- the import in `src/index.ts` (re-exporting the F22 async helper),
- the definition in `src/store/documents.ts`,
- async callers throughout `src/store/**`.

If any other live caller appears, it is a G36-rebase artefact and
must be migrated to the async helper before deleting the sync
export.

### Files touched

- [src/config.ts](../../../src/config.ts) — rewrite of L259-L281
  (`loadConfig` + cache + `ensureDir` export). L1-L258 schema block
  unchanged. Imports collapse from
  `readFileSync, existsSync, mkdirSync` to just `existsSync`; add
  `readFile` from `node:fs/promises` and `pathExists` from
  `./store/documents.js`.
- **Not touched**: [src/index.ts](../../../src/index.ts) (round-1
  deletion was wrong).
- [src/server/bootstrap.ts](../../../src/server/bootstrap.ts#L128) —
  `const config = await loadConfig(project.projectRoot);`.
- [src/server/cli.ts](../../../src/server/cli.ts#L289) —
  `const config = await loadConfig(root ?? undefined);`.
- [src/server/cli.ts](../../../src/server/cli.ts#L432) —
  `const cfg = await loadConfig();` (inside the existing try/catch).
- [src/auth/anthropic.ts](../../../src/auth/anthropic.ts) — L51,
  L82, L166: `const clientId = (await loadConfig()).oauth.anthropic.clientId;`.
- [src/auth/openai-codex.ts](../../../src/auth/openai-codex.ts) —
  L61, L92, L176: same shape with `.oauth.openaiCodex.clientId`.
- [src/auth/github-copilot.ts](../../../src/auth/github-copilot.ts)
  — L67, L114: same shape with `.oauth.githubCopilot.clientId`.
- [src/config.test.ts](../../../src/config.test.ts) — every
  `loadConfig(true, projectRoot)` becomes
  `await loadConfig(projectRoot)`; the three sync `toThrow` cases
  become `await expect(...).rejects.toThrow(...)`. Append three
  new cases (see "Test impact" below).
- [src/store/project.test.ts](../../../src/store/project.test.ts#L79),
  [L86](../../../src/store/project.test.ts#L86) — add `await`.
- [src/auth/defaults.test.ts](../../../src/auth/defaults.test.ts#L51),
  [L61](../../../src/auth/defaults.test.ts#L61),
  [L72](../../../src/auth/defaults.test.ts#L72) — add `await`.
- [src/mcp/builtins.test.ts](../../../src/mcp/builtins.test.ts#L54),
  [L285](../../../src/mcp/builtins.test.ts#L285) — add `await`.
  Change the type alias `let cfg: ReturnType<typeof loadConfig>` at
  L35 to `let cfg: Awaited<ReturnType<typeof loadConfig>>;`.
- [src/mcp/fsGuard.test.ts](../../../src/mcp/fsGuard.test.ts#L22) —
  add `await`.
- **New** [src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts)
  — described under "Regression guard" below.

### Deletion list

- `let cached: SaivageConfig | null = null;` at
  [src/config.ts](../../../src/config.ts#L259).
- `let cachedConfigDir: string | null = null;` at
  [src/config.ts](../../../src/config.ts#L260).
- The `force` parameter and `if (cached && !force && cachedConfigDir === dir) return cached;`
  branch at [L261-L263](../../../src/config.ts#L261).
- `const dir = saivageDir(projectRoot);` at
  [L262](../../../src/config.ts#L262) (no longer needed).
- The `cached = …; cachedConfigDir = dir;` assignments at
  [L271-L272](../../../src/config.ts#L271).
- The `ensureDir` export at
  [L279-L281](../../../src/config.ts#L279) (only **after** G36 has
  removed the [src/auth/store.ts](../../../src/auth/store.ts#L10)
  caller).
- The `readFileSync` and `mkdirSync` names from the
  [L2](../../../src/config.ts#L2) `node:fs` import.

### Public API impact

- `loadConfig` signature changes from
  `(force?: boolean, projectRoot?: string) => SaivageConfig` to
  `(projectRoot?: string) => Promise<SaivageConfig>`.
- `ensureDir` is removed from the `config` module. The barrel's
  `ensureDir` export (the F22 async helper from `store/documents`)
  is **untouched**.

### Regression guard (r3)

New file [src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts).
Uses the G30 scanner as-shipped — the `walk` implementation in
[../G30/02-design-r2.md](../G30/02-design-r2.md#L226-L242) treats
each `roots` entry as a directory (`readdir` recursion), so the
scanner cannot be pointed at a single file. The test passes
`roots: ["src"]` with the **default** allow-list
(`["createWriteStream"]`) and an **explicit post-filter** to isolate
violations originating from `src/config.ts`.

Per the G30 scanner contract
([../G30/02-design-r2.md](../G30/02-design-r2.md#L167-L215)),
`src/config.ts` will emit **two** violations after this finding
lands, both from the surviving `existsSync` in `resolveProjectRoot`:

1. `kind: "disallowed-named-import", detail: "existsSync"` — from
   the `import { existsSync } from "node:fs"` line at
   [src/config.ts](../../../src/config.ts#L2) (the name is not in
   the default `["createWriteStream"]` allow-list).
2. `kind: "sync-call", detail: "existsSync"` — from the call at
   [src/config.ts](../../../src/config.ts#L208) inside
   `resolveProjectRoot`.

Both are the load-bearing carve-out justified in §"`resolveProjectRoot`
— left sync, scope-justified" above. The test asserts exactly that
pair and nothing else:

```ts
// src/config.no-sync-fs.test.ts
import { describe, it, expect } from "vitest";
import { sep } from "node:path";
import { scanForSyncFs } from "./testing/noSyncFsScanner.js";

describe("src/config.ts is async-fs only", () => {
  it("permits only the existsSync carve-out in resolveProjectRoot", async () => {
    const all = await scanForSyncFs({
      roots: ["src"],
      // Default allow-list ["createWriteStream"] (G30). We do NOT
      // broaden existsSync workspace-wide; we narrow it to
      // src/config.ts via the post-filter below.
    });
    const configViolations = all
      .filter(
        (v) =>
          v.file === `src${sep}config.ts` ||
          v.file.endsWith(`${sep}src${sep}config.ts`),
      )
      // Stable order so the assertion below is independent of the
      // scanner's traversal order (import vs call site).
      .map((v) => ({ kind: v.kind, detail: v.detail }))
      .sort((a, b) =>
        a.kind === b.kind
          ? a.detail.localeCompare(b.detail)
          : a.kind.localeCompare(b.kind),
      );

    // Exactly the two G30 violations produced by the existsSync
    // carve-out in resolveProjectRoot — and nothing else.
    expect(configViolations).toEqual([
      { kind: "disallowed-named-import", detail: "existsSync" },
      { kind: "sync-call", detail: "existsSync" },
    ]);
  });
});
```

Why this exact shape (r3, reviewer-required):

- Matches the actual scanner output documented in
  [../G30/02-design-r2.md](../G30/02-design-r2.md#L189-L215):
  `disallowed-named-import` per name + `sync-call` per call site.
- The default `skipPathContains` includes `.test.ts` and `.d.ts`
  ([../G30/02-design-r2.md](../G30/02-design-r2.md#L171)), so this
  test does not flag itself nor any other test file.
- The scanner walks `src/`; other modules' violations (e.g.
  `bootstrap.ts` `writeFileSync`, `runtime/stash.ts`) are ignored by
  the post-filter. They are owned by their own findings — G30
  carved them out via per-module tests
  ([../G30/03-plan-r2.md](../G30/03-plan-r2.md#L377-L401)).
- The `existsSync` allow-list is **not** broadened workspace-wide:
  if a future edit adds `existsSync` to any other source file, that
  file's own no-sync-fs test (when it exists) will catch it, and
  the workspace-wide guard (gated by G30's audit) will too.
- Any *new* sync surface inside `src/config.ts` (a second
  `existsSync` call, a `readFileSync`, an extra named import, etc.)
  introduces a third entry into `configVi​olations` and fails
  `expect(...).toEqual([...])`. The `sort` step keeps the assertion
  insensitive to the scanner's discovery order between the import
  and the call.

### Test impact

Eight cases in [src/config.test.ts](../../../src/config.test.ts)
plus the regression test.

1. **Empty config dir** — existing test, signature updated to
   `await loadConfig(projectRoot)`.
2. **Interpolates `${ENV_VAR}` strings** — existing test, `await`.
3. **MCP shellTimeoutMs floor validation** — existing test,
   rewritten to
   `await expect(loadConfig(projectRoot)).rejects.toThrow(/WALL_CLOCK_HEADROOM_MS/)`
   and `/inner cap/`.
4. **Two concurrent loaders see independent snapshots** — new. Uses
   the existing sync `mkdirSync(saivageRoot, { recursive: true })`
   + `writeFileSync(saivageJson, …)` fixture pattern from
   [src/config.test.ts](../../../src/config.test.ts#L51-L52). Calls
   `Promise.all([loadConfig(projectRoot), loadConfig(projectRoot)])`;
   asserts the two returned objects are distinct instances and
   asserts mutating one does not affect a third call. Regression
   guard for "someone reintroduces the cache".
5. **Edit-after-load sees the edit** — new. Writes `saivage.json`
   with `mcp.shellTimeoutMs: 11 * 60_000`, `await loadConfig(...)`,
   re-writes the same path with `12 * 60_000`,
   `await loadConfig(...)` again, asserts the second result reflects
   the new value. Directly exercises the bug the finding describes.
6. **Malformed JSON rejects** — new. Writes `"not json"` to
   `saivage.json`; asserts `await loadConfig(...)` rejects with a
   `SyntaxError`. Documents the (preserved) crash-fast behaviour
   noted in §"Round-2 deltas" #4 — live code already throws on
   malformed JSON; this test pins that semantics.
7. **No sync-fs in `src/config.ts`** —
   [src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts)
   per "Regression guard (r3)" above.

Fixture mechanics (reviewer-required): every new write reuses the
existing sync helpers already imported at
[src/config.test.ts](../../../src/config.test.ts#L3) (`mkdirSync`,
`writeFileSync` from `node:fs`). Each `writeFileSync` is preceded
by `mkdirSync(join(projectRoot, ".saivage"), { recursive: true })`
to match the pattern at
[src/config.test.ts](../../../src/config.test.ts#L51-L52). No new
`node:fs/promises` import is added to the test file.

### What it does NOT do (deliberately)

- **No `fs.watch`.** Analysis §3: long-lived consumers
  (Router/Resolver/Supervisor) snapshot config at construction and
  do not re-read. A watcher in `config.ts` would not change their
  behaviour.
- **No `reloadConfig()` API.** Same reason; with the cache gone,
  every call is a fresh read.
- **No SIGHUP / `PUT /api/config`.** Out of scope; belongs to a
  future reactive-config feature.
- **No async conversion of `resolveProjectRoot`.** See risk #4.
- **No edit to [src/index.ts](../../../src/index.ts).** The `ensureDir,`
  re-export is from `./store/documents.js` and is unrelated to this
  finding.
- **No change to the G30 scanner API.** Adding a per-file
  allow-list capability is out of scope; the carve-out lives in the
  post-filter inside the regression test, not in the shared
  scanner.

### Risk (unchanged from r2 except wording on r3 guard)

1. `tsc` cascade through three auth modules + bootstrap + cli +
   five test files. All mechanical, all caught at compile time.
2. Per-call parse cost. Parsing a < 4 KB `saivage.json` plus Zod
   validation is < 1 ms; called ~once per bootstrap and 1–3 times
   per OAuth refresh (≤ once/hour per provider). Negligible.
3. Race on direct (non-atomic) operator edits — pre-existing.
4. `resolveProjectRoot` stays sync (justified above). The
   regression guard asserts *both* G30 violation kinds the carve-out
   produces (named import + sync call), pinned to `src/config.ts`.
5. **G36-rebase coupling.** If G36 is reverted, G37 must be
   reverted with it because the deletion of `config.ensureDir`
   would break [src/auth/store.ts](../../../src/auth/store.ts) on
   the reverted tree. Mitigation: implementation plan
   ([03-plan-r3.md](03-plan-r3.md)) gates Step 1.d (`ensureDir`
   deletion) on `grep -rn "ensureDir" src` returning no callers
   outside `src/index.ts` and `src/store/`.

---

## Coordination

- **G30 (APPROVED) — hard prerequisite.** Provides
  [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts).
  G37's regression test imports it via
  `./testing/noSyncFsScanner.js`.
- **G36 (APPROVED) — hard prerequisite (revised from r1).**
  Rewrites [src/auth/store.ts](../../../src/auth/store.ts#L8-L10)
  to drop the `node:fs` + `ensureDir` imports. G37 rebases on G36
  and then deletes `config.ensureDir`.
- **F22 round-1.** Reuses `pathExists` from
  [src/store/documents.ts](../../../src/store/documents.ts).

## Recommendation

**Proposal A.** Deleting the cache is the architecture-correct fix
because the cache is the source of the staleness hazard and its
only beneficiaries (three client-id reads per OAuth refresh) re-
parse a < 4 KB file in well under a millisecond. The `force`
parameter and the `ensureDir` export die with the same patch (the
latter gated on G36), satisfying the project rules on obsolete code
and architecture-first.
