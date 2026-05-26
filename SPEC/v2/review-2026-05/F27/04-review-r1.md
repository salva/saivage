# F27 — Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F27-oauth-client-ids-in-source.md](SPEC/v2/review-2026-05/F27-oauth-client-ids-in-source.md)
- [SPEC/v2/review-2026-05/F27/01-analysis-r1.md](SPEC/v2/review-2026-05/F27/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F27/02-design-r1.md](SPEC/v2/review-2026-05/F27/02-design-r1.md)
- [SPEC/v2/review-2026-05/F27/03-plan-r1.md](SPEC/v2/review-2026-05/F27/03-plan-r1.md)

## Findings

### Analysis

The analysis correctly identifies the three provider-local OAuth client-id literals and their concrete use sites. Spot checks match the current source: Anthropic declares and uses the id at [src/auth/anthropic.ts](src/auth/anthropic.ts#L13), [src/auth/anthropic.ts](src/auth/anthropic.ts#L57), [src/auth/anthropic.ts](src/auth/anthropic.ts#L88), and [src/auth/anthropic.ts](src/auth/anthropic.ts#L170); OpenAI Codex at [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L12), [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L66), [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L97), and [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L179); GitHub Copilot at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L15), [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L83), and [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L137).

The scope boundary is also sound. The `oauthToProviderName` concern is real at [src/auth/store.ts](src/auth/store.ts#L154-L158), but it is correctly assigned to F15 rather than folded into this low-severity client-id configurability issue. The analysis accurately notes that [src/config.ts](src/config.ts#L34-L113) has no OAuth/auth section today and that env interpolation already runs before schema parsing at [src/config.ts](src/config.ts#L157-L165).

### Design

Proposal A is the right recommendation for this finding. Moving the shipped defaults into a tiny `src/auth/defaults.ts` and exposing schema-typed `oauth.<provider>.clientId` values solves the operator rebuild problem without conflating OAuth login configuration with runtime provider routing. Keeping the default ids in source as shipped defaults is not a backward-compatibility shim; the new single source of truth at runtime is `loadConfig().oauth...clientId`.

Proposal B is a valid future direction but correctly rejected for this issue because it expands into PKCE de-duplication and provider descriptors. Proposal C is also properly rejected because it creates a second operator config surface instead of reusing `.saivage/saivage.json`.

### Plan

The edit plan is concrete and executable. Importing constants from `./auth/defaults.js` in [src/config.ts](src/config.ts) does not create a problematic cycle because the new defaults module is data-only, while the auth flow modules can safely import `loadConfig` from [src/config.ts](src/config.ts). The proposed auth edits preserve the existing provider contracts and leave [src/auth/store.ts](src/auth/store.ts), [src/auth/types.ts](src/auth/types.ts), and [src/auth/pkce.ts](src/auth/pkce.ts) untouched, which matches the stated scope.

The test strategy is adequate. Existing config tests already use `loadConfig(true, projectRoot)` with temporary `.saivage/saivage.json` fixtures in [src/config.test.ts](src/config.test.ts#L28-L54), so the new defaults/override/interpolation cases are straightforward. Minor implementation note: the "empty `.saivage/saivage.json`" default test should use no file or a JSON object (`{}`), not a zero-byte file, because `loadConfig` parses the file contents when it exists.

## Required changes

None.

## Strengths

- Clear separation between public OAuth client ids and actual OAuth refresh-token secret storage.
- Good architecture boundary between OAuth login config and provider routing config.
- Practical validation commands using the repo's Vitest/typecheck/build conventions.

VERDICT: APPROVED