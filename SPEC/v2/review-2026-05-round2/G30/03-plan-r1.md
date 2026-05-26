# G30 — Implementation Plan (r1)

**Chosen design**: Proposal A — in-place async-fs migration of
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts), plus a
`src/mcp/`-scoped CI guard reusable by G06 / G36 / G37.

## Steps

1. **Verify no concurrent edit collides** — confirm `git status` is
   clean for `src/mcp/builtins.ts`,
   `src/mcp/builtins.test.ts`, and `src/mcp/fsGuard.test.ts`. If any
   of G06 / G36 / G37 has landed first, re-read their guard scope so
   the new `no-sync-fs.test.ts` does not double-cover the same glob.

2. **Rewrite the `node:fs` import block** at
   [src/mcp/builtins.ts#L15-L26](../../../../src/mcp/builtins.ts#L15-L26):
   - Keep `createWriteStream` from `node:fs` (streaming primitive, not
     sync).
   - Drop `closeSync`, `readFileSync`, `readSync`, `writeFileSync`,
     `readdirSync`, `mkdirSync`, `openSync`, `statSync`, and the unused
     `existsSync`.
   - Add `import { readFile, writeFile, mkdir, readdir, stat, open }
     from "node:fs/promises";`.

3. **Migrate `filesystem.read_file`** at
   [src/mcp/builtins.ts#L276](../../../../src/mcp/builtins.ts#L276):
   replace `readFileSync(fp, "utf-8")` with `await readFile(fp,
   "utf-8")`.

4. **Migrate `filesystem.write_file`** at
   [src/mcp/builtins.ts#L298-L299](../../../../src/mcp/builtins.ts#L298-L299):
   `await mkdir(dirname(fp), { recursive: true })` then
   `await writeFile(fp, args.content as string, "utf-8")`. Preserve
   the BLOCKED_PATH guard block above unchanged.

5. **Migrate `filesystem.list_dir`** at
   [src/mcp/builtins.ts#L304](../../../../src/mcp/builtins.ts#L304):
   `const entries = (await readdir(dp, { withFileTypes: true })).map(...)`.

6. **Migrate `runShellCommand` dir setup** at
   [src/mcp/builtins.ts#L443-L444](../../../../src/mcp/builtins.ts#L443-L444):
   `await mkdir(dirname(outputPaths.stdoutAbs), { recursive: true })`
   and the matching stderr line. These now run before `createWriteStream`
   is opened — both are awaited inside `runShellCommand` before the
   `new Promise` body returns, so the streams remain valid.

7. **Make `safeFileSize` async** at
   [src/mcp/builtins.ts#L609](../../../../src/mcp/builtins.ts#L609):
   `async function safeFileSize(path: string): Promise<number> { try {
   return (await stat(path)).size; } catch { return 0; } }`. Update its
   call sites:
   - `readFileTail` (next step) — already going async.
   - `runShellCommand` post-close handler at
     [src/mcp/builtins.ts#L525-L535](../../../../src/mcp/builtins.ts#L525-L535):
     `const [stdoutBytes, stderrBytes] = await Promise.all([safeFileSize(...), safeFileSize(...)]);`
     before the existing `stdoutBytes > MAX_OUTPUT` checks.
   - `checkOutputGrowth` (step 8).

8. **Convert `checkOutputGrowth` to async-tick-without-overlap** —
   keep the `setInterval` shape (lowest-disruption choice; see
   analysis open question 2) but make each tick fire-and-forget the
   async work and guard against overlapping ticks with an
   `inFlight` flag:

   ```ts
   let inFlight = false;
   const checkOutputGrowth = () => {
     if (!inactivityTimeoutMs || inFlight) return;
     inFlight = true;
     void (async () => {
       try {
         const [s1, s2] = await Promise.all([
           safeFileSize(outputPaths.stdoutAbs),
           safeFileSize(outputPaths.stderrAbs),
         ]);
         const outputBytes = Math.max(lastOutputBytes, s1 + s2);
         if (outputBytes > lastOutputBytes) {
           lastOutputBytes = outputBytes;
           lastGrowthAt = Date.now();
           return;
         }
         if (Date.now() - lastGrowthAt >= inactivityTimeoutMs) terminate("inactivity");
       } finally {
         inFlight = false;
       }
     })();
   };
   ```

   Behaviour stays identical from the LLM's perspective (same
   inactivity termination semantics, same default poll interval); the
   only change is that the stat calls no longer block the event loop.

9. **Migrate `readFileTail`** at
   [src/mcp/builtins.ts#L621-L630](../../../../src/mcp/builtins.ts#L621-L630)
   to async using `fs/promises.open` + `FileHandle.read`:

   ```ts
   async function readFileTail(path: string, maxBytes: number): Promise<string> {
     const size = await safeFileSize(path);
     if (size === 0) return "";
     const length = Math.min(size, maxBytes);
     const buffer = Buffer.alloc(length);
     const handle = await open(path, "r");
     try {
       await handle.read(buffer, 0, length, size - length);
     } finally {
       await handle.close();
     }
     return buffer.toString("utf-8");
   }
   ```

   Update the two awaited call sites in the `child.on("close", async ...)`
   handler at
   [src/mcp/builtins.ts#L527-L528](../../../../src/mcp/builtins.ts#L527-L528):
   `const stdout = await readFileTail(...)` and the matching `stderr`
   line.

10. **Migrate the data handler writes** —
    [src/mcp/builtins.ts#L226-L227](../../../../src/mcp/builtins.ts#L226-L227)
    (`downloadUrl` payload),
    [src/mcp/builtins.ts#L869-L870](../../../../src/mcp/builtins.ts#L869-L870)
    (`download_with_fallbacks` success manifest), and
    [src/mcp/builtins.ts#L886-L887](../../../../src/mcp/builtins.ts#L886-L887)
    (failure manifest): each pair becomes `await mkdir(dirname(...), {
    recursive: true })` then `await writeFile(...)`. All three are
    inside `async` functions already.

11. **Add the regression guard** — new file
    [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts):

    ```ts
    import { readFile } from "node:fs/promises";
    import { glob } from "tinyglobby"; // already a dep; otherwise readdir+filter
    import { describe, it, expect } from "vitest";

    describe("src/mcp/ stays off blocking fs", () => {
      it("imports nothing from node:fs except createWriteStream", async () => {
        const files = await glob("src/mcp/**/*.ts", { ignore: ["**/*.test.ts"] });
        for (const f of files) {
          const src = await readFile(f, "utf-8");
          const m = src.match(/from\s+["']node:fs["']/);
          if (!m) continue;
          // Only the streaming primitive is permitted from node:fs.
          const block = src.match(/import\s*\{([^}]*)\}\s*from\s*["']node:fs["']/);
          const names = block ? block[1].split(",").map(s => s.trim()).filter(Boolean) : [];
          expect(names, `${f}: only createWriteStream is allowed from node:fs`)
            .toEqual(["createWriteStream"]);
        }
      });

      it("uses no *Sync fs primitives", async () => {
        const files = await glob("src/mcp/**/*.ts", { ignore: ["**/*.test.ts"] });
        for (const f of files) {
          const src = await readFile(f, "utf-8");
          // Allow identifiers like `dirSync`/`isDirectorySync` from libraries? None used here.
          expect(src, `${f}: no *Sync fs primitive`)
            .not.toMatch(/\b(readFileSync|writeFileSync|mkdirSync|readdirSync|statSync|openSync|readSync|closeSync|unlinkSync|existsSync|chmodSync)\b/);
        }
      });
    });
    ```

    If `tinyglobby` is not on the dep tree, replace with a `readdir`
    recursion (the same pattern used by other tests). Verify with
    `grep "tinyglobby" package.json` during the edit.

12. **Type-check + build + test**:

    ```bash
    cd /home/salva/g/ml/saivage
    npx tsc --noEmit
    npx vitest run src/mcp/
    npx vitest run                       # full suite; expected: green
    npm run build                        # tsup must still bundle prompts and dist/cli.js
    ```

13. **Deploy to the affected daemons** — see *Rollback* for the
    bind-mount layout. Build artefacts live on the host; restart each
    systemd unit:

    ```bash
    ssh root@10.0.3.111 'systemctl restart saivage.service'              # saivage container
    ssh root@10.0.3.112 'systemctl restart saivage.service'              # saivage-v3 harness
    ssh root@10.0.3.113 'systemctl restart saivage.service'              # diedrico harness
    for ip in 10.0.3.111 10.0.3.112 10.0.3.113; do
      curl -fsS http://$ip:8080/health || echo "FAIL $ip"
    done
    ```

    The `saivage-v3-getrich-v2` container (10.0.3.170) runs Saivage
    *v3*, not v2; it is *not* affected by this finding and must not be
    restarted as part of this batch.

## Validation

- `npx tsc --noEmit` is clean.
- `npx vitest run src/mcp/builtins.test.ts src/mcp/fsGuard.test.ts
   src/mcp/no-sync-fs.test.ts` all pass.
- `grep -nE 'readFileSync|writeFileSync|mkdirSync|readdirSync|statSync|openSync|readSync|closeSync' src/mcp/builtins.ts`
  returns nothing.
- `grep -n 'from "node:fs"' src/mcp/builtins.ts` returns only the
  `createWriteStream` import line.
- Smoke: from one of the harness containers,
  `curl -fsS http://10.0.3.112:8080/health` returns `200 OK` and an
  agent turn that calls `read_file` / `write_file` / `list_dir`
  completes — e.g. trigger a `saivage chat` turn that lists `.saivage/`.
- Concurrency smoke (optional but worth running once): drive a shell
  tool call that emits ~500 KB of output while another agent issues a
  `read_file` on a 50 MB log; confirm the dashboard `/health` endpoint
  still returns within its normal latency band.

## Rollback

The deployment surface is two LXC containers running Saivage v2 with
bind-mounts onto the host repo:

| Container | IP | Bind mount → in-container | Unit |
|---|---|---|---|
| `saivage` | 10.0.3.111 | host `/home/salva/g/ml/saivage` → container `/opt/saivage` | `saivage.service` |
| `saivage-v3` | 10.0.3.112 | host `/home/salva/g/ml/saivage` → `/opt/saivage` (code) + `/home/salva/g/ml/saivage-v3` → `/work/saivage-v3` (target project) | `saivage.service` |
| `diedrico` | 10.0.3.113 | host `/home/salva/g/ml/saivage` → `/opt/saivage` (code) + `/home/salva/g/ml/diedrico` → `/work/diedrico` (target project) | `saivage.service` |

Because the bind-mount serves `dist/` directly from the host, a build
on the host is immediately visible in all three containers. There is
no per-container artefact to roll back.

**Rollback procedure** (no `git reset --hard`):

1. From the host, `cd /home/salva/g/ml/saivage && git status` to
   confirm the patch is in a single commit.
2. `git revert <commit-sha>` (creates a forward revert commit; preserves
   history; never re-writes published commits).
3. `npm run build` to regenerate `dist/`.
4. `ssh root@10.0.3.111 'systemctl restart saivage.service'` and
   repeat for `.112` and `.113`.
5. `curl -fsS http://10.0.3.111:8080/health` and `.112`, `.113` —
   all must return `200 OK`.

If a container fails health after the revert, fall back to
`systemctl status saivage.service` over SSH and inspect
`journalctl -u saivage.service -n 200`. Do *not* touch the
`saivage-v3-getrich-v2` container (10.0.3.170) — it runs Saivage v3
and is unaffected.

If only one container regresses while the others stay green, the
revert is unnecessary: collect logs, leave the others on the new
build, and triage the lone failure separately.

## Cross-finding coordination

This batch lands the regression class fix only for `src/mcp/`. Three
sibling round-2 findings target the same regression class in other
modules:

- **[G06](../G06-stash-uses-sync-fs.md)** — `src/runtime/stash.ts`.
  The `no-sync-fs.test.ts` shape introduced here is the template for
  G06's `src/runtime/no-sync-fs.test.ts`. G06 is on the agent hot path
  (stash writes happen on every oversize tool result) so it should land
  *before* the workspace-wide guard is widened.
- **[G36](../G36-auth-store-sync-fs.md)** — `src/auth/store.ts`.
  Touches credentials; G36's plan must explicitly preserve
  `auth-profiles.json` (do not print it, do not regenerate it during
  migration) per the workspace's auth-secrets memory.
- **[G37](../G37-config-sync-fs-and-stale-cache.md)** — `src/config.ts`.
  Bundles an mtime-cache concern that is *not* in scope here.

Sequencing: G30 ships first (smallest blast radius, exercises the
guard pattern), then G06, then G36, then G37. After G37 lands, the
final batch consolidates the three per-module guards into one
workspace-wide `src/no-sync-fs.test.ts` with an allow-list for the
`recovery.ts` lockfile primitives (intentionally sync — see round-1
notes referenced in G06).

`src/repo-layout/contract.ts` and `src/knowledge/builtinWalker.ts`
also still import from `node:fs` (see the workspace-wide audit) but
are not flagged by any round-2 finding; they are read-only at module
load and out of scope for this batch.

