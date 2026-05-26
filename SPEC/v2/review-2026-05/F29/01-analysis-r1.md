# F29 r1 — Analysis

## Problem restated

`PiAiProvider` is the runtime adapter that fronts five upstream providers (`anthropic`, `openai`, `openai-codex`, `opencode`, `opencode-go`) — wired in [src/providers/router.ts](src/providers/router.ts#L730-L750). Two distinct unsafe patterns coexist in the same file:

1. **Type-assertion soup.** Eight `as <Type>` casts in 290 lines bypass `tsc`'s checks on pi-ai's public types. Each one papers over a real impedance mismatch instead of either modelling it or failing fast.
2. **Silent model substitution.** When `resolveModel` can't find the requested model in pi-ai's catalogue, it clones a "sibling" model by stripping a trailing `[.-]<digits>` suffix, finds any model that begins with the stripped prefix, and forges a new `Model<Api>` with the user's requested ID. The forged model carries the sibling's `contextWindow`, pricing, capability flags, and API binding.

The synthesis path is reached for any operator typo or any model name pi-ai's catalogue is behind on — there is no diagnostic, no warning log, no metric. The cast pattern is what lets the synthesis path compile in the first place (the `as Model<Api>` on the cloned object).

## Actual cast inventory

Verified against the current file:

- [src/providers/pi-ai.ts#L82-L83](src/providers/pi-ai.ts#L82-L83) — `getModel`/`getModels` re-typed from their strict generic signatures (`<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>`) down to `(string, string) => Model<Api>`. This is necessary at the boundary because pi-ai's generics require statically-known literals, but Saivage's `modelSpec` is a runtime string.
- [src/providers/pi-ai.ts#L105](src/providers/pi-ai.ts#L105) — `{ ...sibling, id: modelId } as Model<Api>` (the synthesis cast).
- [src/providers/pi-ai.ts#L123](src/providers/pi-ai.ts#L123) — `{ ...model, compat: { ... } } as Model<Api>` (Kimi compat flag injection; `compat` is not on pi-ai's `Model` type).
- [src/providers/pi-ai.ts#L148](src/providers/pi-ai.ts#L148), [#L159](src/providers/pi-ai.ts#L159), [#L173](src/providers/pi-ai.ts#L173), [#L179](src/providers/pi-ai.ts#L179), [#L214](src/providers/pi-ai.ts#L214) — five conversion-output casts to `UserMessage` / `AssistantMessage` / `ToolResultMessage`. Each object literal in fact contains every required field; the cast hides nothing real, but it also means a future pi-ai breaking change (added required field, renamed field) compiles cleanly here.
- [src/providers/pi-ai.ts#L222](src/providers/pi-ai.ts#L222) — `t.inputSchema as Tool["parameters"]` (the tool-schema cast). pi-ai's `Tool.parameters` is a `typebox` `TSchema`, while Saivage's `ToolSchema.inputSchema` is a JSON-schema-shaped `Record<string, unknown>`. This is the only cast that hides a real semantic mismatch: pi-ai expects a typebox schema with `Static<>` inference, Saivage hands it a hand-written JSON schema. pi-ai providers happen to serialize `parameters` as JSON without consulting typebox metadata, so it works at runtime, but the types lie.

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
- No `*.test.ts` covers `pi-ai.ts`. The provider tests file is [src/providers/types.test.ts](src/providers/types.test.ts) and the router test [src/providers/router.test.ts](src/providers/router.test.ts); neither imports `PiAiProvider`.

## Constraints any solution must respect

1. **The boundary cast is irreducible.** `getModel`/`getModels` use compile-time-only generic constraints that cannot accept a runtime string. Any solution will need exactly one place that erases those generics. That place must be small, named, and the only such location in the file.
2. **The Kimi compat field is real.** pi-ai's `Model` type does not declare `compat` but pi-ai's openai-completions provider reads it (`requiresReasoningContentOnAssistantMessages`). The fix must keep injecting that field; it cannot just remove the cast.
3. **The Saivage `ToolSchema` → pi-ai `Tool.parameters` impedance mismatch is real.** Either Saivage's tool schemas migrate to typebox (out of scope here, large) or the conversion declares it bridges JSON-schema-shaped values into a structurally-compatible position. A typed conversion that explicitly returns `unknown as TSchema` at one named line is acceptable; nine ambient `as` casts spread across the file are not.
4. **No backward compatibility for the synthesis path.** Per project rule (1), the cloned-sibling fall-through must be deleted outright, not behind a flag. Operators with bad `modelSpec` strings must fail loudly on first use.
5. **Errors thrown here are consumed by BaseAgent's regex classifier today.** F13 will eventually replace that with typed errors. The fix should throw an error shape that is forward-compatible with F13's `{ kind: "non_retryable", reason: "unknown_model" }` discriminant, so F13's later work doesn't need to re-touch this file.
6. **Out of scope:** `src/skills/`, memory subsystem.
