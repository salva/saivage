# G20 — Analysis r2

Round-2 finding: [G20-dead-concrete-provider-classes.md](../G20-dead-concrete-provider-classes.md).
Subsystem map: [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) (providers row).

Revises [01-analysis-r1.md](01-analysis-r1.md) in response to
[04-review-r1.md](04-review-r1.md) finding 1 (missed
`model-capabilities.test.ts`) and finding 5 (stale `openrouter`
vocabulary in `types.test.ts`).

## Functional analysis

The `ModelRouter` (constructed at boot in
[src/server/bootstrap.ts](../../../../src/server/bootstrap.ts)) is the
only production consumer of the provider layer. Its registration loop in
[src/providers/router.ts](../../../../src/providers/router.ts#L99-L120)
iterates a hardcoded list of provider names and calls `createProvider`
([src/providers/router.ts](../../../../src/providers/router.ts#L741-L815))
for each. For the four "cloud-LLM" branches (`anthropic`, `openai`,
`openai-codex`, `opencode`) the switch returns a
`new PiAiProvider(<name>)`, not the eponymous concrete class. The
`github-copilot` branch returns `CopilotProvider`. The `ollama` and
`llamacpp` branches return `OllamaProvider` / `LlamaCppProvider`. There
is **no** branch that ever constructs `AnthropicProvider`,
`OpenAIProvider`, `OpenAICodexProvider`, or `OpenRouterProvider`
directly, and there is no `case "openrouter":` arm at all — meaning the
`openrouter` provider name is unreachable from the router even though a
class exists for it.

Cross-checking the import graph confirms the dead status of three of the
four classes. A grep over `src/` excluding `*.test.ts` returns only:

- [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L1) and
  [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L1)
  import `OpenAIProvider` to use as a **base class** for inheritance.
- [src/providers/openrouter.ts](../../../../src/providers/openrouter.ts#L1)
  also extends `OpenAIProvider`, but `OpenRouterProvider` itself has no
  production importer.
- `AnthropicProvider`, `OpenAICodexProvider`, and `OpenRouterProvider`
  have **zero non-test importers**.

This refines the finding: of the four classes the finding lists,
`AnthropicProvider`, `OpenAICodexProvider`, and `OpenRouterProvider` are
truly dead (router-uninstantiated and unreferenced outside test code),
while `OpenAIProvider` is router-uninstantiated **but** still serves as
the inheritance base for the live `OllamaProvider` and `LlamaCppProvider`
(which wrap the `openai` npm SDK against OpenAI-compatible local
endpoints). Removing `OpenAIProvider` therefore requires either
re-homing or replacing the local-LLM path; deleting the other three is
mechanical.

Because the router only ever returns `PiAiProvider` for the cloud
branches, the dead classes encode a parallel, divergent contract — their
own auth header conventions, retry/error semantics, and per-model
capability tables — that no production code exercises. Bug fixes landed
in `PiAiProvider` (e.g. F13 typed `ProviderError` classification, F20
per-model `ModelCapabilities`, F29 `piGetModel`/`piGetModels` helpers)
have not been mirrored into them. Their own unit tests therefore give
false coverage signal: green CI implies nothing about what the running
system does.

### Test-suite consumers of the dead classes (r2 correction)

Per [04-review-r1.md](04-review-r1.md) finding 1, the test corpus
imports and constructs the dead classes in more than the three
per-class files originally listed:

- [src/providers/anthropic.test.ts](../../../../src/providers/anthropic.test.ts) — single-class suite for `AnthropicProvider`.
- [src/providers/openai-codex.test.ts](../../../../src/providers/openai-codex.test.ts) — single-class suite for `OpenAICodexProvider`.
- [src/providers/openrouter.test.ts](../../../../src/providers/openrouter.test.ts) — single-class suite for `OpenRouterProvider`.
- [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L3-L6)
  imports `OpenAIProvider`, `OpenAICodexProvider`, `AnthropicProvider`,
  and `OpenRouterProvider`, and constructs the three deleted classes in
  the "per-provider direct-class tables" suite at
  [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L43-L93).
  This file is dual-purpose: the same file also contains a live
  `PiAiProvider` registry suite at
  [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L117-L156),
  a live `OllamaProvider`/`LlamaCppProvider`
  `defaultContextWindow` suite at
  [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L95-L114),
  and a live `ModelRouter.getMaxContextTokens` suite at
  [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L158-L200).
  Deleting the file outright would discard live coverage; only the
  direct-class `it` blocks for the three deleted classes (and their
  four import lines) must be removed. The `OpenAIProvider` direct-class
  `it` block stays because the class stays.

No other `src/**/*.test.ts` file constructs the three deleted classes.
The exhaustive search (`new AnthropicProvider|new OpenAICodexProvider|new OpenRouterProvider`
across `src/`) returns hits only in
[src/providers/anthropic.test.ts](../../../../src/providers/anthropic.test.ts),
[src/providers/openai-codex.test.ts](../../../../src/providers/openai-codex.test.ts),
[src/providers/openrouter.test.ts](../../../../src/providers/openrouter.test.ts),
and the four-construction block in
[src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L43-L93).

### Stale `openrouter` vocabulary in active tests (r2 addition)

Per [04-review-r1.md](04-review-r1.md) finding 5,
[src/providers/types.test.ts](../../../../src/providers/types.test.ts#L11-L13)
uses `openrouter/meta-llama/llama-3.3-70b` as the example string for
the "nested model IDs" case in `parseModelId`. `parseModelId` is a
generic provider-agnostic parser at
[src/providers/types.ts](../../../../src/providers/types.ts) — it does
not validate provider names against the router registry, and the test
only asserts that the first `/` splits provider from model. The test
is therefore still functionally correct after the deletion. However, if
G20's operator-facing signal is "`openrouter` is unsupported and should
fail loudly," continuing to name `openrouter` as the canonical
nested-model example is contradictory documentation. The
recommendation in [02-design-r2.md](02-design-r2.md) is to swap the
example string for a live nested-model provider name (the only live
provider name today that emits nested model IDs is the local-LLM path
via `ollama/<vendor>/<model>` in some operator configs, or the
PiAi-routed cloud paths with vendor-prefixed model strings). The
parser remains provider-agnostic; only the example literal changes.

## Affected code

Truly dead (router-uninstantiated and zero non-test importers):

| File | LOC | Imported by (non-test) |
|---|---|---|
| [src/providers/anthropic.ts](../../../../src/providers/anthropic.ts) | 135 | (none) |
| [src/providers/anthropic.test.ts](../../../../src/providers/anthropic.test.ts) | 37 | (test only) |
| [src/providers/openai-codex.ts](../../../../src/providers/openai-codex.ts) | 410 | (none) |
| [src/providers/openai-codex.test.ts](../../../../src/providers/openai-codex.test.ts) | 48 | (test only) |
| [src/providers/openrouter.ts](../../../../src/providers/openrouter.ts) | 35 | (none — extends `OpenAIProvider`) |
| [src/providers/openrouter.test.ts](../../../../src/providers/openrouter.test.ts) | 38 | (test only) |
| **Subtotal** | **703** | |

Conditionally dead (router-uninstantiated but used as inheritance base):

| File | LOC | Imported by (non-test) |
|---|---|---|
| [src/providers/openai.ts](../../../../src/providers/openai.ts) | 171 | [ollama.ts](../../../../src/providers/ollama.ts#L1), [llamacpp.ts](../../../../src/providers/llamacpp.ts#L1), [openrouter.ts](../../../../src/providers/openrouter.ts#L1) (openrouter goes away with the deletion above) |
| [src/providers/openai.test.ts](../../../../src/providers/openai.test.ts) | 36 | (test only) |
| **Subtotal** | **207** | |

Tests that must be edited (not deleted) to stop importing the dead classes:

| File | Edit |
|---|---|
| [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts) | Remove imports of `OpenAICodexProvider`, `AnthropicProvider`, `OpenRouterProvider` ([L4-L6](../../../../src/providers/model-capabilities.test.ts#L4-L6)). Remove the three `it` blocks that construct them at [L53-L60](../../../../src/providers/model-capabilities.test.ts#L53-L60), [L62-L76](../../../../src/providers/model-capabilities.test.ts#L62-L76), and [L78-L93](../../../../src/providers/model-capabilities.test.ts#L78-L93). Keep the `OpenAIProvider` direct-class `it` at [L44-L51](../../../../src/providers/model-capabilities.test.ts#L44-L51) and the `PiAiProvider` / local-LLM / router suites. The live coverage the deleted `it` blocks gave for cloud-LLM capability lookups is already provided by the `PiAiProvider` registry suite at [L117-L156](../../../../src/providers/model-capabilities.test.ts#L117-L156). |
| [src/providers/types.test.ts](../../../../src/providers/types.test.ts#L11-L13) | Replace the `openrouter/meta-llama/llama-3.3-70b` example with a live nested-provider example (e.g. `ollama/library/llama3.3:70b`) so the active test corpus stops naming the deleted provider. |

Router sites that must be touched regardless of design choice:

- [src/providers/router.ts](../../../../src/providers/router.ts#L99-L120) — `knownProviders` list (cannot list `openrouter` since no `createProvider` branch handles it; verify finding).
- [src/providers/router.ts](../../../../src/providers/router.ts#L741-L815) — `createProvider` switch.
- [src/providers/router.ts](../../../../src/providers/router.ts#L768-L789) — `shouldRegisterProvider` switch (also enumerates provider names).
- [src/providers/router.ts](../../../../src/providers/router.ts#L897-L909) — `isProviderName` helper (fourth duplication of the provider-name list — overlaps G21).

Subsystem map row that must be updated:

- [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L75-L101) — Providers row currently lists the four dead files; revise to match the post-deletion state.

## Constraints from project guidelines

- **Architecture-first, no backward compatibility**: Do not preserve the
  dead classes as "alternative implementations" or "future hooks".
  Delete the files outright, delete or surgically prune their unit
  tests, and do not add re-export shims for hypothetical external
  importers (saivage v2 is not a published library;
  `src/providers/index.ts` was already removed in F19).
- **No over-engineering**: Do not invent a new abstraction layer just
  to rehome OpenAI-compatible HTTP code. Either keep `OpenAIProvider`
  as the existing concrete base (Design A) or rename/fold it (Design
  B), but do not introduce a third hierarchy.
- **No docstrings/comments in untouched code**: Edits to `router.ts`
  are limited to the four sites above and the test surgery is limited
  to the lines listed.
- **All file references as repo-relative markdown links with line
  numbers** — followed throughout.

## Open questions

1. **Is the `openrouter` provider intended to be revived?** The router
   has no `case "openrouter":` arm in `createProvider` or
   `shouldRegisterProvider`, and the [SaivageConfig](../../../../src/types.ts)
   provider list does not include it; the class has been unreachable
   since at least round-1. Assumption: it is abandoned and should be
   deleted, and any operator config naming it should fail loudly at
   boot.
2. **Does any external operator config still set `providers.openrouter`
   or `models.<role>: "openrouter/..."`?** If yes, deletion will
   surface a missing-model error at boot rather than silently fail.
   This is the desired behaviour under the no-backward-compatibility
   rule; the operator-facing CHANGELOG entry calls it out.
3. **Cross-finding sequencing** — G21 (provider-name list quadruple
   duplication) edits three of the same `router.ts` sites. Decide
   whether G20 lands first (smaller, deletion-only) or both land in a
   single batch. Recommendation in [03-plan-r2.md](03-plan-r2.md): G20
   first, G21 immediately after on the reduced surface.
4. **Follow-up acceptance criterion for the level-up.** Per
   [04-review-r1.md](04-review-r1.md) finding 3, G20 is now explicitly
   scoped to dead-code deletion only and a concrete follow-up
   acceptance criterion for renaming/folding `OpenAIProvider` is
   recorded in [02-design-r2.md](02-design-r2.md) and
   [03-plan-r2.md](03-plan-r2.md). The level-up path is no longer an
   indefinite "nice later" note.
