# F19 Analysis r2 — provider barrel is incomplete and unused

## Changes from r1

- **Fixed the `ModelRouter` instantiation claim.** r1 said `ModelRouter` "instantiates all eight via deep imports" at [src/providers/router.ts](src/providers/router.ts#L9-L12). That is wrong on two counts: the cited lines are import statements, not instantiations, and the router does not construct eight concrete provider classes. Re-verified against [src/providers/router.ts](src/providers/router.ts#L9-L12) (imports) and the `createProvider` switch at [src/providers/router.ts](src/providers/router.ts#L726-L760): the router imports and constructs only `PiAiProvider`, `CopilotProvider`, `OllamaProvider`, and `LlamaCppProvider`. The older `AnthropicProvider` ([src/providers/anthropic.ts](src/providers/anthropic.ts)), `OpenAIProvider` ([src/providers/openai.ts](src/providers/openai.ts)), `OpenRouterProvider` ([src/providers/openrouter.ts](src/providers/openrouter.ts)), and `OpenAICodexProvider` ([src/providers/openai-codex.ts](src/providers/openai-codex.ts)) files exist in the folder but are not referenced by the router at all today.
- **Fixed the package/build-entry-point claims.** r1 said `package.json` `main`/`exports` point at `dist/index.js` and that the barrel causes `dist/providers/index.js` to be emitted. Re-verified [package.json](package.json#L1-L40): there is no `main`, no `exports`, no `types` field. The only published entry is the CLI bin `./dist/cli.js` ([package.json](package.json#L9-L11)). Re-verified [tsup.config.ts](tsup.config.ts#L1-L21): the single bundler entry is `src/server/cli.ts` ([tsup.config.ts](tsup.config.ts#L5)); there is no `src/index.ts` entry and no providers entry. Because nothing imports `src/providers/index.ts`, `tsup` does not pull it into the bundle and `dist/` contains no `providers/index.js`.
- **Tightened the "no importers" claim** with a broader grep recipe (now reflected in [03-plan-r2.md](03-plan-r2.md)) that covers static imports, re-exports, side-effect imports, and dynamic imports at arbitrary relative depth.
- **Reworded the consumer table** so it no longer implies the eight provider files share a single instantiation site. The drift it documents (barrel re-exports a 4-of-8 subset) is still real and is the subject of this issue.

## Problem restated

[src/providers/index.ts](src/providers/index.ts#L1-L7) is a 7-line barrel re-exporting `BaseProvider`, `ModelRouter`, eleven type names from `./types.js`, and four of the eight concrete provider classes (`AnthropicProvider`, `OpenAIProvider`, `OllamaProvider`, `OpenRouterProvider`). The remaining four sibling provider files (`PiAiProvider`, `CopilotProvider`, `OpenAICodexProvider`, `LlamaCppProvider`) are not re-exported.

The deeper finding is that the barrel has zero consumers anywhere in `src/` or `web/`. Tests live next to the code as `*.test.ts` under `src/`; there is no top-level `tests/` directory ([web/](web/) and `src/` are the only TypeScript trees). A workspace-wide search for static imports, re-exports, side-effect imports, and dynamic imports of `"../providers"`, `"./providers"`, `"providers/index"`, or deeper relative-path equivalents returns no hits. Every actual consumer imports the providers it needs by deep path (e.g. `"../providers/router.js"`, `"./types.js"`). The top-level `src/index.ts` does not re-export anything from `src/providers/` either — see [src/index.ts](src/index.ts#L70-L89), which only re-exports agents, runtime, and server symbols.

So F19 is two problems wearing one hat:

1. The barrel does not match the folder it claims to summarise (4 of 8 concrete providers omitted, and the barrel's chosen 4 do not match the 4 the router actually constructs).
2. The barrel is dead code regardless: nothing imports it.

## Actual differences

The exported subset is not a curated "public" surface — it is the set that happens to predate the four providers added later, and it is not even congruent with what the router uses. Comparing the barrel to the folder and to the router's `createProvider` switch:

| Provider class | File | Re-exported by barrel | Constructed by `ModelRouter.createProvider` |
| --- | --- | --- | --- |
| `BaseProvider` | [src/providers/base.ts](src/providers/base.ts) | yes | n/a (abstract) |
| `AnthropicProvider` | [src/providers/anthropic.ts](src/providers/anthropic.ts) | yes | no |
| `OpenAIProvider` | [src/providers/openai.ts](src/providers/openai.ts) | yes | no |
| `OllamaProvider` | [src/providers/ollama.ts](src/providers/ollama.ts) | yes | yes |
| `OpenRouterProvider` | [src/providers/openrouter.ts](src/providers/openrouter.ts) | yes | no |
| `PiAiProvider` | [src/providers/pi-ai.ts](src/providers/pi-ai.ts) | no | yes (for `anthropic`, `openai`, `openai-codex`, `opencode`, `opencode-go`) |
| `CopilotProvider` | [src/providers/copilot.ts](src/providers/copilot.ts) | no | yes |
| `OpenAICodexProvider` | [src/providers/openai-codex.ts](src/providers/openai-codex.ts) | no | no |
| `LlamaCppProvider` | [src/providers/llamacpp.ts](src/providers/llamacpp.ts) | no | yes |

The router switch is at [src/providers/router.ts](src/providers/router.ts#L726-L760); the router's import set is at [src/providers/router.ts](src/providers/router.ts#L9-L12). The barrel re-exports three classes the router never constructs (`AnthropicProvider`, `OpenAIProvider`, `OpenRouterProvider`) and omits three the router does construct (`PiAiProvider`, `CopilotProvider`, `LlamaCppProvider`). It is a stale snapshot.

## Contract

The barrel has no contract.

- [package.json](package.json#L1-L40) has no `main`, no `module`, no `exports`, and no `types` field. The package's only public entry is the CLI bin at [package.json](package.json#L9-L11).
- [tsup.config.ts](tsup.config.ts#L5) declares exactly one bundler entry: `src/server/cli.ts`. There is no `src/index.ts` or `src/providers/index.ts` entry.
- Because no consumer in `src/` or `web/` imports the barrel, `tsup`'s dependency graph does not pull `src/providers/index.ts` into `dist/`, and no `dist/providers/index.js` artifact is emitted today.
- The barrel has no JSDoc.

Its only effect today is to make TypeScript type-check the re-export list. It does not appear in the published artifact and is not referenced anywhere.

## Call sites & dependencies

- Direct importers of `src/providers/index.ts`: **none**. Verified by `rg` covering static imports (`from "...providers"` / `from "...providers/index"`), re-exports (`export ... from "...providers"`), side-effect imports (`import "...providers"`), and dynamic imports (`import("...providers")`) across `src/` and `web/`. The exact recipe is in [03-plan-r2.md](03-plan-r2.md).
- Importers of `src/providers/*.ts` by deep path:
  - [src/agents/types.ts](src/agents/types.ts#L16) — `ModelRouter` type.
  - [src/agents/base.ts](src/agents/base.ts#L14) — provider types.
  - [src/agents/agents.test.ts](src/agents/agents.test.ts#L19), [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L14), [src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts#L12) — provider types.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L3), [src/runtime/compaction.ts](src/runtime/compaction.ts#L7-L8), [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L8) — router and message types.
  - [src/server/bootstrap.ts](src/server/bootstrap.ts#L9) — `ModelRouter`.
  - [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L1-L2) — `ModelRouter`, `parseModelId`.
  - [src/providers/router.ts](src/providers/router.ts#L9-L12) — the four concrete provider classes the routing switch constructs.
  - Provider unit tests ([src/providers/router.test.ts](src/providers/router.test.ts#L1-L4), [src/providers/types.test.ts](src/providers/types.test.ts#L1-L2), [src/providers/copilot.test.ts](src/providers/copilot.test.ts#L1-L2), [src/providers/openai-codex.test.ts](src/providers/openai-codex.test.ts#L1-L2), [src/providers/responses-ids.test.ts](src/providers/responses-ids.test.ts#L1-L2)) import siblings by relative file.

No consumer reaches for a wildcard `import * from "../providers"`; the "anyone consuming `saivage` as a library" framing from the issue file is theoretical, because the package does not advertise a library entry point at all — only the CLI bin.

## Constraints any solution must respect

1. **Architecture-first, no backward compatibility** (project guideline 1): a "make the barrel match the folder" fix must not justify keeping the barrel if the barrel itself shouldn't exist. Conversely, if we delete it, we delete it cleanly — no temporary re-export, no `@deprecated` stub.
2. **No abstractions used only once** (project guideline 2): a barrel with zero importers is by definition unused.
3. **F13 cross-link** ([F13-base-agent-error-regex-brittle.md](../F13-base-agent-error-regex-brittle.md)): F13 proposes that providers normalise their errors into a typed enum (`{ kind: "context_overflow" | "throttling" | "non_retryable" | "transient", retryAfterMs? }`). The natural home for that type is [src/providers/types.ts](src/providers/types.ts). Whichever path we pick for F19, the choice should still let F13 land cleanly: a `ProviderErrorKind` type lives next to the other shared provider types and is consumed via the same import path consumers already use.
4. **F02 cross-link** ([F02-agent-roster-drift.md](../F02-agent-roster-drift.md)): F02 addresses the analogous drift between the agents folder and the role enum. Same disease, different folder — but the agents case has real consumers (dispatcher's role map, schema enums) so the comparison is not "do the same thing"; it is "make sure the chosen shape for providers is intentional and not an accident".
5. The four non-router-instantiated provider files (`anthropic.ts`, `openai.ts`, `openrouter.ts`, `openai-codex.ts`) contain TypeScript that must continue to compile. They each import from `./base.js` and `./types.js`, not from `./index.js` — verified — so removing the barrel cannot orphan their exports.
6. Out-of-scope: `src/skills/` is owned by another agent. F19 touches none of it.
