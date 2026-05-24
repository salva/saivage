# F27 — Design r1

## Proposal A — Focused: `oauth` section in `SaivageConfig` with shipped defaults

**Scope (files touched):**

- [src/config.ts](src/config.ts#L34-L113) — add `oauth` block to `configSchema`.
- [src/auth/anthropic.ts](src/auth/anthropic.ts) — drop the module-scope `CLIENT_ID` literal; resolve from config at the top of each flow function.
- [src/auth/openai-codex.ts](src/auth/openai-codex.ts) — same shape.
- [src/auth/github-copilot.ts](src/auth/github-copilot.ts) — same shape; drop the `atob(...)` indirection (obfuscation, not security).
- New: `src/auth/defaults.ts` — exports the three shipped default client ids as named constants. This is *not* a migration shim; it is the canonical home for the shipped defaults so the config schema can reference them via `.default(...)`.

**What gets added:**

```ts
// in configSchema
oauth: z
  .object({
    anthropic: z.object({ clientId: z.string().default(DEFAULT_ANTHROPIC_CLIENT_ID) }).default({}),
    openaiCodex: z.object({ clientId: z.string().default(DEFAULT_OPENAI_CODEX_CLIENT_ID) }).default({}),
    githubCopilot: z.object({ clientId: z.string().default(DEFAULT_GITHUB_COPILOT_CLIENT_ID) }).default({}),
  })
  .default({}),
```

Each flow function obtains its `client_id` via:

```ts
const { clientId } = loadConfig().oauth.anthropic;
```

inside `loginAnthropic` / `refreshAnthropicToken` (and the analogues). Because env-var interpolation already runs in `deepInterpolate` ([src/config.ts](src/config.ts#L150-L165)), an operator can set `"clientId": "${ANTHROPIC_OAUTH_CLIENT_ID}"` in `.saivage/saivage.json` without code changes.

**What gets removed:**

- The three `const CLIENT_ID = ...` module-scope declarations.
- The `atob("SXY...")` indirection in github-copilot.ts ([src/auth/github-copilot.ts](src/auth/github-copilot.ts#L15)); the value becomes a plain string in `src/auth/defaults.ts`.

**Risk:** very low. The runtime contract for `client_id` is purely "string passed to the provider's token endpoint". Adding a config-driven indirection cannot regress unless we typo a default; the new `src/auth/defaults.ts` is statically verified by the schema's `.default(...)` calls.

**What it enables:**

- Operators can rotate client ids without rebuilds.
- Forks can ship their own OAuth app without patching source.
- Cross-link to F11 (magic constants): same idiom of "value moves into `SaivageConfig` with shipped default".

**What it forbids:**

- No keeping the old module-level constants "as a fallback". `loadConfig()` is the single source of truth.
- No environment-variable side door bypassing the schema (env vars only flow through `${VAR}` interpolation that the schema already validates).

**Recommendation note:** keep the surface minimal. The only field genuinely worth making configurable today is `clientId`. Endpoint URLs (`AUTHORIZE_URL`, `TOKEN_URL`, etc.) are tied to the provider's identity — making them configurable is over-engineering until there is a concrete second consumer.

---

## Proposal B — Level-up: OAuth provider descriptor with parameterized flow runner

**Scope (files touched):**

- [src/auth/types.ts](src/auth/types.ts) — extend `OAuthProviderDef` (or add `OAuthProviderDescriptor`) with the endpoint/scope/callback fields that today are module-scope constants.
- [src/auth/anthropic.ts](src/auth/anthropic.ts), [src/auth/openai-codex.ts](src/auth/openai-codex.ts) — collapse the two near-identical PKCE flows into a shared `runPkceFlow(descriptor, callbacks)` helper in a new `src/auth/pkce-flow.ts`; each module reduces to a descriptor object + any provider-specific quirks (e.g. Codex's `id_token_add_organizations`, `originator=saivage` params and JWT claim parsing).
- [src/auth/github-copilot.ts](src/auth/github-copilot.ts) — separate descriptor (device-code, not PKCE); keep as its own flow runner since the contract is different.
- [src/config.ts](src/config.ts) — `oauth` section as in Proposal A.
- [src/auth/defaults.ts](src/auth/defaults.ts) — exports the three descriptors with their shipped defaults; schema references the `clientId` field of each.

**What gets added:**

- A single PKCE-flow function shared by Anthropic + OpenAI Codex (today these two files duplicate `createState`, `parseAuthorizationInput`, `startCallbackServer`, `exchangeCode`, `refreshAccessToken` with near-identical bodies).
- A descriptor-shaped type that lists every flow-relevant value (`clientId`, `authorizeUrl`, `tokenUrl`, `redirectUri`/`callbackPort`, `scopes`, `extraAuthorizeParams`).

**What gets removed:**

- All three module-scope `CLIENT_ID` literals.
- The duplicated PKCE callback-server code in `anthropic.ts` + `openai-codex.ts`.

**Risk:** medium. Touches the flow control logic of both PKCE providers in a single change. The OpenAI Codex flow has provider-specific extras (extra authorize params, JWT account-id extraction in `refreshOpenAICodexToken` at [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L235-L246)) that need clean extension points without re-introducing duplication.

**What it enables:**

- Adds the *structural* lever for F19 (provider barrel) — once OAuth descriptors are first-class, the three modules can be re-exported as data rather than function modules.
- Adds a future seam for fourth/fifth OAuth providers with minimal code.
- All endpoints become operator-overridable (useful for enterprise tenants with non-standard hosts).

**What it forbids:**

- No `if (descriptor.id === 'openai-codex')` switches inside the shared runner. Provider-specific behavior must be expressed via descriptor fields or descriptor-scoped hooks, not branched-on identity.
- No partial implementation that keeps one of the two PKCE files using the old shape "for now". Either both convert or neither does.

**Recommendation note:** the de-duplication is the same fix as F09 ("worker-agent helpers duplicated") and adjacent to F19. F27 is small ("low" severity, "module" transversality). Doing the de-dup *as part of F27* widens its blast radius beyond its severity. Better to keep F27 focused and let a dedicated finding own the de-dup.

---

## Proposal C — Static shipped JSON: `providers/oauth-config.json`

**Scope (files touched):**

- Add `src/auth/oauth-config.json` baked into `dist/` by `tsup`.
- Each auth module reads the JSON at startup (via `import oauthConfig from "./oauth-config.json" assert { type: "json" }`); operators override by placing a same-shape file at `.saivage/oauth-config.json`.

**What gets added:** a new on-disk config surface dedicated to OAuth.

**What gets removed:** the three module-scope `CLIENT_ID` literals.

**Risk:** introduces a second config path competing with `.saivage/saivage.json`. Operators now have to learn two config files. The schema validator for the new file is also a new surface (or, worse, missing).

**What it enables:** mechanical parity with the F27 source-note suggestion verbatim.

**What it forbids:** by construction, conflicts with the single-source-of-truth principle that `SaivageConfig` is the operator-editable surface.

**Recommendation note:** this is the option that the F27 evidence note offers as an alternative. After enumerating it, it is clearly inferior to A: a second JSON file with its own loader, override semantics, and validation duplicates infrastructure that `SaivageConfig` already provides. The "OAuth-specific" framing is not strong enough to warrant a separate file.

---

## Recommendation

**Proposal A.** Severity is low, transversality is module. Proposal A solves the stated problem with the smallest possible architectural surface, while reusing the env-var interpolation and schema validation that `SaivageConfig` already provides. It also leaves the door open for Proposal B's de-dup to land cleanly later under its own finding (the descriptor type can be introduced then; today the `oauth` schema only needs `clientId` per provider).

Proposal B is desirable de-duplication but belongs to a separate finding because (a) its risk profile exceeds F27's "low" severity and (b) it overlaps F19's scope. Proposal C is rejected: a second on-disk config file is strictly worse than the existing `saivage.json`.
