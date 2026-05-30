# F32 — Design (r1)

Two proposals plus one rejected option. Both viable proposals start from the same fact: the operator-facing doc [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L1-L248) already documents the four missing blocks and `continuousImprovement` accurately. The disagreement is whether the SPEC should *mirror* that doc or *delegate* to it.

## Proposal A — Update `01-DATA-MODEL.md` § 1 to mirror the full Zod schema (FOCUSED FIX)

**Scope (files touched):**

- [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L7-L52) — § 1 "Runtime Config" rewritten to match the on-disk schema. New layout:

  ```typescript
  interface RuntimeConfig {                       // see src/config.ts:configSchema
    models?: { … };                               // shape: per F02/F04 — link out
    providers: { [name: string]: ProviderConfig };// see src/routing/resolver.ts
    failover: { [providerOrModel: string]: string[] };
    modelEquivalents: { [modelSpec: string]: string[] };
    server: { port: number; host: string };
    agent: { maxConcurrentAgents: number };
    runtime: {
      maxServices: number;
      restartOnCrash: boolean;
      continuousImprovement: boolean;             // NEW
      healthCheckIntervalMs: number;
      idleShutdownMs: number;
      // F11 will add: notes.volatileTtlMs, recoveryDelayMs, supervisor.forceCancelDelayMs
    };
    security: {                                   // NEW BLOCK
      injectionScanner: boolean;
      injectionModel?: string;                    // per F04: optional, no hardcoded default
      maxScanLengthBytes: number;
    };
    supervisor: {                                 // NEW BLOCK
      enabled: boolean;
      model?: string;                             // per F04: optional, no hardcoded default
      intervalMs: number;
      consecutiveStuckVerdicts: number;
      logLines: number;
    };
    telegram: { botToken: string; allowedUserIds: number[] };
    notifications: {                              // NEW (was project-only in SPEC)
      channels: ("telegram" | "web")[];
      filters: { min_severity: …; categories: […] };
    };
    mcpServers: { [name: string]: McpServerSpec };// NEW BLOCK
    // F11 will add: mcp.{shellTimeoutMs, inProcessTimeoutMs, maxOutputBytes, …}
  }

  interface McpServerSpec {                       // NEW
    command: string;
    args: string[];
    env: { [k: string]: string };
    disabled: boolean;
    autostart: boolean;
    transport: "stdio" | "sse";
  }
  ```

  - Section heading renamed from "Runtime Config" to "Runtime Config (`SaivageConfig`)" so the SPEC name matches the source type ([src/config.ts](src/config.ts#L115)).
  - Each block annotated with a one-line "drives X" pointer to the consuming subsystem (security cop, supervisor, MCP runtime, recovery loop). No prose duplication beyond that — the operator-facing prose stays in [docs/guide/config-runtime.md](docs/guide/config-runtime.md).
  - Footer of the section adds a single "See also" bullet list: prose with examples → `docs/guide/config-runtime.md`; canonical schema → [src/config.ts](src/config.ts#L34).
  - `models` field references F02 / F04 for the active worker-role list and default policy instead of inlining names that will drift again.

- [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L186-L210) — § 2.3 "LLM Provider Router" already references `RuntimeConfig.providers[name].models[role]`. One-line addition: note that `RuntimeConfig` also carries the `security`, `supervisor`, and `mcpServers` blocks, with a link to § 1. No further edits to § 2.x — the architecture description is already correct.

**What gets added:**

- ~50 lines of TypeScript-style schema in `01-DATA-MODEL.md` § 1 (the four missing blocks + `continuousImprovement` + the `McpServerSpec` helper interface).
- Three "drives X" cross-link sentences.
- One "See also" footer block at the end of § 1.

**What gets removed:**

- The stale `RuntimeConfig` interface body in [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L13-L52). Replaced wholesale, not patched.
- Out-of-date `// default: …` inline comments in that interface that contradict F04's policy (`models.orchestrator: "anthropic/…"`). The replacement uses links to F02/F04 instead of inlining a default that will be wrong again next quarter.

**Risk:**

- **Drift risk persists.** The SPEC remains a hand-maintained mirror of `configSchema`. F33 already exists to catch this kind of drift between `writeDefaultConfig` and `configSchema`; F32 does not solve the SPEC half of that problem — it just resets it. Mitigation: the "See also" footer pointing at `src/config.ts` makes the canonical location obvious; a future ticket can add a generator that produces § 1 from the Zod schema.
- **Re-stale on F02/F04/F11/F33 landing.** F02 reshapes `models`; F04 makes `injectionModel`/`supervisor.model` optional; F11 adds keys to `runtime.*` and `mcp.*`; F33 reshapes `writeDefaultConfig`. F32 r1 already encodes the *post-F04* shape in the schema sketch above (using `injectionModel?` and `supervisor.model?`). Cross-issue ordering: F32 must merge *after* F02, F04, F11, F33. Plan covers this explicitly.
- **Operator confusion between SPEC and prose doc.** Two docs cover the same shape. Mitigation: the SPEC documents *the type*; the prose doc documents *how to set it up*. The "See also" line and the section heading make this split explicit.

**What it enables:**

- F04 cross-link target (its plan says "F32 will document that `injectionModel` and `model` are required when their respective subsystem is enabled" — see [SPEC/v2/review-2026-05/F04/02-design-r3.md](SPEC/v2/review-2026-05/F04/02-design-r3.md)).
- F11 cross-link target (its design adds `runtime.notes.volatileTtlMs`, `runtime.recoveryDelayMs`, `runtime.supervisor.forceCancelDelayMs`, `mcp.*` — these will slot into the `runtime` and new `mcp` blocks documented here).
- F33 ("config default drift") can build its parity test against a SPEC that finally matches the schema; previously F33 had no SPEC anchor to test against.

**What it forbids:**

- New per-block prose duplication in the SPEC. The SPEC carries type, not tutorial.
- Adding undocumented blocks in source: the SPEC update implicitly establishes the rule that any new top-level key in `configSchema` must also appear in § 1.

**Recommendation note:** the focused, low-risk fix. Recommended on its own merits, even though Proposal B is structurally cleaner.

---

## Proposal B — Delete the schema mirror from the SPEC; delegate to source + prose (LEVEL UP)

**Scope (files touched):**

- [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L7-L52) — § 1 rewritten as a *pointer*, not a type. New § 1 body:

  > **Path:** `<project>/.saivage/saivage.json` (or `${SAIVAGE_ROOT}/saivage.json`).
  >
  > The runtime config is defined by the `SaivageConfig` Zod schema in [src/config.ts](src/config.ts#L34-L113). The schema is the canonical source of truth: field names, default values, and validation rules live there and only there. The 2026-05 schema covers `models`, `providers`, `failover`, `modelEquivalents`, `server`, `agent`, `runtime`, `security`, `supervisor`, `telegram`, `notifications`, and `mcpServers`.
  >
  > For operator-facing prose with worked examples — env-var interpolation, provider failover chains, MCP-server entries, supervisor tuning — see [docs/guide/config-runtime.md](docs/guide/config-runtime.md).
  >
  > Cross-cutting policies:
  > - Model resolution and the no-hardcoded-defaults rule: F04.
  > - Worker-role roster (`models.*` keys): F02.
  > - Magic-constant promotion (`runtime.notes`, `runtime.recoveryDelayMs`, `runtime.supervisor.forceCancelDelayMs`, `mcp.*`): F11.
  > - Default-writer / schema parity: F33.

- [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L186-L210) — one-line addition: "`SaivageConfig` is defined in `src/config.ts`; § 1 of the data-model SPEC is a pointer, not a duplicate."

- All other SPEC references to `RuntimeConfig` ([SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L196), [SPEC/v2/00-AGENT-SYSTEM.md](SPEC/v2/00-AGENT-SYSTEM.md#L489), [SPEC/v2/04-RUNTIME-DETAILS.md](SPEC/v2/04-RUNTIME-DETAILS.md#L103)) renamed to `SaivageConfig` for consistency with source. Three one-word swaps.

**What gets added:**

- ~15 lines of pointer prose in `01-DATA-MODEL.md` § 1.
- Three `RuntimeConfig` → `SaivageConfig` renames in companion SPEC docs.

**What gets removed:**

- The entire `interface RuntimeConfig { … }` body ([SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L13-L52)). Forty-five lines deleted, not patched.
- The implicit second source of truth. After Proposal B there are exactly two places documenting `saivage.json`: the Zod schema in source (canonical type) and the operator prose doc (canonical tutorial). The SPEC participates only as a pointer.

**Risk:**

- **Loss of "at-a-glance schema" affordance.** A reader of the SPEC who wants to see all `saivage.json` keys at once now has to follow a link to `src/config.ts`. This is a minor regression in browseability; mitigated by the fact that the SPEC's current type is wrong anyway (so the affordance was an illusion).
- **Slight asymmetry with other § N sections.** § 2 ("Project Config") still inlines its type, § 3+ inline plan/task/report shapes. Proposal B leaves § 1 as the only pointer. This is *justified asymmetry*: project config and the document shapes are SPEC-defined (no Zod schema in source for `Plan`, `Stage`, `Task`); runtime config is schema-defined. Documenting them the same way pretends a parity that does not exist.
- **Reviewer perception.** A reviewer may read the deletion as "less documentation". The plan must explain that it is *consolidation*, not removal — total documentation goes from {stale SPEC + prose doc + schema} to {prose doc + schema with the SPEC pointing at both}.

**What it enables:**

- Drift cannot recur. F33's parity test only needs to compare `configSchema` against `writeDefaultConfig`; the SPEC is no longer in the loop.
- F02 / F04 / F11 stop creating SPEC churn. Today, any change to the `models` block or to a default value implies a `01-DATA-MODEL.md` edit; with Proposal B those changes are documented exactly once, in the Zod schema (with the prose doc updated when operator-facing prose is affected).
- Future Zod-to-Markdown generator becomes trivial: the SPEC is no longer a manual destination, so the generator (if/when built) only needs to emit a reference table in the prose doc.

**What it forbids:**

- Any future SPEC PR that adds a new schema block "for completeness". The SPEC explicitly steps out of that role.
- Re-introduction of `interface RuntimeConfig`-style mirrors elsewhere in the SPEC. The pointer in § 1 is the precedent.

**Recommendation note:** structurally the cleanest answer to "the SPEC went stale". Removes the failure mode entirely rather than re-painting the wall. Slightly bigger one-shot edit but a much smaller maintenance surface.

---

## Proposal Z (rejected) — Promote `security` / `supervisor` / `continuousImprovement` to environment variables and delete them from `saivage.json`

The ticket's "Why this matters" section floats this idea: "demote them to environment variables / a separate `runtime-config.json`". Rejected because:

1. These blocks are not transient. `supervisor.intervalMs`, `security.maxScanLengthBytes`, and `mcpServers` entries are persistent operator choices, not deploy-time secrets. Env vars are the wrong shape for them.
2. `mcpServers` carries structured data (`args: string[]`, `env: {…}`); flattening to env vars is a strict downgrade in expressivity.
3. The user-stated operator workflow (one `saivage.json` per project, edited with a text editor) is the right ergonomic. Splitting some keys into env and others into JSON makes the operator inventory worse, not better.
4. Project guideline: no over-engineering. Two configuration mechanisms where one suffices is over-engineering.

Recorded for completeness; not viable.

---

## Recommendation

**Proposal B.** The disease is "the SPEC and the schema drifted because the SPEC was a manual mirror"; the cure is to stop mirroring, not to mirror more carefully. Proposal A fixes the *symptom* (today's missing blocks) but reintroduces the same maintenance trap that produced F32 in the first place. Proposal B removes the trap and acknowledges the existing operator-prose doc as the right place for runnable detail.

If reviewer prefers Proposal A on grounds of "SPEC must enumerate every shape", switch — both proposals execute cleanly and the harm of choosing A is purely a near-zero ongoing drift cost.
