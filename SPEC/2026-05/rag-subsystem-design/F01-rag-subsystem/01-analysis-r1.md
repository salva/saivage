# F01 — RAG subsystem functional analysis (round 1)

Scope: functional analysis only. No design, no implementation, no edits outside this folder. Honors workspace rule "Architecture-first, no backward compatibility" and Saivage v2 constraints (Node 20+, ESM, TypeScript, providers via [@anthropic-ai/sdk](saivage/package.json#L28-L29), [openai](saivage/package.json#L38-L39), [@mariozechner/pi-ai](saivage/package.json#L31-L32)).

All "VERIFY:" markers in this document are price/limit numbers the implementer must reconfirm against vendor pages before committing the choice in the design round.

---

## 1. Use cases per candidate dataset

The RAG subsystem must serve three logically independent datasets. Each has its own corpus profile, query profile, freshness profile, and latency budget. The library must treat them as fully isolated collections; no cross-dataset assumptions.

### 1.1 Dataset A — Skills and memories (Saivage's own knowledge)

Producers: the existing knowledge layer in [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts), the built-in skills under [saivage/skills/builtin/](saivage/skills/builtin/), per-project memory notes under each project's `.saivage/` tree, and (when later wired) the `KnowledgeRecord` instances defined in [saivage/src/knowledge/types.ts](saivage/src/knowledge/types.ts#L1-L60).

Consumers (future, not part of this work):
- Planner / manager loops that want to recall prior decisions and prior memories before drafting the next stage.
- Coder / researcher loops that want to recall the right skill (procedural how-to) for the current task.
- Inspector / reviewer loops that want to recall prior critiques on the same artifact.

Query archetypes:
- "Find skills about <topic>" (semantic match on SKILL.md descriptions and bodies).
- "Find memories where I previously hit <symptom>" (semantic match on memory bodies, filtered by scope=project|stage|session).
- "Find memories about <subsystem> authored by role=reviewer in the last 30 days" (semantic + metadata filter).

Corpus size estimates:
- Built-in skills today: 3 files, 71 lines total (verified via `find skills/builtin -name '*.md'`). Realistic growth ceiling: 100 SKILL.md files of ~300 lines each = ~30k tokens.
- Per-project memories at steady state (estimated from `saivage-v3/.saivage/` observations): 200–2000 KnowledgeRecord rows per long-lived project, average body ~400 tokens, total 80k–800k tokens.
- Skills + memories combined across all active projects on a host: estimated at ~5k–10k chunks, ~2M–5M tokens. This is small.

Latency targets:
- Skills lookup happens once per agent turn at most, often once per stage. Budget: end-to-end retrieval (embed query + ANN search + filter) under 150 ms p50, under 400 ms p95. A cached embedding of the query and a sub-10k-row vector index trivially meet this.
- Memory recall is on the hot path of agent reasoning; same budget.

Freshness:
- Skills change rarely (built-in: only on Saivage upgrades; project: when an operator adds a new SKILL.md). Re-ingest on file mtime change is sufficient.
- Memories change frequently (every supersede / archive in [saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts)) but volumes per change are tiny (1 record). The RAG layer must accept incremental upserts and tombstones synchronously, not in a nightly batch.

Multi-tenancy boundary: per project. The library must allow one logical collection key like `skills-memories::<projectId>` or equivalent metadata-tagged storage. Cross-project recall is out of scope until an operator explicitly asks for it.

### 1.2 Dataset B — Target-project documentation

Producers: the target project's `docs/`, `README.md`, `AGENTS.md`, `SPEC/**`, `inspections/`, and similar markdown trees. Realistic targets are [saivage/docs/](saivage/docs/) (1194 files, includes generated TypeDoc — see §5.5 on exclusion), [getrich/docs/](getrich/docs/), [getrich-v2/docs/](getrich-v2/docs/), [diedrico/docs/](diedrico/docs/), [diedrico/specs/](diedrico/specs/).

Consumers: any agent that has to operate on the target project and needs prose context (architecture notes, ADRs, glossary, dataset definitions).

Query archetypes:
- "What does this project mean by `<term>`?" (definitional, expects a short paragraph).
- "Where is the spec for feature X?" (location-finding, expects file paths in the metadata).
- "Summarize the architecture of subsystem Y" (needs top-k passages from multiple documents).

Corpus size estimates:
- Small target (getrich-v2): ~10 docs files, estimated 30k–80k tokens after stripping front-matter.
- Medium target (saivage's hand-written docs, excluding `docs/api/` TypeDoc output): estimated 50–150 markdown files, 200k–800k tokens.
- Large target hypothetical (mlflow-style codebase docs): 500–2000 files, 2M–8M tokens.
- Design ceiling to plan for: 5k–20k chunks per target project, 5M tokens.

Latency targets:
- Docs lookups feed agent prompts at the start of a stage. Budget 300 ms p50, 800 ms p95.

Freshness:
- Docs change as the project evolves. Polling on file mtime + content hash at agent-start is acceptable; no need for a file-watcher daemon in v1. Re-ingest takes seconds for typical sizes (see §3.4 throughput).

Multi-tenancy boundary: per target-project. Two open projects must have isolated docs collections.

### 1.3 Dataset C — Target-project source code

Producers: the target project's source tree (`src/**/*.ts`, `getrich/src/**/*.py`, `frontend/src/**/*.vue`, etc.).

Consumers: coder, reviewer, inspector loops that want "show me functions related to X" or "find places that already call this API."

Query archetypes:
- "Find code that handles `<concept>`" (semantic).
- "Find usages of symbol `<name>`" (lexical — note: this is poorly served by embeddings; see §5.4 below; ripgrep/LSP remain superior for exact-symbol search).
- "Find the implementation of the function that does X" (semantic, expects to land on a definition span).

Corpus size estimates:
- Saivage v2 itself: 172 .ts files, ~38061 LOC (verified via `find src -name '*.ts' | wc -l` and aggregate `wc -l`). At ~6 tokens/line that is ~228k tokens. Chunked at 400 tokens with 20% overlap → ~700 chunks.
- Getrich-v2 Python: 39 files, estimated 200k–400k tokens, 600–1200 chunks.
- Large target hypothetical (mlflow main package): thousands of files, 5M–20M tokens, 15k–60k chunks.
- Design ceiling: 100k chunks per target-project source dataset. Still small enough for an in-process ANN index in RAM if needed.

Latency targets:
- Code search runs interactively in agent loops; budget 300 ms p50, 1000 ms p95.

Freshness:
- Code changes on every commit / every coder loop iteration. Incremental re-ingest on file mtime + sha256 of the file is mandatory; full reindex must remain a recovery operation, not a per-edit operation. If the agent edits a file, the embed-and-upsert for the changed chunks should run in the background within seconds.

Multi-tenancy boundary: per target-project, and within a project optionally per language (so a "find Python code" filter does not have to scan TypeScript). Language is metadata, not a separate collection — the design must not multiply collection counts unnecessarily.

### 1.4 Cross-cutting observations

- All three datasets are bounded — even pessimistic ceilings fit in a single embedded vector store on one machine. No sharding, no distributed index needed.
- Query rates are agent-driven (one to a few per agent turn), not user-facing search bar QPS. Single-digit QPS sustained, with bursts under 50 QPS during multi-agent stages. Any embedded ANN library handles this trivially.
- Recall@10 matters more than recall@1 for agent context-building (the agent will read several chunks and re-rank with its own attention). This relaxes the embedding-quality bar somewhat and makes a smaller/cheaper embedding model viable.
- Result chunks must round-trip the original source path and line span, because downstream agents will want to open the file. Metadata schema must guarantee this (see §6.3).

### 1.5 Latency budget decomposition

A 400 ms p95 budget breaks down approximately as:

| Stage | Typical cost (hosted embeddings) | Typical cost (local embeddings) | Notes |
|---|---|---|---|
| Query embedding (single text, ~50 tokens) | 80–200 ms over HTTPS to OpenAI | 5–30 ms with Transformers.js MiniLM on CPU | Dominated by TLS handshake reuse and provider tail latency. |
| Vector ANN search (10k–100k rows, 1536-d, brute-force in sqlite-vec) | 1–15 ms | 1–15 ms | Cosine over float32; SIMD-friendly. |
| Metadata filter and hydration | 0.5–3 ms | 0.5–3 ms | Plain SQL `WHERE` on indexed columns. |
| Serialization back to caller | <1 ms | <1 ms | Small payloads (top-10 chunks of ~500 tokens each). |

Implication: with hosted embeddings, query-side latency is dominated by the embedding network hop, not by the vector store. Caching query embeddings (§7.1) is the single biggest available win.

### 1.6 Why the three datasets stay separate

Tempting alternative considered and rejected here: store everything in one collection with a `source` discriminator, query once, filter post-hoc. Rejected because:

- Chunkers differ irreducibly (code AST vs. markdown headers vs. memory-as-atomic). A single collection forces an awkward "polymorphic chunker" abstraction.
- Embedding-model choice can legitimately differ per dataset (e.g. `voyage-code-3` for code, `text-embedding-3-small` for prose). A single collection forces one model across all sources, locking out specialization.
- Lifecycle ops (`drop` skills, keep docs) are common operator wishes and trivial when datasets are separate.
- Filtering on a `source` column at query time costs nothing when the underlying ANN has built-in filter support — but using that filter to emulate separate collections still pays the cost of doing one ANN search over a larger combined index. With small per-dataset indexes, the per-query work is strictly smaller.

---

## 2. Embeddings provider survey (hosted)

Surveyed: providers Saivage v2 already ships SDKs for, plus the providers routed via [@mariozechner/pi-ai](saivage/package.json#L31-L32). Anthropic, OpenAI, Google, Cohere, Voyage, Mistral, and the open-source-as-a-service hosts (Together, Fireworks) are the realistic candidates. Pricing and dimensions stated below reflect mid-2025 public pricing pages and are dated; the implementer must reconfirm before the design round picks a default.

### 2.1 Anthropic

Anthropic has historically not shipped a first-party embeddings API. Their public docs ([docs.anthropic.com/en/docs/build-with-claude/embeddings](https://docs.anthropic.com/en/docs/build-with-claude/embeddings)) explicitly recommend using Voyage AI for embeddings paired with Claude for generation. The `@anthropic-ai/sdk` exposes Messages and Files APIs but no `embeddings.create`.

VERIFY: confirm at design-round time that Anthropic still does not ship a `/v1/embeddings` endpoint. If they have launched one in the interim, re-score this row.

Implication: even though [saivage/package.json](saivage/package.json#L28-L29) pins `@anthropic-ai/sdk`, the embeddings provider abstraction cannot assume one provider for both generation and embeddings. The two must be independent in config.

### 2.2 OpenAI

OpenAI has a stable, well-documented embeddings API exposed by the `openai` SDK already in [saivage/package.json](saivage/package.json#L38-L39).

| Model | Dim (native) | Dim (truncatable to) | Price per 1M input tokens (VERIFY) | Notes |
|---|---|---|---|---|
| `text-embedding-3-small` | 1536 | 256/512/1024 via `dimensions` param | ~$0.02 | Default cheap option. |
| `text-embedding-3-large` | 3072 | 256/1024/3072 | ~$0.13 | Higher quality, 6.5x more expensive. |
| `text-embedding-ada-002` (legacy) | 1536 | not truncatable | ~$0.10 | Legacy; ignore — no backward-compat reasons here. |

Rate limits (default tier, VERIFY against the operator's actual usage tier):
- ~1M TPM and ~3000 RPM for `text-embedding-3-small` on tier 1.
- Higher tiers raise limits 10x–100x; not a constraint at Saivage scale.

Cost calibration at Saivage scale: one full re-ingest of a 5M-token target docs corpus on `text-embedding-3-small` costs ~$0.10. Daily incremental re-ingest of memories (≤100k tokens) costs fractions of a cent. This is effectively free.

The truncatable dimensionality is a real architectural lever: storing at 512-d instead of 1536-d shrinks the vector store on disk by 3x and speeds ANN search proportionally, with modest recall loss (OpenAI's own benchmarks claim ~5–10% MTEB drop). Worth offering as a config knob but defaulting to 1536-d.

### 2.3 Google (Gemini / Vertex)

Google offers `text-embedding-005` (PaLM-family) and the newer `gemini-embedding-001` (released 2025). Available via Vertex AI and Generative Language API.

| Model | Dim (native) | Dim (truncatable, Matryoshka) | Price per 1M input tokens (VERIFY) | Notes |
|---|---|---|---|---|
| `text-embedding-005` | 768 | n/a | ~$0.025 | Stable, older. |
| `gemini-embedding-001` | 3072 | 256/768/1536/3072 | ~$0.15 | Higher quality, Matryoshka-truncatable. |

Saivage v2 does not currently depend on a Google SDK. Adding `@google/generative-ai` solely for embeddings adds one dependency. Routing through [@mariozechner/pi-ai](saivage/package.json#L31-L32) is preferable if that library exposes embeddings for Google providers — VERIFY pi-ai's embedding surface at design-round time.

### 2.4 Cohere

`embed-english-v3.0`, `embed-multilingual-v3.0`, `embed-english-light-v3.0`, plus the `embed-v4.0` generation.

| Model | Dim | Price per 1M tokens (VERIFY) | Notes |
|---|---|---|---|
| `embed-english-v3.0` | 1024 | ~$0.10 | Strong on MTEB English retrieval. |
| `embed-english-light-v3.0` | 384 | ~$0.10 (same) | Cheaper to store and search. |
| `embed-v4.0` | 1024–1536 | ~$0.12 | Multimodal-capable. |

Cohere offers a useful `input_type` parameter (`search_document` vs `search_query`) that produces asymmetric embeddings — measurably better for retrieval. The design should respect this asymmetry by passing the correct type when embedding queries vs. documents (regardless of which provider is chosen, only some support it).

Cohere requires a Cohere API key; not currently configured for Saivage. Pulling in `cohere-ai` SDK adds another dependency to maintain. Score: viable, not preferred unless quality benchmarks demand it.

### 2.5 Voyage AI

`voyage-3`, `voyage-3-lite`, `voyage-code-3`, `voyage-large-3`. Voyage is Anthropic's recommended embeddings vendor and tends to top MTEB code-retrieval leaderboards.

| Model | Dim | Price per 1M tokens (VERIFY) | Notes |
|---|---|---|---|
| `voyage-3-lite` | 512 | ~$0.02 | Cheapest at Voyage; matches OpenAI small price. |
| `voyage-3` | 1024 | ~$0.06 | Mid-tier. |
| `voyage-code-3` | 1024 | ~$0.18 | Specialized for code retrieval; relevant for Dataset C. |
| `voyage-large-3` | 1024 | ~$0.18 | High-quality general. |

For Dataset C (code), `voyage-code-3` has a real, measurable advantage over generic models (typically +5–10 nDCG@10 on CodeSearchNet-style benchmarks, VERIFY current numbers). Cost is still trivial at Saivage scale.

Rate limits: Voyage publishes per-tier limits; verify when an API key is provisioned.

### 2.6 Mistral

`mistral-embed` and (recently) `codestral-embed` for code.

| Model | Dim | Price per 1M tokens (VERIFY) | Notes |
|---|---|---|---|
| `mistral-embed` | 1024 | ~$0.10 | General-purpose. |
| `codestral-embed` | 1024 | ~$0.15 | Code-specialized. |

Routable via OpenAI-compatible endpoints. No new SDK dep needed if going through pi-ai.

### 2.7 OpenAI-compatible aggregators (Together, Fireworks, DeepInfra)

These hosts proxy open models (e.g. BAAI/bge-large-en-v1.5, intfloat/e5-mistral-7b-instruct, nomic-embed-text-v1.5) behind the OpenAI Embeddings wire format. Pricing typically $0.005–$0.02 per 1M tokens — cheaper than first-party APIs but with provider-specific reliability.

| Hosted model (typical) | Dim | Typical price per 1M tokens (VERIFY) |
|---|---|---|
| `BAAI/bge-large-en-v1.5` | 1024 | ~$0.01 |
| `nomic-embed-text-v1.5` | 768 (Matryoshka-truncatable) | ~$0.01 |
| `intfloat/e5-mistral-7b-instruct` | 4096 | ~$0.10 |

These are interesting because the same models are downloadable for local inference (§3), so a project can start hosted-cheap and later cut over to local with no embedding-space change. That is a meaningful architectural property.

### 2.8 pi-ai routing

[@mariozechner/pi-ai](saivage/package.json#L31-L32) is Saivage's multi-provider abstraction. VERIFY: inspect `node_modules/@mariozechner/pi-ai/dist` (or its repo) to confirm whether its current surface includes embeddings (alongside chat completions / tool calls), and which providers it routes to. If it does, the RAG subsystem should prefer routing embeddings through pi-ai for consistency with the rest of Saivage's provider config. If it does not, the design must add a thin embedding-provider interface that lives alongside pi-ai usage rather than inside it.

### 2.9 Cheapest-reasonable default at Saivage scale

Ranking the candidates against the constraints "cheap, low-friction, already in Saivage's dependency tree, asymmetric-query support not required, no reindex churn expected":

1. **OpenAI `text-embedding-3-small` at 1536-d** — already-shipped SDK, ~$0.02/1M tokens, predictable rate limits, public dimensionality reduction available. Best default for the focused design.
2. **OpenAI `text-embedding-3-small` at 512-d** — same provider but cheaper to store and faster to search; default for very large code corpora where the recall hit is acceptable.
3. **Voyage `voyage-3-lite` or `voyage-code-3`** — best quality-for-cost on the code dataset specifically; recommended config override when Dataset C dominates.
4. **OpenAI-compatible aggregator hosting BGE / Nomic** — cheapest, lowest vendor lock-in, smooth path to fully-local later. Recommended fallback when the operator wants to avoid OpenAI.

Anthropic is explicitly excluded as an embeddings provider. The design must not assume a single provider can do both generation and embeddings.

### 2.10 Cost calibration at expected Saivage workloads

The numbers below assume the §1 corpus estimates (skills + memories ≈ 2–5M tokens; one medium target docs ≈ 5M tokens; one medium target code ≈ 1M tokens) and a workload of one full rebuild per month plus daily incremental re-ingest of ~1% of corpus, plus 10 queries per agent turn × 200 turns per day. All prices "VERIFY" per §2.1–§2.7.

| Provider/model | Monthly rebuild cost | Daily incremental cost | Daily query-embed cost | Approx total / month |
|---|---|---|---|---|
| OpenAI `text-embedding-3-small` | ~$0.22 (11M tokens) | <$0.01 | <$0.01 | <$1 |
| OpenAI `text-embedding-3-large` | ~$1.43 | <$0.05 | <$0.05 | ~$5 |
| Voyage `voyage-3-lite` | ~$0.22 | <$0.01 | <$0.01 | <$1 |
| Voyage `voyage-code-3` (code only) | ~$0.18 (1M tokens code) + small | <$0.01 | <$0.01 | <$1 |
| Aggregator BGE-large | ~$0.11 | <$0.01 | <$0.01 | <$0.5 |
| Transformers.js local | $0 (CPU time) | $0 | $0 | $0 |

At these scales, monetary cost is not a meaningful differentiator between hosted choices. The decision should be driven by quality, latency, and operational simplicity, not by per-token price.

---

## 3. Local embedding options

Local embedding is in scope as a design seam (the abstraction must support it) but explicitly out of scope as an integration deliverable for this work. Goal of this section: pick the candidate that the design seam should be shaped around so a future operator can plug it in without re-architecting.

### 3.1 Transformers.js (`@xenova/transformers`)

Pure-Node ONNX runtime that loads sentence-transformer models from Hugging Face Hub or local disk. Runs on CPU by default; WebGPU/CUDA in newer builds requires non-trivial setup.

- Install footprint: ~50–100 MB of npm deps, model files downloaded lazily (BGE-small ~130 MB, BGE-large ~440 MB, all-MiniLM-L6-v2 ~25 MB).
- Models commonly used: `Xenova/all-MiniLM-L6-v2` (384-d), `Xenova/bge-small-en-v1.5` (384-d), `Xenova/bge-base-en-v1.5` (768-d), `Xenova/multilingual-e5-small` (384-d).
- Throughput on a modern x86 laptop CPU (estimated, VERIFY on the operator's actual host): 50–200 chunks/sec for MiniLM-L6, 20–60 chunks/sec for BGE-small, 5–20 chunks/sec for BGE-large.
- JS/TS ergonomics: best-in-class. Pure ESM, TypeScript types, single `pipeline('feature-extraction', model)` call.
- License: model-dependent (most are MIT or Apache-2.0). The runtime itself is Apache-2.0.

Score: highest single-language compatibility. Top candidate for the "designed-in but not implemented" local option.

### 3.2 fastembed-js

Node bindings to the Rust `fastembed` library, which itself wraps ONNX Runtime with curated embedding models.

- Install footprint: a Rust-built native module (~10–20 MB) plus models (similar sizes to §3.1).
- Models: a curated set of BGE, E5, all-MiniLM, Jina, etc.
- Throughput: comparable to Transformers.js, sometimes 1.5–2x faster on CPU due to tighter ONNX Runtime integration.
- JS/TS ergonomics: smaller, opinionated API. ESM compatibility VERIFY — historically CJS-first.
- License: Apache-2.0.

Score: viable, but native-module-with-prebuilds friction (must publish prebuilds for the host arch) reduces install simplicity vs. Transformers.js. Reject as primary, keep as alternative.

### 3.3 Ollama `/api/embeddings` (or `/api/embed`)

Saivage talks to an existing Ollama daemon over HTTP. Ollama exposes embedding endpoints for many models (`nomic-embed-text`, `mxbai-embed-large`, `all-minilm`, `snowflake-arctic-embed`).

- Install footprint: zero npm deps on Saivage's side beyond `fetch`. Ollama itself is a separate apt/curl install (~150 MB binary plus models).
- Models: `nomic-embed-text` (768-d, 8k context), `mxbai-embed-large` (1024-d, 512 ctx), `snowflake-arctic-embed` (1024-d), `bge-large` (1024-d).
- Throughput: depends on GPU availability. On CPU, comparable to or slower than Transformers.js due to HTTP overhead per request; batching via `/api/embed` mitigates it.
- JS/TS ergonomics: plain HTTP, easy to wrap. No SDK lock-in.
- License: Ollama is MIT; underlying models vary.

Score: zero-dep on Saivage side, attractive if the operator already runs Ollama for other reasons. Slightly weaker than Transformers.js for the "no extra daemons required" minimalist constraint, because Ollama is itself a daemon.

### 3.4 llama.cpp embedding server

`llama-server --embedding` or the `llama-cpp-python`-equivalent serves embeddings via OpenAI-compatible endpoints.

- Install footprint: needs a `llama.cpp` build (apt package on some distros, otherwise `cmake` from source) plus GGUF model files (~100–500 MB per model).
- Models: any GGUF-quantized sentence-transformer; quality acceptable but typically a step below the FP16 / safetensors variants used by Transformers.js.
- Throughput: very fast on GPU, comparable to Ollama on CPU.
- JS/TS ergonomics: OpenAI-compatible endpoint → reuse the `openai` SDK against `http://localhost:8080/v1`.
- License: MIT.

Score: powerful if the operator already has llama.cpp set up, but install complexity is the highest in this list. Reject as primary local recommendation; acceptable as "operator can point the OpenAI-compatible client at this URL" mode.

### 3.5 Comparison summary

| Option | Install on Linux | Model size | Default dim | Throughput (CPU, est.) | JS/TS ergonomics | Daemon? |
|---|---|---|---|---|---|---|
| Transformers.js | `npm i @xenova/transformers` | 25–440 MB | 384–768 | 50–200 chunks/s (small) | Excellent (ESM, TS) | No |
| fastembed-js | npm + Rust prebuilds | 25–440 MB | 384–1024 | 100–300 chunks/s | Good (CJS-leaning) | No |
| Ollama embeddings | curl-install + `ollama pull` | 270–700 MB | 384–1024 | 50–150 chunks/s | Excellent (HTTP) | Yes |
| llama.cpp server | apt or build from source | 100–500 MB | 384–1024 | varies | Excellent (OpenAI-compatible) | Yes |

### 3.6 Designed-in recommendation

The abstraction must be shaped to make Transformers.js the smoothest local plug-in:
- No daemon assumption (the focused design must work in-process).
- Model name is a string in config; nothing in the public surface should hard-code OpenAI model strings.
- Dimensions are not assumed at compile time; they are a property of the configured provider and stored alongside the index (so a dim mismatch on reload is detected, not silently miscompared).
- Query embedding and document embedding may be different calls (Cohere-style `input_type`); the provider interface must accept a role parameter even if many providers ignore it.

Transformers.js is the recommended "designed-in but not implemented" local option. Ollama is the recommended "operator already has it, just point at the URL" fallback.

---

## 4. Vector store survey for embedded JS/TS use

Constraints recap (from F01 §"Hard constraints"):
- Embedded preferred. Either an npm package or talks to a single small local binary.
- Easy install on Linux (apt or pure-npm; no Docker requirement).
- Multi-tenancy across datasets is mandatory.
- Filterable metadata is mandatory (scope, project, role, mtime, file path).
- ANN algorithm only needs to scale to ~100k vectors per collection initially, with headroom to 1M.
- License must allow embedding in Saivage's commercial-permissive setup (Apache-2.0, MIT, BSD, MPL acceptable; AGPL not).

### 4.1 sqlite-vec (with better-sqlite3)

SQLite extension by Alex Garcia exposing `vec0` virtual tables for vector storage and KNN search. Distributed as a loadable extension (`.so`/`.dylib`/`.dll`) and via the `sqlite-vec` npm package, which bundles a prebuilt extension and helpers to `loadExtension` into a `better-sqlite3` or `node:sqlite` connection.

- Install footprint: `better-sqlite3` (~6 MB native build, prebuilds for common arches) + `sqlite-vec` (~2 MB with bundled extension). Pure npm install, no apt deps.
- JS/TS API quality: very good. `better-sqlite3` is sync and TypeScript-typed; sqlite-vec exposes plain SQL (`SELECT … FROM vec_chunks WHERE embedding MATCH ? AND k=10`). All filtering composes via standard SQL `WHERE`.
- Persistence model: single SQLite file per database. Trivial backup (`cp file.db`), trivially scoped per project under `.saivage/rag/`.
- Multi-collection support: by table or by metadata column. Both are idiomatic.
- Filterable metadata: full SQL — best filtering story in this list.
- ANN algorithm: brute-force exact KNN by default; recent releases add an IVF-style approximate option (VERIFY which version is current and whether IVF is stable). At ~100k vectors with 768-d embeddings, brute force is single-digit milliseconds per query; brute force is acceptable up to roughly 1M vectors before becoming noticeable.
- Scaling ceiling: ~1M vectors per collection comfortably (brute force) or higher with IVF.
- License: Apache-2.0.

Score: excellent fit. Embedded, pure-npm install, SQL filters, single-file persistence per project. Top candidate.

### 4.2 LanceDB (`vectordb` npm, now `@lancedb/lancedb`)

Embedded columnar store with vector + lexical search, written in Rust, exposed via Node bindings.

- Install footprint: ~30–50 MB native module with prebuilds for common arches. Pure npm install.
- JS/TS API quality: very good, first-class TypeScript types. `db.openTable`, `table.add`, `table.search().where(...).limit(k)`.
- Persistence model: directory-based (Lance format on Arrow + Parquet under the hood). Backup is a directory copy.
- Multi-collection support: native (tables within a database).
- Filterable metadata: SQL-like predicate strings (`db.openTable('...').search(vec).where("scope = 'project'").limit(10)`).
- ANN algorithm: IVF-PQ optional, otherwise brute-force; full-text BM25 supported in recent versions for hybrid retrieval.
- Scaling ceiling: easily 10M+ vectors; this is overkill for Saivage.
- License: Apache-2.0.

Score: excellent, slightly heavier than sqlite-vec. Best candidate if hybrid (vector + BM25) is ever wanted. Top alternative.

### 4.3 hnswlib-node

Pure HNSW (Hierarchical Navigable Small World) index, no metadata store.

- Install footprint: small native module.
- JS/TS API quality: minimal — just `addPoint`, `searchKnn`. Metadata storage is the caller's problem.
- Persistence model: `writeIndex(path)` / `readIndex(path)`.
- Multi-collection: one index per file; the caller maintains the mapping.
- Filterable metadata: not supported in-index. Post-filtering only (search top-N*k, then filter, then truncate) — wasteful when filters are selective.
- ANN algorithm: HNSW.
- Scaling ceiling: high, but the operational burden (separate metadata DB, no transactions across the two) is the killer.
- License: Apache-2.0.

Score: rejected. Requires building a metadata store next to it, which reinvents sqlite-vec / LanceDB.

### 4.4 ChromaDB (embedded)

Chroma has an embedded mode (`PersistentClient` in Python; the Node `chromadb` package was historically thin and required a running Chroma server). Recent versions ship a `chromadb` server binary; embedded-in-Node mode remains underdeveloped.

- Install footprint: substantial. The Node SDK is light, but the server binary (or Python interop) is the operational unit.
- JS/TS API quality: SDK is fine, but it always assumes a running Chroma server (default port 8000).
- Persistence model: directory on disk, managed by the server.
- Multi-collection: native (collections).
- Filterable metadata: yes, JSON-style `where` clauses.
- ANN algorithm: HNSW under the hood.
- Scaling ceiling: high.
- License: Apache-2.0.

Score: violates "no separate DB server" preference. Reject for the focused design; could be reconsidered in the "one level up" sidecar variant.

### 4.5 Qdrant (local server)

Rust-based vector DB with rich filtering. Typically run as a server (Docker, binary).

- Install footprint: Qdrant binary or container. There is a `@qdrant/js-client-rest` SDK.
- JS/TS API quality: very good SDK.
- Persistence model: server-managed; files in a data directory.
- Multi-collection: native.
- Filterable metadata: best-in-class payload filters.
- ANN algorithm: HNSW.
- Scaling ceiling: very high (this is what production Qdrant deployments handle billions on).
- License: Apache-2.0.

Score: overkill for Saivage's scale and violates the "no Docker requirement, prefer embedded" preference. Reject for the focused design; only revisit as a sidecar.

### 4.6 pgvector (requires Postgres)

Postgres extension. Requires an installed and running Postgres server.

- Install footprint: full Postgres dependency. apt-installable but not minimal.
- JS/TS API quality: through `pg` or `postgres` clients; good.
- Persistence model: Postgres-managed.
- Multi-collection: via tables.
- Filterable metadata: full SQL.
- ANN algorithm: IVFFlat, HNSW.
- Scaling ceiling: very high.
- License: PostgreSQL license (BSD-style).

Score: hard reject. F01 §"Hard constraints" explicitly forbids "separate DB server unless absolutely required," and there is no Saivage scenario that requires Postgres for RAG.

### 4.6.1 Other candidates considered briefly and rejected

- **USearch** (`usearch` npm package): single-header C++ ANN with Node bindings. Very fast, but metadata storage is again the caller's problem (same shape as hnswlib-node). Reject for the same reason.
- **Milvus Lite** (`@zilliz/milvus2-sdk-node` against Milvus Lite): embedded SQLite-backed Milvus. Promising but heavier dep tree than sqlite-vec and a less mature Node story. Reject as primary; reasonable third-tier fallback.
- **Weaviate embedded**: Java-runtime-backed; install footprint prohibitive against the F01 minimalism constraint. Reject.
- **Vald, Marqo, Vespa**: server-class systems; out of scope.
- **Raw FAISS** via `faiss-node`: native module, no metadata, brittle Node bindings as of mid-2025. Reject.

The shortlist after this triage is sqlite-vec, LanceDB, and (a distant third) Milvus Lite.

### 4.7 Scoring summary

Scoring rubric (1–5, 5 best) against F01 constraints. Columns: install simplicity (apt-free, pure-npm > native-module > daemon > server), JS/TS ergonomics, metadata filtering, multi-collection, fit-to-scale, license.

| Store | Install | TS API | Filtering | Multi-coll | Scale fit | License | Verdict |
|---|---|---|---|---|---|---|---|
| sqlite-vec + better-sqlite3 | 5 | 5 | 5 | 5 | 5 | 5 | **Primary** |
| LanceDB (`@lancedb/lancedb`) | 4 | 5 | 5 | 5 | 5 | 5 | **Fallback** |
| hnswlib-node | 5 | 2 | 1 | 2 | 4 | 5 | Reject |
| ChromaDB embedded | 2 | 4 | 4 | 5 | 5 | 5 | Reject (server) |
| Qdrant local | 2 | 5 | 5 | 5 | 5 | 5 | Reject (server) |
| pgvector | 1 | 4 | 5 | 5 | 5 | 5 | Reject (server) |

### 4.8 Primary + fallback recommendation

- **Primary**: sqlite-vec on top of better-sqlite3. Single file per dataset under `.saivage/rag/`, SQL filters, sync API plays well with Saivage's existing sync knowledge store at [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts), trivial backup story.
- **Fallback**: LanceDB. Same install profile, better when corpora exceed a few hundred thousand chunks or when hybrid BM25 retrieval becomes desirable. Switching from sqlite-vec to LanceDB later is an operator-visible config change but a manageable rewrite of the store-adapter layer (precisely the seam the design must create).

Both stores share enough properties (embedded, multi-collection, metadata-filterable, ANN) that one store-adapter interface can cover both without lowest-common-denominator damage.

---

## 5. Chunking and ingestion strategy

Chunking, metadata, and idempotency are the three places where naïve RAG implementations rot fastest. This section sets the rules; the design round will turn them into module boundaries.

### 5.1 Prose / markdown chunking

Source materials: Dataset A memory bodies, Dataset B docs.

Recommended strategy:
- Split on markdown structural boundaries first: H1/H2/H3 sections become candidate chunks.
- If a section exceeds the max chunk size (recommended 800 tokens), recursively split by H4, then by paragraphs, then by sentence boundaries.
- If a section is smaller than the min chunk size (recommended 100 tokens), greedily concatenate with the previous sibling until a chunk reaches the target band.
- Target chunk size band: 400–800 tokens. This sits comfortably under all considered embedding models' context windows and is large enough to carry semantic context but small enough to give precise top-k results.
- Overlap: 50–100 tokens between adjacent chunks (10–15% overlap) to avoid cutting a definition exactly between two chunks. Pure header-based splits often need zero overlap because sections are self-contained; only the recursive-split path needs overlap.
- Always retain the heading path as a string in chunk metadata (e.g. `"H1 > H2 > H3"`). The agent prompt builder will use it.

YAML front-matter, HTML comments, and code fences inside markdown are not split further but their content counts toward the token budget. Code fences inside docs are not specially-embedded with a code model; they ride along with their surrounding prose chunk.

### 5.2 Code chunking

Source materials: Dataset C source files.

Recommended strategy:
- Prefer AST-aware chunking using `tree-sitter` (Node bindings: `tree-sitter` + grammar packages like `tree-sitter-typescript`, `tree-sitter-python`). Walk the AST and emit one chunk per top-level declaration (function, class, method, exported const).
- If a function/class exceeds the max chunk size (recommended 1000 tokens for code — code is denser than prose), recursively chunk by inner block at the next AST level.
- Tiny declarations (under 50 tokens) get greedily merged with their sibling in source order, up to a max merge of ~600 tokens.
- Fall back to naïve line-window chunking (e.g. 60-line windows with 10-line overlap) only when tree-sitter has no grammar for the language. This keeps the design simple: AST-aware where possible, fixed-window otherwise.
- Carry symbol metadata: `{symbolName, symbolKind: "function"|"class"|"method"|"const", startLine, endLine, language}`. The query path can filter by these to answer "find me the function named X" without round-tripping to ripgrep.

Tree-sitter cost: pure-Node Wasm version (`web-tree-sitter`) is portable but slower; native bindings (`tree-sitter`) need prebuilds. Either is acceptable; the choice is design-round work. VERIFY: confirm `tree-sitter` 0.20+ Node bindings work cleanly under Node 20 ESM (historically there were CJS-only friction points).

Note on lexical search: embeddings are not the right tool for exact-symbol search (e.g. "find usages of `assertScopePathCoherence`"). The design must not pretend otherwise. For exact-symbol queries, the right tool remains ripgrep or the language server. The RAG subsystem should expose only semantic queries and leave lexical search to its callers.

### 5.3 Short memory notes

Source materials: Dataset A memories — KnowledgeRecord rows whose body is typically 50–500 tokens.

Recommended strategy:
- Do not chunk. One memory = one chunk. The body is already short enough; splitting it loses local context.
- The embedding is computed over `${title}\n\n${body}` (or whatever the record schema exposes — design-round to confirm against [saivage/src/knowledge/types.ts](saivage/src/knowledge/types.ts)).
- Metadata is the structured fields from the KnowledgeRecord (scope, scope_ref, role, lifecycle status, created_at, supersedes, etc.). This matches the existing filter axes the knowledge store already supports.

### 5.4 Metadata schema (target shape)

The design round will formalize types. The data the query path must be able to filter on, derived from §1 use cases:

- `datasetId` (which dataset / collection).
- `projectId` (which project root).
- `source` discriminator: `"skill" | "memory" | "doc" | "code"`.
- `path` (repo-root-relative file path).
- `chunkIndex`, `startLine`, `endLine` (so the chunk can be located in the source).
- `contentHash` (sha256 of the chunk's text, for idempotency).
- `sourceHash` (sha256 of the originating file at ingest time, for change detection at file granularity).
- `mtimeMs` (file mtime at ingest, redundant safety against subtle hash collisions; not relied on alone).
- `embeddingProvider`, `embeddingModel`, `embeddingDim`, `embeddingVersion` (so a dimension or model change is detectable).
- `language` (for code; null otherwise).
- `headingPath` (for docs/markdown).
- `symbolName`, `symbolKind` (for code).
- `scope`, `scopeRef`, `role`, `lifecycleStatus`, `createdAt`, `supersedes` (for memories — mirrors the knowledge store).
- `tags[]` (optional, free-form, for future use).

Schema discipline: this is the union schema. The store-adapter must accept a Zod schema per dataset (already a pattern in [saivage/src/knowledge/types.ts](saivage/src/knowledge/types.ts)) and not promiscuously accept anything; nullable fields stay nullable in storage, not collapsed.

### 5.5 Idempotency and change detection

Required properties:
- Re-ingesting the same file twice produces the same vectors and does not create duplicate rows.
- Re-ingesting after a file edit replaces only the chunks whose `contentHash` changed; unchanged chunks (most of them, for small edits) are left alone — no re-embedding cost.
- Re-ingesting after a file delete removes all chunks tagged with that `path` and `projectId`.

Mechanism:
1. Per ingest run, walk the source tree producing `(path, sourceHash, mtimeMs)` for every eligible file. Apply exclusion patterns (see §7) before listing.
2. Diff against the store: `sourceHash` mismatch → re-chunk that file; absent in source but present in store → delete those chunks; present in source but absent in store → ingest those chunks.
3. For each re-chunked file, compute per-chunk `contentHash` and upsert by `(datasetId, path, chunkIndex, contentHash)`. Pre-existing rows with the same `contentHash` are not re-embedded; rows with a missing or different hash are re-embedded.
4. Tombstone with hard delete (no soft-delete state in storage): the chunk either exists or does not. Audit of who-deleted-what is the knowledge store's responsibility for Dataset A; the RAG store does not duplicate audit.

Change-detection tradeoff: `mtimeMs` is a cheap pre-filter (skip files whose mtime is unchanged since last ingest, avoid hashing them at all). `sourceHash` is the authoritative check for changed files. The mtime cache lives in the same SQLite database as the chunks (e.g. an `ingest_files` table) to keep the on-disk layout to a single file per dataset.

### 5.6 Dimension change

If the configured embedding provider or model changes (e.g. operator switches from OpenAI 1536-d to Voyage 1024-d), all stored vectors are unusable — they live in a different space.

Required behavior:
- Detect at startup: compare `(embeddingProvider, embeddingModel, embeddingDim)` of the configured provider against the values stamped on existing rows.
- On mismatch: refuse to mix. Either (a) refuse queries until the operator runs an explicit `rebuild` lifecycle op, or (b) auto-rebuild the affected dataset(s) at startup if config opts in. Default: refuse with a clear error; auto-rebuild is too expensive to trigger silently.
- The lifecycle `rebuild` op must drop all chunk rows for the affected dataset, then re-ingest end-to-end. No partial / overlapping spaces ever coexist in one query.

This is the cleanest expression of the "no backward compatibility" rule for vector spaces: there is no path that lets old 1536-d vectors satisfy a new 1024-d query. The implementer must never write code that tries.

### 5.7 Throughput sanity check

Worst-case full rebuild of a medium target docs corpus (5M tokens) with OpenAI `text-embedding-3-small`:
- Embedding API: 5M tokens / (e.g.) 1M TPM = 5 minutes of wall clock at tier-1 limits, ignoring per-request overhead. Batched requests of ~100 chunks at a time keep this near the theoretical limit.
- Vector store write: better-sqlite3 inserts at tens of thousands per second; negligible vs. embedding latency.
- Disk: 5M tokens / 400 = ~12k chunks × (1536 floats × 4 bytes + ~500 bytes metadata) = ~80 MB on disk. Comfortable.

Local Transformers.js with BGE-small (384-d) on CPU:
- ~60 chunks/sec × 12k chunks = ~3.5 minutes of CPU. Acceptable for a full rebuild; the design should keep ingest off the agent's hot path regardless (background ingest queue, not blocking synchronous calls).

Incremental ingest (1% of corpus changed) is sub-second in both modes.

### 5.8 Quantization and storage compaction

For corpora that push past the 1M-chunk mark, the design must consider:

- **Float16 storage**: halves disk and RAM with imperceptible recall loss for cosine similarity. sqlite-vec supports `float[N]` and `int8[N]` vector types; LanceDB stores Arrow vectors in any numeric type.
- **Int8 quantization**: another 2x compaction at typically <2% recall loss when ranges are calibrated per-component. Useful only past ~1M chunks; premature at Saivage's expected scale.
- **Product quantization (PQ)**: meaningful only at ~10M-chunk scale; not applicable here.

The library's storage layer must accept a quantization mode in store-adapter config; default `float32`. Switching quantization is treated identically to switching embedding model — it requires `rebuild`.

### 5.9 Tokenization for chunk-size accounting

Chunk-size budgets are stated in tokens, not characters. The library must agree with the embedding provider on what "token" means for budgeting:

- For OpenAI models, the existing [js-tiktoken](saivage/package.json#L36-L37) dependency provides the correct BPE tokenizer (`cl100k_base` / `o200k_base`).
- For other providers, exact token counts may not be available; the library falls back to a coarse `chars / 4` approximation and accepts ~10% overshoot.
- The library does not need to enforce the provider's max-input limit exactly — chunkers should target well under the limit (e.g. 800-token chunks against 8192-token model contexts), making strict accounting unnecessary.

---

## 6. Public surface sketch

This is the minimum operation list. It is not a design — no type signatures here, no module names. The design round picks the names.

### 6.1 Configuration surface (read at startup)

- Per-project `saivage.json` keys (top-level `rag:` block, design-round to formalize) that enable the subsystem and select provider + store. If the block is absent, the subsystem stays disabled (rollback property required by F01).
- Provider config: provider id (`"openai" | "voyage" | "transformers-js" | …`), model id, dimensions, API key reference (by name, never inlined), optional `dimensions` truncation, optional `inputType` policy.
- Store config: store id (`"sqlite-vec" | "lancedb"`), on-disk path defaulting to `<projectRoot>/.saivage/rag/`.
- Dataset registry: a list of `{id, includeGlobs, excludeGlobs, chunker, metadataSchema}` entries. Datasets that are not declared cannot be ingested or queried.

### 6.2 Lifecycle operations (operator-facing)

- `listDatasets()` — what is registered and what is its on-disk state (chunk count, last ingest time, embedding model stamp).
- `ingest(datasetId, { force?: boolean })` — incremental by default; full re-embed when `force`.
- `rebuild(datasetId)` — drop and re-ingest. Required after a model/dimension change.
- `drop(datasetId)` — delete all chunks and the dataset's on-disk file. Operator must confirm; this is destructive.
- `stats(datasetId)` — chunk count, distinct file count, last-ingest timestamp, embedding model stamp, on-disk byte size.

### 6.3 Ingest operations (callable by future consumers and by the lifecycle layer)

- `add(datasetId, items[])` — accept already-chunked items or raw `{path, text, metadata}` documents and let the registered chunker process them.
- `update(datasetId, items[])` — same as add but assumes the caller has resolved which path is replacing which.
- `delete(datasetId, { path? , ids? })` — by path or by chunk id.

These are intentionally low-level. Higher-level "ingest a directory tree" is built on top of these.

### 6.4 Query operations (callable by future consumers)

- `query(datasetId, { queryText, topK, filter?, mode? })` — embed `queryText`, ANN search top-K, optionally apply a metadata filter. `mode` is `"document" | "query"` to support providers with asymmetric embeddings (Cohere, Voyage); ignored by providers that do not.
- Returned items always carry: `text`, full metadata, `score` (cosine similarity in [-1, 1] or the store's native distance with documented direction), and a `chunkId` opaque to the caller.

That is the entire query surface. No reranker, no hybrid BM25 in v1. Hybrid is a separate work item if benchmarks ever show it is needed.

### 6.5 What the surface deliberately does not include

- No "summarize for me" wrapper. The RAG library returns chunks; the agent prompt builder turns chunks into prompts. Keeping these separated avoids leaking LLM-generation concerns into the retrieval layer.
- No cross-dataset query. If the caller wants both skills and docs, they call twice and merge. This keeps filters simple and avoids invented per-dataset weight knobs.
- No streaming / incremental KNN. All ANN searches return a complete result list in a single response.
- No write-ahead queue. Synchronous ingest is fine at Saivage scale (see §5.7). A background queue can be added later if the agent loop measurably stalls during ingest.

### 6.6 Concurrency model

- Single-process, single-writer per dataset. Multiple concurrent queries are fine; concurrent ingests on the same dataset serialize on a per-dataset mutex held inside the library. This mirrors the single-writer-per-project guarantee already enforced via `runtime.lock` in the knowledge layer at [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts#L3-L13).
- Cross-process access is not supported. If two Saivage processes end up pointing at the same `.saivage/rag/` directory, behavior is undefined; the design must either enforce a file lock or document this loudly. better-sqlite3 + sqlite-vec naturally serialize via SQLite's locking; LanceDB does not promise multi-writer safety.
- Ingest is async-friendly: it returns a Promise, batches embedding requests, and yields between batches to keep the event loop responsive for queries.

### 6.7 Observability surface

Minimum operational telemetry the library must emit (structured logs only; metrics integration is the consumer's concern):

- `ingest.start` / `ingest.complete` / `ingest.failed` per dataset, with file count, chunk count, embedding tokens consumed, wall-clock duration.
- `query.complete` per query with dataset id, top-k, filter shape (not values), latency split into `embed_ms` and `search_ms`.
- `secret.blocked` per dropped chunk (path, pattern that matched, never content).
- `dimension.mismatch` per refused query (configured dim vs. stored dim).

No log line ever contains chunk text or embedding vectors. Logs go through the existing Saivage logger; this analysis does not prescribe a format.

### 6.8 Hybrid retrieval (BM25 + vectors) — deferred

Hybrid retrieval (combining lexical BM25 scores with vector cosine scores via reciprocal-rank-fusion or similar) is known to outperform pure-vector retrieval on certain corpora (especially short technical documents heavy on identifiers). It is nevertheless rejected for v1 because:

- LanceDB and sqlite-vec both ship some form of full-text index, but the chosen primary (sqlite-vec) uses SQLite FTS5 separately, requiring a second index and a fusion layer the library would have to maintain.
- The agent consumers already do a form of re-ranking (the LLM reads top-k and decides what is relevant). Doubling the retrieval pathway adds complexity that does not clearly improve agent outcomes at the corpus sizes in §1.
- Exact-symbol lookups, which are the strongest case for lexical search, are explicitly delegated to ripgrep / LSP per §5.2; the RAG library's surface does not pretend to handle them.

If a future benchmark on a specific dataset shows pure-vector retrieval is leaving recall on the table, hybrid can be added as a per-dataset config flag without breaking the public surface (it is implemented as a different `query` mode behind the same call).

---

## 7. Failure modes and security

### 7.1 Provider outages

Embedding provider down at query time:
- Reject the query with a typed error. Do not silently fall back to a different model — that would mix embedding spaces.
- Optional: cache recent query embeddings keyed by `(provider, model, dim, sha256(queryText))` so an immediate retry after an outage hits the cache. Bounded LRU, no cross-process sharing required.

Embedding provider down at ingest time:
- Pause the affected ingest job. Mark it as `failed-retryable` in the lifecycle status. Do not write partial vectors with missing rows next to vectors that did get embedded; either everything for the affected file batch is written or nothing is.
- The store must already be in a consistent state when the process is killed mid-ingest. better-sqlite3 transactions per file batch achieve this; LanceDB's writer also commits atomically per write call.

### 7.2 Provider rate-limit and quota

- Honor 429 responses with respect for `Retry-After` headers; exponential backoff with jitter capped at ~60s.
- Batch up to the provider's documented batch ceiling (OpenAI accepts up to 2048 inputs per call) and the provider's per-input token ceiling.
- Per-process embed concurrency bounded to a small number (e.g. 4) to avoid bursting through tier-1 rate limits.

### 7.3 Embedding model drift / dimension change

Covered in §5.6. The detection-and-refuse default is the safe stance; the only way to "upgrade" is `rebuild`. There is no shim, no on-the-fly re-embedding of old rows. This matches the workspace's no-backward-compatibility rule.

### 7.4 Poisoned content

Threat: a document being ingested contains adversarial text designed to manipulate later LLM reasoning (e.g. "ignore previous instructions" buried in a markdown file). RAG retrieval will surface this to an agent prompt.

Mitigations available within the RAG layer:
- Content does not become privileged just because it was retrieved. The consumer (prompt builder) is responsible for sandwiching retrieved chunks between clear delimiters and instructing the model not to follow instructions embedded in them. The RAG library does not promise to sanitize prose.
- Surface the source path in metadata so the consumer (or a downstream auditor) can trace any odd model behavior back to its origin. This is the most important hardening lever the retrieval layer can provide.
- Do not extract and execute anything embedded in retrieved chunks (e.g. URLs, MCP tool-call hints). The library returns text, not actions.

These are guardrails, not guarantees. Prompt-injection robustness is a generation-time concern; the retrieval layer cannot solve it alone.

### 7.5 Accidental indexing of secrets

This is the highest-severity local risk. The Saivage knowledge store already enforces secret guards (`scanForSecrets`, `isBlockedPath` in [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts#L19-L31)). The RAG layer must enforce the same posture independently — defense in depth, because the RAG layer may receive raw file streams that bypass the knowledge store path.

Mandatory exclusion patterns at the ingest entry point (applied before files are read, not just before they are embedded):

```
.saivage/auth-profiles.json
.saivage/**/auth-profiles.json
.saivage/tmp/**
.saivage-work/**
.env
.env.*
**/*.pem
**/*.key
**/*.p12
**/*.pfx
**/id_rsa
**/id_ed25519
**/*credentials*
**/*secret*
**/.git/**
**/node_modules/**
**/dist/**
**/build/**
**/.venv/**
**/venv/**
**/__pycache__/**
**/.cache/**
```

The list is owned by the RAG ingest layer, not by individual consumers. It is non-overridable for the security-critical entries (the credential / private key patterns); the doc-tree exclusions are operator-overridable per-dataset.

Additionally, the ingest pipeline must:
- Run a secrets scanner over each chunk's text before storing it (reuse the helper at [saivage/src/security/secrets.ts](saivage/src/security/secrets.ts) — note that this is a read-only reference; we do not modify it). On match, drop the chunk and emit a structured warning. Never store the matching text, never embed it.
- Never log chunk content at info-level. Only metadata (path, size, hash prefix) goes to operational logs.
- Never include `.saivage/auth-profiles.json` content in any error message, even if the file is somehow read past the exclusion filter. The error path must be aware of which files are tagged sensitive and degrade its own verbosity.

The RAG store's on-disk files must inherit `.saivage/` directory permissions (operator-owned, mode 0700 directory / 0600 files where the OS supports it). The design round must specify that explicitly.

### 7.6 In-process vs. sidecar

In-process (the focused-design assumption):
- Pros: zero new ports, zero new daemons, lifecycle tied to the Saivage server process, simplest config.
- Cons: a slow embedding call from a hosted provider holds an event-loop turn (mitigable with `await`); a misbehaving native module (e.g. better-sqlite3 segfault on a corrupted database) takes the Saivage process down with it.
- Memory footprint: vector store mostly memory-mapped (SQLite) or memory-resident (LanceDB cache), bounded by the per-collection ANN structures. Should stay under 200 MB for the realistic ceilings in §1.

Sidecar (the "one level up" candidate, for the design round):
- Pros: isolation (a crashed embedding subprocess does not kill Saivage), potentially exposable via MCP to other tools, can be swapped from embedded sqlite-vec to a heavier store without touching the Saivage main process.
- Cons: another binary to launch, supervise, and version; another port; harder install story; latency overhead of the local IPC hop.
- Worth it only if the design round can demonstrate a concrete benefit (e.g. crash isolation requirements, multi-process query fan-out, MCP-exposed retrieval as a Saivage product surface) that the focused in-process design cannot deliver.

The default position is in-process. The sidecar option must justify itself in the design round, not be assumed.

### 7.7 Disk corruption / partial writes

- All writes that span multiple rows happen inside a single transaction (SQLite `BEGIN`/`COMMIT`; LanceDB single `add` call).
- Lifecycle `rebuild` writes to a sibling directory / file and atomically renames at the end, so a crash mid-rebuild does not wipe the prior good index.
- Startup runs a lightweight integrity check (`PRAGMA integrity_check` for SQLite; `table.countRows()` sanity for LanceDB). On failure: refuse queries and flag the dataset as `corrupted`; lifecycle `rebuild` is the only recovery path.

### 7.8 PII and audit

Beyond credentials, the RAG layer may incidentally index PII present in target documents (names, emails in commit logs, etc.). The library cannot detect arbitrary PII reliably. The mitigation is operator-side: declare exclusions per dataset and trust the operator's directory choices. The library only commits to honoring the exclusion list and to not exfiltrating chunks to anywhere other than the configured embedding provider.

If the embedding provider is hosted (OpenAI, Voyage, etc.), every chunk text is sent to that vendor. The operator must understand this; the design must surface the embedding provider in `stats()` output so an operator can audit "what model has seen my docs."

### 7.9 Backup and restore

- For sqlite-vec: backup is a file copy of `<dataset>.db` while no writer is active, or `VACUUM INTO 'backup.db'` for a live online backup. Restore is a file replacement. The library does not provide higher-level backup helpers; that is operator territory.
- For LanceDB: backup is a recursive directory copy. Same property: atomic snapshots require pausing writers (e.g. holding the per-dataset ingest mutex during the copy).
- The `.saivage/rag/` directory is safe to delete entirely; the subsystem reconstructs everything from source on the next `ingest`. This is the canonical disaster-recovery path and the reason the on-disk store is treated as derived data, not source of truth.

### 7.10 No-backward-compat reaffirmed

To prevent drift back into compatibility shims as the design round and implementation proceed:

- There is no on-disk schema version that promises forward compatibility. If a future change alters the table layout, the lifecycle `rebuild` is the only supported upgrade path. The store-adapter is allowed to detect "this looks like an older layout" and refuse with a clear `rebuild required` error; it is not allowed to migrate in place.
- There is no fallback to a prior embedding-provider config when the current one fails. If the operator removes OpenAI from the provider config but old vectors remain stamped with OpenAI, the subsystem refuses to serve queries on that dataset until `rebuild`. There is no "use whatever stored vectors there are" code path.
- There are no compatibility shims for prior Saivage `src/knowledge/` data shapes. The RAG layer treats the knowledge store as a future producer; it does not read knowledge-store files directly until the consumer integration spec (out of scope here) defines how. This keeps the RAG layer from quietly absorbing knowledge-store internals.

### 7.11 Boundary with the existing knowledge store

The existing knowledge layer at [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts) and [saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts) already provides durable, audited, secret-scanned storage of skills and memories. The RAG layer is strictly additive: it builds a queryable vector view over content the knowledge store owns.

Consequences for the analysis:
- The RAG layer does not duplicate audit. When a memory is superseded, the knowledge store records the audit event; the RAG layer just upserts the new vector and tombstones the old.
- The RAG layer does not duplicate the secret-scanner; it calls into [saivage/src/security/secrets.ts](saivage/src/security/secrets.ts) (or its equivalent) as a function, treating it as the single source of truth for "is this string sensitive."
- The RAG layer does not own the on-disk format of skills or memories. It receives them as opaque `{text, metadata}` pairs from a (future) adapter and produces vectors. If the knowledge store changes its on-disk layout, the adapter changes; the RAG store does not.

This boundary is what makes "no integration design with specific Saivage v2 features" (F01 §"Hard constraints" item 2) achievable: the RAG library has a tiny ingest API, and a future spec wires producers into it.

---

## 8. Summary of recommendations to carry into the design round

- Default embeddings provider: OpenAI `text-embedding-3-small` at native 1536-d, with a 512-d truncated mode as a config switch for very large corpora. Anthropic explicitly not used for embeddings.
- Default vector store: sqlite-vec on top of better-sqlite3, single file per dataset under `<projectRoot>/.saivage/rag/`.
- Fallback vector store: LanceDB (`@lancedb/lancedb`), same abstraction.
- Designed-in local embedding option: Transformers.js (`@xenova/transformers`), with Ollama HTTP as a secondary slot.
- Chunking: markdown → header-aware recursive split (400–800 tokens, light overlap). Code → tree-sitter-aware, one declaration per chunk (up to 1000 tokens), naïve line-window fallback. Memories → no chunking.
- Metadata schema covers source, path, line span, content/source hashes, embedding-provider stamps, scope/role/lifecycle (for memories), and symbol/language (for code).
- Idempotency: per-file mtime pre-filter, per-file sourceHash authoritative check, per-chunk contentHash for upsert. Dimension change is detected and refused unless `rebuild` runs.
- Public surface: dataset registration, lifecycle (ingest/rebuild/drop/stats), ingest (add/update/delete), query (top-k + filter, document/query embedding mode). No reranker, no hybrid, no cross-dataset query in v1.
- Security: hard exclusion patterns enforced at the ingest boundary, per-chunk secret scan, dropped sensitive chunks never logged or stored, on-disk files inherit `.saivage/` ownership.
- Deployment posture: in-process by default; sidecar variant only if the design round can justify it.

---

## 9. Items the implementer must verify before the design round

Each item below has been flagged "VERIFY:" in context above. Collected here for the orchestrator's convenience.

- VERIFY: Anthropic still does not ship a public `/v1/embeddings` API as of the design-round date.
- VERIFY: current OpenAI embeddings prices ($0.02 per 1M tokens for `text-embedding-3-small`, $0.13 for `text-embedding-3-large`) and tier-1 rate limits (~1M TPM, ~3000 RPM) against [platform.openai.com/docs](https://platform.openai.com/docs).
- VERIFY: current Google Gemini embeddings prices and dimensions (`text-embedding-005`, `gemini-embedding-001`).
- VERIFY: current Cohere embed pricing and `input_type` support across the v3.x and v4 models.
- VERIFY: current Voyage AI pricing for `voyage-3-lite`, `voyage-3`, `voyage-code-3` and current MTEB / code-retrieval leaderboard standings for `voyage-code-3` vs. OpenAI / Cohere.
- VERIFY: current Mistral embeddings pricing for `mistral-embed`, `codestral-embed`.
- VERIFY: current OpenAI-compatible aggregator pricing on Together / Fireworks / DeepInfra for BGE-large, Nomic, E5-mistral.
- VERIFY: whether [@mariozechner/pi-ai](saivage/package.json#L31-L32) exposes an embeddings surface (and for which providers) by inspecting its current published version under `node_modules/@mariozechner/pi-ai`.
- VERIFY: Transformers.js CPU throughput numbers on the operator's actual host hardware (the §3.1 estimates are conservative averages, not measurements on this machine).
- VERIFY: sqlite-vec current release and whether IVF / ANN indexes are stable or still brute-force only; if brute-force only, confirm latency at the 100k-vector / 1M-vector points on the operator's hardware.
- VERIFY: `tree-sitter` Node 20 ESM compatibility for the chosen language grammars (`tree-sitter-typescript`, `tree-sitter-python`, etc.) — historically there have been CJS-only friction points.
- VERIFY: actual on-disk size of [saivage/docs/](saivage/docs/) excluding generated TypeDoc output (the 1194-file count includes generated content that should not be ingested; the design must distinguish hand-written `docs/` from generated `docs/api/`).
