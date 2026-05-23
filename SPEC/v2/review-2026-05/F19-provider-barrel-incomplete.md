# F19 — `src/providers/index.ts` exports only 4 of 8 providers

**Category**: half-implemented
**Severity**: low
**Transversality**: module

## Summary

The provider barrel exports `BaseProvider`, `AnthropicProvider`, `OpenAIProvider`, `OllamaProvider`, `OpenRouterProvider`, and `ModelRouter`. The remaining four providers (`PiAiProvider`, `CopilotProvider`, `OpenAICodexProvider`, `LlamaCppProvider`) exist as files but are not exported. Anyone consuming `saivage` as a library must import them by deep path.

## Evidence

- Barrel: [src/providers/index.ts](src/providers/index.ts#L1-L7).
- The unlisted providers exist: [src/providers/pi-ai.ts](src/providers/pi-ai.ts), [src/providers/copilot.ts](src/providers/copilot.ts), [src/providers/openai-codex.ts](src/providers/openai-codex.ts), [src/providers/llamacpp.ts](src/providers/llamacpp.ts).
- The main barrel `src/index.ts` does re-export `bootstrap` and `startServer` but no provider type at all: [src/index.ts](src/index.ts#L79-L100).

## Why this matters

Inconsistent public API. Either the providers folder is internal (in which case `providers/index.ts` shouldn't exist at all) or it's public (in which case it should export everything). Today it exports a subset that happens to match what the unit-test file imports, which is a bad reason to draw the line.

## Related

- F02 (roster-style drift)
