# F04 - Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [F04-hardcoded-default-models.md](../F04-hardcoded-default-models.md)
- [01-analysis-r1.md](01-analysis-r1.md)
- [02-design-r1.md](02-design-r1.md)
- [03-plan-r1.md](03-plan-r1.md)

## Findings

### Analysis

1. The source inventory misses an additional runtime hardcoded model fallback in the resolver. [01-analysis-r1.md](01-analysis-r1.md#L25) identifies the final `resolveLegacyModels` fallback, but [src/routing/resolver.ts](src/routing/resolver.ts#L135) also has `?? "openai-codex/gpt-5.3-codex"` in `resolve()` itself. Even if it is currently dead because `resolveLegacyModels()` always returns a non-empty array, it is still a model identifier embedded as a last-ditch runtime fallback. Under the operator directive, it must be called out and removed.

2. The fresh-init path is not fully accounted for. The analysis focuses on [src/config.ts](src/config.ts#L204-L237) and says a new project should hit the `saivage.json` placeholder path, but CLI init currently seeds `.saivage/config.json` with a hardcoded `provider: "openai-codex/gpt-5.3-codex"` at [src/server/cli.ts](src/server/cli.ts#L45), and `initProject` writes that project config at [src/store/project.ts](src/store/project.ts#L115). Since the resolver still accepts `project.provider` as a `project-default` source at [src/routing/resolver.ts](src/routing/resolver.ts#L284-L285), a freshly initialized project can still get a model from source code rather than operator runtime configuration.

### Design

1. The conditional-role design is correct in intent but not executable with the current bootstrap shape. [02-design-r1.md](02-design-r1.md#L35-L36) says `supervisor` and `security` are checked only when enabled, but bootstrap always evaluates `routing.resolve("security").modelSpec` before calling `createPromptInjectionCop` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L142), even though the cop only checks `!security.injectionScanner` inside the callee at [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L57). Bootstrap also always resolves `supervisor` before constructing the supervisor at [src/server/bootstrap.ts](src/server/bootstrap.ts#L251), even though the supervisor no-ops only later in `start()` at [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L57). Disabled subsystems would still fail model resolution after the proposed throwing resolver change.

2. The placeholder strategy is underspecified. [02-design-r1.md](02-design-r1.md#L26) says `"REPLACE-WITH-PROVIDER/MODEL"` is intentionally invalid and detected by the validator, but the resolver parser only requires a slash, so that placeholder is syntactically valid as a provider/model-shaped string. The validator design at [02-design-r1.md](02-design-r1.md#L33-L36) only describes catching `MissingModelForRoleError`; it does not describe detecting the placeholder, so `models.default` with the placeholder would look like coverage for every role.

### Plan

1. Step 6 removes only the fallback in `resolveLegacyModels` ([03-plan-r1.md](03-plan-r1.md#L38-L39)) and leaves the inline fallback in [src/routing/resolver.ts](src/routing/resolver.ts#L135). The plan needs an explicit edit to make `resolve()` obtain the model spec from either `preferredModels[0]` or a throwing resolver path, with no literal fallback at the call site.

2. Step 7 says no other bootstrap changes are needed because the existing `routing.resolve("security")` and `routing.resolve("supervisor")` calls already do the right thing ([03-plan-r1.md](03-plan-r1.md#L43-L50)). They do not: after F04, those calls must be guarded by the same enabled checks that the validator uses, or disabled subsystems become impossible to boot without fake models.

3. The tests do not cover either placeholder rejection or the fresh-init/default-provider bypass. The new tests in [03-plan-r1.md](03-plan-r1.md#L62-L78) should include at least: placeholder `models.default` is rejected with the promised specific message; a fresh `init`-style project config does not provide a hardcoded model through `project.provider`; and disabled `security` / disabled `supervisor` do not require model resolution.

## Required changes

1. Update the analysis, design, and plan to include and remove the inline resolver fallback at [src/routing/resolver.ts](src/routing/resolver.ts#L135). Add a validation or test step that searches production source for remaining runtime model-default literals after the edit.

2. Rework the bootstrap design so `security` and `supervisor` model resolution only occurs when those subsystems are enabled. For disabled security, construct/register the disabled cop without resolving `security`; for disabled supervisor, do not construct/start a supervisor that requires a model.

3. Make the placeholder behavior executable: specify where the validator detects `"REPLACE-WITH-PROVIDER/MODEL"`, make that detection independent of ordinary slash parsing, and add a focused test for the error.

4. Account for CLI/project-config defaults. Either remove the hardcoded `provider` from `saivage init` and require operator-provided routing/runtime config, or explicitly justify and test why `project.provider` remains allowed without violating the F04 operator directive. The current Proposal A silently preserves a source-level model default through [src/server/cli.ts](src/server/cli.ts#L45).

## Strengths

- The core direction is right: deleting model defaults rather than centralising them matches the operator comment and the workspace no-backward-compatibility rule.
- The design correctly separates model identifiers from unrelated sizing constants and gives a reasonable boot-time validation UX target.
- The plan identifies the important existing tests and keeps fixture model literals out of scope, which should keep the implementation focused.

VERDICT: CHANGES_REQUESTED