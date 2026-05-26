# F04 — Plan (r1)

Implementation plan for **Proposal A — drop the defaults, add a single boot-time validator**.

## Ordered edit steps

1. **Add `src/config-validation.ts`** with:
   - `class MissingModelForRoleError extends Error` carrying `roles: string[]` and `configPath: string`. `toString()` formatter that lists missing roles, the configured `saivage.json` path, and a one-line remediation hint ("set `models.<role>` or `models.default` in <path>").
   - `function validateModelCoverage(config: SaivageConfig, routing: ModelRoutingResolver, configPathStr: string): void`.
     - Local constant `REQUIRED_MODEL_ROLES: readonly string[] = ["planner", "manager", "coder", "researcher", "data_agent", "reviewer", "inspector", "chat"]`. (Once F02's roster lands, this is replaced by `WORKER_OR_PLANNER_ROLES` from the roster module; the validator's body otherwise unchanged.)
     - Iterate `REQUIRED_MODEL_ROLES`, call `routing.resolve(role)` inside try/catch, collect the role into a `missing: string[]` array on `MissingModelForRoleError`.
     - If `config.supervisor.enabled`, additionally check `routing.resolve("supervisor")`.
     - If `config.security.injectionScanner`, additionally check `routing.resolve("security")`.
     - If `missing.length > 0`, throw a single `MissingModelForRoleError(missing, configPathStr)`.

2. **Edit `src/config.ts`**:
   - Line 49: replace `.default({ orchestrator: "anthropic/claude-sonnet-4-20250514" })` with `.default({})`.
   - Line 83: replace `injectionModel: z.string().default("github-copilot/gpt-5.4"),` with `injectionModel: z.string().optional(),`.
   - Line 91: replace `model: z.string().default("github-copilot/gpt-5.4"),` with `model: z.string().optional(),`.
   - In `writeDefaultConfig` (around line 207), change the seeded `models: {}` to `models: { default: "REPLACE-WITH-PROVIDER/MODEL" }`. (This placeholder is recognised by the validator with a sharper error: "saivage.json contains the init placeholder — set models.default to a real provider/model".)

3. **Edit `src/security/prompt-injection-cop.ts`**:
   - Delete line 26 (`const DEFAULT_SCAN_MODEL = "github-copilot/gpt-5.4";`).
   - Change the signature of `createPromptInjectionCop(config, router, modelSpecOverride?)` so `modelSpecOverride: string` is required (drop the `?`).
   - Change the body to `modelSpec: modelSpecOverride` (drop the `?? security.injectionModel ?? DEFAULT_SCAN_MODEL` chain).
   - `DEFAULT_MAX_SCAN_CHARS` stays — it is a sizing constant, not a model identifier, and is F11's territory.

4. **Edit `src/runtime/supervisor.ts`**:
   - Delete line 8 (`const DEFAULT_MODEL = "github-copilot/gpt-5.4";`).
   - Change the constructor's `modelSpecOverride?: string` parameter to `modelSpecOverride: string` (required).
   - Change the body assignment to `this.modelSpec = modelSpecOverride;` (drop the `?? config.supervisor.model ?? DEFAULT_MODEL` chain). The `config.supervisor.model` field still exists (optional now) so an operator can set it in `saivage.json`; the bootstrap path resolves it via the routing resolver and passes it as the override, exactly as today.

5. **Edit `src/providers/router.ts`**:
   - Line 203–205: `resolveModelForRole(role: string): string` — change the last branch from `?? "anthropic/claude-sonnet-4-20250514"` to `throw new MissingModelForRoleError([role], configPath)`. Import `MissingModelForRoleError` and `configPath` from `../config-validation.js` and `../config.js`.

6. **Edit `src/routing/resolver.ts`**:
   - Line 100: change the `source` union to `"routing" | "legacy" | "runtime-default" | "project-default"` (drop `"hardcoded-default"`).
   - Lines 279–286 (`resolveLegacyModels`): change the final `return ["openai-codex/gpt-5.3-codex"];` to `throw new MissingModelForRoleError([role], configPath);`.
   - Lines 289–294 (`resolveSource`): delete the final `return "hardcoded-default";` branch. The `if (this.project.provider) return "project-default";` becomes the last branch; if neither condition matches, the resolver will throw from `resolveLegacyModels` before `resolveSource` is reached, so no fallback return is needed. If TS complains about a missing return type, add `throw new MissingModelForRoleError(...)` at the end as the unreachable terminator.
   - `MissingModelForRoleError` import added.

7. **Edit `src/server/bootstrap.ts`**:
   - After `routing` is constructed (currently around line 129–131) and before `createPromptInjectionCop` (line 142) / `new RuntimeSupervisor` (line 251) / any agent spawner, insert:
     ```ts
     import { validateModelCoverage } from "../config-validation.js";
     import { configPath } from "../config.js";
     // ...
     validateModelCoverage(config, routing, configPath(projectRoot));
     ```
   - No other bootstrap changes; `routing.resolve("security").modelSpec` and `routing.resolve("supervisor").modelSpec` already do the right thing once the throwing branches in the resolver are in place.

8. **Edit `src/server/cli.ts`** (`serve` command, around line 80–120 in the existing CLI surface):
   - Wrap the bootstrap call in `try { ... } catch (err) { if (err instanceof MissingModelForRoleError) { console.error(err.toString()); process.exit(1); } throw err; }`. This is the *only* place that catches `MissingModelForRoleError`; internal callers propagate.

9. **Update existing tests:**
   - [src/config.test.ts](src/config.test.ts#L33): change `expect(config.models.orchestrator).toBe("anthropic/claude-sonnet-4-20250514");` to `expect(config.models.orchestrator).toBeUndefined();`. Verify by `git diff` that no other line in `config.test.ts` references the old default string.
   - [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L264-L290) `makeSupervisorConfig`: confirm `supervisor.model` and `security.injectionModel` are explicit (they already are at lines 271, 276); no change required. Tests at lines 135/164/188/217/245 construct `new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry })` — they currently pass `undefined` as the third arg, which under the new required-parameter signature is a type error. Update each to `new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry }, "github-copilot/gpt-5.4")` (same string the fixture already carries).
   - [src/routing/resolver.test.ts](src/routing/resolver.test.ts) — search for `source: "hardcoded-default"` (no matches expected; the test corpus uses configured paths). If any test relies on the hardcoded fallback, change the fixture to set a model explicitly. Confirm with `rg "hardcoded-default" src/`.
   - [src/providers/router.test.ts](src/providers/router.test.ts) — `resolveModelForRole` callers: search for any test that exercises the missing-role path. Update those to assert `expect(() => router.resolveModelForRole("nonexistent")).toThrow(MissingModelForRoleError)`.

10. **Add `src/config-validation.test.ts`** with four cases:
    - Happy path: config sets `models.default`; `validateModelCoverage` returns void.
    - Missing model for one worker: validator throws, error names `coder` and the configured `saivage.json` path.
    - Supervisor disabled + supervisor model absent: validator does not throw for `supervisor`.
    - Security enabled + injection model absent: validator throws naming `security`.

## Test strategy

**Existing tests that cover this area** (must continue passing unchanged in behaviour):
- [src/config.test.ts](src/config.test.ts) — config loader.
- [src/routing/resolver.test.ts](src/routing/resolver.test.ts) — the four-source merge.
- [src/providers/router.test.ts](src/providers/router.test.ts) — router resolution.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — supervisor/cop construction.
- [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts) (if present — check via `ls src/security/`).

**New tests:**
- `src/config-validation.test.ts` — the four cases enumerated in step 10.
- One end-to-end-flavoured test in `src/server/bootstrap.test.ts` (if such a test module exists; otherwise extend `src/runtime/runtime.test.ts`) asserting that a `loadConfig`'d empty config + a fresh `ModelRouter` + `validateModelCoverage` throws `MissingModelForRoleError` with `roles` containing all 8 worker/planner/chat roles plus `supervisor` and `security`.

**Commands:**

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npx vitest run src/config-validation.test.ts
npx vitest run src/config.test.ts src/routing/resolver.test.ts src/providers/router.test.ts src/runtime/runtime.test.ts src/security/
npm run build
```

The full suite (`npx vitest run`) should be run before commit; the focused commands above are the iteration loop.

## Rollback strategy

Single commit. Revert reintroduces the seven hardcoded strings and the `?? <literal>` chains; the validator + `MissingModelForRoleError` module is deleted as part of the revert. Operators whose `saivage.json` was updated to set explicit models retain those settings (the fields remain valid post-revert; the defaults just become unused again).

If a partial rollback is needed (e.g. one provider's tests reveal an unanticipated interaction), the change naturally splits into three independent commits:
1. Validator module + bootstrap wiring (steps 1, 7, 8, 10).
2. Config schema + writeDefaultConfig (step 2).
3. Constant deletions + signature tightening (steps 3, 4, 5, 6, 9).

Commit 3 cannot land before commit 1 (the throwing branches in router/resolver require the validator to have run at boot). Otherwise the order is flexible.

## Cross-issue ordering

- **Land after F02 if possible** — F02 introduces the agent roster; the validator's `REQUIRED_MODEL_ROLES` constant becomes a `roster.filter(r => r.role !== ...).map(r => r.role)` expression. If F02 has not landed when F04 starts, the local `REQUIRED_MODEL_ROLES` array is a documented bridge that F02's writer will replace as part of F02's edits.
- **Land before F32** — F32 documents `security.injectionModel` and `supervisor.model`. Post-F04 the documentation says "required when subsystem enabled" instead of "defaults to `github-copilot/gpt-5.4`". Documenting today's behaviour and then rewriting it next week is wasted work.
- **Independent of F11, F20** — F11 is about non-model constants; F20 is about per-provider context-window numbers. Neither blocks F04.
- **Independent of F19** — F19 is the provider barrel; not in the model-default resolution path.

If both F02 and F04 are in flight simultaneously, F02 lands first.
