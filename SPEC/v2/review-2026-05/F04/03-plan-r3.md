# F04 — Plan (r3)

Implementation plan for **Proposal A — drop the defaults, add a single boot-time validator**.

## Changes from r2

- **Step 6 expanded** to include the `resolveSource` classification fix for `allowed_models`-only routing rules. r2 only listed the `"hardcoded-default"` removal; the reviewer correctly observed that `resolvePreferredModels` returns `[...allowed]` for an `allowed_models`-only rule ([src/routing/resolver.ts](src/routing/resolver.ts#L241)), so removing `"hardcoded-default"` without first classifying that case as `"routing"` would convert a valid operator rule into a thrown error. Both edits land in step 6, in the order: classification first, terminal-branch removal second.
- **New step 6b** rewrites the JSDoc example on `AgentContext.modelSpec` at [src/agents/types.ts](src/agents/types.ts#L49). r2's production-source sweep (step 11) would have failed on the current tree because the literal `"openai-codex/gpt-5.3-codex"` lives in that comment. Resolution: a one-line edit that changes the example to `"provider/model"`. This keeps the sweep contract strict ("zero model identifiers in `src/**/*.ts` outside test files") without needing JSDoc-aware exception logic.
- **Step 10 adds** a focused `allowed_models`-only resolver test: a `routing.roles.<role>` rule with only `allowed_models: ["provider/model"]` (no `model`, no `preferred_models`, no `profile`) resolves with `source: "routing"` and `modelSpec: "provider/model"`. This proves the classification fix and pins it against regression.
- **Step 11 unchanged** in scope (still the grep + the executable test in `src/config-validation.test.ts`) but the expected pass condition is now actually achievable: after step 6b, the JSDoc example no longer trips the sweep.

All other r2 steps are unchanged.

## Ordered edit steps

1. **Add `src/config-validation.ts`** with:
   - `class MissingModelForRoleError extends Error` carrying `roles: string[]` and `configPath: string`. Constructor formats the message: `"No model configured for role(s): <roles>. Set models.default (or models.<role>) in <configPath>."`.
   - `function validateModelCoverage(config: SaivageConfig, routing: ModelRoutingResolver, configPathStr: string): void`.
     - Local constant `REQUIRED_MODEL_ROLES: readonly string[] = ["planner", "manager", "coder", "researcher", "data_agent", "reviewer", "inspector", "chat"]`. (Once F02 lands, this is replaced by the roster's `WORKER_OR_PLANNER_ROLES` export; the validator's body otherwise unchanged.)
     - Iterate `REQUIRED_MODEL_ROLES`, call `routing.resolve(role)` inside try/catch, collect missing roles.
     - If `config.supervisor.enabled`, additionally try `routing.resolve("supervisor")`.
     - If `config.security.injectionScanner`, additionally try `routing.resolve("security")`.
     - If accumulator non-empty, throw single `MissingModelForRoleError(missing, configPathStr)`.

2. **Edit `src/config.ts`**:
   - Line 49: replace `.default({ orchestrator: "anthropic/claude-sonnet-4-20250514" })` with `.default({})`.
   - Line 83: replace `injectionModel: z.string().default("github-copilot/gpt-5.4"),` with `injectionModel: z.string().optional(),`.
   - Line 91: replace `model: z.string().default("github-copilot/gpt-5.4"),` with `model: z.string().optional(),`.
   - `writeDefaultConfig`: **no change**. The existing `models: {}` seed is correct under F04. No placeholder is written.

3. **Edit `src/security/prompt-injection-cop.ts`**:
   - Delete line 26 (`const DEFAULT_SCAN_MODEL = "github-copilot/gpt-5.4";`).
   - In `createPromptInjectionCop` (around line 51–62), reorganize so the disabled-scanner early-return runs before any model resolution: leave the existing `if (!security.injectionScanner) return disabledCop();` as the first statement. After that early return, change the `modelSpec` line from `modelSpecOverride ?? security.injectionModel ?? DEFAULT_SCAN_MODEL` to `modelSpecOverride` (drop the chain entirely). The parameter `modelSpecOverride?: string` stays optional in the signature; add a defensive throw immediately after the early return:
     ```ts
     if (!modelSpecOverride) throw new MissingModelForRoleError(["security"], configPath());
     ```
     This is unreachable under correct bootstrap + boot validation; it exists so a wrongly-wired construction surfaces a clear error rather than a `Cannot read property 'model' of undefined` later.
   - Import `MissingModelForRoleError` from `../config-validation.js` and `configPath` from `../config.js`.
   - `DEFAULT_MAX_SCAN_CHARS` stays — it is a sizing constant, F11's territory.

4. **Edit `src/runtime/supervisor.ts`**:
   - Delete line 8 (`const DEFAULT_MODEL = "github-copilot/gpt-5.4";`).
   - Constructor `modelSpecOverride?: string` stays optional. Body assignment: `this.modelSpec = modelSpecOverride ?? "";` (drop the `?? config.supervisor.model ?? DEFAULT_MODEL` chain). The `config.supervisor.model` field still exists (optional now) so an operator can set it; the bootstrap path resolves it via the routing resolver and passes it as the override.
   - In `start()` (around line 57), update the guard so it throws when enabled-but-no-model:
     ```ts
     if (!this.enabled || this.timer) return;
     if (!this.modelSpec) throw new MissingModelForRoleError(["supervisor"], configPath());
     ```
     Same rationale as the cop: unreachable under correct bootstrap + boot validation; defense-in-depth for misconfigured construction.
   - Import `MissingModelForRoleError` and `configPath`.

5. **Edit `src/providers/router.ts`**:
   - Line 203–205: `resolveModelForRole(role: string): string` — change the last branch from `?? "anthropic/claude-sonnet-4-20250514"` to `throw new MissingModelForRoleError([role], configPath());`. Import `MissingModelForRoleError` from `../config-validation.js` and `configPath` from `../config.js`.

6. **Edit `src/routing/resolver.ts`** — resolver structural cleanup (apply in this order so the tree stays compiling between sub-edits):
   - **6.1** Line 289 (`resolveSource` first branch): change
     ```ts
     if (rule.model || rule.preferredModels.length || rule.profile) return "routing";
     ```
     to
     ```ts
     if (rule.model || rule.preferredModels.length || rule.allowedModels?.length || rule.profile) return "routing";
     ```
     This classifies `allowed_models`-only rules as routing-derived, matching the resolution path in `resolvePreferredModels` ([src/routing/resolver.ts](src/routing/resolver.ts#L241)). It must land before sub-edit 6.4 below; otherwise an `allowed_models`-only rule would hit the new terminal throw.
   - **6.2** Lines 279–286 (`resolveLegacyModels`): change the final `return ["openai-codex/gpt-5.3-codex"];` to `throw new MissingModelForRoleError([role], configPath());`.
   - **6.3** Line 100: change the `source` union to `"routing" | "legacy" | "runtime-default" | "project-default"` (drop `"hardcoded-default"`).
   - **6.4** Lines 293–294 (`resolveSource` terminal): delete the final `return "hardcoded-default";` branch. To satisfy TS that `resolveSource` returns on every path, terminate the function with `throw new Error("unreachable: resolveLegacyModels would have thrown first");`. This is an internal-invariant marker, not a defensive fallback — no model identifier, no operator UX.
   - Import `MissingModelForRoleError` from `../config-validation.js` and `configPath` from `../config.js`.

6a. **Edit `src/routing/resolver.ts`** — second edit (inline literal in `resolve()`):
   - Line 135 (`resolve()` `modelSpec` chain): change
     ```ts
     const modelSpec = preferredModels[0] ?? this.resolveLegacyModels(role)[0] ?? "openai-codex/gpt-5.3-codex";
     ```
     to
     ```ts
     const candidate = preferredModels[0] ?? this.resolveLegacyModels(role)[0];
     if (!candidate) throw new MissingModelForRoleError([role], configPath());
     const modelSpec = candidate;
     ```
     The `if (!candidate)` branch is unreachable in practice (because `resolveLegacyModels` already throws when there's no model) but required for TS narrowing.

6b. **Edit `src/agents/types.ts`** — rewrite the JSDoc example:
   - Line 49: change
     ```ts
     /** Model spec to use (e.g. "openai-codex/gpt-5.3-codex"). */
     modelSpec: string;
     ```
     to
     ```ts
     /** Model spec to use (e.g. "provider/model"). */
     modelSpec: string;
     ```
     One-line edit. Removes the last model-identifier literal from production source so the sweep contract in step 11 is executable. The comment already exists; only the example string changes (consistent with the loop convention's "no new docstrings/comments" rule, which forbids *adding* comments, not editing them as part of an in-scope edit).

7. **Edit `src/server/bootstrap.ts`**:
   - After `routing` is constructed (currently around line 129–131) and before `createPromptInjectionCop` / `new RuntimeSupervisor` / agent spawners, insert:
     ```ts
     import { validateModelCoverage } from "../config-validation.js";
     import { configPath } from "../config.js";
     // ...
     validateModelCoverage(config, routing, configPath(project.projectRoot));
     ```
   - Line 142: change
     ```ts
     createPromptInjectionCop(config, router, routing.resolve("security").modelSpec)
     ```
     to
     ```ts
     createPromptInjectionCop(
       config,
       router,
       config.security.injectionScanner ? routing.resolve("security").modelSpec : undefined,
     )
     ```
   - Line 251: change
     ```ts
     supervisor = new RuntimeSupervisor(config, { router, agentRegistry }, routing.resolve("supervisor").modelSpec);
     ```
     to
     ```ts
     supervisor = new RuntimeSupervisor(
       config,
       { router, agentRegistry },
       config.supervisor.enabled ? routing.resolve("supervisor").modelSpec : undefined,
     );
     ```

8. **Edit `src/server/cli.ts`** (`init` command, around line 33–77):
   - Line 45: delete the line `provider: "openai-codex/gpt-5.3-codex",`. The freshly written `.saivage/config.json` no longer carries a `provider` field.

8a. **Edit `src/server/cli.ts`** (`start` / `serve` commands, around line 80–120):
   - Wrap the `bootstrap()` call in:
     ```ts
     try {
       runtime = await bootstrap(path);
     } catch (err) {
       const { MissingModelForRoleError } = await import("../config-validation.js");
       if (err instanceof MissingModelForRoleError) {
         console.error(err.message);
         process.exit(1);
       }
       throw err;
     }
     ```

9. **Update existing tests:**
   - [src/config.test.ts](src/config.test.ts#L33): change `expect(config.models.orchestrator).toBe("anthropic/claude-sonnet-4-20250514");` to `expect(config.models.orchestrator).toBeUndefined();`. Verify by `git diff` that no other line in `config.test.ts` references the old default string.
   - [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L135), [L164](src/runtime/runtime.test.ts#L164), [L188](src/runtime/runtime.test.ts#L188), [L217](src/runtime/runtime.test.ts#L217), [L245](src/runtime/runtime.test.ts#L245): each `new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry })` becomes `new RuntimeSupervisor(makeSupervisorConfig(), { router, agentRegistry }, "github-copilot/gpt-5.4")`. (Same string the fixture's `supervisor.model` carries.)
   - [src/routing/resolver.test.ts](src/routing/resolver.test.ts) — search for `"hardcoded-default"` and `"openai-codex/gpt-5.3-codex"` references. Any test that exercised the hardcoded-fallback path is updated to either (a) set a model in the test fixture and assert the new source, or (b) assert `expect(() => resolver.resolve("role")).toThrow(MissingModelForRoleError)`. Confirm with `rg 'hardcoded-default|openai-codex/gpt-5\.3-codex' src/routing/`.
   - [src/providers/router.test.ts](src/providers/router.test.ts) — `resolveModelForRole` callers: search for any test that exercises the missing-role path. Update to assert `expect(() => router.resolveModelForRole("nonexistent")).toThrow(MissingModelForRoleError)`.

10. **Add `src/config-validation.test.ts`** with these cases:
    - Happy path: config sets `models.default = "github-copilot/gpt-5.4"`; `validateModelCoverage` returns void.
    - Missing model for one worker role: validator throws, error message names the role and the configured `saivage.json` path.
    - Supervisor disabled + no `supervisor.model`: validator does not throw for `supervisor`.
    - Security disabled + no `security.injectionModel`: validator does not throw for `security`.
    - Supervisor enabled + no model anywhere: validator throws with `supervisor` in the role list.
    - Security enabled + no model anywhere: validator throws with `security` in the role list.
    - Fresh-init failure: a freshly initialized project (`saivage init <tmpdir>` style, but written directly via `writeDefaultConfig` + `initProject` with the same config shape `saivage init` produces post-step-8a) followed by `bootstrap()` throws `MissingModelForRoleError` listing all 8 worker roles + `supervisor` + `security`, with `configPath` pointing at the new project's `.saivage/saivage.json`.
    - Disabled-everything bootability: a project with both `supervisor.enabled = false` and `security.injectionScanner = false`, no `models` block, no `routing`, no `project.provider`, no `model_overrides` — bootstrap still throws because worker roles (`planner`, `coder`, ...) are required; supervisor and security are not in the error list.

    **Plus, in `src/routing/resolver.test.ts`** (focused regression test for the r3 classification fix):
    - `allowed_models`-only routing rule: a `SaivageConfig` with `routing.roles.coder = { allowed_models: ["github-copilot/gpt-5.4"] }` (no `model`, no `preferred_models`, no `profile`) resolves with
      ```ts
      const route = resolver.resolve("coder");
      expect(route.modelSpec).toBe("github-copilot/gpt-5.4");
      expect(route.source).toBe("routing");
      ```
      This pins the `resolveSource` classification edit (step 6.1) and prevents future refactors from re-misclassifying the case.

11. **Production-source sweep** (validation step + executable test):
    - Manual: run
      ```bash
      rg -n 'github-copilot/gpt-5\.|anthropic/claude-sonnet-4-|openai-codex/gpt-5\.3-codex' src/ --type ts | grep -v '\.test\.ts'
      ```
      Expected output: zero matches. After step 6b, the `src/agents/types.ts` JSDoc no longer trips the sweep; after steps 2–8a, no runtime literal remains.
    - Encoded as an executable test in `src/config-validation.test.ts`: use `child_process.execSync('rg -l ...', { cwd: process.cwd() })` and assert the result excludes any non-`.test.ts` file. A future PR reintroducing a literal — runtime, comment, or otherwise — will fail CI.

## Test strategy

**Existing tests that cover this area** (must continue passing in behaviour):
- [src/config.test.ts](src/config.test.ts) — config loader.
- [src/routing/resolver.test.ts](src/routing/resolver.test.ts) — the four-source merge.
- [src/providers/router.test.ts](src/providers/router.test.ts) — router resolution.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — supervisor/cop construction.
- `src/security/prompt-injection-cop.test.ts` (if present — confirm via `ls src/security/`).

**New tests:**
- `src/config-validation.test.ts` — the eight validator cases enumerated in step 10 + the production-source sweep in step 11.
- One new case in `src/routing/resolver.test.ts` — the `allowed_models`-only routing rule (step 10, second block).
- One end-to-end-flavoured test (extend `src/runtime/runtime.test.ts` or add `src/server/bootstrap.test.ts`) asserting that a `loadConfig`'d empty config + a fresh `ModelRoutingResolver` + `validateModelCoverage` throws `MissingModelForRoleError` with `roles` containing all 8 worker/planner/chat roles plus `supervisor` and `security`.
- A bootstrap-level test asserting that `config.security.injectionScanner: false` + `config.supervisor.enabled: false` + no model strings anywhere does not throw at `bootstrap()` (the disabled subsystems are not resolved).

**Commands:**

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npx vitest run src/config-validation.test.ts
npx vitest run src/config.test.ts src/routing/resolver.test.ts src/providers/router.test.ts src/runtime/runtime.test.ts src/security/
npm run build
# Manual sweep (also encoded as a test case in src/config-validation.test.ts):
rg -n 'github-copilot/gpt-5\.|anthropic/claude-sonnet-4-|openai-codex/gpt-5\.3-codex' src/ --type ts | grep -v '\.test\.ts' || echo "OK: no production-source matches"
```

The full suite (`npx vitest run`) should be run before commit; the focused commands above are the iteration loop.

## Rollback strategy

Single commit. Revert reintroduces the ten source-level literals (nine runtime + one JSDoc), the `??` chains, the unconditional bootstrap resolution, the CLI seed, and the `"hardcoded-default"` source classification; the validator + `MissingModelForRoleError` module is deleted as part of the revert. Operators whose `saivage.json` was updated to set explicit models retain those settings (the fields remain valid post-revert; the defaults just become unused again).

If a partial rollback is needed (e.g. one provider's tests reveal an unanticipated interaction), the change naturally splits into three independent commits:

1. Validator module + bootstrap wiring + conditional resolution (steps 1, 7, 10, 11).
2. Config schema + CLI seed removal + JSDoc rewrite (steps 2, 6b, 8, 8a).
3. Constant deletions + signature tightening + resolver edits (steps 3, 4, 5, 6, 6a, 9).

Commit 3 cannot land before commit 1 (the throwing branches in router/resolver require boot validation + conditional bootstrap to be in place). Commit 2's step 6b (JSDoc rewrite) can land in any order — it has no runtime dependency — but is grouped with commit 2 because it's a one-line text edit and a natural fit with the other comment/seed cleanups.

## Cross-issue ordering

- **Land after F02 if possible** — F02 introduces the agent roster; the validator's `REQUIRED_MODEL_ROLES` constant becomes a roster-derived expression. If F02 has not landed when F04 starts, the local array is a documented bridge that F02's writer replaces.
- **Land before F32** — F32 documents `security.injectionModel` and `supervisor.model`. Post-F04 the documentation says "required when subsystem enabled" instead of "defaults to `github-copilot/gpt-5.4`".
- **Independent of F11, F19, F20** — F11 is about non-model sizing constants; F19 is the provider barrel; F20 is per-provider context-window numbers. None blocks F04.

If both F02 and F04 are in flight simultaneously, F02 lands first.
