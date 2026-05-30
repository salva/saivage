# G23 — Routing resolver silently truncates rule chains on profile cycles

**Subsystem**: routing
**Category**: short-sighted
**Severity**: medium
**Transversality**: module

## Summary

`mergeRuleChain` walks `extends`-style profile references through a
`visited` set and simply stops following the chain when it encounters a
node it has already seen. No warning is logged, no diagnostic is
returned to callers, and the resolved routing silently uses whichever
prefix of the chain was visited first. A misconfigured `extends` loop
therefore produces a deterministic but wrong route with zero feedback.

## Evidence (with line-linked refs)

- Cycle break with no logging or error: [src/routing/resolver.ts](src/routing/resolver.ts#L180-L195).
- Callers consume the chain as if it were complete:
  [src/routing/resolver.ts](src/routing/resolver.ts#L222-L260).

## Why this matters

Routing decides which provider/model handles every agent call;
mis-routing because of an undetected profile cycle is a latent
production bug that surfaces as "the wrong model is answering" rather
than as a configuration error. Without at least a `log.warn` and a
field in the resolution trace, operators cannot tell that their
`profiles.json` is broken.

## Rough remediation direction (one bullet "one conceptual level up")

- Detect cycles eagerly during profile load (graph validation step) and
  reject the config; in the resolver, treat a cycle as a hard error or
  surface it through the existing `RoutingTrace` so the chat UI shows
  the misconfiguration instead of hiding it.

## Cross-links

- Round 1: F12 (routing trace coverage), F18 (resolver fail-modes).
- G24 (resolver fail-open allow-list), G25 (resolver legacy source name).
