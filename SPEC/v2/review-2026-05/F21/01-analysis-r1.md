# F21 r1 — Analysis: Copilot adapter hardcodes vscode + extension version strings

## Problem restated

The GitHub Copilot integration sets a fixed set of impersonation headers identifying the client as a specific VS Code build running a specific copilot-chat extension version. The upstream `api.individual.githubcopilot.com` proxy is known to reject requests whose `Editor-Version` / `Editor-Plugin-Version` / `User-Agent` triple falls too far behind the current released VS Code + Copilot Chat pair. When (not if) Microsoft tightens that check, Saivage silently stops talking to Copilot until an operator rebuilds and redeploys the runtime.

Two concrete defects:

1. **Duplicated, drift-prone constant.** The same `COPILOT_HEADERS` literal exists in two places that can (and will) drift out of sync:
   - [src/providers/copilot.ts](src/providers/copilot.ts#L33-L39) — used for chat/completions, responses, and the `/models` discovery call.
   - [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L17-L22) — used for the GitHub-token-to-Copilot-token exchange.
   Plus two more inline copies of the User-Agent string at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L80) (device-code start) and [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L134) (access-token poll), which only set `User-Agent` and forget the rest.
2. **Hardcoded, non-overridable values.** Both copies pin `User-Agent: GitHubCopilotChat/0.35.0`, `Editor-Version: vscode/1.107.0`, `Editor-Plugin-Version: copilot-chat/0.35.0`. There is no `SaivageConfig` knob to update the triple without touching source.

A secondary but related defect noted by F21: the `ANTHROPIC_API_MODELS` allow-list at [src/providers/copilot.ts](src/providers/copilot.ts#L63-L70) is effectively dead code because [`isAnthropicModel`](src/providers/copilot.ts#L72-L74) short-circuits on `model.startsWith("claude-")` and every Set entry already starts with `claude-`. It encodes the same "redeploy to recognize a new Anthropic-on-Copilot model" anti-pattern and should be deleted in the same change (architecture-first, no backward compatibility).

## Actual differences (duplicates today)

`providers/copilot.ts` const vs `auth/github-copilot.ts` const:

```
                             providers/copilot.ts   auth/github-copilot.ts
User-Agent                   GitHubCopilotChat/0.35.0   (same)
Editor-Version               vscode/1.107.0             (same)
Editor-Plugin-Version        copilot-chat/0.35.0        (same)
Copilot-Integration-Id       vscode-chat                (same)
Openai-Intent                conversation-edits         ABSENT
```

So today's duplicates are 4-of-5 identical; the `auth` copy omits `Openai-Intent` (correctly, since the auth endpoints do not need it). The risk is not that today's values diverge — it is that the next bump touches only one file. The 2 inline `User-Agent: "GitHubCopilotChat/0.35.0"` strings at L80 and L134 make the divergence near-guaranteed.

## Contract

The Copilot proxy treats these headers as a soft client-attestation. Observed contract (from upstream behavior and the [pi-ai/OpenClaw](src/auth/github-copilot.ts#L1-L12) lineage referenced in the comment header):

- `User-Agent` — must look like `GitHubCopilotChat/<semver>`.
- `Editor-Version` — must look like `vscode/<semver>` (other editors accepted but tied to their plugin id).
- `Editor-Plugin-Version` — must look like `copilot-chat/<semver>` and be approximately consistent with `User-Agent`.
- `Copilot-Integration-Id` — stable string `vscode-chat` (also accepts other registered integrations, but Saivage is unconditionally pretending to be vscode-chat).
- `Openai-Intent` — chat-only signal; absent on auth endpoints.
- `Authorization` — `Bearer <copilot-token>`, set per-request in [createCopilotFetch](src/providers/copilot.ts#L102-L107). Must not coexist with `x-api-key`; the wrapper deletes that header.
- `X-Initiator` — `agent` or `user`, derived per request from [isAgentCall](src/providers/copilot.ts#L75-L94).

Failure mode when the impersonation triple is rejected: HTTP 400/401 with body referencing client version. We have no telemetry/alerting path for "Copilot rejected our client headers"; calls just start failing across every agent. Recovery requires editing source and redeploying.

## Call sites & dependencies

Inside `saivage`:

- [src/providers/copilot.ts](src/providers/copilot.ts#L142) — `defaultHeaders` on the OpenAI SDK client.
- [src/providers/copilot.ts](src/providers/copilot.ts#L149) — `defaultHeaders` on the Anthropic SDK client.
- [src/providers/copilot.ts](src/providers/copilot.ts#L102-L107) — `createCopilotFetch` overrides per-request headers with the same constant (so the SDK `defaultHeaders` setting is effectively redundant but still authoritative for the underlying `fetch`).
- [src/providers/copilot.ts](src/providers/copilot.ts#L193-L197) — `fetchModels` direct `fetch` of `/models` for capability discovery.
- [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L175-L181) — `refreshGitHubCopilotToken` exchange (`copilot_internal/v2/token`).
- [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L75-L88) — `startDeviceFlow` (only `User-Agent`, no other headers needed).
- [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L127-L139) — `pollForAccessToken` (only `User-Agent`).

Tests touching this surface:

- [src/providers/copilot.test.ts](src/providers/copilot.test.ts#L1-L42) — `vi.stubGlobal("fetch", ...)`, asserts Authorization / X-Initiator on the produced request but does **not** assert any of the version-pinned headers, so changing how those headers are populated does not break this test as long as the call still goes through.

Config surface:

- [src/config.ts](src/config.ts#L51) — `providers: z.record(z.string(), runtimeProviderConfigSchema).default({})`.
- [src/routing/resolver.ts](src/routing/resolver.ts#L37-L56) — `runtimeProviderAccountSchema` / `runtimeProviderConfigSchema`. This is the generic-per-provider config slot. There is no Copilot-specific shape today; whatever we add must compose with this schema.
- [src/config.test.ts](src/config.test.ts#L54-L55) — exercises `config.providers["github-copilot"]` access; whatever shape we pick must keep that path working.

## Constraints any solution must respect

1. **Architecture-first, no compatibility shim.** Delete the duplicate `COPILOT_HEADERS` literals and the dead `ANTHROPIC_API_MODELS` Set in the same change. No `@deprecated` aliases.
2. **Single source of truth** for the header set across `src/auth/github-copilot.ts` and `src/providers/copilot.ts`. The two inline `User-Agent` strings in `auth/github-copilot.ts` must also go.
3. **Operator-overridable without rebuilding.** The fix must allow an operator to bump `Editor-Version` / `Editor-Plugin-Version` / `User-Agent` by editing `.saivage/saivage.json` and restarting, with no source change. This is the substantive content of F21.
4. **No new system-boundary validation that isn't actually validating anything.** Headers are opaque key/value pairs at the HTTP layer; just merge config-provided headers on top of defaults. Do not introduce per-header zod constraints.
5. **Respect F15 / F11 boundaries.** F11 (magic constants generally) and F15 (OAuth token resolution overlap) are separate issues. The F21 fix should colocate Copilot-specific headers with the Copilot auth/provider code, not invent a generic project-wide "client identity" subsystem. F19 (provider barrel) is orthogonal.
6. **No code under `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/`** — out of scope per loop conventions.
7. **No new constants invented just for symmetry.** If the Anthropic SDK or OpenAI SDK do not need a separate config slot, do not add one.
8. **Existing test fixtures (`copilot.test.ts`) must keep passing** without being rewritten to know about config; the test uses a `vi.stubGlobal("fetch", ...)` and a constructor-time API key. Either the headers must continue to work with no config wired up (defaults), or the test must be updated to pass a header override — preferably the former, so defaults remain useful in unit-test contexts.
