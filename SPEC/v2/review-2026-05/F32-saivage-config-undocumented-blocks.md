# F32 — `SaivageConfig` adds blocks the SPEC never mentions

**Category**: documentation-mismatch
**Severity**: medium
**Transversality**: module

## Summary

The runtime config schema declares four major blocks not described in `SPEC/v2/`: `security`, `supervisor`, `mcpServers`, and `runtime.continuousImprovement`. Each carries operational defaults (hardcoded models, MCP server entries for Playwright) that the operator needs to know about; today they exist only in `src/config.ts` source.

## Evidence

- `security` block: [src/config.ts](src/config.ts#L78-L82).
- `supervisor` block: [src/config.ts](src/config.ts#L84-L92).
- `mcpServers` block + Playwright default: [src/config.ts](src/config.ts#L94-L99) and [src/config.ts](src/config.ts#L121-L138).
- `runtime.continuousImprovement` default: [src/config.ts](src/config.ts#L70-L76).
- SPEC config documentation is in `SPEC/v2/00-*` and `SPEC/v2/01-DATA-MODEL.md`; none of those blocks are described there.

## Why this matters

An operator reading the SPEC believes `SaivageConfig` is a small object (objectives, providers, models, notifications). The reality is twice as large; they only discover the new blocks by reading source. The right fix is to either (a) update the SPEC to describe them, or (b) demote them to environment variables / a separate `runtime-config.json` and keep `saivage.json` aligned with the SPEC.

## Related

- F02 (roster-style drift)
- F31 (BaseAgentConfig drift)
