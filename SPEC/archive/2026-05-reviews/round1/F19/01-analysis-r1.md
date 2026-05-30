# F19 Analysis — provider barrel is incomplete and unused

## Problem restated

`src/providers/index.ts` is a 7-line barrel that re-exports a hand-picked subset of the providers folder. It exports `BaseProvider`, `ModelRouter`, eleven names from `./types.js`, and four of the eight concrete provider classes (`AnthropicProvider`, `OpenAIProvider`, `OllamaProvider`, `OpenRouterProvider`). The remaining four (`PiAiProvider`, `CopilotProvider`, `OpenAICodexProvider`, `LlamaCppProvider`) exist as sibling files but are not re-exported. See [src/providers/index.ts](src/providers/index.ts#L1-L7).

The deeper finding (uncovered while writing this analysis) is that the barrel has zero consumers anywhere in `src/`, `web/`, or `tests/`. A workspace-wide search for imports of `"../providers"`, `"./providers"`, or `"providers/index"` returns no hits. Every actual consumer imports the providers it needs by deep path (e.g. `"../providers/router.js"`, `"./types.js"`). The top-level barrel `src/index.ts` does not re-export anything from `src/providers/` either — see [src/index.ts](src/index.ts#L70-L89), which only re-exports agents, runtime, and server symbols.

So F19 is two problems wearing one hat:

1. The barrel does not match the folder it claims to summarise (4 of 8 concrete providers omitted).
2. The barrel is dead code regardless: nothing imports it.

## Actual differences

The exported subset is not a curated "public" surface — it is the set that happens to predate the four providers added later (Pi.ai, Copilot, OpenAI Codex, llama.cpp). Comparing the barrel to the folder:

| Provider class | File | Re-exported by barrel |
| --- | --- | --- |
| `BaseProvider` | [src/providers/base.ts](src/providers/base.ts) | yes |
| `AnthropicProvider` | [src/providers/anthropic.ts](src/providers/anthropic.ts) | yes |
| `OpenAIProvider` | [src/providers/openai.ts](src/providers/openai.ts) | yes |
| `OllamaProvider` | [src/providers/ollama.ts](src/providers/ollama.ts) | yes |
| `OpenRouterProvider` | [src/providers/openrouter.ts](src/providers/openrouter.ts) | yes |
| `PiAiProvider` | [src/providers/pi-ai.ts](src/providers/pi-ai.ts) | no |
| `CopilotProvider` | [src/providers/copilot.ts](src/providers/copilot.ts) | no |
| `OpenAICodexProvider` | [src/providers/openai-codex.ts](src/providers/openai-codex.ts) | no |
| `LlamaCppProvider` | [src/providers/llamacpp.ts](src/providers/llamacpp.ts) | no |

`ModelRouter` itself instantiates all eight via deep imports — see [src/providers/router.ts](src/providers/router.ts#L9-L12) — confirming the omission is not intentional gatekeeping but neglect.

## Contract

The barrel has no contract. It is not referenced by any `package.json` `exports` field (the package `main`/`exports` point at `dist/index.js`, which comes from `src/index.ts`), it has no JSDoc, and `tsup.config.ts` does not single it out as an entry point. Its only effect today is to make TypeScript compile and emit a `dist/providers/index.js` no consumer loads.

## Call sites & dependencies

- Direct importers of `src/providers/index.ts`: **none** (verified by grep across `src/`, `web/`, `tests/`).
- Importers of `src/providers/*.ts` by deep path:
  - [src/agents/types.ts](src/agents/types.ts#L16) — `ModelRouter` type.
  - [src/agents/base.ts](src/agents/base.ts#L14) — provider types.
  - [src/agents/agents.test.ts](src/agents/agents.test.ts#L19), [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L14), [src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts#L12) — provider types.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L3), [src/runtime/compaction.ts](src/runtime/compaction.ts#L7-L8), [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L8) — router and message types.
  - [src/server/bootstrap.ts](src/server/bootstrap.ts#L9) — `ModelRouter`.
  - [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L1-L2) — `ModelRouter`, `parseModelId`.
  - [src/providers/router.ts](src/providers/router.ts#L9-L12) — concrete provider classes for the routing table.
  - Provider unit tests ([src/providers/router.test.ts](src/providers/router.test.ts#L1-L4), [src/providers/types.test.ts](src/providers/types.test.ts#L1-L2), [src/providers/copilot.test.ts](src/providers/copilot.test.ts#L1-L2), [src/providers/openai-codex.test.ts](src/providers/openai-codex.test.ts#L1-L2), [src/providers/responses-ids.test.ts](src/providers/responses-ids.test.ts#L1-L2)) import siblings by relative file.

No consumer reaches for a wildcard `import * from "../providers"`; the public-API claim from the issue file ("anyone consuming `saivage` as a library") is theoretical — there is no library consumer today, and the top-level `src/index.ts` chose not to re-export providers at all (probably intentionally, given that provider construction is the router's job).

## Constraints any solution must respect

1. **Architecture-first, no backward compatibility** (project guideline 1): a "make the barrel match the folder" fix must not justify keeping the barrel if the barrel itself shouldn't exist. Conversely, if we delete it, we delete it cleanly — no temporary re-export, no `@deprecated` stub.
2. **No abstractions used only once** (project guideline 2): a barrel with zero importers is by definition unused.
3. **F13 cross-link** ([F13-base-agent-error-regex-brittle.md](../F13-base-agent-error-regex-brittle.md)): F13 proposes that providers normalise their errors into a typed enum (`{ kind: "context_overflow" | "throttling" | "non_retryable" | "transient", retryAfterMs? }`). The natural home for that type is [src/providers/types.ts](src/providers/types.ts). Whichever path we pick for F19, the choice should still let F13 land cleanly: a `ProviderErrorKind` type lives next to the other shared provider types and is consumed via the same import path consumers already use.
4. **F02 cross-link** ([F02-agent-roster-drift.md](../F02-agent-roster-drift.md)): F02 addresses the analogous drift between the agents folder and the role enum. Same disease, different folder — but the agents case has real consumers (dispatcher's role map, schema enums) so the comparison is not "do the same thing"; it is "make sure the chosen shape for providers is intentional and not an accident".
5. The four omitted provider files contain TypeScript that must continue to compile. Removing the barrel must not orphan exports they rely on (they import from `./base.js` and `./types.js`, not from `./index.js`, so this is satisfied today — verified by reading [src/providers/router.ts](src/providers/router.ts#L9-L12) imports).
6. Out-of-scope: `src/skills/` is owned by another agent. F19 touches none of it.
