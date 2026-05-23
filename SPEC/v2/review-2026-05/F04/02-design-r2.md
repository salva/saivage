# F04 — Design (r2)

## Changes from r1

- **Resolver inline literal removed.** Proposal A now explicitly edits [src/routing/resolver.ts](src/routing/resolver.ts#L135) to drop the inline `?? "openai-codex/gpt-5.3-codex"` in `resolve()`, in addition to the previously listed `resolveLegacyModels` literal. The two literals are co-located and removed together so no model identifier survives in the resolver after the edit.
- **Bootstrap conditional resolution.** Proposal A now reshapes the bootstrap construction of the security cop and the supervisor so `routing.resolve("security")` / `routing.resolve("supervisor")` are only evaluated when the corresponding subsystem is enabled. r1 left those calls unconditional; combined with the resolver's new throwing behavior, that would have made disabled subsystems unbootable.
- **Placeholder strategy dropped.** Proposal A no longer writes a `"REPLACE-WITH-PROVIDER/MODEL"` placeholder into `writeDefaultConfig`. Reviewer correctly noted the placeholder is syntactically valid under the resolver's slash-parser and that detecting it would require a separate rule. The cleaner answer under the operator directive is to seed nothing: `writeDefaultConfig` keeps its existing `models: {}` seed, the validator emits a single error pointing the operator at the file to edit, and there is no string in source that masquerades as a model.
- **CLI init seed deleted.** Proposal A now removes `provider: "openai-codex/gpt-5.3-codex"` from [src/server/cli.ts](src/server/cli.ts#L45). r1 missed this site; reviewer flagged it as a source-level default that would survive even after sites 1–8 were removed. The `ProjectConfig.provider` field remains in `ProjectConfigSchema` as an operator-settable optional field; the source-level *seed* is what gets deleted.
- **New production-source sweep step.** Proposal A's validation now includes a `grep` across `src/**/*.ts` (excluding `*.test.ts`) for the three vendor strings; the check must return zero matches after the edit and is added to the test plan so a future PR adding a new literal would surface in CI/local validation.
- Proposal B's scope is unchanged from r1 except for inheriting the same fixes (resolver inline literal, conditional bootstrap, CLI seed). Proposal B remains **not recommended** for the same reason as r1: it conflates "remove hardcoded defaults" (the F04 directive) with "redesign the `models` block taxonomy" (a separate concern).
- Proposal Z (centralise into `src/defaults.ts`) remains rejected for the same reason as r1.

Both Proposal A and Proposal B honour the operator directive — "no model should be hardcoded; fail if config doesn't specify one." They differ in how deeply they reshape the resolution layer.

---

## Proposal A — Drop the defaults, add a single boot-time validator (RECOMMENDED)

**Scope (files touched):**

- New: `src/config-validation.ts` (~70 lines) exposing `validateModelCoverage(config, routing, configPath): void` and a `MissingModelForRoleError` class.
- Edited:
  - [src/config.ts](src/config.ts#L36-L50) — `models` block: drop the `.default({ orchestrator: "anthropic/..." })` argument; the block-level `.default({})` stays (empty object). `orchestrator`, `planner`, ... all stay `modelAssignmentSchema.optional()` (already are).
  - [src/config.ts](src/config.ts#L78-L82) — `security.injectionModel`: change `z.string().default("github-copilot/gpt-5.4")` → `z.string().optional()`.
  - [src/config.ts](src/config.ts#L84-L92) — `supervisor.model`: change `z.string().default("github-copilot/gpt-5.4")` → `z.string().optional()`.
  - [src/config.ts](src/config.ts#L204-L237) `writeDefaultConfig` — no change. The existing `models: {}` seed is already correct under the F04 directive. No placeholder is added.
  - [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L26) — delete `const DEFAULT_SCAN_MODEL = "github-copilot/gpt-5.4";`.
  - [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L51-L62) — `createPromptInjectionCop` keeps `modelSpecOverride?: string` *optional* but reorganizes: if `!security.injectionScanner` return `disabledCop()` (no resolution); otherwise require `modelSpecOverride` and use it directly (no `?? security.injectionModel ?? DEFAULT_SCAN_MODEL` chain). If the scanner is enabled but no override was passed, throw a clear `MissingModelForRoleError(["security"], configPath)` — this is a defense-in-depth safety net for the case where bootstrap is wired wrong; under correct bootstrap and boot validation, this branch is unreachable.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L8) — delete `const DEFAULT_MODEL = "github-copilot/gpt-5.4";`.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L45-L55) — constructor's `modelSpecOverride?: string` stays optional. Body: assign `this.modelSpec = modelSpecOverride ?? "";`. `start()` checks `if (!this.enabled || !this.modelSpec) { if (this.enabled) throw new MissingModelForRoleError(["supervisor"], configPath); return; }` — when supervisor is disabled, start() no-ops as today; when enabled, start() requires modelSpec (guaranteed by boot validation + the conditional bootstrap construction).
  - [src/providers/router.ts](src/providers/router.ts#L203-L205) — `resolveModelForRole` last branch throws `MissingModelForRoleError([role], configPath())` instead of returning `"anthropic/claude-sonnet-4-20250514"`.
  - [src/routing/resolver.ts](src/routing/resolver.ts#L135) — `resolve()`'s `modelSpec` line drops the inline `?? "openai-codex/gpt-5.3-codex"`. New shape:
    ```ts
    const candidate = preferredModels[0] ?? this.resolveLegacyModels(role)[0];
    if (!candidate) throw new MissingModelForRoleError([role], configPath());
    const modelSpec = candidate;
    ```
    The explicit check keeps TS happy; in practice `resolveLegacyModels` throws when no model is configured, so the `if` body is unreachable but required for type narrowing.
  - [src/routing/resolver.ts](src/routing/resolver.ts#L279-L286) `resolveLegacyModels` — change the final `return ["openai-codex/gpt-5.3-codex"];` to `throw new MissingModelForRoleError([role], configPath());`.
  - [src/routing/resolver.ts](src/routing/resolver.ts#L100) and [src/routing/resolver.ts](src/routing/resolver.ts#L289-L294) — remove the `"hardcoded-default"` source discriminant from `ResolvedModelRoute["source"]` and from `resolveSource`. The `resolveSource` `return "hardcoded-default"` branch becomes unreachable; per architecture-first guideline it is removed, not commented out. (`source` becomes `"routing" | "legacy" | "runtime-default" | "project-default"`.)
  - [src/server/bootstrap.ts](src/server/bootstrap.ts#L125-L260) — three edits:
    1. After `routing` is built (currently line 130–131), insert `validateModelCoverage(config, routing, configPath(project.projectRoot));`.
    2. Line 142: change `createPromptInjectionCop(config, router, routing.resolve("security").modelSpec)` to `createPromptInjectionCop(config, router, config.security.injectionScanner ? routing.resolve("security").modelSpec : undefined)`.
    3. Line 251: change `new RuntimeSupervisor(config, { router, agentRegistry }, routing.resolve("supervisor").modelSpec)` to `new RuntimeSupervisor(config, { router, agentRegistry }, config.supervisor.enabled ? routing.resolve("supervisor").modelSpec : undefined)`.
  - [src/server/cli.ts](src/server/cli.ts#L42-L66) — delete line 45 (`provider: "openai-codex/gpt-5.3-codex",`). The freshly initialized `.saivage/config.json` no longer carries a `provider` field. The `provider` field remains in `ProjectConfigSchema` as `z.string().optional()` ([src/types.ts](src/types.ts#L14)); operators who deliberately set it in their hand-written or migrated config continue to be honored by the resolver's `project.provider` branch.
  - [src/server/cli.ts](src/server/cli.ts#L80-L120) — wrap `bootstrap()` in `try { ... } catch (err) { if (err instanceof MissingModelForRoleError) { console.error(err.toString()); process.exit(1); } throw err; }`. This is the *only* place that catches `MissingModelForRoleError`; internal callers propagate.
  - [src/config.test.ts](src/config.test.ts#L33) — assertion updated: `expect(config.models.orchestrator).toBeUndefined()`.
  - [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L264-L290) (fixture `makeSupervisorConfig`) — `supervisor.model: "github-copilot/gpt-5.4"` and `security.injectionModel: "github-copilot/gpt-5.4"` are already set (lines 271, 276). Tests at lines 135/164/188/217/245 construct `new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry })` and currently pass `undefined` implicitly as the third arg; they keep working unchanged because the constructor still accepts `modelSpecOverride?: string` (optional). The runtime invariant inside `start()` requires the model only when enabled; the test fixture enables the supervisor and provides the model via `config.supervisor.model`, which is read via the bootstrap-side `routing.resolve("supervisor")` path. Since these tests construct the supervisor directly (bypassing bootstrap), they need an explicit third argument set to `"github-copilot/gpt-5.4"` (the same string the fixture carries) for `start()` to work. Concrete change: add `"github-copilot/gpt-5.4"` as the third arg in each of the five test setups.
  - New: `src/config-validation.test.ts` covering placeholder-free happy/sad paths, disabled-subsystem paths, and fresh-init failure (see Plan).

**What gets added:**

- A `validateModelCoverage(config: SaivageConfig, routing: ModelRoutingResolver, configPathStr: string): void` function that:
  - For each role the runtime will actually construct (derived from the agent roster — F02 — or, if F02 has not landed, a local `REQUIRED_MODEL_ROLES` array containing `["planner", "manager", "coder", "researcher", "data_agent", "reviewer", "inspector", "chat"]`), calls `routing.resolve(role)` inside a try/catch. If any throws `MissingModelForRoleError`, accumulates the role into a list.
  - If `config.supervisor.enabled`, additionally checks `routing.resolve("supervisor")`.
  - If `config.security.injectionScanner`, additionally checks `routing.resolve("security")`.
  - If the accumulator is non-empty, throws a single `MissingModelForRoleError` listing all missing roles + the path of `saivage.json`.
- A `MissingModelForRoleError extends Error` carrying `roles: string[]` and `configPath: string`, exported from `src/config-validation.ts`. Resolver and router import this class from `config-validation.ts` (avoiding the would-be circular import between resolver and `config.ts`).

**What gets removed:**

- Nine hardcoded model identifiers (sites 1–9 enumerated in `01-analysis-r2.md`).
- The `DEFAULT_SCAN_MODEL` and `DEFAULT_MODEL` module-local constants.
- The `"hardcoded-default"` member of the `ResolvedModelRoute["source"]` discriminated union.
- The `?? <literal>` resolution patterns in `resolveModelForRole` and `resolveLegacyModels` and the inline `??` in `resolve()`.
- The CLI seed of `project.provider` (the field itself stays; only the source-code initial value is removed).

**Risk:**

- **Operator-facing breakage.** A project running on a `saivage.json` that omits `supervisor.model` while leaving `supervisor.enabled = true` (today's default) will stop booting. This is *intended* per the operator directive. Mitigation: the `MissingModelForRoleError` text is the single piece of UX that has to land right; the validator emits all missing roles in one error so the operator fixes them in one edit pass.
- **Fresh init UX.** After this change, `saivage init <path>` followed by `saivage start <path>` will fail with `MissingModelForRoleError` listing 8 worker roles + `supervisor` + `security`. This is intentional — the operator directive is "fail loudly if nothing is configured" — but the error must point at exactly the file to edit (`./.saivage/saivage.json`) and the keys to set (`models.default` covers all 8 worker roles in one line). Plan covers the error wording.
- **Bootstrap conditional logic.** The `config.security.injectionScanner ? ... : undefined` and `config.supervisor.enabled ? ... : undefined` ternaries are minimal additions; they do not introduce a new branching layer (the `enabled` flags are already authoritative inside the cop and supervisor). The only risk is a future contributor stripping the guard "for clarity" and reintroducing the unconditional resolution; the new test for "disabled supervisor + missing supervisor model boots cleanly" defends against regression.
- **`resolve()` inline guard.** The TS-narrowing branch `if (!candidate) throw ...` in `resolve()` is technically unreachable after `resolveLegacyModels` throws, but it is required for TypeScript to accept the assignment. It is not a "default" — it carries no model identifier — but it is a small piece of defensive code at an internal boundary. Justification: the resolver is the single source of truth for "what model"; the `if` guard makes the contract explicit and survives any future refactor that loosens `resolveLegacyModels` to return `string[] | []`.
- **Test parallelism.** All v2 tests that construct a `SaivageConfig` via `loadConfig` from an empty file used to rely on the orchestrator default being injected. The Plan enumerates them; only `src/config.test.ts` needs an actual assertion change.

**What it enables:**

- **F02 (roster):** F02 derives the model-key list from the roster; F04's validator becomes a one-line `for (const r of WORKER_OR_PLANNER_ROLES) routing.resolve(r)`. F02 + F04 compose cleanly with F02 landing first.
- **F20 (`maxContextTokens`):** F20 will need to interrogate the model spec to pick a context window. Once F04 guarantees a real model spec is in hand at every call site (no synthetic defaults), F20's per-spec lookup table has no "what context window applies to a string I made up?" edge case.
- **F32 (undocumented config blocks):** F32 documents `security` and `supervisor`. Post-F04, F32 documents that `injectionModel` and `model` are required when their respective subsystem is enabled.

**What it forbids:**

- Re-introducing any model string in source as a runtime fallback. The validator + the throwing branches in router/resolver enforce this at runtime; the new grep-based test (step 12 in the Plan) catches static reintroduction.
- Silent EOL drift: when a provider retires a model, the failure mode is a routing error attributable to the operator's `saivage.json`, not a buried `DEFAULT_SCAN_MODEL`.

**Recommendation note:** this is the proposal the operator explicitly asked for, addressing all four r1 reviewer items. It is the minimum change that fully honours the directive. Recommended.

---

## Proposal B — Drop the defaults AND introduce a `model_role` indirection layer

Everything from Proposal A, plus a deeper refactor: collapse the two parallel resolution paths (`ModelRouter.resolveModelForRole` and `ModelRoutingResolver.resolve`) into the resolver-only path, and reshape `models` config from "one entry per agent role" to "one entry per `model_role` (capability tier), plus a per-agent-role assignment to a `model_role`".

**Additional scope beyond A:**

- New: `src/routing/model-roles.ts` declaring a small enum of capability tiers (`"primary" | "fast" | "auditor" | "scanner"`) and a fixed agent-role → tier table.
- Edited:
  - `src/config.ts` `models` block: replaces per-agent-role keys with `z.object({ primary, fast, auditor, scanner }).partial()`. **No defaults**.
  - `src/providers/router.ts`: `resolveModelForRole(role)` is deleted; all callers route through `ModelRoutingResolver.resolve(role).modelSpec`.
  - `src/routing/resolver.ts`: resolver internally maps `role → ModelRole → models[ModelRole]`; the four-source merge collapses; `resolveLegacyModels` is deleted along with the `project.provider` / `model_overrides` legacy path (architecture-first: legacy paths removed).
  - `src/config-validation.ts`: validates `models.primary`, `models.fast`, `models.auditor`, `models.scanner` are present for whichever tiers any active agent role maps to.

**What gets added beyond A:**

- A four-element capability-tier vocabulary and a fixed agent-role → tier table.

**What gets removed beyond A:**

- The `models.orchestrator`, `models.planner`, ..., `models.executor` keys — 11 keys collapse to 4.
- `ModelRouter.resolveModelForRole` and the `modelAssignments` field on `ModelRouter`.
- `ModelRoutingResolver.resolveLegacyModels`, the `project.provider` field on `ProjectConfigSchema`, and the `project.model_overrides` field.
- `ROUTING_ROLE_TO_MODEL_KEY` at [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16).

**Risk:**

- **Existing `saivage.json` files break.** Any production `saivage.json` with `models.orchestrator` / `models.coder` / etc. stops working. Per the workspace architecture-first guideline this is allowed, but it is meaningfully larger blast radius than Proposal A. The operator's project (`/home/salva/g/ml/saivage-v3/.saivage/`) and any deployed harnesses would need their configs migrated as part of the merge.
- **Tier names are a design decision the operator hasn't weighed in on.** Choosing `"primary" | "fast" | "auditor" | "scanner"` (or any other tuple) bakes in a *taxonomy*.
- **The role → tier mapping is itself a "default" of sorts.** Per the operator directive, it is arguable whether `planner → primary` is the same kind of "default" the operator objected to.
- **Larger PR surface.** Touches every consumer of `ModelRouter.resolveModelForRole` (agent constructors). Conflicts with F02's roster-derived `defaultModelKey` mapping.

**What it enables:**

- Single resolution path simplifies routing observability.
- The `models` block becomes 4 keys instead of 11.

**What it forbids:**

- Per-agent-role models in `saivage.json` (must go through `routing.roles` override).
- The legacy routing path (`project.provider`, `model_overrides`).

**Recommendation note:** structurally cleaner but the operator's stated objection in F04 is specifically about hardcoded *model identifiers*, not about the *shape* of the `models` block. **Not recommended for F04** — propose separately if the per-role-key sprawl in `models` becomes its own issue.

---

## Proposal Z (rejected) — Centralise the defaults in `src/defaults.ts`

The writer prompt suggested this. It is rejected because it directly contradicts the operator directive:

> No model should be hard-coded. If no model is set in the config, the system must just fail to work and report the issue.

Centralising the defaults *moves* the hardcoded strings but keeps them. Recording the proposal for completeness; not viable under the stated operator constraint.

---

## Recommendation

**Proposal A.** It is the minimal change that fully honours the operator directive, addresses all four r1 reviewer items, composes cleanly with F02 (roster) and F32 (config docs), and does not pre-commit to a tier taxonomy that the operator has not signed off on. Proposal B can be raised separately if the `models` block sprawl is later judged a distinct concern.
