# Tool Schema And Persistence Unification Design

## Problem

Several subsystems still define the same contract in multiple places:

- Plan MCP tools have separate schema definitions, reader/writer sets, and dispatch switches.
- RAG tools define Zod validators and hand-written MCP JSON schemas separately.
- Planner prompt contract fragments are duplicated across startup, recovery, continuous improvement, and nudges.
- RAG provider config fields are accepted by config but do not have a clear runtime owner.
- Atomic JSON writes are implemented in multiple modules with different behavior.
- SQLite RAG metadata fields are repeated across TypeScript types, DDL, column lists, row hydration, and insert bindings.

These are drift risks. The cleanup goal is not more abstraction for its own sake; it is one source of truth per contract.

## Goals

- A plan tool is declared once and used for schema export, access classification, and dispatch.
- A RAG tool input contract is declared once and used for runtime validation and MCP schema publication.
- Shared prompt contract text has one source.
- RAG embedding provider config has explicit ownership.
- Atomic JSON writes use one helper with configurable validation/fsync behavior.
- SQLite metadata mapping uses descriptors instead of repeated manual lists.

## Non-Goals

- Do not replace all schemas with code generation across the project.
- Do not change plan tool semantics.
- Do not change RAG storage format unless descriptor generation reveals an existing mismatch.
- Do not expose or log API keys when clarifying RAG provider config.

## Plan Tool Registry

Replace parallel plan definitions with a registry.

Suggested shape:

```ts
type PlanToolAccess = "reader" | "writer";

interface PlanToolDefinition {
  access: PlanToolAccess;
  schema: ToolSchema;
  handle(service: PlanService, args: Record<string, unknown>): Promise<unknown>;
}

export const PLAN_TOOL_REGISTRY: Record<string, PlanToolDefinition> = { ... };
```

The registry is for MCP-exposed plan tools only. Internal/admin methods such as `plan_append_history()` must stay outside the registry and remain absent from exported schemas and reader/writer sets. Keep or add a regression test that `plan_append_history` is not exposed.

Registry handlers return raw `PlanService` results. `dispatchPlanToolCall()` or an equivalent adapter remains responsible for converting `PlanError`-shaped returns into `{ content, isError }` MCP envelopes so existing error behavior does not change.

Derived exports:

- `getPlanToolSchemas()` from registry values.
- `PLAN_READER_TOOLS` from entries with `access === "reader"`.
- `PLAN_WRITER_TOOLS` from entries with `access === "writer"`.
- `dispatchPlanToolCall()` from `registry[toolName].handle`.
- Role-filter drift checks from the same registry or tests that compare role-visible Plan tools with the registry-derived tool names.

`PlanService` remains owner of document state and serialized writes.

## RAG Tool Metadata

Define each RAG tool once with:

- Tool name.
- Description.
- Zod input schema.
- Handler function.
- Access/admin metadata.

MCP schemas should be generated from Zod if practical. If generation is too heavy for v2, keep an adjacent `inputSchema` field and add a drift test that asserts every tool metadata entry has exactly one runtime validator and exactly one MCP schema.

Suggested shape:

```ts
interface RagToolDefinition<I> {
  description: string;
  input: z.ZodType<I>;
  inputSchema: Record<string, unknown>;
  requiresAdminRole: boolean;
  requiresControlMutex: boolean;
  operatorBypassAllowed: boolean;
  handle(ctx: RagToolContext, input: I): Promise<unknown>;
}
```

Authorization and serialization are separate dimensions. Do not collapse them into one `access` enum: current behavior has admin-only tools and control-mutex tools that are not identical sets. Derive admin checks and control mutex checks from the explicit booleans above.

Role-level exposure must also be covered. Either derive Plan/RAG entries in `tool-filters.ts` from the canonical registries, or add drift tests proving role filters expose exactly the intended registry tools for planner, worker, reviewer, inspector, chat, and librarian roles.

## Shared Planner Contract Fragments

Extract prompt fragments into `src/agents/planner-contract-prompts.ts` or adjacent server prompt module:

- Plan mutation contract.
- Recovery instructions.
- Continuous improvement instructions.
- Text-only nudge instructions.

Rules:

- Keep the contract text role-specific and explicit.
- Do not move prompt text into generic runtime utilities.
- Add snapshot tests for each exported fragment.

## RAG Provider Config Ownership

Decision required before implementation:

### Option A — Support per-dataset provider options

- `EmbeddingProviderRef` includes non-secret provider options such as `baseUrl` and a secret reference, not a raw API key value from MCP input.
- Do not expose an `apiKey` property in generated MCP schemas. Use `apiKeyEnvVar`, `providerAccountRef`, or existing runtime provider/account routing if agents need to select credentials.
- Bootstrap or the RAG manager resolves provider options and passes only runtime-safe options to `Dataset.open()`; ownership of API-key handling must be singular.
- Read models redact `apiKey`.
- Drift stamp includes model/dim/provider identity, not secret values.

### Option B — Remove unsupported config fields

- Delete per-dataset RAG provider `baseUrl`/`apiKey` from config schema and docs.
- Use a single runtime/provider environment source.

Recommendation: choose Option A only if there is a current deployment need for per-dataset embedding backends. Otherwise choose Option B to keep v2 simple.

## Atomic JSON Persistence Helper

Create a helper with explicit options:

```ts
interface AtomicJsonWriteOptions<T> {
  schema?: z.ZodType<T>;
  fsync?: boolean;
  mode?: number;
  redactErrors?: boolean;
}
```

Use it for:

- Generic validated document writes.
- RAG registry writes.
- RAG config persistence.
- Future plan persistence if it does not conflict with `ProjectStore` ownership.

Rules:

- No helper should interpolate env vars by default.
- Config persistence must read raw JSON directly, never through `loadConfig()`, so `${VAR}` placeholders are preserved.
- Schema/default expansion must not rewrite unrelated config fields during a small persistence update.
- Errors from sensitive config paths must not include secret values.
- Wrappers around the helper must preserve existing domain error contracts. In particular, RAG config persistence currently exposes `read`, `validate`, and `write` stages through `SaivagePersistError`; keep that mapping and its API error details stable.

## SQLite Metadata Descriptor

Define metadata columns once:

```ts
const CHUNK_METADATA_COLUMNS = [
  { key: "path", column: "path", type: "TEXT NOT NULL" },
  ...
] as const;
```

Derive:

- Column lists.
- DDL snippets.
- Insert columns.
- Insert placeholders/bindings.
- Row-to-metadata hydration.
- Query filter allowlists.
- Indexed-column allowlists.

Keep the persisted table shape unchanged unless a migration is explicitly planned. The current schema intentionally uses existing column names, including camelCase names where present; descriptors must model the current persisted schema rather than rename columns.

If deriving query filter allowlists immediately is too much churn, add a drift test tying `sql.ts` allowlists to the descriptor so new metadata fields cannot silently miss filtering/index eligibility decisions.

## Migration Plan

### Step 1 — Plan tool registry

- Add registry and derive existing exports.
- Keep old exported names as derived compatibility exports.
- Delete switch-based dispatch after tests pass.

### Step 2 — RAG tool metadata

- Add metadata table.
- Migrate handler registration to consume metadata.
- Add drift tests between validators and MCP schemas.

### Step 3 — Prompt fragments

- Extract shared fragments.
- Update planner runner and planner nudge code.
- Update prompt snapshot tests intentionally.

### Step 4 — RAG provider config decision

- Implement Option B with explicit docs unless a current deployment needs per-dataset embedding-provider overrides.
- Add redaction tests if Option A is chosen.
- Add tests that generated MCP schemas do not expose raw `apiKey` fields.

### Step 5 — Atomic JSON helper

- Add helper and tests.
- Migrate one low-risk writer first.
- Migrate remaining persistence modules in separate commits.
- Add regression tests preserving raw `${VAR}` placeholders and the existing RAG persistence `read`/`validate`/`write` stage errors.

### Step 6 — SQLite metadata descriptor

- Add descriptor and derive current constants.
- Confirm no SQL shape changes in tests.
- Add a golden test for generated `CREATE TABLE chunk` SQL or column metadata.
- Add a migration regression test opening an existing fixture DB and asserting no table rebuild or migration occurs.
- Add tests that query filter allowlists and indexed-column allowlists match descriptor metadata.

## Validation

- Plan MCP tests.
- RAG handler/tool/register/drop tests.
- Prompt snapshot tests.
- Persistence helper tests.
- SQLite vector store tests.
- Full `npm run typecheck && npm test` before deleting compatibility exports.

## Expected Result

Contract drift becomes difficult by construction. Adding a plan tool, RAG tool, or metadata field has one obvious edit location and focused tests that fail if derived outputs are incomplete.
