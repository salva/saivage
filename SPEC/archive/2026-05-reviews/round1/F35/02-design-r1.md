# F35 — Design r1

## Proposal A — Focused fix: delete `CLIChannel`

### Scope (files touched)

- Delete `src/channels/cli.ts`.
- Edit `src/channels/index.ts`: remove the `export { CLIChannel } from "./cli.js";` line.

### What gets added

Nothing.

### What gets removed

- The `CLIChannel` class and its `readline`-on-stdio implementation.
- The single re-export line in the barrel.

### Risk

Near-zero. No code constructs `CLIChannel` (grep verified — see analysis). The bundle entry is `src/server/cli.ts` per [tsup.config.ts](tsup.config.ts#L5); the `src/channels/` directory is internal to the build (no `exports` field in `package.json`, no `dts: true`). Removing one orphan re-export cannot break consumers.

### What it enables

- Removes one "phantom integration" signal that misleads readers of the channels directory into believing a CLI chat channel is wired.
- Aligns with mandatory guideline 1 (architecture-first, no backward compatibility) and 2 (no abstractions used only once).

### What it forbids

- Future re-introduction must be paired with a concrete caller in the same change (typical YAGNI discipline).

### Recommendation note

This is the literal minimum that resolves the F35 issue as filed. It leaves two adjacent orphans untouched (`src/channels/index.ts` barrel — itself unimported; `src/channels/oneshot.ts` `OneShotChannel` — also unimported except through that barrel). Both are flagged in the analysis. Proposal B handles them in the same commit.

---

## Proposal B — One level up: collapse the unused channels barrel

### Scope (files touched)

- Delete `src/channels/cli.ts`.
- Delete `src/channels/oneshot.ts`.
- Delete `src/channels/index.ts` (barrel) entirely.

No other source files change because no caller imports the barrel; every consumer already imports the concrete module:

- `import type { ChatChannel } from "../channels/types.js"` — [src/agents/chat.ts](src/agents/chat.ts#L16), [src/agents/agents.test.ts](src/agents/agents.test.ts#L17).
- `import { TelegramChannel } from "../channels/telegram.js"` — [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L9).
- `import { WebSocketChannel } from "../channels/websocket.js"` — [src/server/server.ts](src/server/server.ts#L26).

After this change, `src/channels/` contains only the in-use files: `types.ts`, `websocket.ts`, `telegram.ts`, `telegram.test.ts`.

### What gets added

Nothing.

### What gets removed

- The `CLIChannel` class (same as A).
- The `OneShotChannel` class — defined in [src/channels/oneshot.ts](src/channels/oneshot.ts#L6) and only re-exported by the barrel; no constructor or import elsewhere in `src/` or `web/src/`.
- The barrel module itself, since no caller imports `"../channels"` (only specific submodules).

### Risk

Still low. The verification is the same grep set used for A; additionally:

- `OneShotChannel`: grep `OneShotChannel` returns only `src/channels/oneshot.ts:6` (definition) and `src/channels/index.ts:3` (re-export).
- Barrel: grep `from ".*/channels"` (no further segment) returns no hits.

The bundle entry is unaffected (only `src/server/cli.ts`). No `package.json#exports` field references the barrel. tsup tree-shaking already drops the unused exports, so this is a purely cosmetic source-cleanup; runtime behavior is bit-identical.

### What it enables

- Eliminates an entire class of "barrel-only" orphan in `src/channels/`. Future contributors looking at the directory see exactly the channels that are wired.
- Removes ambiguity about whether `OneShotChannel` is "almost wired" (it isn't — same status as `CLIChannel`).
- Tightens the architectural rule that exports in this repo follow real consumers, not speculative APIs.

### What it forbids

- The "barrel as registry" idiom in `src/channels/`. If a future channel ships, callers import it directly (matching the existing pattern for `WebSocketChannel` and `TelegramChannel`).
- Future re-introduction of `OneShotChannel`/`CLIChannel` without a concrete in-repo caller in the same change.

### Cross-link to other Fxx

- Same dead-code pattern as **F02** (agent roster drift) and the broader "intent-only features" class referenced in [F35-cli-channel-orphan.md](../F35-cli-channel-orphan.md#related). Solving F35 at this depth establishes the precedent for those.
- No conflict with F31 (which is about base-agent prompt/doc mismatch despite the misleading cross-reference in the F35 issue file).

### Recommendation note

Same single-commit risk profile as Proposal A but removes three files and one extra orphan rather than one file and one re-export. Net code reduction is larger; complexity-of-change is essentially equal.

---

## Proposal C — Wire `saivage chat` and keep `CLIChannel`

### Sketch (deliberately not recommended)

Add a `chat [project-path]` Commander subcommand in [src/server/cli.ts](src/server/cli.ts) that constructs a `ChatAgent` against a `CLIChannel` using the same `resolveChatRoute(runtime)` + session-id machinery as [src/server/server.ts](src/server/server.ts#L672-L703), printing to stdout and reading from stdin.

### Why it is rejected

1. **YAGNI / guideline 2.** There is no requested user-facing feature, no test, no docs entry, no operator workflow that needs a stdio chat. WebSocket chat through the SPA covers the use case; Telegram covers ambient.
2. **`prompt()` orphan.** `CLIChannel.prompt()` ([src/channels/cli.ts](src/channels/cli.ts#L52-L55)) is outside the `ChatChannel` interface and no caller invokes it, indicating the original integration was never finished. Wiring would require either deleting `prompt()` or extending the interface — either way more churn than deletion.
3. **Cost vs. value.** The minimum viable wiring (Commander subcommand + agent construction + lifecycle/exit handling + at least one smoke test) is materially more change than Proposals A or B, for a feature no Fxx issue is asking for.
4. **Architecture-first.** Adding new entry points only to "rescue" dead code violates guideline 1. If the feature is genuinely wanted, file a fresh feature issue and design it independently; do not piggyback it on a dead-code cleanup.

This proposal exists to enumerate the alternative the issue itself names ("either we want a CLI channel… or we don't") and to demonstrate why "we don't" is the correct branch absent a concrete request.

---

## Recommendation

**Proposal B.**

Reasoning:

- Proposal A is correct but partial. The same audit that proves `CLIChannel` is dead simultaneously proves `OneShotChannel` and the barrel are dead. Closing F35 with A leaves a known-orphan surface in the same directory that the next reviewer will trip on.
- Proposal B costs no additional risk (the verification is the same grep), produces a strictly cleaner directory, and matches the project's "delete the old in the same change" guideline.
- Proposal C is the wrong shape for this issue and is recorded as rejected.

If the human orchestrator prefers minimal scope per issue, fall back to A and file a follow-up to remove `oneshot.ts` and the barrel; both proposals are listed with full file paths so either choice is directly executable.
