# G36 — Review r1

## Findings

### 1. Proposal B still loses cross-process updates despite the lock

The recommended design says the `SecretStore` keeps an in-memory cache and does not do an mtime poll because the singleton is the only writer in-process, with CLI-vs-daemon coordination handled by a lock ([SPEC/v2/review-2026-05-round2/G36/02-design-r1.md](SPEC/v2/review-2026-05-round2/G36/02-design-r1.md#L152-L156)). That does not close the race the finding is about.

The current bug is read-modify-write loss: `saveProfile()` loads the whole map, mutates one key, and writes the whole map back ([src/auth/store.ts](src/auth/store.ts#L74-L77)); token refresh does the same after awaiting the provider refresh ([src/auth/store.ts](src/auth/store.ts#L99-L124)); CLI `logout` is another whole-file writer outside the store API ([src/server/cli.ts](src/server/cli.ts#L492-L538)). A lockfile around each write serializes the rename, but it does not merge with another process's already-committed map if this process writes from a stale cache.

Example failure under the proposed B shape: daemon starts and caches profile `a`; CLI `login` acquires `auth-profiles.json.lock` and adds profile `b`; daemon later refreshes `a`, acquires the same lock, writes its cached `{a}` map, and deletes `b`. No writes interleaved, but the update is still lost. This directly contradicts the claim that concurrent-writer loss disappears as a property of the type ([SPEC/v2/review-2026-05-round2/G36/02-design-r1.md](SPEC/v2/review-2026-05-round2/G36/02-design-r1.md#L356-L360)).

Required change: either choose the smaller in-place design with an explicit locked read-modify-write helper, or keep `SecretStore` but make every mutating operation acquire the cross-process lock, reload or mtime-validate the latest on-disk store inside that critical section, merge the intended mutation, then atomically write. If read caching remains, it must have a correctness story for external writers; the issue file's mtime invalidation direction cannot be dropped without an equivalent replacement.

Also tighten the lock language. The design calls this POSIX `flock(LOCK_EX)` ([SPEC/v2/review-2026-05-round2/G36/02-design-r1.md](SPEC/v2/review-2026-05-round2/G36/02-design-r1.md#L164-L166)), but the plan uses `open(lockPath, "wx")` ([SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md#L19-L22)). That is a lockfile protocol, not kernel advisory flock, and it can leave stale locks on crash. If lockfiles are the chosen route, the design needs PID/mtime stale-lock handling or an explicit, tested failure policy beyond manual cleanup in rollback ([SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md#L247-L251)).

### 2. The facade is not justified tightly enough against the F22 precedent

F22 approved Proposal A: convert the existing free-function document store in place, cascade `async`, and avoid a new store abstraction ([SPEC/v2/review-2026-05/F22/02-design-r2.md](SPEC/v2/review-2026-05/F22/02-design-r2.md#L11-L15)). Its plan explicitly says not to introduce a `DocumentStore` class, dependency-injection container, or filesystem abstraction ([SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md#L268-L269)). G36 can depart from that precedent because auth has stronger requirements: owner-only mode, secret-bearing data, and CLI/daemon writers. But the current B proposal mixes that real need with speculative future scope: "every future secret-bearing file" ([SPEC/v2/review-2026-05-round2/G36/02-design-r1.md](SPEC/v2/review-2026-05-round2/G36/02-design-r1.md#L324-L333)) and a production-exported `InMemorySecretStore` test fake ([SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md#L29-L48)).

Required change: narrow the architectural claim. If the writer keeps Proposal B, frame `SecretStore` as the smallest auth-profile owner needed for the concrete invariants, not as a general future secret framework. Remove `InMemorySecretStore` from the production auth barrel; tests can use a local structural fake against a `SecretStoreLike` interface. This keeps the clean break from old free functions without adding test-only public API.

### 3. The test plan does not prove the risky properties

The proposed concurrency tests are mostly same-process tests on one store instance ([SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md#L128-L138)). Those would pass even if the stale-cache daemon/CLI lost-update bug above still exists. The manual scratch-container check using two parallel `saivage login` invocations is not deterministic and depends on live OAuth interaction ([SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md#L195-L198)).

The torn-write test is also mismatched to the implementation. The plan says to mock `handle.sync` throwing and assert the original file is unchanged ([SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md#L125-L127)), but F22's accepted atomic-write pattern tolerates `fsync` failure and still renames ([SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md#L35-L35)); the current implementation does the same in [src/store/documents.ts](src/store/documents.ts#L72-L79). A thrown `sync()` is not a torn write.

Required change: add deterministic tests for the real invariants. Use two `SecretStore` instances or child processes pointed at the same temp `.saivage` directory, preseed profile `a`, mutate profile `b` from one actor and refresh/mutate `a` from the other, and assert both survive. Add failure-injection tests for `writeFile` or `rename` errors that prove the old `auth-profiles.json` remains intact and temp files are cleaned up. Keep the existing 0o600 mode test from [src/auth/store.test.ts](src/auth/store.test.ts#L18-L43), converted to the new API.

### 4. Cross-finding lint coordination overclaims the current source state

The scoped `src/auth/**` guard is good ([SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md#L156-L159)). The broader coordination text is not: it says G06/G30/G36 should land together with a shared `node:fs` lint rule and that the allow-list is basically `runtime/recovery.ts` plus tests ([SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md#L256-L264), [SPEC/v2/review-2026-05-round2/G36/02-design-r1.md](SPEC/v2/review-2026-05-round2/G36/02-design-r1.md#L371-L376)). The checkout still has non-test `node:fs` imports in [src/agents/base.ts](src/agents/base.ts#L7), [src/agents/prompts.ts](src/agents/prompts.ts#L9), [src/repo-layout/contract.ts](src/repo-layout/contract.ts#L29), [src/knowledge/builtinWalker.ts](src/knowledge/builtinWalker.ts#L13), [src/knowledge/store.ts](src/knowledge/store.ts#L14-L18), [src/server/bootstrap.ts](src/server/bootstrap.ts#L15), [src/runtime/recovery.ts](src/runtime/recovery.ts#L8-L13), [src/config.ts](src/config.ts#L2), plus the sibling findings in [src/runtime/stash.ts](src/runtime/stash.ts#L6), [src/mcp/builtins.ts](src/mcp/builtins.ts#L18-L26), and [src/auth/store.ts](src/auth/store.ts#L8).

Required change: keep G36's guard scoped to `src/auth/**` and coordinate with G30/G06/G37 via an explicit audit table or shared scanner plan. Do not promise a repository-wide allow-list until the remaining non-test sync-fs sites are owned or deliberately exempted.

## Non-blocking notes

- The writer correctly found the auth sync-fs sites in [src/auth/store.ts](src/auth/store.ts#L46-L68), the refresh write in [src/auth/store.ts](src/auth/store.ts#L99-L124), and the CLI `logout` bypass in [src/server/cli.ts](src/server/cli.ts#L492-L538). The `writeFileSync` is at line 538 in this checkout, not 537, but the site is correctly identified.
- The production caller files are right: router OAuth resolution and provider registration touch auth in [src/providers/router.ts](src/providers/router.ts#L184-L199) and [src/providers/router.ts](src/providers/router.ts#L730-L745), bootstrap constructs the router at [src/server/bootstrap.ts](src/server/bootstrap.ts#L139), and CLI `models` constructs it at [src/server/cli.ts](src/server/cli.ts#L290). The test count is low in the prose: current direct router construction is 20 sites in [src/providers/router.test.ts](src/providers/router.test.ts#L38-L470), one in [src/providers/copilot-router.test.ts](src/providers/copilot-router.test.ts#L40), and four in [src/providers/model-capabilities.test.ts](src/providers/model-capabilities.test.ts#L169-L221).
- No auth-profile secret values are quoted in the writer docs. The daemon coverage is also adequate for this v2 finding: rollback/deploy order covers `diedrico` at 10.0.3.113, `saivage-v3` at 10.0.3.112, and `saivage` at 10.0.3.111 ([SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G36/03-plan-r1.md#L218-L244)).
- The no-backward-compat posture is mostly clean: the old free functions and CLI direct writer are deleted rather than shimmed. Fixing the facade scope and cache/lock semantics above would make that direction acceptable.

## Required change count

4

VERDICT: CHANGES_REQUESTED