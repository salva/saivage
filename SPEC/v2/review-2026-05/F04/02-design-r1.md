# F04 — Design (r1)

Two proposals plus a rejected option. Both honour the operator directive — "no model should be hardcoded; fail if config doesn't specify one" — but they differ in how deeply the change reshapes the resolution layer.

The rejected option (Proposal Z, at the bottom) is "centralise the defaults into a single `src/defaults.ts`" — included because it was suggested in the writer prompt; rejected because the operator's directive expressly forbids defaults.

---

## Proposal A — Drop the defaults, add a single boot-time validator

**Scope (files touched):**

- New: `src/config-validation.ts` (~60 lines) exposing `validateModelCoverage(config, routing): void` and a `MissingModelForRoleError` class.
- Edited:
  - [src/config.ts](src/config.ts#L36-L50) — `models` block: drop the `.default({ orchestrator: "anthropic/..." })` argument; the block-level `.default({})` stays (empty object). `orchestrator`, `planner`, ... all stay `modelAssignmentSchema.optional()` (already are).
  - [src/config.ts](src/config.ts#L78-L82) — `security.injectionModel`: change `z.string().default("github-copilot/gpt-5.4")` → `z.string().optional()`.
  - [src/config.ts](src/config.ts#L84-L92) — `supervisor.model`: change `z.string().default("github-copilot/gpt-5.4")` → `z.string().optional()`.
  - [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L26) — delete `const DEFAULT_SCAN_MODEL = "github-copilot/gpt-5.4";`.
  - [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L51-L62) — `createPromptInjectionCop` requires `modelSpecOverride` (no longer optional); the `?? DEFAULT_SCAN_MODEL` chain collapses to `modelSpecOverride`. Bootstrap already passes `routing.resolve("security").modelSpec` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L142), so the call site does not change.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L8) — delete `const DEFAULT_MODEL = "github-copilot/gpt-5.4";`.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L45-L55) — constructor requires `modelSpecOverride` when `config.supervisor.enabled === true`; the `?? DEFAULT_MODEL` chain collapses. Bootstrap already passes `routing.resolve("supervisor").modelSpec` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L251).
  - [src/providers/router.ts](src/providers/router.ts#L203-L205) — `resolveModelForRole` last branch throws `MissingModelForRoleError(role, ".saivage/saivage.json:models")` instead of returning the hardcoded string.
  - [src/routing/resolver.ts](src/routing/resolver.ts#L279-L286) — `resolveLegacyModels` last branch throws `MissingModelForRoleError(role, ".saivage/saivage.json:models")` instead of returning `["openai-codex/gpt-5.3-codex"]`.
  - [src/routing/resolver.ts](src/routing/resolver.ts#L100) and [src/routing/resolver.ts](src/routing/resolver.ts#L289-L294) — remove the `"hardcoded-default"` source discriminant from `ResolvedModelRoute["source"]` and from `resolveSource`. The `resolveSource` `return "hardcoded-default"` branch becomes unreachable; per architecture-first guideline it is removed, not commented out. (`source` becomes `"routing" | "legacy" | "runtime-default" | "project-default"`.)
  - [src/server/bootstrap.ts](src/server/bootstrap.ts#L125-L260) — after `routing` is built (currently around line 130) and before `createPromptInjectionCop` / `new RuntimeSupervisor` / agent spawners, insert `validateModelCoverage(config, routing)`.
  - [src/config.ts](src/config.ts#L204-L237) `writeDefaultConfig` — populates `models` with a `default: "REPLACE-WITH-PROVIDER/MODEL"` placeholder so a fresh `init` produces a config that fails boot validation with a clear, locatable error rather than passing validation and then failing at first model call. The placeholder string is intentionally syntactically invalid for any real provider; the validator detects it and emits a "saivage.json contains the init placeholder — set models.default to a real provider/model" error.
  - [src/config.test.ts](src/config.test.ts#L33) — assertion updated: `expect(config.models.orchestrator).toBeUndefined()` (block parses; no default injected).
  - [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L264-L290) (fixture `makeSupervisorConfig`) — set explicit `supervisor.model: "github-copilot/gpt-5.4"` and `security.injectionModel: "github-copilot/gpt-5.4"` (these are already set; this confirms they remain after F04). No assertion change.
  - New: `src/config-validation.test.ts` covering the four happy/sad paths (see Plan).

**What gets added:**

- A `validateModelCoverage(config: SaivageConfig, routing: ModelRoutingResolver): void` function that:
  - For each role the runtime will actually construct (derived from the agent roster — F02 — or, if F02 has not landed, a local `REQUIRED_MODEL_ROLES` array containing `["planner", "manager", "coder", "researcher", "data_agent", "reviewer", "inspector", "chat"]`), calls `routing.resolve(role)` inside a try/catch. If any throws `MissingModelForRoleError`, accumulates the role into a list.
  - If `config.supervisor.enabled`, additionally checks `routing.resolve("supervisor")`.
  - If `config.security.injectionScanner`, additionally checks `routing.resolve("security")`.
  - If the accumulator is non-empty, throws a single `MissingModelForRoleError` listing all missing roles + the path of `saivage.json` (already exposed via `configPath()`).
- A `MissingModelForRoleError extends Error` carrying `roles: string[]` and `configPath: string`. Boot wraps the throw with `process.exit(1)` only at the outermost CLI surface (`src/server/cli.ts` `serve` command) — internal callers propagate.

**What gets removed:**

- Seven hardcoded model strings (sites 1–7 enumerated in `01-analysis-r1.md`).
- The `DEFAULT_SCAN_MODEL` and `DEFAULT_MODEL` module-local constants.
- The `"hardcoded-default"` member of the `ResolvedModelRoute["source"]` discriminated union.
- The optional-with-fallback ergonomics of `createPromptInjectionCop` and `RuntimeSupervisor` constructors: `modelSpecOverride` becomes required.
- The `?? <literal>` resolution patterns in `resolveModelForRole` and `resolveLegacyModels`.

**Risk:**

- **Operator-facing breakage.** A project running on a `saivage.json` that omits `supervisor.model` while leaving `supervisor.enabled = true` (today's default) will stop booting after this change. This is *intended* per the operator directive, but the error message must be unmistakable. Mitigation: the `MissingModelForRoleError` text is the single piece of UX that has to land right. Plan covers it.
- **`writeDefaultConfig` placeholder strategy.** Two failure modes: (a) operator runs `saivage init` and then `saivage serve` and hits the placeholder error — good, clearly directs them. (b) operator copies an existing `saivage.json` from another project and assumes it's complete — they hit the same error if any role is missing — also good. No silent-success path.
- **Test parallelism.** All v2 tests that construct a `SaivageConfig` via `loadConfig` from an empty file used to rely on the orchestrator default being injected. There are two such tests ([src/config.test.ts](src/config.test.ts#L33), and a small number in `src/agents/*.test.ts` that may transitively rely on it). The Plan enumerates them and asserts no more than ~3 lines change per file.
- **The `executor` and `default` model keys** are still in the `models` block (per F02, `executor` is dead and `default` is a legitimate convenience). F04 leaves them as-is; F02 deletes `executor`. No interaction risk.

**What it enables:**

- **F02 (roster):** F02 derives the model-key list from the roster's `defaultModelKey` values; F04's validator becomes a one-line `for (const r of WORKER_OR_PLANNER_ROLES) routing.resolve(r)`. The two issues compose cleanly with F02 landing first.
- **F20 (`maxContextTokens`):** F20 will need to interrogate the model spec to pick a context window. Once F04 guarantees a real model spec is in hand at every call site (no synthetic defaults), F20's per-spec lookup table has no "what context window applies to a string I made up?" edge case.
- **F32 (undocumented config blocks):** F32 documents `security` and `supervisor`. Post-F04, F32 documents that `injectionModel` and `model` are required when their respective subsystem is enabled — a sharper contract than "defaults to `github-copilot/gpt-5.4`".

**What it forbids:**

- Re-introducing any model string in source as a runtime fallback. The validator + the throwing branches in router/resolver enforce this at runtime; a future contributor adding `?? "some-model"` would have to also undo the validation flow, which would surface in PR review.
- Silent EOL drift: when GitHub Copilot retires `gpt-5.4`, the failure mode is a routing error attributable to the operator's `saivage.json`, not a buried `DEFAULT_SCAN_MODEL`.

**Recommendation note:** this is the proposal the operator explicitly asked for, and it is the minimum change that fully honours the directive. Recommended.

---

## Proposal B — Drop the defaults AND introduce a `model_role` indirection layer

Everything from Proposal A, plus a deeper refactor: collapse the two parallel resolution paths (`ModelRouter.resolveModelForRole` and `ModelRoutingResolver.resolve`) into the resolver-only path, and reshape `models` config from "one entry per agent role" to "one entry per `model_role` (capability tier), plus a per-agent-role assignment to a `model_role`".

**Additional scope beyond A:**

- New: `src/routing/model-roles.ts` declaring a small enum of capability tiers:
  ```ts
  export const MODEL_ROLES = ["primary", "fast", "auditor", "scanner"] as const;
  export type ModelRole = (typeof MODEL_ROLES)[number];
  ```
  Each agent role maps to a `ModelRole`:
  - `planner / manager / inspector → "primary"` (current `orchestrator`)
  - `coder / researcher / data_agent → "primary"` (or `"fast"`, per project policy)
  - `reviewer → "auditor"`
  - `chat → "fast"`
  - `supervisor → "auditor"`
  - `security → "scanner"`
  The mapping is fixed in `src/routing/model-roles.ts` (one place); operators only set `models.primary`, `models.fast`, `models.auditor`, `models.scanner` in `saivage.json`.
- Edited:
  - `src/config.ts` `models` block: replaces today's per-agent-role keys (`orchestrator, planner, manager, coder, researcher, data_agent, reviewer, inspector, executor, chat, default`) with `z.object({ primary, fast, auditor, scanner }).partial()`. **No defaults**.
  - `src/providers/router.ts`: `resolveModelForRole(role)` is deleted entirely; `ModelRouter` no longer carries the `modelAssignments` field. All callers route through `ModelRoutingResolver.resolve(role).modelSpec` (single path).
  - `src/routing/resolver.ts`: resolver internally maps `role → ModelRole → models[ModelRole]`; the four-source merge collapses to two sources (project routing override → `models[role's tier]`); `resolveLegacyModels` is deleted along with the `project.provider`/`model_overrides` legacy path (architecture-first: legacy paths are removed, not preserved).
  - `src/config-validation.ts`: validates `models.primary`, `models.fast`, `models.auditor`, `models.scanner` are present for whichever tiers any active agent role maps to.

**What gets added beyond A:**

- A four-element capability-tier vocabulary and a fixed agent-role → tier table.
- Project routing can still override per-agent-role (the `routing.roles` block in `ProjectRoutingConfigLike` is preserved); the tiers are the *default* layer, the per-role overrides are the *exception* layer.

**What gets removed beyond A:**

- The `models.orchestrator`, `models.planner`, ..., `models.executor` keys — 11 keys collapse to 4.
- `ModelRouter.resolveModelForRole` and the `modelAssignments` field on `ModelRouter`.
- `ModelRoutingResolver.resolveLegacyModels` and the `project.provider` / `project.model_overrides` legacy path.
- `ROUTING_ROLE_TO_MODEL_KEY` at [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16) — it is replaced by the `role → tier` map, which lives in `model-roles.ts`.

**Risk:**

- **Existing `saivage.json` files break.** Any production `saivage.json` with `models.orchestrator` / `models.coder` / etc. stops working. Per the workspace architecture-first guideline ("no backward compatibility") this is allowed, but it is meaningfully larger blast radius than Proposal A. The operator's project (`/home/salva/g/ml/saivage-v3/.saivage/`) and any deployed harnesses would need their configs updated as part of the merge.
- **Tier names are a design decision the operator hasn't weighed in on.** Choosing `"primary" | "fast" | "auditor" | "scanner"` (or any other tuple) bakes in a *taxonomy*. If the tuple is wrong, a follow-up rename is more painful than today's per-role keys.
- **The role → tier mapping is itself a default.** Per the operator directive on F04 ("no defaults"), it is arguable whether `planner → primary` is the same kind of "default" the operator objected to. The defence: this is not a *model* default (no model name in source); it is a *grouping* of roles that share a capability profile. Whether the operator accepts that distinction is a judgement call.
- **Larger PR surface.** Touches every consumer of `ModelRouter.resolveModelForRole` (agent constructors). Conflicts with F02's roster-derived `defaultModelKey` mapping (which assumes the current per-role-key shape). F02 + F04-B together is a meaningfully wider change than F02 + F04-A.

**What it enables:**

- A single resolution path simplifies later work on routing observability (the `source` discriminant has only two members instead of five after F04-A).
- The `models` block becomes 4 keys instead of 11, simpler to document in F32.
- Adding a new agent role doesn't require adding a `models.*` key — it just gets mapped to one of the four tiers.

**What it forbids:**

- Per-agent-role models specified directly in `saivage.json` (must go through `routing.roles` override). Some operators may experience this as a regression in ergonomics.
- The "legacy" routing path (`project.provider`, `model_overrides`). Per architecture-first, this is correct; in practice some tests will need to migrate.

**Recommendation note:** structurally cleaner but the operator's stated objection in F04 is specifically about hardcoded *model identifiers*, not about the *shape* of the `models` block. Proposal B introduces a tier taxonomy as a side effect; that taxonomy is a design decision worthy of its own discussion. **Not recommended for F04** — propose it separately if the per-role-key sprawl in `models` becomes its own issue.

---

## Proposal Z (rejected) — Centralise the defaults in `src/defaults.ts`

The writer prompt suggested this as Proposal A. It is rejected because it directly contradicts the operator directive quoted at the top of [F04-hardcoded-default-models.md](../F04-hardcoded-default-models.md):

> No model should be hard-coded. If no model is set in the config, the system must just fail to work and report the issue.

Centralising the defaults into `src/defaults.ts` *moves* the hardcoded strings but keeps them. It would also keep the silent-EOL-drift failure mode that motivated the issue in the first place. Recording the proposal for completeness; it is not a viable option under the stated operator constraint.

---

## Recommendation

**Proposal A.** It is the minimal change that fully honours the operator directive, it composes cleanly with F02 (roster) and F32 (config docs), and it does not pre-commit to a tier taxonomy that the operator has not signed off on. Proposal B can be raised as a separate issue (e.g. F04b) if the `models` block sprawl is later judged a separate concern.
