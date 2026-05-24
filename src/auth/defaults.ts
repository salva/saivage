/**
 * Saivage — OAuth client defaults.
 *
 * These OAuth client ids ship with the binary because the upstream providers
 * publish them. They are intentionally public; operators can still override
 * them via `oauth.<provider>.clientId` in `.saivage/saivage.json` or the
 * corresponding `${ENV_VAR}` interpolation.
 */
export const DEFAULT_ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const DEFAULT_OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
