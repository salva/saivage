# F32 — Plan (r2)

Plan for the recommended proposal: **Proposal B** (delete the schema mirror from `01-DATA-MODEL.md` § 1; delegate to `src/config.ts` + `docs/guide/config-runtime.md`).

## Changes from r1

- **Validation commands** (reviewer required change 1): removed `npm run docs:verify`. That script does not exist in [package.json](package.json#L12-L26) — the only docs scripts are `docs:api`, `docs:dev`, `docs:build`, `docs:preview`. r2 uses `npm run docs:build` as the link-resolution check and adds explicit manual `rg` checks for SPEC cross-links. The r1 sentence "the latter is the VitePress-aware version" was wrong about a script that did not exist; it is deleted.
- **`src/config.test.ts` wording** (reviewer required change 3): r1's test strategy listed `npx vitest run src/config.test.ts` under "schema-shape assertions". r2 reclassifies it as a loader/defaults smoke test and removes the schema-shape claim. The file actually covers `expandHome`, `loadConfig` defaults, and provider-account parsing only ([src/config.test.ts](src/config.test.ts#L17-L57)).
- **Promoted-doc repair** (reviewer required change 2): r1's Step 4 only required a "verify every top-level key still matches" pass against the schema. r2 adds an explicit substep to fix the current config-location mismatch in [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L9-L20) versus [src/config.ts](src/config.ts#L119-L146). This is now a required substep of Step 4, not deferred to a separate ticket — Proposal B makes the guide canonical, so the guide cannot ship wrong on day one.
- No other changes; Steps 1–3, ordering, rollback, and out-of-scope reminders are unchanged from r1.

## Cross-issue ordering

This plan must merge **after**:

- **F02** (agent-roster drift) — finalizes the `models.*` key list.
- **F04** (hardcoded default models) — changes which `models.*`, `security.injectionModel`, and `supervisor.model` are required vs optional.
- **F11** (magic constants → config) — adds `runtime.notes.volatileTtlMs`, `runtime.recoveryDelayMs`, `runtime.supervisor.forceCancelDelayMs`, and the new `mcp.*` block.
- **F33** (default-writer / schema parity) — reshapes `writeDefaultConfig`.

If F32 lands first, the prose in `docs/guide/config-runtime.md` (which Proposal B references) will be out of date relative to F02/F04/F11/F33 on day one; the SPEC pointer at the canonical schema would then point at a moving target with no transitional anchor. F32 must be the last of this group to merge.

Conversely, F32 must merge **before** any further SPEC ticket that claims to "document a new config block" — those tickets become invalid once Proposal B lands (new blocks are documented in the Zod schema, not in the SPEC).

## Ordered edit steps

### Step 1 — Rewrite `SPEC/v2/01-DATA-MODEL.md` § 1

Replace the entire current § 1 body (heading "Runtime Config" plus the `interface RuntimeConfig { … }` block, [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L7-L52)) with the pointer body specified in [02-design-r1.md § Proposal B](02-design-r1.md):

- New heading: ``## 1. Runtime Config (`SaivageConfig`)``.
- Four short paragraphs: path, canonical source, operator prose link, cross-cutting policy links.
- Cross-link targets:
  - `src/config.ts` — line-range link to the `configSchema` declaration. At write time this is [src/config.ts](src/config.ts#L34-L113); update the range if F11/F33 shifts it.
  - `docs/guide/config-runtime.md` — whole-file link.
  - `SPEC/v2/review-2026-05/F02-agent-roster-drift.md`, `F04-hardcoded-default-models.md`, `F11-magic-constants-not-in-config.md`, `F33-config-default-drift.md` — bare-issue references (do not deep-link into specific rounds; tickets may grow).

No edit to the table of contents — section 1 still exists at the same anchor.

### Step 2 — Update SPEC companion docs to use `SaivageConfig` consistently

Three one-token renames (`RuntimeConfig` → `SaivageConfig`):

- [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L196): `RuntimeConfig.providers[name].models[role]` → `SaivageConfig.providers[name].models[role]`.
- [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L688): "Runtime/provider config" sentence — change phrasing to ``Runtime config (`SaivageConfig`)`` and ensure it links to § 1 of `01-DATA-MODEL.md`.
- [SPEC/v2/04-RUNTIME-DETAILS.md](SPEC/v2/04-RUNTIME-DETAILS.md#L103): `RuntimeConfig` → `SaivageConfig` (single mention in the failover paragraph).
- [SPEC/v2/00-AGENT-SYSTEM.md](SPEC/v2/00-AGENT-SYSTEM.md#L489): `RuntimeConfig.providers[name].models[role]` → `SaivageConfig.providers[name].models[role]`.

Before editing, run `rg -n 'RuntimeConfig' SPEC/v2/` from the repo root and update *all* hits (the four above are the ones known at r1 write time; do not edit any hit inside `SPEC/v2/review-2026-05/` because those are historical review documents and must not be retconned).

### Step 3 — Add a one-line architecture note in § 2.3

In [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L186-L210) (§ 2.3 LLM Provider Router), append at the end of the "Responsibilities" list:

> The full `SaivageConfig` shape — including `security`, `supervisor`, `mcpServers`, and `runtime.continuousImprovement` — lives in `src/config.ts` and is referenced by [01-DATA-MODEL.md § 1](01-DATA-MODEL.md#L7).

This is the only place in `06-SYSTEM-DESIGN.md` where a reader naturally asks "what other top-level blocks does this file carry?", so the cross-link belongs here.

### Step 4 — Repair the promoted operator guide

Two substeps. Both edit [docs/guide/config-runtime.md](docs/guide/config-runtime.md); neither edits `src/`.

**Step 4a — Fix the config-location section.** Replace lines [9-20](docs/guide/config-runtime.md#L9-L20) (heading "## Location" plus the numbered list and the `::: tip` block) with prose that matches the actual code path in `configPath()` / `saivageDir()` / `resolveProjectRoot()` ([src/config.ts](src/config.ts#L119-L146)).

The replacement must say:

1. The runtime config path is `<saivageDir>/saivage.json`.
2. `<saivageDir>` is computed by `saivageDir()` ([src/config.ts](src/config.ts#L137-L142)) as follows:
   - If `SAIVAGE_ROOT` is set (and no explicit project root is passed), `saivageDir` is `${SAIVAGE_ROOT}` directly; the file is therefore `${SAIVAGE_ROOT}/saivage.json`.
   - Otherwise it is `<projectRoot>/.saivage`, where `projectRoot` is resolved by `resolveProjectRoot()` ([src/config.ts](src/config.ts#L119-L137)) in this precedence: `PROJECT_ROOT` env, `dirname(SAIVAGE_ROOT)` env, walking up from `process.cwd()` looking for a `.saivage/config.json` marker, falling back to `process.cwd()` itself.
3. There is **no `${HOME}/.saivage/saivage.json` fallback**. Delete that bullet entirely.
4. Rewrite the `::: tip` block to recommend `SAIVAGE_ROOT` for multi-project deployments and to drop the "`~/.saivage/saivage.json` is the natural multi-project location" sentence. The "natural" location for a multi-project deployment is whatever path the operator sets `SAIVAGE_ROOT` to; the daemon does not pick `${HOME}` on its own.

Keep the rest of the doc (every section from `## Default content` downward) unchanged in Step 4a. The block-level prose for `security`, `supervisor`, `mcpServers`, `notifications`, and `runtime.continuousImprovement` is already source-accurate (analysis r2 § "Promoted-doc current state").

**Step 4b — Verify top-level key parity.** Read [docs/guide/config-runtime.md](docs/guide/config-runtime.md) end-to-end against [src/config.ts](src/config.ts#L34-L113). Required outcome: every top-level key in `configSchema` appears in the prose doc and every key in the prose doc exists in `configSchema`. Two known mismatches expected to surface depending on which sibling tickets have landed:

- If **F04** landed: the prose doc currently shows `supervisor.model: "github-copilot/gpt-5.4"` and `security.injectionModel: "github-copilot/gpt-5.4"` as defaults. Per F04 those become required-when-enabled (no default). Update the prose doc example to omit the literal and add a one-sentence note: "Required when the corresponding subsystem is enabled; the daemon refuses to boot otherwise. See F04."
- If **F11** landed: the prose doc must gain `runtime.notes`, `runtime.recoveryDelayMs`, `runtime.supervisor.forceCancelDelayMs`, and a new `mcp` section. Mirror the keys from F11's plan (do not re-derive defaults).

If F04 or F11 have not yet landed, skip those substeps and leave a TODO in F32's merge commit message referencing the pending Fxx — but do not merge F32 before those tickets close (see "Cross-issue ordering"). Step 4a is unconditional and must happen regardless of F04/F11 status; the location mismatch is independent of those tickets.

### Step 5 — Save and lint

- `npm run typecheck` — no source changes, so this should pass unchanged. Run it anyway to catch accidental edits.
- `npm run docs:build` — runs `typedoc` + `sanitize-typedoc.mjs` + `vitepress build docs` (see [package.json](package.json#L23-L25)). Required to pass; the rewritten `## Location` section and any Step 4b changes must not break the VitePress build, and the doc's internal anchors must still resolve. There is **no `npm run docs:verify` script** in this repo; r1 was wrong to require it. The replacement is `npm run docs:build` plus the manual `rg` checks below.
- `rg -n 'RuntimeConfig' SPEC/v2/ | rg -v review-2026-05` — expect zero hits after Step 2.
- `rg -n '\${HOME}/\.saivage/saivage\.json' docs/guide/config-runtime.md` — expect zero hits after Step 4a.
- `rg -n '## 1\. Runtime Config' SPEC/v2/01-DATA-MODEL.md` — expect exactly one hit (the new pointer-section heading).
- `git diff --stat` — confirm only `SPEC/v2/01-DATA-MODEL.md`, the three companion SPEC files touched in Step 2/3, and `docs/guide/config-runtime.md` were changed. No `src/` edits, no test edits.

## Test strategy

F32 is a docs-only change; no production code is modified. The validation surface is:

1. **Type check**: `npm run typecheck` from `/home/salva/g/ml/saivage`. Expected: zero new errors. This catches accidental source edits.
2. **Build**: `npm run build`. Expected: identical `dist/` to pre-change build (modulo timestamps). Validates we did not touch `src/`.
3. **Docs build**: `npm run docs:build`. Expected: VitePress succeeds with no missing-anchor warnings for the edited sections.
4. **Existing tests as a safety net** — no Vitest run is strictly necessary because no `*.test.ts` is in scope. As a regression guard against accidental `src/config.ts` edits, run `npx vitest run src/config.test.ts`. This file covers `expandHome`, `loadConfig` defaults, and provider-account parsing ([src/config.test.ts](src/config.test.ts#L17-L57)); it does **not** assert schema-shape parity with the prose doc and is not promoted to that role by F32. r1 implied otherwise; r2 retracts that wording.
5. **Manual SPEC review**:
   - Open `SPEC/v2/01-DATA-MODEL.md` § 1 in the repo's preferred markdown previewer. Confirm the four cross-issue links (F02/F04/F11/F33) resolve to existing tickets.
   - Open `SPEC/v2/06-SYSTEM-DESIGN.md` § 2.3 and confirm the new link to `01-DATA-MODEL.md § 1` works.
   - `rg` checks as listed in Step 5.
6. **Manual doc parity** (Step 4b outcome): every `z.object({ … })` top-level key in `configSchema` appears in `docs/guide/config-runtime.md`. A grep-based smoke check:
   ```bash
   # From repo root
   rg -o '^\s+([a-zA-Z]+):\s*z\.' src/config.ts | sort -u  # schema keys
   rg -o '^### `([a-zA-Z]+)`' docs/guide/config-runtime.md | sort -u  # prose keys
   ```
   The two lists should be equal modulo a known short list of subkeys (the prose doc does not need a separate `###` for every nested field). Manual diff suffices; no automated test is built as part of F32 (an automated parity test belongs to F33).

No new tests are added. F32 is a documentation consolidation; the absence of a test is intentional and aligns with the project guideline against premature configurability (here: against premature automation of documentation parity).

## Validation commands

Run from `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npm run docs:build
npx vitest run src/config.test.ts                              # smoke test for loader/defaults
rg -n 'RuntimeConfig' SPEC/v2/ | rg -v review-2026-05          # expect: empty
rg -n '\${HOME}/\.saivage/saivage\.json' docs/guide/config-runtime.md  # expect: empty
rg -n '## 1\. Runtime Config' SPEC/v2/01-DATA-MODEL.md         # expect: one line
```

There is no `npm run docs:verify` in this repo ([package.json](package.json#L12-L26)); r1's requirement to run it is removed. If a future ticket adds a real VitePress dead-link checker as `docs:verify` or similar, it can be folded into this list — but F32 r2 must not block on a script that does not exist.

## Rollback strategy

Single commit, revert with `git revert`. No source changes, no schema changes, no on-disk format changes — rollback is content-only and cannot break a running daemon. If reviewer rejects Proposal B in favour of Proposal A, the revert + re-do is cheap.

## Out-of-scope reminders

- Do not edit `src/config.ts`. Any urge to "add a comment explaining the schema" is forbidden by project guideline #3. The Step 4a location fix edits the doc, not the code.
- Do not change the lookup precedence in `configPath()` / `saivageDir()` / `resolveProjectRoot()`. Step 4a aligns the *doc* with the code; it must not propose the inverse.
- Do not add a Zod-to-Markdown generator. That belongs to a separate ticket; F32 documents the *consolidation*, not the automation of it.
- Do not touch any file under `src/skills/`, `SPEC/v2/skills/`, or `SPEC/v2/skills-memory/`.
- Do not edit historical files under `SPEC/v2/review-2026-05/Fnn/` other than F32's own directory.
