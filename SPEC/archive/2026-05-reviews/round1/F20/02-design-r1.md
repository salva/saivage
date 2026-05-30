# F20 — Design (r1)

## Proposal A — Per-provider data table, no abstraction

**Scope (files touched):**

- [src/providers/anthropic.ts](src/providers/anthropic.ts#L109-L114), [src/providers/openai.ts](src/providers/openai.ts#L148-L153), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L374-L379), [src/providers/openrouter.ts](src/providers/openrouter.ts#L16-L18), [src/providers/ollama.ts](src/providers/ollama.ts#L17-L19), [src/providers/llamacpp.ts](src/providers/llamacpp.ts#L21-L23) — replace each `maxContextTokens` body with a per-model `Map<RegExp | string, number>` lookup.
- [src/providers/base.ts](src/providers/base.ts#L19-L21) — `BaseProvider.maxContextTokens` becomes `abstract`. No silent default. `pi-ai` and `copilot` already override; the four hardcoded providers above gain real implementations.
- [src/providers/router.ts](src/providers/router.ts#L245-L258) — remove the `?? 200_000` fallback in `getMaxContextTokens`. If the provider returns nothing (cannot happen once `maxContextTokens` is abstract), throw — but in practice the abstract method always returns a number, so this is just deleting the dead fallback.

**What gets added:**

- Inside each provider file, a `MODEL_CONTEXT_WINDOWS` table sitting next to the provider class. For most providers the table is 4–8 entries. Examples:

  ```ts
  // src/providers/anthropic.ts
  const MODEL_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
    [/^claude-(?:3|3-5|3\.5|sonnet|opus|haiku)-/, 200_000],
    // Claude 4 line — same 200k window today; refine when official.
    [/^claude-(?:sonnet|opus|haiku)-4/, 200_000],
  ];
  function lookupContextWindow(model: string): number | undefined {
    for (const [pattern, tokens] of MODEL_CONTEXT_WINDOWS) {
      if (pattern.test(model)) return tokens;
    }
    return undefined;
  }
  ```

- A loud failure path. When `lookupContextWindow(model)` returns `undefined`, throw `new Error(\`unknown context window for model "\${this.name}/\${model}" — add an entry to MODEL_CONTEXT_WINDOWS in \${__filename}\`)`. This surfaces routing/configuration drift at boot time (BaseAgent construction) instead of letting a silently-wrong 200k figure poison compaction for the agent's lifetime.

**What gets removed:**

- All collapsed `if includes()` branches that return the same number (anthropic dead branching).
- The `_model` underscore-prefixed signatures in `ollama` / `llamacpp` / `openrouter` / `base` — every provider now uses its `model` argument.
- The router-side `?? 200_000` silent fallback at [src/providers/router.ts](src/providers/router.ts#L249) and [src/providers/router.ts](src/providers/router.ts#L252-L257).
- The "Varies; OpenRouter handles it" comment, which is incorrect.

**Risk:**

- A model name not yet in the table throws at agent construction. Operators tuning a fresh model see the error immediately and add a row; they do not silently get compacted at the wrong threshold. Mitigation cost: one PR per new model family.
- For `ollama` / `llamacpp`, the table can never be exhaustive (operators load arbitrary weights). For those two providers only, the lookup falls back to a configured value pulled from `SaivageConfig.providers.ollama.defaultContextWindow` (new optional field, default `null` ⇒ throw). This adds one config field instead of a silent constant. Two providers, one field — under the "no abstraction used once" threshold.

**What it enables:**

- F07 numerator (`countTokens`) sits next to F20 denominator (`maxContextTokens`) on the same provider class — both per-model, both synchronous, both local-only. Symmetry is the point.
- Future per-model awareness (output-token budget, image-token surcharge, reasoning-budget) can land as additional same-shape lookup tables on the provider without inventing a new layer.

**What it forbids:**

- A single hardcoded number per provider regardless of model (the original bug).
- Silent `?? 200_000` substitutions anywhere downstream of `maxContextTokens`.
- Operators adding model identifiers to `SaivageConfig.models` to "tune the window" — the window stays with the provider implementation where the upstream vendor information lives.

**Recommendation note:** Cheapest fix. Restricts the change to provider files only. Risk concentrated where it belongs.

---

## Proposal B (RECOMMENDED) — `ModelProvider.modelCapabilities(model)` returns a small capability record, replacing both `maxContextTokens` and the F07-introduced `countTokens` accessor with a single per-model accessor

**Scope (files touched):**

- [src/providers/types.ts](src/providers/types.ts#L83-L98) — `ModelProvider` gains:

  ```ts
  /** Synchronous, local-only. No network. Returns undefined for unknown models. */
  modelCapabilities(model: string): ModelCapabilities | undefined;

  export interface ModelCapabilities {
    /** Maximum input+output context window in tokens. */
    contextWindow: number;
    /** Token-counter encoding tag, consumed by countTokens. */
    tokenEncoding: "cl100k_base" | "o200k_base";
  }
  ```

  The existing `maxContextTokens(model): number` and the F07-introduced `countTokens(model, messages, system?, tools?): number` are removed from the interface; both are replaced by `modelCapabilities` + a single concrete helper in `src/runtime/token-counting.ts` (the file F07 already creates) that consumes the returned `tokenEncoding`.

- [src/providers/base.ts](src/providers/base.ts#L1-L34) — `BaseProvider.modelCapabilities` is `abstract`. No default. The `BaseProvider.countTokens` default that F07 lands is rewritten to:

  ```ts
  countTokens(model, messages, system, tools): number {
    const caps = this.modelCapabilities(model);
    if (!caps) throw new Error(`unknown model "${this.name}/${model}"`);
    return countWithTiktoken(messages, system, tools, caps.tokenEncoding);
  }
  ```

  i.e. `countTokens` now derives its encoding from the same per-model capability record that provides the context window, instead of having a separate model-name switch in each provider.

- All eight provider files — each rewrites its `maxContextTokens` body as a per-model `MODEL_CAPABILITIES` table returning `ModelCapabilities | undefined`. `copilot.ts` keeps reading `metadata.capabilities.limits.max_context_window_tokens` and pairs it with an encoding inferred from the model id. `pi-ai.ts` reads `model.contextWindow` from the pi-ai runtime registry and pairs it similarly.

- [src/providers/router.ts](src/providers/router.ts#L245-L258) — `getMaxContextTokens` calls `provider.modelCapabilities(model)?.contextWindow`; on `undefined` it throws with the model spec in the message. No silent fallback.

- [src/agents/base.ts](src/agents/base.ts#L187) — call site unchanged in shape (`ctx.router.getMaxContextTokens(ctx.modelSpec)`); the throw bubbles to the agent constructor exactly like the F04 `MissingModelForRoleError` does.

- [src/runtime/token-counting.ts](src/runtime/token-counting.ts) — the file F07 creates loses any per-provider model-name switch; encoding is now an input determined by the provider via `modelCapabilities`.

**What gets added:**

- `ModelCapabilities` type + `modelCapabilities(model)` accessor on every provider.
- Per-provider `MODEL_CAPABILITIES` table (data) inside each provider file.

**What gets removed:**

- `maxContextTokens(model): number` from the `ModelProvider` interface, `BaseProvider`, and every provider implementation.
- The `countTokens` per-model encoding switch that F07 lands in each OpenAI-style provider — it collapses into the shared `modelCapabilities` table.
- The router's `?? 200_000` silent fallback (same as Proposal A).
- The `BaseProvider.maxContextTokens` default.

**Risk:**

- Touches one more file (`src/providers/types.ts`) than Proposal A and modifies the contract `BaseAgent` consumes (`getMaxContextTokens` is unchanged in shape but its underlying provider seam shifts). Tests that stub `maxContextTokens: () => 222` at [src/providers/router.test.ts](src/providers/router.test.ts#L172-L175) and [src/providers/router.test.ts](src/providers/router.test.ts#L464) need rewriting to stub `modelCapabilities: () => ({ contextWindow: 222, tokenEncoding: "cl100k_base" })`. Five test files, ~10 lines total.
- Sequencing matters with F07: this proposal *replaces* F07's `countTokens` interface entry. Cleanest landing order is "F07 lands first, F20 collapses F07's `countTokens` accessor into the capability record". If F20 lands first, F07's plan trivially adapts (it adds the helper but skips the interface method). Either order works.
- The `tokenEncoding` field is OpenAI-tokenizer specific terminology. Acceptable because F07 already commits to `js-tiktoken` as the workspace token counter; future vendor-native counters would extend the union rather than the encoding field disappearing.

**What it enables:**

- A single per-model record consumed by both the compaction-trigger numerator (count) and denominator (window). Future fields (max output tokens, image-token surcharge, reasoning-budget) land as additional capability fields without inventing a new layer.
- F07 cleanup: removes the second per-model switch that F07 plants in each OpenAI-style provider.

**What it forbids:**

- Drift between "what context window does this model have?" and "which tokenizer does this model use?" — both now live in the same row of the same table.
- Re-introducing `maxContextTokens` as a separate provider method.

**Recommendation note:** The right shape: the consumer asks one question ("what are this model's capabilities?") and gets one answer. The cost over Proposal A is one interface type + ~10 lines of test stub rewrite. Pays for itself the moment F07 is on the same page (which is the current state — F07 is APPROVED).

---

## Proposal C — Move per-model windows into a static JSON registry under `src/providers/model-registry.json`

**Scope (files touched):**

- New: `src/providers/model-registry.json` (~80 lines, one entry per known provider/model).
- New: `src/providers/model-registry.ts` (~20 lines) — typed loader, frozen at import time.
- All eight provider files — `maxContextTokens` reads from the registry by `(this.name, model)` key.
- Router `?? 200_000` removed.

**What gets added:**

- A separate JSON file as the source of truth for per-model windows.
- A `registry.get(providerName, model)` helper.

**What gets removed:**

- Same as Proposal A: all dead `if` branches, silent fallback.

**Risk:**

- Adds a new file that becomes a magnet for unrelated per-model data (model display names, deprecation tags, latency tiers). The registry file would either stay narrow (just context window — duplicating the table-inside-the-provider approach with an extra hop) or grow into a parallel `SaivageConfig`-style structure with its own schema.
- Decouples the data from the provider that owns the rest of that model's behaviour (chat conversion, tool conversion, encoding choice). The provider class is the only thing that knows `gpt-5` uses the `responses` API path; placing its context window in a different file invites drift.
- Violates "no abstractions used once" — the registry is exactly one abstraction layer (lookup-by-name) we do not need.

**Recommendation note:** Not recommended. Documented to show the alternative was considered and rejected.

---

## Recommendation

**Proposal B.** It is one interface type and ~10 lines of test stub rewrite over Proposal A; in exchange it removes the per-model encoding switch that F07 plants in each OpenAI-style provider and consolidates the two per-model facts (window + encoding) into one record on one accessor. Proposal A is the fallback if F07's `countTokens` ends up not landing as a provider method for some reason.

Cross-links:
- **F07** (APPROVED, Proposal B — `countTokens` as provider capability) — Proposal B here is the structural twin. Either order is fine; F07 first is marginally cheaper because it avoids a transient state where `countTokens` exists as a method and `modelCapabilities` does not.
- **F04** (APPROVED — no hardcoded model defaults in non-provider source) — preserved: all model identifiers introduced by F20 live inside `src/providers/*.ts`.
- **F11** (operational constants in config) — explicitly *not* a cross-link target: per-model context windows are vendor facts, not operator tunables, so they stay with the provider.
