# RAG Config Type Contract

## Problem

`npm run typecheck` currently fails in `src/server/bootstrap.ts` because runtime
config accepts any embedding model string, while several downstream RAG types and
input schemas only accept the literal `"text-embedding-3-small"`.

This makes the codebase fail its first correctness gate and reveals a broader
contract issue: config schemas and runtime types are not generated from the same
source of truth.

Current working-tree note: `src/config.ts` is already partially widened to accept
custom `provider.model`, arbitrary positive `provider.dim`, and optional
`provider.baseUrl` / `provider.apiKey`. That change is directionally correct but
incomplete until the downstream RAG contracts below are widened too.

## Options Considered

| Option | Pros | Cons |
| --- | --- | --- |
| Narrow config to only `"text-embedding-3-small"` | Fewest code edits. | Hard-codes support for one model and contradicts the intended configuration surface. |
| Widen downstream model and dimension contracts | Preserves the intended operator-configured model surface with little abstraction. | Requires updating all literal schemas/types and relying on drift checks for incompatible dimensions. |
| Introduce a model registry with model/dimension validation | Strongest validation. | More machinery than v2 needs unless many model-specific rules are required. |

## Chosen Approach

Widen the downstream RAG provider contract to match config: `model` is a
non-empty string and `dim` is a positive integer.

This keeps the code simple without falsely hard-coding support for a single
embedding model. A model registry is not needed yet; the persistent compatibility
key is the provider stamp (`provider`, `model`, `dim`, `releaseFingerprint`) and
the existing drift checks should reject incompatible index reuse.

## Design

- Keep `SaivageConfigSchema.rag.datasets[*].provider.model` as `z.string().min(1)`.
- Keep `SaivageConfigSchema.rag.datasets[*].provider.dim` as a positive integer.
- Keep optional `provider.baseUrl` and `provider.apiKey` in config if the runtime
  supports per-dataset embedding-provider overrides; treat `apiKey` as sensitive
  in all API/debug surfaces.
- Change RAG dataset/provider types so `provider.model` is `string`, not a
  literal.
- Change RAG dataset/provider types so `provider.dim` is `number`, not the
  `256 | 512 | 1024 | 1536` union tied to one model family.
- Widen RAG registration input schemas and TypeScript input types in the same
  way.
- Keep `dim` as the explicit compatibility key for vector store shape.
- Preserve existing drift checks around provider dimensions.
- `src/server/rag/service.ts` derives `RuntimeRagDatasetConfig` from
  `DatasetConfig`, so widening `DatasetConfig.provider` widens the runtime view
  without a separate type alias edit.

## Execution Plan

1. Preserve the existing partial `src/config.ts` widening; do not revert it.
2. Update `src/rag/types.ts`:
   - `EmbeddingProviderRef.model`: `"text-embedding-3-small"` -> `string`
   - `EmbeddingProviderRef.dim`: `256 | 512 | 1024 | 1536` -> `number`
3. Update `src/server/rag/handler.ts` registration schemas:
   - provider model: literal -> non-empty string
   - provider dim: literal union -> positive integer
4. Update `src/server/rag/tools/register.ts` input type in the same way.
5. Confirm `src/server/rag/service.ts` widens through its `DatasetConfig`
   dependency.
6. Update type-level/unit tests so a non-default model with explicit `dim` is
   accepted.
7. Update test fixture type annotations that currently rely on literal model or
   dimension unions; runtime values can remain `"text-embedding-3-small"` where
   the test is not about model selection.
8. Keep or add tests that drift detection includes model and dimension in the
   provider stamp.
9. Run `npm run typecheck`.
10. Run `npm test`.

## Validation

- `npm run typecheck`
- `npm test`
- Existing RAG drift tests must continue to pass and should prove that model or
  dimension changes are treated as provider-stamp drift.

## Risks

- A custom model with a wrong `dim` can still be configured. Without a model
  registry, Saivage cannot know every provider's valid model/dimension pairs.
  The clean v2 boundary is to require explicit `dim` and prevent accidental reuse
  of incompatible persisted vectors through drift checks.
