# F21 r1 — Design

Two proposals below. Both delete the duplicate `COPILOT_HEADERS` literal and the dead `ANTHROPIC_API_MODELS` Set. They differ in how the impersonation triple is sourced.

## Proposal A — Focused fix: single source of truth + config override

**Scope.** Touched files:

- [src/providers/copilot.ts](src/providers/copilot.ts) — remove local `COPILOT_HEADERS` const, import from new module; remove `ANTHROPIC_API_MODELS` Set; build effective headers from defaults + per-provider config at `setApiKey`.
- [src/auth/github-copilot.ts](src/auth/github-copilot.ts) — remove local `COPILOT_HEADERS` const and the 2 inline `"User-Agent": "GitHubCopilotChat/0.35.0"` strings; import the shared defaults; thread an optional headers override through `refreshGitHubCopilotToken` / `loginGitHubCopilot` / the `githubCopilotOAuthProvider.login`/`refreshToken` callbacks (or read it at the call site — see below).
- `src/providers/copilot-client-headers.ts` — new, ~30 lines: exports `DEFAULT_COPILOT_HEADERS` (the 5-entry triple-plus) and a `resolveCopilotHeaders(override?: Record<string,string>): Record<string,string>` helper that returns `{ ...DEFAULT_COPILOT_HEADERS, ...override }`. The auth-only entry points use the same helper but strip `Openai-Intent` if they need to (or just include it harmlessly).
- [src/routing/resolver.ts](src/routing/resolver.ts#L37-L56) — extend `runtimeProviderAccountSchema` with `headers: z.record(z.string(), z.string()).optional()`. This is the cleanest place because the schema is already the canonical provider-config shape and headers are conceptually per-account (an enterprise account may want a different `Editor-Version` than an individual account).
- [src/config.ts](src/config.ts#L51) — no change; it already records the schema, so the new field becomes part of `SaivageConfig.providers[...]`.
- [src/providers/copilot.test.ts](src/providers/copilot.test.ts) — add one test asserting `Editor-Version`/`User-Agent`/`Editor-Plugin-Version` are present on the issued request and that an override at construction time wins over the default. No change to the existing Authorization/X-Initiator assertions.

**Wiring.** The provider needs the override at the point where it constructs the SDK clients and the per-request `fetch` wrapper. Today `CopilotProvider.setApiKey` is called from the routing/auth layer; that same layer already has access to `runtimeProviderConfigSchema` data via `ModelRoutingResolver.getProviderConfig("github-copilot")`. The provider gains a second method `setHeaderOverrides(overrides?: Record<string,string>): void` (or accepts them as a second `setApiKey` arg — see the recommendation below) and rebuilds `openaiClient` / `anthropicClient` / `createCopilotFetch` with the merged headers.

For `src/auth/github-copilot.ts`, the device-code and token-exchange calls happen outside the provider's lifecycle (during OAuth login/refresh). Pass overrides explicitly through:

- `refreshGitHubCopilotToken(githubToken, options?: { enterpriseDomain?: string; headerOverrides?: Record<string,string> })`.
- `loginGitHubCopilot(callbacks, options?: { headerOverrides?: Record<string,string> })`.
- `githubCopilotOAuthProvider.login` / `refreshToken` — their `types.ts` `OAuthProviderDef` signature does not accept arbitrary options today; the caller (token store / auth manager) reads `SaivageConfig.providers["github-copilot"].headers` and wraps the provider def with a closure that captures overrides. This avoids polluting `OAuthProviderDef`.

**What gets added.**
- `DEFAULT_COPILOT_HEADERS` (single export).
- One new optional zod field `headers` on `runtimeProviderAccountSchema`.
- One new optional parameter on `CopilotProvider.setApiKey` (or a sibling setter).
- Two new optional params on the two `auth/github-copilot.ts` async exports.
- One new vitest assertion.

**What gets removed.**
- The two `COPILOT_HEADERS` const literals.
- The two inline `"User-Agent": "GitHubCopilotChat/0.35.0"` strings in `auth/github-copilot.ts`.
- The whole `ANTHROPIC_API_MODELS` Set; `isAnthropicModel` simplifies to `model.startsWith("claude-")`.

**Risk.** Low. The only behavioral change visible to the network is that an operator-set override can change outgoing headers, and the default is preserved byte-for-byte. The `OAuthProviderDef` interface stays unchanged (overrides are passed via captured closure, not by widening the interface).

**What it enables.** Operators can hotfix a Microsoft tightening by editing one JSON file. Also unblocks F32 (saivage-config undocumented blocks) — the new `headers` field will be documented as part of the per-provider schema.

**What it forbids.** No env-var fallback (`COPILOT_USER_AGENT` etc.). No per-call header injection. No header-by-header zod validation. No per-provider header subsystem for non-Copilot providers (the field is on the generic account schema, but only Copilot reads it; that's fine — adding the same plumbing for other providers is a separate change).

**Recommendation note.** This is the architecture-first fix. Headers belong with the provider that sends them; overrides belong in provider config. Done.

## Proposal B — One level up: auto-derive from the operator's installed VS Code / Copilot Chat

**Scope.** Everything from Proposal A, plus:

- `src/providers/copilot-client-detect.ts` — new, ~80 lines: at module load (or first `setApiKey`), best-effort probe of:
  1. `$VSCODE_VERSION` env (set by the LXC unit if the operator wants to pin).
  2. `~/.vscode/extensions/github.copilot-chat-*/package.json` — newest version directory wins.
  3. `~/.vscode-server/extensions/github.copilot-chat-*/package.json` for SSH/remote setups.
  4. `code --version` (first line) as a last resort.
  Returns `{ vscodeVersion?: string; copilotChatVersion?: string }`. Anything not found stays `undefined`.
- The merge order becomes: built-in baked defaults < auto-detected < operator config override.
- Detection runs once, memoized in a module-scoped variable. Filesystem reads are sync (only ~3 small JSON files, runs once at boot). No detection thread, no refresh.

**Scope.** Touched files: same as A plus the new `copilot-client-detect.ts` and one extra test (`copilot-client-detect.test.ts`) that fakes the home directory with `os.homedir` stubbing.

**Risk.** Medium. We now silently change request headers based on the operator's filesystem state. In CI / Docker images without VS Code installed, detection yields `undefined` and we fall back to baked defaults, so behavior matches Proposal A there. In a developer's local environment, an installed copilot-chat extension that is significantly newer than what the upstream proxy expects could theoretically push us over a different cliff (extension too new for whatever heuristic the proxy uses), but this is unlikely — Microsoft's check is "not too old", not "exactly this version".

**What it enables.** The runtime keeps working through Microsoft tightening as long as the host has a current VS Code + Copilot Chat installed, with zero operator action. This is the strongest hedge against the failure mode F21 actually warns about.

**What it forbids.** Network-based version discovery (probing `update.code.visualstudio.com`). Periodic refresh (one-shot at boot only). Cross-process detection (no IPC into a running VS Code).

**Recommendation note.** Real defense against the failure mode, but assumes the host filesystem layout. The Saivage runtime in production runs in `saivage-v3` / similar LXC containers where VS Code is *not* installed — so for the deployed runtime, Proposal B degenerates to Proposal A plus dead detection code. The win is real only on developer workstations and on hosts where the operator deliberately co-installs VS Code. Given Proposal A already covers the "operator can hotfix without rebuilding" requirement, Proposal B's marginal value over Proposal A is small in our actual deployment topology.

## Recommendation

**Proposal A.**

Rationale:

1. The substantive F21 ask is "operators must be able to bump without redeploying" — Proposal A delivers exactly that, by exposing `providers["github-copilot"].headers` in `saivage.json`.
2. Proposal B's auto-detection only adds value on hosts that have a VS Code install colocated with the Saivage runtime. The actual production deployments (`saivage-v3` LXC, GetRich v2 LXC) do not. So we'd be adding ~80 lines of filesystem-probe code plus tests for a benefit that exists almost exclusively on a developer workstation.
3. F11 (magic constants generally) is a sibling issue; Proposal A's "single header module + config field" pattern is the precedent F11 will likely reuse. Proposal B is a bespoke heuristic that doesn't generalize and would not be replicated for other providers.
4. The architecture-first guideline says: delete duplicates, expose one knob, no shims. Proposal A is the minimal architecturally correct shape. Proposal B layers a heuristic on top.

If the failure mode actually materializes in production and operator-side config edits prove too slow a response, Proposal B's detection module can be added as a follow-up without re-touching Proposal A's surface area.
