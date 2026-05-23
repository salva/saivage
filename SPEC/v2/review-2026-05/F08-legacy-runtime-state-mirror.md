# F08 — Legacy runtime-state mirror is written on every update

**Category**: dead-code
**Severity**: low
**Transversality**: module

## Summary

`writeRuntimeState` dual-writes the runtime state to both `paths.runtimeState` (the SPEC-current `.saivage/tmp/state/runtime.json`) and a legacy `.saivage/runtime/runtime-state.json` mirror. The mirror is read by no live code path; only the recovery test asserts on its existence to lock in the dual-write behaviour.

## Evidence

- Dual-write call site: [src/runtime/recovery.ts](src/runtime/recovery.ts#L299-L308).
- `legacyRuntimeStatePath` helper: [src/runtime/recovery.ts](src/runtime/recovery.ts#L309).
- Test that asserts the mirror exists: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1028-L1042).
- The planner system prompt already documents the mirror as "compatibility mirror, not the primary state path": [src/agents/planner.ts](src/agents/planner.ts#L41).

## Why this matters

Architecture-first means deleting compatibility shims rather than carrying them. The legacy path doubles the fsync cost on a hot path (every agent activity ticks runtime state), and the planner prompt has to explain its existence — confusing the strategist about which file is authoritative.

## Related

- F22 (sync fs blocks the event loop)
