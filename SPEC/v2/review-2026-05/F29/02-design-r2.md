# F29 r2 — Design

## Changes from r1

- **Removed `PiAiModelWithCompat` helper type.** It was introduced in r1 on the false premise that `Model<Api>.compat` is missing. The dependency already declares `compat?` ([node_modules/@mariozechner/pi-ai/dist/types.d.ts#L380-L403](node_modules/@mariozechner/pi-ai/dist/types.d.ts#L380-L403)); the real problem is the conditional union keyed on `TApi`. r2 narrows on the `model.api` discriminant instead, which produces correctly-typed `compat` without any local helper type and without any `as` cast on the spread.
- **Two named bridge casts instead of one.** r1 implicitly understated the body inventory by missing [src/providers/pi-ai.ts#L162](src/providers/pi-ai.ts#L162), [#L201](src/providers/pi-ai.ts#L201), and [#L281](src/providers/pi-ai.ts#L281). L162 dies via TS narrowing, L281 is replaced by `piGetModels`, and L201 stays as a second labelled boundary alongside the L222 tool-parameters bridge. Both surviving casts now carry the same 2-line comment template that names them as the only allowed body assertions.
- **Acceptance check is now two targeted greps**, not a count of the string ` as `.

Two proposals. Proposal A targets just the unsafe patterns called out in the finding. Proposal B treats `pi-ai.ts` as the place where the broader provider-adapter contract should crystallise, anticipating F13/F19/F20.

## Proposal A — Focused: kill the synthesis path, isolate the boundary cast, type the conversions

### Scope

Single file modified: [src/providers/pi-ai.ts](src/providers/pi-ai.ts). One new helper file: [src/providers/pi-ai-types.ts](src/providers/pi-ai-types.ts) (about 30 lines, no `PiAiModelWithCompat`).

### What gets added

1. `src/providers/pi-ai-types.ts`: declares the single allowed boundary erasure as two named exports plus the structured error class. Shape:

   ```ts
   import { getModel, getModels, type Model, type Api } from "@mariozechner/pi-ai";

   // The one and only place where pi-ai's compile-time generic constraint
   // is erased. Runtime strings come from operator config.
   export const piGetModel = getModel as unknown as
     (provider: string, modelId: string) => Model<Api> | undefined;
   export const piGetModels = getModels as unknown as
     (provider: string) => Model<Api>[];

   export class UnknownModelError extends Error {
     readonly kind = "unknown_model" as const;
     constructor(
       readonly piProvider: string,
       readonly modelId: string,
       available: string[],
     ) {
       super(
         `Model "${modelId}" not registered for pi-ai provider "${piProvider}". ` +
         `Available: ${available.slice(0, 8).join(", ")}${available.length > 8 ? ", ..." : ""}`,
       );
     }
   }
   ```

   Note: no `PiAiModelWithCompat` alias. Use upstream `Model<Api>` directly.

2. In `pi-ai.ts`, build pi-ai messages with **typed factory helpers** that have explicit return types `(): UserMessage`, `(): AssistantMessage`, `(): ToolResultMessage`. Object literals are checked against the declared return type by `tsc` — no `as` needed. Five conversion casts (L148, L159, L173, L179, L214) go away.

3. `withProviderCompat` narrows on the `model.api` discriminant:

   ```ts
   private withProviderCompat(model: Model<Api>): Model<Api> {
     if (!this.isOpenCodeKimi(model)) return model;
     if (model.api !== "openai-completions") return model;
     // Discriminant narrows model to Model<"openai-completions">; its compat is
     // OpenAICompletionsCompat, which declares requiresReasoningContentOnAssistantMessages.
     return {
       ...model,
       compat: {
         ...model.compat,
         requiresReasoningContentOnAssistantMessages: true,
       },
     };
   }
   ```

   This removes both L120 and L123 casts. If the conditional `compat?` type fails to distribute over `Model<Api>` after narrowing in some TS edge case, fall back to one labelled `as Model<"openai-completions">` at the narrowing line — counted as a third labelled boundary in that case. Plan Step 2.4 calls this out so the implementer verifies with `npm run typecheck`.

4. Tool conversion at L222 keeps one named, documented bridge at the boundary:

   ```ts
   // pi-ai types Tool.parameters as a typebox TSchema; Saivage hand-writes
   // JSON Schema objects. pi-ai serialises parameters as JSON without
   // consulting typebox metadata, so the runtime is sound.
   const tools: Tool[] | undefined = request.tools?.map((t) => ({
     name: t.name,
     description: t.description,
     parameters: t.inputSchema as unknown as Tool["parameters"],
   }));
   ```

5. Tool-call input conversion at L201 keeps one named, documented bridge at the boundary:

   ```ts
   } else if (b.type === "tool_use") {
     // ContentBlock.input is unknown by design (provider-agnostic); pi-ai's
     // ToolCall.arguments is Record<string, unknown>. Tightening ContentBlock
     // ripples across anthropic.ts, copilot.ts, and base.ts; out of scope.
     content.push({
       type: "toolCall",
       id: b.id!,
       name: b.name!,
       arguments: b.input as Record<string, unknown>,
     });
   }
   ```

Per project rule (3) these comments are not added to code we are not modifying — they are placed on the new boundary lines themselves and identify the unsafe surface, so the next reader knows not to paste a third `as`.

### What gets removed

- The cloned-sibling synthesis block ([src/providers/pi-ai.ts#L98-L107](src/providers/pi-ai.ts#L98-L107)) — deleted entirely. No flag, no warning-and-continue.
- The fuzzy-prefix branch ([src/providers/pi-ai.ts#L94-L96](src/providers/pi-ai.ts#L94-L96)) — same class of "guess at operator intent" failure mode. Deleted.
- The `m.content as ContentBlock[]` cast at L162 — TS already narrows `string | ContentBlock[]` in the `else` of a `typeof === "string"` guard.
- The five output-conversion casts at L148, L159, L173, L179, L214 — replaced by typed factories.
- Both compat-injection casts at L120 and L123 — replaced by discriminant narrowing.
- The duplicate `_getModels` cast at L281 — replaced by `piGetModels` from the new module.

### What replaces the throw

`chat` throws `UnknownModelError` (exported from `pi-ai-types.ts`). When F13 lands typed errors at the BaseAgent boundary, the classifier maps `err instanceof UnknownModelError` → `{ kind: "non_retryable", reason: "unknown_model" }`. Until then, the `.message` is still informative for the regex classifier and for the operator looking at logs.

### Risk

- Operators with a `modelSpec` typo who never noticed (because synthesis covered for them) will see a failed first call. **This is the desired outcome.** Project rule (1) explicitly forbids transitional shims.
- Operators relying on `kimi-k2.6` working when pi-ai only has `kimi-k2.5` registered will need to either pin to `kimi-k2.5` or update pi-ai. Same reasoning — silent substitution is the bug.
- Two surviving labelled boundaries (L201 tool-call input, L222 tool parameters) remain unsound in principle. Both are mitigated by being one named line each with a 2-line comment that names the cause. Real fix is migrating Saivage to typebox (out of scope) and/or tightening `ContentBlock.input` (out of scope, six call sites).

### What it enables

- F13 (typed errors): `UnknownModelError` is the seed; once F13 normalises across providers, every adapter exports a `class XxxError extends Error { kind: "..." }` shape and the regex switch dies.
- F20 (`maxContextTokens`): once the synthesis path is gone, `model.contextWindow` is trustworthy. F20 can then standardise on "all `maxContextTokens` implementations read from the model registry, never hardcode".

### What it forbids

- No more inline `as` casts inside `pi-ai.ts` body. After the change the only allowed body assertions are L201 and L222 (both with documenting comments). Acceptance check codifies this — see plan Step 8.
- No "did you mean X?" fuzzy resolution. Operator config errors are configuration errors, not adapter responsibilities.

### Recommendation note

This is the minimum sufficient fix for everything the finding actually complains about, and it leaves the file noticeably smaller (about 25 net lines removed once dead branches go). Cross-issue load: zero — F13/F19/F20 each independently benefit but don't have to coordinate.

---

## Proposal B — Level up: split `PiAiProvider` into adapter + provider, derive capabilities from pi-ai model metadata

### Scope

- Refactor [src/providers/pi-ai.ts](src/providers/pi-ai.ts) into two files:
  - `src/providers/pi-ai-adapter.ts` — pure functions over pi-ai types: `lookupModel`, `toPiMessage`, `toPiTool`, `fromPiAssistant`, `withKimiCompat`. No `BaseProvider` inheritance, no API key state, no `name`.
  - `src/providers/pi-ai.ts` — `PiAiProvider extends BaseProvider`, holds `piProvider`, `apiKey`, `name`, derives `supportsTools`/`supportsImages`/`maxContextTokens` from the resolved `Model<Api>`.
- Touches [src/providers/index.ts](src/providers/index.ts) (the F19 barrel) to export `PiAiProvider`.
- Touches `BaseProvider` defaults conceptually — `supportsTools`/`supportsImages` become "should be overridden per model", and `PiAiProvider.supportsTools(modelSpec)` reads from `Model<Api>` metadata. Today `BaseProvider.supportsTools()` takes no model arg ([src/providers/base.ts#L11](src/providers/base.ts#L11)). Per-model capability is a contract change worth discussing.

### What gets added

Everything in Proposal A, plus:

1. **Adapter as a pure module.** All conversions are stateless functions with explicit return types. The provider class becomes a 60-line shell that holds `piProvider`/`apiKey` and forwards to adapter functions. Test surface: adapter functions are unit-testable without instantiating a provider or wiring an API key.

2. **Per-model capabilities.** `Model<Api>` carries (in pi-ai's catalogue) flags like `input` includes `"image"`, `reasoning`, `contextWindow`. `PiAiProvider.supportsImages(modelSpec)` reads `resolveModel(modelSpec)?.input?.includes("image") === true`. This is the precondition F20 implicitly demands and F22 (capability surface) explicitly demands. It does require `BaseProvider` to grow a `modelSpec` parameter on these methods — see "Cross-issue load" below.

3. **Tighter `UnknownModelError`** (same as Proposal A) + a sibling `UnsupportedCapabilityError` thrown from `chat` when the request asks for tools but the model has no tool support in the pi-ai registry.

4. **Adapter unit tests.** `src/providers/pi-ai-adapter.test.ts` covers conversion of every message-content branch (text, thinking, tool_use, tool_result) round-trip through adapter functions against a small fake `Model<Api>` literal. Today no tests exist for pi-ai.ts.

### What gets removed

Everything Proposal A removes, plus:

- The `withProviderCompat` method becomes a free function in the adapter; the `isOpenCodeKimi` predicate too.
- The boundary erasures move to `pi-ai-adapter.ts` instead of `pi-ai-types.ts`.

### Risk

- Per-model capability methods are a `BaseProvider` API change. Other providers (`AnthropicProvider`, `OpenAIProvider`, etc.) currently return `true`/`false` ignoring the model arg. The change requires either (a) the new signature is `supportsTools(modelSpec: string)` with default ignoring the arg, or (b) every provider gains a `modelSpec` parameter and behaviour for it. (a) is cheap but doesn't enable per-model dispatch; (b) is correct but explicitly couples this change to roughly five other providers.
- Adapter/provider split is the kind of "one conceptual level up" refactor that is easy to under-justify. If the only adapter functions are `toUserMessage` etc. used by one class, it is over-engineering (rule 2). The justification has to be that **tests** (currently zero) want to call these without instantiating `BaseProvider`.

### What it enables

- F13 (typed errors): same hook as Proposal A, but adapter exposes the error type alongside conversion functions — cleaner.
- F19 (barrel): `PiAiProvider` joins the public barrel. Done as part of this change.
- F20 (per-model context window): `PiAiProvider.maxContextTokens(modelSpec)` already does the right thing; this proposal makes the rest of the codebase converge on the same pattern (read from model metadata, never hardcode).
- F22 / capability surface: per-model `supportsImages`/`supportsTools` becomes possible. Today `OpenAIProvider.supportsImages()` returns `true` for every model including reasoning models that reject images. Same story for tool-calling on legacy chat models.

### What it forbids

- Same as Proposal A.
- Plus: no more "one bool per provider" capability answers in `PiAiProvider`.

### Recommendation note

This is the right end state. But its value depends on F13 / F19 / F20 / F22 also landing — otherwise the adapter file's pure functions sit there with nothing to test against the rest of the codebase, and the per-model `BaseProvider` API change ripples without payoff. If we are doing this review's findings in priority order, Proposal A first, B later when F20+F22 are queued, is the correct sequence.

---

## Recommendation

**Proposal A.**

Reasons:

1. The finding is specifically about unsafe patterns in one file. Proposal A removes 9 of the 11 body assertions and leaves the remaining 2 as named, commented boundaries that document exactly why they exist. Cast inventory drops from 11 to 2; both surviving casts are tied to two distinct out-of-scope refactors (Saivage→typebox tool schemas; tightening `ContentBlock.input`).
2. Proposal B's payoff is in coupling F29 to F22 / F20's per-model capability work. Doing that coupling here means F29 cannot ship until F22 ships — and F22 is not in this review's queue at the same priority. Better to land A now, revisit a small B-shaped follow-up after F22 lands.
3. The synthesis-deletion + typed error is the value-carrying part of the change. The adapter split is hygiene that does not pay for itself absent test scaffolding that doesn't exist today.

Cross-link summary:

- F13 — Proposal A introduces `UnknownModelError` with a `kind` field, designed to drop into F13's typed-error normalisation when F13 lands.
- F19 — Proposal A does *not* add `PiAiProvider` to the barrel; that is squarely F19's job. F19 should pick it up as part of "export all eight providers, decide barrel scope".
- F20 — once synthesis is gone, `maxContextTokens(model) = resolveModel(model)?.contextWindow ?? <fail loud>` is the pattern F20 should adopt across all providers. F29 doesn't change F20 directly; it removes the obstacle.
