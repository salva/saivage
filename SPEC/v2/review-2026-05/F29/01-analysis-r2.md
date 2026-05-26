# F29 r2 — Analysis

## Changes from r1

- **Compat claim corrected.** r1 said `compat` is not on pi-ai's `Model` type. Verified against the installed `@mariozechner/pi-ai@^0.73.1` ([package.json#L21](package.json#L21)): `Model<TApi>.compat?` is declared in [node_modules/@mariozechner/pi-ai/dist/types.d.ts#L380-L403](node_modules/@mariozechner/pi-ai/dist/types.d.ts#L380-L403), and `requiresReasoningContentOnAssistantMessages` is part of `OpenAICompletionsCompat` at [node_modules/@mariozechner/pi-ai/dist/types.d.ts#L260-L263](node_modules/@mariozechner/pi-ai/dist/types.d.ts#L260-L263). The real impedance is that `compat` is a conditional union keyed on `TApi`: `TApi extends "openai-completions" ? OpenAICompletionsCompat : ... : never`. With `TApi = Api` (the union), the conditional may not auto-narrow per branch, so writing `compat: { requiresReasoningContentOnAssistantMessages: true }` against `Model<Api>` is ill-typed against the `never` branch. This is a "narrow on `model.api` discriminant" problem, not a "missing property" problem.
- **Cast inventory completed.** r1 listed eight casts but missed three. The full body inventory now lists 11 sites (excluding the L20 import alias `Message as PiMessage`, which is not a cast).
- **Acceptance check rewritten.** r1's `grep -c " as "` was unreliable (matched the import alias and a prose word). r2 replaces it with two targeted greps that name the allowed boundaries.

## Problem restated

`PiAiProvider` is the runtime adapter that fronts five upstream providers (`anthropic`, `openai`, `openai-codex`, `opencode`, `opencode-go`) — wired in [src/providers/router.ts](src/providers/router.ts#L730-L750). Two distinct unsafe patterns coexist in the same file:

1. **Type-assertion soup.** Eleven `as <Type>` casts in 290 lines bypass `tsc`'s checks on pi-ai's public types. Each one papers over a real impedance mismatch instead of either modelling it or failing fast.
2. **Silent model substitution.** When `resolveModel` can't find the requested model in pi-ai's catalogue, it clones a "sibling" model by stripping a trailing `[.-]<digits>` suffix, finds any model that begins with the stripped prefix, and forges a new `Model<Api>` with the user's requested ID. The forged model carries the sibling's `contextWindow`, pricing, capability flags, and API binding.

The synthesis path is reached for any operator typo or any model name pi-ai's catalogue is behind on — there is no diagnostic, no warning log, no metric. The cast pattern is what lets the synthesis path compile in the first place (the `as Model<Api>` on the cloned object).

## Actual cast inventory

Verified against the current file via `grep -n " as " src/providers/pi-ai.ts`. The L20 hit `Message as PiMessage` is an import alias, not a type assertion; excluded. The L115 hit is the word "as" in a prose comment ("but as of 0.73.0"); excluded. The remaining 11 are real assertions:

| Line | Site | Category | r2 disposition |
| --- | --- | --- | --- |
| [82](src/providers/pi-ai.ts#L82) | `getModel as (provider: string, modelId: string) => Model<Api> \| undefined` | Boundary (runtime string vs generic constraint) | Move to `pi-ai-types.ts` as `piGetModel` |
| [83](src/providers/pi-ai.ts#L83) | `getModels as (provider: string) => Model<Api>[]` | Boundary | Move to `pi-ai-types.ts` as `piGetModels` |
| [105](src/providers/pi-ai.ts#L105) | `{ ...sibling, id: modelId } as Model<Api>` | Synthesis | **Deleted with the synthesis block** |
| [120](src/providers/pi-ai.ts#L120) | `model.compat as Record<string, unknown> \| undefined` | Conditional-compat union | Replaced via discriminant narrowing on `model.api === "openai-completions"` |
| [123](src/providers/pi-ai.ts#L123) | `{ ...model, compat: { ... } } as Model<Api>` | Conditional-compat union | Same as L120 — return value of the narrowed branch is structurally `Model<"openai-completions">`, assignable to `Model<Api>` without `as` |
| [148](src/providers/pi-ai.ts#L148) | `{ ...literal } as UserMessage` | Output conversion | Replaced by `userMsg(): UserMessage` factory; literal checked against return type |
| [159](src/providers/pi-ai.ts#L159) | `{ ...literal } as AssistantMessage` | Output conversion | Replaced by `assistantMsg(): AssistantMessage` factory |
| [162](src/providers/pi-ai.ts#L162) | `m.content as ContentBlock[]` | Redundant — TS already narrows `string \| ContentBlock[]` in the `else` of a `typeof === "string"` guard | **Removed; relies on TS narrowing** |
| [173](src/providers/pi-ai.ts#L173) | `{ ...literal } as ToolResultMessage` | Output conversion | Replaced by `toolResultMsg(): ToolResultMessage` factory |
| [179](src/providers/pi-ai.ts#L179) | `{ ...literal } as UserMessage` | Output conversion | Replaced by `userMsg(): UserMessage` factory |
| [201](src/providers/pi-ai.ts#L201) | `b.input as Record<string, unknown>` | Source-type bridge: Saivage's `ContentBlock.input: unknown` ([src/providers/types.ts#L15](src/providers/types.ts#L15)) is intentionally permissive across providers; pi-ai's `ToolCall.arguments` is `Record<string, unknown>` | **One labelled bridge cast** (kept with a 2-line comment that names it as the second documented boundary) |
| [214](src/providers/pi-ai.ts#L214) | `{ ...literal } as AssistantMessage` | Output conversion | Replaced by `assistantMsg(): AssistantMessage` factory |
| [222](src/providers/pi-ai.ts#L222) | `t.inputSchema as Tool["parameters"]` | Schema-shape bridge: Saivage hand-writes JSON Schema; pi-ai types `Tool.parameters` as a typebox `TSchema` | **One labelled bridge cast** (the original `as` becomes `as unknown as` with a 2-line comment) |
| [281](src/providers/pi-ai.ts#L281) | `getModels as (provider: string) => Model<Api>[]` | Boundary duplicate of L83 | Replaced by `piGetModels` from `pi-ai-types.ts` |

After the cleanup the only `as` assertions remaining in the file body are the two labelled bridges at L201 and L222.

## The synthesis path in detail

```ts
const prefix = modelId.replace(/[.\-][\d]+$/, "");
const sibling = models.find((m) => m.id.startsWith(prefix));
if (sibling) {
  return this.withProviderCompat({ ...sibling, id: modelId } as Model<Api>);
}
```

Behaviour observed by reading the code:

- `"kimi-k2.6"` (typo or new release) → strips to `"kimi-k2"`, finds `"kimi-k2-0905"` or any other model starting with `kimi-k2`, returns a copy renamed `"kimi-k2.6"`.
- `"gpt-5-typo-9"` → strips to `"gpt-5-typo"`, no sibling starts with that, returns `undefined` (good).
- `"gpt-4o-foo-1"` → strips to `"gpt-4o-foo"`, no match — but `"gpt-foo"` etc. could collide depending on alphabetical ordering of the registry.
- Critically: the forged model carries the **sibling's** `contextWindow`, `cost`, and `api` binding. Saivage then feeds that `contextWindow` into the compaction threshold (see F20) and pricing into telemetry. So a `kimi-k2.7` typo doesn't just talk to a different model than the operator intended — it also reports incorrect token budget and incorrect cost numbers.

The catalogue is real: `claude-sonnet-4-20250514` is in [node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L1942-L1958](node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L1942-L1958), and `kimi-k2.5` / `kimi-k2.6` exist for opencode at [node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L8788-L8819](node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L8788-L8819) and [node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L9016-L9047](node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L9016-L9047). pi-ai's runtime `getModel` returns `undefined` for unknown IDs ([node_modules/@mariozechner/pi-ai/dist/models.js#L11-L14](node_modules/@mariozechner/pi-ai/dist/models.js#L11-L14)), despite the stricter declaration in [node_modules/@mariozechner/pi-ai/dist/models.d.ts#L4-L8](node_modules/@mariozechner/pi-ai/dist/models.d.ts#L4-L8). So failing fast on unknown IDs is sound at the boundary.

## Contract

Stated contract of `resolveModel(modelId: string): Model<Api> | undefined`:

- Input: a model ID string from operator config.
- Output: the pi-ai `Model<Api>` whose registry entry matches that ID, or `undefined` if not found.
- The current implementation breaks the second clause by sometimes inventing a return value.

Stated contract of `chat`:

- Throws `Error("Model \"...\" not found ...")` when `resolveModel` returns `undefined`. That `throw new Error(string)` is the kind of message-only error that F13 critiques (BaseAgent's regex classifier then sees the string).

## Call sites & dependencies

- `router.ts` constructs five `PiAiProvider` instances ([src/providers/router.ts](src/providers/router.ts#L728-L751)) and registers them under provider keys `anthropic`, `openai`, `openai-codex`, `opencode`, `opencode-go`. All five of Saivage's first-class cloud providers run through pi-ai today.
- `PiAiProvider` is not in the provider barrel [src/providers/index.ts](src/providers/index.ts#L1-L7) — see F19. Library consumers must deep-import.
- `maxContextTokens(model)` ([src/providers/pi-ai.ts#L271-L274](src/providers/pi-ai.ts#L271-L274)) is the only `maxContextTokens` in the codebase that does the right thing (reads `model.contextWindow`) — and the synthesis path corrupts it. See F20.
- `ContentBlock.input: unknown` is consumed broadly: [src/providers/anthropic.ts#L57](src/providers/anthropic.ts#L57), [src/providers/anthropic.ts#L83](src/providers/anthropic.ts#L83), [src/providers/copilot.ts#L431](src/providers/copilot.ts#L431), [src/providers/copilot.ts#L452](src/providers/copilot.ts#L452), [src/agents/base.ts#L306](src/agents/base.ts#L306), [src/agents/base.ts#L788](src/agents/base.ts#L788). Tightening `ContentBlock.input` from `unknown` to `Record<string, unknown>` to remove the L201 cast would ripple across six unrelated sites; that is out of scope for F29. Keeping L201 as one labelled bridge is the proportionate fix.
- No `*.test.ts` covers `pi-ai.ts`. The provider tests file is [src/providers/types.test.ts](src/providers/types.test.ts) and the router test [src/providers/router.test.ts](src/providers/router.test.ts); neither imports `PiAiProvider`.

## Constraints any solution must respect

1. **The boundary cast is irreducible.** `getModel`/`getModels` use compile-time-only generic constraints that cannot accept a runtime string. Any solution will need exactly one place that erases those generics. That place must be small, named, and the only such location in the file.
2. **The Kimi compat field is real and already typed by pi-ai.** OpenCode Kimi serves via `api === "openai-completions"`; `Model<"openai-completions">["compat"]` is `OpenAICompletionsCompat`, which already declares `requiresReasoningContentOnAssistantMessages`. The fix must keep injecting that field; the right shape is to narrow on the `model.api` discriminant rather than carry a local `PiAiModelWithCompat` intersection.
3. **The Saivage `ToolSchema` → pi-ai `Tool.parameters` impedance mismatch is real.** pi-ai types `Tool.parameters` as a typebox `TSchema`, Saivage hands it a JSON Schema object. pi-ai providers serialize `parameters` as JSON without consulting typebox metadata, so the runtime is sound, but the static types cannot match without migrating Saivage tool schemas to typebox (large, out of scope). A single labelled `as unknown as` at the conversion boundary is acceptable.
4. **The Saivage `ContentBlock.input → pi-ai ToolCall.arguments` impedance is real.** `ContentBlock.input` is `unknown` by design (provider-agnostic). pi-ai's `ToolCall.arguments` is `Record<string, unknown>`. A single labelled cast at the conversion boundary is acceptable; tightening `ContentBlock.input` is out of scope.
5. **No backward compatibility for the synthesis path.** Per project rule (1), the cloned-sibling fall-through must be deleted outright, not behind a flag. Operators with bad `modelSpec` strings must fail loudly on first use.
6. **Errors thrown here are consumed by BaseAgent's regex classifier today.** F13 will eventually replace that with typed errors. The fix should throw an error shape that is forward-compatible with F13's `{ kind: "non_retryable", reason: "unknown_model" }` discriminant, so F13's later work doesn't need to re-touch this file.
7. **Out of scope:** `src/skills/`, memory subsystem.
