# G12b — Plan (Round 2)

**Companion docs:** [01-analysis-r2.md](01-analysis-r2.md),
[02-design-r2.md](02-design-r2.md).

All edits land in [saivage](../../../../) (Saivage v2). No changes to
`saivage-v3/`. Project rule:
[WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md) →
architecture-first, no backward compatibility, no migration shim.

This round 2 plan supersedes [03-plan-r1.md](03-plan-r1.md). Edits E1,
E2, E3, E5, E6 are unchanged from round 1; E4 is extended to make the
top-level schema strict; E7, E8, E9 carry over from round 1 with the
typo / fixture fixes the reviewer required; E10, E11, E12, E13 are new
or extended.

## Edit set

### E1 — Delete the cop module (unchanged)

`git rm` [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts).
`git rm` [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts).

### E2 — Strip cop wiring from src/mcp/builtins.ts (unchanged)

Identical to [03-plan-r1.md §E2](03-plan-r1.md#e2--strip-cop-wiring-from-srcmcpbuiltinsts).
Eight sub-steps: drop the two cop imports at
[L32-L33](../../../../src/mcp/builtins.ts#L32-L33); drop
`MAX_SCAN_DECODE_BYTES` at L44; drop `prompt_injection_scan` from
`DownloadSuccess` at L121; drop `BuiltinServicesOptions` at L124-L126;
drop `isTextLikeContentType` / `looksTextLike` / `bufferToScannableText`
/ `scanUntrustedText` at L128-L160; trim `downloadUrl` body at L162-L226;
trim the four cases inside `createDataHandler` at L734-L894 and
demote `createDataHandler` to a module-level `dataHandler`; trim
`registerBuiltinServices` at L1067-L1112 to a two-parameter signature.

### E3 — Strip cop wiring from src/server/bootstrap.ts (unchanged)

Identical to [03-plan-r1.md §E3](03-plan-r1.md#e3--strip-cop-wiring-from-srcserverbootstrapts).
Remove the `createPromptInjectionCop` import at
[L13](../../../../src/server/bootstrap.ts#L13); remove the
`securityModel: config.security.injectionModel,` line at L133;
collapse the `registerBuiltinServices(...)` call at L145-L151 to
`registerBuiltinServices(mcpRuntime, config.mcp);`.

### E4 — Drop the `security` config block and make the schema strict (extended)

File: [src/config.ts](../../../../src/config.ts)

Two changes in this file:

1. Remove the entire `security: z.object({ … }).default({}),` block at
   [L111-L117](../../../../src/config.ts#L111-L117).
2. Append `.strict()` to the top-level `configSchema` object literal.
   Today the literal closes at line ~193 with `mcpServers: z.record(...).default({})`
   followed by `});`. The new closing is `}).strict();`. After the
   change a stale `{ security: { … }, … }` config produces a Zod
   parse error of kind `unrecognized_keys` at boot.

No other adjustments to `loadConfig`: it already calls
`configSchema.parse(raw)` so the strict check fires automatically.

### E5 — Drop the `security` branch from boot validation (unchanged)

Identical to [03-plan-r1.md §E5](03-plan-r1.md#e5--drop-the-security-branch-from-boot-validation).
Remove the `if (config.security.injectionScanner) { … }` block at
[src/config-validation.ts L61-L66](../../../../src/config-validation.ts#L61-L66).

### E6 — Drop the `security` routing role (unchanged)

Identical to [03-plan-r1.md §E6](03-plan-r1.md#e6--drop-the-security-routing-role).
Remove `security: "security",` from `ROUTING_ROLE_TO_MODEL_KEY` at
[L9](../../../../src/routing/resolver.ts#L9); remove
`securityModel?: string;` at
[L63](../../../../src/routing/resolver.ts#L63); remove the
`if (role === "security")` branch at
[L249](../../../../src/routing/resolver.ts#L249).

### E7 — Rewrite src/mcp/builtins.test.ts (carried from round 1)

Identical to [03-plan-r1.md §E7](03-plan-r1.md#e7--rewrite-srcmcpbuiltinstestts).
Remove the `PromptInjectionCop` type import at
[L10](../../../../src/mcp/builtins.test.ts#L10); delete the two
`"blocks fetched content rejected by the prompt-injection cop"` and
`"does not write downloaded files rejected by the prompt-injection
cop"` tests at L220-L261; add the single positive
`"returns external content verbatim with no cop on the data path"`
test (literal block in
[03-plan-r1.md §E7 step 3](03-plan-r1.md#e7--rewrite-srcmcpbuiltinstestts)).

### E8 — Rewrite src/config-validation.test.ts (carried from round 1)

Identical to [03-plan-r1.md §E8](03-plan-r1.md#e8--rewrite-srcconfig-validationtestts).
Strip `security` from `makeConfig` at
[L23](../../../../src/config-validation.test.ts#L23); strip the six
`security: { ...makeConfig().security, … } as SaivageConfig["security"]`
overrides at L52, L62, L78, L112, L126; drop the
`"security enabled + no model anywhere => security in error"` test
at L100-L106 and any `expect(...roles).toContain("security")` /
`.not.toContain("security")` assertion; strip the
`securityModel: "github-copilot/gpt-5.4"` argument to
`ModelRoutingResolver` at L44.

### E9 — Rewrite src/routing/resolver.test.ts (carried from round 1)

Identical to [03-plan-r1.md §E9](03-plan-r1.md#e9--rewrite-srcroutingresolvertestts).
Replace the
`"uses shared runtime defaults for supervisor and security roles"` test
at [L102-L120](../../../../src/routing/resolver.test.ts#L102-L120)
with the `"uses shared runtime defaults for the supervisor role"`
variant that drops `securityModel` and asserts
`resolver.resolve("security")` throws `MissingModelForRoleError`.

### E10 — Strip `security` from runtime / provider test fixtures (new in round 2)

This is the round 1 blocker (i): three live test fixtures still build
a `security` block. After E4 they fail typecheck. Each is edited in
isolation.

File: [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts)

- Remove the entire block at
  [L327-L331](../../../../src/runtime/runtime.test.ts#L327-L331):

  ```ts
  security: {
    injectionScanner: true,
    injectionModel: "github-copilot/gpt-5.4",
    maxScanLengthBytes: 100_000,
  },
  ```

  including its leading comma on L326 and trailing comma on L331 so
  the surrounding `makeSupervisorConfig` literal still parses. The
  `notifications`, `mcpServers`, `supervisor`, and `telegram` keys
  remain.

File: [src/providers/router.test.ts](../../../../src/providers/router.test.ts)

- Remove the line at
  [L26](../../../../src/providers/router.test.ts#L26):

  ```ts
  security: { injectionScanner: true, maxScanLengthBytes: 100000 },
  ```

  The surrounding `makeConfig` literal still constructs a valid
  `SaivageConfig` because `security` no longer exists on the type.

File: [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts)

- Remove the line at
  [L34](../../../../src/providers/model-capabilities.test.ts#L34):

  ```ts
  security: { injectionScanner: true, maxScanLengthBytes: 100000 },
  ```

  Same rationale.

The `project: { root, venv, description }` field in
[src/providers/router.test.ts L24](../../../../src/providers/router.test.ts#L24)
and [src/providers/model-capabilities.test.ts L32](../../../../src/providers/model-capabilities.test.ts#L32)
is **out of scope** for this issue. It is a separate dead-fixture
artifact that does not exist on `SaivageConfig` either; it surfaces
only because the `as SaivageConfig` cast happens implicitly through
`Partial<SaivageConfig>`. It does not interact with the cop deletion
or the strict-schema change at runtime, so leaving it alone keeps
this issue focused.

### E11 — Add no-cop invariant test (new in round 2)

File: new
[src/security/no-cop.test.ts](../../../../src/security/no-cop.test.ts).

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const FORBIDDEN = [
  "PromptInjection",
  "promptInjectionCop",
  "prompt-injection-cop",
  "scanUntrustedText",
  "prompt_injection_scan",
  "injectionScanner",
  "injectionModel",
  "maxScanLengthBytes",
  "securityModel",
  `security: "security"`,
  "SecurityStatusRing",
  "securityStatusRing",
  "/api/debug/security",
];

const REPO_ROOT = join(__dirname, "..", "..");

const SCAN_EXTS = [".ts", ".tsx", ".vue", ".md", ".json"];
const SCAN_ROOTS = ["src", "web/src", "docs"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".vitepress/cache", "web/dist"]);
const SKIP_FILES = new Set(["no-cop.test.ts"]);

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (SCAN_EXTS.some((ext) => entry.endsWith(ext))) {
      if (!SKIP_FILES.has(basename(full))) out.push(full);
    }
  }
  return out;
}

describe("G12b — prompt-injection cop removal", () => {
  it("no live file references the cop or any of its hangers-on", () => {
    const candidates = SCAN_ROOTS.flatMap((relative) => {
      const abs = join(REPO_ROOT, relative);
      try {
        return walk(abs);
      } catch {
        return [];
      }
    });

    const offenders: Array<{ path: string; needle: string }> = [];
    for (const path of candidates) {
      const body = readFileSync(path, "utf-8");
      for (const needle of FORBIDDEN) {
        if (body.includes(needle)) offenders.push({ path, needle });
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

This satisfies review concern (iii): the invariant covers the full
residue vocabulary from
[01-analysis-r2.md §2.4](01-analysis-r2.md#24-full-residue-vocabulary)
and walks `docs/**` in addition to `src/**` and `web/src/**`.

### E12 — Docs cleanup (extended in round 2)

1. `git rm` [docs/internals/security.md](../../../../docs/internals/security.md).
2. In [docs/internals/architecture.md](../../../../docs/internals/architecture.md#L99),
   delete the
   `| Security | src/security/prompt-injection-cop.ts | Optional content scanner. |`
   row.
3. In [docs/.vitepress/config.ts](../../../../docs/.vitepress/config.ts#L144),
   delete the line
   `{ text: "Security: Prompt-Injection Cop", link: "/internals/security" },`.
4. In [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md#L184-L194),
   delete the block:

   ```
   ### security

   ```json
   "security": {
     "injectionScanner": true,
     "maxScanLengthBytes": 100000
   }
   ```

   Drives the [Prompt-Injection Cop](/internals/security). `injectionModel` is
   required when the scanner is enabled; the daemon refuses to boot otherwise.
   See [F04](../../SPEC/v2/review-2026-05/F04-hardcoded-default-models.md).
   ```

   Surrounding `### runtime` and `### supervisor` sections stay.
5. In [docs/internals/testing.md](../../../../docs/internals/testing.md#L35),
   delete the row
   `| `src/security/*.test.ts` | Prompt-injection cop. |`.
6. In [docs/internals/source-tree.md](../../../../docs/internals/source-tree.md#L24),
   replace
   `│   ├── security/               # prompt-injection cop`
   with
   `│   ├── security/               # secret env scrubbing`.
7. Run `npm run docs:api` (the actual script per
   [package.json L21](../../../../package.json#L21)) to regenerate
   `docs/api/**`. Verify in validation (§V3) that the regenerated tree
   contains no residue from §E11's `FORBIDDEN` list.

### E13 — Operator runbook note (unchanged)

Documentation-only; mirrors round 1 §E12.
`.saivage/saivage.json` files that still carry a `security: { … }`
block will now produce a Zod `unrecognized_keys` error at boot. The
operator must strip the block from each project's local config before
restarting the daemon. No automated migration; no shim. The three live
v2 deployments (`saivage` 10.0.3.111, `saivage-v3` v2-harness 10.0.3.112,
`diedrico` 10.0.3.113 per
[WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md)) are
inspected and edited as part of the rollout.

## Validation

V1. `npm run typecheck` (root) passes. After E4 the strict-schema
    change and the `security`-removal cascade through every fixture
    edited in E7-E10; any missed fixture surfaces as a `TS2353`
    "Object literal may only specify known properties" error.

V2. `npm test` (root) passes. The new tests are:

    - E10 ("returns external content verbatim with no cop on the data
      path") in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).
    - The strict-schema rejection test added to
      [src/config.test.ts](../../../../src/config.test.ts) (or
      `src/config-validation.test.ts` if the existing schema-parse
      tests live there):

      ```ts
      it("rejects stale `security` block as an unrecognized top-level key", () => {
        const raw = { models: {}, security: { injectionScanner: true } };
        const result = configSchema.safeParse(raw);
        expect(result.success).toBe(false);
        if (result.success) return;
        const unrecognized = result.error.issues.find(
          (issue) => issue.code === "unrecognized_keys",
        );
        expect(unrecognized).toBeDefined();
        expect((unrecognized as { keys: string[] }).keys).toContain("security");
      });
      ```

    - E11 ("no live file references the cop or any of its
      hangers-on") in [src/security/no-cop.test.ts](../../../../src/security/no-cop.test.ts).

V3. `npm run docs:build` (the actual VitePress + typedoc target per
    [package.json L23](../../../../package.json#L23)) succeeds and the
    resulting tree under `docs/api/**` and `docs/.vitepress/dist/**`
    contains none of the substrings in E11's `FORBIDDEN` list. Verify
    with the one-liner
    `grep -rIn "PromptInjection\|injectionScanner\|injectionModel\|maxScanLengthBytes\|prompt_injection_scan\|securityModel\|scanUntrustedText\|prompt-injection-cop\|SecurityStatusRing\|/api/debug/security" docs/`
    returning no matches.

V4. Manual repo-wide grep, equivalent to the static test in E11 but
    one-shot over the working tree:

    ```bash
    grep -rIn \
      'PromptInjection\|promptInjectionCop\|prompt-injection-cop\|scanUntrustedText\|prompt_injection_scan\|injectionScanner\|injectionModel\|maxScanLengthBytes\|securityModel\|security: "security"\|SecurityStatusRing\|securityStatusRing\|/api/debug/security' \
      src web docs
    ```

    Expected: empty.

V5. Live boot test. Start the daemon against a project whose
    `.saivage/saivage.json` is current (no `security` block). Confirm
    `/health` returns 200. Then inject a `"security": { "injectionScanner": true }`
    key into the config and restart; confirm boot fails with a Zod
    error citing `unrecognized_keys` and `security`. Strip the key,
    restart; boot succeeds again. Performed against the `saivage-v3`
    v2-harness container at 10.0.3.112 per
    [WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md).

## Rollback

Single commit; revert it. No data migration. The cop file resurrects
as it existed at HEAD~1; the four test fixtures and six docs revert in
the same change.
