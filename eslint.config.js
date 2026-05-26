import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "no-eval": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // G36: ban sync FS in the auth credential store. The exit-handler
    // sync unlink is justified per-line with `eslint-disable-next-line
    // no-restricted-imports`. Test files are exempt; the scanner
    // enforces source-file purity via scanForSyncFs in store.test.ts.
    files: ["src/auth/**/*.{ts,tsx}"],
    ignores: ["src/auth/**/*.test.ts", "src/auth/__fixtures__/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "node:fs", message: "Use node:fs/promises in src/auth/. Sync fs is banned here (G36)." },
          { name: "fs", message: "Use node:fs/promises in src/auth/. Sync fs is banned here (G36)." },
        ],
      }],
    },
  },
  {
    ignores: ["dist/", "web/", "node_modules/", "*.config.*"],
  },
);
