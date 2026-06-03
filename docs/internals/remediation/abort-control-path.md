# Abort Control Path

## Problem

The docs describe urgent notes triggering abort, rollback, and replanning. The
live code contains old abort helpers, but the urgent-note scanner is not wired
into the running planner/runtime path.

The explicit planner restart path already exists: `PlannerControl` is defined in
`src/server/bootstrap.ts`, and `runPlannerWithRecovery` already listens for
restart requests, sets the planner abort signal, queues a restart directive, and
starts a new planner loop.

This creates conceptual duplication:

- User notes can influence the planner as normal context.
- Planner restart requests can abort and restart the planner through the live
  recovery loop.
- Urgent-note abort exists as stale helper code but is not operationally active.

## Options Considered

| Option | Pros | Cons |
| --- | --- | --- |
| Wire urgent-note polling into all running agents | Matches old docs. | Adds another async control loop and rollback behavior that is hard to reason about. |
| Remove urgent-note abort and use explicit restart/control requests | Simpler runtime model; mostly matches live code. | Requires one UI/API affordance if operators need manual restart. |
| Keep both paths | Feature-rich. | More state transitions and more confusing recovery semantics. |

## Chosen Approach

Unify on the explicit planner restart/control path that already exists. Treat
manual interruption as a direct call to `PlannerControl.requestRestart`, not as
a note-scanning or rollback side effect.

This is cleaner for v2 because it avoids hidden polling and makes user control
visible through one path: `PlannerControl.requestRestart`.

## Design

- Keep `PlannerControl` as the runtime control point.
- Add one UI/API affordance for “restart planner with reason” if not already
  exposed.
- Do not add a mapping layer from urgent notes to restarts. Notes are context;
  restarts are explicit control actions.
- Remove `runtime/abort.ts` helpers. Current live code does not import them;
  only tests do.
- Avoid automatic `git checkout -- .` rollback as part of this path. Rollback is
  too destructive for a generic control signal and should be a deliberate stage
  or operator action.

## Execution Plan

1. Add a server or chat command path that calls `plannerControl.requestRestart`.
2. Update docs to say restart interrupts the planner and queues a restart
   directive; it does not automatically reset the working tree.
3. Remove `runtime/abort.ts` and update tests that import it.
4. Update tests away from standalone urgent-note scanner and rollback
   expectations.
5. Leave crash-recovery wording about “aborted tasks” alone unless it is
   actually describing the stale urgent-note path; crash recovery is a separate
   runtime-state concern.

## Validation

- `npm run typecheck`
- `npm test`
- Focused test: explicit restart request aborts current planner loop and queues
  restart directive.

## Risks

- Operators who expect note creation to restart the planner must use the explicit
  restart affordance instead. This is intentional: control-plane actions should
  be visible, direct, and auditable.
