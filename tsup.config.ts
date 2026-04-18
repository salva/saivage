import { defineConfig } from "tsup";

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
});
