# F19 Design — barrel: complete it, or delete it

## Proposal A — Complete the barrel

**Scope (files touched)**:
- [src/providers/index.ts](src/providers/index.ts) — add `PiAiProvider`, `CopilotProvider`, `OpenAICodexProvider`, `LlamaCppProvider` re-exports.

**What gets added**: four lines.

```ts
export { PiAiProvider } from "./pi-ai.js";
export { CopilotProvider } from "./copilot.js";
export { OpenAICodexProvider } from "./openai-codex.js";
export { LlamaCppProvider } from "./llamacpp.js";
```

**What gets removed**: nothing.

**Risk**: trivial. No type widening, no behaviour change.

**What it enables**: a putative library consumer could write `import { CopilotProvider } from "saivage/providers"`. F13's `ProviderErrorKind` (when it lands) would still be added in [src/providers/types.ts](src/providers/types.ts) and re-exported here alongside the other type aliases.

**What it forbids**: nothing.

**Recommendation note**: This fixes the literal complaint in [F19-provider-barrel-incomplete.md](../F19-provider-barrel-incomplete.md) but does not address the deeper finding from `01-analysis-r1.md`: the barrel has zero importers. After this change it would still have zero importers — we would simply have made the dead code more consistent. By project guideline 2 ("no abstractions used only once"; an abstraction used zero times is the limit case), this proposal preserves dead code. Recommended only if there is a concrete near-term plan to publish providers as a library entry point (e.g. adding an `exports` field to `package.json` pointing at `dist/providers/index.js`). There is no such plan in the repo today.

---

## Proposal B — Delete the barrel

**Scope (files touched)**:
- [src/providers/index.ts](src/providers/index.ts) — deleted.

**What gets added**: nothing.

**What gets removed**:
- The barrel file itself.
- Anything in `tsup.config.ts` / `package.json` that mentions it (verified: nothing does today — `tsup.config.ts` has a single `entry: ["src/index.ts"]`-style configuration; the providers barrel is reached only as a transitive dep, and since no consumer imports it the emit will simply stop containing it).

**Risk**: minimal. Verification is `npm run typecheck && npm run build && npx vitest run`. Because no source or test file imports the barrel (grep confirmed), TypeScript and Vitest cannot break.

**What it enables**:
- Honest signal: the file tree no longer claims `src/providers/` has a curated public surface. The actual surface — the one consumers care about — is `src/providers/router.ts` (for `ModelRouter`) and `src/providers/types.ts` (for the message types). Both are imported by deep path and stay that way.
- F13 can land without ambiguity: `ProviderErrorKind` is added to [src/providers/types.ts](src/providers/types.ts), and consumers import it via `from "../providers/types.js"`, identical to how they already import `ChatRequest`/`ChatResponse`. No "should this be in the barrel too?" question to litigate.
- F02 ([F02-agent-roster-drift.md](../F02-agent-roster-drift.md)) is left to address the agent-side roster drift on its own terms; F19 stops being a category-of-thing F02 can be tempted to copy from.

**What it forbids**: A future "library consumer of `saivage/providers`" would have to either (a) be added by importing the modules they need by deep path (which is what every existing consumer does), or (b) re-introduce a barrel at that time, with a documented purpose and at least one importer. This is the desired direction — no abstractions ahead of need.

**Recommendation note**: This is the architecture-first move. It removes dead code instead of polishing it, matches what every consumer actually does, and is reversible in one commit if a real library entry point ever materialises.

---

## Recommendation

**Proposal B — delete the barrel.**

Reasons, in order:

1. **Project guideline 1 / 2**: the barrel is dead. The mandate is to remove dead code, not to extend it for symmetry. Proposal A makes the dead code more thorough; Proposal B removes it.
2. **No library consumer exists.** `package.json` does not advertise `src/providers/index.ts` as an entry point; `src/index.ts` (the actual top-level barrel for the package) deliberately does not re-export providers. The premise of Proposal A — that someone might import from `saivage/providers` — is not supported by the package's own configuration.
3. **F13 alignment.** F13 needs a typed-error API to live in `src/providers/types.ts`. Both proposals support that, but Proposal B keeps the import path uniform across the codebase (everyone imports `../providers/types.js`), whereas Proposal A invites a future bikeshed about whether the new `ProviderErrorKind` should also be re-exported.
4. **Reversibility.** If a library entry point is ever required, recreating a barrel takes minutes and can be done with a real list of importers in hand — better than today's accident-of-history list.
