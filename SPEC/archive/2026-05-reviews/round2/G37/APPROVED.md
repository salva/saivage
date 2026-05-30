# G37 — APPROVED

**Chosen proposal**: Per [02-design-r3.md](02-design-r3.md) — replace sync fs in src/config.ts with async fs/promises, retain the `existsSync` named import + call for the resolveProjectRoot quick probe, and acknowledge auth/store.ts as a transitive consumer that depends on G36 landing first to clean up `config.ensureDir`. G36 promoted to hard prerequisite.

**Approved by**: GPT-5.5 (copilot) reviewer at round 3 — see [04-review-r3.md](04-review-r3.md). All r2 blockers resolved: regression test now matches the G30 scanner contract (expects both `disallowed-named-import` and `sync-call` violations for the carved-out `existsSync` quick-probe), barrel re-identification correct, fixture mechanics use sync mkdirSync/writeFileSync to seed `.saivage/` before each case, malformed-JSON prose matches live throw behaviour.

**Implementation pointer**: [03-plan-r3.md](03-plan-r3.md). Sequencing: G30 must land first (provides the scanner); G36 must land second (removes the `config.ensureDir` consumer in auth/store.ts).

**Daemon impact**: Minimal — config reads are async post-bootstrap. Restart `saivage` (10.0.3.111) and `diedrico` (10.0.3.113) operator-gated; `saivage-v3` (10.0.3.112) untouched.
