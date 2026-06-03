# Legacy And Transition Cleanup

## Problem

The v2 codebase still contains transition scaffolding:

- v1 routing-key rejection and tests.
- Legacy knowledge-tree cleanup.
- Backward-compatible response labels.
- Unavailable MCP stubs.
- Skipped tests that document desired behavior but are not executable.
- Comments describing phased skeleton work that has since landed or changed.

Some of this was useful during migration, but it now obscures the clean v2
architecture.

## Goal

Delete compatibility and transition code that is no longer required by current
runtime state or deployment needs.

## Deletion Criteria

Delete a legacy path when all are true:

- No current project-local `.saivage/` state needs it.
- No deployed container is expected to load that exact old shape.
- The behavior is tested only to preserve old compatibility.
- The replacement behavior is documented and covered by current tests.

Keep a legacy path only when there is a concrete current consumer.

## Cleanup Targets

### Config Compatibility

- Remove v1 routing-key compatibility/rejection if current initialized projects
  no longer contain that key.
- Remove exact-message tests that exist only to preserve migration text.

### Knowledge Legacy Tree

- Remove legacy JSON-tree cleanup once sidecar migration is complete for active
  projects.
- If a migration guard is still desired, move it to a one-shot admin script
  rather than runtime startup.

### MCP Stubs

- Delete unavailable `web`, `index`, and `lock` stubs unless the dashboard needs
  to display them intentionally.
- If kept, isolate them in `builtins/stubs.ts` and document why.

### API Compatibility

- Remove backward-compatible labels such as a generic `provider` field when the
  structured routing object is sufficient.
- Keep only fields consumed by the current web UI.

### Skipped Tests

- Convert skipped prompt/sequence tests into executable stub-model tests, or
  delete them and replace with docs/tasks.
- Skipped tests should not be used as long-term architecture documentation.

## Migration Strategy

1. Inventory legacy markers with grep.
2. Classify each marker: delete, move to admin script, keep with documented
   consumer.
3. Remove tests that only assert obsolete compatibility.
4. Update docs to describe current-only behavior.
5. Run full validation.

## Validation

- `npm run typecheck`
- `npm test`
- `npm run build`
- Optional: run a local server against a freshly initialized project.

## Risk

Deleting compatibility can break old local state. That is acceptable under the
clean-v2 goal, but each deletion should be paired with a short operator note or
admin script if recovery is cheap.
