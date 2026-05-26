# G20 — Design r1

Companion to [01-analysis-r1.md](01-analysis-r1.md).

## Design A — Focused fix (delete the dead classes)

Delete the three truly-dead classes plus their unit tests, and prune the
two router enumerations that would otherwise still reference the deleted
provider name `openrouter`. Leave `OpenAIProvider` in place because
`OllamaProvider` and `LlamaCppProvider` inherit from it.

### Files touched

Deleted:

- [src/providers/anthropic.ts](../../../../src/providers/anthropic.ts) (135 LOC)
- [src/providers/anthropic.test.ts](../../../../src/providers/anthropic.test.ts) (37 LOC)
- [src/providers/openai-codex.ts](../../../../src/providers/openai-codex.ts) (410 LOC)
- [src/providers/openai-codex.test.ts](../../../../src/providers/openai-codex.test.ts) (48 LOC)
- [src/providers/openrouter.ts](../../../../src/providers/openrouter.ts) (35 LOC)
- [src/providers/openrouter.test.ts](../../../../src/providers/openrouter.test.ts) (38 LOC)

**Total deletion: 703 LOC across 6 files.**

Edited (router enumerations that name `openrouter`):

- [src/providers/router.ts](../../../../src/providers/router.ts#L897-L909) — remove `"openrouter"` if present in `isProviderName`'s hardcoded list (verify; current code does not list it but G21 will eventually fold these lists).

Edited (subsystem map):

- [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L75-L101) — Providers row: drop the four deleted files from the "Key files" cell and from the "Public surface" cell (remove `AnthropicProvider`, `OpenAIProvider`* (keep — still a base class), `OpenAICodexProvider`, `OpenRouterProvider` from the listed concrete classes).

### Public API impact

- The `*Provider` class names disappear from the providers subsystem's
  effective public surface. Because [src/providers/index.ts](../../../../src/providers/index.ts)
  was deleted in round-1 F19 and there are no non-test importers, no
  Saivage-internal consumer breaks.
- `OpenAIProvider` is retained but its role narrows from "named provider
  for `openai`" to "OpenAI-compatible HTTP base for local-LLM
  subclasses". Document this in [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)
  by listing it only under the local-LLM block.
- Operator-facing config: any `saivage.json` with
  `models.<role>: "openrouter/..."` or a `providers.openrouter` block
  will fail boot validation via `validateModelCoverage`
  ([src/config-validation.ts](../../../../src/config-validation.ts)). This
  is the desired failure mode (architecture-first, no shim) — add a
  CHANGELOG entry but no migration code.

### Deletion list

Exactly the six files above. No dead imports remain because the only
non-test importers of `OpenAIProvider` are `ollama.ts` / `llamacpp.ts`,
both of which stay. No `router.ts` import lines need to be removed —
`router.ts` already does not import `AnthropicProvider`,
`OpenAIProvider`, `OpenAICodexProvider`, or `OpenRouterProvider`.

### Test impact

- 123 test LOC (`anthropic.test.ts` + `openai-codex.test.ts` + `openrouter.test.ts`) removed; their assertions exercise dead code, so coverage drop is illusory.
- Live coverage for the OpenAI-compatible HTTP shape continues to come from [src/providers/openai.test.ts](../../../../src/providers/openai.test.ts) (via the inherited `OllamaProvider` / `LlamaCppProvider` behaviour), and from [src/providers/router.test.ts](../../../../src/providers/router.test.ts).
- The cloud-LLM paths (`anthropic`, `openai`, `openai-codex`, `opencode`) are already covered by [src/providers/pi-ai.test.ts](../../../../src/providers/pi-ai.test.ts) and [src/providers/router.test.ts](../../../../src/providers/router.test.ts) exercising `PiAiProvider`, which is what production actually runs.
- No new tests required; the deletion does not change runtime behaviour.

## Design B — One conceptual level up (collapse the OpenAI-compat layer too)

Recognise that the "OpenAI-compatible HTTP" code in
[src/providers/openai.ts](../../../../src/providers/openai.ts) is no longer
a *provider* (the cloud OpenAI path runs through `PiAiProvider`) — it is
an *adapter* for local servers that happen to speak the OpenAI chat
completions wire format. Rename and re-home it accordingly, and delete
`OpenAIProvider` as a separately-named symbol.

Two concrete shapes — pick one in implementation:

**B.1 — Rename and narrow**: `OpenAIProvider` becomes
`OpenAICompatibleLocalProvider` in a new
[src/providers/openai-compatible.ts](../../../../src/providers/) (or
inline its body into a small base inside `ollama.ts` and have
`llamacpp.ts` extend from there). Delete `openai.ts` and `openai.test.ts`
as separate files. Ollama/LlamaCpp lose their `OpenAIProvider` import
and gain the new base. Class name stops misleading reviewers into
thinking the cloud-OpenAI path goes through it.

**B.2 — Fold into PiAiProvider**: Add `ollama` and `llamacpp` as
PiAi-routable provider names (PiAi already supports arbitrary
named endpoints; the only OpenAI-specific bits are the `/v1/chat/completions`
path and the `openai` npm SDK). Replace the `openai` SDK dependency in
the local-LLM path with a small fetch-based call inside `PiAiProvider`
(or its sibling), and delete `OpenAIProvider`, `OllamaProvider`,
`LlamaCppProvider` outright. The `openai` npm package can then be
removed from [package.json](../../../../package.json) — production code
no longer needs an OpenAI SDK because the cloud OpenAI path already
runs through PiAi's HTTP client.

### Files touched (B.1, conservative variant)

Deleted (everything in Design A, plus):

- [src/providers/openai.ts](../../../../src/providers/openai.ts) (171 LOC)
- [src/providers/openai.test.ts](../../../../src/providers/openai.test.ts) (36 LOC)

Added or substantially rewritten:

- [src/providers/openai-compatible.ts](../../../../src/providers/) — ~120 LOC OpenAI-wire-format base class (subset of current `openai.ts`, with cloud-only branches removed and the `openai` SDK replaced by a small fetch call if going with the lighter variant).
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
- B.2 additionally removes the `openai` npm dependency, reducing the
  install footprint and CVE surface; verify no other code path imports
  `openai` (audit step in plan).

### Deletion list (B.1)

Eight files (Design A's six plus `openai.ts` and `openai.test.ts`).
For B.2: ten files (the eight, plus `ollama.ts` / `llamacpp.ts` as
separate adapters — replaced by additional cases inside `PiAiProvider`).

### Test impact (B)

- B.1: 159 LOC of stand-alone provider tests removed; ~80 LOC
  parameterised conformance suite added. Net coverage for the
  local-LLM path is at least as strong because it now actually runs
  against every subclass instead of testing a class whose only callers
  inherit from it.
- B.2: also requires extending [src/providers/pi-ai.test.ts](../../../../src/providers/pi-ai.test.ts)
  with cases for the new `ollama` / `llamacpp` provider names against a
  mock OpenAI-compatible endpoint.

## Recommendation

**Adopt Design A now; defer B to a follow-up batch.**

Rationale:

1. **Risk asymmetry**: Design A is mechanical deletion of code with zero
   non-test importers and zero router branches — the failure mode
   (`tsc` error or test failure) is local and obvious. Design B
   restructures the live local-LLM code path that production users hit
   and changes test scaffolding; the failure mode (broken Ollama
   inference at runtime) is detected only by integration testing
   against a real local server.
2. **Cross-finding coherence**: G21 (provider-name list quadruple
   duplication) and G22 (dead `copilot` OAuth mapping) edit the same
   `router.ts` enumerations. Landing Design A first reduces the surface
   those findings touch (`openrouter` is excluded from the unified list
   by virtue of no class existing), making G21's refactor smaller and
   cleaner.
3. **Architecture-first does not mean "biggest refactor wins"**: The
   guideline forbids backward-compatibility shims and dead-code
   preservation; both designs honour it. Design A removes 703 LOC of
   dead code without restructuring live code, which is the minimum
   change that fully satisfies the no-dead-code rule.
4. **Design B remains tractable later**: Once Design A lands, the only
   reason `OpenAIProvider` still exists is to serve as an inheritance
   base. Renaming it to `OpenAICompatibleLocalProvider` (B.1) or folding
   the local-LLM path into PiAi (B.2) becomes a focused, well-scoped
   follow-up that can be filed as a new round-2 finding or addressed in
   round 3.

Plan in [03-plan-r1.md](03-plan-r1.md) implements Design A and records
B.1/B.2 as deferred follow-ups.
