# G02 — `enforceDispatchLimits` silently omits the `designer` role

**Subsystem:** src/runtime/
**Category:** correctness / roster-drift
**Severity:** medium
**Transversality:** local (single function), but symptom of a roster-drift pattern

## Summary

The Manager-level dispatch limiter that enforces "max 1 of each worker type per batch" enumerates `coder | researcher | data_agent | reviewer` literally in an if-condition. The `designer` worker role — added later — is not in the list, so a Manager can dispatch multiple Designer children concurrently in a single tool-call batch while equivalent batches of any other worker type are rejected. This is a roster-drift bug of the exact class round-1 was supposed to extinguish.

## Evidence

[src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L262-L283):

```ts
for (const tc of calls) {
  const role = DISPATCH_ROLE_MAP[tc.name];
  if (!role) continue;

  // For workers, enforce max 1 of each.
  if (role === "coder" || role === "researcher" || role === "data_agent" || role === "reviewer") {
    if (seen[role]) {
      log.warn(`[dispatcher] Rejecting duplicate ${role} dispatch — max 1 per batch`);
      rejected.push(tc);
      continue;
    }
    seen[role] = true;
  }
  allowed.push(tc);
}
```

Compare against [src/agents/roster.ts](src/agents/roster.ts#L141-L156) (designer entry, `worker: true`) and [src/agents/roster.ts](src/agents/roster.ts#L223-L225) (`WORKER_ROLES` already derived from roster).

`DISPATCH_ROLE_MAP` itself **is** derived from ROSTER (used a few lines above), so the dispatcher already knows which roles are workers; the if-condition just doesn't ask.

## Why this matters

- A Manager that issues `[run_designer(taskA), run_designer(taskB), run_designer(taskC)]` in one round will fan out three concurrent Designer children. The whole purpose of `enforceDispatchLimits` — bound concurrency, force serialization of same-role work, and keep parent context manageable — is silently bypassed for one specific worker.
- Round-1 F26 (dispatcher worker-role enumeration) explicitly de-duplicated this kind of literal list elsewhere; this site was missed and is now a regression-by-omission.
- A test that asserts the limiter for every `WORKER_ROLES` entry would have caught both this and any future role addition.

## Rough remediation direction

Replace the literal disjunction with a roster lookup. Either:

- `if (getRoster(role).worker) { ... }` — uses the existing helper from [src/agents/roster.ts](src/agents/roster.ts#L244-L248); or
- Iterate `WORKER_ROLES.includes(role)` directly.

Add a unit test that builds a batch of `N` calls for each `WORKER_ROLES` entry and asserts that `enforceDispatchLimits` always allows exactly one and rejects the rest.

While there, consider the broader question of whether `reviewer` should really be lumped in with workers here (manager often dispatches the reviewer alone, so the limit is moot, but the encoding is at least consistent).

## Cross-links

- Same anti-pattern as G01 (supervisor priority duplication) and G03 (tool-filter duplication).
- Reinforces round-1 finding F26.
- Touches the manager-side mirror G04 (`validateFinalResponse` hardcoded dispatch tool list).
