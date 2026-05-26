# G06 — Design (r2)

**Finding**: [../G06-stash-uses-sync-fs.md](../G06-stash-uses-sync-fs.md)
**Analysis**: [01-analysis-r2.md](./01-analysis-r2.md)
**Approved-precedent references**:
- [../../review-2026-05/F22/APPROVED.md](../../review-2026-05/F22/APPROVED.md) — in-place for `src/store/documents.ts`.
- [../G30/APPROVED.md](../G30/APPROVED.md) — in-place for `src/mcp/builtins.ts`; produced [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts).
- [../G36/APPROVED.md](../G36/APPROVED.md) — in-place for `src/auth/store.ts` (with a locked RMW helper because auth is a single shared JSON file).

**r2 changes** (responding to [04-review-r1.md](./04-review-r1.md)):

1. **Caller migration table now requires trimming the base-agent import.** The r1 entry "Import unchanged" was wrong — [src/agents/base.ts#L36](../../../../src/agents/base.ts#L36) imports `stashResult, readStash, cleanStash` but only `stashResult` is used (verified by `grep`; `readStash` and `cleanStash` have zero in-file references). Leaving the import as-is violates the [eslint.config.js](../../../../eslint.config.js#L8-L15) `@typescript-eslint/no-unused-vars: "error"` rule, which is part of the plan's lint gate. The migration row now mandates `import { stashResult } from "../runtime/stash.js";`.
2. **Round-trip test fixture rewritten** to match the repo's actual env contract: import `beforeEach` / `afterEach` from `vitest` (they are not on `vi`); preserve and restore `PROJECT_ROOT` *and* `SAIVAGE_ROOT` (the only two env vars [src/config.ts#L199-L221](../../../../src/config.ts#L199-L221) reads — there is no `SAIVAGE_PROJECT_ROOT`); explicitly create `<tempDir>/.saivage` before the first stash call; assert returned paths live under `<tempDir>/.saivage/tmp/stash/`. The pattern mirrors [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L67) verbatim.

Two proposals. Both fully remove every sync-fs primitive from [src/runtime/stash.ts](../../../../src/runtime/stash.ts) and keep the on-disk format and filenames unchanged. They differ in how much surrounding structure moves with the fix.

---

## Proposal A — In-place `fs/promises` migration (RECOMMENDED)

### Idea

Rewrite [src/runtime/stash.ts](../../../../src/runtime/stash.ts) so every primitive comes from `node:fs/promises`. Make `stashResult`, `readStash`, `cleanStash`, and the internal `ensureDir` `async`. Propagate `await` through the three caller sites identified in [01-analysis-r2.md §3](./01-analysis-r2.md). Trim the unused stash names from [src/agents/base.ts#L36](../../../../src/agents/base.ts#L36) so the file no longer carries dead imports. Add a per-subsystem regression guard at `src/runtime/no-sync-fs.test.ts` that calls G30's shared scanner with `roots: ["src/runtime"]` and `skipPathContains: [".test.ts", ".d.ts", "recovery.ts"]`. Add a new round-trip test at `src/runtime/stash.test.ts`.

### Final shape of `src/runtime/stash.ts`

```ts
/**
 * Stash: saves large tool results to disk so the model can access them
 * selectively via read_stash, instead of blowing up the context window.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { saivageDir } from "../config.js";
import { log } from "../log.js";

function stashDir(): string {
  return join(saivageDir(), "tmp", "stash");
}

async function ensureDir(): Promise<void> {
  await mkdir(stashDir(), { recursive: true });
}

/** Save content to a stash file. Returns the absolute file path. */
export async function stashResult(content: string, toolName: string): Promise<string> {
  await ensureDir();
  const id = randomUUID().slice(0, 12);
  const filename = `${toolName}_${id}.txt`;
  const filepath = join(stashDir(), filename);
  await writeFile(filepath, content, "utf-8");
  log.info(`Stashed ${content.length} chars from tool "${toolName}" → ${filepath}`);
  return filepath;
}

/** Read a portion of a stashed file. */
export async function readStash(
  filepath: string,
  offset = 0,
  length = 10_000,
): Promise<{ content: string; totalSize: number; offset: number; length: number }> {
  const stashRoot = resolve(stashDir());
  const resolved = resolve(filepath);
  const rel = relative(stashRoot, resolved);
  if (rel.startsWith("..") || resolve(stashRoot, rel) !== resolved) {
    throw new Error(`read_stash only works on stashed files under ${stashRoot}`);
  }
  const full = await readFile(filepath, "utf-8");
  const chunk = full.slice(offset, offset + length);
  return { content: chunk, totalSize: full.length, offset, length: chunk.length };
}

/** Clean up stash files older than maxAgeMs (default 24h). Returns the count removed. */
export async function cleanStash(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  await ensureDir();
  const now = Date.now();
  const dir = stashDir();
  const entries = await readdir(dir);
  const results = await Promise.all(
    entries.map(async (f) => {
      const fp = join(dir, f);
      try {
        const st = await stat(fp);
        if (now - st.mtimeMs > maxAgeMs) {
          await unlink(fp);
          return 1;
        }
      } catch { /* ignore ENOENT / EACCES */ }
      return 0;
    }),
  );
  const removed = results.reduce((a, b) => a + b, 0);
  if (removed > 0) log.info(`Cleaned ${removed} stale stash files`);
  return removed;
}
```

Key shape choices (versus a minimal one-for-one swap):

1. **`cleanStash` uses `Promise.all` over the directory listing.** The old code's per-entry sync loop did N synchronous syscalls in series. The async version can fan out, bounded by Node's libuv default thread-pool size (4); on a stash with hundreds of files this trades one giant blocking burst for many small ticks of yielded event loop. `Promise.all` is safe here because each entry is an independent file with a unique name (UUID-generated) — there is no ordering or contention concern.
2. **Containment check unchanged.** [src/runtime/stash.ts#L41-L43](../../../../src/runtime/stash.ts#L41-L43) is byte-identical. The case-insensitive-FS edge case noted in [01-analysis-r2.md §6](./01-analysis-r2.md) is **not** in scope.
3. **Read-then-slice unchanged.** `readStash` still loads the whole file then slices. Switching to `open` + `read(buf, 0, length, offset)` is left for a follow-up to keep this diff mechanical and reviewable (also noted in [01-analysis-r2.md §6](./01-analysis-r2.md)).
4. **`ensureDir` becomes `async`.** It has two call sites (`stashResult` and `cleanStash`); both already need to `await` other primitives, so the cost is one extra `await` per call.

### Caller migration

| File | Edit | Concrete diff |
|---|---|---|
| [src/agents/base.ts](../../../../src/agents/base.ts#L36) | **Trim unused names from the stash import** (r2 fix). `readStash` and `cleanStash` are never used in this file — only `stashResult` is called (at [L704](../../../../src/agents/base.ts#L704)). Required by [eslint.config.js](../../../../eslint.config.js#L8-L15) `no-unused-vars: "error"`. | `import { stashResult, readStash, cleanStash } from "../runtime/stash.js";` → `import { stashResult } from "../runtime/stash.js";` |
| [src/agents/base.ts](../../../../src/agents/base.ts#L697-L711) | `private maybeStash` becomes `private async maybeStash(...): Promise<string>`. The `stashResult` call gains `await`. | One signature edit, one `await`. |
| [src/agents/base.ts](../../../../src/agents/base.ts#L334-L342) | The synchronous `.map(...)` building `resultBlocks` is replaced with `await Promise.all(toolResults.map(async (r) => ({ ..., content: await this.maybeStash(r.content, r.toolUseId), ... })))`. Order is preserved. | Mechanical. |
| [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L13) | Import unchanged (single name `readStash`, still used). | — |
| [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L150) | `readStash(...)` → `await readStash(...)`. The enclosing `executeLocalTool` is already `async`. | One `await`. |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L14) | Import unchanged (single name `cleanStash`, still used). | — |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L204) | `cleanStash();` → `await cleanStash();`. Enclosing `bootstrap` is already `async` ([L110](../../../../src/server/bootstrap.ts#L110)). | One `await`. |
| [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts#L579) | **Not touched.** Local name collision (`const readStash: Formatter`), unrelated to the runtime import. | — |

### Regression guard

New file `src/runtime/no-sync-fs.test.ts`:

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

Why `skipPathContains` includes `recovery.ts`: per the G06 finding text and round-1 F22 notes, [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts) intentionally uses sync primitives for its crash-recovery lockfile path (sync semantics are required there because the recovery routine runs in `process.once("exit")` handlers where the event loop is already shutting down). The scanner's `skipPathContains` parameter exists for exactly this kind of carve-out (signature documented in [../G30/02-design-r2.md](../G30/02-design-r2.md)). The default `allowedNamedImports: ["createWriteStream"]` from G30 is left untouched — `src/runtime/` never imports `createWriteStream`, but the default is harmless.

### Round-trip test (r2 fixture)

New file `src/runtime/stash.test.ts` covering four cases. The fixture mirrors [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L67) — the established repo pattern — and uses the two env vars that [src/config.ts#L199-L221](../../../../src/config.ts#L199-L221) actually reads:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stashResult, readStash, cleanStash } from "./stash.js";

describe("runtime/stash", () => {
  let projectRoot: string;
  let stashRoot: string;
  let previousProjectRoot: string | undefined;
  let previousSaivageRoot: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "saivage-stash-"));
    previousProjectRoot = process.env["PROJECT_ROOT"];
    previousSaivageRoot = process.env["SAIVAGE_ROOT"];
    process.env["PROJECT_ROOT"] = projectRoot;
    process.env["SAIVAGE_ROOT"] = join(projectRoot, ".saivage");
    mkdirSync(join(projectRoot, ".saivage"), { recursive: true });
    stashRoot = join(projectRoot, ".saivage", "tmp", "stash");
  });

  afterEach(() => {
    if (previousProjectRoot === undefined) delete process.env["PROJECT_ROOT"];
    else process.env["PROJECT_ROOT"] = previousProjectRoot;
    if (previousSaivageRoot === undefined) delete process.env["SAIVAGE_ROOT"];
    else process.env["SAIVAGE_ROOT"] = previousSaivageRoot;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("round-trips a small payload through stashResult + readStash", async () => {
    const path = await stashResult("hello world", "tool_T1");
    expect(path.startsWith(stashRoot)).toBe(true);          // asserts containment in temp root
    const r = await readStash(path);
    expect(r.content).toBe("hello world");
    expect(r.totalSize).toBe(11);
  });

  it("slices via offset/length", async () => {
    const content = "x".repeat(1024);
    const path = await stashResult(content, "tool_T2");
    expect(path.startsWith(stashRoot)).toBe(true);
    const r = await readStash(path, 100, 50);
    expect(r.content.length).toBe(50);
    expect(r.offset).toBe(100);
    expect(r.length).toBe(50);
    expect(r.totalSize).toBe(1024);
  });

  it("rejects paths outside the stash root", async () => {
    await expect(readStash("/etc/passwd")).rejects.toThrow(/read_stash only works on stashed files under/);
  });

  it("cleanStash removes only files older than maxAgeMs", async () => {
    const a = await stashResult("a", "tool_T3");
    const b = await stashResult("b", "tool_T3");
    const c = await stashResult("c", "tool_T3");
    expect(a.startsWith(stashRoot)).toBe(true);
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(a, past, past);
    await utimes(b, past, past);
    const removed = await cleanStash(60_000);
    expect(removed).toBe(2);
    const remaining = await readStash(c);
    expect(remaining.content).toBe("c");
  });
});
```

Notes:

- `beforeEach` / `afterEach` are imported from `vitest`. They are **not** properties on `vi` (the r1 design said `vi.beforeEach` — that would not compile).
- Both `PROJECT_ROOT` and `SAIVAGE_ROOT` are captured-and-restored. `SAIVAGE_ROOT` is the one that `saivageDir()` reads directly at [src/config.ts#L216-L220](../../../../src/config.ts#L216-L220); setting it alone is sufficient to redirect stash output, but setting both matches the established fixture pattern in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L67) and avoids surprising `resolveProjectRoot` users in any helper that subsequently runs in the test process.
- The temp `.saivage` directory is created up-front with `mkdirSync(..., { recursive: true })` so that `saivageDir()` returns a real directory; `ensureDir()` inside `stashResult` will create the `tmp/stash` subtree on demand.
- Each test asserts `path.startsWith(stashRoot)` to *prove* the fixture redirected writes into the temp tree — if the env-var capture ever regressed, this assertion would fail loudly rather than silently writing into the repo's `.saivage/`.
- No cross-process fixture needed (no locking).

### Public API impact

`stashResult`, `readStash`, `cleanStash` change from `T` to `Promise<T>`. The only consumers are the three call sites enumerated above; the change is mechanical and observable only as an `async` cascade through `maybeStash` → `runLoop`. The synthetic `read_stash` MCP tool surface (its name, input schema, and JSON-stringified result shape) is unchanged from the model's perspective.

### Deletion list

- [src/runtime/stash.ts#L5](../../../../src/runtime/stash.ts#L5) — the sync `node:fs` import (replaced wholesale).
- The synchronous body of `maybeStash` ([src/agents/base.ts#L697-L711](../../../../src/agents/base.ts#L697-L711)) — replaced by the async version. No shim, no overload.
- The dead `readStash, cleanStash` names from the [src/agents/base.ts#L36](../../../../src/agents/base.ts#L36) import (r2). No re-export, no compatibility alias.

No backward-compat layer. No re-export of the sync names from anywhere.

---

## Proposal B — Extract a shared `LockedJsonFile<T>` (or equivalent) primitive

### Idea

Take this opportunity to do the cross-module abstraction G36 r1 explicitly *deferred* ([../G36/02-design-r1.md L322-L332 / L367-L372](../G36/02-design-r1.md)): hoist the common shape of "JSON-on-disk file with atomic-write + read-modify-write under a lockfile" into a small primitive (call it `LockedJsonFile<T>`) used by `auth/store.ts` (G36), `runtime/stash.ts` (G06), and `runtime/notes.ts` and `runtime/runtime-state.ts` and `chat/localCommands.ts` as a future round-3 cleanup.

The primitive would look roughly like:

```ts
// src/store/lockedJsonFile.ts
export class LockedJsonFile<T> {
  constructor(opts: { path: string; defaultValue: () => T; mode?: number });
  read(): Promise<T>;
  mutate(fn: (current: T) => T | Promise<T>): Promise<T>;
  // Internally: lockfile via open(lockPath, "wx", 0o600); reload-under-lock;
  // atomic write via tmp+rename; PID/hostname stale-lock probe (same shape
  // as G36's writeProfilesAtomically/withProfilesLock/mutateProfiles trio).
}
```

`auth/store.ts`'s post-G36 `mutateProfiles` reduces to `authFile.mutate(s => ...)`. `runtime/stash.ts` would *not* use the locking surface — stash filenames are UUID-unique, so the `mutate` API is unused — but it could reuse the primitive's `writeBytes(path, content)` atomic-write helper. (The reduction in shared code is therefore small for stash specifically.)

### Why this would be useful (and why it isn't for G06)

In favour:

- One reviewed implementation of "atomic write" / "stale-lock reclaim" / "PID probe" instead of N copies across G06, G36, G37, and any future store. G36's r3 helpers (`writeProfilesAtomically`, `withProfilesLock`, `tryReclaimStaleLock`, `registerExitCleanup`) are non-trivial and already accept tightening.
- Forces the team to think about a stable lock-acquire backoff schedule, an exit-cleanup contract, and a single `*.tmp` naming convention.

Against, for G06 specifically:

1. **Stash has no shared-mutation pattern.** Each `stashResult` writes a new file with a UUID-derived name. There is no read-modify-write, no contention, no consumer that needs `mutate(fn)`. The only thing stash would consume from the primitive is its `writeBytes` half — i.e. roughly one `await writeFile(...)` call replaced by `await primitive.writeBytes(...)`. Negative net code, possibly, but trivial savings.
2. **Cross-module abstraction blocks the F22-class fix.** G06 is a regression of F22. The point of the round-2 finding is to *stop the bleed* on the event loop — every extra week the sync writes are in production the worse the user-visible dashboard freeze. Extracting a primitive that needs its own review cycle, its own test suite, and an integration sweep across `auth/store.ts` (already approved at G36 r3), `runtime/notes.ts`, and `runtime/runtime-state.ts` is a much larger PR with a much larger blast radius.
3. **G36 has already approved an in-place shape.** Pulling the helpers back out of `auth/store.ts` into a shared module *immediately* after G36 lands means re-reviewing `auth/store.ts` to confirm equivalence. That undoes the work of the G36 round-3 review. The right window for the extraction is *after* G37 settles, when all three concrete sites are in tree and the actual common surface is empirical, not speculative.
4. **G36's authors explicitly said "later".** The deferred-cleanup note at [../G36/02-design-r1.md L322-L332](../G36/02-design-r1.md) names a future round, not this finding. Pulling it forward unilaterally for G06 contradicts that decision.
5. **In-place matches every prior approved precedent.** F22, G30, G36 all picked the in-place shape. Proposal A here continues that pattern; Proposal B would be an outlier and would owe the reviewer an argument the prior approvals already declined.

### Files touched (if B were chosen)

- New `src/store/lockedJsonFile.ts` (~150 lines incl. tests).
- New `src/store/lockedJsonFile.test.ts` (cross-process + atomic-write + stale-lock cases — essentially a port of G36's r3 test file).
- `src/auth/store.ts` rewritten to delegate to the primitive (re-review).
- `src/runtime/stash.ts` rewritten as in Proposal A *plus* a thin call into the primitive's `writeBytes` helper.
- `src/runtime/notes.ts`, `src/runtime/runtime-state.ts`, `src/chat/localCommands.ts` — opportunistic migrations (or left alone, in which case the primitive has one consumer + one wishful-thinking consumer).
- Several new sync-fs scanner test files unchanged.

Blast radius is *substantially* larger than A. Risk is concentrated in `src/auth/`, which is the most security-sensitive path in the codebase.

---

## Recommendation

**Proposal A.** Same shape as F22, G30, G36. Fixes the F22 regression with the smallest possible diff (one file + three caller edits + two new test files; the base-agent import is additionally trimmed to satisfy the lint gate). Defers the cross-module `LockedJsonFile<T>` extraction to a dedicated cleanup finding *after* G37 lands, when the common surface across `auth/store.ts`, `runtime/stash.ts`, and the next sync-fs site (whichever it turns out to be) is concretely visible rather than speculative.

Recommendation against B is on three grounds in priority order:

1. **Stash specifically has no need for the lock surface.** UUID-unique filenames, no read-modify-write, no contention. The extraction's value for *stash* is approximately zero; it would be valuable for auth/notes/runtime-state, all of which are out of scope here.
2. **G36 explicitly deferred the extraction.** Pulling it forward here contradicts an approved design decision in a sibling finding.
3. **Blast radius and re-review cost.** Touching `src/auth/store.ts` to re-route through a new primitive immediately after G36's round-3 approval is a meaningful security-sensitive review burden for a finding whose stated goal is "stop the sync-fs regression."

## Cross-finding coordination

- **G30** — produces [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts). G06 *consumes* it via the new `src/runtime/no-sync-fs.test.ts`; the scanner's `roots`/`allowedNamedImports`/`skipPathContains` signature is sufficient (carve out `recovery.ts`). No scanner modification needed.
- **G36** — chose in-place for `src/auth/store.ts`; the precedent and the in-place vs extraction trade-off discussion in [../G36/02-design-r1.md L322-L356](../G36/02-design-r1.md) are reused here. No coordination required at code level — disjoint modules.
- **G37** — sibling sync-fs finding (config). G06's `src/runtime/no-sync-fs.test.ts` is independent of G37. If G37 lands first and the scanner signature evolves, G06's test call site adopts the same call shape. If G37 lands second, this guard is already in place.
- **Workspace-wide guard** — out of scope for G06; per [../G30/03-plan-r2.md](../G30/03-plan-r2.md) the workspace-wide scanner composition is deferred until G37 settles and the full allow-list is empirical.

## Daemon impact

`saivage` (10.0.3.111), `saivage-v3` (10.0.3.112), `diedrico` (10.0.3.113) — all bind-mount the host `/home/salva/g/ml/saivage` tree (see [../../../../../.github/copilot-instructions.md](../../../../../.github/copilot-instructions.md)). `saivage-v3-getrich-v2` (10.0.3.170) runs Saivage v3 and is unaffected. Deploy is a normal `saivage-development-validation` cycle; no on-disk format change.
