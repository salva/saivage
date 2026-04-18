import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/api": "http://localhost:7777",
      "/health": "http://localhost:7777",
      "/ws": {
        target: "ws://localhost:7777",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
