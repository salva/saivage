# G49 — Design (Round 4)

- **Round 1**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md)
- **Round 2**: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md)
- **Round 3**: [01-analysis-r3.md](01-analysis-r3.md), [02-design-r3.md](02-design-r3.md), [03-plan-r3.md](03-plan-r3.md)
- **Round 4 analysis**: [01-analysis-r4.md](01-analysis-r4.md)
- **Review**: [04-review-r3.md](04-review-r3.md)

This r4 design supersedes [02-design-r3.md](02-design-r3.md) only on the single point raised by [04-review-r3.md](04-review-r3.md). All r3 alias-topology, vitest-config shape, schema, composable, server-channel, Telegram, and failure-mode decisions stand. No source-tree file shape changes in r4.

## 1. Acceptance-check command (clarification, no source change)

The three-config alias topology and the [vitest.config.ts](../../../../vitest.config.ts) shape from [02-design-r3.md §1](02-design-r3.md#1-alias-topology-new-section-vs-r2) and [§1.1](02-design-r3.md#11-vitestconfigts-shape) are unchanged. What changes is purely how the acceptance checklist proves the alias resolves to the same on-disk file as `src/channels/ws-schema.ts`.

The original r3 command relied on plain `node` to import a `.ts` config, which fails in this repo. The replacement uses the `tsx` Node import hook, already installed at `tsx@^4.21.0` in [package.json](../../../../package.json) `devDependencies`. The hook is invoked as `node --import tsx`, the form supported by tsx ≥ 4.x. Functionally the command still:

1. Loads [vitest.config.ts](../../../../vitest.config.ts) through `tsx`.
2. Reads `default.resolve.alias["@channels/ws-schema"]`.
3. Compares it (string-equal) with `realpath src/channels/ws-schema.ts`.

A mismatch — either alias missing, alias pointing at a sibling file, or `fileURLToPath(new URL(...))` evaluating to a different absolute path — fails the check. A match proves the resolver in the test runner agrees with the on-disk schema file.

No other design element changes: [vitest.config.ts](../../../../vitest.config.ts), [web/vite.config.ts](../../../../web/vite.config.ts), [web/tsconfig.json](../../../../web/tsconfig.json), and the server-side relative import in [src/channels/websocket.ts](../../../../src/channels/websocket.ts) keep their r3 shapes verbatim.
