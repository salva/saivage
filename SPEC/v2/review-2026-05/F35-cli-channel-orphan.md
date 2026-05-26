# F35 — CLI channel exists but is never registered by any bootstrap path

**Category**: dead-code
**Severity**: low
**Transversality**: local

## Summary

`src/channels/cli.ts` implements a CLI chat channel (terminal stdin/stdout). No code path constructs it: `cli.ts` only exposes Commander subcommands (`init`, `serve`, `auth`, ...), and `bootstrap.ts` only wires the WebSocket and Telegram channels. The file compiles, exports, and tests would need to import it explicitly to exercise it — which they don't.

## Evidence

- The channel implementation: [src/channels/cli.ts](src/channels/cli.ts).
- The CLI entry has no `chat` subcommand: [src/server/cli.ts](src/server/cli.ts#L1-L200).
- Bootstrap registers only WS + Telegram in chat-channel paths: [src/server/bootstrap.ts](src/server/bootstrap.ts).
- WebSocket session construction in `server.ts` does not list `cli`: [src/server/server.ts](src/server/server.ts#L661-L704).

## Why this matters

Either we want a CLI channel (in which case it needs a `saivage chat` subcommand and integration with the bootstrap) or we don't (in which case the file is dead and should be removed). Carrying it as a phantom option misleads readers about what's wired up.

## Related

- F02 (roster drift — same pattern)
- F31 (intent-only features)
