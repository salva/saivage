// F01 B12 — Watcher build/cache exclusion set.
//
// Applied IN ADDITION to the dataset-wide secret exclusion set (already
// enforced by walker + scanChunk) and the per-source `exclude` patterns
// supplied by the dataset config. Lives in its own file because the
// operational runbook references it by name.

export const BUILD_CACHE_EXCLUSIONS: ReadonlyArray<string> = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/.saivage/**",
  "**/.saivage-work/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.cache/**",
  "**/.turbo/**",
  "**/target/**",
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/.venv/**",
  "**/venv/**",
  // Editor temp patterns.
  "**/.*.swp",
  "**/.*.swo",
  "**/.#*",
  "**/*~",
  "**/*.tmp",
];
