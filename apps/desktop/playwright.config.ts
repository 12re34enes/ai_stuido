/**
 * E2E: loads the shell and the dev gallery against a mocked studiod (route interception, see
 * e2e/mock.ts) and writes screenshots to test-results/screens/ (git-ignored).
 *
 * Browsers come from PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers here) — never `playwright install`.
 * WebKit (closest to WKWebView) runs automatically when a webkit build is present.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
const entries = existsSync(browsers) ? readdirSync(browsers) : [];
const chromiumBin = existsSync(join(browsers, "chromium")) ? join(browsers, "chromium") : undefined;
const hasWebkit = entries.some((d) => d.startsWith("webkit"));
const PORT = Number(process.env.E2E_PORT ?? 4317);
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/artifacts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 2,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport,
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport, launchOptions: chromiumBin ? { executablePath: chromiumBin } : {} },
    },
    ...(hasWebkit ? [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport } }] : []),
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Point the dev proxy at a closed port: anything not mocked fails fast instead of hitting a real studiod.
    env: { AISTUDIO_PORT: "9" },
  },
});
