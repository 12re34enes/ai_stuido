import { expect, test, type Page } from "@playwright/test";

import { installMockApi, settle } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;

const SECTIONS = [
  "foundations",
  "buttons",
  "forms",
  "pickers",
  "surfaces",
  "badges",
  "status",
  "meters",
  "agents",
  "overlays",
  "toasts",
  "code",
  "log",
  "timeline",
  "flow",
  "shell",
];

async function openGallery(page: Page) {
  await installMockApi(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource/i.test(m.text())) errors.push(m.text());
  });
  await page.goto("/#/__gallery?static=1");
  await expect(page.getByTestId("gallery")).toBeVisible();
  return errors;
}

test("gallery: every section, light and dark side by side", async ({ page }) => {
  test.setTimeout(120_000);
  // Tall viewport so every section is fully painted on screen when captured.
  await page.setViewportSize({ width: 1440, height: 2200 });
  const errors = await openGallery(page);
  for (const id of SECTIONS) {
    const section = page.locator(`[data-section="${id}"]`);
    // Align the section under the sticky header (sections carry scroll-margin).
    await section.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await settle(page, id === "code" || id === "flow" ? 1400 : 700);
    await section.screenshot({ path: shot(`gallery-${id}`) });
  }
  expect(errors).toEqual([]);
});

test("gallery: overlays in place (light column)", async ({ page }) => {
  await openGallery(page);
  const light = page.locator('[data-section="overlays"] [data-theme-column="light"]');
  await light.scrollIntoViewIfNeeded();

  await light.getByRole("button", { name: "Açılır kart" }).click();
  await settle(page);
  await page.screenshot({ path: shot("gallery-popover") });
  await page.keyboard.press("Escape");

  await light.getByRole("button", { name: "Daha fazla" }).click();
  await expect(page.getByRole("menuitem", { name: "Düzenle" })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot("gallery-menu") });
  await page.keyboard.press("Escape");

  await light.getByRole("button", { name: "Diyalog" }).click();
  await expect(page.getByRole("dialog", { name: "Worktree silinsin mi?" })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot("gallery-dialog") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Worktree silinsin mi?" })).toBeHidden();

  await light.getByRole("button", { name: "Sayfa (sheet)" }).click();
  await expect(page.getByRole("dialog", { name: "Yeni host" })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot("gallery-sheet") });
  await page.keyboard.press("Escape");
});

test("gallery: overlays in the dark column use the dark theme", async ({ page }) => {
  await openGallery(page);
  const dark = page.locator('[data-section="overlays"] [data-theme-column="dark"]');
  await dark.scrollIntoViewIfNeeded();
  await dark.getByRole("button", { name: "Diyalog" }).click();
  const dialog = page.getByRole("dialog", { name: "Worktree silinsin mi?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("xpath=ancestor::*[@data-theme][1]")).toHaveAttribute("data-theme", "dark");
  await settle(page);
  await page.screenshot({ path: shot("gallery-dialog-dark") });
});

test("gallery: drawer opens, resizes and closes without trace", async ({ page }) => {
  await openGallery(page);
  const light = page.locator('[data-section="overlays"] [data-theme-column="light"]');
  await light.scrollIntoViewIfNeeded();
  await light.getByRole("button", { name: "Çekmeceyi aç" }).click();
  const drawer = page.getByRole("complementary", { name: "Canlı çıktı" });
  await expect(drawer).toBeVisible();
  await settle(page, 900);
  await page.screenshot({ path: shot("gallery-drawer") });
  const before = (await drawer.boundingBox())!.width;
  const handle = drawer.getByRole("separator", { name: "Genişliği ayarla" });
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 120, hb.y + hb.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await drawer.boundingBox())!.width)).toBeGreaterThan(before + 100);
  await drawer.getByRole("tab", { name: "Diff" }).click();
  await settle(page, 1200);
  await page.screenshot({ path: shot("gallery-drawer-diff") });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("gallery: toasts stack and production frame", async ({ page }) => {
  await openGallery(page);
  const light = page.locator('[data-section="toasts"] [data-theme-column="light"]');
  await light.scrollIntoViewIfNeeded();
  await light.getByRole("button", { name: "Başarılı" }).click();
  await light.getByRole("button", { name: "Uyarı" }).click();
  await light.getByRole("button", { name: "Eylemli" }).click();
  await settle(page);
  await page.screenshot({ path: shot("gallery-toasts") });
  await page.getByRole("region", { name: "Bildirimler" }).hover();
  await settle(page);
  await page.screenshot({ path: shot("gallery-toasts-expanded") });

  const shell = page.locator('[data-section="shell"] [data-theme-column="light"]');
  await shell.scrollIntoViewIfNeeded();
  await shell.getByRole("button", { name: "Production çerçevesi" }).click();
  await expect(page.getByTestId("production-frame")).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot("gallery-production-frame") });
});

test("gallery: agent card expands into detail", async ({ page }) => {
  await openGallery(page);
  const light = page.locator('[data-section="agents"] [data-theme-column="light"]');
  await light.scrollIntoViewIfNeeded();
  await light.getByRole("button", { name: /Limit çubukları/ }).first().click();
  await settle(page, 900);
  await page.screenshot({ path: shot("gallery-agent-expanded") });
  await page.getByRole("button", { name: "Kapat" }).last().click();
});

test("gallery: status dot morph sequence", async ({ page }) => {
  await openGallery(page);
  const light = page.locator('[data-section="status"] [data-theme-column="light"]');
  await light.scrollIntoViewIfNeeded();
  for (const st of ["idle", "running", "success", "error"]) {
    await light.getByRole("button", { name: st, exact: true }).click();
    await settle(page, 600);
    await light.screenshot({ path: shot(`gallery-status-${st}`) });
  }
});
