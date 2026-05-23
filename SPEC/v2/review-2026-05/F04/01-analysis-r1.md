# F04 — Analysis (r1)

## Problem restated

A model identifier string is encoded directly in source code in at least seven places. Five of those are operational defaults that take effect when the project does not configure a model; the remaining two are last-ditch fallbacks deep in the routing/resolver stack. The strings are spread across three subsystems (config schema, security cop, runtime supervisor, provider router, routing resolver) and they do not even agree on which model to fall back to: the orchestrator/router fall back to `"anthropic/claude-sonnet-4-20250514"`, the supervisor/security/cop fall back to `"github-copilot/gpt-5.4"`, and the routing resolver falls back to `"openai-codex/gpt-5.3-codex"`.

The operator's explicit constraint for this issue (quoted in [F04-hardcoded-default-models.md](../F04-hardcoded-default-models.md)) is:

> No model should be hard-coded. If no model is set in the config, the system must just fail to work and report the issue.

So the bar is not "consolidate defaults into one place" — it is "remove the defaults entirely and make the bootstrap fail loudly when the config does not name a model for every role the runtime is about to use."

## Actual differences

Every site that embeds a model identifier as a runtime default or fallback:

| # | Site | String | Role/use |
|---|---|---|---|
| 1 | [src/config.ts](src/config.ts#L36-L50) | `"anthropic/claude-sonnet-4-20250514"` | Zod default for `models.orchestrator` when the `models` block is absent. |
| 2 | [src/config.ts](src/config.ts#L78-L82) | `"github-copilot/gpt-5.4"` | Zod default for `security.injectionModel`. |
| 3 | [src/config.ts](src/config.ts#L84-L92) | `"github-copilot/gpt-5.4"` | Zod default for `supervisor.model`. |
| 4 | [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L26) | `"github-copilot/gpt-5.4"` | `DEFAULT_SCAN_MODEL`, used as `?? DEFAULT_SCAN_MODEL` fallback when both the explicit `modelSpecOverride` arg and `security.injectionModel` are nullish. |
| 5 | [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L8) | `"github-copilot/gpt-5.4"` | `DEFAULT_MODEL`, used as `?? DEFAULT_MODEL` fallback when both the explicit `modelSpecOverride` and `config.supervisor.model` are nullish. |
| 6 | [src/providers/router.ts](src/providers/router.ts#L204) | `"anthropic/claude-sonnet-4-20250514"` | Last fallback in `resolveModelForRole(role)` when neither role-specific nor `default` assignment is present. |
| 7 | [src/routing/resolver.ts](src/routing/resolver.ts#L283-L286) | `"openai-codex/gpt-5.3-codex"` | Last fallback in `resolveLegacyModels(role)` when the resolver finds nothing in routing, overrides, runtime defaults, or `project.provider`. Produces `source: "hardcoded-default"` per [src/routing/resolver.ts](src/routing/resolver.ts#L100). |

Distinct behaviours that diverge today:

1. **Three different "default models" coexist in one process.** A bare `saivage.json` produces an orchestrator model of `anthropic/claude-sonnet-4-20250514` and supervisor/security models of `github-copilot/gpt-5.4`. Any worker role missing from `models` and missing from `models.default` resolves to *yet another* model (`openai-codex/gpt-5.3-codex` via the resolver's `resolveLegacyModels` fallback, or `anthropic/claude-sonnet-4-20250514` via the router's `resolveModelForRole` fallback — which one wins depends on which call site reaches the model first).
2. **Two of the constants are unreachable today but still exist.** The Zod default at [src/config.ts](src/config.ts#L84-L92) means `config.supervisor.model` is always a string, so the `?? DEFAULT_MODEL` in [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L50) never fires. Same pattern for the security cop. These dead defaults still encode `gpt-5.4` in source — operators rotating models would have to find and update them anyway to keep the codebase clean.
3. **Routing layer disagrees with router layer.** `ModelRoutingResolver` is the layered resolver (project routing → runtime default → hardcoded `openai-codex/gpt-5.3-codex`). `ModelRouter.resolveModelForRole` is a separate method on the legacy router with its own hardcoded `anthropic/claude-sonnet-4-20250514`. Two parallel resolution paths means rotating defaults requires editing both.
4. **The defaults encode vendor + product version**, not a capability tier. `gpt-5.4` is a Copilot-routed product version that will be EOL'd by GitHub Copilot independent of any Saivage decision. When that happens, the security and supervisor subsystems silently start using whatever the provider routes `gpt-5.4` to (or, if the provider drops the model, hard-fail in production with no traceability back to "this default was set in source two years ago").

## Contract

The thing that needs a contract is "what model does role X use?" — and the answer today is "whatever survives the resolution chain, with up to four distinct hardcoded fallbacks at the bottom." Under the operator directive, the contract becomes:

- **Inputs:** a `SaivageConfig` (parsed from `.saivage/saivage.json`) and a role name from the live roster (`AgentRole` ∪ `"supervisor" | "security" | "default"`).
- **Output:** a fully-qualified model spec string (`"<provider>/<model>"`).
- **Error mode:** if the config does not specify a model for the role and there is no `models.default` to inherit from, **bootstrap fails with a clear "no model configured for role X" error before any agent starts**. No silent fallback to any built-in string.
- **Lifecycle:** validation happens once at boot, after `loadConfig` returns and before any agent/supervisor/cop is constructed. Lazy/runtime resolution then either trivially succeeds (config covers the role) or — if a role is reached that boot validation didn't consider — throws a typed `MissingModelForRoleError` that the caller propagates.

Roles that must be covered by the boot check:
- **Always required:** every role from the agent roster ([src/agents/types.ts](src/agents/types.ts#L20-L28) → after F02, the unified roster) plus the two pseudo-roles `supervisor` and `security`. F02's roster supplies `defaultModelKey` per role; the boot check iterates roster entries and asks the resolver for each one without falling back to any string.
- **Conditionally required:** `supervisor` only when `config.supervisor.enabled` is `true`; `security` only when `config.security.injectionScanner` is `true`. Otherwise the subsystem is not constructed and asking for its model would falsely fail boot.
- **Always optional:** `models.default` is a convenience inherit-target only; it does not need to be set if every other key is set explicitly.

## Call sites & dependencies

Who consumes default-model resolution today:

- **`SaivageConfig` parse** ([src/config.ts](src/config.ts#L36-L92)) — Zod defaults inject the three strings into the parsed object. After F04, those `.default(...)` calls disappear; the fields become required-when-present (the *block* keeps its `.default({})` for the block itself, but `injectionModel` / `supervisor.model` / `models.orchestrator` become `z.string().optional()`).
- **`createPromptInjectionCop`** ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L51-L62)) — receives `security.injectionModel ?? DEFAULT_SCAN_MODEL`. After F04 the cop is constructed only after boot validation has confirmed a model is configured (or via an explicit `modelSpecOverride` passed by the bootstrapper from `routing.resolve("security").modelSpec`, as it already does at [src/server/bootstrap.ts](src/server/bootstrap.ts#L142)). `DEFAULT_SCAN_MODEL` is deleted.
- **`RuntimeSupervisor` constructor** ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L45-L55)) — same shape: `modelSpecOverride ?? config.supervisor.model ?? DEFAULT_MODEL`. After F04 the bootstrapper passes `routing.resolve("supervisor").modelSpec` (it already does at [src/server/bootstrap.ts](src/server/bootstrap.ts#L251)); `DEFAULT_MODEL` is deleted; the `??` fallback chain collapses to the override (required-when-supervisor-enabled).
- **`ModelRouter.resolveModelForRole`** ([src/providers/router.ts](src/providers/router.ts#L203-L205)) — last fallback `"anthropic/claude-sonnet-4-20250514"`. This method is called from agent constructors that haven't yet been refactored to consume `ModelRoutingResolver`. After F04 the fallback throws `MissingModelForRoleError`; boot validation ensures it is never reached for the live roster.
- **`ModelRoutingResolver.resolveLegacyModels`** ([src/routing/resolver.ts](src/routing/resolver.ts#L279-L286)) — last fallback `"openai-codex/gpt-5.3-codex"`. After F04 it throws `MissingModelForRoleError`; the `source: "hardcoded-default"` discriminant in `ResolvedModelRoute["source"]` ([src/routing/resolver.ts](src/routing/resolver.ts#L100)) is removed.
- **Boot wiring** ([src/server/bootstrap.ts](src/server/bootstrap.ts#L125-L260)) — gains a `validateModelCoverage(config, routing)` call right after `routing` is built and before any agent/supervisor/cop construction. This is the single enforcement point.

Test-side dependencies (the ones that will need updates because they encode the same strings):
- [src/config.test.ts](src/config.test.ts#L33) asserts `config.models.orchestrator === "anthropic/claude-sonnet-4-20250514"` — will need to change to assert "absent when not set" or to pass an explicit value.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L142) `expect(requests[0].modelSpec).toBe("github-copilot/gpt-5.4")` — this is a test of *behaviour-given-this-fixture-config*, not of defaults. Inspect: it relies on the supervisor default in the test fixture at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L271-L276). After F04 the test fixture sets `model: "github-copilot/gpt-5.4"` explicitly, the assertion stays identical.
- [src/providers/router.test.ts](src/providers/router.test.ts), [src/routing/resolver.test.ts](src/routing/resolver.test.ts), [src/providers/copilot.test.ts](src/providers/copilot.test.ts), [src/providers/openai-codex.test.ts](src/providers/openai-codex.test.ts) use `gpt-5.4` / `claude-sonnet-4-20250514` as **arbitrary realistic test inputs** — not as defaults. These tests do not need to change; the strings can remain as test fixtures.

Cross-issue dependencies:
- **F02 (agent roster drift)** — after F02 lands, the roster's `defaultModelKey` field defines the set of role-keys the boot check must cover. F04 should land after F02 so that "every role" has a single source rather than a hand-typed list across modules. If F02 has not landed when F04 starts, F04 supplies a local `REQUIRED_MODEL_ROLES` array in the validator and F02 later replaces it with a roster-derived list.
- **F11 (magic constants)** — F11 is about timing/sizing constants (`MAX_NUDGES`, `RECOVERY_DELAY_MS`, etc.) being inlined. F04 is structurally similar but model identifiers carry external-vendor risk (a number `15` doesn't become unsupported by a provider — a model string does). The right pattern for F11 is "make it configurable with a sensible built-in default"; for F04, per operator, it is "make it configurable with NO built-in default". Different policies, do not unify the issues.
- **F20 (`maxContextTokens` returns a single hardcoded number per provider)** — same family of "vendor product knowledge encoded in source" smell, but at a different layer (per-provider context window vs. per-role default). F20 is independent of F04; both should land, F20 will likely consume the model string F04 stops hardcoding.
- **F32 (`SaivageConfig` undocumented blocks)** — F32 documents the `security` and `supervisor` blocks. F04 changes those blocks (drops `.default(...)` on the model field). F04 should land first so F32 documents the post-F04 shape.

## Constraints any solution must respect

1. **No backward compatibility.** No "fallback to old default if config missing" warning + continue. The operator was explicit: fail. No `@deprecated` markers, no transitional `model || OLD_DEFAULT` shims.
2. **Fail at boot, not on first use.** A misconfigured Saivage that runs for 4 hours and then crashes during supervisor cycle 1 because nobody configured `supervisor.model` is worse than today's hardcoded-default behaviour. The validator must run during `bootstrapServer` (or whatever the v2 equivalent is) before any agent is constructed.
3. **Conditional roles must be checked conditionally.** `supervisor.model` is only required when `supervisor.enabled === true`; `security.injectionModel` only when `security.injectionScanner === true`. Otherwise an operator who disables those subsystems would be forced to set fake values.
4. **No `?? FALLBACK_CONSTANT` patterns survive in any of the seven sites.** Sites 4, 5, 6, 7 currently use `??` chains terminating in a string literal. After F04 those chains terminate in a thrown error from the resolver, or boot validation has already guaranteed the chain doesn't need a terminus.
5. **System-boundary validation only.** Per workspace guideline, internal callers (`createPromptInjectionCop`, `new RuntimeSupervisor`, agent constructors) do not re-validate; they trust that boot validation has run. The only place that validates is the boot-time `validateModelCoverage` function.
6. **The error message must name (a) the role, (b) the config field the operator should set, (c) the file path of the active `saivage.json`.** No "Cannot read property 'model' of undefined" stack traces.
7. **Test fixtures stay literal.** Tests use concrete model strings (`"github-copilot/gpt-5.4"`) as realistic inputs; F04 does not need to introduce a `TEST_MODEL` helper or refactor those tests. The strings being deleted are *defaults*, not *test inputs*.
8. **No new docstrings/comments** on code not otherwise modified (per loop conventions).
9. **Skills/memory subsystem is out of scope.** No skill loader is affected.
10. **`writeDefaultConfig`** at [src/config.ts](src/config.ts#L204-L237) writes a starter `saivage.json` for new projects. Today that starter has `models: {}` — an operator running `saivage init` and then `saivage serve` would have hit the orchestrator default. After F04 they will hit the boot validation error. The starter config needs to either (a) include a `models.default` placeholder + a comment-style README pointer, or (b) the `init` flow needs to prompt for at least one model. The cleanest answer per the architecture-first guideline is (a) with a clearly-named placeholder like `"REPLACE-WITH-PROVIDER/MODEL"` that itself fails routing with a recognisable error — but this risks the operator missing the placeholder. The design doc weighs both.
