/**
 * E2E: the small native windows rendered outside the shell — the menu bar popover (#/menubar,
 * 360×480) and the quick palette (#/palette). In a browser the native bridge degrades to plain
 * navigation (`showMainWindow(route)` sets the hash), which these tests observe.
 * Screenshots: test-results/screens/window-*.png (light and dark).
 */
import { expect, test, type Page } from "@playwright/test";

import { approval, installMockApi, NOW, settle } from "./mock";

const shot = (name: string) => `test-results/screens/window-${name}.png`;
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function installTasks(page: Page, created: unknown[]) {
  await page.route("**/api/engine/tasks**", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      created.push(req.postDataJSON());
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "task_200", title: "x", status: "running" }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: "task_142", title: "Limit çubuklarını üst çubuğa ekle", status: "running", mode: "duo", updated_at: iso(-3) },
        { id: "task_139", title: "Ödeme webhook testlerini düzelt", status: "completed", mode: "single", updated_at: iso(-90) },
        { id: "task_131", title: "Deploy profillerini yeniden düzenle", status: "waiting", mode: "pipeline", updated_at: iso(-400) },
      ]),
    });
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`menu bar popover (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    await page.setViewportSize({ width: 360, height: 480 });
    await page.goto("/#/menubar");
    await expect(page.getByRole("heading", { name: "Kullanım limitleri" })).toBeVisible();
    await expect(page.getByRole("meter", { name: "Haftalık" }).first()).toBeVisible();
    // Production approvals never get an approve button here: they open in the app.
    const prod = page.getByRole("listitem").filter({ hasText: "VACUUM ANALYZE orders" });
    await expect(prod.getByRole("button", { name: "Uygulamada aç" })).toBeVisible();
    await expect(prod.getByRole("button", { name: "Onayla" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Etkin ajanlar" }).getByText("review/limit-bars")).toBeVisible();
    await settle(page, 1200);
    await page.screenshot({ path: shot(`menubar-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("menu bar: pause notifications, open approvals and start a new task", async ({ page }) => {
  await installMockApi(page, (s) => {
    s.approvals.push(approval("apr_4", { title: "Birleştirme onayı: limit-bars", kind: "merge", created_at: iso(-30) }));
    s.approvals.push(approval("apr_5", { title: "Son onay: görev #142", kind: "final", created_at: iso(-40) }));
  });
  await page.setViewportSize({ width: 360, height: 480 });
  await page.goto("/#/menubar");
  const bell = page.getByRole("button", { name: "Bildirimleri duraklat" });
  await bell.click();
  await expect(page.getByText("Bildirimler duraklatıldı · kritikler yine gelir")).toBeVisible();
  await expect(page.getByRole("button", { name: "Bildirimleri sürdür" })).toHaveAttribute("aria-pressed", "true");
  await settle(page, 700);
  await page.screenshot({ path: shot("menubar-paused") });
  await page.getByRole("button", { name: "Bildirimleri sürdür" }).click();

  await expect(page.getByRole("button", { name: "Tümünü gör (5)" })).toBeVisible();
  await page.getByRole("button", { name: "Uygulamada aç" }).click();
  await expect(page).toHaveURL(/#\/approvals\/apr_2$/);

  await page.goto("/#/menubar");
  await page.getByRole("button", { name: "Yeni görev" }).click();
  await expect(page).toHaveURL(/#\/\?new=1$/);
});

for (const scheme of ["light", "dark"] as const) {
  test(`quick palette window (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    await installTasks(page, []);
    await page.setViewportSize({ width: 640, height: 460 });
    await page.goto("/#/palette");
    const input = page.getByRole("textbox", { name: "Hızlı palet" });
    await expect(input).toBeFocused();
    await expect(page.getByRole("group", { name: "Son görevler" })).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`palette-${scheme}`) });
    await input.fill("odeme");
    await expect(page.getByRole("option", { name: /Yeni görev: “odeme”/ })).toHaveAttribute("aria-selected", "true");
    await settle(page, 400);
    await page.screenshot({ path: shot(`palette-search-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("quick palette: arrows, mode cycling, task creation and navigation", async ({ page }) => {
  const created: unknown[] = [];
  await installMockApi(page);
  await installTasks(page, created);
  await page.setViewportSize({ width: 640, height: 460 });
  await page.goto("/#/palette");
  const input = page.getByRole("textbox", { name: "Hızlı palet" });
  await expect(page.getByRole("group", { name: "Son görevler" })).toBeVisible();

  // Tab cycles the task mode (İkili → Yarış).
  await expect(page.getByRole("button", { name: "Mod: İkili" })).toBeVisible();
  await input.press("Tab");
  await expect(page.getByRole("button", { name: "Mod: Yarış" })).toBeVisible();

  // Arrow keys move the highlighted result; Enter opens it in the main window.
  await input.fill("bağlantı");
  await expect(page.getByRole("option", { name: /^Bağlantılar/ })).toBeVisible();
  await input.press("ArrowDown");
  await expect(page.getByRole("option", { name: /^Bağlantılar/ })).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(page).toHaveURL(/#\/connections$/);

  // A typed prompt becomes a task in the current workspace with the chosen mode.
  await page.goto("/#/palette");
  await page.getByRole("textbox", { name: "Hızlı palet" }).fill("Limit halkalarını menü çubuğuna ekle");
  const pill = page.getByRole("button", { name: /^Mod: / });
  const before = await pill.getAttribute("aria-label");
  await page.getByRole("textbox", { name: "Hızlı palet" }).press("Tab");
  await expect(pill).not.toHaveAttribute("aria-label", before ?? "");
  const label = (await pill.getAttribute("aria-label"))?.replace("Mod: ", "");
  const mode = { Tek: "single", İkili: "duo", Yarış: "race", Hat: "pipeline", Kurul: "council" }[label ?? ""];
  await page.getByRole("textbox", { name: "Hızlı palet" }).press("Enter");
  await expect(page).toHaveURL(/#\/tasks\/task_200$/);
  expect(created[0]).toMatchObject({ workspace_id: "ws_1", title: "Limit halkalarını menü çubuğuna ekle", prompt: "Limit halkalarını menü çubuğuna ekle", mode, start: true });

  // Esc first clears the query.
  await page.goto("/#/palette");
  const again = page.getByRole("textbox", { name: "Hızlı palet" });
  await again.fill("xyz");
  await again.press("Escape");
  await expect(again).toHaveValue("");
});
