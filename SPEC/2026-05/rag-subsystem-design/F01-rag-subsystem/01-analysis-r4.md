# F01 — RAG subsystem functional analysis

Scope: functional analysis only. No design, no implementation, no edits outside this folder. Honors the workspace rule "Architecture-first, no backward compatibility" and Saivage v2 constraints: Node 24+ (current LTS at time of writing; the existing `"engines": { "node": ">=20.0.0" }` pin in [saivage/package.json](saivage/package.json) will be raised by this work to match), ESM-only, TypeScript, providers wired via [@anthropic-ai/sdk](saivage/package.json#L28-L29), [openai](saivage/package.json#L38-L39), and [@mariozechner/pi-ai](saivage/package.json#L31-L32). The library entry points covered here are the dataset surfaces in [saivage/skills/builtin](saivage/skills/builtin), [saivage/src/knowledge/](saivage/src/knowledge/), and the multi-provider abstraction installed at [saivage/node_modules/@mariozechner/pi-ai](saivage/node_modules/@mariozechner/pi-ai).

Every `VERIFY:` marker in this document points at a public-fact, price, dimension, or rate-limit value the implementer must reconfirm against the cited URL before any design commits to a default. All latency, throughput, and cost numbers in this document are estimates derived from public vendor pages and reasonable hardware assumptions; the implementer MUST measure on the operator's actual host before tuning anything.

---

## 1. Use cases per candidate dataset

The RAG subsystem must serve three logically independent datasets. Each has its own corpus profile, query profile, freshness profile, and latency budget. The library must treat them as fully isolated collections; no cross-dataset assumptions.

### 1.1 Dataset A — Skills and memories (Saivage's own knowledge)

Producers: the existing knowledge layer in [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts), the built-in skills under [saivage/skills/builtin/](saivage/skills/builtin/), per-project memory notes under the per-project memory tree inside the .saivage directory, and the `KnowledgeRecord` shapes defined in [saivage/src/knowledge/types.ts](saivage/src/knowledge/types.ts).

Future consumers (not part of this work):

- Planner and manager loops that want to recall prior decisions and memories before drafting the next stage.
- Coder and researcher loops that want to recall the right skill (procedural how-to) for the current task.
- Inspector and critique agent roles inside the runtime (Saivage product terms naming agent personas) that want to recall prior critiques on the same artifact.

Query archetypes:

- "Find skills about <topic>" — semantic match over SKILL.md descriptions and bodies.
- "Find memories where the agent has hit <symptom> before" — semantic match on memory bodies, filtered by scope (`project`, `stage`, `session`).
- "Find memories about <subsystem> authored by role=checker in the last 30 days" — semantic with metadata filter.

Corpus arithmetic (verified counts at this commit):

- Built-in skills directory listing yields 3 `SKILL.md` files under [saivage/skills/builtin/](saivage/skills/builtin/). Realistic growth ceiling over the next year: ~100 SKILL.md files at ~300 lines each. At a conservative 5 tokens per line that is 100 × 300 × 5 ≈ 150k tokens. After chunking (one skill ≈ 1 chunk in the small case, 2–3 chunks when skill bodies grow past 800 tokens), ~150–300 chunks.
- Existing knowledge module surface: 15 `.ts` files under [saivage/src/knowledge/](saivage/src/knowledge/). These are not corpus, they are the producer code; counted here only to size the producer-side change surface, not the index.
- Per-project memory steady-state, extrapolated from observed shape under [saivage-v3/.saivage/](saivage-v3/.saivage/) and the `KnowledgeRecord` lifecycle in [saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts): 200–2000 records per long-lived project, average body 400 tokens. Per project: 200 × 400 = 80k tokens at the low end; 2000 × 400 = 800k tokens at the high end. At one-chunk-per-memory (see §5.3), per project: 200–2000 chunks.
- Skills + memories combined across all active projects on a host: 5k–10k chunks, 2M–5M tokens. Small enough that brute-force vector search is dominated by network embedding latency, not by store work.

Latency targets:

- Skills lookup runs at most once per agent turn. Budget: end-to-end retrieval (embed query + vector search + metadata filter + hydration) under 150 ms p50, under 400 ms p95.
- Memory recall is on the agent reasoning hot path. Same budget.

Freshness:

- Skills change rarely. Re-ingest on file mtime change is sufficient.
- Memories change frequently (every supersede or archive in [saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts)) but per-change volume is tiny (1 record). The RAG layer must accept incremental upserts and hard deletes synchronously, not in a nightly batch.

Multi-tenancy boundary: per project. The library must allow one logical collection identified by something equivalent to `skills-memories::<projectId>`. Cross-project recall is out of scope until an operator explicitly asks for it.

### 1.2 Dataset B — Target-project documentation

Producers: the target project's hand-written documentation tree. Typical producer patterns:

```
docs/
README.md
AGENTS.md
SPEC/**
inspections/
```

Realistic example directories: [saivage/docs/](saivage/docs/), [getrich/docs/](getrich/docs/), [getrich-v2/docs/](getrich-v2/docs/), [diedrico/docs/](diedrico/docs/), [diedrico/specs/](diedrico/specs/).

Generated TypeDoc output must be excluded. Verified split for [saivage/docs/](saivage/docs/): 48 hand-written markdown files outside [saivage/docs/api/](saivage/docs/api/), and 232 generated files under [saivage/docs/api/](saivage/docs/api/). The ingest layer must exclude the equivalent generated trees by default; the operator can override per dataset. Default exclusion glob:

```
docs/api/**
```

Future consumers: any agent role that has to operate on the target project and needs prose context (architecture notes, ADRs, glossary, dataset definitions, spec files).

Query archetypes:

- "What does this project mean by `<term>`?" — definitional, expects a short paragraph.
- "Where is the spec for feature X?" — location-finding, expects file paths to be in the chunk metadata so the caller can `open` them.
- "Summarize the architecture of subsystem Y" — needs top-k passages from multiple documents to build a prompt context window.

Corpus arithmetic:

- Small target (getrich-v2): ~10 markdown files in [getrich-v2/docs/](getrich-v2/docs/), 30k–80k tokens after stripping YAML front matter.
- Medium target (saivage hand-written docs): 48 hand-written files × ~800 lines × ~5 tokens/line ≈ 190k tokens, rounded up to 200k–800k tokens to cover bigger files like the SPEC tree.
- Large hypothetical (mlflow-style codebase docs): 500–2000 files, 2M–8M tokens.
- Realistic design ceiling per project: 10k–50k chunks. Subtract generated typedoc; the upper bound is reached only when both the SPEC tree and `inspections/` grow large.

Latency targets: docs lookups feed agent prompts at stage start. Budget 300 ms p50, 800 ms p95.

Freshness: docs change as the project evolves. Polling on file mtime + content hash at agent-start is acceptable; no file-watcher daemon is required.

Multi-tenancy boundary: per target project. Two open projects must have isolated docs collections on disk.

### 1.3 Dataset C — Target-project source code

Producers: the target project's source tree. Typical producer globs:

```
src/**/*.ts
**/*.py
frontend/src/**/*.vue
```


Future consumers: coder, critique, inspector agent roles wanting "show me functions related to X" or "find places that already call this API."

Query archetypes:

- "Find code that handles `<concept>`" — semantic.
- "Find usages of symbol `<name>`" — lexical. Poorly served by embeddings. The RAG layer does not promise to handle this; ripgrep and the language server remain superior. See §5.2.
- "Find the implementation of the function that does X" — semantic, expected to land on a definition span.

Corpus arithmetic:

- Saivage v2 itself: 172 `.ts` files under [saivage/src/](saivage/src/). At ~250 lines per file average × 6 tokens/line ≈ 258k tokens. Chunked at 400 tokens with ~15% overlap, ~750 chunks.
- A medium TypeScript or Python project: 500 files × 300 lines × 6 tokens/line ≈ 900k tokens, ~2500 chunks.
- A large hypothetical (mlflow main package): thousands of files, 5M–20M tokens, 15k–60k chunks.
- Realistic design ceiling per target-project source dataset: 100k chunks at the upper bound; 500k chunks only in pathological cases. Still small enough for an in-process index without ANN tricks at the lower end of that range.

Latency targets: code search runs interactively in agent loops. Budget 300 ms p50, 1000 ms p95.

Freshness: code changes on every commit and every coder loop iteration. Incremental re-ingest on file mtime + sha256 is mandatory; full reindex stays a recovery operation. When the agent edits a file, the embed-and-upsert for changed chunks runs in the background within seconds — not in the agent's response path.

Multi-tenancy boundary: per target-project, with `language` carried as metadata (so "find Python code" is a filter, not a separate collection).

### 1.4 Cross-cutting observations

- All three datasets are bounded. Even pessimistic ceilings fit on one machine in a single embedded vector store. No sharding, no distributed index.
- Query rates are agent-driven, not user-search QPS. Single-digit sustained QPS, with bursts under 50 QPS during multi-agent stages. Any embedded store handles this trivially; the bottleneck on bursts is the hosted embedding endpoint, not the store.
- Recall@10 matters more than recall@1. The agent reads several chunks and re-ranks with its own attention. This relaxes the embedding-quality bar and makes a smaller, cheaper embedding model viable for the default.
- Every result chunk must carry the original source path and line span back to the caller. Downstream agents open files; metadata schema must guarantee this (§5.4).

### 1.5 Why the three datasets stay separate

Tempting alternative: one collection, `source` discriminator, query once, filter post-hoc. Rejected here because:

- Chunkers differ irreducibly (code AST vs. markdown headers vs. memory-as-atomic). A single collection forces a polymorphic chunker abstraction with no upside.
- Embedding-model choice can legitimately differ per dataset (e.g. code-specialized model for Dataset C, general model for A and B). One collection forces one model across all sources, locking out specialization.
- Lifecycle ops ("drop skills, keep docs") are common operator wishes and trivial when collections are physically separate.
- Smaller per-dataset indexes do strictly less work per query than one combined index plus a filter, regardless of how the store implements pre- vs. post-filtering.

### 1.6 Query archetypes the design must serve

Across the three datasets, the agent loops generate a small number of recurring query archetypes. Each places different demands on filtering and ranking, and the public surface (§6) must satisfy all of them through a single uniform query operation:

- **Skill recall** ("how do I do X in this workspace"): semantic match against dataset A, filtered by `kind = 'skill'` and optionally by `scope`. Top-K small (3–5). Recall@5 dominates.
- **Memory recall under symptom** ("have I hit error pattern Y before"): semantic match against dataset A's memories, filtered by `kind = 'memory'`, optionally `scope = 'project'` and a recency window on `createdAt`. Top-K small (5–10). Recency is a filter, not a ranking signal in v1.
- **Doc lookup by intent** ("what does the architecture say about caching"): semantic match against dataset B, filtered by `path glob` if the agent already narrowed the area (e.g. an architecture-docs subtree under the docs directory). Top-K mid (10–20). Recall@10 dominates.
- **Code symbol or behaviour lookup** ("find the function that parses JSON-RPC requests"): semantic match against dataset C, filtered by `language` and optionally `path glob`. Top-K mid (10–30) because the agent reads several candidates before picking. Recall@10 dominates; rerankers explicitly out of scope (§6.5).
- **Previous critique lookup** ("what did the critique agent say about this artifact last time"): semantic match against dataset A's memories, filtered by `role = 'checker'` and a recency window. Top-K small (3–5).
- **Cross-dataset query** ("anything in skills, docs, or code about retries"): the agent issues three separate `dataset.query` calls and merges results client-side. The library does NOT provide a single cross-dataset entry point (§6.5); the call-site is explicit about which sources it consulted.

The metadata schema (§5.4) must support every filter expression listed above without ad-hoc extensions. The store-adapter must implement filtering in the most efficient mode available to each backend (§4.10).

---

## 2. Embeddings provider survey (hosted)

The Saivage runtime already wires three providers: Anthropic via [@anthropic-ai/sdk](saivage/package.json#L28-L29), OpenAI via [openai](saivage/package.json#L38-L39), and a multi-provider abstraction via [@mariozechner/pi-ai](saivage/package.json#L31-L32). This survey covers those three plus the other hosted providers a future operator might point Saivage at.

Every numeric value in the tables below has a `VERIFY:` footnote with the URL the implementer must check before locking it in. The numbers are taken from publicly documented vendor pages and may be stale; this analysis explicitly refuses to fabricate values not present in the implementer's training data and flags rows that the implementer must reconfirm rather than invent.

### 2.1 Anthropic

Anthropic does NOT offer a public embeddings API as of writing (VERIFY). Their published documentation directs callers to Voyage AI for embeddings paired with Claude for generation. The `@anthropic-ai/sdk` exposes Messages and Files APIs but no `embeddings.create`.

VERIFY: confirm Anthropic still publishes no public `/v1/embeddings` endpoint at [docs.anthropic.com/en/docs/build-with-claude/embeddings](https://docs.anthropic.com/en/docs/build-with-claude/embeddings). If they have launched one, re-score this row.

Implication: the embedding-provider config slot is independent of the generation-provider config slot. The two MUST stay independent in any later design.

### 2.2 OpenAI

OpenAI ships stable, well-documented embedding models exposed through the `openai` SDK already in [saivage/package.json](saivage/package.json#L38-L39).

| Model | Native dim | Truncatable to | Price per 1M input tokens | Max input tokens | Notes |
|---|---|---|---|---|---|
| `text-embedding-3-small` | 1536 | 256 / 512 / 1024 via `dimensions` param | ~$0.02 | 8191 | Cheap default candidate. |
| `text-embedding-3-large` | 3072 | 256 / 1024 / 3072 | ~$0.13 | 8191 | Higher quality, ~6.5x more expensive. |
| `text-embedding-ada-002` | 1536 | not truncatable | ~$0.10 | 8191 | Legacy; ignore (no backward-compat to honor). |

VERIFY: model list, dimensions, prices, and max-token windows at [platform.openai.com/docs/guides/embeddings](https://platform.openai.com/docs/guides/embeddings) and [openai.com/api/pricing](https://openai.com/api/pricing).

Rate limits: OpenAI rate limits are account-, tier-, and model-specific. Published per-tier defaults for embeddings sit on the order of 500k–5M TPM and 500–10000 RPM at tier 1 for `text-embedding-3-small`, escalating per tier. These are NOT a stable design input.

VERIFY: the operator's actual TPM and RPM ceilings for each embedding model at [platform.openai.com/account/limits](https://platform.openai.com/account/limits) (account-specific; the design must read this at runtime via 429+Retry-After, not hard-code).

Cost calibration at Saivage scale: a full re-ingest of a 5M-token corpus on `text-embedding-3-small` costs ~$0.10. Daily incremental re-ingest of memories (≤100k tokens) is fractions of a cent. Monetary cost does not differentiate hosted choices at this scale.

Truncatable dimensionality is a real lever: 512-d instead of 1536-d shrinks the index ~3x and speeds search proportionally with a small recall loss (OpenAI's MTEB numbers suggest single-digit percentage points on retrieval tasks; the implementer should re-benchmark on the actual corpus).

### 2.3 Google (Vertex AI / Generative Language API)

Example candidate pending implementer verification; rows below must be reconfirmed before being used as a design input.

| Model | Native dim | Truncatable | Price per 1M input tokens | Max input tokens | Notes |
|---|---|---|---|---|---|
| `text-embedding-005` | 768 | n/a | ~$0.025 | 2048 | Older PaLM-family. |
| `gemini-embedding-001` | 3072 | Matryoshka 256 / 768 / 1536 / 3072 | ~$0.15 | ~2048 | Released 2025; quality leader on some MTEB tasks at release. |

VERIFY: model availability, prices, dimensions, and max-token windows at [ai.google.dev/gemini-api/docs/embeddings](https://ai.google.dev/gemini-api/docs/embeddings) and [cloud.google.com/vertex-ai/generative-ai/pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing).

Rate limits: per-project, per-region, per-model. Vertex publishes default quotas (commonly on the order of 1500 RPM at the Generative Language API tier and significantly higher with Vertex projects). The design must treat these as account-bound facts.

VERIFY: current TPM/RPM defaults and any free-tier caveat at [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits).

Saivage v2 does not currently depend on a Google SDK. Adding `@google/generative-ai` solely for embeddings is one extra direct dependency. Routing through [@mariozechner/pi-ai](saivage/package.json#L31-L32) is preferable if pi-ai exposes an embeddings surface for Google (see §2.8).

### 2.4 Cohere

Example candidate pending implementer verification; rows below must be reconfirmed before being used as a design input.

| Model | Native dim | Truncatable | Price per 1M input tokens | Max input tokens | Notes |
|---|---|---|---|---|---|
| `embed-english-v3.0` | 1024 | n/a | ~$0.10 | 512 | Asymmetric (`input_type` flag). |
| `embed-english-light-v3.0` | 384 | n/a | ~$0.10 | 512 | Cheaper to store/search; same line-rate. |
| `embed-multilingual-v3.0` | 1024 | n/a | ~$0.10 | 512 | Multilingual. |
| `embed-v4.0` | 256 / 512 / 1024 / 1536 (Matryoshka) | yes | ~$0.12 | 128k (image+text) | Multimodal, longest context. |

VERIFY: current v4 line, dimensions, prices, and max input tokens at [docs.cohere.com/docs/embed](https://docs.cohere.com/docs/embed) and [cohere.com/pricing](https://cohere.com/pricing).

Rate limits: Cohere publishes trial vs. production tiers. Production limits commonly sit at ~10000 RPM for embed endpoints. VERIFY at [docs.cohere.com/docs/rate-limits](https://docs.cohere.com/docs/rate-limits).

Cohere supports an `input_type` parameter (`search_document` vs. `search_query`) that produces asymmetric embeddings, measurably better for retrieval on Cohere-style models. The design must pass the correct type when embedding queries vs. documents; providers that do not support it ignore the hint internally.

### 2.5 Voyage AI

Example candidate pending implementer verification; rows below must be reconfirmed before being used as a design input.

| Model | Native dim | Truncatable | Price per 1M input tokens | Max input tokens | Notes |
|---|---|---|---|---|---|
| `voyage-3-lite` | 512 | n/a | ~$0.02 | 32000 | Cheapest at Voyage. |
| `voyage-3` | 1024 | n/a | ~$0.06 | 32000 | Mid-tier general. |
| `voyage-3-large` | 1024 | yes (Matryoshka per docs) | ~$0.18 | 32000 | High-quality general. |
| `voyage-code-3` | 1024 | yes (Matryoshka per docs) | ~$0.18 | 32000 | Code-specialized; relevant for Dataset C. |

VERIFY: the exact current model list (Voyage has released and deprecated models on a rolling basis; `voyage-3.5`-family or successors may already be the documented current line), dimensions, prices, max-input tokens, and any Matryoshka support at [docs.voyageai.com/docs/embeddings](https://docs.voyageai.com/docs/embeddings) and [docs.voyageai.com/docs/pricing](https://docs.voyageai.com/docs/pricing). Do NOT assume the v3 family above is still current.

VERIFY: per-key rate limits at [docs.voyageai.com/docs/rate-limits](https://docs.voyageai.com/docs/rate-limits).

For Dataset C (code), Voyage's code-specialized model typically outperforms generic embeddings on CodeSearchNet-style benchmarks by several nDCG@10 points. VERIFY current numbers on the implementer's own benchmark before relying on this.

### 2.6 Mistral

Example candidate pending implementer verification; rows below must be reconfirmed before being used as a design input.

| Model | Native dim | Truncatable | Price per 1M input tokens | Max input tokens | Notes |
|---|---|---|---|---|---|
| `mistral-embed` | 1024 | n/a | ~$0.10 | 8192 | General-purpose. |
| `codestral-embed` | up to 1536 (per release notes) | reported Matryoshka | ~$0.15 | 8192 | Code-specialized; verify availability. |

VERIFY: model availability (`codestral-embed` was announced separately from `mistral-embed` and the public GA surface has fluctuated), dimensions, prices, and max input tokens at [docs.mistral.ai/capabilities/embeddings](https://docs.mistral.ai/capabilities/embeddings) and [mistral.ai/pricing](https://mistral.ai/pricing).

VERIFY: rate limits at [docs.mistral.ai/deployment/laplateforme/overview](https://docs.mistral.ai/deployment/laplateforme/overview).

Mistral exposes an OpenAI-compatible endpoint; no extra SDK dep is needed if routing through pi-ai.

### 2.7 OpenAI-compatible aggregators (Together, Fireworks, DeepInfra)

Example candidates pending implementer verification; rows below must be reconfirmed before being used as a design input.

These hosts proxy popular open embedding models behind the OpenAI embeddings wire format. Pricing is typically an order of magnitude cheaper than first-party APIs because the underlying models are open-weight.

| Aggregator | Representative model | Native dim | Truncatable | Price per 1M input tokens | Notes |
|---|---|---|---|---|---|
| Together | `BAAI/bge-large-en-v1.5` | 1024 | n/a | ~$0.01 | OpenAI-compatible base URL. |
| Together | `togethercomputer/m2-bert-80M-32k-retrieval` | 768 | n/a | ~$0.01 | Long context. |
| Fireworks | `nomic-ai/nomic-embed-text-v1.5` | 768 (Matryoshka-truncatable) | yes | ~$0.008 | OpenAI-compatible. |
| DeepInfra | `BAAI/bge-large-en-v1.5` | 1024 | n/a | ~$0.005–0.01 | OpenAI-compatible. |
| DeepInfra | `intfloat/e5-mistral-7b-instruct` | 4096 | n/a | ~$0.10 | High-quality, expensive at 4096-d storage. |

VERIFY: each aggregator's current embedding catalog, prices, and rate limits at [docs.together.ai/docs/embedding-models](https://docs.together.ai/docs/embedding-models), [fireworks.ai/pricing](https://fireworks.ai/pricing), and [deepinfra.com/models](https://deepinfra.com/models).

These are interesting because the same model can later run locally (§3), enabling hosted-to-local cutover. That cutover preserves the embedding space only if the hosted runtime and the local runtime produce byte-identical vectors — same model release fingerprint, same tokenizer, same pooling, same normalization, same prompt prefix. Same model name alone does NOT guarantee this. The design must record the full provider+model+releaseFingerprint tuple in store metadata and refuse to mix on mismatch (see §5.6).

### 2.8 pi-ai routing

[@mariozechner/pi-ai](saivage/package.json#L31-L32) is the multi-provider abstraction the Saivage runtime uses for chat completions and tool calls.

VERIFY: whether pi-ai exposes an embeddings surface at all (the `dist/` of the installed version should be inspected for an `embeddings`-shaped export), and for which providers. Treat this as unknown until inspected. If pi-ai exposes embeddings: route through it for consistency with the rest of Saivage's provider config. If it does not: the design must define a thin embedding-provider interface that lives alongside pi-ai rather than inside it. Do not assume parity with pi-ai's chat-completions provider list.

Inspection target for the implementer: the installed package directory [saivage/node_modules/@mariozechner/pi-ai](saivage/node_modules/@mariozechner/pi-ai). Listing pattern:

```
saivage/node_modules/@mariozechner/pi-ai/dist
```

Grep the exported surface for `embed` and cross-check against the upstream repo's README.

### 2.9 Cheapest-reasonable default at Saivage scale

The only currently-defensible default recommendation at this analysis level is **OpenAI `text-embedding-3-small` at native 1536-d**: it is already wired through [openai](saivage/package.json#L38-L39), priced at ~$0.02 per 1M tokens, supports public dimensionality reduction, has a well-understood rate-limit shape, and has stable model identifiers. It is the default for the focused design.

The alternatives below are example candidates only, contingent on the implementer running the VERIFY items in §2.2–2.7 before any of them is promoted to a real recommendation:

1. OpenAI `text-embedding-3-small` at 512-d — same provider, smaller index, faster search. Plausible override for very large code corpora where the recall hit is acceptable.
2. Voyage `voyage-code-3` (or the current Voyage code-specialized successor) — plausibly best quality-for-cost on Dataset C specifically; verify model lineup and benchmark standing before recommending.
3. OpenAI-compatible aggregator (Together / Fireworks / DeepInfra) hosting BGE-large or Nomic — plausibly cheapest with lowest vendor lock-in and a smooth path to fully-local later; verify current catalogs, prices, and rate limits.

Anthropic is explicitly excluded as an embeddings provider because no such API exists (VERIFY).

---

## 3. Local embedding options

Local embedding is in scope as a design seam (the abstraction must support it) but explicitly out of scope as an integration deliverable. The goal of this section: pick the candidate the design seam should be shaped around so a future operator can plug it in without re-architecting.

### 3.1 Transformers.js (`@xenova/transformers`, recent fork `@huggingface/transformers`)

Pure-Node ONNX runtime that loads sentence-transformer models from Hugging Face Hub or local disk. CPU by default; GPU/WebGPU paths exist but require non-trivial setup. ESM and TypeScript types are first-class.

- Install footprint: ~50–100 MB of npm deps; model files downloaded lazily (BGE-small ≈ 130 MB, BGE-large ≈ 440 MB, all-MiniLM-L6-v2 ≈ 25 MB).
- Models commonly used: `Xenova/all-MiniLM-L6-v2` (384-d), `Xenova/bge-small-en-v1.5` (384-d), `Xenova/bge-base-en-v1.5` (768-d), `Xenova/multilingual-e5-small` (384-d).
- CPU throughput estimate (single thread, modern x86 laptop): 50–200 chunks/sec for MiniLM-L6, 20–60 chunks/sec for BGE-small, 5–20 chunks/sec for BGE-large. These are estimates pending measurement.
- License: runtime Apache-2.0; models per their own license.

CRITICAL: local embedding is CPU-bound. Running it on Saivage's main event loop blocks every other handler. The design MUST run local embedding through `worker_threads`, or keep local embedding strictly off the focused design entirely. This is the single biggest reason in-process hosted-only is the minimal default and local-embedding integration is deferred.

Score: top candidate for the "designed-in but not implemented" local option.

### 3.2 fastembed-js

Node bindings to the Rust `fastembed` library. Curated model set, faster than Transformers.js on CPU in some cases. Historically CJS-leaning; ESM compatibility must be verified against the current release. Reject as primary, keep as alternative.

### 3.3 Ollama `/api/embed`

Saivage talks to an Ollama daemon over HTTP. No npm dep on Saivage's side beyond `fetch`. Ollama itself is a separate install. Models: `nomic-embed-text` (768-d, 8k context), `mxbai-embed-large` (1024-d), `snowflake-arctic-embed`, etc. CPU throughput comparable to Transformers.js with batching. Adds a daemon, which is exactly what the F01 minimalism constraint pushes back on; recommended only as "operator already has Ollama" fallback.

### 3.4 llama.cpp embedding server

`llama-server --embedding` exposes OpenAI-compatible embeddings. Most powerful with GPU. Install complexity highest of these. Recommended only as "operator already runs llama-server, points OpenAI-compatible client at it" mode.

### 3.5 Comparison summary

| Option | Install on Linux | Default dim | CPU throughput estimate | JS/TS ergonomics | Daemon? |
|---|---|---|---|---|---|
| Transformers.js | `npm i @xenova/transformers` | 384–768 | 50–200 chunks/s (small) | Excellent (ESM, TS) | No |
| fastembed-js | npm + Rust prebuilds | 384–1024 | 100–300 chunks/s | Good (CJS-leaning) | No |
| Ollama | curl-install + `ollama pull` | 384–1024 | 50–150 chunks/s | Excellent (HTTP) | Yes |
| llama.cpp server | apt or source build | 384–1024 | varies | Excellent (OpenAI-compatible) | Yes |

### 3.6 Designed-in recommendation

Shape the abstraction to make Transformers.js the smoothest local plug-in:

- No daemon assumption.
- Model name is a string in config; no provider-name hard-coded in the embedding-provider interface.
- Dimensions are a property of the configured provider, stored alongside the index, and validated on every open.
- Query and document embedding are separate calls in the interface (Cohere-style `input_type`); providers that do not differentiate ignore the role parameter.
- A worker-thread offload point is reserved in the in-process design so local embedding can be introduced later without restructuring the request path.

---

## 4. Vector store survey for embedded JS/TS use

Constraints (from [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md)):

- Embedded preferred. npm package or a single small local binary.
- Easy install on Linux (apt or pure-npm; no Docker requirement).
- Multi-tenancy across datasets mandatory.
- Filterable metadata mandatory (scope, project, role, mtime, path).
- ANN only needs to scale to ~100k vectors per collection initially, with headroom to ~1M.
- License must allow embedding in Saivage (Apache-2.0, MIT, BSD, MPL acceptable; AGPL not).

### 4.1 sqlite-vec (with better-sqlite3)

`sqlite-vec` is a loadable SQLite extension by Alex Garcia exposing `vec0` virtual tables. The npm package [sqlite-vec](https://www.npmjs.com/package/sqlite-vec) bundles prebuilt extension binaries and helpers for loading the extension into a `better-sqlite3` connection.

Important corrections to common claims:

- ANN: as of 2026-05, sqlite-vec's primary `vec0` virtual table provides **brute-force exact KNN** (cosine, L2, dot). IVF/HNSW/other ANN indexes have been discussed and partially landed in development branches but are NOT a stable baseline to design around. VERIFY at [github.com/asg017/sqlite-vec/releases](https://github.com/asg017/sqlite-vec/releases) and the project's CHANGELOG. The design must assume brute-force exact KNN.
- Persistence: a single `.db` file per dataset. Backup is `cp`, or `VACUUM INTO 'backup.db'` for an online snapshot.
- Multi-collection: one virtual table per dataset (operator-facing concept "dataset" ↔ implementation concept "virtual table"). Multiple `vec0` tables can coexist in the same `.db` file, but per-dataset `.db` files keep lifecycle ops simple.
- Metadata filtering: NOT a built-in feature of `vec0` in the sense of a payload schema. The pattern is: a sibling ordinary SQLite table holds metadata keyed by the same rowid as the vector, and the implementer composes filtering as a SQL `WHERE` clause joining the two. This is post-filter relative to the KNN scan when the join is applied after the MATCH, and pre-filter when the implementer issues an indexed `WHERE` first and feeds candidate rowids into the vector match. Both patterns are well within standard SQL; the design must pick one explicitly per query shape.
- Runtime path: load into `better-sqlite3`. Node 24 ships `node:sqlite` as a stable substrate and the implementer MAY evaluate it alongside `better-sqlite3`. The primary recommendation remains `better-sqlite3` on the rationale of ecosystem maturity and loadable-extension distribution: the `sqlite-vec` npm package and the wider third-party SQLite-extension ecosystem document and test their loader path against `better-sqlite3`'s `loadExtension` hook today, and `better-sqlite3` ships prebuilt native binaries across common arches, a fully synchronous TypeScript-typed API, and plays well with the sync style of [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts). If a future implementer demonstrates equivalent extension-loading ergonomics on `node:sqlite`, switching is a store-adapter change, not a public-surface change.
- Scaling ceiling: brute-force exact KNN at 1536-d on 100k vectors typically completes in single-digit to low-double-digit milliseconds on a single x86 core; at 1M vectors, tens to a few hundred milliseconds. VERIFY on the operator's hardware before promising any p95.
- License: Apache-2.0 (`sqlite-vec`), MIT (`better-sqlite3`).

Score: best fit. Embedded, pure-npm install, SQL filters, single-file persistence per project. Top candidate, with the explicit caveat that ANN is brute force at the scales we care about.

### 4.2 LanceDB (`@lancedb/lancedb`)

Embedded columnar store with vector and lexical search, written in Rust, exposed via Node bindings on npm.

- Install: native module with prebuilds for common arches (~30–50 MB). Pure npm install.
- Persistence model: directory of Lance files (Arrow + Parquet on disk). Backup is a directory copy.
- Multi-collection: native (tables within a database).
- Metadata filtering: SQL-like predicate strings (`.search(vec).where("scope = 'project'").limit(10)`).
- ANN algorithm: IVF_PQ (the canonical Lance ANN). Brute force is available when no ANN index is built. BM25 / full-text index is supported in recent versions if hybrid is ever wanted.
- Scaling ceiling: comfortably 10M+ vectors. Overkill for Saivage, but a clean upgrade path.
- License: Apache-2.0.

Score: strong fallback. Native ANN (IVF_PQ) plus native BM25 keep options open if Saivage ever outgrows sqlite-vec's brute-force scan.

### 4.3 hnswlib-node

In-memory HNSW index. No built-in persistence beyond manual `writeIndex(path)` / `readIndex(path)`. No metadata store; the caller maintains it. Filterable metadata: not supported in-index — only post-filtering. Score: rejected. Pairing it with a separate metadata store reinvents sqlite-vec or LanceDB poorly.

### 4.4 ChromaDB

As of recent versions, the JavaScript `chromadb` client REQUIRES a separate Chroma server (typically port 8000), run as a process or container. The "embedded mode" that Python `PersistentClient` provides is NOT available in the Node client. Score: rejected. F01 forbids a separate DB server unless absolutely required.

### 4.5 Qdrant (local)

Requires the Qdrant binary or container as a separate process. Excellent SDK (`@qdrant/js-client-rest`), excellent payload filters, HNSW. Score: rejected by the same "no separate server unless absolutely required" rule.

### 4.6 pgvector

Requires Postgres. Rejected by the minimalism constraint.

### 4.7 Other candidates considered and rejected

- USearch (`usearch` npm): single-header C++ ANN; no metadata store — same shape problem as hnswlib-node.
- Milvus Lite via `@zilliz/milvus2-sdk-node`: heavier dep tree, less mature Node story than sqlite-vec/LanceDB.
- Weaviate embedded: Java runtime; install footprint prohibitive.
- `faiss-node`: native module, no metadata, brittle Node bindings historically.

### 4.8 Scoring summary

Scoring rubric (1–5, 5 best) against the F01 constraints. Columns: install simplicity, JS/TS API, metadata filtering, multi-collection, scale fit, license.

| Store | Install | TS API | Filtering | Multi-coll | Scale fit | License | Verdict |
|---|---|---|---|---|---|---|---|
| sqlite-vec + better-sqlite3 | 5 | 5 | 5 (via SQL join) | 5 | 5 (at Saivage scale, brute force) | 5 | **Primary** |
| LanceDB (`@lancedb/lancedb`) | 4 | 5 | 5 | 5 | 5 (IVF_PQ + BM25 headroom) | 5 | **Fallback** |
| hnswlib-node | 5 | 2 | 1 | 2 | 3 | 5 | Reject |
| ChromaDB (Node) | 2 | 4 | 4 | 5 | 5 | 5 | Reject (server) |
| Qdrant local | 2 | 5 | 5 | 5 | 5 | 5 | Reject (server) |
| pgvector | 1 | 4 | 5 | 5 | 5 | 5 | Reject (server) |
| USearch / faiss-node | 4 | 2 | 1 | 2 | 4 | 5 | Reject (no metadata) |
| Milvus Lite (Node) | 2 | 3 | 4 | 5 | 5 | Apache-2.0 | Reject (immature) |

### 4.9 Primary + fallback recommendation

- **Primary: sqlite-vec on better-sqlite3.** Justification: single `.db` file per dataset under `<projectRoot>/.saivage/rag/`, full SQL filtering via a sibling metadata table, synchronous API that matches the existing knowledge-store style in [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts), trivial backup, no daemon, brute-force exact KNN is fast enough at the §1 corpus sizes.
- **Fallback: LanceDB (`@lancedb/lancedb`).** Justification: same install profile, native IVF_PQ for larger corpora, native BM25 if hybrid retrieval ever becomes warranted, clean directory-per-dataset layout that drops in behind the same store-adapter interface.

Both stores share enough properties (embedded, multi-collection, metadata-filterable, ranked vector retrieval) that one adapter interface covers both. The shared denominator is brute-force-or-ANN ranked retrieval plus structured-metadata filtering — NOT "ANN with payload filters," because the primary does not provide ANN.

### 4.10 Filtering patterns for sqlite-vec

Filtering at retrieval has three distinct shapes, with different recall and latency profiles. Calling them all "metadata filtering" hides cost differences the implementer must reason about:

| Filter shape | sqlite-vec pattern | Recall implication | Latency implication |
|---|---|---|---|
| Highly selective equality (`projectId = ?`) | Pre-filter: SELECT candidate rowids from the metadata sibling, then `MATCH` only over those rowids using a `rowid IN (...)` subquery. | No recall loss vs. brute force on the full corpus. | Strictly faster than full brute force when the filter prunes the corpus below the natural ANN-vs-brute-force crossover point. |
| Mid-selectivity (`source = 'memory' AND scope = 'project'`) | Same pre-filter pattern. | No recall loss. | Faster when selectivity is high; identical to brute force when the predicate barely prunes. |
| Low-selectivity (`createdAt > ?` matching most rows) | Post-filter: full `MATCH` returning K' = K × overshoot rows, then SQL `WHERE` to whittle to K. | Slight recall loss if K' is set too small. The implementer must size K' against expected filter selectivity. | Cost of the search dominates; post-filter adds negligible overhead. |

The store-adapter must expose these two patterns (`pre-filter` vs `post-filter`) as an internal decision based on the filter shape, NOT as a caller knob. The caller sees only the filter expression.

For LanceDB, the equivalent decision is handled by Lance's planner — the implementer just passes `.where(...)` and the engine picks pre- vs post-filter. The store-adapter abstraction must accommodate both control surfaces without leaking the difference to callers.

---

## 5. Chunking and ingestion strategy

Chunking, metadata, and idempotency are the three places where naïve RAG implementations rot fastest. This section sets the rules; the module boundaries are formalized in the subsystem design.

### 5.1 Prose / markdown chunking

Source materials: Dataset A memory bodies, Dataset B docs.

Strategy:

- Header-recursive splitter. Walk the document, split on H1 first, then H2, then H3. Each section becomes a candidate chunk.
- Target chunk size band: 400–800 tokens. Justification: sits comfortably under every considered embedding model's input window (Cohere v3 at 512 tokens is the tightest considered model, see §2.4; large-window models like Voyage 32k or Cohere v4 128k go unused at this size — that is fine), large enough to carry a section's semantic context, small enough that top-k of 5–10 chunks fits in a typical agent prompt budget.
- If a section exceeds 800 tokens: recurse into H4, then paragraphs, then sentence boundaries. Stop when the chunk fits.
- If a section is under ~100 tokens: greedy concatenate with the previous sibling under the same parent heading until the chunk reaches 400 tokens or runs out of siblings.
- Overlap: ~15% (60–120 tokens) between adjacent chunks produced by the recursive split path. Justification: prevents a definition or table from being cut between two chunks; 15% is a widely-used heuristic that balances duplication cost against boundary-loss risk. Pure header-derived chunks need no overlap because sections are already self-contained.
- Always retain the heading path as a string in chunk metadata (e.g. `"H1 > H2 > H3"`). The agent prompt builder uses it for context labelling.

YAML front matter, HTML comments, and fenced code blocks ride along with their surrounding prose chunk. Code fences inside markdown are NOT specially re-embedded with a code model.

### 5.2 Code chunking

Source materials: Dataset C source files.

Strategy:

- Preferred: AST-aware chunking via `tree-sitter` (Node bindings: `tree-sitter` plus grammar packages such as `tree-sitter-typescript`, `tree-sitter-python`). Walk the AST, emit one chunk per top-level declaration (function, class, method, exported const).
- Boundary heuristic: a chunk runs from the start of the declaration's leading documentation comment (if any) to the end of its body, inclusive of any in-body comments. If two adjacent declarations share an import block or a shared comment header, they are merged up to the chunk size cap.
- Max chunk: 1000 tokens (code is denser than prose). If a declaration exceeds 1000 tokens, recurse into inner blocks at the next AST level (top-level statements inside the function body), then fall back to fixed line-window chunking inside that declaration only.
- Min chunk: 50 tokens. Tiny declarations are merged greedily with the next sibling up to 600 tokens.
- Carry symbol metadata: `symbolName`, `symbolKind` (one of function/class/method/const), `startLine`, `endLine`, `language`. This metadata is for filtering and display only.

Tree-sitter native-addon load complexity per grammar on current Node: the native `tree-sitter` Node bindings require prebuilds per language grammar and carry ESM-vs-CJS interop quirks across grammar packages. The portable Wasm path (`web-tree-sitter`) avoids the native build but is slower and has its own ESM packaging quirks. The fallback path is therefore architecturally first-class, not a hack:

- Fallback: a "regex + blank-line-aware splitter" that does not require any grammar. It chunks by paragraphs separated by blank lines, with a maximum chunk size of 1000 tokens and merging of trivially-small fragments. Symbol metadata is absent in this mode; the chunker carries only `startLine`, `endLine`, `language` (inferred from extension). The query path tolerates absent symbol metadata.
- Decision rule at startup: try to load the grammar; if loading fails or throws under the installed Node + tree-sitter combination, log a structured warning and use the fallback for that language. Do not block ingest on grammar availability.

The chunker MUST NOT pretend to handle exact-symbol search. Symbol metadata exists for display, hydration, and filtering ("only function-kind chunks"), not for substituting `ripgrep` or the language server. Exact-symbol queries are out of the RAG library's surface.

### 5.3 Short memory notes

Source materials: Dataset A memories — `KnowledgeRecord` rows whose body is typically 50–500 tokens.

Strategy:

- Atomic by default: one memory = one chunk. The body is short enough; splitting loses local context.
- Exception: if a single memory body exceeds 1000 tokens, apply the prose chunker to it. Sub-chunks share the same `recordId` metadata so a query that hits any sub-chunk can resolve the parent record.
- Embedded text is `"${title}\n\n${body}"` (or whichever fields the future adapter elects to expose from [saivage/src/knowledge/types.ts](saivage/src/knowledge/types.ts) — that adapter belongs to the future consumer-integration spec, not to this work).
- Metadata is the structured fields from the `KnowledgeRecord` (scope, scope_ref, role, lifecycle status, created_at, supersedes).

### 5.4 Metadata schema (target shape)

The subsystem design formalizes the types. The data the query path must be able to filter on, derived from the §1 use cases:

- `datasetId` — which collection.
- `projectId` — which project root.
- `source` — discriminator: `"skill" | "memory" | "doc" | "code"`.
- `path` — repo-root-relative file path.
- `chunkIndex`, `startLine`, `endLine` — locate the chunk in the source.
- `contentHash` — sha256 of the chunk's normalized text. Authoritative idempotency key per chunk.
- `sourceHash` — sha256 of the originating file at ingest time. File-level change-detection key.
- `mtimeMs` — file mtime at ingest. Cheap pre-filter only, never the authoritative check.
- `embeddingProvider`, `embeddingModel`, `embeddingDim`, `embeddingRevision` — stamped per row so dimension/model drift is detectable on load (§5.6).
- `language` — for code; null otherwise.
- `headingPath` — for docs/markdown.
- `symbolName`, `symbolKind` — for code (nullable; absent in regex-fallback mode).
- `scope`, `scopeRef`, `role`, `lifecycleStatus`, `createdAt`, `supersedes` — for memories.

Schema discipline: a Zod schema per dataset. Nullable fields stay nullable in storage; the storage layer does not collapse them.

### 5.5 Idempotency and change detection

Required properties:

- Re-ingesting the same file twice produces the same vectors and does not create duplicate rows.
- Re-ingesting after a file edit replaces only the chunks whose `contentHash` changed AND deletes any chunks the new chunking did not regenerate (covers the case where edits shift chunk boundaries so the old `(chunkIndex)` no longer maps onto the new file).
- Re-ingesting after a file delete removes all chunks tagged with that `(projectId, path)`.

Mechanism:

1. Walk the source tree producing `(path, sourceHash, mtimeMs)` for every eligible file (after exclusion globs from §7.5).
2. Diff against the store:
   - `sourceHash` mismatch (or never-seen path) → mark file for re-chunk.
   - Path absent in source tree but present in store → mark for full deletion.
   - Path present and `sourceHash` unchanged → skip.
3. For each re-chunked file, compute the new chunk set with per-chunk `contentHash`. Compute the symmetric difference against the store's existing chunks for that `(datasetId, projectId, path)`:
   - Chunks whose `contentHash` matches an existing row → no-op (keep vector).
   - Chunks whose `contentHash` is new → embed and insert.
   - Existing rows whose `contentHash` is absent from the new chunk set → hard delete. This is what handles shifted chunk boundaries: even if `chunkIndex` remains stable, the old content at that index is gone, so the old row is gone.
4. Reuse an embedding cache keyed by `(provider, model, dim, releaseFingerprint, sha256(content))`. Cache hits skip the embedding API call. The cache lives in the same SQLite file as the chunks (e.g. a `chunk_keys` table) so it is per-project and trivially rebuilt by deleting the file.

Chunk identity for upsert composes `sha256(contentNormalized) + sourcePath + lineRange`, where `contentNormalized` is the chunk's text after trimming trailing whitespace and normalizing line endings. The combined key prevents two distinct files with identical content from colliding into one row.

Worked example of the shifted-boundary case using these illustrative source paths:

```
src/foo.ts
```

- Before edit, a 1200-line TypeScript file at the path above produced 4 chunks: chunkIndex 0 (lines 1–320, contentHash `A`), 1 (321–640, `B`), 2 (641–960, `C`), 3 (961–1200, `D`). Store has 4 rows.
- Operator inserts a new 80-line block at line 200. File becomes 1280 lines.
- New chunking produces 5 chunks: chunkIndex 0 (1–280, hash `A'` — partially overlaps old `A`), 1 (281–600, `B'`), 2 (601–920, `B''`), 3 (921–1200, `C'`), 4 (1201–1280, `E'`). None of `A'`, `B'`, `B''`, `C'`, `E'` match any of `A`, `B`, `C`, `D`.
- Symmetric difference: insert 5 new rows for `A'`..`E'`, delete the 4 old rows for `A`..`D`. No orphans, no stale boundaries.
- A naïve "match on chunkIndex" upsert would have inserted/updated rows 0–4 and left old row 4-as-`D` (or worse, left a phantom row 3-as-`D` if the new file shrank). The symmetric-difference approach is correctness-critical, not optimization.

### 5.6 Dimension change

If the configured embedding provider, model, dimension, or release fingerprint differs from what is stamped on existing rows, those rows are unusable. Vector spaces do not commute across providers, models, dimensions, or even (in some cases) model release fingerprints.

Required behavior:

- On open, compare the configured `(provider, model, dim)` against the values stamped on any existing row in the dataset.
- On mismatch: refuse queries with a clear, single error: "Embedding configuration changed (was `<old>`, is `<new>`); run `rebuild` to re-embed dataset `<datasetId>`." Do NOT auto-rebuild silently. Do NOT mix vectors. The implementer must not add a code path that retries against a different embedding configuration.
- Lifecycle `rebuild` drops the dataset, then re-ingests end-to-end. There is no partial migration.

This is the cleanest expression of "no backward compatibility" for vector spaces.

### 5.7 Tokenization for chunk-size accounting

Chunk-size budgets are token budgets, not character counts.

- For OpenAI models, the existing [js-tiktoken](saivage/package.json#L36-L37) dep provides the right tokenizer (`cl100k_base` for `text-embedding-3-small` / `text-embedding-3-large`).
- For other providers without a published JS tokenizer, fall back to `chars / 4` as a coarse upper bound and accept ~10% overshoot.
- Chunkers target well under the model's max input (e.g. 800 tokens against an 8k window), making strict accounting unnecessary for safety; it is needed only for cost predictability.

### 5.8 Chunker edge cases

The following cases the chunker MUST handle without crashing and without producing unusable chunks. Each is concrete because each has shown up in real codebases of the §1 datasets:

- **Oversized single element.** A single code function or markdown section larger than the chunk-size ceiling (e.g. a 3000-token TypeScript class, a 5000-token release-notes section). The chunker splits on the next-lower granularity (statement boundaries for code; paragraph then sentence for markdown). If even that overflows, fall back to a hard windowed split with overlap; never emit chunks that exceed the provider's input limit.
- **Mixed-language files.** A markdown file with embedded fenced code blocks of varying languages. The chunker treats the fenced block as opaque text in the parent markdown chunk if it fits; if it does not fit, it splits the fenced block as its own chunk with `chunkType: 'code-in-doc'` and preserves the language tag in metadata. It does NOT route fenced blocks through the code chunker (that path is for true source files only).
- **Generated and vendored files.** Source trees contain generated TypeScript declaration files shadowing implementation, TypeDoc HTML/MD output, vendored libraries, and machine-built artifacts. Representative patterns:

  ```
  *.d.ts
  vendor/
  third_party/
  node_modules/
  dist/
  build/
  out/
  coverage/
  ```

  All are excluded by default at the ingest layer (§7.5); the chunker never sees them.
- **Binary or near-binary blobs.** Minified JS, source maps, base64-encoded payloads in JSON fixtures, and lockfiles such as:

  ```
  package-lock.json
  pnpm-lock.yaml
  poetry.lock
  uv.lock
  ```

  Excluded by default. If something slips through, the secret-scan and entropy check at §7.6 catches high-entropy payloads and the chunker drops them with a logged reason.
- **Tree-sitter grammar load failure.** As covered in §5.2: code chunker falls back to the regex+blank-line splitter. Operator sees a one-time log line per language; no per-file noise.
- **UTF-8 boundary truncation.** When windowed splitting hits a multi-byte codepoint, the chunker splits on token boundaries from the tokenizer (§5.7), not on byte offsets. The js-tiktoken tokenizer decodes back to text safely.
- **Empty or whitespace-only sections.** Markdown documents with empty sections under a heading produce zero chunks for that section; the heading is preserved as breadcrumb metadata on the next non-empty sibling chunk.
- **Symlinks and circular trees.** The path walker follows symlinks at most once per real-path target, tracked via a resolved-realpath set. Repository conventions like `docs -> ../shared-docs` work; symlink cycles do not hang the walk.

---

## 6. Public surface sketch

This section lists the operations the RAG library exposes. No type signatures, no module names, no concurrency model commitments, no transaction semantics, no observability event names, no streaming API, no cross-dataset query. Those decisions belong to the subsystem design.

Operations:

- `register` — declare a logical dataset and bind its provider, store, and chunker configuration. Datasets not registered cannot be ingested or queried.
- `ingest` — incrementally add or update chunks for a dataset, honoring the idempotency and change-detection rules in §5.5.
- `delete` — remove chunks from a dataset by id or by metadata filter.
- `query` — return the top-K most relevant chunks for a query, honoring the dataset's metadata filter; the embedding role (query vs. document) is decided internally.
- `stats` — report chunk count, distinct file count, last-ingest timestamp, stamped `(provider, model, dim)`, and on-disk byte size.
- `rebuild` — drop the dataset and re-ingest end-to-end; required after embedding-configuration change.
- `drop` — delete all chunks and on-disk artifacts for the dataset.

### 6.1 What the surface deliberately does NOT include

- No reranker.
- No hybrid (BM25 + vector) retrieval. Rejected for v1.
- No cross-dataset query. Caller invokes twice and merges.
- No streaming / incremental KNN. All searches return a complete list.
- No write-ahead queue or background ingest worker. Ingest is synchronous; if measured event-loop blocking later requires offloading, that is taken up in the subsystem design.
- No transaction model exposed to callers. Atomicity at the file-batch level is the implementation's concern.
- No `mode` / `input_type` knob in the query payload. Callers do not need to know whether the underlying provider uses asymmetric embeddings.
- No free-form `tags[]` metadata. Every metadata field must answer a use case from §1.

---

## 7. Failure modes and security

### 7.1 Provider outages

Embedding provider down at query time: reject the query with a typed error. Do not silently fall back to a different model — that would mix embedding spaces and corrupt rankings.

Embedding provider down at ingest time: pause the affected batch, mark it as retryable, leave the store in a consistent state. The store must already be transactionally consistent if the process is killed mid-ingest.

### 7.2 Provider rate-limit and quota

Provider 429 / 5xx responses must be retryable with exponential backoff and respect for `Retry-After` headers (retry policy and circuit-breaker thresholds are recorded in the system design, not in this analysis).

### 7.3 Embedding model drift / dimension change

Covered in §5.6. Detection-and-refuse is the safe default. `rebuild` is the only path to "upgrade."

### 7.4 Poisoned content

Threat: a document contains adversarial text designed to manipulate later LLM reasoning. RAG retrieval surfaces this into an agent prompt.

Mitigations available in the retrieval layer:

- Surface the source path in every result's metadata so the caller (prompt builder, auditor) can trace odd model behavior back to its origin. This is the most important hardening lever retrieval can provide.
- Return text, not actions. Never extract and execute anything embedded in retrieved chunks (URLs, MCP tool-call hints, etc.).
- Do not promise sanitization. The prompt builder is responsible for delimiting retrieved chunks and instructing the model not to follow embedded instructions.

These are guardrails, not guarantees. Prompt-injection robustness is a generation-time concern.

### 7.5 Accidental indexing of secrets

This is the highest-severity local risk. The existing Saivage knowledge store enforces secret guards (`scanForSecrets`, `isBlockedPath` in [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts)); the RAG layer must enforce the same posture independently — defense in depth, because the RAG layer may receive raw file streams that bypass the knowledge-store path.

Mandatory exclusion globs at the ingest entry point. Applied BEFORE files are read, not just before they are embedded. Hard defaults (operator MAY add to the list per dataset; operator may NOT remove the credential-adjacent entries):

```
**/.saivage/auth-profiles.json
**/.saivage/saivage.json
**/.saivage/**/auth-profiles.json
**/.saivage/tmp/**
**/.saivage-work/**
**/.env
**/.env.*
**/secrets/**
**/*credentials*
**/*.pem
**/*.key
**/*.p12
**/*.pfx
**/id_rsa
**/id_rsa.*
**/id_ed25519
**/id_ed25519.*
**/.git/**
**/node_modules/**
**/dist/**
**/build/**
**/.venv/**
**/venv/**
**/__pycache__/**
**/.cache/**
```

Per-chunk secret scan BEFORE embedding (regex set, applied to chunk text):

- AWS access key ids: `AKIA[0-9A-Z]{16}` and the matching 40-char secret pattern.
- GitHub tokens: `gh[pousr]_[A-Za-z0-9]{36,255}` and `github_pat_[A-Za-z0-9_]{82}`.
- OpenAI keys: `sk-[A-Za-z0-9]{20,}` and the `sk-proj-` variant.
- Anthropic keys: `sk-ant-[A-Za-z0-9\-_]{40,}`.
- Generic JWT-looking strings: `eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+`.
- Generic high-entropy base64/hex tokens above a length+entropy threshold (off by default; on if the operator opts in, because false-positive rate is high).

Matched chunks are dropped (not stored, not embedded), and a structured log entry records `(path, pattern, dropped_chunk_index)` — NEVER the matched text. The aggregate "X chunks dropped from ingest" count surfaces in `dataset.stats()` output so an operator can audit.

The credential and private-key patterns above are NON-overridable. The doc-tree exclusions (build dirs, caches) are operator-overridable per dataset.

On-disk RAG artifacts live under the project-local RAG store directory, illustrated as:

```
<projectRoot>/.saivage/rag/
```

These artifacts inherit `.saivage` directory permissions (operator-owned, mode 0700 directory / 0600 files where the OS supports them).

### 7.6 In-process vs. sidecar

In-process is the realistic default given Saivage's existing Fastify topology. Concrete blocking-risk implications:

- Hosted embedding calls are network I/O. `await fetch(...)` yields the event loop; concurrent queries are not blocked by an outstanding embedding request. This is fine in-process.
- Local embedding is CPU-bound and DOES block the event loop. If local embedding is ever integrated, it MUST run in `worker_threads` or a child process; otherwise every embedding call freezes the Fastify request loop. The focused design accordingly stays hosted-embedding-only; local embedding is a deferred integration.
- Synchronous native calls into `better-sqlite3` are fast (sub-millisecond per insert) but DO block the loop while they run. Batch sizes must be bounded so the loop is not held for tens of milliseconds at a time during ingest.
- Native crashes (e.g. a corrupted SQLite file segfaulting `better-sqlite3`) take the Saivage process with them. The `PRAGMA integrity_check` step at open is the cheapest pre-emption.

Sidecar (separate process talking over IPC or HTTP) is revisited only if local embedding is actually integrated, OR if the subsystem design demonstrates a concrete benefit (crash isolation across worker tiers, MCP-exposed retrieval as a product surface, multi-process query fan-out). Default position: in-process.

### 7.7 Provider key handling

The RAG layer never opens credential files directly; it receives provider configuration via the project config layer (see [saivage/src/config.ts](saivage/src/config.ts)) and any provider routing module. The RAG layer:

- Never reads `.saivage/auth-profiles.json` directly. It calls the provider abstraction and asks for an authenticated client.
- Never logs an API key. Never logs request bodies. Logs include provider id, model id, response code, latency, and token counts only.
- Never embeds the contents of `.saivage/auth-profiles.json` or `.saivage/saivage.json` (also blocked at the ingest exclusion list in §7.5).

### 7.8 Disk corruption / partial writes

- Multi-row writes happen inside a single transaction (SQLite `BEGIN` / `COMMIT`; LanceDB single `add` call).
- `rebuild` writes to a sibling file or directory and atomically renames at the end, so a crash mid-rebuild does not destroy the prior good index.
- Startup runs `PRAGMA integrity_check` for SQLite or `table.countRows()` for LanceDB. On failure: refuse queries, mark dataset corrupted, require `rebuild`.

### 7.9 PII

Beyond credentials, the RAG layer may incidentally index PII present in target docs (names, emails). The library cannot detect arbitrary PII reliably; the mitigation is operator-side (declare exclusions per dataset). The library only commits to honoring the exclusion list and to not exfiltrating chunks anywhere other than the configured embedding provider.

If the embedding provider is hosted, every chunk is sent to that vendor. `dataset.stats()` surfaces the stamped embedding provider so an operator can audit "what model has seen my docs."

### 7.10 Backup and restore

- sqlite-vec: file copy when no writer is active, or `VACUUM INTO 'backup.db'` for an online snapshot. Restore = file replacement.
- LanceDB: recursive directory copy with the per-dataset ingest mutex held.
- The project-local RAG store directory inside `.saivage` is safe to delete entirely; the subsystem rebuilds from source on the next ingest. The on-disk store is derived data, not source of truth. This is the canonical disaster-recovery path.

### 7.11 No-backward-compat reaffirmed

- No on-disk schema version that promises forward compatibility. If a future change alters the layout, `rebuild` is the only supported upgrade path. The store-adapter may detect "this looks like an older layout" and refuse with a clear error; it does NOT migrate in place.
- No fallback to a prior embedding-provider config if the current one fails. Refuse queries, demand `rebuild`.
- No compatibility shims for prior knowledge-store shapes. The RAG layer treats the knowledge store as a future producer through a small ingest API; it does not absorb knowledge-store internals.

### 7.12 Boundary with the existing knowledge store

The knowledge layer at [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts) and [saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts) already provides durable, audited, secret-scanned storage of skills and memories. The RAG layer is strictly additive: it builds a queryable vector view over content the knowledge store owns.

Consequences:

- The RAG layer does not duplicate audit. When a memory is superseded, the knowledge store records the audit event; the RAG layer just upserts the new vector and hard-deletes the old.
- The RAG layer does not duplicate the secret scanner; it calls into the existing helper (`scanForSecrets` and equivalents in [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts)) as a function and treats it as the single source of truth for "is this string sensitive."
- The RAG layer does not own the on-disk format of skills or memories. It receives them as opaque `{text, metadata}` pairs from a future adapter and produces vectors. If the knowledge store changes its on-disk layout, the adapter changes; the RAG store does not.

### 7.13 Concrete failure-mode walkthroughs

The following five scenarios illustrate how the rules above compose. Each is the kind of failure a real operator hits in the first month of use; the analysis here documents the expected behavior, not a fix to design later.

- **Provider 429 storm during ingest.** Operator triggers a full `rebuild` of dataset C (code, 60k chunks, ~6M tokens). The hosted provider returns HTTP 429 mid-stream. Expected behavior: the embedding call observes the `Retry-After` header (or applies exponential backoff capped at, e.g., 30 s if the header is absent), retries the same batch up to a small bounded number of attempts, and on persistent failure surfaces an error that names the failing batch and the cumulative progress. The ingest pipeline does NOT silently drop the batch and continue; the dataset is left in a state where the next `ingest` resumes via the file-level idempotency check (mtime + sourceHash unchanged, sourceHashes for completed files match, others re-attempted). Concrete retry-policy parameters are deferred to the subsystem design.
- **Mid-ingest crash.** Operator's terminal kills the process during a 5-minute rebuild. Expected behavior: the staging file or directory used by atomic-rename (§7.8) is left orphaned and is cleaned up on next startup. The prior good index is intact (rename had not happened). Next `ingest` re-runs without data loss.
- **Corrupted .db on disk.** Power loss, disk-full mid-write, or external process truncates the sqlite-vec file. Expected behavior: startup `PRAGMA integrity_check` fails; the dataset is marked corrupted; queries return a clear error directing the operator to `rebuild`; ingest will not silently overwrite a corrupted file. Operator can also delete the dataset's `.db` file from the project-local RAG store (§7.10) and re-ingest from source.
- **Embedding-config drift between sessions.** Operator changes `embedProvider` in `saivage.json` between runs. Expected behavior: on next query, the `(provider, model, dim)` mismatch (§5.6) is detected and the query is refused with the exact error string from §5.6. The dataset is not auto-rebuilt; the operator must run `rebuild` explicitly.
- **Stale chunk shadowing after large refactor.** Operator renames `oldModule.ts` to `newModule.ts`. Without the symmetric-difference delete (§5.5), retrieval would return stale chunks under `path: oldModule.ts` indefinitely. With it, the file walker no longer surfaces `oldModule.ts`, the chunk-by-path delete fires for that path on next ingest, and queries return only the new path's chunks. If the operator also deleted a file entirely, the same pass removes its chunks; the dataset never accumulates orphan chunks from deleted source paths.

---

## 8. Latency and throughput budgets

All numbers below are estimates. The implementer MUST measure on the operator's actual host before tuning anything.

### 8.1 Query latency decomposition

A query latency target like "p95 under 400 ms" must be decomposed into three independent components that compose additively in the common case (no caching) and are bounded by the slowest of the three when cached.

Component 1 — query embedding:

- Hosted (OpenAI / Voyage / etc.) over HTTPS, single short query (~50 input tokens): 80–250 ms typical, with provider tail latency pushing p99 above 600 ms. TLS handshake reuse helps; cold-connection latency adds another 30–100 ms.
- Local Transformers.js, MiniLM-L6 on CPU, single query: 5–30 ms.
- Local Transformers.js, BGE-base on CPU, single query: 20–80 ms.

Component 2 — vector search:

- sqlite-vec brute-force exact KNN, 1536-d float32, 50k vectors, single x86 core: estimated 5–20 ms.
- sqlite-vec brute-force, 1536-d float32, 500k vectors, single x86 core: estimated 50–250 ms. This is the regime in which sqlite-vec brute force starts to feel painful and where switching to LanceDB IVF_PQ (or to a smaller dimension via OpenAI's `dimensions` truncation) becomes worth considering.
- LanceDB IVF_PQ, 500k vectors: estimated 5–30 ms after the index is built.

Component 3 — candidate post-filtering and hydration:

- SQL `WHERE` over a sibling metadata table with indexed columns: 0.5–3 ms.
- Fetching chunk text for top-K from sqlite-vec rowids: 0.5–2 ms per chunk; bounded by K (typical K=10).
- Serialization back to caller: <1 ms.

Implication for the §1 latency budgets:

- Skills/memories (corpus ≤10k chunks, 1536-d): hosted query embed dominates (80–250 ms typical), search is <5 ms, hydration is <5 ms. p95 budget of 400 ms is comfortable with hosted embeddings as long as the provider's tail latency is not pathological that day.
- Docs (corpus 10k–50k chunks): same shape. Hosted embed still dominates.
- Code (corpus 100k–500k chunks): with sqlite-vec brute force at 1536-d, search itself can consume 50–250 ms at the high end. Either truncate to 512-d (recovers most of the budget), or switch to LanceDB IVF_PQ.

Single biggest available latency win: cache query embeddings keyed by `(provider, model, dim, sha256(queryText))`. A small bounded LRU is sufficient.

### 8.2 Ingest throughput decomposition

Ingest cost decomposes into three independent components:

Component 1 — read + parse + chunk:

- Reading a 5M-token markdown corpus from disk: seconds, disk-bound.
- Header-recursive markdown chunker: tens of thousands of chunks per second on a single core. Negligible vs. embedding.
- Tree-sitter parse for code: hundreds to low thousands of files per second per core for typical TS/Python source.

Component 2 — embed batch:

- HOSTED is network-bound and rate-limit-bound. Throughput ceiling is `min(provider TPM, provider RPM × per-request input tokens, provider per-input-batch ceiling)`. For OpenAI `text-embedding-3-small` at a tier-1 TPM around 1M, a 5M-token rebuild takes ~5 minutes of wall clock under ideal batching, ignoring per-request overhead. The implementer MUST treat provider TPM as the binding constraint and design batch sizes against it.
- LOCAL is CPU-bound. Transformers.js BGE-small at ~60 chunks/sec × 12k chunks ≈ 3.5 minutes. Local CPU embed does NOT scale with extra concurrency on a single core; it does scale with `worker_threads` up to the number of cores.

Component 3 — store insert:

- better-sqlite3 inserts: tens of thousands per second per transaction, disk-bound on the WAL.
- LanceDB writes: similar order of magnitude.

For incremental ingest (1% of corpus changed):

- 1% of 5M tokens is ~50k tokens. At the OpenAI TPM ceiling above, that is ~3 seconds wall clock for the embedding step, plus a small constant for read/parse/insert.
- A 1% incremental ingest at this token volume is not sub-second under hosted embeddings. Sub-second is achievable only for very small incrementals (a handful of files) or when query-embedding cache hits dominate.

### 8.3 Cost calibration

At the §1 corpus estimates and a workload of one full rebuild per month plus daily incremental of ~1% plus 10 queries per agent turn × 200 turns/day:

| Provider/model | Monthly rebuild cost | Daily incremental cost | Daily query-embed cost | Approx total / month |
|---|---|---|---|---|
| OpenAI `text-embedding-3-small` | ~$0.22 (11M tokens) | <$0.01 | <$0.01 | <$1 |
| OpenAI `text-embedding-3-large` | ~$1.43 | <$0.05 | <$0.05 | ~$5 |
| Voyage `voyage-3-lite` | ~$0.22 | <$0.01 | <$0.01 | <$1 |
| Voyage `voyage-code-3` (code only) | ~$0.18 (1M code tokens) | <$0.01 | <$0.01 | <$1 |
| Aggregator BGE-large | ~$0.11 | <$0.01 | <$0.01 | <$0.5 |
| Transformers.js local | $0 (CPU time) | $0 | $0 | $0 |

Per-token prices above are VERIFY (see §2). At these scales, monetary cost is not a meaningful differentiator between hosted choices; quality, latency, and operational simplicity drive the decision.

### 8.4 Storage compaction

For corpora past 1M chunks (well beyond §1 ceilings), float16 storage halves disk + RAM with negligible recall loss, and int8 quantization halves it again at modest recall loss. These are NOT needed at Saivage's expected scale. The store-adapter does NOT take a quantization knob in v1 (storing only float32). Adding it later is a single store-adapter change, not a public-surface change.

### 8.5 Worked examples per dataset

Each worked example uses the §1 estimates and the OpenAI `text-embedding-3-small` defaults (1536-d float32 = 6144 bytes per vector). All numbers are estimates pending implementer measurement.

- **Dataset A (skills + memories).** 3 built-in skills × ~3 chunks each + future user skills (call it 50 chunks total at saturation) + ~500 memory chunks at saturation = ~550 chunks. Embedding cost at saturation: ~550 × 600 tokens × $0.02/1M ≈ $0.007 per full rebuild. On-disk vector size: ~3.4 MB. Query latency: brute force over 550 vectors is sub-millisecond on better-sqlite3; network embedding dominates at 80–250 ms HOSTED p95 (§8.1).
- **Dataset B (docs).** 48 markdown files in [saivage/docs/](saivage/docs/) (with [saivage/docs/api/](saivage/docs/api/) excluded), call it ~600 chunks across the workspace's hand-written docs. Embedding cost at full rebuild: ~600 × 600 × $0.02/1M ≈ $0.007. Vector size: ~3.7 MB. Query latency: same as A.
- **Dataset C (code).** 172 TypeScript files in [saivage/src/](saivage/src/) plus equivalents in target projects. At ~70 chunks per 1000 LoC and an average 500 LoC per source file, the workspace's code corpus is in the 5k–60k chunk range depending on which projects are included. Take 50k chunks (a worst-case "all four projects" estimate). Embedding cost at full rebuild: 50k × 600 × $0.02/1M ≈ $0.60. Vector size: ~300 MB. Query latency: brute-force scan of 50k × 1536-d float32 (~300 MB) per query is bandwidth-limited; the §8.1 estimate of 5–25 ms PRIMARY puts a 50k-vector brute-force query well within budget on a modern desktop or VPS. At 500k vectors the brute-force time rises proportionally to ~50–250 ms, which is the point at which the LanceDB IVF_PQ fallback starts to pay for itself.

All three worked examples confirm:

- Money is not a constraint at hosted-default scale.
- Disk is not a constraint until dataset C grows past several hundred thousand chunks.
- Latency stays under typical p95 targets through the §1 corpus sizes; the primary store crosses into "ANN would help" territory only at dataset C's upper end.

The implementer should re-derive these numbers from measured per-chunk token counts on the operator's actual corpora before committing to defaults; the numbers above are anchors, not commitments.

---

## 9. Summary recommendations

- Default embeddings provider: OpenAI `text-embedding-3-small` at native 1536-d; 512-d truncation as a config switch for very large code corpora. Anthropic explicitly NOT used (no API).
- Default vector store: sqlite-vec on top of better-sqlite3, single `.db` per dataset under the project-local RAG store directory inside `.saivage`. Brute-force exact KNN. `node:sqlite` may be evaluated alongside better-sqlite3; better-sqlite3 remains primary on ecosystem-maturity and loadable-extension-distribution grounds.
- Fallback vector store: LanceDB (`@lancedb/lancedb`), IVF_PQ + BM25 headroom.
- Local embedding design seam shaped around Transformers.js, off-loaded to `worker_threads` if ever integrated. Ollama as "operator already has it" secondary.
- Chunking: markdown header-recursive (400–800 tokens, ~15% overlap); code tree-sitter-aware (≤1000 tokens, AST-derived boundaries) with a regex + blank-line fallback when the grammar fails to load; memories atomic up to 1000 tokens.
- Metadata schema covers source, path, line span, content/source hashes, embedding-provider stamps, scope/role/lifecycle (memories), and symbol/language (code). No free-form tags.
- Idempotency: file-level `(sourceHash, mtimeMs)` pre-filter, chunk-level `contentHash` upsert with symmetric-difference delete to handle shifted chunk boundaries. Embedding cache keyed by content hash. Dimension/model change refused with a single clear error.
- Public surface: `dataset.register`, `dataset.ingest`, `dataset.delete`, `dataset.query`, `dataset.stats`, `dataset.rebuild`, `dataset.drop`. No reranker, no hybrid, no cross-dataset, no streaming, no transactions exposed, no `mode` knob.
- Security: hard exclusion globs (credential/key entries non-overridable; build/cache entries overridable), per-chunk regex secret scan with drop-and-log, RAG artifacts inherit `.saivage/` permissions.
- Latency dominated by hosted embedding network hop; vector search is fast at the §1 sizes for sqlite-vec brute force up to ~100k vectors at 1536-d. At higher chunk counts: truncate dim or fall back to LanceDB IVF_PQ.
- Ingest is rate-limited by provider TPM; ~5 minutes wall clock for a 5M-token full rebuild on OpenAI `text-embedding-3-small` at tier-1 limits. Incremental ingest at the few-percent scale is in the seconds range, NOT sub-second.
- In-process deployment is the realistic default. Sidecar revisited only if local embedding is integrated.

---

## 10. Verification checklist

The implementer must verify each item below before any design locks defaults. Every entry maps to a `VERIFY:` marker in context above.

- VERIFY: Anthropic still does not ship a public `/v1/embeddings` endpoint at [docs.anthropic.com/en/docs/build-with-claude/embeddings](https://docs.anthropic.com/en/docs/build-with-claude/embeddings).
- VERIFY: OpenAI embeddings model list, dimensions, prices, and max input tokens at [platform.openai.com/docs/guides/embeddings](https://platform.openai.com/docs/guides/embeddings) and [openai.com/api/pricing](https://openai.com/api/pricing).
- VERIFY: account-specific OpenAI TPM and RPM ceilings at [platform.openai.com/account/limits](https://platform.openai.com/account/limits).
- VERIFY: Google `text-embedding-005` and `gemini-embedding-001` availability, dimensions, prices, and max input tokens at [ai.google.dev/gemini-api/docs/embeddings](https://ai.google.dev/gemini-api/docs/embeddings) and [cloud.google.com/vertex-ai/generative-ai/pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing).
- VERIFY: Google embeddings rate limits at [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits).
- VERIFY: Cohere v3 / v4 embed model list, dimensions, prices, max input tokens, `input_type` support at [docs.cohere.com/docs/embed](https://docs.cohere.com/docs/embed) and [cohere.com/pricing](https://cohere.com/pricing).
- VERIFY: Cohere rate limits at [docs.cohere.com/docs/rate-limits](https://docs.cohere.com/docs/rate-limits).
- VERIFY: current Voyage model lineup (the v3 names listed in §2.5 may already be superseded by v3.5 or later), dimensions, prices, max input tokens, Matryoshka support, and code-retrieval benchmark standing at [docs.voyageai.com/docs/embeddings](https://docs.voyageai.com/docs/embeddings) and [docs.voyageai.com/docs/pricing](https://docs.voyageai.com/docs/pricing).
- VERIFY: Voyage rate limits at [docs.voyageai.com/docs/rate-limits](https://docs.voyageai.com/docs/rate-limits).
- VERIFY: Mistral `mistral-embed` and `codestral-embed` availability, dimensions, prices, max input tokens at [docs.mistral.ai/capabilities/embeddings](https://docs.mistral.ai/capabilities/embeddings) and [mistral.ai/pricing](https://mistral.ai/pricing); Mistral rate limits at [docs.mistral.ai/deployment/laplateforme/overview](https://docs.mistral.ai/deployment/laplateforme/overview).
- VERIFY: aggregator embedding catalogs, prices, and rate limits at [docs.together.ai/docs/embedding-models](https://docs.together.ai/docs/embedding-models), [fireworks.ai/pricing](https://fireworks.ai/pricing), [deepinfra.com/models](https://deepinfra.com/models).
- VERIFY: whether [@mariozechner/pi-ai](saivage/package.json#L31-L32) exposes an embeddings surface, and for which providers, by inspecting the installed package at [saivage/node_modules/@mariozechner/pi-ai](saivage/node_modules/@mariozechner/pi-ai).
- VERIFY: Transformers.js single-thread CPU throughput on the operator's actual host (the §3 estimates are conservative averages, not measurements on this machine).
- VERIFY: sqlite-vec current release at [github.com/asg017/sqlite-vec/releases](https://github.com/asg017/sqlite-vec/releases); confirm ANN/IVF features remain unstable so the design correctly assumes brute-force exact KNN; confirm brute-force latency at the 50k-vector / 500k-vector points on the operator's hardware.
- VERIFY: `better-sqlite3` current-Node ESM compatibility and prebuild availability for the operator's arch at [github.com/WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3).
- VERIFY: `@lancedb/lancedb` current-Node ESM compatibility and prebuild availability at [github.com/lancedb/lancedb](https://github.com/lancedb/lancedb).
- VERIFY: `tree-sitter` current-Node ESM compatibility for the chosen language grammars (`tree-sitter-typescript`, `tree-sitter-python`); confirm whether the native or Wasm path is the right primary.
- VERIFY: on-disk size and file count of [saivage/docs/](saivage/docs/) excluding [saivage/docs/api/](saivage/docs/api/) so the Dataset B ceilings in §1.2 are reconfirmed against the implementer's current tree.
- VERIFY: hosted embedding tail-latency p95/p99 against the chosen provider on the operator's network before promising the §1.5 latency budgets.
