# F35 — Analysis r1

## Problem restated

`src/channels/cli.ts` defines a `CLIChannel` implementing `ChatChannel` over `process.stdin` / `process.stdout`. The class is constructed nowhere. The only outgoing reference to the file is the re-export in the channels barrel:

- Channel implementation: [src/channels/cli.ts](src/channels/cli.ts#L1-L57).
- Barrel re-export: [src/channels/index.ts](src/channels/index.ts#L2).

Workspace grep for `CLIChannel` returns only its own definition plus that one re-export:

```
src/channels/cli.ts:7:export class CLIChannel implements ChatChannel {
src/channels/index.ts:2:export { CLIChannel } from "./cli.js";
```

The CLI entry never wires it (no `chat` subcommand): the registered Commander subcommands are `init`, `start`, `status`, `note`, `request-shutdown`, `inspect`, `models`, `serve`, `login`, `logout` — see [src/server/cli.ts](src/server/cli.ts#L33-L493). The WebSocket session in `server.ts` constructs a `WebSocketChannel`, not a CLI channel — [src/server/server.ts](src/server/server.ts#L672-L680). The Telegram bot constructs a `TelegramChannel` — [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L9). `src/server/bootstrap.ts` contains zero references to `Channel`/`channel` (verified by grep). There are no tests importing `CLIChannel`.

The summary line in the F35 issue file ("`bootstrap.ts` only wires the WebSocket and Telegram channels") is loose: bootstrap.ts wires neither directly; the wiring lives in `server.ts` (WS) and `telegram-bot.ts` (Telegram). The substantive claim — no code path constructs `CLIChannel` — holds.

## Surrounding orphan surface

While auditing importers, two adjacent orphans surfaced in the same directory. They are not the F35 issue, but any "level-up" solution naturally encounters them:

- **`src/channels/index.ts` (the barrel) is itself unused.** Every consumer imports the specific module it needs:
  - `import type { ChatChannel } from "../channels/types.js"` — [src/agents/chat.ts](src/agents/chat.ts#L16), [src/agents/agents.test.ts](src/agents/agents.test.ts#L17).
  - `import { TelegramChannel } from "../channels/telegram.js"` — [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L9).
  - `import { WebSocketChannel } from "../channels/websocket.js"` — [src/server/server.ts](src/server/server.ts#L26).
  - Grep for `from ".*/channels"` (no trailing path segment) returns no matches.
- **`src/channels/oneshot.ts` (`OneShotChannel`) is also unused.** Grep for `OneShotChannel` returns only its own definition plus the barrel re-export. No tests, no callers.

These are the same class of dead code as `cli.ts`. The level-up proposal in the design doc addresses them together; the focused proposal addresses only the F35 file.

## Contract

`CLIChannel` implements [src/channels/types.ts](src/channels/types.ts#L5-L18):

```
interface ChatChannel {
  send(message: string): void | Promise<void>;
  onMessage(handler: (message: string) => void | Promise<void>): void;
  onClose(handler: () => void): void;
  close(): void | Promise<void>;
}
```

Plus an extra `prompt()` method ([src/channels/cli.ts](src/channels/cli.ts#L52-L55)) not present on the interface and not consumed anywhere. The class owns a `readline.Interface` on `process.stdin`/`process.stdout`. There is no documented or implemented lifecycle integration with the existing chat agent path (chat sessions persist via `chatSessionId()` and are constructed inside the WebSocket handler in [src/server/server.ts](src/server/server.ts#L672-L703)); no comparable construction path exists for stdio.

## Call sites & dependencies

- Importers of `CLIChannel`: **none** (only the barrel re-export).
- Importers of the barrel `channels/index.ts`: **none**.
- Consumers of `ChatChannel`: `src/agents/chat.ts` (the abstract consumer) and the two live channel constructions cited above.
- Tests: `src/channels/telegram.test.ts` exists; no `cli.test.ts`, no `oneshot.test.ts`.

Nothing in `src/skills/`, `SPEC/v2/skills*/`, or the memory subsystem is involved — F35 is fully outside the out-of-scope zone defined in `_LOOP-CONVENTIONS.md`.

## Constraints any solution must respect

1. **Architecture-first, no backward compatibility.** Per mandatory guideline 1, leaving `cli.ts` in the tree under an `@deprecated` tag or behind a feature flag is forbidden. Either delete it or wire it up the same change.
2. **No new docstrings/comments on unmodified code.** Pure deletion is the cheapest compliant fix.
3. **Public API surface of `src/channels/*` is internal.** `package.json`'s `tsup.config.ts` and `package.json` `exports` field (verify before edit) determine whether the barrel is part of an external API; if it is, removing the barrel widens scope. Plan must verify this.
4. **No shared abstractions used only once.** If `CLIChannel` survives at all, it must have a concrete in-tree consumer in the same change.
5. **Boundary respect.** No changes under `src/skills/` or `SPEC/v2/skills*/`.
6. **Test coverage gap is non-existent** — removing dead code with no tests requires no test-deletion bookkeeping beyond the file itself.

## Decision-relevant question for design

Is there any near-term concrete use case for an interactive CLI chat (`saivage chat <project>`)? Issue file F35 explicitly states the binary choice: wire it, or remove it. Per the architecture-first guideline and the YAGNI default, the design proposes deletion unless a caller is specified.
