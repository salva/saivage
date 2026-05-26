import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@channels/ws-schema": fileURLToPath(
        new URL("./src/channels/ws-schema.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "web/src/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 10_000,
    passWithNoTests: true,
  },
});
