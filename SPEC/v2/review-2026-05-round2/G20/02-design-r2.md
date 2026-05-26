# G20 — Design r2

Companion to [01-analysis-r2.md](01-analysis-r2.md). Revises
[02-design-r1.md](02-design-r1.md) to address
[04-review-r1.md](04-review-r1.md) findings 1 (test surgery), 2 (false
`openai`-package-removal claim), and 3 (sharper architecture decision +
concrete follow-up).

## Design A — Focused fix (delete the dead classes)

Delete the three truly-dead classes plus their unit tests, surgically
prune the dead-class `it` blocks from
[src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts),
swap the stale `openrouter` example in
[src/providers/types.test.ts](../../../../src/providers/types.test.ts#L11-L13),
and leave `OpenAIProvider` in place because `OllamaProvider` and
`LlamaCppProvider` inherit from it.

### Files deleted

- [src/providers/anthropic.ts](../../../../src/providers/anthropic.ts) (135 LOC)
- [src/providers/anthropic.test.ts](../../../../src/providers/anthropic.test.ts) (37 LOC)
- [src/providers/openai-codex.ts](../../../../src/providers/openai-codex.ts) (410 LOC)
- [src/providers/openai-codex.test.ts](../../../../src/providers/openai-codex.test.ts) (48 LOC)
- [src/providers/openrouter.ts](../../../../src/providers/openrouter.ts) (35 LOC)
- [src/providers/openrouter.test.ts](../../../../src/providers/openrouter.test.ts) (38 LOC)

**Total file-deletion: 703 LOC across 6 files.**

### Files edited (test surgery + doc clean-up)

- [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts) —
  remove imports of `OpenAICodexProvider`, `AnthropicProvider`, and
  `OpenRouterProvider` at
  [L4-L6](../../../../src/providers/model-capabilities.test.ts#L4-L6),
  and delete the three direct-class `it` blocks at
  [L53-L60](../../../../src/providers/model-capabilities.test.ts#L53-L60),
  [L62-L76](../../../../src/providers/model-capabilities.test.ts#L62-L76),
  and [L78-L93](../../../../src/providers/model-capabilities.test.ts#L78-L93).
  Keep the `OpenAIProvider` direct-class `it` at
  [L44-L51](../../../../src/providers/model-capabilities.test.ts#L44-L51),
  the live `OllamaProvider`/`LlamaCppProvider` `defaultContextWindow`
  cases at
  [L95-L114](../../../../src/providers/model-capabilities.test.ts#L95-L114),
  the `PiAiProvider` registry suite at
  [L117-L156](../../../../src/providers/model-capabilities.test.ts#L117-L156),
  and the `ModelRouter.getMaxContextTokens` suite at
  [L158-L200](../../../../src/providers/model-capabilities.test.ts#L158-L200).
  Net deletion ~50 LOC inside this file.
- [src/providers/types.test.ts](../../../../src/providers/types.test.ts#L11-L13) —
  replace the `openrouter/meta-llama/llama-3.3-70b` example with a
  live nested example such as `ollama/library/llama3.3:70b` (or any
  live provider name that emits a nested model string). The assertion
  shape is unchanged; the literal updates the test corpus to stop
  naming a deleted provider. The test stays generic to `parseModelId`'s
  provider-agnostic parsing contract.
- [src/providers/router.ts](../../../../src/providers/router.ts#L897-L909) —
  remove `"openrouter"` from `isProviderName`'s hardcoded list **if
  present** (verify; current code does not list it but G21 will
  eventually fold these lists).
- [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L75-L101) — Providers
  row: drop the four deleted files from the "Key files" cell and
  remove `AnthropicProvider`, `OpenAICodexProvider`, and
  `OpenRouterProvider` from the "Public surface" cell. Keep
  `OpenAIProvider` and describe its narrowed role as the inheritance
  base for the local-LLM providers.

### Public API impact

- The `*Provider` class names disappear from the providers subsystem's
  effective public surface. Because
  [src/providers/index.ts](../../../../src/providers/index.ts) was
  deleted in round-1 F19 and there are no non-test importers, no
  Saivage-internal consumer breaks.
- `OpenAIProvider` is retained but its role narrows from "named
  provider for `openai`" to "OpenAI-compatible HTTP base for local-LLM
  subclasses". Document this in
  [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) by listing it only
  under the local-LLM block.
- Operator-facing config: any `saivage.json` with
  `models.<role>: "openrouter/..."` or a `providers.openrouter` block
  will fail boot validation via `validateModelCoverage`
  ([src/config-validation.ts](../../../../src/config-validation.ts)).
  This is the desired failure mode (architecture-first, no shim) — add
  a CHANGELOG entry but no migration code.

### Deletion list

Exactly the six files above are removed from the tree. Two files are
edited (`model-capabilities.test.ts`, `types.test.ts`). No `router.ts`
import lines need to be removed — `router.ts` already does not import
`AnthropicProvider`, `OpenAIProvider`, `OpenAICodexProvider`, or
`OpenRouterProvider`.

### Test impact

- 123 test LOC removed via file deletion
  (`anthropic.test.ts` + `openai-codex.test.ts` + `openrouter.test.ts`);
  their assertions exercise dead code, so coverage drop is illusory.
- ~50 LOC removed in-place from
  [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts);
  the equivalent capability coverage for the cloud-LLM models lives in
  the `PiAiProvider` suite further down the same file (which is what
  the router actually exercises in production).
- 1 LOC literal change in
  [src/providers/types.test.ts](../../../../src/providers/types.test.ts#L11-L13).
- Live coverage for the OpenAI-compatible HTTP shape continues to come
  from
  [src/providers/openai.test.ts](../../../../src/providers/openai.test.ts)
  (via the inherited `OllamaProvider` / `LlamaCppProvider` behaviour)
  and from
  [src/providers/router.test.ts](../../../../src/providers/router.test.ts).
- The cloud-LLM paths (`anthropic`, `openai`, `openai-codex`,
  `opencode`) remain covered by
  [src/providers/pi-ai.test.ts](../../../../src/providers/pi-ai.test.ts)
  and
  [src/providers/router.test.ts](../../../../src/providers/router.test.ts)
  exercising `PiAiProvider`, which is what production actually runs.
- No new tests required; the deletion does not change runtime
  behaviour.

## Design B — One conceptual level up (rename or fold the OpenAI-compat layer)

Recognise that the "OpenAI-compatible HTTP" code in
[src/providers/openai.ts](../../../../src/providers/openai.ts) is no
longer a *provider* (the cloud OpenAI path runs through `PiAiProvider`)
— it is an *adapter* for local servers that happen to speak the OpenAI
chat completions wire format. Rename and re-home it accordingly, and
delete `OpenAIProvider` as a separately-named symbol.

Two concrete shapes — pick one in implementation:

**B.1 — Rename and narrow**: `OpenAIProvider` becomes
`OpenAICompatibleLocalProvider` in a new
[src/providers/openai-compatible.ts](../../../../src/providers/) (or
inline its body into a small base inside `ollama.ts` and have
`llamacpp.ts` extend from there). Delete `openai.ts` and
`openai.test.ts` as separate files. Ollama/LlamaCpp lose their
`OpenAIProvider` import and gain the new base. Class name stops
misleading reviewers into thinking the cloud-OpenAI path goes through
it. The `openai` npm package **stays** in
[package.json](../../../../package.json) because
[src/providers/copilot.ts](../../../../src/providers/copilot.ts#L1)
still imports it; see B.2 for the only path that could drop the
dependency.

**B.2 — Fold the local-LLM providers into PiAi (does not remove the `openai` package on its own)**:
Add `ollama` and `llamacpp` as PiAi-routable provider names (PiAi
already supports arbitrary named endpoints; the only OpenAI-specific
bits are the `/v1/chat/completions` path and the `openai` npm SDK).
Replace the `openai` SDK usage in the local-LLM path with a small
fetch-based call inside `PiAiProvider` (or its sibling), and delete
`OpenAIProvider`, `OllamaProvider`, `LlamaCppProvider` outright.

**Correction to r1**: the r1 design claimed B.2 lets the `openai` npm
dependency be removed from
[package.json](../../../../package.json). That is false today.
[src/providers/copilot.ts](../../../../src/providers/copilot.ts#L1)
imports `openai`, stores an `OpenAI` client at
[src/providers/copilot.ts](../../../../src/providers/copilot.ts#L107-L132),
and uses both the Responses and Chat Completions APIs at
[src/providers/copilot.ts](../../../../src/providers/copilot.ts#L214-L280).
Removing the dependency would require either (a) a separate Copilot
refactor that replaces the `openai` SDK with a fetch-based client
(non-trivial — the Responses API path uses SDK-specific streaming
helpers), or (b) reinterpreting B.2 as "drop the SDK from the
local-LLM path only," in which case the package stays installed.
Neither is a transparent benefit of folding the local providers, so
the `openai`-package-removal claim is dropped from B.2.

### Files touched (B.1, conservative variant)

Deleted (everything in Design A, plus):

- [src/providers/openai.ts](../../../../src/providers/openai.ts) (171 LOC)
- [src/providers/openai.test.ts](../../../../src/providers/openai.test.ts) (36 LOC)

Added or substantially rewritten:

- [src/providers/openai-compatible.ts](../../../../src/providers/) — ~120 LOC OpenAI-wire-format base class (subset of current `openai.ts`, with cloud-only branches removed).
- [src/providers/openai-compatible.test.ts](../../../../src/providers/) — parameterised conformance suite that runs against `OllamaProvider` and `LlamaCppProvider`.
- [src/providers/ollama.ts](../../../../src/providers/ollama.ts), [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts) — update import to the new base.

Edited:

- [src/providers/router.ts](../../../../src/providers/router.ts#L741-L815) — no functional change; only the import line ordering shifts.
- [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L75-L101) — replace `OpenAIProvider` with the new base class in the Providers row.

**Total deletion: 910 LOC. Total addition: ~150 LOC. Net: −760 LOC.**

### Public API impact (B)

- Class `OpenAIProvider` ceases to exist; any future contributor who
  greps for it finds only the explicitly-renamed
  `OpenAICompatibleLocalProvider` (or, in B.2, nothing — the local-LLM
  shape lives inside the unified PiAi layer).
- Neither B.1 nor B.2 removes the `openai` npm dependency from
  [package.json](../../../../package.json) on its own; that removal is
  blocked by the Copilot provider and is filed as a separate follow-up
  (see "Follow-up acceptance criterion" below).

### Test impact (B)

- B.1: 159 LOC of stand-alone provider tests removed; ~80 LOC
  parameterised conformance suite added. Net coverage for the
  local-LLM path is at least as strong because it now actually runs
  against every subclass instead of testing a class whose only callers
  inherit from it.
- B.2: also requires extending
  [src/providers/pi-ai.test.ts](../../../../src/providers/pi-ai.test.ts)
  with cases for the new `ollama` / `llamacpp` provider names against
  a mock OpenAI-compatible endpoint.

## Recommendation

**Adopt Design A for G20. Explicitly scope G20 to dead-code deletion +
record concrete follow-up acceptance criteria for the rename/fold
(B.1) and for dropping the `openai` npm dependency.**

Rationale (per [04-review-r1.md](04-review-r1.md) finding 3 — sharper
architecture-first decision):

1. **Risk asymmetry**: Design A is mechanical deletion of code with
   zero non-test importers and zero router branches — the failure mode
   (`tsc` error or test failure) is local and obvious. Design B
   restructures the live local-LLM code path that production users hit
   and changes test scaffolding; the failure mode (broken Ollama
   inference at runtime) is detected only by integration testing
   against a real local server.
2. **Cross-finding coherence**: G21 (provider-name list quadruple
   duplication) and G22 (dead `copilot` OAuth mapping) edit the same
   `router.ts` enumerations. Landing Design A first reduces the
   surface those findings touch, making G21's refactor smaller and
   cleaner.
3. **Architecture-first does not mean "biggest refactor wins"**: The
   guideline forbids backward-compatibility shims and dead-code
   preservation; both designs honour it. Design A removes 703 LOC of
   dead code without restructuring live code, which is the minimum
   change that fully satisfies the no-dead-code rule.
4. **The follow-up is concrete, not aspirational** — see below.

### Follow-up acceptance criterion (new in r2)

To honour the architecture-first guideline and avoid leaving the
level-up as an indefinite "nice later" note, G20 lands with two
explicit follow-up commitments that must be filed as new round-2
findings (or round-3 entries) before G20's CHANGELOG entry can be
considered closed:

- **Follow-up F-G20-RENAME** — Rename or fold `OpenAIProvider` (B.1 or
  B.2) so the providers subsystem no longer exposes a class named
  after a cloud provider it does not implement. Acceptance criteria:
  1. `git grep "class OpenAIProvider" src/` returns zero hits.
  2. `git grep "import.*OpenAIProvider" src/` returns zero hits.
  3. Either a new `OpenAICompatibleLocalProvider` class exists in
     [src/providers/](../../../../src/providers/) (B.1) or `ollama`
     and `llamacpp` are PiAi-routable provider names handled inside
     `PiAiProvider` (B.2).
  4. Live local-LLM coverage runs against `OllamaProvider` and
     `LlamaCppProvider` (B.1) or against the equivalent PiAi branches
     (B.2).
- **Follow-up F-G20-OPENAI-PKG** — Drop the `openai` npm dependency
  from [package.json](../../../../package.json). Acceptance criteria:
  1. `git grep "from \"openai\"" src/` returns zero hits.
  2. `git grep "\"openai\":" package.json` returns zero hits in
     `dependencies` / `devDependencies`.
  3. [src/providers/copilot.ts](../../../../src/providers/copilot.ts)
     uses a fetch-based client for both the Responses and Chat
     Completions APIs at
     [src/providers/copilot.ts](../../../../src/providers/copilot.ts#L214-L280).
  4. `npm test -- --run` and `npx tsc --noEmit` remain green.

Both follow-ups are referenced from the G20 CHANGELOG entry per
[03-plan-r2.md](03-plan-r2.md) so that the level-up commitment is
discoverable from the deletion commit, not buried in a review thread.

Plan in [03-plan-r2.md](03-plan-r2.md) implements Design A with the
test surgery, the `types.test.ts` literal swap, the
ModelRouter-constructing validation command, the three-host live
health-check probes, and the two follow-up acceptance criteria
recorded in CHANGELOG.
