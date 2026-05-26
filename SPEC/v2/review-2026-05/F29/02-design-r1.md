# F29 r1 — Design

Two proposals. Proposal A targets just the unsafe patterns called out in the finding. Proposal B treats `pi-ai.ts` as the place where the broader provider-adapter contract should crystallise, anticipating F13/F19/F20.

## Proposal A — Focused: kill the synthesis path, isolate the boundary cast, type the conversions

### Scope

Single file: [src/providers/pi-ai.ts](src/providers/pi-ai.ts). One new tiny helper file: `src/providers/pi-ai-types.ts` (about 40 lines).

### What gets added

1. `src/providers/pi-ai-types.ts`: declares the single allowed boundary erasure as two named exports, and re-exports a `PiAiModel` alias plus a `withKimiCompat(model)` helper that returns the same shape with an intersection type that exposes `compat`. Example shape:

   ```ts
   import { getModel, getModels, type Model, type Api } from "@mariozechner/pi-ai";

   // The one and only place where pi-ai's compile-time generic constraint
   // is erased. Runtime strings come from operator config.
   export const piGetModel = getModel as unknown as
     (provider: string, modelId: string) => Model<Api> | undefined;
   export const piGetModels = getModels as unknown as
     (provider: string) => Model<Api>[];

   export type PiAiModelWithCompat = Model<Api> & {
     compat?: { requiresReasoningContentOnAssistantMessages?: boolean };
   };
   ```

2. In `pi-ai.ts`, build pi-ai messages with **typed factory helpers** that have explicit return types `(): UserMessage`, `(): AssistantMessage`, `(): ToolResultMessage`. Object literals are checked against the declared return type by `tsc` — no `as` needed. Five conversion casts go away.

3. `withProviderCompat` returns `PiAiModelWithCompat` instead of `Model<Api>`. The spread that injects `compat` is typed.

4. Tool conversion: keep one named, documented bridge at the boundary:

   ```ts
   // Saivage tool schemas are JSON Schema objects; pi-ai's Tool.parameters
   // is structurally a typebox TSchema. pi-ai serialises parameters as
   // JSON without consulting typebox metadata, so the runtime is sound.
   const parameters = t.inputSchema as unknown as Tool["parameters"];
   ```

   This is *one* labelled erasure, not a casual `as` mid-expression. (Per project rule (2) it does not count as a docstring — it is the documentation of a deliberately unsafe boundary; without it the next reader will paste another `as any`.)

### What gets removed

- The cloned-sibling synthesis block ([src/providers/pi-ai.ts#L98-L107](src/providers/pi-ai.ts#L98-L107)) — deleted entirely. No flag, no warning-and-continue.
- All inline `as <PiAiType>` casts on conversion outputs (lines 105, 123, 148, 159, 173, 179, 214, 222).
- The exact-match-then-search-then-fuzzy-prefix cascade in `resolveModel` collapses to: try `piGetModel(provider, id)`, then `models.find(m => m.id === id)`. The fuzzy prefix branch is dropped too — it is the same class of "guess at operator intent" failure mode as the synthesis path. Operators must spell model IDs exactly as the pi-ai registry has them.

### What replaces the throw

`chat` throws a structured error type that F13 can route on:

```ts
class UnknownModelError extends Error {
  readonly kind = "unknown_model" as const;
  constructor(readonly piProvider: string, readonly modelId: string, available: string[]) {
    super(`Model "${modelId}" not registered for pi-ai provider "${piProvider}". ` +
          `Available: ${available.slice(0, 8).join(", ")}${available.length > 8 ? ", ..." : ""}`);
  }
}
```

The class lives next to `PiAiProvider` (same file). Its presence is the forward-compatible hook for F13: when F13 lands typed errors at the BaseAgent boundary, the classifier maps `err instanceof UnknownModelError` → `{ kind: "non_retryable", reason: "unknown_model" }`. Until then, the `.message` is still informative for the regex classifier and for the operator looking at logs.

### Risk

- Operators with a `modelSpec` typo who never noticed (because synthesis covered for them) will see a failed first call. **This is the desired outcome.** Project rule (1) explicitly forbids transitional shims.
- Operators relying on `kimi-k2.6` working when pi-ai only has `kimi-k2.5` registered will need to either pin to `kimi-k2.5` or update pi-ai. Same reasoning — silent substitution is the bug.
- Tool-schema cast remains unsound in principle. Mitigated by being one named line, not eight scattered ones. Real fix is moving Saivage tools to typebox (genuinely out of scope, would cross into agent/tool plumbing throughout).

### What it enables

- F13 (typed errors): `UnknownModelError` is the seed; once F13 normalises across providers, every adapter exports a `class XxxError extends Error { kind: "..." }` shape and the regex switch dies.
- F20 (`maxContextTokens`): once the synthesis path is gone, `model.contextWindow` is trustworthy. F20 can then standardise on "all `maxContextTokens` implementations read from the model registry, never hardcode".

### What it forbids

- No more `as` casts inside `pi-ai.ts` body. ESLint or a code-review checklist can enforce — but the file becoming visibly cast-free is the social enforcement.
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

2. **Per-model capabilities.** `Model<Api>` carries (in pi-ai's catalogue) flags like `input.images`, `tools` support, `reasoning`, `contextWindow`, `output.maxTokens`. `PiAiProvider.supportsImages(modelSpec)` reads `resolveModel(modelSpec)?.input?.images === true`. Same for `supportsTools`. This is the precondition F20 implicitly demands and F22 (capability surface) explicitly demands. It does require `BaseProvider` to grow a `modelSpec` parameter on these methods — see "Cross-issue load" below.

3. **Tighter `UnknownModelError`** (same as Proposal A) + a sibling `UnsupportedCapabilityError` thrown from `chat` when the request asks for tools but the model has `tools !== true` in the pi-ai registry.

4. **Adapter unit tests.** `src/providers/pi-ai-adapter.test.ts` covers conversion of every message-content branch (text, thinking, tool_use, tool_result) round-trip through adapter functions against a small fake `Model<Api>` literal. Today no tests exist for pi-ai.ts.

### What gets removed

Everything Proposal A removes, plus:

- The `withProviderCompat` method becomes a free function in the adapter; the `isOpenCodeKimi` predicate too.
- The five-line `_getModel`/`_getModels` casts at the top of `resolveModel` move to `pi-ai-types.ts` as in Proposal A — still one named place.

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

1. The finding is specifically about unsafe patterns in one file. Proposal A removes 100% of them and leaves no follow-up debt (cast inventory drops from 8 to 1, that 1 is named).
2. Proposal B's payoff is in coupling F29 to F22 / F20's per-model capability work. Doing that coupling here means F29 cannot ship until F22 ships — and F22 is not in this review's queue at the same priority. Better to land A now, revisit a small B-shaped follow-up after F22 lands.
3. The synthesis-deletion + typed error is the value-carrying part of the change. The adapter split is hygiene that does not pay for itself absent test scaffolding that doesn't exist today.

Cross-link summary:

- F13 — Proposal A introduces `UnknownModelError` with a `kind` field, designed to drop into F13's typed-error normalisation when F13 lands.
- F19 — Proposal A does *not* add `PiAiProvider` to the barrel; that is squarely F19's job. F19 should pick it up as part of "export all eight providers, decide barrel scope".
- F20 — once synthesis is gone, `maxContextTokens(model) = resolveModel(model)?.contextWindow ?? <fail loud>` is the pattern F20 should adopt across all providers. F29 doesn't change F20 directly; it removes the obstacle.
