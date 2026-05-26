# F31 — Design r1

## Proposal A — Subsume into F18 (recommended)

### Scope

No files touched under F31. The JSDoc fix at [src/agents/base.ts](src/agents/base.ts#L104-L105) ships as part of F18's Plan r2, which already creates `prompts/<role>.md`, the `loadRolePrompt` loader, the `tsup` copy step, and rewrites the JSDoc to `/** Rendered role prompt (see prompts/<role>.md and src/agents/prompts.ts). */`.

### What gets added/removed

- Added: nothing (under F31).
- Removed: nothing (under F31).
- F31 closes with an `APPROVED.md` and a pointer to F18; no commit is attributed to F31.

### Risk

Zero. F31 carries no edits of its own and depends on a change ([SPEC/v2/review-2026-05/F18/03-plan-r2.md](SPEC/v2/review-2026-05/F18/03-plan-r2.md)) that is already approved and queued.

### What it enables

- Single writer at [src/agents/base.ts](src/agents/base.ts#L104-L105) — no merge conflict between F31 and F18.
- After F18 lands, the JSDoc is not just deleted but actually true: the file `prompts/<role>.md` exists and the loader is the path the reader is told to follow.

### What it forbids

- F31 must not land an independent patch on `base.ts` while F18 is pending. Any such patch only buys minutes of "less misleading comment" at the cost of conflicting with the approved F18 plan.

### Cross-links

- Depends on (and is closed by): F18 — [SPEC/v2/review-2026-05/F18/APPROVED.md](SPEC/v2/review-2026-05/F18/APPROVED.md), [SPEC/v2/review-2026-05/F18/02-design-r2.md](SPEC/v2/review-2026-05/F18/02-design-r2.md), [SPEC/v2/review-2026-05/F18/03-plan-r2.md](SPEC/v2/review-2026-05/F18/03-plan-r2.md).
- Sibling docs-mismatch issues handled or noted by F18: F02 (roster), F09 (worker contract), F33 (defaults in prompts).

### Recommendation note

This is the right answer. F18 is approved, the JSDoc rewrite is explicitly named in F18's design, and any independent F31 patch is wasted work that would have to be re-touched by F18 anyway.

---

## Proposal B — One-line preemptive deletion (fallback if F18 slips)

### Scope

A single edit to [src/agents/base.ts](src/agents/base.ts#L104-L105):

```diff
-  /** System prompt (from prompts/<role>.md). */
+  /** Rendered system prompt string. */
   systemPrompt: string;
```

No other files.

### What gets added/removed

- Removed: the misleading "from prompts/<role>.md" claim.
- Added: a one-line accurate JSDoc (replacement, not a new docstring on code that previously had none — so it does not violate the "no new docstrings/comments" guideline).

### Risk

- Negligible runtime risk: pure comment change.
- Coordination risk: if F18 is landing soon, this edit collides with F18's JSDoc rewrite at the same line. Resolving the conflict is trivial (take F18's version), but it is still wasted churn.

### What it enables

- Removes the stale promise immediately, decoupled from F18's larger build/loader work.

### What it forbids

- This proposal is mutually exclusive with Proposal A. Pick one or the other, not both.
- The replacement JSDoc must not invent a new layout (no "future prompts/ directory"); it must describe only what is true today.

### When to pick B over A

Only if F18 is paused, descoped, or otherwise blocked in a way that would leave the misleading JSDoc in the tree for an extended period. As of this round F18 is approved and unblocked, so this proposal exists as a fallback, not as the active recommendation.

### Cross-links

- Conflicts with: [SPEC/v2/review-2026-05/F18/03-plan-r2.md](SPEC/v2/review-2026-05/F18/03-plan-r2.md) Step (BaseAgent JSDoc rewrite).
- Does NOT close F18's broader concern (system-prompt bloat, externalisation, build-step). It only removes the lie.

---

## Proposal C — Reject: F31-owned loader

Not a real third option. Implementing the `prompts/<role>.md` loader under F31 would duplicate F18's approved Proposal B and contradict F18's design. Listing it only to record why it is rejected:

- Duplicates F18's `loadRolePrompt`, `tsup` copy step, and `prompts/` tree.
- Splits ownership of `BaseAgentConfig.systemPrompt` across two issues.
- Violates the "no over-engineering / no duplicate abstractions" guideline.

Do not pursue.

---

## Recommendation

**Proposal A.** F18 is approved (Proposal B in F18, which builds the `prompts/<role>.md` tree and rewrites the JSDoc explicitly named in F31). F31 has no work of its own; it closes by reference. Proposal B (one-line JSDoc deletion) is kept on file only as a fallback for the scenario where F18 stops being the on-ramp.
