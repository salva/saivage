# G12b - Review (Round 1)

Reviewer: GPT-5.5

Round 1 has the right architectural direction: delete the prompt-injection cop, delete the `security` routing role, delete the `prompt_injection_scan` payload field, and keep only structural data-tool boundaries. I agree that URL-scheme checks, byte caps, and project-root containment are not agent-behavior heuristics.

The proposal is not ready to approve because the edit set and regression net are still incomplete, and because the config behavior contradicts the project-wide no-backward-compatibility rule.

## Findings

1. **The plan misses live test fixtures that still construct `security` config.** E8 covers [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L23-L126), E7 covers [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L10-L261), and E9 covers [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L102-L120), but the live tree has additional stale `security` fixtures in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L325-L331), [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L24-L27), and [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L24-L34). After [src/config.ts](../../../../src/config.ts#L111-L117) removes the schema field, these fixtures either fail typecheck or force casts around a deleted shape. Add explicit edit steps for all remaining test config builders and make the acceptance grep cover them.

2. **The documentation cleanup is incomplete and the validation command is too narrow.** E11 deletes [docs/internals/security.md](../../../../docs/internals/security.md), removes the architecture row, and removes the VitePress sidebar item, but live docs also document the cop in [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md#L186-L195), [docs/internals/testing.md](../../../../docs/internals/testing.md#L35), and [docs/internals/source-tree.md](../../../../docs/internals/source-tree.md#L24). The server serves built VitePress output from [docs/.vitepress/dist](../../../../src/server/server.ts#L96-L116), while V3 only asks for `pnpm docs:api`; the actual package script is `npm run docs:build` and it is the one that rebuilds both typedoc and VitePress output ([package.json](../../../../package.json#L16-L22)). As written, V4's grep audit would still find stale cop docs outside docs/api.

3. **The new no-cop invariant does not pin down every residue it claims to pin down.** E10 does include the important never-landed R4 surface names `SecurityStatusRing`, `securityStatusRing`, and `/api/debug/security`, which is good. But the forbidden list omits `prompt-injection-cop`, `prompt_injection_scan`, `securityModel`, and the routing-table residue `security: "security"`. Those are all live residue classes today in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L13-L149), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L121-L235), and [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L7-L9). The invariant should share the same residue list as V4, or V4 should be promoted into a checked test, so the proof cannot diverge from the plan.

4. **The config story contradicts both itself and the no-migration rule.** The analysis says stale `security` blocks will be rejected, but the design says the top-level config remains non-strict and old `security` blocks are silently dropped. Current Zod behavior in [src/config.ts](../../../../src/config.ts#L53-L191) supports the silent-drop reading. That is not architecture-first deletion: an operator can keep a removed security block in a project-local runtime config and receive no boot error, even though the scanner is gone. If this project rule means no backward compatibility for old configs, the implementation plan should explicitly reject the removed `security` key, or else state that silent acceptance is an intentional exception and get it approved.

## Checks That Pass

- The proposed remaining boundary protections are non-heuristic: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L73-L79) enforces URL scheme structurally, [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L43-L44) holds config-driven size caps, and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L50-L58) keeps project-root containment.
- [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L139-L178) does not contain a prompt-injection gate; `McpRuntime.callTool` only dispatches in-process or external tools and propagates tool errors.
- I found no live `/api/debug/security` route in [src/server/server.ts](../../../../src/server/server.ts) and no Security tab in [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L1-L100). Round 1 is correct that the R4 dashboard surface did not land.
- Proposal B and Proposal C are correctly rejected; adding an `untrusted` label or a renamed static scanner would keep a decorative control surface instead of deleting the cop.

## Required Round 2 Changes

- Extend the edit set to every stale test fixture and every source doc that still mentions the cop or `security` config.
- Replace V3 with the repository's actual docs build path, or explicitly remove regenerated output from the artifact set if it is not tracked.
- Make the invariant test cover the full residue vocabulary: `PromptInjection`, `promptInjectionCop`, `prompt-injection-cop`, `scanUntrustedText`, `prompt_injection_scan`, `injectionScanner`, `injectionModel`, `maxScanLengthBytes`, `securityModel`, `security: "security"`, `SecurityStatusRing`, `securityStatusRing`, and `/api/debug/security`.
- Resolve the stale-config policy: either reject removed `security` config explicitly or document a user-approved exception to the no-backward-compatibility rule.

VERDICT: CHANGES_REQUESTED