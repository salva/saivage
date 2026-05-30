# G37 — Implementation Plan (r3)

**Finding**: [../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md)
**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
**Design**: [02-design-r3.md](02-design-r3.md) — Proposal A.
**Round-2 review**: [04-review-r2.md](04-review-r2.md) — CHANGES_REQUESTED.
**Hard prerequisites (must both be merged first)**:
- [../G30/APPROVED.md](../G30/APPROVED.md) — provides
  [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts).
- [../G36/APPROVED.md](../G36/APPROVED.md) — rewrites
  [src/auth/store.ts](../../../src/auth/store.ts#L8-L10) to drop
  the `ensureDir` import from `../config.js`. Without G36, deleting
  `config.ensureDir` breaks the tree.

Implementation is a single PR. Steps are listed in compile-error
order: each step makes the codebase temporarily un-compilable until
the next step lands, but the final commit is green.

## Round-3 deltas (reviewer-driven)

Reviewer-required correction from
[04-review-r2.md](04-review-r2.md#L11-L19) applied below:

- **Step 6 only**: the no-sync-fs regression test now asserts the
  **two** violations the G30 scanner actually emits for the
  `existsSync` carve-out in `src/config.ts`
  (`disallowed-named-import existsSync` from the
  [src/config.ts](../../../src/config.ts#L2) named import, plus
  `sync-call existsSync` from the call site at
  [src/config.ts](../../../src/config.ts#L208)). The r2 plan
  expected only one and would have failed on first run. Rationale
  and the matching test snippet live in
  [02-design-r3.md](02-design-r3.md) §"Regression guard (r3)".
- No other step changes. Steps 0–5 and 7–8 are identical to r2.

## Round-2 deltas (retained from r2)

Reviewer-required corrections from
[04-review-r1.md](04-review-r1.md#L13-L42) applied in r2 and
retained here:

- **G36 promoted to hard prerequisite** (banner above).
- Step 1.d (delete `config.ensureDir`) is gated on a
  `grep -rn "ensureDir" src` precondition (Step 0).
- **Step 2 removed.** The round-1 edit of
  [src/index.ts](../../../src/index.ts#L35) was wrong — that
  `ensureDir,` line is the F22 async re-export from
  `./store/documents.js`, not the sync config export.
- **Step 8 removed** (the barrel-cleanliness test was predicated on
  the same misidentification).
- **Step 5 fixtures**: new test cases reuse the existing sync
  `mkdirSync` + `writeFileSync` helpers already imported at
  [src/config.test.ts](../../../src/config.test.ts#L3), with an
  explicit `mkdirSync(saivageRoot, { recursive: true })` before
  each new write — matching the existing pattern at
  [src/config.test.ts](../../../src/config.test.ts#L51-L52).

---

## Step 0 — Precondition checks (must pass before touching code)

```bash
cd /home/salva/g/ml/saivage
# G30 prerequisite landed:
test -f src/testing/noSyncFsScanner.ts
# G36 prerequisite landed (auth/store.ts no longer imports ensureDir):
! grep -nE 'ensureDir\s*[,}]' src/auth/store.ts
# config.ensureDir has zero remaining live callers in src/ (excluding
# the barrel's UNRELATED F22 async export from store/documents.js):
grep -rn 'from "\.\./config\.js"' src | grep -E '\bensureDir\b' && \
  { echo 'BLOCKED: someone still imports ensureDir from ../config.js'; exit 1; } || true
```

If any check fails, do **not** proceed; rebase on the missing
prerequisite first.

## Step 1 — Rewrite `loadConfig`; drop the cache; delete `config.ensureDir`

File: [src/config.ts](../../../src/config.ts)

Edits (single hunk window L1-L281):

1.a Replace the [L2](../../../src/config.ts#L2) `node:fs` named
import:

```ts
import { existsSync } from "node:fs";          // resolveProjectRoot only
import { readFile } from "node:fs/promises";   // loadConfig only
```

(`readFileSync` and `mkdirSync` go away.)

1.b Add `import { pathExists } from "./store/documents.js";`
alongside the other internal imports
([L6-L9](../../../src/config.ts#L6-L9)).

1.c Replace the cache + `loadConfig` block at
[L259-L273](../../../src/config.ts#L259-L273) with:

```ts
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

1.d Delete the `ensureDir` export at
[L279-L281](../../../src/config.ts#L279-L281).

Verify locally: `git diff src/config.ts` shows exactly four hunks,
all inside L1-L281. No other lines change. The barrel
[src/index.ts](../../../src/index.ts#L35) is **not** edited.

## Step 2 — Cascade `await` through `bootstrap` and CLI

File: [src/server/bootstrap.ts](../../../src/server/bootstrap.ts)

- L128: `const config = loadConfig(true, project.projectRoot);` →
  `const config = await loadConfig(project.projectRoot);`.

File: [src/server/cli.ts](../../../src/server/cli.ts)

- L289: `const config = loadConfig(true, root ?? undefined);` →
  `const config = await loadConfig(root ?? undefined);`.
- L432: `const cfg = loadConfig();` →
  `const cfg = await loadConfig();` (already inside an `async`
  arrow and a try/catch; no other change).

## Step 3 — Update OAuth driver call sites

File: [src/auth/anthropic.ts](../../../src/auth/anthropic.ts)

- L51, L82, L166:
  `const clientId = loadConfig().oauth.anthropic.clientId;` →
  `const clientId = (await loadConfig()).oauth.anthropic.clientId;`.

File: [src/auth/openai-codex.ts](../../../src/auth/openai-codex.ts)

- L61, L92, L176: same shape with `.oauth.openaiCodex.clientId`.

File: [src/auth/github-copilot.ts](../../../src/auth/github-copilot.ts)

- L67, L114: same shape with `.oauth.githubCopilot.clientId`.

Every site is already inside an `async function` — see
[01-analysis-r3.md](01-analysis-r3.md) §2.

## Step 4 — Update test fixtures (mechanical await)

For each file below, replace `loadConfig(true, <root>)` with
`await loadConfig(<root>)` (drop the `true`) and ensure the
enclosing `it`/`beforeEach` is `async`:

- [src/config.test.ts](../../../src/config.test.ts) — lines 30, 38,
  58, 82, 112, 117. The three `expect(() => loadConfig(...)).toThrow(...)`
  cases at L97, L102, L107 become
  `await expect(loadConfig(projectRoot)).rejects.toThrow(/WALL_CLOCK_HEADROOM_MS/)`
  (twice) and `…/inner cap/`.
- [src/store/project.test.ts](../../../src/store/project.test.ts#L79),
  [L86](../../../src/store/project.test.ts#L86).
- [src/auth/defaults.test.ts](../../../src/auth/defaults.test.ts#L51),
  [L61](../../../src/auth/defaults.test.ts#L61),
  [L72](../../../src/auth/defaults.test.ts#L72).
- [src/mcp/builtins.test.ts](../../../src/mcp/builtins.test.ts#L54),
  [L285](../../../src/mcp/builtins.test.ts#L285). The type alias
  `let cfg: ReturnType<typeof loadConfig>;` at L35 becomes
  `let cfg: Awaited<ReturnType<typeof loadConfig>>;`.
- [src/mcp/fsGuard.test.ts](../../../src/mcp/fsGuard.test.ts#L22).

## Step 5 — Add new test cases in `src/config.test.ts`

Append three cases to the existing `describe("loadConfig", …)`
block. **Important**: use the existing sync `mkdirSync` and
`writeFileSync` helpers already imported at
[src/config.test.ts](../../../src/config.test.ts#L3). Do not add
new `node:fs/promises` imports. Each write is preceded by
`mkdirSync(saivageRoot, { recursive: true })` mirroring
[src/config.test.ts](../../../src/config.test.ts#L51-L52).

```ts
it("two concurrent loaders see independent snapshots", async () => {
  const saivageRoot = join(projectRoot, ".saivage");
  mkdirSync(saivageRoot, { recursive: true });
  writeFileSync(
    join(saivageRoot, "saivage.json"),
    JSON.stringify({ models: { default: "openai/gpt-5" } }),
  );
  const [a, b] = await Promise.all([
    loadConfig(projectRoot),
    loadConfig(projectRoot),
  ]);
  expect(a).not.toBe(b);
  (a.models as { default?: unknown }).default = "tampered";
  const c = await loadConfig(projectRoot);
  expect(c.models.default).toBe("openai/gpt-5");
});

it("reflects edits made between calls", async () => {
  const saivageRoot = join(projectRoot, ".saivage");
  mkdirSync(saivageRoot, { recursive: true });
  const fp = join(saivageRoot, "saivage.json");
  writeFileSync(fp, JSON.stringify({ mcp: { shellTimeoutMs: 11 * 60_000 } }));
  const first = await loadConfig(projectRoot);
  expect(first.mcp.shellTimeoutMs).toBe(11 * 60_000);
  writeFileSync(fp, JSON.stringify({ mcp: { shellTimeoutMs: 12 * 60_000 } }));
  const second = await loadConfig(projectRoot);
  expect(second.mcp.shellTimeoutMs).toBe(12 * 60_000);
});

it("rejects on malformed JSON", async () => {
  const saivageRoot = join(projectRoot, ".saivage");
  mkdirSync(saivageRoot, { recursive: true });
  writeFileSync(join(saivageRoot, "saivage.json"), "not json");
  await expect(loadConfig(projectRoot)).rejects.toThrow(SyntaxError);
});
```

## Step 6 — Add the no-sync-fs regression test (r3)

New file:
[src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts).

```ts
import { describe, it, expect } from "vitest";
import { sep } from "node:path";
import { scanForSyncFs } from "./testing/noSyncFsScanner.js";

describe("src/config.ts is async-fs only", () => {
  it("permits only the existsSync carve-out in resolveProjectRoot", async () => {
    const all = await scanForSyncFs({
      roots: ["src"],
      // Default allow-list ["createWriteStream"] (G30). existsSync
      // is NOT broadened workspace-wide; it is narrowed to
      // src/config.ts via the post-filter below.
    });
    const configViolations = all
      .filter(
        (v) =>
          v.file === `src${sep}config.ts` ||
          v.file.endsWith(`${sep}src${sep}config.ts`),
      )
      // Stable order so the assertion is independent of the
      // scanner's traversal order between the named import and
      // the call site.
      .map((v) => ({ kind: v.kind, detail: v.detail }))
      .sort((a, b) =>
        a.kind === b.kind
          ? a.detail.localeCompare(b.detail)
          : a.kind.localeCompare(b.kind),
      );

    // The G30 scanner emits both kinds for the existsSync carve-out:
    //   - disallowed-named-import from `import { existsSync } from "node:fs"`
    //     at src/config.ts L2 (existsSync is not in the default
    //     allow-list).
    //   - sync-call from the call inside resolveProjectRoot at L208.
    // Any new sync-fs surface in src/config.ts adds a third entry
    // and fails this assertion.
    expect(configViolations).toEqual([
      { kind: "disallowed-named-import", detail: "existsSync" },
      { kind: "sync-call", detail: "existsSync" },
    ]);
  });
});
```

Why this exact shape (r3, reviewer-required per
[04-review-r2.md](04-review-r2.md#L11-L19)):

- The G30 scanner contract
  ([../G30/02-design-r2.md](../G30/02-design-r2.md#L167-L215))
  emits a `disallowed-named-import` violation for any named import
  from `node:fs` not in `allowedNamedImports`, **and** emits a
  `sync-call` violation when that import is invoked. Both fire for
  the `existsSync` carve-out kept in
  [src/config.ts](../../../src/config.ts).
- `roots: ["src"]` matches the shipped scanner API
  ([../G30/02-design-r2.md](../G30/02-design-r2.md#L226-L242))
  which recurses directories via `readdir` — it cannot be pointed
  at a single file path.
- The **default** allow-list `["createWriteStream"]` is used; the
  test does **not** add `existsSync` to it. Other modules' sync-fs
  violations are isolated by the post-filter, not silenced — they
  are owned by their own findings (G06 `runtime/`, the workspace-
  wide guard gated by G30's audit, etc.).
- The `sort` step makes the assertion order-independent across
  scanner implementations and avoids depending on whether the
  import or the call is discovered first.
- If a second `existsSync` call (or any other `*Sync`) appears in
  `src/config.ts`, or a second named import is added, `configViolations`
  grows beyond two entries and the assertion fails.

## Step 7 — Local validation

```bash
cd /home/salva/g/ml/saivage
npx tsc --noEmit
npx vitest run \
  src/config.test.ts \
  src/config.no-sync-fs.test.ts \
  src/auth/defaults.test.ts \
  src/store/project.test.ts \
  src/mcp/builtins.test.ts \
  src/mcp/fsGuard.test.ts
npx tsup
```

`tsc --noEmit` is the primary correctness gate — the `await`
cascade through three auth files + bootstrap + cli is mechanical
and the compiler enforces every site. `tsup` confirms the cli
bundle still emits.

Also re-run the G36 owner's
[src/auth/no-sync-fs.test.ts](../../../src/auth/no-sync-fs.test.ts)
(if present per
[../G36/APPROVED.md](../G36/APPROVED.md)) and G30's
[src/mcp/no-sync-fs.test.ts](../../../src/mcp/no-sync-fs.test.ts)
to confirm neither has regressed.

## Step 8 — Deployment validation

Per [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](file:///home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md)
and the daemon list in [../G30/APPROVED.md](../G30/APPROVED.md):

```bash
# Build artefact lives at host; containers bind-mount /opt/saivage.
ssh root@10.0.3.111 'systemctl restart saivage.service && sleep 3 && \
  systemctl is-active saivage.service && curl -fsS http://127.0.0.1:8080/health'
ssh root@10.0.3.112 'systemctl restart saivage.service && sleep 3 && \
  systemctl is-active saivage.service && curl -fsS http://127.0.0.1:8080/health'
ssh root@10.0.3.113 'systemctl restart saivage.service && sleep 3 && \
  systemctl is-active saivage.service && curl -fsS http://127.0.0.1:8080/health'
```

Smoke: hit `GET /api/config` on each daemon; confirm `routing.planner`
and `routing.chat` populated (proves `bootstrap` finished
`await loadConfig` and `ModelRoutingResolver` constructed from the
async-loaded config). No new endpoints to exercise.

`saivage-v3-getrich-v2` (10.0.3.170) does not bind-mount the host
`saivage/` tree, so it is unaffected — same scope rule as G30/G36.

---

## Sequencing summary (revised)

1. **G30 must be merged first** (provides
   [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts)).
2. **G36 must be merged first** (removes the
   [src/auth/store.ts](../../../src/auth/store.ts#L10) import of
   `ensureDir` from `../config.js`). This is **revised from r1**,
   where G36 and G37 were incorrectly described as independent.
3. After G30 and G36 both land, **G37 lands as a single PR** with
   the steps above.
4. Final `node:fs` named-import surface in `src/` after the three
   patches: `createWriteStream` (allow-listed by G30), `existsSync`
   in `src/config.ts` `resolveProjectRoot` (carved out by G37 via
   a `src/config.ts`-scoped post-filter in
   [src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts)),
   plus documented out-of-scope carve-outs in `bootstrap`
   (fatal `writeFileSync`) and `runtime/stash.ts`.

## Rollback

Single PR. `git revert` undoes the entire migration. No data-shape
changes, no on-disk format changes, no public-API additions —
only an async-ifies-a-loader signature change. Rollback is safe.

If G36 is reverted after G37 has landed, G37 must be reverted in
the same commit or `auth/store.ts` rebuilt to no longer import the
removed `ensureDir` export. See
[02-design-r3.md](02-design-r3.md) §Risk #5.
