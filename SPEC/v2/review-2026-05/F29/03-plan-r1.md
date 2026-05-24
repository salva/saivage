# F29 r1 — Plan (Proposal A)

Single-commit change. All edits stay inside `src/providers/`.

## Ordered edit steps

### Step 1 — create `src/providers/pi-ai-types.ts`

New file, ~25 lines. Contents:

- Import `getModel`, `getModels`, `type Model`, `type Api` from `@mariozechner/pi-ai`.
- Export two named bindings `piGetModel` and `piGetModels` that cast away pi-ai's compile-time generic constraint exactly once each (`as unknown as (provider: string, modelId: string) => Model<Api> | undefined` etc.). These two casts are the only `as unknown as` permitted in the pi-ai integration after this change.
- Export `type PiAiModelWithCompat = Model<Api> & { compat?: { requiresReasoningContentOnAssistantMessages?: boolean } }`.
- Export `class UnknownModelError extends Error` with readonly `kind: "unknown_model"`, `piProvider: string`, `modelId: string`. Constructor signature `(piProvider, modelId, available: string[])`. Builds an informative `message`.

### Step 2 — rewrite `src/providers/pi-ai.ts`

Edits, in order:

1. **Imports.** Replace the bare `getModel`/`getModels`/`getProviders` imports from `@mariozechner/pi-ai` with `piGetModel`, `piGetModels`, `PiAiModelWithCompat`, `UnknownModelError` from `./pi-ai-types.js`. Keep importing `getProviders` from `@mariozechner/pi-ai` (still used by `listPiProviders`). Keep all type-only imports of `Model`, `Api`, `Context`, `Message as PiMessage`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `TextContent`, `ThinkingContent`, `ToolCall`, `Tool`.

2. **`resolveModel`.** Delete lines 80-107 inclusive (the body) and replace with:

   ```ts
   private resolveModel(modelId: string): Model<Api> | undefined {
     const exact = piGetModel(this.piProvider, modelId);
     if (exact) return this.withProviderCompat(exact);
     const byId = piGetModels(this.piProvider).find((m) => m.id === modelId);
     return byId ? this.withProviderCompat(byId) : undefined;
   }
   ```

   This deletes both the fuzzy-prefix branch and the synthetic-sibling branch.

3. **`chat`.** Change the not-found throw to:

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

4. **`withProviderCompat`.** Change return type from `Model<Api>` to `PiAiModelWithCompat`. Remove the trailing `as Model<Api>` cast on the spread. The intersection type now accepts `compat` directly.

5. **`buildContext` — message factories.** Replace the inline object-literal-plus-cast pattern with explicit-return-typed local helpers at the top of the method (or as private methods on the class; local closures are fine since they capture `now` and `this.piProvider`). Helper shapes:

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

   At each of lines 145-150, 154-164, 167-175, 176-181, 207-216, replace the literal-plus-cast with a call to the appropriate helper. All five conversion casts (`as UserMessage`, `as AssistantMessage`, `as ToolResultMessage`) disappear; `tsc` now type-checks each branch against the declared return type.

6. **Tool conversion.** Keep the conversion but isolate the cast on its own line with a brief preceding comment (this is the documented unsafe boundary, not new docstring noise — see project rule 2 / design Proposal A):

   ```ts
   // pi-ai types Tool.parameters as a typebox TSchema; Saivage hand-writes
   // JSON Schema objects. Runtime serialisation is JSON either way.
   const tools: Tool[] | undefined = request.tools?.map((t) => ({
     name: t.name,
     description: t.description,
     parameters: t.inputSchema as unknown as Tool["parameters"],
   }));
   ```

7. **`listModels`.** Change `const _getModels = getModels as ...; return _getModels(this.piProvider).map(...)` to `return piGetModels(this.piProvider).map((m) => m.id)`.

8. **Verify** no `as ` substrings remain in `pi-ai.ts` except for the single tool-parameters cast: `grep -n " as " src/providers/pi-ai.ts` should show exactly one hit.

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

1. **`resolveModel — exact match returns the registry entry.`** Create a `PiAiProvider("anthropic")`, call `(provider as any).resolveModel("claude-sonnet-4-20250514")` (or whichever ID pi-ai's catalogue currently has — read at test-write time, do not assume). Assert `result?.id === "<that ID>"`. The `as any` here is in a test file (acceptable; F29 scope is `src/providers/pi-ai.ts`, not tests).
2. **`resolveModel — unknown model returns undefined.`** `(provider as any).resolveModel("definitely-not-a-real-model-xyz")` → `undefined`. **No synthesis.**
3. **`resolveModel — typo near a real model still returns undefined.`** `"claude-sonnet-4-typo-9"` → `undefined`. This is the regression test against the deleted synthesis path.
4. **`chat — throws UnknownModelError with available IDs in the message.`** Call `chat({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] })`, assert thrown error is `instanceof UnknownModelError`, `err.kind === "unknown_model"`, `err.modelId === "no-such-model"`, and `err.message` contains at least one real model ID from the catalogue.
5. **`withProviderCompat — adds requiresReasoningContentOnAssistantMessages for opencode kimi-k2 models.`** Resolve a kimi-k2 model on the `opencode` provider and assert the resulting object has `compat.requiresReasoningContentOnAssistantMessages === true`. Resolve a non-kimi model on `opencode` and assert no compat flag was added.

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

Additional manual sanity:

```bash
grep -c " as " src/providers/pi-ai.ts        # expect: 1 (the tool-parameters bridge)
grep -n "synthetic\|sibling\|prefix" src/providers/pi-ai.ts  # expect: no matches
```

## Rollback strategy

Single commit. Revert with `git revert <sha>`. No data migrations, no on-disk format changes, no config schema changes. The only behaviour change visible to an operator is: a `modelSpec` typo that previously got silently substituted now throws `UnknownModelError` on first use. Reverting restores the silent substitution.

## Cross-issue ordering

- **Must precede:** nothing. F29 stands alone.
- **Should precede:** F19 (provider barrel). F19 will add `PiAiProvider` to `src/providers/index.ts`; that addition reads cleaner after this cleanup lands because the file no longer carries the synthesis embarrassment that motivated keeping it out of the public barrel.
- **Should precede:** F20 (per-model `maxContextTokens`). F20 needs `model.contextWindow` to be trustworthy; the synthesis path corrupted it, so F20 should not land first.
- **Independent of:** F13 (typed errors). F29 introduces `UnknownModelError` with a `kind` field as a forward-compatible seed. F13 will later normalise this and equivalents across all providers; F13 does not need F29 to land first, and F29 does not need F13.
- **Independent of:** F02 (roster drift). Different layer.

No coordination needed with `src/skills/` or memory subsystems (the out-of-scope areas).
