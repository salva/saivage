# G20 — Implementation plan r1 (Design A)

Companion to [01-analysis-r1.md](01-analysis-r1.md) and
[02-design-r1.md](02-design-r1.md). Implements Design A — delete the
three truly-dead concrete provider classes and their unit tests; leave
`OpenAIProvider` in place as the inheritance base for the live local-LLM
providers.

## Implementation steps

1. **Pre-flight: verify no hidden non-test importer has appeared.**
   Run from repo root [/home/salva/g/ml/saivage](../../../../):
   ```bash
   grep -rn "AnthropicProvider\|OpenAICodexProvider\|OpenRouterProvider" \
     src/ web/ deploy/ docs/ prompts/ --include="*.ts" --include="*.vue" --include="*.md" \
     | grep -v "\.test\.ts"
   ```
   Expected output: only the three class declarations
   ([src/providers/anthropic.ts](../../../../src/providers/anthropic.ts#L19),
   [src/providers/openai-codex.ts](../../../../src/providers/openai-codex.ts#L88),
   [src/providers/openrouter.ts](../../../../src/providers/openrouter.ts#L17))
   and possibly doc/spec mentions to be cleaned up in step 5. If any
   `src/` non-test file imports these names, **stop** and revise the
   design — the assumption that they are dead has regressed since
   2026-05-24.

2. **Delete `AnthropicProvider`.**
   - Remove [src/providers/anthropic.ts](../../../../src/providers/anthropic.ts).
   - Remove [src/providers/anthropic.test.ts](../../../../src/providers/anthropic.test.ts).

3. **Delete `OpenAICodexProvider`.**
   - Remove [src/providers/openai-codex.ts](../../../../src/providers/openai-codex.ts).
   - Remove [src/providers/openai-codex.test.ts](../../../../src/providers/openai-codex.test.ts).
   - Note: the `openai-codex` *provider name* stays alive — it is served by
     `PiAiProvider("openai-codex")` in
     [src/providers/router.ts](../../../../src/providers/router.ts#L770-L774). Do
     not touch that branch.

4. **Delete `OpenRouterProvider` and confirm the name is unreachable.**
   - Remove [src/providers/openrouter.ts](../../../../src/providers/openrouter.ts).
   - Remove [src/providers/openrouter.test.ts](../../../../src/providers/openrouter.test.ts).
   - Verify `createProvider`
     ([src/providers/router.ts](../../../../src/providers/router.ts#L741-L815)),
     `shouldRegisterProvider`
     ([src/providers/router.ts](../../../../src/providers/router.ts#L768-L789)),
     and `isProviderName`
     ([src/providers/router.ts](../../../../src/providers/router.ts#L897-L909))
     do not name `openrouter`. They currently do not; no edit required.
     If they did, remove the entry.

5. **Update the subsystem map.**
   - Edit the Providers row in
     [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L75-L101): remove the
     three deleted files from the "Key files" list and remove the three
     class names from the "Public surface" cell. `OpenAIProvider` stays
     (now described as the inheritance base for `OllamaProvider` /
     `LlamaCppProvider`).
   - Grep the round-2 spec tree for stale references:
     ```bash
     grep -rn "AnthropicProvider\|OpenAICodexProvider\|OpenRouterProvider" \
       SPEC/v2/ docs/
     ```
     Update any prose hit that references the deleted classes as if
     they were live.

6. **Update CHANGELOG entry.**
   - Add a line under the round-2 batch heading in
     [CHANGELOG.md](../../../../CHANGELOG.md) (or repo equivalent;
     verify path before editing): "G20: removed dead provider classes
     `AnthropicProvider`, `OpenAICodexProvider`, `OpenRouterProvider`
     (~700 LOC). Cloud-LLM routing already goes through `PiAiProvider`.
     Operator config using `models.<role>: \"openrouter/...\"` or a
     `providers.openrouter` block will now fail boot — switch to a
     PiAi-routed provider."

## Validation

Run from [/home/salva/g/ml/saivage](../../../../):

1. **TypeScript compile** — must succeed with zero errors:
   ```bash
   npx tsc --noEmit
   ```

2. **Unit tests** — must succeed with all suites green and three test
   files fewer than before:
   ```bash
   npm test -- --run
   ```
   Expected delta: `anthropic.test.ts`, `openai-codex.test.ts`,
   `openrouter.test.ts` no longer appear in the run report.
   `router.test.ts`, `pi-ai.test.ts`, `copilot.test.ts`,
   `ollama.test.ts`, `llamacpp.test.ts`, `openai.test.ts` all pass
   unchanged.

3. **Lint** — must pass:
   ```bash
   npx eslint .
   ```

4. **Build the runtime + web bundle**:
   ```bash
   npx tsup && (cd web && npm run build)
   ```
   Expected: clean build, `dist/cli.js` and `dist/web/` produced. The
   build artefacts are what the bind-mounted LXC containers run.

5. **Bootstrap smoke test against a real `saivage.json`** — verifies the
   `knownProviders` loop in
   [src/providers/router.ts](../../../../src/providers/router.ts#L99-L120)
   still constructs every needed provider without referencing deleted
   classes:
   ```bash
   node dist/cli.js --version
   ```
   Then on the `saivage-v3` LXC container (host `10.0.3.112`), after a
   service restart per the rollback section, confirm the container's
   `saivage.service` starts cleanly and `/health` returns 200.

## Rollback

In-tree:

- This change is a deletion of three source files and three test files
  plus a doc-only edit to the subsystem map. If `npx tsc` or `npm test`
  fails after step 2/3/4 inside a single working tree, revert that step
  with `git restore <file>` (paths above). Do **not** use
  `git reset --hard` — it would discard unrelated work.

After commit, if a regression is found post-deploy:

- Identify the offending commit (the G20 commit will touch only the
  files listed in "Implementation steps").
- **Operator-gated only**: prepare `git revert <sha>` for the G20
  commit and request human sign-off before running it. Do not
  auto-revert.
- After revert lands, rebuild and redeploy as below.

Running-daemon rollback (only if the regression breaks bootstrap on a
container the operator runs):

- The bind-mount layout is: host
  [/home/salva/g/ml/saivage](../../../../) → `/opt/saivage` on
  containers `saivage` (`10.0.3.111`), `diedrico` (`10.0.3.113`), and
  `saivage-v3` (`10.0.3.112`). All three run `saivage.service`. The
  container `saivage-v3-getrich-v2` (`10.0.3.170`) does **not**
  bind-mount this tree and is **unaffected** by this change.
- Sequence after a `git revert` lands on host:
  1. `cd /home/salva/g/ml/saivage && npx tsup && (cd web && npm run build)`
  2. For each of the three affected containers, restart the service via
     classic LXC: `sudo lxc-attach -n <container> -- systemctl restart saivage.service`
     where `<container>` ∈ `{saivage, diedrico, saivage-v3}`.
  3. Health-check each: `curl -fsS http://10.0.3.111:8080/health`,
     `http://10.0.3.112:8080/health`, `http://10.0.3.113:8080/health`.
- Do not edit container-local files; the only source of truth is the
  host bind-mount.

## Cross-finding coordination

- **[G21](../G21-router-provider-name-quadruple-duplication.md)** —
  This finding will unify the four hardcoded provider-name lists inside
  `router.ts` (the `knownProviders` array, the `createProvider` switch
  cases, the `shouldRegisterProvider` switch cases, and the
  `isProviderName` array). G20 leaves all four sites in place but
  removes the only class whose absence would have forced G21 to special-case
  `openrouter`. **Land G20 first**, then G21 immediately after on the
  reduced surface. G20 does not subsume G21.

- **[G22](../G22-router-dead-copilot-oauth-mapping.md)** — G22 removes
  the dead `copilot` → `github-copilot` entry in `PROVIDER_TO_OAUTH`
  ([src/providers/router.ts](../../../../src/providers/router.ts#L64-L69)).
  Independent of G20 mechanically, but conceptually the same theme of
  "router carries dead lookup tables". Safe to land in either order.
  G20 does not subsume G22.

- **[G26](../G26-resolver-legacy-source-tier.md)** — Routing-resolver
  dead `"legacy"` tier; independent subsystem, no coupling. Not subsumed
  by G20.

- **Deferred follow-up (Design B from [02-design-r1.md](02-design-r1.md))** —
  After G20+G21+G22 land, file a new round-2 finding (e.g. G20b) to
  rename or fold `OpenAIProvider` so it is no longer named after a
  cloud provider that no longer routes through it. Do not bundle into
  this plan.
