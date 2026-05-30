# G37 — Implementation Plan (r1)

**Finding**: [../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md)
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
**Design**: [02-design-r1.md](02-design-r1.md) — Proposal A
**Depends on (must land first)**: [../G30/APPROVED.md](../G30/APPROVED.md) (shared scanner at [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts)).
**Coordinates with**: [../G36/APPROVED.md](../G36/APPROVED.md) (sibling sync-fs migration; either order is fine — see [02-design-r1.md](02-design-r1.md#L0)).

Implementation is a single PR. Steps are listed in compile-error
order: each step makes the codebase temporarily un-compilable until
the next step lands, but the final commit is green.

---

## Step 1 — Rewrite `loadConfig`, drop the cache and `ensureDir`

File: [src/config.ts](../../../src/config.ts)

Edits:

1. Replace the `node:fs` import at
   [L2](../../../src/config.ts#L2) with:
   ```ts
   import { existsSync } from "node:fs"; // resolveProjectRoot only
   import { readFile } from "node:fs/promises";
   ```
   `mkdirSync` and `readFileSync` go away.
2. Add `import { pathExists } from "./store/documents.js";` near the
   other internal imports (right after the `auth/defaults.js` import
   at [L6-L9](../../../src/config.ts#L6-L9)).
3. Delete `let cached: SaivageConfig | null = null;`
   ([L259](../../../src/config.ts#L259)) and
   `let cachedConfigDir: string | null = null;`
   ([L260](../../../src/config.ts#L260)).
4. Replace the `loadConfig` body ([L261-L273](../../../src/config.ts#L261)) with:
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
5. Delete the `ensureDir` export at
   [L279-L281](../../../src/config.ts#L279-L281).

Verify: `git diff src/config.ts` shows exactly five hunks, all
inside the L1-L281 range. No other lines change.

## Step 2 — Drop `ensureDir` from the barrel

File: [src/index.ts](../../../src/index.ts)

Edit:

- Remove the line `ensureDir,` at
  [L35](../../../src/index.ts#L35).

## Step 3 — Cascade `await` through `bootstrap` and CLI

File: [src/server/bootstrap.ts](../../../src/server/bootstrap.ts)

- L128: `const config = loadConfig(true, project.projectRoot);` →
  `const config = await loadConfig(project.projectRoot);`.

File: [src/server/cli.ts](../../../src/server/cli.ts)

- L289: `const config = loadConfig(true, root ?? undefined);` →
  `const config = await loadConfig(root ?? undefined);`.
- L432: `const cfg = loadConfig();` →
  `const cfg = await loadConfig();`. (Already inside an `async` arrow
  and a `try/catch`; no other change.)

## Step 4 — Update OAuth driver call sites

File: [src/auth/anthropic.ts](../../../src/auth/anthropic.ts)

- L51, L82, L166:
  `const clientId = loadConfig().oauth.anthropic.clientId;` →
  `const clientId = (await loadConfig()).oauth.anthropic.clientId;`.

File: [src/auth/openai-codex.ts](../../../src/auth/openai-codex.ts)

- L61, L92, L176: same shape with
  `.oauth.openaiCodex.clientId`.

File: [src/auth/github-copilot.ts](../../../src/auth/github-copilot.ts)

- L67, L114: same shape with `.oauth.githubCopilot.clientId`.

Every site is already inside an `async function` — verified in
[01-analysis-r1.md](01-analysis-r1.md#L2) §2.

## Step 5 — Update test fixtures

For each file below, replace `loadConfig(true, <root>)` with
`await loadConfig(<root>)` and ensure the enclosing arrow is
`async`:

- [src/config.test.ts](../../../src/config.test.ts) — lines 30, 38,
  58, 82, 112, 117. Lines 97, 102, 107 (the `expect(() => loadConfig(...)).toThrow`
  cases) become
  `await expect(loadConfig(projectRoot)).rejects.toThrow(/WALL_CLOCK_HEADROOM_MS/)`
  and `…/inner cap/`.
- [src/store/project.test.ts](../../../src/store/project.test.ts#L79)
  and [L86](../../../src/store/project.test.ts#L86).
- [src/auth/defaults.test.ts](../../../src/auth/defaults.test.ts#L51),
  [L61](../../../src/auth/defaults.test.ts#L61),
  [L72](../../../src/auth/defaults.test.ts#L72).
- [src/mcp/builtins.test.ts](../../../src/mcp/builtins.test.ts#L54),
  [L285](../../../src/mcp/builtins.test.ts#L285). The type alias
  `let cfg: ReturnType<typeof loadConfig>` at L35 becomes
  `let cfg: Awaited<ReturnType<typeof loadConfig>>;`.
- [src/mcp/fsGuard.test.ts](../../../src/mcp/fsGuard.test.ts#L22).

## Step 6 — Add new test cases in `src/config.test.ts`

Append three cases to the existing `describe("loadConfig", …)`
block (design [02-design-r1.md](02-design-r1.md#L0) §Test impact
cases 4, 5, 6):

```ts
it("two concurrent loaders see independent snapshots", async () => {
  await writeFile(join(projectRoot, ".saivage", "saivage.json"),
    JSON.stringify({ models: { default: "openai/gpt-5" } }));
  const [a, b] = await Promise.all([loadConfig(projectRoot), loadConfig(projectRoot)]);
  expect(a).not.toBe(b);
  (a.models as { default?: unknown }).default = "tampered";
  const c = await loadConfig(projectRoot);
  expect(c.models.default).toBe("openai/gpt-5");
});

it("reflects edits made between calls", async () => {
  const fp = join(projectRoot, ".saivage", "saivage.json");
  await writeFile(fp, JSON.stringify({ mcp: { shellTimeoutMs: 11 * 60_000 } }));
  const first = await loadConfig(projectRoot);
  expect(first.mcp.shellTimeoutMs).toBe(11 * 60_000);
  await writeFile(fp, JSON.stringify({ mcp: { shellTimeoutMs: 12 * 60_000 } }));
  const second = await loadConfig(projectRoot);
  expect(second.mcp.shellTimeoutMs).toBe(12 * 60_000);
});

it("rejects on malformed JSON", async () => {
  await writeFile(join(projectRoot, ".saivage", "saivage.json"), "not json");
  await expect(loadConfig(projectRoot)).rejects.toThrow(SyntaxError);
});
```

`writeFile` is the async `node:fs/promises` import; existing tests
in the file already use the async pattern after F22 cascaded
through, so no new test util is needed.

## Step 7 — Add the no-sync-fs regression test

New file:
[src/config.no-sync-fs.test.ts](../../../src/config.no-sync-fs.test.ts).

```ts
import { describe, it, expect } from "vitest";
import { scanForSyncFs } from "./testing/noSyncFsScanner.js";

describe("src/config.ts is async-fs only", () => {
  it("uses no node:fs sync APIs apart from existsSync in resolveProjectRoot", async () => {
    const violations = await scanForSyncFs({
      roots: ["src/config.ts"],
      allowedNamedImports: ["existsSync"],
      extensions: [".ts"],
      skipPathContains: [],
    });
    expect(violations).toEqual([]);
  });
});
```

Notes:

- The scanner accepts a file path or a directory as a `roots` entry
  (G30's signature, per [../G30/APPROVED.md](../G30/APPROVED.md)).
  If the implementation only accepts directories, swap `roots`
  to `["src"]` and rely on `skipPathContains` to narrow to
  `config.ts` — both behaviours are scannable; pick the one the
  shipped scanner supports.
- The `existsSync` allow-list is a single name, tightly scoped: any
  additional sync import in `config.ts` (or any
  `*Sync(` call other than the explicit
  `existsSync(...)` in `resolveProjectRoot`) fails the test.

## Step 8 — Add the barrel-cleanliness test

New (or extended) file:
[src/index.test.ts](../../../src/index.test.ts).

```ts
import { describe, it, expect } from "vitest";
import * as barrel from "./index.js";

describe("src/index.ts barrel", () => {
  it("no longer re-exports ensureDir from config", () => {
    expect("ensureDir" in barrel).toBe(false);
  });
});
```

If [src/index.test.ts](../../../src/index.test.ts) does not yet
exist, create with that single `describe`.

## Step 9 — Local validation

```bash
cd /home/salva/g/ml/saivage
npx tsc --noEmit
npx vitest run src/config.test.ts src/config.no-sync-fs.test.ts \
                src/index.test.ts src/auth src/store/project.test.ts \
                src/mcp/builtins.test.ts src/mcp/fsGuard.test.ts
npx tsup
```

`tsc --noEmit` is the primary correctness gate (the `await` cascade
through three auth files + bootstrap + cli is mechanical and the
compiler enforces it). `tsup` confirms the cli bundle still emits.

## Step 10 — Deployment validation

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
and `routing.chat` are populated (proves `bootstrap` finished
`await loadConfig` and `ModelRoutingResolver` constructed from the
async-loaded config). No new endpoints to exercise — the surface is
unchanged.

`saivage-v3-getrich-v2` (10.0.3.170) does not bind-mount the host
`saivage/` tree, so it is unaffected — same scope rule as G30/G36.

---

## Sequencing summary

1. **G30 must be merged first** (provides
   [src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts)).
2. **G36 and G37 are independent.** Either order is fine. The
   rebase-the-second-one cost is one trivial conflict resolution
   per overlapping `auth/*.ts` file (G36 touches `auth/store.ts`
   only; G37 touches `auth/{anthropic,openai-codex,github-copilot}.ts`
   only — disjoint).
3. After all three land, `src/`'s remaining `node:fs` named-import
   surface is the documented allow-list (`createWriteStream`,
   `existsSync` in `config.resolveProjectRoot`) plus the explicit
   out-of-scope carve-outs (`bootstrap` fatal `writeFileSync`,
   `runtime/stash.ts`). Each of those carve-outs is tracked as a
   separate finding or is owned by a different subsystem.

## Rollback

Single PR. `git revert` undoes the entire migration. No data-shape
changes, no on-disk format changes, no public API additions —
only an async-ifies-a-loader signature change. Rollback is safe.
