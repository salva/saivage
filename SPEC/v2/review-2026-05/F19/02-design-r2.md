# F19 Design r2 — barrel: complete it, or delete it

## Changes from r1

- **Removed the incorrect packaging claim from Proposal B.** r1 said `tsup.config.ts` has an `entry: ["src/index.ts"]`-style configuration and that the providers barrel is reached "only as a transitive dep". Both are wrong. Re-verified [tsup.config.ts](tsup.config.ts#L5): the single bundler entry is `src/server/cli.ts`. The providers barrel is not reached transitively either, because nothing in the bundled graph imports it. The deletion rationale now rests on the actual packaging shape: no library entry point exists, the CLI is the only bundled entry, and `dist/providers/index.js` is not emitted today.
- **Reworded Proposal A's "what it enables".** r1 mentioned `import { CopilotProvider } from "saivage/providers"` as if the package already exposed `saivage/providers`. It does not — [package.json](package.json#L1-L40) has no `exports` map. The proposal now correctly states that enabling this consumer pattern would require *also* adding a `package.json` `exports` entry and a corresponding `tsup` entry, neither of which exists today; Proposal A on its own does not enable any new import shape.
- **Reworded the recommendation argument** so it cites the corrected facts (no `main`/`exports`, single CLI bundler entry) instead of the r1 placeholders.

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

**What it enables**: literally nothing today, because nothing imports the barrel and [package.json](package.json#L1-L40) does not expose `src/providers/index.ts` as a subpath via an `exports` map. To turn this into a usable library subpath one would also have to (a) add `"./providers": "./dist/providers/index.js"` (or similar) to a new `exports` map in [package.json](package.json), and (b) add `src/providers/index.ts` to [tsup.config.ts](tsup.config.ts) `entry`. Without those two extra changes, this proposal only makes the dead barrel internally consistent.

**What it forbids**: nothing.

**Recommendation note**: This fixes the literal complaint in [F19-provider-barrel-incomplete.md](../F19-provider-barrel-incomplete.md) but does not address the deeper finding from [01-analysis-r2.md](01-analysis-r2.md): the barrel has zero importers and is not advertised as a library entry. After this change it would still have zero importers — we would simply have made dead code more thorough. By project guideline 2 ("no abstractions used only once"; an abstraction used zero times is the limit case), this proposal preserves dead code. Recommended only if there is a concrete near-term plan to ship `saivage` as a library, complete with `exports` map and additional `tsup` entries; there is no such plan in the repo today.

---

## Proposal B — Delete the barrel

**Scope (files touched)**:
- [src/providers/index.ts](src/providers/index.ts) — deleted.

**What gets added**: nothing.

**What gets removed**:
- The barrel file itself.
- Nothing else. [package.json](package.json#L1-L40) has no `main`, `exports`, or `types` field, so no packaging metadata needs to change. [tsup.config.ts](tsup.config.ts#L5) lists only `src/server/cli.ts` as an entry, so no bundler config needs to change. Because no consumer imports the barrel, the bundled `dist/` was not pulling it in to begin with, and the build output is unchanged.

**Risk**: minimal. Verification is `npm run typecheck && npm run build && npx vitest run`. Because no source or test file imports the barrel (broadened grep recipe in [03-plan-r2.md](03-plan-r2.md) confirms this), TypeScript and Vitest cannot break.

**What it enables**:
- Honest signal: the file tree no longer claims `src/providers/` has a curated public surface. The actual surface — the one consumers care about — is `src/providers/router.ts` (for `ModelRouter`) and `src/providers/types.ts` (for the message types). Both are imported by deep path and stay that way.
- F13 can land without ambiguity: `ProviderErrorKind` is added to [src/providers/types.ts](src/providers/types.ts), and consumers import it via `from "../providers/types.js"`, identical to how they already import `ChatRequest`/`ChatResponse`. No "should this be in the barrel too?" question to litigate.
- F02 ([F02-agent-roster-drift.md](../F02-agent-roster-drift.md)) is left to address the agent-side roster drift on its own terms; F19 stops being a category-of-thing F02 can be tempted to copy from.

**What it forbids**: A future "library consumer of `saivage/providers`" would have to either (a) be added by importing the modules they need by deep path (which is what every existing consumer does), or (b) re-introduce a barrel at that time, with a documented purpose, a `package.json` `exports` entry, a `tsup` entry, and at least one importer. This is the desired direction — no abstractions ahead of need.

**Recommendation note**: This is the architecture-first move. It removes dead code instead of polishing it, matches what every consumer actually does, and is reversible in one commit if a real library entry point ever materialises.

---

## Recommendation

**Proposal B — delete the barrel.**

Reasons, in order:

1. **Project guideline 1 / 2**: the barrel is dead. The mandate is to remove dead code, not to extend it for symmetry. Proposal A makes the dead code more thorough; Proposal B removes it.
2. **No library consumer exists, and the package is not configured to have one.** [package.json](package.json#L1-L40) has no `main`, `module`, `exports`, or `types`. [tsup.config.ts](tsup.config.ts#L5) bundles only the CLI entry `src/server/cli.ts`. `src/index.ts` (the in-source aggregator) deliberately does not re-export from `src/providers/`. The premise of Proposal A — that someone might import from a public `saivage/providers` subpath — is not just unsupported, it is not even reachable given the current packaging.
3. **F13 alignment.** F13 needs a typed-error API to live in `src/providers/types.ts`. Both proposals support that, but Proposal B keeps the import path uniform across the codebase (everyone imports `../providers/types.js`), whereas Proposal A invites a future bikeshed about whether the new `ProviderErrorKind` should also be re-exported.
4. **Reversibility.** If a library entry point is ever required, recreating a barrel (and the matching `exports` / `tsup` entries) takes minutes and can be done with a real list of importers in hand — better than today's accident-of-history list.
