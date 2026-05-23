import { defineConfig } from "tsup";
import { cp, mkdir } from "node:fs/promises";

export default defineConfig({
  entry: ["src/server/cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  shims: false,
  async onSuccess() {
    // FR-31a: ship built-in skills alongside the bundle so the deployed
    // runtime can seed `<projectRoot>/.saivage/skills/project/` on first launch.
    await mkdir("dist/skills", { recursive: true });
    await cp("skills/builtin", "dist/skills/builtin", { recursive: true });
  },
});
