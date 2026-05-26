# F32 — Analysis (r1)

## Problem restated

`SPEC/v2/01-DATA-MODEL.md` § 1 ("Runtime Config") declares a `RuntimeConfig` TypeScript interface that an operator reading the SPEC will treat as authoritative ([SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L7-L52)). The runtime Zod schema in [src/config.ts](src/config.ts#L34-L113) is materially larger than that interface: it adds four top-level blocks the SPEC does not mention at all, and one extra key inside an existing block.

Missing from the SPEC, present in the schema:

1. `security` — [src/config.ts](src/config.ts#L78-L82). Keys: `injectionScanner`, `injectionModel`, `maxScanLengthBytes`. Drives the prompt-injection cop ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L51-L62)).
2. `supervisor` — [src/config.ts](src/config.ts#L84-L92). Keys: `enabled`, `model`, `intervalMs`, `consecutiveStuckVerdicts`, `logLines`. Drives the background stuck-agent supervisor ([src/runtime/supervisor.ts](src/runtime/supervisor.ts#L44-L54)).
3. `mcpServers` — [src/config.ts](src/config.ts#L112) and `mcpServerSchema` at [src/config.ts](src/config.ts#L26-L33). Per-name external-MCP launch spec (`command`, `args`, `env`, `disabled`, `autostart`, `transport`). `writeDefaultConfig` seeds a `playwright` entry: [src/config.ts](src/config.ts#L222-L233). Consumed by `startConfiguredMcpServers` in [src/server/bootstrap.ts](src/server/bootstrap.ts#L708-L738).
4. `notifications` — [src/config.ts](src/config.ts#L105-L110). Keys: `channels`, `filters.{min_severity, categories}`. The SPEC documents the *project*-level `ProjectConfig.notifications` field with the same shape ([SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L69-L76)) but does not mention the daemon-level fallback in `RuntimeConfig`.

Missing inside the SPEC's existing `runtime` block:

5. `runtime.continuousImprovement: boolean` (default `true`) — [src/config.ts](src/config.ts#L74). Read by [src/server/bootstrap.ts](src/server/bootstrap.ts#L602-L609): when `PLAN_COMPLETE` is emitted and this flag is true, the recovery loop queues a continuous-improvement directive and restarts the Planner instead of terminating. This is a directly operator-facing behavioural switch and is invisible from the SPEC.

The ticket's `evidence` also lists this fifth item; for clarity it is counted separately from the four "new blocks".

## Actual differences

The SPEC's `RuntimeConfig` is a strict *subset* of the on-disk schema; no field collides with a different shape. Reformulated as a diff of the SPEC against the schema:

```
SPEC missing:                                                  Schema location
+ security: { injectionScanner, injectionModel,                src/config.ts#L78-L82
              maxScanLengthBytes }
+ supervisor: { enabled, model, intervalMs,                    src/config.ts#L84-L92
                consecutiveStuckVerdicts, logLines }
+ notifications: { channels, filters }                         src/config.ts#L105-L110
+ mcpServers: { [name]: { command, args, env,                  src/config.ts#L26-L33
                          disabled, autostart, transport } }     + L112
+ runtime.continuousImprovement: boolean                       src/config.ts#L74
```

There is also a smaller but related drift not called out in the ticket: the SPEC declares `models.{orchestrator, coder, researcher, executor, chat, default}` as five required-string fields, but the schema makes every model assignment optional and adds `planner`, `manager`, `data_agent`, `reviewer`, `inspector` ([src/config.ts](src/config.ts#L36-L50)). This is owned by F02 (roster drift) and F04 (default models). F32 must not re-fix it; F32 must produce a SPEC shape that is consistent with whatever F02/F04 land.

The operator-prose doc [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L1-L248) **already** documents all four missing blocks and `continuousImprovement` with examples. The SPEC and the prose doc therefore diverge today: prose is current, SPEC is stale. Any fix has to remove one source of truth, not add a third.

## Contract

The file referenced by the SPEC and by the prose doc is the same file: `<project>/.saivage/saivage.json` (or `${SAIVAGE_ROOT}/saivage.json`). It is read by `loadConfig()` in [src/config.ts](src/config.ts#L184-L198). The schema is validated with Zod (`configSchema.parse`); validation errors fail the boot. Environment-variable interpolation (`${NAME}`) runs before parsing.

Defaults are supplied two different ways and this duality is the root of why the SPEC went stale:

- **Zod-level defaults**: every nested block has `.default({})` and every leaf has `z.…default(value)`. Missing keys are silently filled in by `loadConfig`.
- **Seeded defaults**: `writeDefaultConfig()` ([src/config.ts](src/config.ts#L204-L237)) writes a fresh `saivage.json` with a *subset* of the defaults (notably `mcpServers.playwright`, which is *not* a Zod default — the Zod default for `mcpServers` is `{}`).

Consequence: the on-disk shape and the `loadConfig` shape are not identical, and the SPEC § 1 today documents neither one accurately.

## Call sites & dependencies

Every consumer of `SaivageConfig` is in `src/`; nothing outside the daemon reads this file. The five missing items are read here:

- `config.security` → [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L51-L62) (cop construction), [src/server/bootstrap.ts](src/server/bootstrap.ts#L130) (resolver routing).
- `config.supervisor` → [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L44-L54) (constructor), [src/server/bootstrap.ts](src/server/bootstrap.ts#L129) and [src/server/bootstrap.ts](src/server/bootstrap.ts#L251) (resolver routing + instance wiring).
- `config.mcpServers` → [src/server/bootstrap.ts](src/server/bootstrap.ts#L144) and [src/server/bootstrap.ts](src/server/bootstrap.ts#L708-L738) (`startConfiguredMcpServers`).
- `config.notifications` → consumed alongside the project-level `notifications`; same shape (`notificationFiltersSchema` is the canonical type, used in both).
- `config.runtime.continuousImprovement` → [src/server/bootstrap.ts](src/server/bootstrap.ts#L602-L609) (recovery loop).

Schemas constraining the shape: `configSchema` in [src/config.ts](src/config.ts#L34-L113); `runtimeProviderConfigSchema` from [src/routing/resolver.ts](src/routing/resolver.ts) is composed into `providers`. F02 and F04 will further constrain `models` and the worker role list.

The operator-facing doc that already covers these blocks: [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L100-L248). It is linked from VitePress at [docs/.vitepress/config.ts](docs/.vitepress/config.ts) (sidebar entry `/guide/config-runtime`).

## Constraints any solution must respect

1. **Architecture-first, no backward compatibility.** No "old SPEC shape kept for transition", no "doc note that v2.x still uses the small interface". Update the SPEC in one shot, delete the stale section in the same change.
2. **One source of truth.** The current situation is: schema in `src/config.ts`, prose in `docs/guide/config-runtime.md`, stale type in `SPEC/v2/01-DATA-MODEL.md`. The fix must remove the *third* source, not just rebuild it.
3. **No new docstrings or comments** on `src/config.ts`. The schema is already self-documenting via Zod field names; F32 is a docs-and-SPEC change, not a source change. If the schema needs any source-side adjustment, it must be a structural one driven by another Fxx (F04 owns model defaults; F11 owns promoting magic constants; F02 owns the roster).
4. **No promotion of new config keys.** F32 is not the place to add, remove, or rename schema keys. Document what exists; leave shape changes to F02 (`models`), F04 (defaults), F11 (`runtime.notes`, `runtime.recoveryDelayMs`, `runtime.supervisor.forceCancelDelayMs`, `mcp.*` block), F33 (default-writer parity).
5. **Cross-issue ordering.** F02 and F04 reshape `models` and the model-default fields. F11 adds new `runtime.*` and `mcp.*` keys to the schema. F33 reshapes `writeDefaultConfig`. F32's SPEC update needs to land *after* those structural changes, otherwise the SPEC will be re-stale on day one.
6. **VitePress wiring.** Whatever the SPEC ends up saying about `saivage.json`, it must link to `docs/guide/config-runtime.md` so an operator who lands on the SPEC follows the trail to runnable prose. The reverse link already exists (the prose doc points at `src/config.ts`).
7. **Out of scope.** `src/skills/`, `SPEC/v2/skills/`, `SPEC/v2/skills-memory/` — another agent owns those. The `notifications` block discussion stays at the runtime-config level; skill-memory notifications, if any, are out of scope.
8. **Confidentiality.** None of the documented fields here are secrets, but the prose doc renders `${TELEGRAM_BOT_TOKEN}` and `${ANTHROPIC_API_KEY}` as env-var references. The SPEC must continue that convention, never paste literal token strings.
