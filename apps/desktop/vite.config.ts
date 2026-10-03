/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** studiod's port in dev: AISTUDIO_PORT, else the runtime file written by `studiod serve`. */
function backendPort(): number {
  if (process.env.AISTUDIO_PORT) return Number(process.env.AISTUDIO_PORT);
  const home = process.env.AISTUDIO_HOME ?? join(process.cwd(), "..", "..", ".aistudio-dev");
  try {
    return JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")).port;
  } catch {
    return 8765;
  }
}

const target = `http://127.0.0.1:${backendPort()}`;
const devToken = process.env.AISTUDIO_DEV_TOKEN ?? "dev-token";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Browser dev: same-origin proxy that injects the dev token (Tauri talks to studiod directly).
    proxy: {
      "/api": { target, changeOrigin: true, headers: { Authorization: `Bearer ${devToken}` } },
      "/ws": { target: target.replace("http", "ws"), ws: true, headers: { Authorization: `Bearer ${devToken}` } },
    },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari17",
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    exclude: ["e2e/**", "node_modules/**"],
  },
});
