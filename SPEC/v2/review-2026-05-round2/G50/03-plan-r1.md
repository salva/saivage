# G50 — Implementation Plan (Round 1)

**Issue**: [../G50-note-manager-per-request-instantiation.md](../G50-note-manager-per-request-instantiation.md)
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
**Design**: [02-design-r1.md](02-design-r1.md)

## 1. Pre-flight

1. `grep -n "AgentContext" src/agents/ src/server/` to enumerate every
   construction site for `AgentContext`. Confirm each has access to a
   runtime or shared `noteManager` so the new field can be wired.
2. Re-read [src/agents/base.ts](../../../../src/agents/base.ts) to locate the `AgentContext` interface
   definition (or wherever it's declared) and the imports it already
   carries.
3. Confirm test fakes ([src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts#L91)) use
   `as unknown as SaivageRuntime` — they do, so no field-by-field
   updates required in those casts.

## 2. Edits

### 2.1 [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts)

- **Interface** ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66)): add
  `noteManager: NoteManager;` after `planService` (alphabetical-ish with
  the existing services; matches the rough ordering already in use).
- **Cleanup block** ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L192-L198)): rename local
  `noteCleanup` to a `const noteManager` hoisted just above the block so
  the same binding flows into the runtime literal. The cleanup call
  becomes `await noteManager.cleanupStaleNotes(...)`.
- **Runtime literal** ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L249)): add
  `noteManager,` next to `planService,`.
- **AgentContext builders** in this file (the child-spawner factory and
  any context literals): add `noteManager: runtime.noteManager` (or
  `noteManager` if hoisted locally). Find by greping for fields like
  `tracker:` or `project:` paired with `router:`.

### 2.2 [src/agents/base.ts](../../../../src/agents/base.ts) (or wherever `AgentContext` lives)

- Add `noteManager: NoteManager;` to `AgentContext`.
- Add the `import type { NoteManager } from "../runtime/notes.js";`
  alongside existing type imports.

### 2.3 [src/agents/planner.ts](../../../../src/agents/planner.ts)

- Line [src/agents/planner.ts](../../../../src/agents/planner.ts#L52): replace
  `const noteManager = new NoteManager(ctx.project.paths.notes);`
  with `const noteManager = ctx.noteManager;`.
- Remove the `NoteManager` symbol from the import at
  [src/agents/planner.ts](../../../../src/agents/planner.ts#L14) — keep only `NoteChannel`.
- Leave `this.noteManager = noteManager;` in place if any in-class
  reference uses it; otherwise drop the field too. Verify by grep.

### 2.4 [src/server/server.ts](../../../../src/server/server.ts)

- Line [src/server/server.ts](../../../../src/server/server.ts#L28): drop the `NoteManager` import.
- Lines [src/server/server.ts](../../../../src/server/server.ts#L254-L283): rewrite the four handlers per
  design §4. Each handler-local `const noteManager = new NoteManager(...)`
  is removed; calls become `runtime.noteManager.<method>(...)`.

### 2.5 Other `AgentContext` consumers

For every other agent file that constructs an `AgentContext` (Manager,
Coder, Worker, Reviewer, Designer, Data, Researcher, Inspector, Chat,
Handoff, Conventions, Prompts, TaskReport — see [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)):

- If they build an `AgentContext` literal, add the new field.
- If they only consume an `AgentContext` passed in, no change.

Concrete file list to verify during implementation by:
`grep -rln "AgentContext\b" src/`.

## 3. Regression tests

Place new tests in [src/server/server.test.ts](../../../../src/server/server.test.ts) (if it exists) or add
[src/server/server.notes.test.ts](../../../../src/server/server.notes.test.ts) as a new sibling beside the existing
server tests. The intent is to assert runtime-shared identity, not
HTTP behaviour (which is already covered indirectly by NoteManager unit
tests).

### 3.1 Identity test (the primary regression guard)

```ts
import { describe, it, expect } from "vitest";
import { bootstrap } from "./bootstrap.js";
// …test scaffolding to build a temp project

describe("G50 — NoteManager singleton", () => {
  it("exposes one shared NoteManager on the runtime", async () => {
    const runtime = await bootstrap(/* temp project */);
    try {
      expect(runtime.noteManager).toBeDefined();

      // Multi-request: every handler dispatch must observe the same
      // instance.
      const a = runtime.noteManager;
      const b = runtime.noteManager;
      expect(a).toBe(b);

      // `delivered` cursor must be shared across requests. Push a note,
      // mark it delivered via pullDeliverables, then verify a *second*
      // pullDeliverables (simulating a second request) does not re-emit.
      await runtime.noteManager.createNote({
        channel: "test",
        sessionId: "g50",
        content: "x",
        permanent: true,
      });
      const first = await runtime.noteManager.pullDeliverables();
      const second = await runtime.noteManager.pullDeliverables();
      expect(first.length).toBe(1);
      expect(second.length).toBe(0);
    } finally {
      await runtime.shutdown();
    }
  });
});
```

(API names — `createNote` vs `createUserNote` — must be confirmed
against [src/runtime/notes.ts](../../../../src/runtime/notes.ts) during implementation; use the existing
`createUserNote` helper if the manager doesn't expose a method.)

### 3.2 Planner / runtime identity test

```ts
it("Planner consumes runtime.noteManager", async () => {
  const runtime = await bootstrap(/* temp project */);
  try {
    const ctx = buildPlannerContextFromRuntime(runtime);
    expect(ctx.noteManager).toBe(runtime.noteManager);
  } finally {
    await runtime.shutdown();
  }
});
```

If a full bootstrap is too heavy here, fall back to a unit-level check
that whatever helper builds `AgentContext` from `SaivageRuntime` copies
the field by reference.

### 3.3 Static guard

Add a one-off `grep` assertion to the existing test that scans the
codebase (or, lacking one, accept the acceptance criterion in design §7
to be enforced by CI / code review):

```ts
it("only constructs NoteManager in bootstrap and its own unit tests", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("grep", ["-rln", "new NoteManager", "src/"], {
    encoding: "utf8",
  });
  const lines = out.split("\n").filter(Boolean).sort();
  expect(lines).toEqual([
    "src/runtime/runtime.test.ts",
    "src/server/bootstrap.ts",
  ]);
});
```

This is the regression guard that catches drift if a future contributor
re-adds a per-request `new NoteManager(...)`.

## 4. Validation

1. `npm run build` from [/](../../../../).
2. `npm test` — full Vitest suite. Targeted:
   - `npx vitest run src/runtime/runtime.test.ts`
   - `npx vitest run src/server/` (or the new test file).
3. Manual smoke via the dashboard against the local `saivage-v3`
   harness, per workspace memory: `GET /api/notes`, create, ack, delete
   — confirm 200s and consistent listings.
4. `grep -rn "new NoteManager" src/` matches design §7 acceptance.

## 5. Rollout

Single PR; no migration; no config flag. Workspace rule "no backward
compatibility" applies — delete the old `new NoteManager(...)` lines
outright.

## 6. Follow-ups (tracked, not in this PR)

- Atomic `acknowledgeNote` write (lift the read-modify-write into
  `NoteManager` with per-id serialisation).
- Optional in-process cache / inotify watcher now that ownership is
  single.
- G45: keep the internals/runtime doc in sync with the new
  `SaivageRuntime` field.
