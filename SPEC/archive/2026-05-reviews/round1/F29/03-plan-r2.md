# F29 r2 — Plan (Proposal A)

## Changes from r1

- **Step 1 no longer defines `PiAiModelWithCompat`.** `Model<Api>.compat?` is already declared upstream ([node_modules/@mariozechner/pi-ai/dist/types.d.ts#L380-L403](node_modules/@mariozechner/pi-ai/dist/types.d.ts#L380-L403)). Removed the bogus intersection helper.
- **Step 2.4 (`withProviderCompat`) rewritten** to narrow on the `model.api` discriminant instead of carrying a local intersection type. Both L120 and L123 casts are eliminated.
- **New Step 2.5** explicitly removes the redundant `m.content as ContentBlock[]` at L162 via TS narrowing.
- **New Step 2.6** documents L201 (`b.input as Record<string, unknown>`) as the second labelled bridge boundary, with the 2-line comment naming the cause. Previously omitted from the inventory.
- **Step 8 acceptance check rewritten.** Two targeted greps replace the unreliable `grep -c " as "`.
- **Test recipe fixed.** The `chat` test now satisfies `ChatRequest` by including the required `system` field ([src/providers/types.ts#L20-L29](src/providers/types.ts#L20-L29)).

Single-commit change. All edits stay inside `src/providers/`.

## Ordered edit steps

### Step 1 — create `src/providers/pi-ai-types.ts`

New file, ~30 lines. Contents:

- Import `getModel`, `getModels`, `type Model`, `type Api` from `@mariozechner/pi-ai`.
- Export two named bindings `piGetModel` and `piGetModels` that cast away pi-ai's compile-time generic constraint exactly once each (`as unknown as (provider: string, modelId: string) => Model<Api> | undefined` etc.). These two casts are the only `as unknown as` permitted in the pi-ai integration after this change.
- Export `class UnknownModelError extends Error` with readonly `kind: "unknown_model"`, `piProvider: string`, `modelId: string`. Constructor signature `(piProvider, modelId, available: string[])`. Builds an informative `message`.
- Do **not** declare any local `PiAiModelWithCompat` alias. The upstream `Model<TApi>["compat"]` conditional union is the source of truth; the provider narrows on `model.api` to get the openai-completions compat shape.

### Step 2 — rewrite `src/providers/pi-ai.ts`

Edits, in order:

#### Step 2.1 — Imports

Replace the bare `getModel`/`getModels` imports from `@mariozechner/pi-ai` with `piGetModel`, `piGetModels`, `UnknownModelError` from `./pi-ai-types.js`. Keep importing `getProviders` from `@mariozechner/pi-ai` (still used by `listPiProviders`). Keep all type-only imports of `Model`, `Api`, `Context`, `Message as PiMessage`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `TextContent`, `ThinkingContent`, `ToolCall`, `Tool`.

#### Step 2.2 — `resolveModel`

Delete the current body (lines 80-107 inclusive) and replace with:

```ts
private resolveModel(modelId: string): Model<Api> | undefined {
  const exact = piGetModel(this.piProvider, modelId);
  if (exact) return this.withProviderCompat(exact);
  const byId = piGetModels(this.piProvider).find((m) => m.id === modelId);
  return byId ? this.withProviderCompat(byId) : undefined;
}
```

This deletes the boundary casts (L82-L83), the fuzzy-prefix branch (L94-L96), and the synthetic-sibling branch (L98-L107) in one replacement.

#### Step 2.3 — `chat` throw

Change the not-found throw to:

```ts
const model = this.resolveModel(request.model);
if (!model) {
  throw new UnknownModelError(
    this.piProvider,
    request.model,
    piGetModels(this.piProvider).map((m) => m.id),
  );
}
```

#### Step 2.4 — `withProviderCompat`

Replace the current body (L113-L128) with discriminant-narrowed shape, return type stays `Model<Api>`:

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

Both L120 (`as Record<string, unknown> | undefined`) and L123 (`as Model<Api>`) disappear.

**Fallback contingency:** if `npm run typecheck` after Step 2.4 emits a "compat is `never`" error because TS does not distribute the conditional `compat?` across `Model<Api>` after narrowing on `model.api`, add a single labelled `as Model<"openai-completions">` on the line immediately after the narrowing guard (third labelled boundary). The acceptance check in Step 8 accommodates this case by counting `as Model<` matches separately. The implementer must report which branch was taken when filing the change.

#### Step 2.5 — Remove the redundant `ContentBlock[]` cast

Inside `buildContext`, the outer loop is:

```ts
for (const m of request.messages) {
  if (typeof m.content === "string") {
    // ... string branch ...
  } else {
    const blocks = m.content as ContentBlock[];   // L162 — DELETE the cast
```

`m.content` has type `string | ContentBlock[]`. After the `typeof === "string"` guard, the `else` branch already narrows it to `ContentBlock[]`. Replace `m.content as ContentBlock[]` with `m.content`. No cast.

#### Step 2.6 — Message factories

Replace the inline object-literal-plus-cast pattern with explicit-return-typed local helpers at the top of `buildContext` (they capture `now` and `this.piProvider`):

```ts
const userMsg = (content: UserMessage["content"]): UserMessage =>
  ({ role: "user", content, timestamp: now });

const assistantMsg = (
  content: AssistantMessage["content"],
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: this.piProvider,
  model: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
           cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: now,
});

const toolResultMsg = (toolCallId: string, text: string, isError: boolean): ToolResultMessage =>
  ({ role: "toolResult", toolCallId, toolName: "",
     content: [{ type: "text", text }], isError, timestamp: now });
```

At each of L145-L150 (`as UserMessage`), L154-L164 (`as AssistantMessage`), L167-L175 (`as ToolResultMessage`), L176-L181 (`as UserMessage`), L207-L216 (`as AssistantMessage`), replace the literal-plus-cast with a call to the appropriate helper. All five conversion casts disappear.

#### Step 2.7 — Tool-call input bridge (L201)

Keep the cast on its own line with a 2-line comment that names the boundary:

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

This is the first of two labelled body assertions. The comment is not a "new docstring on code we are not modifying" (project rule 3) — the line itself *is* the change.

#### Step 2.8 — Tool-parameters bridge (L222)

Keep the cast on its own line with a 2-line comment that names the boundary; change `as` to `as unknown as` to make the deliberate erasure explicit:

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

This is the second labelled body assertion.

#### Step 2.9 — `listModels`

Change:

```ts
const _getModels = getModels as (provider: string) => Model<Api>[];
return _getModels(this.piProvider).map((m) => m.id);
```

to:

```ts
return piGetModels(this.piProvider).map((m) => m.id);
```

The L281 boundary cast is removed.

### Step 3 — no barrel change

Per the recommendation in the design doc, do **not** add `PiAiProvider` to [src/providers/index.ts](src/providers/index.ts) here. That is F19's deliverable. The plan must explicitly NOT touch `index.ts` to avoid stepping on F19.

### Step 4 — no router change

`router.ts` keeps constructing `PiAiProvider` exactly as today. No call-site contract changes.

## Test strategy

### Existing tests that cover this code path

- `src/providers/router.test.ts` — exercises router construction but stubs providers; does not call `resolveModel`.
- `src/providers/types.test.ts` — schema tests, irrelevant.
- No `pi-ai.test.ts` exists.

### New tests

Add `src/providers/pi-ai.test.ts` with:

1. **`resolveModel — exact match returns the registry entry.`** Create a `PiAiProvider("anthropic")`, call `(provider as unknown as { resolveModel(s: string): unknown }).resolveModel("claude-sonnet-4-20250514")`. Assert `result?.id === "claude-sonnet-4-20250514"`. The test-only access cast lives in a test file (F29 scope is `src/providers/pi-ai.ts`, not tests). The exact model ID is verified in pi-ai's catalogue at [node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L1942-L1958](node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L1942-L1958); if pi-ai is bumped before this test lands, swap to whichever Claude ID is current — read at test-write time.

2. **`resolveModel — unknown model returns undefined.`** `resolveModel("definitely-not-a-real-model-xyz")` → `undefined`. **No synthesis.**

3. **`resolveModel — typo near a real model still returns undefined.`** `resolveModel("claude-sonnet-4-typo-9")` → `undefined`. This is the regression test against the deleted synthesis path: under the old code, the trailing `-9` would be stripped, `"claude-sonnet-4-typo"` would not match anything starting with that prefix, so this specific input also returned `undefined` — but the path itself was reachable. The companion case `"kimi-k2.99"` on the `opencode` provider is the one the old code would have synthesized; assert it now returns `undefined` too.

4. **`chat — throws UnknownModelError with available IDs in the message.`** Build a typed request and assert the throw shape:

   ```ts
   const req: ChatRequest = {
     model: "no-such-model",
     system: "",
     messages: [{ role: "user", content: "hi" }],
   };
   await expect(provider.chat(req)).rejects.toMatchObject({
     kind: "unknown_model",
     modelId: "no-such-model",
   });
   ```

   Also assert `err instanceof UnknownModelError` and that `err.message` contains at least one real model ID from the catalogue. The `system: ""` is required because `ChatRequest.system: string` is non-optional ([src/providers/types.ts#L20-L29](src/providers/types.ts#L20-L29)).

5. **`withProviderCompat — adds requiresReasoningContentOnAssistantMessages for opencode kimi-k2 models.`** Resolve a kimi-k2 model on the `opencode` provider and assert the resulting object has `compat.requiresReasoningContentOnAssistantMessages === true`. Resolve a non-kimi model on `opencode` and assert no compat flag override was added (the model's pre-existing compat, if any, is preserved unchanged). Resolve a kimi-k2 model whose `api` is not `"openai-completions"` (if any exist in the catalogue at test-write time) and assert no override — proves the discriminant guard works.

No network calls. Tests only call `resolveModel` (synchronous registry lookup) and the synchronous throw path of `chat` (which never reaches `complete`).

### Validation commands

Run from repo root `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/providers/pi-ai.test.ts
npx vitest run src/providers/      # full providers test directory regression
```

Acceptance:

- `typecheck` passes.
- `build` (tsup) produces `dist/` without errors.
- `pi-ai.test.ts` — all 5 cases pass.
- All existing tests under `src/providers/` continue to pass.

### Step 8 — Cast-inventory acceptance check

Replaces r1's `grep -c " as "`. Two targeted greps, each with a named expected outcome.

```bash
# Allowed body assertions: exactly TWO. Both must be the documented bridges
# in buildContext (L201-style tool-call input, L222-style tool-parameters).
# Excludes the L20 import alias `Message as PiMessage` because it does not
# match the `as <Type>` body pattern when prefixed by a space at line start.
grep -nE '^[^/]*\bas (unknown as |Record<)' src/providers/pi-ai.ts
# Expect exactly 2 hits:
#   <line>:    parameters: t.inputSchema as unknown as Tool["parameters"],
#   <line>:      arguments: b.input as Record<string, unknown>,

# No assertions casting to pi-ai/Saivage message or model types.
grep -nE 'as (Model<|UserMessage|AssistantMessage|ToolResultMessage|ContentBlock\[\])' src/providers/pi-ai.ts
# Expect: NO matches (zero hits).
#
# Exception: if Step 2.4's discriminant narrowing was insufficient and the
# fallback `as Model<"openai-completions">` was needed, exactly ONE hit
# `as Model<"openai-completions">` is permitted on the line immediately
# following the `if (model.api !== "openai-completions") return model;` guard.

# No synthesis residue.
grep -nE 'synthetic|sibling|prefix' src/providers/pi-ai.ts
# Expect: NO matches.
```

The first grep encodes the two surviving labelled boundaries. The second grep proves that none of the 9 deleted assertions snuck back in (or were copy-pasted into a different line). The third grep guards against partial reverts of the synthesis deletion.

## Rollback strategy

Single commit. Revert with `git revert <sha>`. No data migrations, no on-disk format changes, no config schema changes. The only behaviour change visible to an operator is: a `modelSpec` typo that previously got silently substituted now throws `UnknownModelError` on first use. Reverting restores the silent substitution.

## Cross-issue ordering

- **Must precede:** nothing. F29 stands alone.
- **Should precede:** F19 (provider barrel). F19 will add `PiAiProvider` to `src/providers/index.ts`; that addition reads cleaner after this cleanup lands because the file no longer carries the synthesis embarrassment that motivated keeping it out of the public barrel.
- **Should precede:** F20 (per-model `maxContextTokens`). F20 needs `model.contextWindow` to be trustworthy; the synthesis path corrupted it, so F20 should not land first.
- **Independent of:** F13 (typed errors). F29 introduces `UnknownModelError` with a `kind` field as a forward-compatible seed. F13 will later normalise this and equivalents across all providers; F13 does not need F29 to land first, and F29 does not need F13.
- **Independent of:** F02 (roster drift). Different layer.

No coordination needed with `src/skills/` or memory subsystems (the out-of-scope areas).
