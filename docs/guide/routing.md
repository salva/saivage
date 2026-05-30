# Routing & Model Selection

Saivage ships a **`ModelRoutingResolver`** that lets you compose
re-usable routing **profiles**, attach them to roles, and constrain which
models or accounts may be used.

The routing schema lives in [`src/routing/resolver.ts`](https://github.com/salva/saivage/blob/main/src/routing/resolver.ts).

## Where it sits

The resolver is consulted **per LLM call**. Inputs:

- `ProjectConfig.routing`
- `RuntimeConfig.models` and `RuntimeConfig.providers`

Output: a `ResolvedModelRoute` describing which provider/model to call,
which account/auth profile to use, and an ordered list of preferred fallback
models.

## Project-level routing config

```jsonc
"routing": {
  "default_profile": "primary",

  "profiles": {
    "primary": {
      "model": "github-copilot/claude-sonnet-4",
      "preferred_models": [
        "github-copilot/claude-sonnet-4",
        "anthropic/claude-3-5-sonnet-20241022"
      ],
      "allowed_models": [
        "github-copilot/claude-sonnet-4",
        "github-copilot/gpt-5.4",
        "anthropic/claude-3-5-sonnet-20241022"
      ],
      "preferred_accounts": ["personal"]
    },
    "cheap": {
      "model": "github-copilot/gpt-4o-mini"
    }
  },

  "roles": {
    "planner":  "primary",
    "manager":  "primary",
    "coder":    { "profile": "cheap" },
    "researcher": { "profile": "cheap" },
    "chat":     { "model": "github-copilot/gpt-4o-mini" }
  }
}
```

### Rule fields

| Field | Description |
|-------|-------------|
| `profile` | Reference to a named profile in `profiles`. |
| `model` | Explicit `provider/model` or provider-independent model id. |
| `auth_profile` | Force a specific OAuth profile. |
| `account` | Bind to an account declared under `runtime.providers.<id>.accounts`. |
| `preferred_models` | Ordered fallback list. The router will try these in order before declaring failure. |
| `allowed_models` | Whitelist — anything not in this list will be rejected. |
| `preferred_accounts` / `allowed_accounts` | Same, for accounts. |

## Resolution algorithm

1. Look up the role rule (`roles[<role>]`, then `roles.default`). A bare
  string is a profile name if it matches `profiles`; otherwise it is a model
  id.
2. Merge the rule with its referenced profile chain. If there is no role rule,
  use `default_profile` when present.
3. If still missing fields, fall back to the role's runtime model key
  (`orchestrator`, `coder`, `researcher`, `data_agent`, `reviewer`,
  `designer`, `critic`, or `chat`), then `RuntimeConfig.models.default`.
4. Validate: refuse if model or account is not in the rule's allow-list.
5. Emit `ResolvedModelRoute` with `source` set to whichever level provided
   the final spec.

## Diagnostic output

The CLI lists the registered providers and their available models:

```bash
saivage models /path/to/project
```

Use it to confirm provider registration and model discovery before wiring those
model ids into `routing` or `models`.

## When to use what

- **Single solo project, one provider** → set `models.default` in
  `saivage.json` and leave project routing empty.
- **Multiple OAuth accounts or strict allow-lists** → switch to `routing`
  and use profiles.

The router itself (failover, retries, rate-limit awareness) is documented
in [Provider Router](/internals/providers/router).
