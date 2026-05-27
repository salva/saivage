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
└── permissions.ts          // ACL row + checkScope branch before worker-stage branch

src/mcp/
└── knowledgeMemory.ts      // create_memory topic guard + update_memory preflight

src/server/
└── bootstrap.ts            // case "librarian": mutates ragService.adminRoles, constructs LibrarianAgent
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
      return { kind: "success", data: text };       // markdown report
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

The dispatcher already JSON-stringifies the `AgentResult.data`
markdown back to the parent via the standard path at
[src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L156-L249).

### A.3 Roster entry

```ts
{
  role: "librarian",
  promptKey: "librarian",
  defaultModelKey: "orchestrator",
  toolFilter: "librarian",
  dispatchableBy: ["planner", "manager"],
  writeTerritory: [".saivage/memory/project/"],
  stageScoped: false,
  worker: false,
}
```

### A.4 Tool filter and dispatch schemas

`TOOL_FILTERS.librarian` is added to the typed `Record` at
[src/agents/tool-filters.ts](src/agents/tool-filters.ts#L32-L40)
with the allow-list from analysis §3.2 and explicit denies for
mutating knowledge tools other than `create_memory` / `update_memory`.

`RUN_LIBRARIAN_SCHEMA` is added to `DISPATCH_SCHEMA_BY_TOOL` at
[src/agents/base.ts](src/agents/base.ts#L1121-L1130). Schema:

```ts
const RUN_LIBRARIAN_SCHEMA = z.object({
  objective: z.string().min(1),
  collection_id: z.string().optional(),
  context: z.string().optional(),
});
```

### A.5 Knowledge ACL and handler guard

The ACL row from analysis §5 is inserted into the permissions
matrix in [src/knowledge/permissions.ts](src/knowledge/permissions.ts);
`checkScope` gains a Librarian branch inserted **before** the
existing worker-stage `Y†` branch at
[src/knowledge/permissions.ts](src/knowledge/permissions.ts#L268-L292):

```ts
if (ctx.role === "librarian") {
  if (record.scope.kind === "project" && record.topic.domain === "rag") return { ok: true };
  return { ok: false, code: "UNAUTHORIZED_SCOPE",
           message: "librarian may only write project-scoped rag memories" };
}
```

`create_memory` and `update_memory` handlers in
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts) gain a
topic guard:

```ts
if (ctx.role === "librarian") {
  if (input.topic.domain !== "rag"
      || !["policy", "secret-incidents", "drift-incidents"].includes(input.topic.subject)) {
    throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
      "librarian topic must be rag/{policy|secret-incidents|drift-incidents}");
  }
}
```

`update_memory` gains the preflight at
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L216-L228):

```ts
const prior = await getMemory(store, { id: input.id });   // existing helper at lifecycle.ts#L733
gateScope(prior.record);                                  // closes the pre-existing gap
if (ctx.role === "librarian") enforceLibrarianTopic(prior.record);
```

This closes the pre-existing scope-check gap for **all** `Y†`
update roles, not only the Librarian — an intentional improvement
already approved in F01 §0.8.

### A.6 Bootstrap wiring (F02-dependent)

This step depends on the F02 source changes that expose
`ragService: RagService` to bootstrap. Once F02 has merged, the
child spawner / agent constructor switch at
[src/server/bootstrap.ts](src/server/bootstrap.ts#L315-L396)
carries `ragService` as a dependency, and the Librarian case adds:

```ts
case "librarian": {
  ragService.adminRoles.add("librarian");           // unlock F02 mutating tools
  return LibrarianAgent.create(ctx, input as LibrarianInput);
}
```

The mutation is idempotent and lives only on the in-memory
`RagService` instance for the current process; a fresh server start
re-adds on first Librarian dispatch. **F02 is a hard prerequisite**;
F03 will not land in a tree where `RagService` does not exist.

### A.7 Manager retrieval-miss routing rule

`prompts/manager.md` gains:

> **Routing retrieval gaps to the Librarian.** When a child
> `TaskReport.issues_found` entry has a `description` starting with
> `"rag retrieval miss:"`, dispatch `run_librarian` with:
>
> - `objective`: `"Investigate RAG retrieval miss for <subject>"`,
>   where `<subject>` is the dataset id or query phrase extracted
>   from the issue description.
> - `collection_id`: the dataset id if the description names one;
>   omit otherwise.
> - `context`: the full issue description plus relevant worker
>   findings.
>
> Do not retry the worker on the same retrieval before the
> Librarian has responded.

`objective` is required and must always be present; `collection_id`
and `context` are optional but should be included when available,
matching `RUN_LIBRARIAN_SCHEMA`.

## B. Level-up Alternative — runtime hook on `issues_found`

A dispatcher post-processor inspects every returned `TaskReport`
and auto-dispatches `run_librarian` when `issues_found` contains a
`"rag retrieval miss:"` description. Pros: deterministic; no
prompt drift. Cons: couples runtime to knowledge-domain semantics;
duplicates Manager's role as dispatch policy owner. Rejected.

## C. Chosen Direction

A. Bounded Inspector-shaped `LibrarianAgent`; ACL gates in
`permissions.ts`; F02-handler admin-role set mutated in the
Librarian bootstrap case; retrieval-miss routing carried by
Manager's prompt with full `objective`/`collection_id`/`context`
guidance.

## D. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Manager forgets the retrieval-miss rule | Regression test round-trips a `TaskReport` with the marker and asserts the rendered Manager prompt mentions `run_librarian` and `objective`. |
| Librarian writes outside `rag` topic via prompt drift | Handler topic guard rejects with `UNAUTHORIZED_ROLE`. |
| `update_memory` preflight surfaces failures for non-Librarian roles | Intentional — closes pre-existing gap. Saivage v3 release notes flag the behaviour change. |
| Operator double-dispatch creates duplicate policy memories | `topic.aspect = collection_id` makes them addressable; Librarian de-dups via `search_memories` before writing. |
| F02 not yet landed when F03 lands | Sequencing enforced: F02 → F01 → F03. F03 will not compile against a tree without `RagService`. |

## E. Test Strategy

- Unit: roster entry; tool-filter membership and denies; ACL row;
  `checkScope` Librarian branch ordering.
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
