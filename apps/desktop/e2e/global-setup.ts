/**
 * Warm the Vite dev server before tests: on a cold start Vite discovers and pre-bundles
 * dependencies on first use and reloads the page, which would interrupt the first test.
 */
import { chromium, type FullConfig } from "@playwright/test";

export default async function globalSetup(config: FullConfig) {
  const project = config.projects[0];
  const baseURL = project?.use.baseURL;
  if (!baseURL) return;
  const browser = await chromium.launch(project.use.launchOptions);
  const page = await browser.newPage();
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  await page.routeWebSocket(/\/ws\/events/, (ws) => ws.send(JSON.stringify({ kind: "ready", last_id: 0 })));
  for (const hash of ["/", "/__gallery?static=1", "/tasks", "/flows", "/settings"]) {
    await page.goto(`${baseURL}/#${hash}`);
    await page.waitForLoadState("networkidle");
  }
  // Give the optimizer a moment to finish a possible re-bundle, then load once more.
  await page.waitForTimeout(1500);
  await page.goto(`${baseURL}/#/__gallery?static=1`);
  await page.waitForLoadState("networkidle");
  await browser.close();
}
