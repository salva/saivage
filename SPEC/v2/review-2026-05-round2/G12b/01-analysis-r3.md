# G12b — Analysis (Round 3)

**Status:** Round 3 of G12b. Round 2 ([01-analysis-r2.md](01-analysis-r2.md),
[02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md)) was
returned with CHANGES_REQUESTED in [04-review-r2.md](04-review-r2.md).
The architectural direction (delete the prompt-injection cop, the
`security` config block, the `security` routing role; make the
top-level Zod schema strict so stale `security` config fails boot) is
unchanged. Round 3 fixes exactly the two reviewer blockers from round 2:

1. The stale-`security` regression test is rewritten to exercise the
   public `loadConfig` path with a fixture file on disk, instead of
   calling an unexported `configSchema`. This better proves boot-time
   behaviour and avoids enlarging the module's export surface for
   test-only reasons.
2. The `PromptInjection` row in the residue inventory is corrected to
   include the bootstrap occurrence
   ([src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts#L13)).

**Companion docs:** [02-design-r3.md](02-design-r3.md),
[03-plan-r3.md](03-plan-r3.md).

Everything not listed in §1 or §2 below is inherited verbatim from
round 2 — including §2.1 (cop module), §2.2 (test-fixture surface),
§2.3 (doc surface), §2.5 (`.strict()` top-level schema policy),
§3 (surviving structural protections), §4 (risks), §5 (pin points).
The cross-references resolve into [01-analysis-r2.md](01-analysis-r2.md)
where the inherited content lives.

## 1. Round 2 review concerns

| Round 2 blocker | Resolution in round 3 |
| --- | --- |
| Stale-`security` regression test is specified against an unexported `configSchema`. | §2 below: switch to the public `loadConfig` path with an on-disk fixture in [src/config.test.ts](../../../../src/config.test.ts). No new export from [src/config.ts](../../../../src/config.ts). Design §2.2 and §3.2 updated; plan §V2 rewritten. |
| `PromptInjection` row of the inventory misses [src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts#L13) (`createPromptInjectionCop` import). | §3 below: re-grepped inventory adds bootstrap to the `PromptInjection` row. Design §3.3 unchanged (the residue invariant test already covers the whole `src/**` tree and would catch the live string). Plan §E3 already removes the import; no edit-set change. |

## 2. Stale-`security` regression test — switch to the public path

[src/config.ts L60-L191](../../../../src/config.ts#L60-L191) declares
`configSchema` as a module-local `const`. Round 2 §V2 wrote the
regression test against that symbol, but it is not exported and the
plan did not include an export-step. The reviewer flagged this in
[04-review-r2.md](04-review-r2.md) and pointed out that exercising the
public `loadConfig` path against an on-disk fixture better proves the
boot-time behaviour the no-back-compat rule requires.

Round 3 keeps `configSchema` unexported. The regression test instead:

1. Writes a temporary `<projectRoot>/.saivage/saivage.json` whose
   payload contains a top-level `security: { injectionScanner: true }`
   block — the exact shape an in-the-wild stale deployment carries.
2. Calls `loadConfig(true, projectRoot)` (the same entry point used by
   the daemon's bootstrap).
3. Asserts the call throws. Either:
   - a `ZodError` whose `issues` include
     `{ code: "unrecognized_keys", keys: [..., "security", ...] }`, **or**
   - an error wrapped by `loadConfig` with a message that still cites
     the offending key by name. ([loadConfig](../../../../src/config.ts#L195-L240)
     currently re-throws Zod errors unchanged from `configSchema.parse(raw)`,
     so the test asserts on the Zod payload directly via
     `(err as z.ZodError).issues` after `expect(...).toThrow()`.)

This sits naturally alongside the existing tests in
[src/config.test.ts](../../../../src/config.test.ts#L48-L67) that
already write `.saivage/saivage.json` fixtures and call `loadConfig`,
so it requires no new test plumbing.

The exported surface of `src/config.ts` does not change. That keeps
the public API minimal and matches the architecture-first rule (no
new export carved out solely to make a test reach internal state).

## 3. Residue inventory — `PromptInjection` row correction

Re-grep on 2026-05-26 from the working tree
([/home/salva/g/ml/saivage](../../../../)):

```
$ grep -rIn 'PromptInjection' src web docs
src/security/prompt-injection-cop.ts:10
src/security/prompt-injection-cop.ts:17
src/security/prompt-injection-cop.ts:26
src/security/prompt-injection-cop.ts:30
src/security/prompt-injection-cop.ts:34
src/mcp/builtins.ts:32
src/mcp/builtins.ts:33
src/mcp/builtins.ts:121
src/mcp/builtins.ts:125
src/mcp/builtins.ts:150
src/mcp/builtins.ts:154
src/mcp/builtins.ts:170
src/mcp/builtins.test.ts:10
src/mcp/builtins.test.ts:221
src/mcp/builtins.test.ts:241
src/server/bootstrap.ts:13                 <-- missing in round 2 inventory
```

The bootstrap occurrence is the `createPromptInjectionCop` import at
[src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts#L13);
the identifier contains `PromptInjection` as a substring and the
no-cop invariant test in [03-plan-r2.md §E11](03-plan-r2.md) /
[02-design-r2.md §3.3](02-design-r2.md#33-no-cop-hangers-on-anywhere-extended-in-round-2)
catches it.

Round 3 corrected `PromptInjection` row:

| Residue | Where it appears today |
| --- | --- |
| `PromptInjection` | [src/security/prompt-injection-cop.ts L10, L17, L26, L30, L34](../../../../src/security/prompt-injection-cop.ts); [src/mcp/builtins.ts L32-L33, L121, L125, L150, L154, L170](../../../../src/mcp/builtins.ts); [src/mcp/builtins.test.ts L10, L221, L241](../../../../src/mcp/builtins.test.ts); [src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts#L13) (`createPromptInjectionCop` import — substring match). |

The bootstrap file is already named in the round 2 plan §E3, which
removes the import line, so no edit-set change is required. The
inventory edit is purely a documentation-completeness fix so the grep
proof and the inventory align exactly. All other rows in
[01-analysis-r2.md §2.4](01-analysis-r2.md#24-full-residue-vocabulary)
are unchanged (re-grepped on 2026-05-26 and verified).

## 4. Carry-over from round 2 (no changes)

- §2.1 — cop module deletion surface.
- §2.2 — test-fixture surface (runtime, providers, config-validation, builtins, resolver).
- §2.3 — doc surface (guide, sidebar, testing table, source-tree comment, architecture row, internal security page, generated API docs).
- §2.4 — full residue vocabulary, **with the `PromptInjection` row corrected as in §3 above**.
- §2.5 — `.strict()` top-level schema policy; fail loud on stale `security`.
- §3 — surviving structural protections.
- §4 — risks R1–R4.
- §5 — pin points 1–4.
