# G04 — `ManagerAgent.validateFinalResponse` hardcodes the dispatch-tool list

**Subsystem:** src/agents/
**Category:** roster-drift / correctness
**Severity:** medium
**Transversality:** local, but a continuation of the G01/G02/G03 pattern

## Summary

`ManagerAgent.validateFinalResponse()` decides whether the Manager has done its job by asserting it used at least one of `run_coder`, `run_researcher`, `run_data_agent`, `run_designer`, `run_reviewer`. The list is hardcoded in source. If a new worker role is added to ROSTER and given a dispatch tool, the Manager will silently consider that worker not to count as "having dispatched anything" — and the Manager will be looped with the "you have not dispatched any worker yet" injection until it dispatches one of the five legacy tools. This is the same architectural drift class as G02 and G03, on the agents side.

## Evidence

[src/agents/manager.ts](src/agents/manager.ts#L106-L113):

```ts
protected override validateFinalResponse(): string | null {
  if (this.hasUsedToolNamed("run_coder", "run_researcher", "run_data_agent", "run_designer", "run_reviewer")) {
    return null;
  }
  return "Invalid final stage response: you have not dispatched any worker yet.";
}
```

The five names are the dispatch tools whose source-of-truth lives in [src/agents/roster.ts](src/agents/roster.ts#L67) (`run_manager`), [src/agents/roster.ts](src/agents/roster.ts#L85) (`run_coder`), and so on — each ROSTER entry has its own `dispatchTool` field, and the helper `DISPATCHABLE_ROLES` ([src/agents/roster.ts](src/agents/roster.ts#L229-L233)) already enumerates the subset whose tool is non-null.

Compare with [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L1-L60) (not pasted) where `DISPATCH_ROLE_MAP` is **already** derived from ROSTER via `getRosterByDispatchTool` — proving the derivation pattern exists in this codebase and is just not applied here.

## Why this matters

- Adding a new dispatchable worker role (say, `qa_agent`) requires editing two unrelated source files (roster + manager.ts) to make Manager accept it as valid completion. The compiler will not flag the miss.
- The condition is also overly permissive in the opposite direction: it accepts `run_manager` if a Manager somehow gets a dispatch tool for itself (impossible today because `dispatchableBy` restricts it, but the assertion is correctness-by-accident).
- This is a *symptom* of the same single-source-of-truth violation as G01/G02/G03, which is why the metaplan should bundle the fix: introducing a `getDispatchTools(parentRole: AgentRole): string[]` helper on ROSTER fixes all four sites.

## Rough remediation direction

Replace the literal list with a roster-derived helper:

```ts
// roster.ts (new helper)
export function getDispatchToolsFor(parent: AgentRole): string[] {
  return ROSTER
    .filter((e) => e.dispatchTool !== null && e.dispatchableBy.includes(parent))
    .map((e) => e.dispatchTool as string);
}

// manager.ts
protected override validateFinalResponse(): string | null {
  const tools = getDispatchToolsFor("manager");
  if (this.hasUsedToolNamed(...tools)) return null;
  return "Invalid final stage response: you have not dispatched any worker yet.";
}
```

This also enables the same derivation in the prompt-rendering path (`renderRosterSummary`) and removes any future need to remember which manager dispatches which worker.

## Cross-links

- Same drift family as G01, G02, G03.
- The new helper `getDispatchToolsFor(parent)` could in principle drive prompt generation (run_X tool descriptions) too — minor scope creep, worth considering at design time.
