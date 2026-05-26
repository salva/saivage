# G12b — Design (Round 3)

**Companion docs:** [01-analysis-r3.md](01-analysis-r3.md),
[03-plan-r3.md](03-plan-r3.md).

Round 3 is a minimal delta on [02-design-r2.md](02-design-r2.md) that
resolves the two blockers from [04-review-r2.md](04-review-r2.md):

1. The stale-`security` regression test is reframed against the public
   `loadConfig` entry point with an on-disk fixture, rather than
   against the unexported `configSchema`. The export surface of
   [src/config.ts](../../../../src/config.ts) does not change.
2. The no-cop invariant residue vocabulary is unchanged; only the
   inventory commentary in [01-analysis-r3.md §3](01-analysis-r3.md)
   gains the missing `PromptInjection` site in
   [src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts#L13).

Everything else in [02-design-r2.md](02-design-r2.md) — §2.1 result
shapes, §2.3 routing-role table, §2.4 boot validation, §2.5 bootstrap,
§2.6 builtins, §2.7 test fixtures, §2.8 docs, §2.9 module deletion,
§3.1 positive data-path test, §3.3 no-cop invariant test, §4 compliance
check, §5 out-of-scope — carries over verbatim.

## 2. Resulting contracts

### 2.2 Config schema (`src/config.ts`) — clarified, not changed

The Zod edits are exactly as in
[02-design-r2.md §2.2](02-design-r2.md#22-config-schema-srcconfigts):

1. Remove the entire `security: z.object({ … }).default({})` block at
   [src/config.ts L111-L117](../../../../src/config.ts#L111-L117).
2. Append `.strict()` to the top-level `configSchema` literal. The
   literal closes today at line ~193 with `mcpServers: z.record(...)`
   followed by `});`; the new closing is `}).strict();`.

`configSchema` remains a **module-local** `const`. It is **not**
exported. Round 2 implicitly required exporting it to support the
regression test in §3.2; round 3 reframes the test against the public
`loadConfig` path (see §3.2 below), so no export is added. Keeping
`configSchema` private matches the architecture-first rule (no
test-only widening of the public surface).

All other text in [02-design-r2.md §2.2](02-design-r2.md#22-config-schema-srcconfigts)
about the boot-time `ZodError` and the surviving "prefer config" knobs
holds unchanged.

### 2.7 Test fixtures — unchanged

Round 2's §2.7 list (runtime.test.ts, router.test.ts,
model-capabilities.test.ts, config-validation.test.ts,
routing/resolver.test.ts, mcp/builtins.test.ts) carries over verbatim
from [02-design-r2.md §2.7](02-design-r2.md#27-test-fixtures--new-in-round-2).
The single edit that this round 3 adds to the test surface is the
stale-`security` regression test in §3.2 below, which lives in
[src/config.test.ts](../../../../src/config.test.ts) and uses only the
public `loadConfig` entry point.

## 3. Regression tests

### 3.1 No cop on the data path — unchanged

Same test, same file, same wording as
[02-design-r2.md §3.1](02-design-r2.md#31-no-cop-on-the-data-path-unchanged).

### 3.2 Stale `security` block fails boot via `loadConfig` (replaces round 2 §3.2)

A new test in [src/config.test.ts](../../../../src/config.test.ts) (in
the existing `describe("loadConfig", …)` block at L29-L88, beside the
fixture-based tests already there) writes
`<projectRoot>/.saivage/saivage.json` with payload
`{ "security": { "injectionScanner": true } }` and calls
`loadConfig(true, projectRoot)`. The test asserts:

- `loadConfig` throws.
- The thrown error is a `ZodError` (imported from `zod`) whose
  `issues` array contains at least one issue with
  `code === "unrecognized_keys"` and a `keys` array that includes the
  literal string `"security"`.

This pins down the round 2 stale-config policy through the daemon's
real boot path — same file system layout (`<projectRoot>/.saivage/saivage.json`),
same `loadConfig(useDefaults, projectRoot)` signature, same Zod
configuration. No new exports from
[src/config.ts](../../../../src/config.ts) are required.

The exact assertion shape (literal block; goes into
[03-plan-r3.md §V2](03-plan-r3.md#validation)):

```ts
import { ZodError } from "zod";
// …
it("rejects a stale `security` block at the top level", () => {
  const saivageRoot = join(projectRoot, ".saivage");
  mkdirSync(saivageRoot, { recursive: true });
  writeFileSync(
    join(saivageRoot, "saivage.json"),
    JSON.stringify({ security: { injectionScanner: true } }, null, 2),
  );

  let caught: unknown;
  try {
    loadConfig(true, projectRoot);
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(ZodError);
  const issues = (caught as ZodError).issues;
  const unrecognized = issues.find((issue) => issue.code === "unrecognized_keys");
  expect(unrecognized).toBeDefined();
  expect((unrecognized as { keys?: string[] }).keys ?? []).toContain("security");
});
```

The existing `beforeEach` / `afterEach` in
[src/config.test.ts L9-L17](../../../../src/config.test.ts#L9-L17) already
sets up and tears down `projectRoot`, so the test needs no extra
plumbing.

### 3.3 No cop hangers-on anywhere — unchanged

Same as
[02-design-r2.md §3.3](02-design-r2.md#33-no-cop-hangers-on-anywhere-extended-in-round-2).
The residue list (`PromptInjection`, `promptInjectionCop`,
`prompt-injection-cop`, `scanUntrustedText`, `prompt_injection_scan`,
`injectionScanner`, `injectionModel`, `maxScanLengthBytes`,
`securityModel`, `security: "security"`, `SecurityStatusRing`,
`securityStatusRing`, `/api/debug/security`) and the
`src/**` + `web/src/**` + `docs/**` walk are unchanged. The walker
naturally catches the bootstrap occurrence
([src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts#L13))
once the round 2 plan §E3 deletes the `createPromptInjectionCop`
import.

## 4. Compliance check — unchanged

Same table as [02-design-r2.md §4](02-design-r2.md#4-compliance-check).
The change in §3.2 strengthens the "architecture-first / no backward
compatibility" row — the regression now goes through the real boot
path, not an internal schema handle.

## 5. Out of scope — unchanged

Same as [02-design-r2.md §5](02-design-r2.md#5-out-of-scope).
