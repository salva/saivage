# F03 — Librarian Agent: Design

This design crystallises the module shape, the `LibrarianAgent`
class (mirroring the existing Inspector non-worker pattern),
authorization wiring, and the Manager retrieval-miss routing rule
specified in
[01-analysis-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md).

## A. Focused Proposal — Inspector-shaped non-worker agent with prompt-level fallback

### A.1 Modules

```
src/agents/
├── librarian.ts            // LibrarianAgent class + LibrarianInput
├── roster.ts               // ROSTER += librarian entry
├── tool-filters.ts         // LIBRARIAN_TOOLS + TOOL_FILTERS.librarian
├── prompts.ts              // PROMPT_KEY_TO_ROLE / ROLE_PROMPT_NAMES += librarian
├── prompt-keys.ts          // "librarian"
└── base.ts                 // RUN_LIBRARIAN_SCHEMA + DISPATCH_SCHEMA_BY_TOOL entry

prompts/
├── librarian.md            // role prompt per analysis §7
└── manager.md              // patched per A.7

src/knowledge/
├── types.ts                // KnowledgeAgentRoleSchema += "librarian"
└── permissions.ts          // ACL row + checkScope Librarian branch

src/mcp/
└── knowledgeMemory.ts      // topic guard + update_memory preflight

src/server/
└── bootstrap.ts            // case "librarian": mutate ragService.adminRoles, build LibrarianAgent
```

### A.2 `LibrarianAgent` class — mirroring Inspector

`LibrarianAgent` mirrors the non-worker pattern at
[src/agents/inspector.ts](src/agents/inspector.ts#L22-L88):

```ts
// src/agents/librarian.ts
import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type { AgentContext, AgentResult, Agent } from "./types.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";
import { log } from "../log.js";

export interface LibrarianInput {
  objective: string;
  collection_id?: string;
  context?: string;
}

export class LibrarianAgent extends BaseAgent implements Agent {
  private input: LibrarianInput;

  static async create(
    ctx: AgentContext,
    input: LibrarianInput,
    config?: Partial<BaseAgentConfig>,
  ): Promise<LibrarianAgent> {
    const initialMessage = buildLibrarianMessage(input);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      "librarian",
      input.objective,
    );
    return new LibrarianAgent(ctx, input, initialMessage, eagerSkillBlock, config);
  }

  constructor(
    ctx: AgentContext,
    input: LibrarianInput,
    initialMessage: string,
    eagerSkillBlock: string,
    config?: Partial<BaseAgentConfig>,
  ) {
    super(ctx, {
      systemPrompt: loadRolePrompt("librarian"),
      eagerSkillBlock,
      skillContext: { agentRole: "librarian", description: input.objective },
      initialMessage,
      ...config,
    });
    this.input = input;
  }

  async run(): Promise<AgentResult> {
    log.info(`[librarian:${this.id}] Starting: ${this.input.objective.slice(0, 80)}`);
    try {
      const { text, finishReason } = await this.runLoop();
      if (finishReason === "abort" || finishReason === "cancelled")
        return { kind: "abort", reason: text };
      if (finishReason === "max_compactions" || finishReason === "error")
        return { kind: "failure", reason: text };
      return { kind: "success", data: text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[librarian:${this.id}] Failed: ${msg}`);
      return { kind: "failure", reason: msg };
    }
  }
}

function buildLibrarianMessage(input: LibrarianInput): string {
  const parts = [`# Objective`, input.objective];
  if (input.collection_id) parts.push(`\n# Collection`, input.collection_id);
  if (input.context) parts.push(`\n# Context`, input.context);
  return parts.join("\n");
}
```

### A.3 Roster entry

The roster entry matches the actual `RosterEntry` interface at
[src/agents/roster.ts](src/agents/roster.ts#L30-L62) verbatim from
analysis §3.1:

```ts
{
  role: "librarian",
  worker: false,
  stageScoped: false,
  dispatchTool: "run_librarian",
  dispatchableBy: ["planner", "manager"],
  toolFilter: "librarian",
  abortPriority: 8,
  selfCheckFrequency: 20,
  convention: {
    writeTerritory: [".saivage/memory/project/"],
    excludeTerritory: ["src/", "research/"],
    description: "Librarian curates project-scoped rag memories only.",
  },
  defaultModelKey: "orchestrator",
  displayName: "Librarian",
  summary:
    "Curates the RAG knowledge surface. Investigates retrieval gaps and drift, " +
    "records policies and incident memories under topic.domain='rag', does not " +
    "write skills or non-rag memories.",
  workerInit: null,
}
```

`ToolFilterKind` at
[src/agents/roster.ts](src/agents/roster.ts#L14) is extended with
`| "librarian"`.

### A.4 Tool filter and dispatch schemas

`TOOL_FILTERS.librarian` is added to the typed `Record` at
[src/agents/tool-filters.ts](src/agents/tool-filters.ts#L32-L40)
with the allow-list from analysis §3.2 and explicit denies for
mutating knowledge tools other than `create_memory` / `update_memory`.

`RUN_LIBRARIAN_SCHEMA` is added to `DISPATCH_SCHEMA_BY_TOOL` at
[src/agents/base.ts](src/agents/base.ts#L1121-L1130):

```ts
const RUN_LIBRARIAN_SCHEMA = z.object({
  objective: z.string().min(1),
  collection_id: z.string().optional(),
  context: z.string().optional(),
});
```

### A.5 Knowledge ACL and handler guard

The Librarian ACL row from analysis §5 is inserted into the
permissions matrix in
[src/knowledge/permissions.ts](src/knowledge/permissions.ts).
`checkScope` gains a Librarian branch immediately after the current
early return for non-`Y†` cells at
[src/knowledge/permissions.ts](src/knowledge/permissions.ts#L268-L292),
using the real signature `checkScope(role, op, kind, scope,
scope_ref, ctx)` and the real `ScopeCheckResult` shape `{ ok: false,
code: "UNAUTHORIZED_SCOPE", reason }`:

```ts
if (role === "librarian") {
  if (scope === "project") return { ok: true };
  return {
    ok: false,
    code: "UNAUTHORIZED_SCOPE",
    reason: `role=librarian may only write memory with scope='project', got '${scope}'`,
  };
}
// existing worker-stage Y† branch follows unchanged.
```

`checkScope` does **not** inspect topic; topic constraints stay in
the handler. The `create_memory` and `update_memory` handlers in
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts) gain a
topic guard before the lifecycle call:

```ts
if (ctx.role === "librarian") {
  if (input.topic.domain !== "rag"
      || !["policy", "secret-incidents", "drift-incidents"].includes(input.topic.subject)) {
    throw new KnowledgeStoreError(
      "UNAUTHORIZED_ROLE",
      "librarian topic must be rag/{policy|secret-incidents|drift-incidents}",
    );
  }
}
```

`update_memory` additionally gains the preflight at
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L216-L228).
`getMemory` is the existing helper at
[src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L733-L757)
with signature `getMemory(saivageRoot, { id?, topic? }) →
(MemoryRecord & { redacted_spans }) | null` and a flat
`scope: KnowledgeScope` field plus optional `scope_ref: string`.
`checkScope` is the existing function from
[src/knowledge/permissions.ts](src/knowledge/permissions.ts#L260-L292)
with signature `(role, op, kind, scope, scope_ref, ctx)`. The
canonical `KnowledgeOp` values per
[src/knowledge/permissions.ts](src/knowledge/permissions.ts#L16-L25)
are `create | update | supersede | archive | delete | read | list
| search`, so the update path passes op `"update"`:

```ts
const saivageRoot = saivageDir(ctx.projectRoot);
const prior = await getMemory(saivageRoot, { id: input.id });
if (!prior) throw new KnowledgeStoreError("NOT_FOUND", `memory ${input.id} not found`);
const scopeResult = checkScope(
  ctx.role, "update", "memory",
  prior.scope, prior.scope_ref, { stageId: ctx.stageId },
);
if (!scopeResult.ok)
  throw new KnowledgeStoreError(scopeResult.code, scopeResult.reason);
if (ctx.role === "librarian") enforceLibrarianTopic(prior);
```

This closes the pre-existing scope-check gap for **all** `Y†`
update roles — an intentional improvement already approved in
F01 §0.8.

### A.6 Bootstrap wiring (F02-dependent)

This step depends on the F02 source changes that expose
`ragService: RagService` to the bootstrap agent constructor. Once
F02 has merged, the switch at
[src/server/bootstrap.ts](src/server/bootstrap.ts#L315-L396)
carries `ragService` as a dependency, and the Librarian case adds:

```ts
case "librarian": {
  ragService.adminRoles.add("librarian");
  return LibrarianAgent.create(ctx, input as LibrarianInput);
}
```

The mutation is idempotent. **F02 is a hard prerequisite**; F03
will not compile against a tree where `RagService` does not exist.

### A.7 Manager retrieval-miss routing rule

`prompts/manager.md` gains:

> **Routing retrieval gaps to the Librarian.** When a child
> `TaskReport.issues_found` entry has a `description` starting with
> `"rag retrieval miss:"`, dispatch `run_librarian` with:
>
> - `objective` (required): `"Investigate RAG retrieval miss for
>   <subject>"`, where `<subject>` is the dataset id or query phrase
>   from the issue description.
> - `collection_id` (optional): the dataset id when the description
>   names one.
> - `context` (optional): the full issue description plus relevant
>   worker findings.
>
> Do not retry the worker on the same retrieval before the
> Librarian has responded.

## B. Level-up Alternative — runtime hook on `issues_found`

A dispatcher post-processor inspects every returned `TaskReport`
and auto-dispatches `run_librarian` when `issues_found` contains a
`"rag retrieval miss:"` description. Pros: deterministic; no
prompt drift. Cons: couples runtime to knowledge-domain semantics;
duplicates Manager's role as dispatch policy owner. Rejected.

## C. Chosen Direction

A. Bounded Inspector-shaped `LibrarianAgent`; ACL gates in
`permissions.ts` (scope only) plus handler-side topic guards
(topic only); F02-handler admin-role set mutated in the Librarian
bootstrap case; retrieval-miss routing carried by Manager's prompt
with full `objective`/`collection_id`/`context` guidance.

## D. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Manager forgets the retrieval-miss rule | Regression test round-trips a `TaskReport` with the marker and asserts the rendered Manager prompt mentions `run_librarian` and `objective`. |
| Librarian writes outside `rag` topic via prompt drift | Handler topic guard rejects with `UNAUTHORIZED_ROLE`. |
| `update_memory` preflight surfaces failures for non-Librarian roles | Intentional — closes pre-existing gap. Release notes flag the behaviour change. |
| Operator double-dispatch creates duplicate policy memories | `topic.aspect = collection_id` makes them addressable; Librarian de-dups via `search_memories` before writing. |
| F02 not yet landed when F03 lands | Sequencing enforced: F02 → F01 → F03. |

## E. Test Strategy

- Unit: roster entry; tool-filter membership and denies; ACL row;
  `checkScope` Librarian branch ordering and `ScopeCheckResult`
  shape.
- Handler: `create_memory` topic guard; `update_memory` preflight
  scope + topic guard; non-Librarian roles continue to work.
- Dispatch: Planner → `run_librarian` succeeds; Manager →
  `run_librarian` succeeds; Chat denied; bootstrap case constructs
  `LibrarianAgent` and mutates `adminRoles`.
- Behaviour: decision-tree branches with mocked F02 tools (drift
  confirmation gate; secret-incident memory body is
  `{count, collection_id, context}` only; protected-dataset
  redirect; no-hit fallback).
- Prompt: rendered Manager prompt contains the retrieval-miss rule
  with `objective` listed as required.

## F. Out of Scope

- Runtime hook on `issues_found` (alternative B).
- Auto-recurring reconcile schedules.
- Librarian write access to skills or non-rag memories.
- `create_note` grant.
