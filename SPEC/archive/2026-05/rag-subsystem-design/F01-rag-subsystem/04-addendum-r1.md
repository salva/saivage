# F01 — RAG subsystem design addendum

## 1. Scope of this addendum

This document extends the Saivage v2 RAG subsystem with three deltas that affect surface policy, runtime change-handling, and the architectural placement of an intelligent retrieval agent. It is self-contained: the rules stated here govern the implementation. It does not relitigate the surrounding library design; it adds.

The deltas are:

1. A boundary policy that fixes which surface — primitive seams or facade — a given caller is expected to use, and which "convenience" features the facade must refuse on principle.
2. A specification for external-change handling: an explicit update API (already provided by the facade) plus an opt-in `chokidar`-backed directory watcher with reconcile-on-startup, debouncing, lock-awareness, and explicit failure modes for inotify limits and event floods.
3. A statement that a future "librarian" agent will be the intelligent layer above the RAG library, designed in a separate dance. The librarian is one consumer; it is not a gateway, and the library exposes the same stable contract to direct in-process callers and to the librarian alike.

All file references below are to real repository paths. The work is TypeScript / ESM under Node LTS >= 24. Architecture-first: no backward compatibility, no migration shims, no scope creep.

## 2. Addition 1 — Facade-vs-primitives boundary policy

### 2.1 Two equal-status entry points

The RAG library exposes two surfaces, and a caller picks based on what it needs:

| Layer | Where | When to use |
|---|---|---|
| Primitive seams | [saivage/src/rag/store/](saivage/src/rag/store/), [saivage/src/rag/embedder/](saivage/src/rag/embedder/), [saivage/src/rag/chunker/](saivage/src/rag/chunker/) | Caller has an unusual need: a custom chunker for a domain-specific format, a custom store (e.g. a future research-only in-memory store), a one-off embedding flow that does not benefit from the configured-by-name dataset surface. |
| Facade | [saivage/src/rag/dataset.ts](saivage/src/rag/dataset.ts) | Caller wants the default path: register a dataset by name with a configuration block, then perform `ingest`, `query`, `stats`, `rebuild`, `drop`. This is the right answer for the skills loader, the memory manager, a future docs indexer, a future code indexer, and the future librarian agent. |

Both layers are first-class. Documentation must not frame the seams as an "escape hatch" relative to a "blessed" facade, nor frame the facade as a "wrapper you can skip." The seams are the substrate; the facade composes them into a single named-dataset object. A caller using the facade is doing the normal thing; a caller using the seams directly is doing the normal thing with different requirements.

Neither layer is privileged in terms of where it can be used: anything inside the Saivage v2 process — skills loader, memory manager, future doc/code indexer, future librarian agent — can call either layer. There is no internal-only sub-API.

### 2.2 Facade scope: RAG-only operations

The facade orchestrates the operations that RAG requires and nothing else. Concretely, it owns:

- Chunking source content via the dataset's configured chunker.
- Embedding chunks via the dataset's configured provider.
- Persisting vectors and metadata to the dataset's configured store.
- Querying with optional metadata filter and returning ranked hits.
- Refusing queries when the dataset's stored provider/model/dim/release fingerprint drifts from the configured one.
- Running the secret-exclusion guard on every readable path before embedding.
- Holding the per-dataset cross-process ingest lock for the duration of an ingest.

It does NOT own anything else. The following are explicit non-goals for the facade and any future contribution to it MUST be refused on these grounds:

- **No generic key-value or document store API.** The facade does not provide "put arbitrary JSON, retrieve by id later." If callers need such a store, they own one elsewhere. RAG is not a database for caller-defined records; the only records it holds are chunks derived from ingestable content.
- **No schema or migration system for caller-defined record shapes.** The library knows about chunks and their fixed metadata. It does not host plug-in record types and does not version caller record shapes.
- **No consumer-convenience shortcuts on the facade.** No `forSkills()`, no `forDocs()`, no `forCode()`. Consumers configure datasets by name and call the named operations. A skill loader that wants three datasets registers three datasets; it does not get a custom facade.
- **No cross-dataset query in a single call.** A caller that needs to retrieve from multiple datasets composes the result client-side from independent `query` calls. The facade does not fan out or merge.
- **No "smart" routing of a free-form question to one or more datasets.** Selecting which dataset(s) answer a question is an agent-layer responsibility (see [Section 4](#4-addition-3--librarian-agent-as-a-future-spec-not-a-gateway)). The facade routes nothing.

### 2.3 What this rules out, by example

- A future PR adding `RagDataset.upsertDocument(id, json)` is rejected: it turns the facade into a document store.
- A future PR adding `RagManager.ask(question)` is rejected: it embeds librarian-style intent translation into the library.
- A future PR adding `RagManager.queryAll(question)` that fans out across all registered datasets is rejected: cross-dataset composition is a caller concern.
- A future PR adding `RagManager.forSkills()` that returns a pre-wired dataset using built-in knowledge of the skills loader is rejected: the library does not know about skills.
- A future PR adding a "record-schema registry" to let callers declare arbitrary record shapes with their own indices is rejected: the only record shape is `Chunk`.

### 2.4 What this preserves

The seams stay narrow and substitutable: a downstream caller with a custom store can implement `VectorStore`, instantiate it, and pass it through dataset configuration; nothing about the facade changes. The facade stays thin and predictable: any caller that wants the default path gets exactly one composition, with no surprise behavior added later because some other consumer wanted convenience.

### 2.5 Worked example: which surface picks which caller

The following table maps anticipated in-process callers to their expected surface. None of these callers are implemented in the current work; the table exists to make the boundary rule concrete and to anchor future review.

| Caller (anticipated) | Expected surface | Reason |
|---|---|---|
| Skills loader integrating with RAG | Facade. One dataset per logical skill corpus, registered by name. | Standard ingest/query needs; no custom chunker, no custom store. |
| Memory manager integrating with RAG | Facade. One dataset for the memory corpus. | Uses the memory chunker; otherwise the default composition. |
| Future target-doc indexer | Facade. One dataset per documented project, configured by source root. | Standard markdown ingest. |
| Future target-code indexer | Facade. One dataset per indexed source tree, with the code chunker selected by config. | Standard composition; tree-sitter chunker already a seam-level choice. |
| Future librarian agent | Facade. Issues `query` calls against any registered dataset; may call `ingest` / `rebuild` on observed change. | The librarian sees the same surface every other caller sees. |
| Hypothetical research notebook that wants to test a custom chunking heuristic | Primitive seams. Instantiates `Chunker`, `EmbeddingProvider`, and `VectorStore` directly. | Bypasses the named-dataset registry on purpose; one-off, not persisted as a dataset. |
| Hypothetical future research-only in-memory store | Primitive seams. New `VectorStore` implementation registered for use by an experimental dataset. | Custom store; the facade composes it the same way it composes the default. |

The pattern: if the caller wants the registered-by-name lifecycle, the facade is the answer. If the caller wants raw composition (one-shot experiments, custom substrate), the seams are the answer. There is no third "convenience" layer between them and there will not be one.

## 3. Addition 2 — External-change handling: explicit update API + directory watcher

### 3.1 Required behavior

The RAG library is used in environments where source content is rewritten outside the calling code path: an editor saves a file, a build writes generated docs, `git pull` lands new commits, another in-process agent writes target-project files directly. Indexed datasets must reflect those changes without forcing callers to remember to re-ingest.

Two complementary mechanisms cover this:

| Mechanism | Trigger | Cost when unused |
|---|---|---|
| Explicit update | Caller invokes `dataset.ingest(paths)` or `dataset.delete(filter)`. | Zero. This is the existing facade path. |
| Background watcher | Filesystem event, batched and debounced, then routed through the same `ingest` pipeline. | Zero. Opt-in per dataset; off by default. |

The explicit update path remains the primary contract. Any caller can trigger ingest at any time. The watcher is an optimization for "I do not want to remember"; it does not replace explicit ingest and is not enabled implicitly.

### 3.2 Watcher specification

#### 3.2.1 Library choice

`chokidar` is the watcher backend:

- ESM-compatible (works under the Node LTS >= 24 / ESM constraint).
- MIT licensed.
- Cross-platform: inotify on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows.
- Mature, widely deployed, with explicit polling fallback for unreliable filesystems.

`chokidar` is added as a runtime dependency in [saivage/package.json](saivage/package.json). It is loaded only when a dataset opts in; with all datasets at `watch: false`, the module is not imported at runtime.

#### 3.2.2 Configuration surface

The dataset configuration schema in [saivage/src/config.ts](saivage/src/config.ts) gains a `watch` field with three permitted shapes:

```ts
type WatchConfig =
  | false
  | true
  | { usePolling: true; interval?: number /* ms, default 2000 */ };
```

Semantics:

- `false` (default): no watcher is ever created for this dataset. The chokidar import does not run on behalf of this dataset.
- `true`: chokidar runs in its default native-events mode (inotify on Linux).
- `{ usePolling: true, interval }`: chokidar runs in forced polling mode. This is the supported escape hatch for filesystems where native events are unreliable: certain LXC bind-mounts to host directories, NFS mounts, some FUSE filesystems. The library does NOT auto-detect this case; the operator chooses.

The watcher scope is the dataset's registered source roots, minus the union of two exclusion sets:

| Exclusion set | Contents | Purpose |
|---|---|---|
| Secret exclusion globs | The mandatory set already enforced for ingest. | Prevent watcher from re-triggering ingest on secret-bearing files. |
| Build/cache exclusion globs | `node_modules/**`, `dist/**`, `build/**`, `.git/**`, `.saivage/**`, `.saivage-work/**`, `coverage/**`, `.next/**`, `.cache/**`, `.turbo/**`, `target/**`, `__pycache__/**`, `.pytest_cache/**`, `.venv/**`, `venv/**`, plus editor temp patterns: `.*.swp`, `.*.swo`, `.#*`, `*~`, `*.tmp`. | Prevent watcher from emitting tens of thousands of events during builds, dependency installs, or editor saves. |

Both sets apply to every watcher regardless of dataset source type.

#### 3.2.3 Debouncing

Filesystem events arrive in bursts. A single editor save can produce a rename + write + chmod sequence; `git pull` writes many files in rapid succession. The watcher coalesces events into batches using a debounce window:

- Default window: 1500ms of quiescence (no new events for the dataset's watched scope) closes the batch.
- The window is configurable via the dataset `watch` config (future field if needed; not required in the initial landing).
- Within a window, events are deduplicated by absolute path: the final state of each path is what matters, not the intermediate steps.
- A `delete` followed by a `create` for the same path within the window resolves to a single ingest of the new content; a `create` followed by a `delete` resolves to a single delete.

The batched ingest is then routed through the same pipeline as an explicit `dataset.ingest(paths)` / `dataset.delete(filter)` call: same secret guard, same chunker, same embedder, same store. No watcher-specific code path bypasses any library invariant.

#### 3.2.4 Lock awareness

The ingest pipeline acquires a per-dataset cross-process lock via `proper-lockfile`. The watcher does NOT bypass it:

- When a debounce window closes, the watcher attempts to acquire the same lock.
- If a manual `dataset.ingest()` already holds the lock, the watcher's batch waits. While waiting, additional filesystem events MAY accumulate into the same pending batch (no separate queue); when the lock becomes available, the watcher acquires it once and ingests the coalesced set.
- The watcher does not fail on lock contention. It coalesces and retries. Lock acquisition timeout for the watcher path is bounded (default 30 seconds of waiting) — past that, the batch is dropped from the queue and a warning is logged; the next event re-arms the cycle.

#### 3.2.5 Restart resilience: reconcile on startup

Native filesystem watchers do not observe events that occur while the process is not running. To prevent silent staleness across restarts, every dataset performs a `reconcile` sweep on startup, BEFORE arming the watcher:

- Walk the dataset's source roots with the same exclusion sets the ingest pipeline uses.
- For each candidate file: compute `mtime + sha256` and compare against the persisted chunk metadata.
- Any path whose `sha256` differs (including paths newly present or newly absent) is routed through the ingest pipeline as if it had just changed.

`reconcile` runs unconditionally on dataset startup when `watch !== false`. It is also exposed as a public, callable operation (see [Section 3.3](#33-public-surface-additions)) so operators and tests can request it explicitly.

#### 3.2.6 inotify-limit handling

On Linux, `chokidar` in native mode consumes inotify watches from a per-user limit (`/proc/sys/fs/inotify/max_user_watches`, default 8192 on many distros, higher on modern Ubuntu). Large source trees can exhaust this. The library handles this explicitly:

- If chokidar reports `ENOSPC` or any other watch-limit signal at arm-time, the watcher startup aborts with a `WatcherUnavailableError`.
- The error message names the inotify limit by path (`/proc/sys/fs/inotify/max_user_watches`) and includes the dataset id, the source-root count, and the approximate file count walked by `reconcile`. It does not suggest "raise the limit"; it leaves that judgment to the operator.
- The dataset remains usable. Explicit `dataset.ingest()` and `dataset.query()` continue to work; only the background watcher is unavailable.
- The library does NOT silently fall back to polling. Polling is acceptable only when the operator opted into it via `{ usePolling: true }`. Implicit fallback would replace a loud failure with a silent CPU drain on a large tree, which is the wrong default.

#### 3.2.7 Event-flood handling

A watcher armed on a source root that contains a directory undergoing `npm install`, a webpack build, or similar bulk-write activity can emit tens of thousands of events within a single debounce window even after exclusions. The debouncer plus the build/cache exclusion set is the first line of defense. As a second line:

- If, after applying both exclusion sets, the number of distinct paths in a closed debounce batch exceeds a threshold (default 5000), the batch is treated as a flood.
- For a flood batch, the library logs a warning naming the dataset id, the path count, and the top three directories by event count. It does NOT submit the batch to embedding (embedding cost is approximately linear in chunk count, and a flood usually means the operator wants to either widen exclusions or run an explicit ingest at their chosen time).
- The next non-flood batch proceeds normally.

This threshold protects against operator-cost surprises (a runaway watcher consuming embedding API quota on transient files). It does not protect against malicious input; that is a separate concern not addressed by this addendum.

### 3.3 Public surface additions

The facade gains three operations. All three are idempotent and safe to call from any in-process caller:

| Operation | Behavior |
|---|---|
| `dataset.watch()` | Arms the watcher per the dataset's `watch` config. If `watch === false`, throws a configuration error (the caller must reconfigure the dataset, not silently no-op). If a watcher is already armed, returns without doing anything. Performs a `reconcile` sweep before arming. |
| `dataset.unwatch()` | Disarms the watcher and releases its inotify watches (or stops the polling loop). If no watcher is armed, returns without doing anything. Does not flush pending debounced events; in-flight ingest completes, queued events are discarded. |
| `dataset.reconcile()` | Runs the one-shot mtime + sha256 sweep against persisted chunk metadata and routes the resulting deltas through the ingest pipeline. Used internally on startup; also callable explicitly (e.g. after a `git pull` from an outer script). Acquires the per-dataset lock. |

No `dataset.watchStatus()`, no `dataset.flushWatcher()`, no event subscription. The watcher is a behavior, not a query target. If observability is wanted later, that is a separate design decision.

### 3.4 Module layout

New code lives under [saivage/src/rag/watcher/](saivage/src/rag/watcher/):

```
saivage/src/rag/watcher/
  index.ts           // public re-exports of the watcher controller used by dataset.ts
  controller.ts      // arm()/disarm()/reconcile() over a single dataset; debouncer + chokidar lifecycle
  debouncer.ts       // window-based coalescing of paths with deduplication
  reconcile.ts       // startup sweep: walk + mtime + sha256 + diff against persisted chunk metadata
  exclusions.ts      // build/cache exclusion glob set (separate file because it is referenced by docs)
  flood.ts           // post-debounce flood detection (path count threshold + top-directories report)
```

The `dataset.ts` facade composes a `WatcherController` instance when the dataset's `watch` config is non-`false`. The controller is lazy: chokidar is imported via dynamic `import('chokidar')` inside `controller.ts`, so datasets with `watch: false` never load the dependency.

### 3.5 Failure modes summary

The new failure surface introduced by the watcher is bounded to three named cases:

| Error | When | Recovery |
|---|---|---|
| `WatcherUnavailableError` | inotify limit reached at arm-time. | Operator widens `max_user_watches` or opts into polling. Dataset stays usable via explicit ingest. |
| Lock-wait timeout | Watcher batch waited 30s for the per-dataset lock. | Logged as warning; next event re-arms. No exception surfaced to the caller. |
| Event-flood threshold exceeded | Post-exclusion batch has more than 5000 distinct paths. | Logged as warning with top-three directories; batch dropped. Operator widens exclusions or runs explicit ingest. |

All three are observable via the existing structured-log surface at [saivage/src/log.ts](saivage/src/log.ts). None of them silently corrupts dataset state; the worst case is staleness until the next explicit ingest or `reconcile`.

### 3.6 Operator guidance: bind-mounts and NFS

Documentation under [saivage/SPEC/v2/rag/operational-runbook.md](saivage/SPEC/v2/rag/operational-runbook.md) (already in the implementation plan) gains a section on watcher-mode selection:

- Default LXC bind-mounts to host directories: native inotify events may or may not propagate, depending on the LXC version, kernel, and `lxc.mount.entry` configuration. If `watch: true` produces missed updates in a bind-mounted root, the supported remedy is `{ usePolling: true }`.
- NFS, SMB, or FUSE-backed roots: always use `{ usePolling: true }`. Native events are unreliable across these.
- Local ext4 / btrfs / zfs on Linux, APFS on macOS, NTFS on Windows: `watch: true` is the right choice.

The library does NOT detect filesystem type or auto-select polling. The choice is the operator's.

## 4. Addition 3 — Librarian agent as a future spec, not a gateway

### 4.1 Statement of intent

A "librarian" agent is planned as the intelligent layer above the RAG library. Its responsibilities, to be designed in a separate agent-design dance and not in this one, are expected to include:

- **Intent translation:** turning a free-form question (from a user or from another agent) into a query text plus an optional metadata filter that the RAG library understands.
- **Dataset selection:** choosing which of the registered datasets (skills/memories, target documentation, target source code, future research notes) should answer a given question, based on the question's content and the librarian's working knowledge of what each dataset contains.
- **Result synthesis and citation:** combining hits from one or more datasets into an answer with explicit citations back to the source files.
- **Ingest/rebuild triggering on observed change:** when the librarian observes that a corpus has shifted (e.g. a new spec was committed, a code module was rewritten), it can call `dataset.ingest(paths)` or `dataset.rebuild()` against the affected dataset. The watcher in [Section 3](#3-addition-2--external-change-handling-explicit-update-api--directory-watcher) handles passive change detection; the librarian handles active, intent-driven re-ingest.

### 4.2 The librarian is a consumer, not a gateway

The librarian agent is ONE consumer of the RAG library. It is not a required intermediary, and the library does not assume its presence:

- The skills loader, when it eventually integrates with RAG, calls the library directly via the facade. It does not route through the librarian.
- The memory manager, when it eventually integrates with RAG, calls the library directly via the facade. It does not route through the librarian.
- A future code indexer (the thing that ingests target-project source) calls the library directly via the seams or the facade. It does not route through the librarian.
- A future doc indexer is the same.

This preserves a deterministic, low-latency path for code that knows exactly which dataset it wants and exactly what filter to apply. Forcing every retrieval through an LLM-backed agent would add per-call latency and per-call cost to operations that have neither.

### 4.3 The library's contract is identical for both usage modes

The public surface of the RAG library — the seams at [saivage/src/rag/store/](saivage/src/rag/store/), [saivage/src/rag/embedder/](saivage/src/rag/embedder/), [saivage/src/rag/chunker/](saivage/src/rag/chunker/), and the facade at [saivage/src/rag/dataset.ts](saivage/src/rag/dataset.ts) plus the registry at [saivage/src/rag/manager.ts](saivage/src/rag/manager.ts) — is the contract that both direct callers AND the future librarian agent consume. It does not grow special operations for one or the other.

In particular:

- The library exposes no operation whose only sensible caller is an LLM-backed agent.
- The library exposes no operation whose only sensible caller is a low-level integration.
- The same `dataset.query(text, options)` serves the librarian (which produces `text` from a free-form question) and the memory manager (which produces `text` from a structured request).

### 4.4 Future MCP exposure is a librarian-side concern

If the RAG capability is ever exposed over MCP to external clients (Claude Desktop, other editors, other agent processes), that exposure lives in the librarian agent, not in the RAG library. The library does not embed an MCP server. The reasons:

- MCP exposes a high-level "ask the librarian" tool surface, not a low-level "embed this chunk in that store" surface.
- The librarian is the right place to enforce per-client filtering, intent shaping, and citation rendering before bytes leave the process.
- Keeping MCP out of the library keeps the library testable as a pure Node module, with no network surface to set up or tear down per test.

### 4.5 Explicit non-goals for this addendum

This addendum does NOT design the librarian. In particular:

- No specification of the librarian's prompts, tool-call shape, model selection, or decision logic.
- No specification of how the librarian discovers which datasets exist (that is the librarian's design problem; the library's registry already lists them).
- No specification of how the librarian renders citations or synthesizes multi-dataset answers.
- No "high-level convenience" methods on the facade or registry that are really librarian responsibilities. The following names are reserved as out-of-scope-for-the-library and any proposal to add them is rejected on architectural grounds, not on quality:
  - `dataset.ask(question)`
  - `dataset.summarize()`
  - `dataset.findRelevant(text, k)` (a friendlier alias of `query` whose only added value is the alias)
  - `manager.askAll(question)` (cross-dataset answer aggregator)
  - `manager.route(question)` (intent-to-dataset router)

### 4.6 Why this is recorded now

The librarian is out of scope for the current implementation, but the architectural assumption — that there will be one, and that the library will not become it — drives sizing decisions in the library itself: the facade stays thin, no convenience methods accrete, and the seams stay narrow. Recording the assumption in this addendum prevents drift during implementation: any review of a future PR can point at this section to refuse facade growth that "anticipates" librarian features.

## 5. Plan delta summary

The implementation sequence absorbs one new batch and one small amendment. The librarian is not implemented in this work.

| Change | Where in the sequence | Notes |
|---|---|---|
| Insert new batch **B12 — Directory watcher** | After the end-to-end smoke batch (B10), before the docs batch (B11). | B12 implements [Section 3](#3-addition-2--external-change-handling-explicit-update-api--directory-watcher). |
| Amend the docs batch (B11) | Same position. | B11 gains coverage of the watcher AND of the facade-vs-primitives boundary policy from [Section 2](#2-addition-1--facade-vs-primitives-boundary-policy). No new batch for the boundary policy; it is enforced by documentation and by review of future PRs. |
| No new acceptance criteria for the librarian | — | Librarian is out of scope. Recording its planned existence does not add work to this implementation. |
| New acceptance criterion for the watcher | B12 and B10's regression scope | "With `watch: true` and a file edit inside the dataset's source root, a subsequent `query` reflects the edit within (debounce window + ingest time) seconds without any explicit caller action." |

### 5.1 B12 — Directory watcher

Goal: land the chokidar-backed watcher per [Section 3](#3-addition-2--external-change-handling-explicit-update-api--directory-watcher) in one isolated commit, opt-in per dataset, with no behavioral impact on datasets that do not enable it.

Files added:

- [saivage/src/rag/watcher/index.ts](saivage/src/rag/watcher/index.ts) — public re-exports.
- [saivage/src/rag/watcher/controller.ts](saivage/src/rag/watcher/controller.ts) — `arm()`, `disarm()`, `reconcile()` over a single dataset; lifecycle wrapping the chokidar instance.
- [saivage/src/rag/watcher/debouncer.ts](saivage/src/rag/watcher/debouncer.ts) — window-based coalescing of paths with per-path event deduplication.
- [saivage/src/rag/watcher/reconcile.ts](saivage/src/rag/watcher/reconcile.ts) — startup sweep (walk + mtime + sha256 + diff).
- [saivage/src/rag/watcher/exclusions.ts](saivage/src/rag/watcher/exclusions.ts) — build/cache exclusion glob set.
- [saivage/src/rag/watcher/flood.ts](saivage/src/rag/watcher/flood.ts) — post-debounce flood detection.
- `*.test.ts` siblings for each module under [saivage/src/rag/watcher/](saivage/src/rag/watcher/).
- [saivage/tests/rag/e2e-watcher.test.ts](saivage/tests/rag/e2e-watcher.test.ts) — e2e test covering the acceptance criterion below.

Files modified:

- [saivage/package.json](saivage/package.json) — add `chokidar` to runtime dependencies. No version pin discussed here; the implementer pins to the current major at landing time.
- [saivage/src/config.ts](saivage/src/config.ts) — extend the dataset configuration schema with the `watch` field per [Section 3.2.2](#322-configuration-surface). Default `false`.
- [saivage/src/rag/dataset.ts](saivage/src/rag/dataset.ts) — add `watch()`, `unwatch()`, and `reconcile()` public operations; instantiate a `WatcherController` lazily when `watch !== false`.
- [saivage/src/rag/errors.ts](saivage/src/rag/errors.ts) — add `WatcherUnavailableError`.

Tests in B12 cover:

- Explicit `dataset.ingest(paths)` still works with `watch: false` and produces no chokidar import in the module graph.
- With `watch: true` against a temp directory, a file write triggers re-ingest within debounce + ingest time, and a follow-up `query` returns the new content.
- Build/cache exclusion: writing into `node_modules/` inside the watched root produces no ingest activity.
- Lock-aware coalescing: a manual `ingest()` running concurrently with a watcher-triggered batch results in exactly one final state with all changes applied, not in concurrent ingest pipelines.
- inotify-limit failure path: a mocked chokidar that throws `ENOSPC` at arm-time causes `dataset.watch()` to throw `WatcherUnavailableError`, and subsequent `dataset.ingest()` and `dataset.query()` still succeed.
- Event-flood path: a simulated burst of 6000+ distinct post-exclusion paths produces a warning log and no embedding calls.
- `dataset.reconcile()`: after the process restarts (simulated by tearing down the manager and re-registering the dataset), files modified while the manager was down are re-ingested before the watcher re-arms.

Validation tags (same convention as the rest of the implementation plan): `T`, `L`, `U`, `E`, `A`. No `S` (no live OpenAI call required for watcher behavior).

Rollback: B12 is opt-in at runtime even after merge. Datasets that do not set `watch: true` get no watcher behavior and pay no chokidar load cost. `git revert` of B12 removes the surface entirely; datasets that had opted in fall back to explicit-ingest-only semantics with no on-disk state to clean up.

### 5.2 B11 — Docs amendment

The docs batch already plans to write [saivage/SPEC/v2/rag/README.md](saivage/SPEC/v2/rag/README.md), [saivage/SPEC/v2/rag/configuration.md](saivage/SPEC/v2/rag/configuration.md), [saivage/SPEC/v2/rag/on-disk-layout.md](saivage/SPEC/v2/rag/on-disk-layout.md), and [saivage/SPEC/v2/rag/operational-runbook.md](saivage/SPEC/v2/rag/operational-runbook.md). B11 absorbs the following additional content:

- In [saivage/SPEC/v2/rag/README.md](saivage/SPEC/v2/rag/README.md): a section titled "Surfaces" that documents the facade-vs-primitives boundary policy from [Section 2](#2-addition-1--facade-vs-primitives-boundary-policy), including the list of facade non-goals.
- In [saivage/SPEC/v2/rag/configuration.md](saivage/SPEC/v2/rag/configuration.md): documentation of the `watch` field shape and defaults.
- In [saivage/SPEC/v2/rag/operational-runbook.md](saivage/SPEC/v2/rag/operational-runbook.md): the bind-mount / NFS guidance from [Section 3.6](#36-operator-guidance-bind-mounts-and-nfs), the inotify-limit failure mode and operator response, and the event-flood failure mode and operator response.

No standalone "librarian" doc is written here. Recording the librarian's planned existence inside the design addendum (this document) is sufficient.

### 5.3 Acceptance criteria delta

The implementation plan's acceptance criteria are extended by exactly one item:

- **Live watcher acceptance:** with a dataset configured `watch: true` and at least one source root pointing at a temp directory, a file written into that root is reflected in `query` results within `(debounce window + ingest time)` seconds, with no explicit caller action between the write and the query.

The librarian agent has no acceptance criteria in this work; it is recorded as a future spec only.

## 6. Summary

Three deltas land. The facade is fixed in scope: RAG-only orchestration, with a documented list of features it must refuse. External changes are handled by the existing explicit `ingest`/`delete` API plus an opt-in chokidar watcher with reconcile-on-startup, debounced and lock-aware ingestion, explicit handling of inotify limits and event floods, and an opt-in polling mode for bind-mounts and NFS. The librarian agent is recorded as a future, separately designed consumer; the library does not become it, does not grow convenience methods for it, and does not host an MCP server on its behalf. The implementation sequence absorbs one new batch (B12) between the end-to-end smoke test and the docs batch, and the docs batch picks up the boundary policy and the watcher's operational surface.
