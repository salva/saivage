# G20 — Implementation plan r2 (Design A)

Companion to [01-analysis-r2.md](01-analysis-r2.md) and
[02-design-r2.md](02-design-r2.md). Revises
[03-plan-r1.md](03-plan-r1.md) to address
[04-review-r1.md](04-review-r1.md) findings 1 (test surgery), 4
(useless `--version` smoke), 5 (`types.test.ts` audit), and 6 (live
health checks for all three affected hosts).

Implements Design A — delete the three truly-dead concrete provider
classes plus their per-class unit tests, surgically prune the
dead-class `it` blocks from
[src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts),
swap the stale `openrouter` example in
[src/providers/types.test.ts](../../../../src/providers/types.test.ts#L11-L13),
and leave `OpenAIProvider` in place as the inheritance base for the
live local-LLM providers.

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
   and possibly doc/spec mentions to be cleaned up in step 6. If any
   `src/` non-test file imports these names, **stop** and revise the
   design — the assumption that they are dead has regressed since
   2026-05-24.

2. **Delete `AnthropicProvider`.**
   - Remove [src/providers/anthropic.ts](../../../../src/providers/anthropic.ts).
   - Remove [src/providers/anthropic.test.ts](../../../../src/providers/anthropic.test.ts).

3. **Delete `OpenAICodexProvider`.**
   - Remove [src/providers/openai-codex.ts](../../../../src/providers/openai-codex.ts).
   - Remove [src/providers/openai-codex.test.ts](../../../../src/providers/openai-codex.test.ts).
   - Note: the `openai-codex` *provider name* stays alive — it is
     served by `PiAiProvider("openai-codex")` in
     [src/providers/router.ts](../../../../src/providers/router.ts#L770-L774).
     Do not touch that branch.

4. **Delete `OpenRouterProvider` and confirm the name is unreachable.**
   - Remove [src/providers/openrouter.ts](../../../../src/providers/openrouter.ts).
   - Remove [src/providers/openrouter.test.ts](../../../../src/providers/openrouter.test.ts).
   - Verify `createProvider`
     ([src/providers/router.ts](../../../../src/providers/router.ts#L741-L815)),
     `shouldRegisterProvider`
     ([src/providers/router.ts](../../../../src/providers/router.ts#L768-L789)),
     and `isProviderName`
     ([src/providers/router.ts](../../../../src/providers/router.ts#L897-L909))
     do not name `openrouter`. They currently do not; no edit
     required. If they did, remove the entry.

5. **Surgically prune dead-class imports and `it` blocks from the live test file.**
   Edit [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts):
   - Remove the three imports at
     [L4-L6](../../../../src/providers/model-capabilities.test.ts#L4-L6):
     `OpenAICodexProvider`, `AnthropicProvider`, `OpenRouterProvider`.
     Keep the `OpenAIProvider` import at
     [L3](../../../../src/providers/model-capabilities.test.ts#L3) and
     all other imports.
   - Delete the three `it` blocks that construct the deleted classes:
     - `"OpenAICodexProvider table"` at
       [L53-L60](../../../../src/providers/model-capabilities.test.ts#L53-L60).
     - `"AnthropicProvider table"` at
       [L62-L76](../../../../src/providers/model-capabilities.test.ts#L62-L76).
     - `"OpenRouterProvider table (prefix sensitive)"` at
       [L78-L93](../../../../src/providers/model-capabilities.test.ts#L78-L93).
   - Keep the `"OpenAIProvider table"` `it` at
     [L44-L51](../../../../src/providers/model-capabilities.test.ts#L44-L51),
     the local-LLM `defaultContextWindow` cases at
     [L95-L114](../../../../src/providers/model-capabilities.test.ts#L95-L114),
     the `PiAiProvider` registry suite at
     [L117-L156](../../../../src/providers/model-capabilities.test.ts#L117-L156),
     and the `ModelRouter.getMaxContextTokens` suite at
     [L158-L200](../../../../src/providers/model-capabilities.test.ts#L158-L200).

6. **Swap the stale `openrouter` example in the live parser test.**
   Edit [src/providers/types.test.ts](../../../../src/providers/types.test.ts#L11-L13):
   - Replace the input literal `"openrouter/meta-llama/llama-3.3-70b"`
     with `"ollama/library/llama3.3:70b"` (or another live nested
     model spec).
   - Update the two assertions in the same block to match
     (`provider === "ollama"`, `model === "library/llama3.3:70b"`).
   - Keep the `it` name as "handles nested model IDs" (drop the
     `(openrouter)` parenthetical).
   - The parser at
     [src/providers/types.ts](../../../../src/providers/types.ts)
     does not validate provider names against the router registry, so
     the substitution is purely cosmetic to remove dead-provider
     vocabulary from the active test corpus.

7. **Update the subsystem map.**
   - Edit the Providers row in
     [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L75-L101): remove
     the three deleted files from the "Key files" list and remove
     `AnthropicProvider`, `OpenAICodexProvider`, and
     `OpenRouterProvider` from the "Public surface" cell.
     `OpenAIProvider` stays (now described as the inheritance base for
     `OllamaProvider` / `LlamaCppProvider`).
   - Grep the round-2 spec tree for stale references:
     ```bash
     grep -rn "AnthropicProvider\|OpenAICodexProvider\|OpenRouterProvider" \
       SPEC/v2/ docs/
     ```
     Update any prose hit that references the deleted classes as if
     they were live.

8. **Update CHANGELOG entry and record the two follow-up acceptance criteria.**
   - Add a line under the round-2 batch heading in
     [CHANGELOG.md](../../../../CHANGELOG.md) (or repo equivalent;
     verify path before editing): "G20: removed dead provider classes
     `AnthropicProvider`, `OpenAICodexProvider`, `OpenRouterProvider`
     (~700 LOC) and pruned their direct-class tests. Cloud-LLM
     routing already goes through `PiAiProvider`. Operator config
     using `models.<role>: \"openrouter/...\"` or a
     `providers.openrouter` block will now fail boot — switch to a
     PiAi-routed provider."
   - Append two follow-up commitments (per
     [02-design-r2.md](02-design-r2.md) "Follow-up acceptance
     criterion"):
     - **F-G20-RENAME**: rename or fold `OpenAIProvider` so the
       providers subsystem no longer exposes a class named after a
       cloud provider it does not implement (acceptance: zero
       `class OpenAIProvider` hits and zero
       `import.*OpenAIProvider` hits in `src/`).
     - **F-G20-OPENAI-PKG**: drop the `openai` npm dependency from
       [package.json](../../../../package.json) (acceptance: zero
       `from "openai"` hits in `src/`, dependency removed,
       [src/providers/copilot.ts](../../../../src/providers/copilot.ts)
       migrated to a fetch-based client).

## Validation

Run from [/home/salva/g/ml/saivage](../../../../):

1. **TypeScript compile** — must succeed with zero errors:
   ```bash
   npx tsc --noEmit
   ```

2. **Unit tests** — must succeed with all suites green, three test
   files fewer than before, and `model-capabilities.test.ts` /
   `types.test.ts` still present with their pruned/updated contents:
   ```bash
   npm test -- --run
   ```
   Expected delta: `anthropic.test.ts`, `openai-codex.test.ts`,
   `openrouter.test.ts` no longer appear in the run report.
   `model-capabilities.test.ts` and `types.test.ts` still run; the
   `"per-provider direct-class tables"` describe block now contains
   only the `OpenAIProvider` `it`, and `parseModelId` "nested model
   IDs" passes on the new example. `router.test.ts`, `pi-ai.test.ts`,
   `copilot.test.ts`, `ollama.test.ts`, `llamacpp.test.ts`,
   `openai.test.ts` all pass unchanged.

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

5. **ModelRouter construction smoke** — replaces the r1 `--version`
   smoke (Commander handles `--version` from
   [src/server/cli.ts](../../../../src/server/cli.ts#L11-L16) without
   invoking `bootstrap` or constructing `ModelRouter`). This step
   verifies the `knownProviders` loop at
   [src/providers/router.ts](../../../../src/providers/router.ts#L99-L120)
   still constructs every needed provider against a real
   `saivage.json` and that the deleted provider names are absent from
   the registered set:
   ```bash
   node -e '(async () => {
     const { loadConfig } = await import("./dist/config.js");
     const { ModelRouter } = await import("./dist/providers/router.js");
     process.env.PROJECT_ROOT = "/home/salva/g/ml/saivage-v3";
     process.env.SAIVAGE_ROOT = "/home/salva/g/ml/saivage-v3/.saivage";
     const cfg = loadConfig(true, "/home/salva/g/ml/saivage-v3");
     const r = new ModelRouter(cfg);
     const names = r.listProviders().sort();
     console.log(JSON.stringify(names));
     if (names.includes("openrouter")) { console.error("openrouter still registered"); process.exit(1); }
   })().catch(e => { console.error(e); process.exit(1); });'
   ```
   Expected: a JSON array of registered provider names that excludes
   `openrouter` and exits 0. The exact set depends on the
   `saivage-v3` config but must include the PiAi-routed cloud names
   (`anthropic`, `openai`, `openai-codex`, `opencode`) and any local
   providers the config enables. If `dist/` import paths differ from
   what `tsup` emits, adjust the two `import()` specifiers to the
   actual bundled module paths from `npx tsup` output.

   If the inline `node -e` block is awkward to embed in CI, the same
   assertion can run as a dedicated vitest case under
   [src/providers/router.test.ts](../../../../src/providers/router.test.ts)
   that constructs `new ModelRouter(loadConfig(true, "<fixture>"))`
   and asserts `listProviders()` does not contain `"openrouter"` and
   that `createProvider("openrouter", ...)` throws.

6. **Live daemon health checks** — per
   [04-review-r1.md](04-review-r1.md) finding 6, run after the host
   rebuild for every container that bind-mounts
   [/home/salva/g/ml/saivage](../../../../). All three services
   restart against the post-deletion build and must answer `/health`:
   ```bash
   for host in saivage diedrico saivage-v3; do
     sudo lxc-attach -n "$host" -- systemctl restart saivage.service
   done
   curl -fsS http://10.0.3.111:8080/health
   curl -fsS http://10.0.3.112:8080/health
   curl -fsS http://10.0.3.113:8080/health
   ```
   Expected: each `curl` returns HTTP 200 with a healthy body.
   `saivage-v3-getrich-v2` (`10.0.3.170`) is **not** probed — it does
   not bind-mount this tree (per the bind-mount table at
   [WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md)) and is
   unaffected.

   The container restarts are operator-gated — if the operator has
   not authorised redeploy, list the three probes as the required
   verification when the build is deployed and stop after step 5.

## Rollback

In-tree:

- This change is a deletion of three source files and three test
  files plus surgical edits to two live test files, a router
  enumeration verification, a subsystem-map edit, and a CHANGELOG
  entry. If `npx tsc` or `npm test` fails after step 2/3/4/5/6 inside
  a single working tree, revert that step with `git restore <file>`
  (paths above). Do **not** use `git reset --hard` — it would discard
  unrelated work.

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
  2. For each of the three affected containers, restart the service
     via classic LXC:
     `sudo lxc-attach -n <container> -- systemctl restart saivage.service`
     where `<container>` ∈ `{saivage, diedrico, saivage-v3}`.
  3. Health-check each:
     `curl -fsS http://10.0.3.111:8080/health`,
     `http://10.0.3.112:8080/health`,
     `http://10.0.3.113:8080/health`.
- Do not edit container-local files; the only source of truth is the
  host bind-mount.

## Cross-finding coordination

- **[G21](../G21-router-provider-name-quadruple-duplication.md)** —
  This finding will unify the four hardcoded provider-name lists
  inside `router.ts` (the `knownProviders` array, the `createProvider`
  switch cases, the `shouldRegisterProvider` switch cases, and the
  `isProviderName` array). G20 leaves all four sites in place but
  removes the only class whose absence would have forced G21 to
  special-case `openrouter`. **Land G20 first**, then G21 immediately
  after on the reduced surface. G20 does not subsume G21.

- **[G22](../G22-router-dead-copilot-oauth-mapping.md)** — G22 removes
  the dead `copilot` → `github-copilot` entry in `PROVIDER_TO_OAUTH`
  ([src/providers/router.ts](../../../../src/providers/router.ts#L64-L69)).
  Independent of G20 mechanically, but conceptually the same theme of
  "router carries dead lookup tables". Safe to land in either order.
  G20 does not subsume G22.

- **[G26](../G26-resolver-legacy-source-tier.md)** —
  Routing-resolver dead `"legacy"` tier; independent subsystem, no
  coupling. Not subsumed by G20.

- **F-G20-RENAME** (deferred follow-up, see
  [02-design-r2.md](02-design-r2.md)) — Rename or fold
  `OpenAIProvider` (Design B.1 or B.2). Must be filed as a new
  round-2 finding before G20's CHANGELOG entry is considered closed.

- **F-G20-OPENAI-PKG** (deferred follow-up, see
  [02-design-r2.md](02-design-r2.md)) — Drop the `openai` npm
  dependency from [package.json](../../../../package.json). Blocked
  on a Copilot provider refactor at
  [src/providers/copilot.ts](../../../../src/providers/copilot.ts#L214-L280).
  Must be filed as a new round-2 finding before G20's CHANGELOG entry
  is considered closed.
