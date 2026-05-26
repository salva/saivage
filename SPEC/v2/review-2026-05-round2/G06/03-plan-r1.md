# G06 — Implementation Plan (r1)

**Finding**: [../G06-stash-uses-sync-fs.md](../G06-stash-uses-sync-fs.md)
**Analysis**: [01-analysis-r1.md](./01-analysis-r1.md)
**Design**: [02-design-r1.md](./02-design-r1.md) — Proposal A (in-place async migration; defer the `LockedJsonFile<T>` extraction).
**Approved-precedent references**:
- [../../review-2026-05/F22/APPROVED.md](../../review-2026-05/F22/APPROVED.md)
- [../G30/APPROVED.md](../G30/APPROVED.md), [../G30/03-plan-r2.md](../G30/03-plan-r2.md)
- [../G36/APPROVED.md](../G36/APPROVED.md), [../G36/03-plan-r3.md](../G36/03-plan-r3.md)

## Sequenced steps

1. **Pre-flight.** Confirm `git status` is clean for [src/runtime/stash.ts](../../../../src/runtime/stash.ts), [src/agents/base.ts](../../../../src/agents/base.ts), [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts). Confirm [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts) exists on the working branch (landed by G30); if G30 has not yet merged, rebase G06 on top of it — do **not** re-implement the scanner.

2. **Rewrite [src/runtime/stash.ts](../../../../src/runtime/stash.ts) end-to-end.** Replace the file's contents with the final shape in [02-design-r1.md §"Final shape of `src/runtime/stash.ts`"](./02-design-r1.md). Concretely:
   - Replace [L5](../../../../src/runtime/stash.ts#L5) `import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";` with `import { mkdir, writeFile, readFile, readdir, stat, unlink } from "node:fs/promises";`.
   - Change `function ensureDir(): void` ([L16-L18](../../../../src/runtime/stash.ts#L16-L18)) to `async function ensureDir(): Promise<void>` with `await mkdir(stashDir(), { recursive: true });`.
   - Change `export function stashResult(content: string, toolName: string): string` ([L23](../../../../src/runtime/stash.ts#L23)) to `export async function stashResult(content: string, toolName: string): Promise<string>`. Body becomes `await ensureDir();` … `await writeFile(filepath, content, "utf-8");` (the `randomUUID`/filename/`log.info`/return lines are untouched).
   - Change `export function readStash(...)` ([L36](../../../../src/runtime/stash.ts#L36)) to `export async function readStash(...): Promise<...>`. Body: containment check is byte-identical (L41-L43), replace `readFileSync(filepath, "utf-8")` ([L46](../../../../src/runtime/stash.ts#L46)) with `await readFile(filepath, "utf-8")`. Slice/return shape unchanged.
   - Change `export function cleanStash(maxAgeMs = ...)` ([L57](../../../../src/runtime/stash.ts#L57)) to `export async function cleanStash(maxAgeMs = ...): Promise<number>`. Replace the sync `for` loop ([L64-L72](../../../../src/runtime/stash.ts#L62-L72)) with the `Promise.all`-over-`readdir`-entries shape from [02-design-r1.md](./02-design-r1.md). The `try { ... } catch { /* ignore */ }` around `stat`/`unlink` is preserved verbatim around the new `await stat` / `await unlink` calls. Sum the per-entry `1|0` returns; preserve the `log.info` and the `return removed;`.

3. **Migrate `src/agents/base.ts` — `maybeStash`.** At [src/agents/base.ts#L697](../../../../src/agents/base.ts#L697) change the signature from `private maybeStash(content: string, toolUseId: string): string` to `private async maybeStash(content: string, toolUseId: string): Promise<string>`. At [L704](../../../../src/agents/base.ts#L704) change `const path = stashResult(...)` to `const path = await stashResult(...)`. The `tokenBudget` / `countTokens` / early-`return content` block is untouched.

4. **Migrate `src/agents/base.ts` — `runLoop`'s tool-result builder.** At [src/agents/base.ts#L334-L342](../../../../src/agents/base.ts#L334-L342) replace:

   ```ts
   const resultBlocks: ContentBlock[] = dispatchResult.toolResults.map(
     (r) => ({
       type: "tool_result" as const,
       tool_use_id: r.toolUseId,
       content: this.maybeStash(r.content, r.toolUseId),
       is_error: r.isError,
     }),
   );
   ```

   with:

   ```ts
   const resultBlocks: ContentBlock[] = await Promise.all(
     dispatchResult.toolResults.map(async (r) => ({
       type: "tool_result" as const,
       tool_use_id: r.toolUseId,
       content: await this.maybeStash(r.content, r.toolUseId),
       is_error: r.isError,
     })),
   );
   ```

   The enclosing `async runLoop()` ([L229](../../../../src/agents/base.ts#L229)) is unchanged. Order is preserved by `Promise.all`. The `pushMessage({ role: "user", content: resultBlocks })` call immediately after is unchanged.

5. **Migrate `src/runtime/dispatcher.ts` — `read_stash` synthetic tool.** At [src/runtime/dispatcher.ts#L150](../../../../src/runtime/dispatcher.ts#L150) change `const result = readStash(args.path, args.offset ?? 0, args.length ?? 10_000);` to `const result = await readStash(args.path, args.offset ?? 0, args.length ?? 10_000);`. The enclosing `private async executeLocalTool(...)` ([L139](../../../../src/runtime/dispatcher.ts#L139)) is already `async`. No other dispatcher edit.

6. **Migrate `src/server/bootstrap.ts` — startup `cleanStash`.** At [src/server/bootstrap.ts#L204](../../../../src/server/bootstrap.ts#L204) change `cleanStash();` to `await cleanStash();`. The enclosing `export async function bootstrap(...)` ([L110](../../../../src/server/bootstrap.ts#L110)) is already `async`. No other bootstrap edit. The `// 9. Clean stale stash files` comment is untouched.

7. **Confirm no other callers exist.** Run `grep -rn "stashResult\|readStash\|cleanStash" src/ web/ --include='*.ts' --include='*.vue'` and verify the only matches are (a) the new `src/runtime/stash.ts` definitions, (b) the three caller edits in steps 3-6, and (c) the unrelated local-symbol `const readStash: Formatter` at [web/src/utils/toolFormatters.ts#L579](../../../../web/src/utils/toolFormatters.ts#L579) which is *not* an import from the runtime stash module. If any other call site exists (e.g. introduced concurrently by another branch), surface it before continuing.

8. **Add per-subsystem regression guard.** New file `src/runtime/no-sync-fs.test.ts`:

   ```ts
   import { describe, it, expect } from "vitest";
   import { scanForSyncFs } from "../testing/noSyncFsScanner.js";

   describe("src/runtime is sync-fs-free", () => {
     it("has no node:fs sync primitives or disallowed named imports", async () => {
       const violations = await scanForSyncFs({
         roots: ["src/runtime"],
         skipPathContains: [".test.ts", ".d.ts", "recovery.ts"],
       });
       expect(violations).toEqual([]);
     });
   });
   ```

   Do **not** re-implement the scanner. Do **not** copy it into `src/runtime/`. Import from `../testing/noSyncFsScanner.js` (the file produced by G30 — see [../G30/02-design-r2.md §"Reusable guard helper"](../G30/02-design-r2.md)). The `recovery.ts` carve-out follows the rationale in [01-analysis-r1.md §5](./01-analysis-r1.md) and the round-1 F22 notes — `recovery.ts` intentionally uses sync fs in exit-path handlers.

9. **Add round-trip test.** New file `src/runtime/stash.test.ts` with the four cases from [02-design-r1.md §"Round-trip test"](./02-design-r1.md). Use `vi.beforeEach` / `vi.afterEach` to set / clear `process.env.SAIVAGE_PROJECT_ROOT` to an `fs.mkdtemp`-created temp directory under `os.tmpdir()`; do not write to the repo's `.saivage/`. For case 4, import `utimes` from `node:fs/promises` to backdate the two files.

10. **Type-check, lint, and build.** Run, in order:
    - `npm run typecheck` (or `npx tsc --noEmit`) — expect zero errors. The `Promise<…>` signature changes cascade through `maybeStash` and `runLoop`; if any caller surfaces, fix it before continuing. There should be none beyond the three edited in steps 3-6.
    - `npm run lint` — expect zero new errors. The new `await Promise.all(...)` shape and the `Promise<number>` return on `cleanStash` introduce no lint regressions.
    - `npm run build` (tsup emits `dist/cli.js`).

11. **Test gate.** Run:
    - `npx vitest run src/runtime/stash.test.ts` — all 4 cases green.
    - `npx vitest run src/runtime/no-sync-fs.test.ts` — green (no violations).
    - `npx vitest run` — full suite green. Pay particular attention to existing `src/runtime/runtime.test.ts`, `src/runtime/compaction.test.ts`, `src/runtime/shutdown-handoff.test.ts`, `src/runtime/token-counting.test.ts` (no stash callers, but they share bootstrap fixtures).

## Validation

Use G30's shared scanner ([src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)) for the static check. Do **not** re-implement.

### Static — sync-fs eradication

```bash
cd /home/salva/g/ml/saivage
# Direct module check (zero match expected)
grep -nE "readFileSync|writeFileSync|mkdirSync|readdirSync|statSync|unlinkSync|openSync|closeSync|appendFileSync|copyFileSync|renameSync|rmSync|rmdirSync|accessSync|lstatSync|chmodSync|existsSync|symlinkSync|linkSync|realpathSync" src/runtime/stash.ts
# Expected: no output.

# Import check (zero match expected)
grep -nE '^import .* from "node:fs"' src/runtime/stash.ts
# Expected: no output.

# Run the new per-subsystem regression guard
npx vitest run src/runtime/no-sync-fs.test.ts
# Expected: 1 passed.
```

### Static — caller cascade

```bash
cd /home/salva/g/ml/saivage
grep -n "stashResult\|readStash\|cleanStash" src/agents/base.ts src/runtime/dispatcher.ts src/server/bootstrap.ts
# Expected:
#   src/agents/base.ts:36:  named import (unchanged)
#   src/agents/base.ts:339: await this.maybeStash(...)
#   src/agents/base.ts:704: await stashResult(...)   (inside async maybeStash)
#   src/runtime/dispatcher.ts:13:  named import (unchanged)
#   src/runtime/dispatcher.ts:150: await readStash(...)
#   src/server/bootstrap.ts:14:    named import (unchanged)
#   src/server/bootstrap.ts:204:   await cleanStash();
```

### Dynamic — unit & integration

```bash
cd /home/salva/g/ml/saivage
npx vitest run src/runtime/stash.test.ts src/runtime/no-sync-fs.test.ts
npx vitest run  # full suite
npm run typecheck && npm run lint && npm run build
```

### Live — v2 harness on `saivage-v3` container (10.0.3.112)

Follow the workspace-level `saivage-development-validation` skill ([../../../../../.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md)). Concretely:

```bash
# Restart the v2 harness on the host where the bind-mount picks up the new code
sudo lxc-attach -n saivage-v3 -- systemctl restart saivage.service
sleep 2
curl -fsS http://10.0.3.112:8080/health
# Expected: HTTP 200 with the usual JSON health body.

# Spot-check that cleanStash ran during bootstrap without freezing
sudo lxc-attach -n saivage-v3 -- journalctl -u saivage.service -n 50 --no-pager | grep -E "Cleaned|stash"
# Expected: at most one "Cleaned N stale stash files" log line; bootstrap completes within the usual window.

# Trigger a stash from a real LLM tool result by running a long command via the dashboard,
# then read it back via read_stash. Confirm no event-loop stall on /health during the write.
```

Do **not** run validation on the `saivage` (10.0.3.111) container until after the v2 harness on `saivage-v3` confirms healthy — `saivage` runs against the live GetRich project state.

## Rollback

Single-commit revert is the rollback. The change is internal to a single source file and three caller awaits + two new test files; no on-disk format change, no schema migration, no new dependencies.

```bash
cd /home/salva/g/ml/saivage
git revert <commit-sha>           # restores pre-G06 sync stash.ts and the three caller sites
npm run build
sudo lxc-attach -n saivage-v3 -- systemctl restart saivage.service
curl -fsS http://10.0.3.112:8080/health
```

Stash files written under the async version are byte-identical to those written under the sync version (same `utf-8` encoding, same filename scheme, same content). Reverting does not orphan or corrupt any on-disk stash; the sync `readFileSync` reads them back unchanged.

If only the test additions are problematic (e.g. CI flake), revert those independently:

```bash
git rm src/runtime/no-sync-fs.test.ts src/runtime/stash.test.ts
git commit -m "G06: revert test additions only"
```

The production change (the async migration) stays in place.

## Cross-finding coordination

- **G30 ([../G30/APPROVED.md](../G30/APPROVED.md))** — owns [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts). G06 consumes it via `src/runtime/no-sync-fs.test.ts`; the call signature `{ roots, skipPathContains, allowedNamedImports? }` is sufficient. **No scanner change requested by G06.** If G30 has not landed when G06 is ready, rebase G06 on top of G30 — do not vendor a copy of the scanner.
- **G36 ([../G36/APPROVED.md](../G36/APPROVED.md))** — chose in-place for `src/auth/store.ts` with a locked RMW helper. G06 reuses the precedent (in-place) and the rationale for *not* extracting a `LockedJsonFile<T>` primitive here (see [02-design-r1.md §"Proposal B"](./02-design-r1.md) and G36's own deferred note at [../G36/02-design-r1.md L322-L332](../G36/02-design-r1.md)). **No code-level coordination with G36 required** — disjoint modules.
- **G37** — sibling sync-fs finding (config). G06's regression test scans `src/runtime/` only; G37 will add its own `src/<config-subsystem>/no-sync-fs.test.ts` using the same scanner. No collision.
- **Workspace-wide guard** — out of scope for G06. After G37 settles, a follow-up finding can compose the same scanner with `roots: ["src"]` and an empirical allow-list. G06 does not pre-empt that work and does not add the workspace-wide test.
- **Shared scanner contract** — G06 commits to using the existing scanner verbatim. If a future finding needs an additional `allowedNamedImports` entry, that finding owns the scanner-signature extension; G06 does not.

## Daemon impact and deploy order

Per [01-analysis-r1.md §8](./01-analysis-r1.md):

1. Build on host → run unit tests → run the scanner test.
2. `sudo lxc-attach -n saivage-v3 -- systemctl restart saivage.service` → `curl /health` on 10.0.3.112.
3. If green, repeat for `diedrico` (10.0.3.113) and then `saivage` (10.0.3.111).
4. `saivage-v3-getrich-v2` (10.0.3.170) — **skip**, runs v3.

No state mutation in `.saivage/` is required by this change; the existing `<saivageDir>/tmp/stash/` directory continues to be used with the same filenames and same UTF-8 content.
