# G49 — Analysis (Round 4)

- **Round 1**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md)
- **Round 2**: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md)
- **Round 3**: [01-analysis-r3.md](01-analysis-r3.md), [02-design-r3.md](02-design-r3.md), [03-plan-r3.md](03-plan-r3.md)
- **Review**: [04-review-r3.md](04-review-r3.md)
- **Issue**: [../G49-usewebsocket-send-leaky-envelope.md](../G49-usewebsocket-send-leaky-envelope.md)

This r4 analysis supersedes [01-analysis-r3.md](01-analysis-r3.md) only on the single point raised by [04-review-r3.md](04-review-r3.md). Every framing, alias-topology argument, schema decision, strict-outbound argument, browser-close semantics, Telegram dispatch, and test surface from r3 stands.

## 1. Correction to r3 framings

### 1.1 Acceptance command must not invoke plain `node` on a TypeScript config

r3 §"Acceptance checklist (delta from r2)" introduced a verification step that runs `node -e 'import("./vitest.config.ts").then(...)'` to compare the alias target against `realpath src/channels/ws-schema.ts`. In this repository, plain Node fails before evaluating the dynamic import body with `TypeError: Unknown file extension ".ts" for /home/salva/g/ml/saivage/vitest.config.ts`. The acceptance step would therefore report failure even on a correct implementation — a false negative.

**Correction.** The verification command is rewritten to use the existing `tsx` loader (already in `devDependencies` as `tsx@^4.21.0`), which the repo uses elsewhere to import `.ts` modules from Node. The replacement form is `node --import tsx -e 'import("./vitest.config.ts").then(...)'`. It exercises the same code path as before — actually loading the config and reading `resolve.alias["@channels/ws-schema"]` — and so still proves that the alias is wired and points at the real on-disk schema file. No other acceptance line changes.

**Alternatives considered and rejected.**

- *Pure JS-only check (`node -e "fs.readFileSync('vitest.config.ts','utf8').includes('@channels/ws-schema')"`).* Rejected: this only proves the literal string appears in the file. It does not prove the alias **resolves** to the correct target, which is the property the checklist exists to guarantee. A typo in the URL argument or a missing `fileURLToPath` wrapper would pass.
- *`npx vitest --config vitest.config.ts --reporter=verbose --run web/src/composables/useWebSocket.test.ts`.* Rejected as the verification step (still valid as an end-to-end smoke). It conflates "alias resolves to the right file" with "all 7 composable assertions pass", so a regression in any of T14–T20 would mask itself as an alias failure and vice-versa. The current checklist already has a separate line for `npm test` reporting `Test Files 3 passed (3)` and `Tests 20 passed (20)`; running the full vitest invocation here would be a duplicate.
- *Direct `realpath` on a hand-written string.* Rejected: it would not catch a config-time `fileURLToPath`/`new URL` mistake, which is precisely the failure mode that motivated adding the check in r3.

### 1.2 No other r3 substance is in scope for r4

[04-review-r3.md](04-review-r3.md) explicitly verifies the alias topology, the server-side import strategy, and the workspace-local smoke path as correct. r4 changes nothing outside the one acceptance command.
