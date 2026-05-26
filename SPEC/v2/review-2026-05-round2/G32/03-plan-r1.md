# G32 — Plan r1

**Finding**: [../G32-builtins-search-files-find-subprocess.md](../G32-builtins-search-files-find-subprocess.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

**Design**: [02-design-r1.md](02-design-r1.md)

**Writer**: Claude Opus 4.7 (round 1)

## 1. Pre-flight

1. Confirm G30 has merged: `git log --oneline | grep -i G30` should
   show the G30 implementation commit; the local
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) imports
   should already include `node:fs/promises` and not the eight sync
   helpers G30 deleted.
2. Re-anchor every line reference in
   [02-design-r1.md](02-design-r1.md) against the post-G30 file.
   The pre-G30 anchors used in the design are: L29 (subprocess
   imports), L39-L43 (module-level caps), L74-L80
   (`parseHttpUrl`-adjacent helpers), L262-L271 (`search_files`
   schema), L310-L327 (handler body), L918 (`execFileAsync` for
   git, must remain), L1077-L1080 (register-time wiring). Expect a
   small downward drift after G30's mkdir-hoist and `settled` flag
   edits.
3. Confirm G31's status. If merged, `parseNonNegativeInt` is
   already declared next to `parseOptionalTimeoutMs` at
   approximately
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L375);
   reuse it. If not, declare it locally next to the same site.
   Annotate the declaration with a `// G32: dedup once G31 lands`
   comment so the eventual cleanup is grep-able.
4. Run the existing test baseline and capture green:
   `pnpm vitest run src/mcp/builtins.test.ts src/mcp/fsGuard.test.ts
   src/mcp/no-sync-fs.test.ts`.

## 2. Sequencing

### 2.1 Hard prerequisites

- G30 (APPROVED, in flight) — async fs baseline.

### 2.2 Soft prerequisites

- G31's `parseNonNegativeInt` helper. If absent at merge time, G32
  declares it locally; G31's eventual PR removes the duplicate.
  See pre-flight step 3.

### 2.3 Disjoint co-edits in the same file

| Finding | Edit range in builtins.ts | Conflict surface with G32 |
|---|---|---|
| G33 web_search | ~L743-L770 | None |
| G34 fetch_url cap | ~L820-L860 | None substantive; possible rebase touch on `node:fs/promises` import line if G34 adds streaming I/O |
| G35 SECRET_ENV_PATTERNS | L416-L432 | None |

G32 may merge in any order with respect to G31/G33/G34/G35.

### 2.4 No daemon impact

`search_files` is a pure in-process MCP handler. No systemd unit,
no LXC container restart, no bind-mount change. The post-merge
build artefacts redeploy via the existing `saivage` /
`saivage-v3` / `diedrico` bind mounts; nothing G32-specific is
required beyond rebuilding `dist/` and restarting the harness for
the new bytes.

## 3. Implementation steps

Each step is an atomic edit verifiable by `grep` from the terminal
(not `read_file`), per the recorded VS Code stale-buffer guidance.

### Step 1 — Config schema

File: [src/config.ts](../../../../src/config.ts).

Inside the `mcp` block (pre-G30 anchor
[src/config.ts](../../../../src/config.ts#L137-L147)), append three
fields after `maxDownloadBytes` and before the closing `})`:

```ts
maxSearchResults: z.number().int().positive().default(1_000),
maxSearchDepth: z.number().int().positive().default(20),
maxSearchMs: z.number().int().positive().default(10_000),
```

Verify with: `grep -n 'maxSearchResults\|maxSearchDepth\|maxSearchMs'
src/config.ts` — expect three hits.

### Step 2 — Module-level caps

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

After the `MAX_DOWNLOAD_BYTES` declaration at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42), add:

```ts
let MAX_SEARCH_RESULTS = 1_000;
let MAX_SEARCH_DEPTH = 20;
let MAX_SEARCH_MS = 10_000;
```

Verify: `grep -n 'MAX_SEARCH_' src/mcp/builtins.ts` — expect six hits
(three declarations plus three uses introduced in step 5).

### Step 3 — Imports

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

In the `node:fs/promises` import line G30 introduced, append
`opendir` and `stat` (if not already present from G30/G31). Do **not**
remove `execFile`, `promisify`, or `execFileAsync` — they are still
used by the git handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L918).

Verify: `grep -n 'opendir' src/mcp/builtins.ts` — expect at least
one hit (the import) plus a use in step 5.

### Step 4 — Local helpers

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

After `parseHttpUrl` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L74-L80) add
`globToRegExp` exactly as listed in
[02-design-r1.md §3.4](02-design-r1.md). If `parseNonNegativeInt` is
not already declared (G31 not yet merged), declare it next to
`parseOptionalTimeoutMs` (pre-G30 anchor
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L375)) per
[02-design-r1.md §3.4](02-design-r1.md).

Verify: `grep -n 'function globToRegExp' src/mcp/builtins.ts` →
exactly one hit. `grep -c 'function parseNonNegativeInt'
src/mcp/builtins.ts` → exactly one (whether declared by G31 or G32).

### Step 5 — Schema and handler

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

Replace the `search_files` schema entry at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L262-L271)
with the block from [02-design-r1.md §3.3](02-design-r1.md).

Replace the `case "search_files":` body at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L310-L327)
with the block from [02-design-r1.md §3.4](02-design-r1.md).

Verify:

- `grep -n 'execFile.*"find"' src/mcp/builtins.ts` → zero hits.
- `grep -n 'truncated_reason' src/mcp/builtins.ts` → at least one hit.
- `grep -nc '"search_files"' src/mcp/builtins.ts` → 1 (the schema
  entry; the case-arm name is matched by `case "search_files":`
  separately).

### Step 6 — Wire config

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

Inside `registerBuiltinServices` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1080),
after `SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;` add:

```ts
MAX_SEARCH_RESULTS = mcpConfig.maxSearchResults;
MAX_SEARCH_DEPTH = mcpConfig.maxSearchDepth;
MAX_SEARCH_MS = mcpConfig.maxSearchMs;
```

Verify: `grep -n 'mcpConfig.maxSearch' src/mcp/builtins.ts` → three
hits.

## 4. Sibling-parity audit (after step 6)

Confirm the four caps are wired uniformly:

```bash
grep -n 'mcpConfig\.\(maxOutputBytes\|maxFetchChars\|maxDownloadBytes\|maxSearchResults\|maxSearchDepth\|maxSearchMs\|maxFileReadBytes\)' src/mcp/builtins.ts
```

Expect every line above `} // registerBuiltinServices` to live in a
single contiguous block. Drift (e.g. one cap wired outside the
block) is rejected at review.

## 5. Tests

File: [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).

Add a new `describe("search_files", () => { … })` block after the
filesystem block at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L68-L77).

### 5.1 Schema and tool-catalogue tests

- `search_files` appears in `runtime.getAllTools()` with the new
  schema (`max_results` optional, `directory`/`pattern` required).

### 5.2 Happy-path matches

For each case below, create the fixture under `projectRoot` and
assert the returned `files` (sorted, after `relative(projectRoot,
…)`) matches the expected set, `truncated === false`,
`truncated_reason === null`.

| Pattern | Fixture | Expected matches |
|---|---|---|
| `*.ts` | `a.ts`, `b.txt`, `src/c.ts` | `a.ts` |
| `**/*.ts` | same | `a.ts`, `src/c.ts` |
| `src/*.ts` | `a.ts`, `src/c.ts`, `src/sub/d.ts` | `src/c.ts` |
| `src/**/*.ts` | same | `src/c.ts`, `src/sub/d.ts` |
| `?.ts` | `a.ts`, `ab.ts` | `a.ts` |
| `[ab].ts` | `a.ts`, `b.ts`, `c.ts` | `a.ts`, `b.ts` |

### 5.3 Skip set

Create `node_modules/foo/bar.ts` and `.git/HEAD.ts` (synthetic);
assert `**/*.ts` does **not** return either path even when a
sibling `src/c.ts` is found.

### 5.4 Truncation envelope

- `truncated_reason: "results"`: create 5 matching files, call
  with `max_results: 3`, expect `files.length === 3, truncated:
  true, truncated_reason: "results"`.
- `truncated_reason: "depth"`: build a `a/b/c/d/e/.../leaf.ts`
  chain deeper than `MAX_SEARCH_DEPTH`. Use a test-local override
  via `loadConfig` override: set `mcp.maxSearchDepth: 2`, then
  build `a/b/c/leaf.ts` and search for `**/*.ts`. Expect leaf is
  **not** returned and `truncated_reason: "depth"`.
- `truncated_reason: "time"`: set `mcp.maxSearchMs: 1`, create a
  modest tree of 200 `*.ts` files, search for `**/*.ts`. Either
  the result is partial with `truncated_reason: "time"` or
  `truncated: false` if the host completes within 1 ms — but in
  CI on `saivage-v3` (10.0.3.112) the 1 ms budget is reliably
  hit; the test asserts `truncated === false || truncated_reason
  === "time"` (never `"results"` or `"depth"`).

### 5.5 Error envelope (G31-parity)

- Empty pattern → `INVALID_ARGUMENT` (caught from the runtime
  `Error` substring).
- `max_results: -1` → `INVALID_ARGUMENT`.
- Pattern `[abc` (unterminated class) → `INVALID_PATTERN`.
- `directory` is a file path → `NOT_A_DIRECTORY`.
- `directory` outside project root → `Path must stay inside` (the
  existing `resolvePath` error; unchanged behaviour).

### 5.6 Permission-denied subtree

`chmod(0)` a directory mid-tree (skip on Windows / when running as
root — detect via `process.getuid?.() === 0` and `it.skip`). Assert
sibling matches return, `truncated === false`. Restore mode in
`afterEach` to allow `rmSync` cleanup.

### 5.7 No-subprocess regression

Add a static-source assertion:

```ts
it("no longer shells out to find(1)", async () => {
  const src = await readFile(join(__dirname, "builtins.ts"), "utf-8");
  expect(src).not.toMatch(/execFile.*["']find["']/);
  expect(src).not.toMatch(/execFileAsync.*["']find["']/);
});
```

This lives next to the search_files tests, not in `no-sync-fs.test.ts`
(which is G30's scanner-based test). It is a focused regression
guard for G32 specifically.

## 6. Build and lint gates

```bash
pnpm tsc -p tsconfig.json
pnpm vitest run src/mcp/builtins.test.ts \
                src/mcp/no-sync-fs.test.ts \
                src/mcp/fsGuard.test.ts
pnpm vitest run                    # full suite, no skips
pnpm build                         # tsup -> dist/
```

All four must be green before merge. The full-suite run guards
against any consumer of the old `{ files }` shape that the analysis
missed.

## 7. Daemon redeploy

Pure in-process change. After `pnpm build` produces a new
`dist/cli.js`, the three bind-mounted harnesses pick up the new
bytes via service restart only:

```bash
ssh root@10.0.3.111 systemctl restart saivage.service
ssh root@10.0.3.112 systemctl restart saivage.service
ssh root@10.0.3.113 systemctl restart saivage.service
```

Health probe each (per workspace handoff):

```bash
for ip in 10.0.3.111 10.0.3.112 10.0.3.113; do
  curl -fsS http://$ip:8080/health || echo "FAIL $ip"
done
```

`saivage-v3-getrich-v2` (10.0.3.170) ships its own v3 binary;
unaffected by this change.

## 8. Rollback

The change is contained to one source file plus a config schema
addition. Rollback is `git revert <merge-sha>` followed by
`pnpm build` + the three harness restarts in §7. No on-disk state
migration is involved (config defaults backfill missing fields).

## 9. Exit criteria

1. `grep -n 'execFile.*"find"' src/mcp/builtins.ts` → zero hits.
2. New `search_files` tests all pass.
3. `no-sync-fs.test.ts` continues to pass (G30 invariant preserved).
4. The four `mcpConfig.max*` parameters are wired in a single
   contiguous block inside `registerBuiltinServices`.
5. Three harness health endpoints return 200 after restart.
6. Reviewer sign-off recorded as `APPROVED.md` per the workflow.
