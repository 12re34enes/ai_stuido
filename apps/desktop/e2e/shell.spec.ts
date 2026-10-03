import { expect, test, type Page } from "@playwright/test";

import { approval, installMockApi, settle } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function openApp(page: Page, hash = "/") {
  await page.goto(`/#${hash}`);
  await expect(page.getByRole("navigation", { name: "Gezinme" })).toBeVisible();
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

for (const scheme of ["light", "dark"] as const) {
  test(`shell renders (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    await openApp(page);
    await expect(page.getByRole("button", { name: "Kullanım limitleri" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Etkin ajanlar" })).toBeVisible();
    await expect(page.getByText("Ödeme servisi").first()).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`shell-home-${scheme}`) });

    await page.getByRole("button", { name: "Kullanım limitleri" }).click();
    await expect(page.getByRole("dialog", { name: "Kullanım limitleri" })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`shell-limits-${scheme}`) });
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /^Onaylar/ }).click();
    await expect(page.getByRole("dialog", { name: "Onay bekleyenler" })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`shell-approvals-${scheme}`) });
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /Limit çubukları: / }).hover();
    await expect(page.getByRole("dialog", { name: "Limit çubukları" })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`shell-agent-hover-${scheme}`) });

    expect(errors).toEqual([]);
  });
}

test("approve from the inbox: counter drops, toast confirms", async ({ page }) => {
  const api = await installMockApi(page);
  await openApp(page);
  const inbox = page.getByRole("button", { name: /^Onaylar/ });
  await expect(inbox).toHaveAccessibleName(/3 onay bekliyor/);
  await inbox.click();
  const dialog = page.getByRole("dialog", { name: "Onay bekleyenler" });
  await dialog.getByRole("button", { name: "Onayla" }).first().click();
  await expect(page.getByText("Onaylandı").first()).toBeVisible();
  await expect(inbox).toHaveAccessibleName(/2 onay bekliyor/);
  expect(api.state.decisions).toEqual([{ id: "apr_1", approve: true, note: null }]);
  // The decided row slides out and is inert meanwhile.
  await expect(dialog.getByRole("listitem")).toHaveCount(2);

  // Reject with a note.
  const row = dialog.getByRole("listitem").first();
  await row.getByRole("button", { name: "Reddet" }).click();
  await row.getByPlaceholder("Not (isteğe bağlı)").fill("Önce test ortamında dene");
  await expect(row.getByRole("button", { name: "Reddet" })).toHaveCount(1);
  await settle(page, 300);
  await page.screenshot({ path: shot("shell-approvals-reject") });
  await row.getByRole("button", { name: "Reddet" }).click();
  await expect(inbox).toHaveAccessibleName(/1 onay bekliyor/);
  expect(api.state.decisions[1]).toEqual({ id: "apr_2", approve: false, note: "Önce test ortamında dene" });
});

test("live approval.requested bumps the counter", async ({ page }) => {
  const api = await installMockApi(page);
  await openApp(page);
  const inbox = page.getByRole("button", { name: /^Onaylar/ });
  await expect(inbox).toHaveAccessibleName(/3 onay bekliyor/);
  api.state.approvals.push(approval("apr_9", { title: "Deploy onayı: test ortamı", kind: "deploy" }));
  api.push("approval.requested", { approval_id: "apr_9", kind: "deploy", title: "Deploy onayı" });
  await expect(inbox).toHaveAccessibleName(/4 onay bekliyor/);
});

test("live agent.status morphs the dot", async ({ page }) => {
  const api = await installMockApi(page);
  await openApp(page);
  const dot = page.getByRole("button", { name: /Limit çubukları: Araç çalıştırıyor/ });
  await expect(dot).toBeVisible();
  api.push("agent.status", { state: "done" }, { session_id: "ses_1" });
  await expect(page.getByRole("button", { name: /Limit çubukları: Tamamlandı/ })).toBeVisible();
});

test("live limit.updated moves the bar", async ({ page }) => {
  const api = await installMockApi(page);
  await openApp(page);
  const bar = page.getByRole("meter", { name: "Claude 5 saat" });
  await expect(bar).toHaveAttribute("aria-valuenow", "42");
  api.push("limit.updated", { provider: "claude", window: "five_hour", label: "5 saat", used_percent: 81, resets_at: null, status: "warning", source: "event", observed_at: new Date().toISOString() });
  await expect(bar).toHaveAttribute("aria-valuenow", "81");
});

test("command palette: fuzzy Turkish search navigates", async ({ page }) => {
  await installMockApi(page);
  await openApp(page);
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await settle(page, 500);
  await page.screenshot({ path: shot("shell-palette") });
  await page.keyboard.type("gorev");
  await expect(palette.getByRole("option", { name: /Görevler/ })).toBeVisible();
  await settle(page, 300);
  await page.screenshot({ path: shot("shell-palette-search") });
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/#\/tasks$/);
});

test("keyboard navigation from the registry and the sidebar toggle", async ({ page }) => {
  await installMockApi(page);
  await openApp(page);
  await page.keyboard.press(`${mod}+3`);
  await expect(page).toHaveURL(/#\/flows$/);
  await page.keyboard.press(`${mod}+,`);
  await expect(page).toHaveURL(/#\/settings$/);
  await page.getByRole("button", { name: "Kenar çubuğunu daralt" }).click();
  await settle(page, 800);
  await page.screenshot({ path: shot("shell-sidebar-collapsed") });
  await page.getByRole("button", { name: "Kenar çubuğunu genişlet" }).click();
  await expect(page.getByRole("button", { name: "Kenar çubuğunu daralt" })).toBeVisible();
});

test("theme comes from settings (dark forced over a light system)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await installMockApi(page, (s) => {
    s.settings["appearance.theme"] = "dark";
  });
  await openApp(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("palette theme command applies instantly and persists", async ({ page }) => {
  const api = await installMockApi(page);
  await openApp(page);
  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.type("koyu tema");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => api.state.settings["appearance.theme"]).toBe("dark");
});

test("widgets hide when endpoints are missing", async ({ page }) => {
  await installMockApi(page, (s) => {
    s.missing = ["/limits", "/approvals", "/agents"];
  });
  await openApp(page);
  await expect(page.getByText("Ödeme servisi").first()).toBeVisible();
  await settle(page, 600);
  await expect(page.getByRole("button", { name: "Kullanım limitleri" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Onaylar/ })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Etkin ajanlar" })).toHaveCount(0);
});

test("backend down: banner appears and recovers", async ({ page }) => {
  const api = await installMockApi(page, (s) => {
    s.down = true;
  });
  await openApp(page);
  const banner = page.getByRole("alert").filter({ hasText: "Motor (studiod) çalışmıyor" });
  await expect(banner).toBeVisible({ timeout: 8000 });
  await settle(page, 500);
  await page.screenshot({ path: shot("shell-backend-down") });
  api.state.down = false;
  await banner.getByRole("button", { name: "Tekrar dene" }).click();
  await expect(banner).toBeHidden();
  await expect(page.getByText("Motor bağlantısı yeniden kuruldu")).toBeVisible();
  await expect(page.getByRole("button", { name: "Kullanım limitleri" })).toBeVisible();
});

test("menu bar and quick palette windows render outside the shell", async ({ page }) => {
  await installMockApi(page);
  await page.setViewportSize({ width: 360, height: 480 });
  await page.goto("/#/menubar");
  await expect(page.getByRole("heading", { name: "Kullanım limitleri" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Gezinme" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Kenar çubuğunu daralt" })).toHaveCount(0);
  await settle(page, 900);
  await page.screenshot({ path: shot("window-menubar") });

  await page.setViewportSize({ width: 640, height: 300 });
  await page.goto("/#/palette");
  await expect(page.getByRole("textbox", { name: "Hızlı palet" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Gezinme" })).toHaveCount(0);
  await settle(page, 400);
  await page.screenshot({ path: shot("window-palette") });
});

test("vibrancy: sidebar and popup windows turn translucent, content stays opaque", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  // What the native shell does at startup (initNativeShell) for a vibrant main window.
  const markNative = (win: string) =>
    page.evaluate((w) => {
      document.documentElement.setAttribute("data-window", w);
      document.documentElement.setAttribute("data-vibrancy", "");
    }, win);
  await installMockApi(page);
  await openApp(page);
  await markNative("main");
  const css = (sel: string, prop: string) =>
    page
      .locator(sel)
      .first()
      .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  expect(await css("html", "background-color")).toBe("rgba(0, 0, 0, 0)");
  expect(await css("[data-sidebar]", "background-color")).toBe("rgba(246, 243, 236, 0.42)");
  expect(await page.locator("main").evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor)).toBe("rgb(250, 249, 245)");

  await page.goto("/#/menubar");
  await expect(page.locator("[data-window-surface]")).toBeVisible();
  await markNative("menubar");
  expect(await css("[data-window-surface]", "background-color")).toBe("rgba(250, 249, 245, 0.74)");
});

test("deep-link targets and the new-task shortcut", async ({ page }) => {
  await installMockApi(page);
  await openApp(page, "/approvals/apr_1");
  await expect(page.locator('[data-page="approvals"]')).toBeVisible();
  await page.keyboard.press(`${mod}+n`);
  await expect(page).toHaveURL(/#\/$/);
});

test("new workspace from the switcher", async ({ page }) => {
  const api = await installMockApi(page);
  await openApp(page);
  await page.getByRole("button", { name: "Çalışma alanı değiştir" }).click();
  await page.getByRole("menuitem", { name: "Yeni çalışma alanı" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni çalışma alanı" });
  await expect(dialog).toBeVisible();
  await settle(page, 500);
  await page.screenshot({ path: shot("shell-new-workspace") });
  await dialog.getByRole("button", { name: "Oluştur" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Bir ad girin.");
  await dialog.getByLabel("Ad").fill("Veri platformu");
  await dialog.getByRole("button", { name: "Oluştur" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("banner").getByText("Veri platformu")).toBeVisible();
  expect(api.state.workspaces).toHaveLength(3);
});
