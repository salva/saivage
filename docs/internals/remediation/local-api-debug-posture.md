# Local API and Debug Posture

## Problem

Saivage v2 is designed to run inside an isolated container where the HTTP API is
reachable only from the host. In that deployment model, mandatory API token auth
is unnecessary friction.

However, debug endpoints can still expose more internal state than needed. The
main concern is not remote internet exposure; it is accidental disclosure in
logs, screenshots, saved responses, or future deployments where the isolation
assumption changes.

## Options Considered

| Option | Pros | Cons |
| --- | --- | --- |
| Require token auth for all APIs | Strong generic web posture. | Overkill for current container-only deployment; adds operational friction. |
| Leave all endpoints unchanged | Simple. | Debug config endpoints may expose sensitive runtime/provider data. |
| Keep local-trust API and return only explicit safe payloads | Fits deployment model and reduces accidental exposure. | Does not protect against a broken container/network boundary. |

## Chosen Approach

Keep API token support optional. Do not make tokens mandatory for v2. Instead,
return explicit safe API payloads and document the container-local trust boundary
clearly.

## Design

- `/health` remains public.
- `/api/*` remains accessible without token when `SAIVAGE_API_TOKEN` is unset.
- If `SAIVAGE_API_TOKEN` is set, existing token behavior remains supported.
- Debug endpoints should not return raw runtime config.
- Provider/account/API-key/auth-profile fields should be omitted from API shapes
  unless there is a concrete UI need for a redacted display value.
- File browsing should continue hiding known secret-bearing files and should add
  explicit sensitive filenames/directories to the denylist.

Recommended endpoint changes:

- `/api/debug/state`: return runtime, plan, history, and safe project config;
  remove `saivage_config` entirely.
- `/api/config`: keep the curated response, but omit `authProfile` and
  `accountRef` from routing objects unless the UI has a concrete redacted-use
  case. If the dashboard currently displays these values, update the UI to use a
  safe display field or remove that display.
- `/api/providers`: provider names and model lists are not secrets by default,
  but the endpoint should not expose account refs, auth profile names, headers,
  base URLs containing credentials, or API keys.
- `/api/files`: expand hidden names beyond `auth-profiles.json` to explicit
  sensitive names such as `saivage.json`, `.env`, `.env.*`, `*.pem`, `*.key`,
  and known backup/secret directories. Avoid broad substring heuristics unless a
  specific filename pattern has proven useful. Apply the same hidden predicate to
  both listing and content endpoints so a known path cannot bypass listing hides.

## Execution Plan

1. Remove raw `saivage_config` from `/api/debug/state`.
2. Define explicit safe response shapes for `/api/debug/state` and `/api/config`
   instead of returning full config objects and redacting after the fact.
3. Review `/api/providers` and keep only non-sensitive provider/model metadata.
4. Expand the file-browser hidden predicate for known sensitive filenames and
   directories, and use it for both `/api/files` and `/api/files/content`.
5. Update docs to state that API token auth is optional because v2 assumes a
   container-local API boundary.
6. Add tests for safe response shapes and hidden file behavior.

## Validation

- `npm run typecheck`
- `npm test`
- Focused server tests proving raw provider API keys, auth profiles, account
  refs, and token-bearing files are not returned by debug/config/file endpoints.

## Risks

- Over-aggressive file hiding may make some operational files harder to inspect
  through the UI. Prefer hiding only clearly sensitive names and allow direct
  host inspection for trusted operators.
