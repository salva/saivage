# F04 — Design (r3)

## Changes from r2

- **`AgentContext.modelSpec` JSDoc example rewritten.** Proposal A now adds a one-line edit to [src/agents/types.ts](src/agents/types.ts#L49) so the existing JSDoc reads `(e.g. "provider/model")` instead of `(e.g. "openai-codex/gpt-5.3-codex")`. Reviewer flagged the original example as a false-positive site for r2's production-source sweep (constraint #12) — the sweep would fail on the current tree because the literal lives in production source even though it is not a runtime default. Fixing the example is one line and keeps the sweep contract strict ("zero model identifiers in `src/**/*.ts` outside test files"), which is much smaller than building a JSDoc-aware exception into the sweep.
- **`resolveSource` preserves `allowed_models`-only routing.** Proposal A now edits [src/routing/resolver.ts](src/routing/resolver.ts#L289) so the first branch reads `if (rule.model || rule.preferredModels.length || rule.allowedModels?.length || rule.profile) return "routing";`. Reviewer correctly observed that `resolvePreferredModels` ([src/routing/resolver.ts](src/routing/resolver.ts#L241)) returns `[...allowed]` for a rule that sets only `allowed_models`; without classifying that case as `"routing"`, removing the `"hardcoded-default"` terminal branch turns a valid operator rule into a thrown error. The classification edit lands in the same step as the terminal-branch removal; both go together.
- **New focused resolver test** in Proposal A's test plan: a `routing.roles.<role>` rule with only `allowed_models: ["provider/model"]` resolves with `source: "routing"` and `modelSpec: "provider/model"`. This proves the classification fix and prevents regression.
- Proposal B inherits the same two fixes (JSDoc rewrite, `allowed_models` classification) for completeness but is unchanged otherwise. Proposal B remains **not recommended** for the same reason as r1/r2: it conflates "remove hardcoded defaults" (the F04 directive) with "redesign the `models` block taxonomy" (a separate concern).
- Proposal Z (centralise into `src/defaults.ts`) remains rejected for the same reason as r1/r2.

All other Proposal A scope from r2 is unchanged.

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
  - [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L51-L62) — `createPromptInjectionCop` keeps `modelSpecOverride?: string` *optional* but reorganizes: if `!security.injectionScanner` return `disabledCop()` (no resolution); otherwise require `modelSpecOverride` and use it directly (no `?? security.injectionModel ?? DEFAULT_SCAN_MODEL` chain). If the scanner is enabled but no override was passed, throw a clear `MissingModelForRoleError(["security"], configPath())` — this is a defense-in-depth safety net for the case where bootstrap is wired wrong; under correct bootstrap and boot validation, this branch is unreachable.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L8) — delete `const DEFAULT_MODEL = "github-copilot/gpt-5.4";`.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L45-L55) — constructor's `modelSpecOverride?: string` stays optional. Body: assign `this.modelSpec = modelSpecOverride ?? "";`. `start()` checks `if (!this.enabled || this.timer) return;` then `if (!this.modelSpec) throw new MissingModelForRoleError(["supervisor"], configPath());` — when supervisor is disabled, `start()` no-ops as today; when enabled, `start()` requires `modelSpec` (guaranteed by boot validation + the conditional bootstrap construction).
  - [src/providers/router.ts](src/providers/router.ts#L203-L205) — `resolveModelForRole` last branch throws `MissingModelForRoleError([role], configPath())` instead of returning `"anthropic/claude-sonnet-4-20250514"`.
  - [src/routing/resolver.ts](src/routing/resolver.ts#L135) — `resolve()`'s `modelSpec` line drops the inline `?? "openai-codex/gpt-5.3-codex"`. New shape:
    ```ts
    const candidate = preferredModels[0] ?? this.resolveLegacyModels(role)[0];
    if (!candidate) throw new MissingModelForRoleError([role], configPath());
    const modelSpec = candidate;
    ```
    The explicit check keeps TS happy; in practice `resolveLegacyModels` throws when no model is configured, so the `if` body is unreachable but required for type narrowing.
  - [src/routing/resolver.ts](src/routing/resolver.ts#L279-L286) `resolveLegacyModels` — change the final `return ["openai-codex/gpt-5.3-codex"];` to `throw new MissingModelForRoleError([role], configPath());`.
  - [src/routing/resolver.ts](src/routing/resolver.ts#L100) — change the `source` union to `"routing" | "legacy" | "runtime-default" | "project-default"` (drop `"hardcoded-default"`).
  - [src/routing/resolver.ts](src/routing/resolver.ts#L289-L294) `resolveSource` — two edits, applied together:
    1. Change the first branch from
       ```ts
       if (rule.model || rule.preferredModels.length || rule.profile) return "routing";
       ```
       to
       ```ts
       if (rule.model || rule.preferredModels.length || rule.allowedModels?.length || rule.profile) return "routing";
       ```
       This classifies `allowed_models`-only rules as routing-derived, matching the resolution path in `resolvePreferredModels` ([src/routing/resolver.ts](src/routing/resolver.ts#L241)).
    2. Remove the final `return "hardcoded-default";` branch. After step 1, every successful resolution path is covered by one of `"routing" | "legacy" | "runtime-default" | "project-default"`; the only remaining "no source matched" path is when `resolveLegacyModels` would have been called and would have thrown. To satisfy TS that `resolveSource` returns on every path, terminate with `throw new Error("unreachable: resolveLegacyModels would have thrown first");` — an internal invariant marker, not a defensive fallback (no model identifier; no operator-facing UX).
  - [src/server/bootstrap.ts](src/server/bootstrap.ts#L125-L260) — three edits:
    1. After `routing` is built (currently line 130–131), insert `validateModelCoverage(config, routing, configPath(project.projectRoot));`.
    2. Line 142: change `createPromptInjectionCop(config, router, routing.resolve("security").modelSpec)` to `createPromptInjectionCop(config, router, config.security.injectionScanner ? routing.resolve("security").modelSpec : undefined)`.
    3. Line 251: change `new RuntimeSupervisor(config, { router, agentRegistry }, routing.resolve("supervisor").modelSpec)` to `new RuntimeSupervisor(config, { router, agentRegistry }, config.supervisor.enabled ? routing.resolve("supervisor").modelSpec : undefined)`.
  - [src/server/cli.ts](src/server/cli.ts#L42-L66) — delete line 45 (`provider: "openai-codex/gpt-5.3-codex",`). The freshly initialized `.saivage/config.json` no longer carries a `provider` field. The `provider` field remains in `ProjectConfigSchema` as `z.string().optional()` ([src/types.ts](src/types.ts#L14)); operators who deliberately set it in their hand-written or migrated config continue to be honored by the resolver's `project.provider` branch.
  - [src/server/cli.ts](src/server/cli.ts#L80-L120) — wrap `bootstrap()` in `try { ... } catch (err) { if (err instanceof MissingModelForRoleError) { console.error(err.message); process.exit(1); } throw err; }`. This is the *only* place that catches `MissingModelForRoleError`; internal callers propagate.
  - [src/agents/types.ts](src/agents/types.ts#L49) — rewrite the JSDoc example from `/** Model spec to use (e.g. "openai-codex/gpt-5.3-codex"). */` to `/** Model spec to use (e.g. "provider/model"). */`. One line. Removes the last model-identifier literal from production source so the sweep contract is strict and executable.
  - [src/config.test.ts](src/config.test.ts#L33) — assertion updated: `expect(config.models.orchestrator).toBeUndefined()`.
  - [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L264-L290) (fixture `makeSupervisorConfig`) — five `new RuntimeSupervisor(...)` constructor calls need an explicit third arg of `"github-copilot/gpt-5.4"` (matching the fixture's `supervisor.model`).
  - [src/routing/resolver.test.ts](src/routing/resolver.test.ts) — add a focused test for `allowed_models`-only routing rules; update or remove any tests that asserted `source: "hardcoded-default"` (see Plan step 9 for the audit).
  - New: `src/config-validation.test.ts` covering placeholder-free happy/sad paths, disabled-subsystem paths, fresh-init failure, and the production-source sweep (see Plan).

**What gets added:**

- A `validateModelCoverage(config: SaivageConfig, routing: ModelRoutingResolver, configPathStr: string): void` function that:
  - For each role the runtime will actually construct (derived from the agent roster — F02 — or, if F02 has not landed, a local `REQUIRED_MODEL_ROLES` array containing `["planner", "manager", "coder", "researcher", "data_agent", "reviewer", "inspector", "chat"]`), calls `routing.resolve(role)` inside a try/catch. If any throws `MissingModelForRoleError`, accumulates the role into a list.
  - If `config.supervisor.enabled`, additionally checks `routing.resolve("supervisor")`.
  - If `config.security.injectionScanner`, additionally checks `routing.resolve("security")`.
  - If the accumulator is non-empty, throws a single `MissingModelForRoleError` listing all missing roles + the path of `saivage.json`.
- A `MissingModelForRoleError extends Error` carrying `roles: string[]` and `configPath: string`, exported from `src/config-validation.ts`. Resolver and router import this class from `config-validation.ts` (avoiding the would-be circular import between resolver and `config.ts`).
- A focused resolver test for `allowed_models`-only routing rules.

**What gets removed:**

- Nine runtime hardcoded model identifiers (sites 1–9 enumerated in `01-analysis-r3.md`).
- One JSDoc model-identifier example (site 10) — replaced by a non-model placeholder.
- The `DEFAULT_SCAN_MODEL` and `DEFAULT_MODEL` module-local constants.
- The `"hardcoded-default"` member of the `ResolvedModelRoute["source"]` discriminated union.
- The `?? <literal>` resolution patterns in `resolveModelForRole` and `resolveLegacyModels` and the inline `??` in `resolve()`.
- The CLI seed of `project.provider` (the field itself stays; only the source-code initial value is removed).

**Risk:**

- **Operator-facing breakage.** A project running on a `saivage.json` that omits `supervisor.model` while leaving `supervisor.enabled = true` (today's default) will stop booting. This is *intended* per the operator directive. Mitigation: the `MissingModelForRoleError` text is the single piece of UX that has to land right; the validator emits all missing roles in one error so the operator fixes them in one edit pass.
- **Fresh init UX.** After this change, `saivage init <path>` followed by `saivage start <path>` will fail with `MissingModelForRoleError` listing 8 worker roles + `supervisor` + `security`. This is intentional — the operator directive is "fail loudly if nothing is configured" — but the error must point at exactly the file to edit (`./.saivage/saivage.json`) and the keys to set (`models.default` covers all 8 worker roles in one line). Plan covers the error wording.
- **`allowed_models`-only classification subtlety.** Operators who use the `routing.roles.X.allowed_models` pattern as a whitelist (no explicit `model` / `preferred_models`) currently see `source: "hardcoded-default"` on those resolutions — which is also a bug today, just a silent one. After F04 they see `source: "routing"`. This is a corrected classification, not a behaviour change; the `modelSpec` returned by `resolvePreferredModels` is identical. Any tooling that gated on `source === "hardcoded-default"` would now see a different value, but the only consumer of `source` is observability/logging.
- **Bootstrap conditional logic.** The `config.security.injectionScanner ? ... : undefined` and `config.supervisor.enabled ? ... : undefined` ternaries are minimal additions; they do not introduce a new branching layer. The new test for "disabled supervisor + missing supervisor model boots cleanly" defends against regression.
- **`resolve()` inline guard.** The TS-narrowing branch `if (!candidate) throw ...` in `resolve()` is technically unreachable after `resolveLegacyModels` throws, but it is required for TypeScript to accept the assignment. It is not a "default" — it carries no model identifier — but it is a small piece of defensive code at an internal boundary. Justification: the resolver is the single source of truth for "what model"; the `if` guard makes the contract explicit and survives any future refactor that loosens `resolveLegacyModels` to return `string[] | []`.
- **`resolveSource` unreachable terminator.** Same shape as the `resolve()` guard: an internal-invariant throw, no model identifier, required only for TS exhaustiveness.
- **Test parallelism.** All v2 tests that construct a `SaivageConfig` via `loadConfig` from an empty file used to rely on the orchestrator default being injected. The Plan enumerates them; only `src/config.test.ts` needs an actual assertion change.

**What it enables:**

- **F02 (roster):** F02 derives the model-key list from the roster; F04's validator becomes a one-line `for (const r of WORKER_OR_PLANNER_ROLES) routing.resolve(r)`. F02 + F04 compose cleanly with F02 landing first.
- **F20 (`maxContextTokens`):** F20 will need to interrogate the model spec to pick a context window. Once F04 guarantees a real model spec is in hand at every call site (no synthetic defaults), F20's per-spec lookup table has no "what context window applies to a string I made up?" edge case.
- **F32 (undocumented config blocks):** F32 documents `security` and `supervisor`. Post-F04, F32 documents that `injectionModel` and `model` are required when their respective subsystem is enabled.

**What it forbids:**

- Re-introducing any model string in source as a runtime fallback. The validator + the throwing branches in router/resolver enforce this at runtime; the new grep-based test (Plan step 11) catches static reintroduction — including in comments and JSDoc, by design.
- Silent EOL drift: when a provider retires a model, the failure mode is a routing error attributable to the operator's `saivage.json`, not a buried `DEFAULT_SCAN_MODEL`.
- Silent loss of `allowed_models`-only routing rules: the classification fix + the new focused test together prevent the regression flagged by the r2 reviewer.

**Recommendation note:** this is the proposal the operator explicitly asked for, addressing all r1 and r2 reviewer items. It is the minimum change that fully honours the directive. Recommended.

---

## Proposal B — Drop the defaults AND introduce a `model_role` indirection layer

Everything from Proposal A, plus a deeper refactor: collapse the two parallel resolution paths (`ModelRouter.resolveModelForRole` and `ModelRoutingResolver.resolve`) into the resolver-only path, and reshape `models` config from "one entry per agent role" to "one entry per `model_role` (capability tier), plus a per-agent-role assignment to a `model_role`".

(Scope, additions, removals, and risk are unchanged from r2. Proposal B also inherits the JSDoc rewrite at [src/agents/types.ts](src/agents/types.ts#L49) and the `allowed_models` classification fix at [src/routing/resolver.ts](src/routing/resolver.ts#L289) — both apply identically since Proposal B retains a routing-resolver layer.)

**Recommendation note:** structurally cleaner but the operator's stated objection in F04 is specifically about hardcoded *model identifiers*, not about the *shape* of the `models` block. **Not recommended for F04** — propose separately if the per-role-key sprawl in `models` becomes its own issue.

---

## Proposal Z (rejected) — Centralise the defaults in `src/defaults.ts`

The writer prompt suggested this. It is rejected because it directly contradicts the operator directive:

> No model should be hard-coded. If no model is set in the config, the system must just fail to work and report the issue.

Centralising the defaults *moves* the hardcoded strings but keeps them. Recording the proposal for completeness; not viable under the stated operator constraint.

---

## Recommendation

**Proposal A.** It is the minimal change that fully honours the operator directive, addresses all r1 and r2 reviewer items (including the JSDoc false-positive and the `allowed_models`-only classification), composes cleanly with F02 (roster) and F32 (config docs), and does not pre-commit to a tier taxonomy that the operator has not signed off on. Proposal B can be raised separately if the `models` block sprawl is later judged a distinct concern.
