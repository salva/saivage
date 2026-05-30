# G36 — APPROVED

**Chosen proposal**: Design A (per [02-design-r3.md](02-design-r3.md)) — in-place async-fs migration of `src/auth/store.ts` with a `mutateProfiles(fn)` helper that acquires a lockfile, reloads from disk INSIDE the critical section, applies the mutation, atomically writes. No cache. No new class.

**Approved by**: GPT-5.5 (copilot) reviewer at round 3 — see [04-review-r3.md](04-review-r3.md). All r1 changes (4) + r2 change (1, fixture path) addressed.

**Lock protocol**: lockfile via `open(lockPath, "wx", 0o600)` (NOT `flock`); PID/hostname JSON for stale-lock recovery via `process.kill(pid, 0)` probe.

**Tests**: cross-process via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` against TS source (no `dist/auth/*` artifact — tsup only emits `dist/cli.js`).

**Implementation pointer**: [03-plan-r3.md](03-plan-r3.md).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount.
