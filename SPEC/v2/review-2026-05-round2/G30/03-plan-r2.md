# G30 — Implementation Plan (r2)

**Chosen design**: Proposal A from
[02-design-r2.md](./02-design-r2.md#L13-L322) — in-place async-fs
migration of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts),
plus a dependency-free reusable scanner in
`src/testing/noSyncFsScanner.ts` consumed by a new
`src/mcp/no-sync-fs.test.ts`.

**Changes from r1**:

- Step 6 (`runShellCommand` mkdir) now explicitly hoists both `await
  mkdir(...)` calls *before* the `new Promise` constructor (review
  finding 1).
- Step 8 (`checkOutputGrowth`) carries the new `settled`/`inFlightTick`
  race guard and step 9 (close handler) sets `settled` first thing
  (review finding 1).
- Step 11 (the regression guard) is rewritten as a thin call into a
  dependency-free reusable helper in `src/testing/noSyncFsScanner.ts`;
  no `tinyglobby` import (review finding 2).
- A new step 12.5 adds a focused close-handler-race regression test in
  `src/mcp/builtins.test.ts` (review finding 1).
- The "Cross-finding coordination" section is rewritten around the
  audit table from
  [01-analysis-r2.md §4.1](./01-analysis-r2.md#L116-L144); the bare
  "workspace-wide guard after G37" claim from r1 is removed (review
  finding 3).

## Steps

1. **Verify no concurrent edit collides** — confirm `git status` is
   clean for `src/mcp/builtins.ts`, `src/mcp/builtins.test.ts`,
   `src/mcp/fsGuard.test.ts`, and `src/testing/` (creating the dir if
   missing). If any of G06 / G36 / G37 has landed first, re-read their
   scanner invocation so we keep the helper signature stable.

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

6. **Hoist `runShellCommand` dir setup out of the Promise executor**
   (r2 — was step 6 in r1, now explicit). At
   [src/mcp/builtins.ts#L433-L444](../../../../src/mcp/builtins.ts#L433-L444),
   change the function from:

   ```ts
   async function runShellCommand(...): Promise<CommandResult> {
     return new Promise((resolve, reject) => {
       mkdirSync(dirname(outputPaths.stdoutAbs), { recursive: true });
       mkdirSync(dirname(outputPaths.stderrAbs), { recursive: true });
       // ...
     });
   }
   ```

   to:

   ```ts
   async function runShellCommand(...): Promise<CommandResult> {
     await mkdir(dirname(outputPaths.stdoutAbs), { recursive: true });
     await mkdir(dirname(outputPaths.stderrAbs), { recursive: true });
     return new Promise((resolve, reject) => {
       // streams open inside the executor; their parent dirs exist now
       // ...
     });
   }
   ```

   Do **not** convert the executor to `async (resolve, reject) => ...`;
   an async Promise executor would orphan the mkdir rejection and leave
   the returned promise potentially unsettled. The two `await mkdir`
   calls must appear before the `new Promise` literal.

7. **Make `safeFileSize` async** at
   [src/mcp/builtins.ts#L609](../../../../src/mcp/builtins.ts#L609):
   `async function safeFileSize(path: string): Promise<number> { try {
   return (await stat(path)).size; } catch { return 0; } }`. Update its
   call sites:
   - `readFileTail` (step 9) — already going async.
   - `runShellCommand` close handler at
     [src/mcp/builtins.ts#L525-L535](../../../../src/mcp/builtins.ts#L525-L535):
     `const [stdoutBytes, stderrBytes] = await Promise.all([safeFileSize(...), safeFileSize(...)]);`
     before the existing `stdoutBytes > MAX_OUTPUT` checks.
   - `checkOutputGrowth` (step 8).

8. **Convert `checkOutputGrowth` to async-tick with `settled` and
   `inFlightTick` guards** (r2 — was step 8 in r1, now race-correct).
   Inside the `new Promise(...)` body, after the existing local
   declarations (`let timeoutKind: ... = null;` etc.), add the two new
   flags and rewrite the helper to short-circuit on either:

   ```ts
   let settled = false;
   let inFlightTick = false;

   const terminate = (kind: "total" | "inactivity") => {
     if (settled || timeoutKind) return;            // (r2) settled-guarded
     timeoutKind = kind;
     terminateChild(child);
     killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), PROCESS_KILL_GRACE_MS);
   };

   const checkOutputGrowth = () => {
     if (!inactivityTimeoutMs || inFlightTick || settled) return;
     inFlightTick = true;
     void (async () => {
       try {
         const [s1, s2] = await Promise.all([
           safeFileSize(outputPaths.stdoutAbs),
           safeFileSize(outputPaths.stderrAbs),
         ]);
         if (settled) return;                       // (r2)
         const outputBytes = Math.max(lastOutputBytes, s1 + s2);
         if (outputBytes > lastOutputBytes) {
           lastOutputBytes = outputBytes;
           lastGrowthAt = Date.now();
           return;
         }
         if (settled) return;                       // (r2)
         if (Date.now() - lastGrowthAt >= inactivityTimeoutMs) terminate("inactivity");
       } finally {
         inFlightTick = false;
       }
     })();
   };
   ```

   Behaviour from the LLM's perspective is identical when the command
   really did stall (same inactivity termination, same default
   interval); the new guards only fire when the close handler races
   an in-flight stat — which under the previous async draft could
   misreport a normal exit as an inactivity timeout.

9. **Migrate `readFileTail` and update the close handler** at
   [src/mcp/builtins.ts#L518-L541](../../../../src/mcp/builtins.ts#L518-L541)
   and
   [src/mcp/builtins.ts#L621-L630](../../../../src/mcp/builtins.ts#L621-L630).

   `readFileTail` becomes:

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

   The close handler must set `settled = true` *before* `clearTimers()`
   so any in-flight tick observes the flip after its `await
   Promise.all` resolves:

   ```ts
   child.on("close", async (code) => {
     settled = true;            // (r2) FIRST
     clearTimers();
     const completedAtMs = Date.now();
     const completedAt = new Date(completedAtMs).toISOString();
     await Promise.all([finishStream(stdoutStream), finishStream(stderrStream)]);
     const [stdout, stderrTail] = await Promise.all([
       readFileTail(outputPaths.stdoutAbs, MAX_OUTPUT),
       readFileTail(outputPaths.stderrAbs, MAX_OUTPUT),
     ]);
     let stderr = stderrTail;
     const [stdoutBytes, stderrBytes] = await Promise.all([
       safeFileSize(outputPaths.stdoutAbs),
       safeFileSize(outputPaths.stderrAbs),
     ]);
     // ... existing MAX_OUTPUT messages, timeoutKind branches, resolve() ...
   });
   ```

10. **Migrate the data handler writes** —
    [src/mcp/builtins.ts#L226-L227](../../../../src/mcp/builtins.ts#L226-L227)
    (`downloadUrl` payload),
    [src/mcp/builtins.ts#L869-L870](../../../../src/mcp/builtins.ts#L869-L870)
    (`download_with_fallbacks` success manifest), and
    [src/mcp/builtins.ts#L886-L887](../../../../src/mcp/builtins.ts#L886-L887)
    (failure manifest): each pair becomes `await mkdir(dirname(...), {
    recursive: true })` then `await writeFile(...)`. All three are
    inside `async` functions already.

11. **Add the reusable scanner helper** — new file
    `src/testing/noSyncFsScanner.ts` with the implementation in
    [02-design-r2.md §"Reusable guard helper"](./02-design-r2.md#L120-L226).
    Key properties:
    - Dependency-free: imports only `node:fs/promises` and `node:path`.
    - Recursive directory walk via `readdir({ withFileTypes: true })`.
    - Generalized import detection: catches default, namespace
      (`import * as fs`), named, and mixed import forms from
      `"node:fs"`.
    - Accepts `(roots, allowedNamedImports, extensions,
      skipPathContains)` so G06 / G36 / G37 can drop it in with their
      own root and skip-list (e.g. G06 skips `recovery.ts`).

12. **Add the per-module regression guard** — new file
    [src/mcp/no-sync-fs.test.ts](../../../../src/mcp/no-sync-fs.test.ts):

    ```ts
    import { describe, it, expect } from "vitest";
    import { scanForSyncFs } from "../testing/noSyncFsScanner.js";

    describe("src/mcp/ stays off blocking fs", () => {
      it("has no node:fs sync imports or *Sync calls outside tests", async () => {
        const violations = await scanForSyncFs({
          roots: ["src/mcp"],
          allowedNamedImports: ["createWriteStream"],
        });
        expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
      });
    });
    ```

    No `tinyglobby`, no inline regex, no hard-coded `src/mcp`
    assumptions inside the helper. The same one-liner is what G06 /
    G36 / G37 will paste into their own test file with their root.

12.5. **Add the close-handler race regression test** (r2 — new). Append
    to [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts):

    ```ts
    it("does not mis-report a fast normal exit as inactivity timeout", async () => {
      const runtime = await makeRuntime();   // existing helper
      // 25ms inactivity timeout + a command that exits in <10ms means
      // checkOutputGrowth will have a stat in flight when child.close
      // fires on the busy CI runner; the settled guard prevents the
      // late tick from calling terminate("inactivity").
      for (let i = 0; i < 20; i++) {
        const res = await runtime.callTool("shell", "run_command", {
          command: "echo hello",
          inactivity_timeout_ms: 25,
        }) as { exitCode: number; stderr: string };
        expect(res.exitCode).toBe(0);
        expect(res.stderr).not.toMatch(/inactivity/);
        expect(res.stderr).not.toMatch(/timed out/);
      }
    });
    ```

    The loop multiplies the chance of catching the race on a noisy
    CI runner; without the `settled` guard at least one iteration
    flips `timeoutKind` to `"inactivity"` between `await
    Promise.all([stat, stat])` resolving and the close handler taking
    over.

13. **Type-check + build + test**:

    ```bash
    cd /home/salva/g/ml/saivage
    npx tsc --noEmit
    npx vitest run src/mcp/ src/testing/
    npx vitest run                       # full suite; expected: green
    npm run build                        # tsup must still bundle prompts and dist/cli.js
    ```

14. **Deploy to the affected daemons** — see *Rollback* for the
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
   src/mcp/no-sync-fs.test.ts` all pass, including the new fast-exit
   loop test from step 12.5.
- `grep -nE 'readFileSync|writeFileSync|mkdirSync|readdirSync|statSync|openSync|readSync|closeSync' src/mcp/builtins.ts`
  returns nothing.
- `grep -n 'from "node:fs"' src/mcp/builtins.ts` returns only the
  `createWriteStream` import line.
- `grep -n 'tinyglobby' src/mcp/no-sync-fs.test.ts src/testing/noSyncFsScanner.ts`
  returns nothing (review finding 2).
- `grep -n 'new Promise' src/mcp/builtins.ts` does not show the two
  `mkdir` lines inside the executor (review finding 1).
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

## Cross-finding coordination (r2)

This batch lands two reusable artefacts plus the `src/mcp/` regression
class fix:

1. The `src/mcp/builtins.ts` async migration (this finding only).
2. `src/testing/noSyncFsScanner.ts` — the dependency-free scanner
   helper. Consumed by `src/mcp/no-sync-fs.test.ts` here and by the
   sibling tests under G06 / G36 / G37.

Sibling sequencing remains: G30 ships first, then G06, then G36, then
G37. Each sibling's test is the same one-liner with a different `roots`
argument (and, for G06, a `skipPathContains: ["recovery.ts"]` to honor
the F22 carve-out).

### Audit: every non-test `node:fs` user in `src/` (r2)

| File | Status | Owning finding / rationale |
|---|---|---|
| [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L26) | covered (this finding) | G30 |
| [src/runtime/stash.ts](../../../../src/runtime/stash.ts#L6-L67) | covered (sibling finding) | [G06](../G06-stash-uses-sync-fs.md) |
| [src/auth/store.ts](../../../../src/auth/store.ts#L8-L66) | covered (sibling finding) | [G36](../G36-auth-store-sync-fs.md) |
| [src/config.ts](../../../../src/config.ts#L2-L280) | covered (sibling finding) | [G37](../G37-config-sync-fs-and-stale-cache.md) |
| `src/runtime/recovery.ts` lockfile primitives | deliberately sync (F22 carve-out) | round-1 [F22](../../review-2026-05/F22/APPROVED.md): atomic at module-load, no event-loop alternative; named in the G06 plan as the sole legitimate sync site under `src/runtime/`. |
| [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L9-L51) | still unowned | needs a new finding before any workspace-wide guard. Module-load read of prompt bundles; likely allow-listable but unreviewed. |
| [src/agents/base.ts](../../../../src/agents/base.ts#L7) | still unowned | needs a new finding. Single `node:fs` import for a non-hot-path read. |
| [src/server/cli.ts](../../../../src/server/cli.ts#L493-L538) | still unowned | needs a new finding. CLI startup sync reads — acceptable at boot but should be confirmed. |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L15-L720) | still unowned | needs a new finding. Sync reads for config discovery at boot. |
| [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L14-L286) | still unowned | needs a new finding. **On the agent hot path** (knowledge skill resolution) — likely *not* a legitimate sync site; priority for the next review batch. |
| [src/repo-layout/contract.ts](../../../../src/repo-layout/contract.ts#L29-L154) | still unowned | needs a new finding. Module-load contract loader; likely allow-listable. |
| [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L13-L139) | still unowned | needs a new finding. Walks the builtin knowledge tree at startup; likely allow-listable. |

### Gating rule for a workspace-wide `src/no-sync-fs.test.ts`

Do **not** land a `roots: ["src"]` invocation of `scanForSyncFs` until
every row marked "still unowned" above is one of:

- covered by a new owning finding that migrates the file, or
- explicitly allow-listed via `skipPathContains` after a focused
  review records the rationale, or
- moved out of the workspace.

Until then the workspace-wide guard would either fail on day one (if
landed without the allow-list) or grow an unreviewed allow-list (if
landed with one). The per-module guards from G30 / G06 / G36 / G37 are
sufficient interim coverage for the regression class the finding
flags.
