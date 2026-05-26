# G20 — Analysis r1

Round-2 finding: [G20-dead-concrete-provider-classes.md](../G20-dead-concrete-provider-classes.md).
Subsystem map: [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) (providers row).

## Functional analysis

The `ModelRouter` (constructed at boot in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts)) is the only production
consumer of the provider layer. Its registration loop in
[src/providers/router.ts](../../../../src/providers/router.ts#L99-L120) iterates a
hardcoded list of provider names and calls `createProvider`
([src/providers/router.ts](../../../../src/providers/router.ts#L741-L815)) for
each. For the four "cloud-LLM" branches (`anthropic`, `openai`,
`openai-codex`, `opencode`) the switch returns a `new PiAiProvider(<name>)`,
not the eponymous concrete class. The `github-copilot` branch returns
`CopilotProvider`. The `ollama` and `llamacpp` branches return
`OllamaProvider` / `LlamaCppProvider`. There is **no** branch that ever
constructs `AnthropicProvider`, `OpenAIProvider`, `OpenAICodexProvider`, or
`OpenRouterProvider` directly, and there is no `case "openrouter":` arm at
all — meaning the `openrouter` provider name is unreachable from the router
even though a class exists for it.

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
truly dead (router-uninstantiated and unreferenced outside their own
unit tests), while `OpenAIProvider` is router-uninstantiated **but**
still serves as the inheritance base for the live `OllamaProvider` and
`LlamaCppProvider` (which wrap the `openai` npm SDK against
OpenAI-compatible local endpoints). Removing `OpenAIProvider` therefore
requires either re-homing or replacing the local-LLM path; deleting the
other three is mechanical.

Because the router only ever returns `PiAiProvider` for the cloud
branches, the dead classes encode a parallel, divergent contract — their
own auth header conventions, retry/error semantics, and per-model
capability tables — that no production code exercises. Bug fixes landed
in `PiAiProvider` (e.g. F13 typed `ProviderError` classification, F20
per-model `ModelCapabilities`, F29 `piGetModel`/`piGetModels` helpers)
have not been mirrored into them. Their own unit tests therefore give
false coverage signal: green CI implies nothing about what the running
system does.

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
| [src/providers/openai.ts](../../../../src/providers/openai.ts) | 171 | [ollama.ts](../../../../src/providers/openai.ts#L1), [llamacpp.ts](../../../../src/providers/llamacpp.ts#L1), [openrouter.ts](../../../../src/providers/openrouter.ts#L1) |
| [src/providers/openai.test.ts](../../../../src/providers/openai.test.ts) | 36 | (test only) |
| **Subtotal** | **207** | |

Router sites that must be touched regardless of design choice:

- [src/providers/router.ts](../../../../src/providers/router.ts#L99-L120) — `knownProviders` list (cannot list `openrouter` since no createProvider branch handles it; verify finding).
- [src/providers/router.ts](../../../../src/providers/router.ts#L741-L815) — `createProvider` switch.
- [src/providers/router.ts](../../../../src/providers/router.ts#L768-L789) — `shouldRegisterProvider` switch (also enumerates provider names).
- [src/providers/router.ts](../../../../src/providers/router.ts#L897-L909) — `isProviderName` helper (fourth duplication of the provider-name list — overlaps G21).

Subsystem map row that must be updated:

- [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L75-L101) — Providers row currently lists the four dead files; revise to match the post-deletion state.

## Constraints from project guidelines

- **Architecture-first, no backward compatibility**: Do not preserve the
  dead classes as "alternative implementations" or "future hooks".
  Delete the files outright, delete their unit tests, and do not add
  re-export shims for hypothetical external importers (saivage v2 is not
  a published library; `src/providers/index.ts` was already removed in
  F19).
- **No over-engineering**: Do not invent a new abstraction layer just to
  rehome OpenAI-compatible HTTP code. Either keep `OpenAIProvider` as
  the existing concrete base (Design A) or replace the local-LLM path
  with the minimum code needed (Design B), but do not introduce a third
  hierarchy.
- **No docstrings/comments in untouched code**: Edits to `router.ts` are
  limited to the four sites above; do not opportunistically reformat or
  re-comment unrelated branches.
- **All file references as repo-relative markdown links with line numbers** —
  followed throughout this analysis.

## Open questions

1. **Is the `openrouter` provider intended to be revived?** The router
   has no `case "openrouter":` arm in `createProvider` or
   `shouldRegisterProvider`, and the [SaivageConfig](../../../../src/types.ts)
   provider list does not include it; the class has been unreachable
   since at least round-1. Assumption: it is abandoned and should be
   deleted.
2. **Should `openai.test.ts` survive in some form?** Its assertions
   exercise the OpenAI SDK adapter shape that `OllamaProvider` and
   `LlamaCppProvider` inherit. Options: (a) keep as-is (cheapest), (b)
   rename/repurpose into a parameterised "OpenAI-compatible base" test
   that covers all three subclasses, (c) delete and rely on the
   ollama/llamacpp tests. Recommendation defers to Design B if the file
   gets re-homed.
3. **Does any external operator config still set `providers.openrouter`
   or `models.<role>: "openrouter/..."`?** If yes, deletion will surface
   a missing-model error at boot rather than silently fail. This is the
   desired behaviour under the no-backward-compatibility rule, but the
   operator-facing CHANGELOG note must call it out.
4. **Cross-finding sequencing** — G21 (provider-name list quadruple
   duplication) edits three of the same `router.ts` sites. Decide
   whether G20 lands first (smaller, deletion-only) or both land in a
   single batch. Recommendation in the plan: G20 first, G21 immediately
   after on the reduced surface.
