# F32 — Plan (r1)

Plan for the recommended proposal: **Proposal B** (delete the schema mirror from `01-DATA-MODEL.md` § 1; delegate to `src/config.ts` + `docs/guide/config-runtime.md`).

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

- New heading: `## 1. Runtime Config (`SaivageConfig`)`.
- Four short paragraphs: path, canonical source, operator prose link, cross-cutting policy links.
- Cross-link targets:
  - `src/config.ts` — line-range link to the `configSchema` declaration. At write time this is [src/config.ts](src/config.ts#L34-L113); update the range if F11/F33 shifts it.
  - `docs/guide/config-runtime.md` — whole-file link.
  - `SPEC/v2/review-2026-05/F02-agent-roster-drift.md`, `F04-hardcoded-default-models.md`, `F11-magic-constants-not-in-config.md`, `F33-config-default-drift.md` — bare-issue references (do not deep-link into specific rounds; tickets may grow).

No edit to the table of contents — section 1 still exists at the same anchor.

### Step 2 — Update SPEC companion docs to use `SaivageConfig` consistently

Three one-token renames (`RuntimeConfig` → `SaivageConfig`):

- [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L196): `RuntimeConfig.providers[name].models[role]` → `SaivageConfig.providers[name].models[role]`.
- [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L688): "Runtime/provider config" sentence — change "Runtime/provider config" phrasing to "Runtime config (`SaivageConfig`)" and ensure it links to § 1 of `01-DATA-MODEL.md`.
- [SPEC/v2/04-RUNTIME-DETAILS.md](SPEC/v2/04-RUNTIME-DETAILS.md#L103): `RuntimeConfig` → `SaivageConfig` (single mention in the failover paragraph).
- [SPEC/v2/00-AGENT-SYSTEM.md](SPEC/v2/00-AGENT-SYSTEM.md#L489): `RuntimeConfig.providers[name].models[role]` → `SaivageConfig.providers[name].models[role]`.

Before editing, run `rg -n 'RuntimeConfig' SPEC/v2/` from the repo root and update *all* hits (the four above are the ones known at r1 write time; do not edit any hit inside `SPEC/v2/review-2026-05/` because those are historical review documents and must not be retconned).

### Step 3 — Add a one-line architecture note in § 2.3

In [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L186-L210) (§ 2.3 LLM Provider Router), append at the end of the "Responsibilities" list:

> The full `SaivageConfig` shape — including `security`, `supervisor`, `mcpServers`, and `runtime.continuousImprovement` — lives in `src/config.ts` and is referenced by [01-DATA-MODEL.md § 1](01-DATA-MODEL.md#L7).

This is the only place in `06-SYSTEM-DESIGN.md` where a reader naturally asks "what other top-level blocks does this file carry?", so the cross-link belongs here.

### Step 4 — Verify the prose doc still matches the schema

Read [docs/guide/config-runtime.md](docs/guide/config-runtime.md) end-to-end against [src/config.ts](src/config.ts#L34-L113). Required outcome: every top-level key in `configSchema` appears in the prose doc and every key in the prose doc exists in `configSchema`. Two known mismatches expected to surface depending on which sibling tickets have landed:

- If **F04** landed: the prose doc currently shows `supervisor.model: "github-copilot/gpt-5.4"` and `security.injectionModel: "github-copilot/gpt-5.4"` as defaults. Per F04 those become required-when-enabled (no default). Update the prose doc example to omit the literal and add a one-sentence note: "Required when the corresponding subsystem is enabled; the daemon refuses to boot otherwise. See F04."
- If **F11** landed: the prose doc must gain `runtime.notes`, `runtime.recoveryDelayMs`, `runtime.supervisor.forceCancelDelayMs`, and a new `mcp` section. Mirror the keys from F11's plan (do not re-derive defaults).

These are content edits to the prose doc, *not* SPEC edits, but they are part of F32 because Proposal B makes the prose doc the operator-facing source of truth. If F04 or F11 have not yet landed, skip these substeps and leave a TODO comment in F32's merge commit referencing the pending Fxx — but do not merge F32 before those tickets close (see "Cross-issue ordering").

### Step 5 — Save and lint

- `npm run typecheck` — no source changes, so this should pass unchanged. Run it anyway to catch accidental edits.
- `npm run docs:verify` — runs the VitePress dead-link checker. Required to pass; the new `[01-DATA-MODEL.md § 1](…)` link must resolve. If VitePress does not yet verify `SPEC/v2/` cross-links (it does not by default), at minimum run `npm run docs:build` and confirm no warnings about missing anchors in `docs/guide/config-runtime.md` (the doc whose links we may have touched in Step 4).
- `git diff --stat` and confirm the only edited files are the four SPEC files plus optionally `docs/guide/config-runtime.md`. No `src/` edits, no test edits.

## Test strategy

F32 is a docs-only change; no production code is modified. The validation surface is:

1. **Type check**: `npm run typecheck` from `/home/salva/g/ml/saivage`. Expected: zero new errors. This catches accidental source edits.
2. **Build**: `npm run build`. Expected: identical `dist/` to pre-change build (modulo timestamps). Validates we did not touch `src/`.
3. **Existing tests**: no Vitest run is strictly necessary — no `*.test.ts` is in scope. As a safety net run `npx vitest run src/config.test.ts` to confirm the schema-shape assertions still match (they should; the schema is untouched).
4. **Manual SPEC review**:
   - Open `SPEC/v2/01-DATA-MODEL.md` § 1 in the repo's preferred markdown previewer. Confirm the four cross-issue links (F02/F04/F11/F33) resolve to existing tickets.
   - Open `SPEC/v2/06-SYSTEM-DESIGN.md` § 2.3 and confirm the new link to `01-DATA-MODEL.md § 1` works.
   - `rg -n 'RuntimeConfig' SPEC/v2/ | grep -v review-2026-05` — expected to return zero hits after Step 2.
5. **Schema-vs-prose parity** (Step 4 outcome): every `z.object({ … })` top-level key in `configSchema` appears in `docs/guide/config-runtime.md`. A grep-based smoke check:
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
npx vitest run src/config.test.ts
rg -n 'RuntimeConfig' SPEC/v2/ | grep -v review-2026-05  # expect: empty
rg -n '## 1\. Runtime Config' SPEC/v2/01-DATA-MODEL.md   # expect: one line, new heading
```

If the repo grows a docs-link checker (e.g., `npm run docs:verify`), also run that. As of r1, `saivage` has `npm run docs:build` and `npm run docs:verify` (the latter is the VitePress-aware version).

## Rollback strategy

Single commit, revert with `git revert`. No source changes, no schema changes, no on-disk format changes — rollback is content-only and cannot break a running daemon. If reviewer rejects Proposal B in favour of Proposal A, the revert + re-do is cheap.

## Out-of-scope reminders

- Do not edit `src/config.ts`. Any urge to "add a comment explaining the schema" is forbidden by project guideline #3.
- Do not add a Zod-to-Markdown generator. That belongs to a separate ticket; F32 documents the *consolidation*, not the automation of it.
- Do not touch any file under `src/skills/`, `SPEC/v2/skills/`, or `SPEC/v2/skills-memory/`.
- Do not edit historical files under `SPEC/v2/review-2026-05/Fnn/` other than F32's own directory.
