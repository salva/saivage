# F01 B10 — RAG end-to-end tests

This directory holds the end-to-end harness for the RAG subsystem.

## Layout

- `fixtures/docs/` — 50 short markdown documents covering five topics
  (cats, dogs, astronomy, cooking, software architecture). Used as the
  ingest corpus by `e2e-ingest-query.test.ts`.
- `e2e-ingest-query.test.ts` — round-trips a fresh project through
  `register → ingest → query` against the real OpenAI embeddings API.
  **Gated on `OPENAI_API_KEY`**; skipped automatically when the variable
  is absent.
- `e2e-drift.test.ts` — purely offline; verifies that re-registering
  with a different `provider.dim` raises `ConfigDriftError` (or, on
  store-level mismatch, `EmbeddingDriftError`).

## Running

```bash
# Offline subset (CI default)
npx vitest run tests/rag

# Full e2e (requires a paid OpenAI API key with embeddings access)
OPENAI_API_KEY=sk-… npx vitest run tests/rag
```

## Manual smoke procedure

1. `export OPENAI_API_KEY=…` (read-only embeddings key is enough).
2. `mkdir -p tmp/rag-smoke && cd tmp/rag-smoke`
3. Copy `saivage/tests/rag/fixtures/docs` into `./docs`.
4. Write a tiny driver script that calls `createRagManager`, registers a
   dataset (`source: "doc"`, `dim: 256`), and runs an `ingest({ kind:
   "fs", root, include: ["docs/**/*.md"] })`.
5. Issue a few queries (`m.query("docs", "fluffy cats", { topK: 5 })`)
   and confirm at least one cat-topic chunk appears near the top.
6. Run the ingest a second time and confirm `filesChanged === 0`.
7. Drop the dataset with `m.drop("docs")` and confirm
   `<projectRoot>/.saivage/rag/docs/` is removed.

The fixtures are deliberately short (≈ 5 lines each) so the smoke run
costs ≤ 1¢ at current `text-embedding-3-small` pricing.
