# G12b — Analysis (Round 2)

**Status:** Round 2 of G12b. Round 1 ([01-analysis-r1.md](01-analysis-r1.md),
[02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md)) was
returned with CHANGES_REQUESTED in [04-review-r1.md](04-review-r1.md).
The architectural direction (delete the prompt-injection cop, the
`security` config block, and the `security` routing role) is unchanged.
Round 2 widens the surface inventory, fixes the docs validation
command, expands the no-cop invariant, and flips the stale-config
policy from "silent drop" to "Zod rejects" to honour the
architecture-first / no-backward-compatibility rule.

**Companion docs:** [02-design-r2.md](02-design-r2.md),
[03-plan-r2.md](03-plan-r2.md).

## 1. Round 1 review concerns

Each blocker from [04-review-r1.md](04-review-r1.md) is mapped to its
resolution here and threaded through design and plan.

| Round 1 blocker | Resolution in round 2 |
| --- | --- |
| Misses stale `security` fixtures in runtime / provider tests | §2.2 extends the live-code inventory; design §2.6 lists each fixture; plan §E7, §E8, §E9, §E10 give the exact edits. |
| Misses doc surfaces beyond `docs/internals/security.md` and the architecture row | §2.3 inventories every live doc reference; design §2.8 specifies the edits; plan §E12 lists them; validation in plan §V replaces `docs:api` with `docs:build`. |
| Incomplete no-cop invariant | §2.4 enumerates the full residue vocabulary; design §3 lists every needle; plan §E13 inlines that list and walks `docs/` too. |
| Silently accepting stale `security` config violates the no-back-compat rule | §2.5 commits to making the top-level config schema `.strict()`; design §2.2 specifies the Zod change; plan §E4 spells out the edit and §V adds a regression test. |

## 2. Live code and doc surface to remove

Inventory verified 2026-05-26 against the working tree
([/home/salva/g/ml/saivage](../../../../)).

### 2.1 The cop itself (unchanged from round 1)

- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts) — whole module.
- [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) — whole test.

### 2.2 Test fixtures — new in round 2

The round 1 plan missed three live test fixtures that still build a
`security` block onto a `SaivageConfig` literal. After the schema
change they would fail to typecheck.

- [src/runtime/runtime.test.ts L312-L344](../../../../src/runtime/runtime.test.ts#L312-L344) — `makeSupervisorConfig` returns a `SaivageConfig` with a populated `security: { injectionScanner, injectionModel, maxScanLengthBytes }` block.
- [src/providers/router.test.ts L6-L29](../../../../src/providers/router.test.ts#L6-L29) — `makeConfig` returns a `SaivageConfig`-shaped literal that includes `security: { injectionScanner: true, maxScanLengthBytes: 100000 }`.
- [src/providers/model-capabilities.test.ts L14-L37](../../../../src/providers/model-capabilities.test.ts#L14-L37) — second `makeConfig` with the same `security` literal.
- [src/config-validation.test.ts L23, L39, L52, L62, L78, L112, L126](../../../../src/config-validation.test.ts#L23) — six `security: { ...makeConfig().security, … } as SaivageConfig["security"]` casts plus the base `makeConfig` literal. Already named by round 1 plan §E8 but listed here for completeness.
- [src/mcp/builtins.test.ts L10, L220-L261](../../../../src/mcp/builtins.test.ts#L10) — already named in round 1 plan §E7.
- [src/routing/resolver.test.ts L102-L120](../../../../src/routing/resolver.test.ts#L102-L120) — already named in round 1 plan §E9.

### 2.3 Docs — extended in round 2

Round 1 plan §E11 already names
[docs/internals/security.md](../../../../docs/internals/security.md),
the architecture row in
[docs/internals/architecture.md L99](../../../../docs/internals/architecture.md#L99),
and the VitePress sidebar entry. Round 2 adds:

- [docs/guide/config-runtime.md L184-L194](../../../../docs/guide/config-runtime.md#L184-L194) — `### security` section with a sample JSON block and a link to `Prompt-Injection Cop` plus an F04 cross-reference. Delete the heading, the JSON sample, and the paragraph.
- [docs/internals/testing.md L35](../../../../docs/internals/testing.md#L35) — table row `| src/security/*.test.ts | Prompt-injection cop. |`. Delete the row.
- [docs/internals/source-tree.md L24](../../../../docs/internals/source-tree.md#L24) — tree comment `│   ├── security/               # prompt-injection cop`. Rewrite to `│   ├── security/               # secret env scrubbing` (the surviving `secrets.ts` file).
- [docs/.vitepress/config.ts L144](../../../../docs/.vitepress/config.ts#L144) — sidebar item `{ text: "Security: Prompt-Injection Cop", link: "/internals/security" }`. Delete the line.
- [docs/api/**](../../../../docs/api/) — typedoc-generated. Verified 2026-05-26 via repo grep: `docs/api/config/functions/loadConfig.md`, `docs/api/mcp/runtime/classes/McpRuntime.md`, `docs/api/providers/router/classes/ModelRouter.md`, `docs/api/runtime/supervisor/classes/RuntimeSupervisor.md`, `docs/api/routing/resolver/interfaces/RuntimeRoutingConfigLike.md`, and `docs/api/server/bootstrap/interfaces/SaivageRuntime.md` all reference the dropped shape. These regenerate from typedoc, so the plan triggers `npm run docs:api` (the actual script per [package.json L21](../../../../package.json#L21)) instead of `pnpm docs:api`.

### 2.4 Full residue vocabulary

The no-cop invariant test must reject every live or never-landed name
in this table when scanning `src/**` and `web/src/**`. The list also
covers the documents under `docs/**` (the test walks `docs/` too).

| Residue | Where it appears today |
| --- | --- |
| `PromptInjection` | [src/security/prompt-injection-cop.ts L10, L17, L26, L30, L34](../../../../src/security/prompt-injection-cop.ts), [src/mcp/builtins.ts L32-L33, L121, L125, L150, L154, L170](../../../../src/mcp/builtins.ts), [src/mcp/builtins.test.ts L10, L221, L241](../../../../src/mcp/builtins.test.ts). |
| `promptInjectionCop` | [src/mcp/builtins.ts L125, L170, L215, L734, L771, L803, L836, L866, L1076, L1109](../../../../src/mcp/builtins.ts), [src/server/bootstrap.ts L146](../../../../src/server/bootstrap.ts), [src/mcp/builtins.test.ts L232, L252](../../../../src/mcp/builtins.test.ts). |
| `prompt-injection-cop` | [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts), [src/mcp/builtins.ts L32-L33](../../../../src/mcp/builtins.ts), [src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts), [src/security/prompt-injection-cop.test.ts L2](../../../../src/security/prompt-injection-cop.test.ts). |
| `scanUntrustedText` | [src/mcp/builtins.ts L149, L214, L770, L802](../../../../src/mcp/builtins.ts). |
| `prompt_injection_scan` | [src/mcp/builtins.ts L121, L235, L787, L819](../../../../src/mcp/builtins.ts). |
| `injectionScanner` | [src/config.ts L113](../../../../src/config.ts#L113), [src/config-validation.ts L61](../../../../src/config-validation.ts#L61), [src/security/prompt-injection-cop.ts L36](../../../../src/security/prompt-injection-cop.ts#L36), test fixtures in §2.2, docs in §2.3. |
| `injectionModel` | [src/config.ts L114](../../../../src/config.ts#L114), [src/server/bootstrap.ts L133](../../../../src/server/bootstrap.ts#L133), test fixtures in §2.2, docs in §2.3. |
| `maxScanLengthBytes` | [src/config.ts L115](../../../../src/config.ts#L115), [src/security/prompt-injection-cop.ts L40](../../../../src/security/prompt-injection-cop.ts#L40), test fixtures in §2.2, docs in §2.3. |
| `securityModel` | [src/routing/resolver.ts L63, L249](../../../../src/routing/resolver.ts#L63), [src/server/bootstrap.ts L133](../../../../src/server/bootstrap.ts#L133), [src/config-validation.test.ts L44](../../../../src/config-validation.test.ts#L44), [src/routing/resolver.test.ts L107](../../../../src/routing/resolver.test.ts#L107). |
| `security: "security"` | [src/routing/resolver.ts L9](../../../../src/routing/resolver.ts#L9). |
| `SecurityStatusRing` / `securityStatusRing` / `/api/debug/security` | Never landed in the working tree (confirmed by reviewer in [04-review-r1.md](04-review-r1.md)). Kept on the residue list so future merges can not silently resurrect the dropped G12 R4 plan. |

### 2.5 Stale-config policy — Zod must reject, not strip

The round 1 design said the top-level Zod schema would stay non-strict
and would "silently drop" any `security` key in a stale
`.saivage/saivage.json`. That contradicts the project rule
([WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md) →
architecture-first, no backward compatibility). Round 2 commits to:

1. Adding `.strict()` to the top-level `configSchema` in
   [src/config.ts L62](../../../../src/config.ts#L62). Any unrecognised
   top-level key — including the dropped `security` key — produces a
   `ZodError` with the `unrecognized_keys` issue code at boot.
2. Adding a regression test that feeds the schema a config object
   containing `security: { injectionScanner: true }` and asserts the
   parse throws with that key cited in the error path. See plan §V2.
3. Operationally this is the same as every other dropped top-level
   key: operators must edit `.saivage/saivage.json` before the
   daemon will boot again. No migration shim, no deprecation warning,
   no compatibility flag.

There is one consequence to flag: making the schema strict at the top
level also rejects any other unrecognised top-level key, not just
`security`. That is consistent with the project rule but slightly
widens the change. There is no known caller relying on extra top-level
keys (verified by inspecting all `.saivage/saivage.json` shapes in
[deploy/](../../../../deploy/) and the test fixtures listed in §2.2).
If a future deployment carries another stale key, the same boot error
will surface — which is the intended behaviour.

## 3. Surviving structural protections (unchanged from round 1)

The data tools keep their non-heuristic boundary protections:

- URL scheme allow-list at [src/mcp/builtins.ts L73-L79](../../../../src/mcp/builtins.ts#L73-L79).
- `MAX_FETCH_CHARS` truncation at [src/mcp/builtins.ts L43](../../../../src/mcp/builtins.ts#L43).
- `max_bytes` / 2 GiB ceiling at [src/mcp/builtins.ts L827, L850](../../../../src/mcp/builtins.ts#L827).
- `assertInside` containment at [src/mcp/builtins.ts L50-L58](../../../../src/mcp/builtins.ts#L50-L58).
- Shell env secret scrubbing at [src/mcp/builtins.ts L370-L388](../../../../src/mcp/builtins.ts#L370-L388).

Nothing here changes in round 2.

## 4. Risks

- **R1 — `.strict()` at the top-level config is broader than the cop
  deletion.** Mitigation: documented above; matches the project rule;
  no known caller breaks. Validation step §V2 in the plan asserts it.
- **R2 — Typedoc regeneration changes a large surface in `docs/api/**`.**
  Mitigation: plan §V3 runs `npm run docs:build` (the script that
  drives both typedoc and VitePress per [package.json L23](../../../../package.json#L23))
  and confirms the resulting tree contains no banned residue.
- **R3 — The no-cop invariant test could become flaky if the residue
  list contains substrings that legitimately appear elsewhere.**
  Mitigation: every residue in §2.4 is a fully-qualified identifier
  (`PromptInjection`, `prompt_injection_scan`, etc.) or a near-unique
  path token (`prompt-injection-cop`). The substring `security:
  "security"` is the routing-table cell only; nothing else in the tree
  ever wrote that pair. The test self-excludes (`no-cop.test.ts`).
- **R4 — Operator-edited `.saivage/saivage.json` files on long-running
  v2 deployments now fail to boot until the `security` block is
  removed.** Mitigation: documented as the intended consequence; the
  three live deployments (`saivage` 10.0.3.111, `saivage-v3` v2-harness
  10.0.3.112, `diedrico` 10.0.3.113 per workspace handoff) restart
  cleanly once the operator strips the block. No automated migration.

## 5. Pin points (carried into design and plan)

1. The `security` config key, the `security` routing role, the cop
   module, the cop's MCP wiring, the cop's downstream test fixtures,
   and every doc that mentions the cop go away in a single change.
2. Top-level Zod schema becomes strict. Stale `security` blocks
   produce a boot error, not a silent strip.
3. The no-cop invariant test scans `src/**`, `web/src/**`, **and**
   `docs/**`, exercising the full residue vocabulary from §2.4.
4. The post-edit docs build command is `npm run docs:build`
   ([package.json L23](../../../../package.json#L23)), not
   `pnpm docs:api`.
