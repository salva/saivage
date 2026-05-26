# G12b — Plan (Round 3)

**Companion docs:** [01-analysis-r3.md](01-analysis-r3.md),
[02-design-r3.md](02-design-r3.md).

All edits land in [saivage](../../../../) (Saivage v2). No changes to
`saivage-v3/`. Project rule:
[WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md) →
architecture-first, no backward compatibility, no migration shim.

This round 3 plan supersedes [03-plan-r2.md](03-plan-r2.md). Only two
deltas relative to round 2:

- The stale-`security` regression test in §V2 is rewritten to call
  `loadConfig` against an on-disk fixture, removing the assumption
  that `configSchema` is exported. No edit to
  [src/config.ts](../../../../src/config.ts)'s export surface.
- The narrative commentary noting that
  [src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts#L13)
  is a `PromptInjection` residue site is now consistent with the
  inventory. The edit set already deletes that import in §E3 of round 2;
  no plan-step change is needed.

Edits E1 through E13 are unchanged from
[03-plan-r2.md](03-plan-r2.md). They are referenced by ID below and
**not** re-listed; the implementer applies them as written in round 2.

## Edit set

### E1 — Delete the cop module

Unchanged. See [03-plan-r2.md §E1](03-plan-r2.md#e1--delete-the-cop-module-unchanged).

### E2 — Strip cop wiring from src/mcp/builtins.ts

Unchanged. See [03-plan-r2.md §E2](03-plan-r2.md#e2--strip-cop-wiring-from-srcmcpbuiltinsts-unchanged).

### E3 — Strip cop wiring from src/server/bootstrap.ts

Unchanged. See [03-plan-r2.md §E3](03-plan-r2.md#e3--strip-cop-wiring-from-srcserverbootstrapts-unchanged).

This edit removes the `createPromptInjectionCop` import at
[src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts#L13),
the `securityModel:` line at L133, and trims the
`registerBuiltinServices(...)` call at L145-L151. The L13 deletion is
the site flagged by [04-review-r2.md](04-review-r2.md) as missing from
the round 2 `PromptInjection` row. The deletion was already in the
edit set; round 3 only corrects the inventory commentary in
[01-analysis-r3.md §3](01-analysis-r3.md#3-residue-inventory--promptinjection-row-correction).

### E4 — Drop the `security` config block and make the schema strict

Unchanged. See
[03-plan-r2.md §E4](03-plan-r2.md#e4--drop-the-security-config-block-and-make-the-schema-strict-extended).

Explicit note for round 3: this edit does **not** export
`configSchema`. The new top-level call site is
`}).strict();` at the end of the existing module-local `const`. The
regression test in §V2 below does not need access to the symbol.

### E5 — Drop the `security` branch from boot validation

Unchanged. See [03-plan-r2.md §E5](03-plan-r2.md#e5--drop-the-security-branch-from-boot-validation-unchanged).

### E6 — Drop the `security` routing role

Unchanged. See [03-plan-r2.md §E6](03-plan-r2.md#e6--drop-the-security-routing-role-unchanged).

### E7 — Rewrite src/mcp/builtins.test.ts

Unchanged. See [03-plan-r2.md §E7](03-plan-r2.md#e7--rewrite-srcmcpbuiltinstestts-carried-from-round-1).

### E8 — Rewrite src/config-validation.test.ts

Unchanged. See [03-plan-r2.md §E8](03-plan-r2.md#e8--rewrite-srcconfig-validationtestts-carried-from-round-1).

### E9 — Rewrite src/routing/resolver.test.ts

Unchanged. See [03-plan-r2.md §E9](03-plan-r2.md#e9--rewrite-srcroutingresolvertestts-carried-from-round-1).

### E10 — Strip `security` from runtime / provider test fixtures

Unchanged. See [03-plan-r2.md §E10](03-plan-r2.md#e10--strip-security-from-runtime--provider-test-fixtures-new-in-round-2).

### E11 — Add no-cop invariant test

Unchanged. See [03-plan-r2.md §E11](03-plan-r2.md#e11--add-no-cop-invariant-test-new-in-round-2).

The `FORBIDDEN` list and the `src` / `web/src` / `docs` walk both
remain. The walker naturally catches the bootstrap `PromptInjection`
residue if E3 is incomplete; no test code changes for round 3.

### E12 — Docs cleanup

Unchanged. See [03-plan-r2.md §E12](03-plan-r2.md#e12--docs-cleanup-extended-in-round-2).

### E13 — Operator runbook note

Unchanged. See [03-plan-r2.md §E13](03-plan-r2.md#e13--operator-runbook-note-unchanged).

## Validation

V1. `npm run typecheck` (root) passes. Same coverage rationale as
    [03-plan-r2.md §V1](03-plan-r2.md#validation).

V2. `npm test` (root) passes. Three new tests:

    - E11 ("returns external content verbatim with no cop on the data
      path") in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).
    - **(Replaces round 2 §V2 unit-against-schema test.)** A new test
      in [src/config.test.ts](../../../../src/config.test.ts) inside
      the existing `describe("loadConfig", …)` block at
      [L29-L88](../../../../src/config.test.ts#L29-L88), placed after
      the "parses provider accounts and default account routing config"
      test at L68-L87:

      ```ts
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
        const unrecognized = issues.find(
          (issue) => issue.code === "unrecognized_keys",
        );
        expect(unrecognized).toBeDefined();
        expect((unrecognized as { keys?: string[] }).keys ?? []).toContain(
          "security",
        );
      });
      ```

      Required imports added at the top of the file:
      `import { ZodError } from "zod";`. The existing
      `beforeEach` / `afterEach` at
      [L9-L17](../../../../src/config.test.ts#L9-L17) already
      provisions and cleans `projectRoot`; the existing imports at
      [L1-L5](../../../../src/config.test.ts#L1-L5) already supply
      `mkdirSync`, `writeFileSync`, `join`. No new test plumbing.

    - E11 ("no live file references the cop or any of its
      hangers-on") in [src/security/no-cop.test.ts](../../../../src/security/no-cop.test.ts).

V3. `npm run docs:build` succeeds. Same content / grep check as
    [03-plan-r2.md §V3](03-plan-r2.md#validation).

V4. Manual repo-wide grep. Same one-liner as
    [03-plan-r2.md §V4](03-plan-r2.md#validation); expected empty.

V5. Live boot test. Same procedure against `saivage-v3` v2-harness at
    10.0.3.112 as [03-plan-r2.md §V5](03-plan-r2.md#validation).
    The boot-error path is now also covered by the unit test in V2 via
    the public `loadConfig` entry point, so V5 mostly confirms that
    operator-facing behaviour matches the unit-test path end-to-end.

## Rollback

Same as [03-plan-r2.md → Rollback](03-plan-r2.md#rollback): single
commit; revert it. No data migration.
