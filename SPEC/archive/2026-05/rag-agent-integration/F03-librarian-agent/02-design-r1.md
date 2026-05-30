# F03 — Librarian Agent: Design

This design crystallises the module shape, prompt placement, and
authorization wiring for the Librarian role specified in
[01-analysis-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md).

## A. Focused Proposal — non-worker BaseAgent subclass with prompt-level fallback

### A.1 Modules

```
src/agents/
├── librarian.ts            // LibrarianAgent class + LibrarianInput
├── roster.ts               // ROSTER += librarian entry
├── tool-filters.ts         // LIBRARIAN_TOOLS + TOOL_FILTERS.librarian
├── prompts.ts              // PROMPT_KEY_TO_ROLE/ROLE_PROMPT_NAMES += librarian
├── prompt-keys.ts          // "librarian"
└── base.ts                 // RUN_LIBRARIAN_SCHEMA + DISPATCH_SCHEMA_BY_TOOL entry

prompts/
├── librarian.md            // role prompt per analysis §7
└── manager.md              // append: TaskReport.issues_found rule per analysis §3.4

src/knowledge/
├── types.ts                // KnowledgeAgentRoleSchema += "librarian"
└── permissions.ts          // ACL row + checkScope branch per analysis §5

src/mcp/
└── knowledgeMemory.ts      // create_memory topic guard + update_memory preflight per §5

src/server/
└── bootstrap.ts            // case "librarian"; mutates ragService.adminRoles.add("librarian")
```

### A.2 `LibrarianAgent` class

`LibrarianAgent` extends `BaseAgent` with:

```ts
export interface LibrarianInput {
  objective: string;
  collection_id?: string;
  context?: string;
}

export class LibrarianAgent extends BaseAgent<LibrarianInput, string> {
  constructor(opts: LibrarianAgentOptions) {
    super({
      role: "librarian",
      promptKey: "librarian",
      input: opts.input,
      // standard BaseAgent dependencies
    });
  }
  protected async runImpl(): Promise<string> {
    return this.driveModelLoop();   // standard BaseAgent loop returning final markdown
  }
}
```

The output is the Librarian's markdown report (Findings, Actions
taken, Recommendations, Open questions — per analysis §7) returned
verbatim to the caller through the standard dispatch JSON-stringify
path in
[dispatcher.ts](src/runtime/dispatcher.ts#L156-L249).

### A.3 Roster entry shape

Verbatim from analysis §3.1.

### A.4 Tool filter and dispatch schemas

Verbatim from analysis §3.2 and §4.

### A.5 Knowledge ACL and handler guard

Verbatim from analysis §5. The `checkScope` Librarian branch is
inserted **immediately before** the existing worker-stage `Y†`
branch in [permissions.ts](src/knowledge/permissions.ts). The
`update_memory` preflight reads the prior record, runs `gateScope`,
and runs the topic guard.

### A.6 Bootstrap wiring

```ts
case "librarian": {
  ragService.adminRoles.add("librarian");      // unlock F02 mutating tools
  return new LibrarianAgent({
    input,
    modelKey: "orchestrator",
    /* ... standard deps */
  });
}
```

The mutation of `ragService.adminRoles` happens lazily inside the
case so projects that never dispatch a Librarian never grant the
admin set. The `adminRoles` mutation is idempotent.

### A.7 Manager prompt rule

`prompts/manager.md` gains a section:

> **Routing retrieval gaps to the Librarian.** When a child
> `TaskReport.issues_found` entry has a `description` starting with
> `"rag retrieval miss:"`, dispatch `run_librarian` with the issue
> description as `context`. Do not retry the worker on the same
> retrieval before the Librarian has responded.

This is prompt-level, not runtime-level, per analysis §3.4 and §1.8.

## B. Level-up Alternative — runtime hook on `issues_found`

A dispatcher post-processor inspects every returned `TaskReport`
and auto-dispatches `run_librarian` when `issues_found` contains a
`"rag retrieval miss:"` description. Pros: deterministic;
operator-invisible; no Manager prompt drift. Cons: changes the
runtime contract (worker-internal escalation channel now triggers
side-effects), couples runtime to knowledge-domain semantics,
duplicates Manager's existing role as the dispatch policy owner,
and forces the Librarian to share Manager's call quota. Rejected
because the resume directive and architecture-first rule favour
keeping the runtime knowledge-agnostic.

## C. Chosen Direction

A. Bounded `LibrarianAgent`; ACL gates in the existing knowledge
permissions matrix; F02-handler admin-role set mutated in the
bootstrap case; retrieval-miss routing carried by Manager's prompt.

## D. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Manager forgets the retrieval-miss rule | Covered by `prompts/manager.md` regression test that round-trips a worker `TaskReport` with the marker and asserts the Manager prompt mentions `run_librarian`. |
| Librarian writes outside `rag` topic via prompt drift | Handler topic guard rejects with `UNAUTHORIZED_ROLE`. |
| `update_memory` preflight surfaces failures for non-Librarian roles | Intentional — closes pre-existing gap. Update Saivage v3 release notes accordingly. |
| Operator double-dispatch creates duplicate policy memories | Memory `topic.aspect = collection_id` makes them addressable; the Librarian de-dups via `search_memories` before writing. |
| `ragService.adminRoles` mutation leaks across project restarts | The set lives on the in-memory `RagService` object constructed at boot. New process starts with empty set; F03's bootstrap case re-adds on first dispatch. |

## E. Test Strategy

- Unit: roster entry; filter membership and denies; ACL row;
  `checkScope` Librarian branch ordering.
- Handler: `create_memory` topic guard; `update_memory` preflight
  scope check and topic guard; non-Librarian roles unaffected.
- Dispatch: Planner / Manager → `run_librarian` succeeds; Chat
  denied; bootstrap case constructs `LibrarianAgent`.
- Behaviour: decision-tree branches with mocked F02 tools
  (drift confirmation gate; secret-incident memory write payload
  is `{count, collection_id, context}` only; protected-dataset
  redirect; no-hit fallback).
- Prompt: Manager prompt mentions `run_librarian` after the
  `"rag retrieval miss:"` rule is added.

## F. Out of Scope

- Runtime hook on `issues_found` (alternative B).
- Auto-recurring reconcile schedules.
- Librarian write access to skills or non-rag memories.
- `create_note` grant.
