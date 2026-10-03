/**
 * Teams (spec §25): list, org-chart builder, the composer's Ekip mode and the flow editor's team
 * node, against the mocked team API (e2e/teams-mock.ts). Light and dark screenshots go to
 * test-results/screens/.
 */
import { expect, test, type Page } from "@playwright/test";

import { settle } from "./mock";
import { installTeamApi, iso, json, type Json } from "./teams-mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const mod = process.platform === "darwin" ? "Meta" : "Control";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED|status of 404|status of 500/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

const card = (page: Page, id: string) => page.getByTestId(`member-${id}`);

// ----------------------------------------------------------------------------- list

for (const scheme of ["light", "dark"] as const) {
  test(`teams list (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installTeamApi(page);
    await page.goto("/#/teams");
    await expect(page.getByRole("heading", { level: 1, name: "Ekipler" })).toBeVisible();
    await expect(page.getByTestId("team-card-team_web")).toBeVisible();
    await expect(page.getByTestId("builtin-grid").getByRole("heading", { name: "Danışmanlı ekip" })).toBeVisible();
    await expect(page.getByTestId("team-card-danismanli-ekip").getByText("1 danışman · 4 üye")).toBeVisible();
    await expect(page.getByTestId("team-card-arayuz-test-ekibi").getByText("3 üye · 2 test")).toBeVisible();
    await expect(page.getByTestId("team-card-team_web").getByText("1 danışman · 6 üye · 2 test")).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`teams-list-${scheme}`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("start a task with a team from the list", async ({ page }) => {
  const { sc } = await installTeamApi(page);
  await page.goto("/#/teams");
  const c = page.getByTestId("team-card-hizli-ekip");
  await c.hover();
  await page.getByTestId("team-start-hizli-ekip").click();
  const dialog = page.getByRole("dialog", { name: "Bu ekiple görev başlat" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Görev" }).fill("Ödeme formuna kart doğrulaması ekle");
  await dialog.getByTestId("team-start-submit").click();
  await expect(page.getByText("Görev başlatıldı")).toBeVisible();
  expect(sc.tasks).toHaveLength(1);
  expect(sc.tasks[0]).toMatchObject({ workspace_id: "ws_1", mode: "team", team_id: "hizli-ekip", title: "Ödeme formuna kart doğrulaması ekle", start: true });
  expect(sc.tasks[0]!.team ?? null).toBeNull();
});

test("palette has the team commands", async ({ page }) => {
  await installTeamApi(page);
  await page.goto("/#/teams");
  await expect(page.getByTestId("teams-list")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("ekip");
  await expect(palette.getByRole("option", { name: /Yeni ekip/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /^Ekipler/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Bu ekiple görev başlat: Hızlı ekip/ })).toBeVisible();
  await palette.getByRole("option", { name: /Yeni ekip/ }).click();
  await expect(page.getByTestId("team-builder-page")).toBeVisible();
});

// ----------------------------------------------------------------------------- builder

test("build a team: add, configure, re-parent, undo, validate, save", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  const { sc } = await installTeamApi(page);
  await page.goto("/#/teams/new");
  await expect(card(page, "lead")).toBeVisible();
  await expect(page.getByTestId("builder-empty-hint")).toBeVisible();

  // "+" on the lead → sub-agent springs in, selected, inspector open.
  await card(page, "lead").hover();
  await page.getByTestId("add-lead").click();
  await page.getByRole("menuitem", { name: "Alt ajan ekle" }).click();
  await expect(card(page, "dev-1")).toBeVisible();
  const inspector = page.getByTestId("member-inspector");
  await expect(inspector).toBeVisible();
  await inspector.getByRole("textbox", { name: "Ad" }).fill("Arayüz");
  await inspector.getByRole("radio", { name: "Codex" }).click();
  await inspector.getByRole("radio", { name: "Yüksek" }).click();
  await expect(card(page, "dev-1")).toContainText("Arayüz");
  await expect(card(page, "dev-1").getByRole("img", { name: "Efor: Yüksek" })).toBeVisible();

  // Keyboard: select the lead, "+" adds another member, "T" a dependent tester.
  await card(page, "lead").click();
  await page.keyboard.press("+");
  await expect(card(page, "dev-2")).toBeVisible();
  await page.keyboard.press("t");
  await expect(card(page, "qa-1")).toBeVisible();
  await expect(page.getByTestId("member-inspector").getByText("Test ettiği üye")).toBeVisible();

  // Advisor from the tool row (the lead is the anchor when nothing manager-like is selected).
  await card(page, "lead").click();
  await page.getByRole("button", { name: "Danışman ekle" }).click();
  await expect(card(page, "advisor-1")).toBeVisible();
  await expect(page.getByTestId("team-summary")).toContainText("1 danışman");

  // Drag dev-2 onto dev-1: re-parent (valid target highlighted while dragging).
  const from = await card(page, "dev-2").boundingBox();
  const to = await card(page, "dev-1").boundingBox();
  if (!from || !to) throw new Error("no boxes");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 20, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 4, { steps: 12 });
  await expect(page.getByText("Arayüz altına taşı")).toBeVisible();
  await page.mouse.up();
  await card(page, "dev-2").click();
  await expect(page.getByTestId("member-inspector").getByRole("button", { name: "Yöneticisi" })).toContainText("Arayüz");

  // Undo / redo the move.
  await page.getByTestId("team-builder-canvas").click({ position: { x: 30, y: 300 } });
  await page.keyboard.press(`${mod}+z`);
  await card(page, "dev-2").click();
  await expect(page.getByTestId("member-inspector").getByRole("button", { name: "Yöneticisi" })).toContainText("Lider");
  await page.getByTestId("team-builder-canvas").click({ position: { x: 30, y: 300 } });
  await page.keyboard.press(`${mod}+Shift+z`);
  await card(page, "dev-2").click();
  await expect(page.getByTestId("member-inspector").getByRole("button", { name: "Yöneticisi" })).toContainText("Arayüz");

  // Live validation: an empty name gets an inline error marker from the server check.
  await page.getByTestId("member-inspector").getByRole("textbox", { name: "Ad" }).fill("");
  await expect(page.getByTestId("issue-dev-2")).toBeVisible();
  await expect(page.getByTestId("team-validation")).toContainText("1 hata");
  await page.getByTestId("member-inspector").getByRole("textbox", { name: "Ad" }).fill("Form doğrulama");
  await expect(page.getByTestId("issue-dev-2")).toHaveCount(0);
  expect(sc.validated.length).toBeGreaterThan(0);

  // Team settings.
  await page.getByTestId("tool-settings").click();
  const settingsPanel = page.getByTestId("team-settings");
  await settingsPanel.getByRole("radio", { name: "Periyodik" }).click();
  await expect(settingsPanel.getByRole("textbox", { name: "Aralık" })).toBeVisible();

  // Name and save → POST, then the URL becomes the team's.
  await page.getByRole("textbox", { name: "Ekip adı" }).fill("Kart ödemeleri ekibi");
  await page.getByTestId("team-save").click();
  await expect(page.getByText("Ekip oluşturuldu")).toBeVisible();
  await expect(page).toHaveURL(/#\/teams\/team_new_1\/edit$/);
  expect(sc.created).toHaveLength(1);
  const body = sc.created[0]! as { name: string; spec: { members: Json[]; settings: Json } };
  expect(body.name).toBe("Kart ödemeleri ekibi");
  expect(body.spec.settings).toMatchObject({ report_mode: "periodic" });
  const byId = Object.fromEntries(body.spec.members.map((m) => [m.id, m]));
  expect(byId["dev-1"]).toMatchObject({ name: "Arayüz", provider: "codex", effort: "high", parent_id: "lead" });
  expect(byId["dev-2"]).toMatchObject({ name: "Form doğrulama", parent_id: "dev-1" });
  expect(byId["qa-1"]).toMatchObject({ role: "tester", tests_member_id: "dev-2", test_mode: "dependent" });
  expect(byId["advisor-1"]).toMatchObject({ role: "advisor", parent_id: "lead", writes: false });
  expect(body.spec.members.every((m) => m.position !== null)).toBe(true);
  await expect(page.getByTestId("team-save-state")).toContainText("Kaydedildi");
  expect(errors).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`team builder (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    const { sc } = await installTeamApi(page);
    await page.goto("/#/teams/team_web/edit");
    await expect(card(page, "dev-api")).toBeVisible();
    await expect(page.getByTestId("team-summary")).toContainText("1 danışman");
    await card(page, "dev-api").click();
    await expect(page.getByTestId("member-inspector")).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`teams-builder-${scheme}`) });

    // Edit + save a new version.
    await page.getByTestId("member-inspector").getByRole("textbox", { name: "Ad" }).fill("API geliştirici");
    await page.getByTestId("team-save").click();
    await expect(page.getByText("Ekip kaydedildi · v4")).toBeVisible();
    expect(sc.updated[0]).toMatchObject({ id: "team_web" });

    // Version history: preview an older version read-only.
    await page.getByTestId("team-versions").click();
    await page.getByRole("button", { name: /v1/ }).click();
    await expect(page.getByTestId("team-preview-banner")).toBeVisible();
    await settle(page, 600);
    await page.screenshot({ path: shot(`teams-builder-version-${scheme}`) });
    await page.getByRole("button", { name: "Güncel sürüme dön" }).click();
    await expect(page.getByTestId("team-preview-banner")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("builder: delete a subtree asks first; builtin templates save as a copy", async ({ page }) => {
  const { sc } = await installTeamApi(page);
  await page.goto("/#/teams/derin-ekip/edit");
  await expect(page.getByText("Hazır şablon · değişiklikler kopya olarak kaydedilir")).toBeVisible();
  await expect(card(page, "dev-2-b")).toBeVisible();
  await card(page, "dev-1").click();
  await page.keyboard.press("Backspace");
  const dialog = page.getByRole("dialog", { name: /Geliştirici 1" ve altındaki 2 ajan silinsin mi/ });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-delete").click();
  await expect(card(page, "dev-1-a")).toHaveCount(0);
  await expect(card(page, "dev-1")).toHaveCount(0);
  await page.getByTestId("team-save").click();
  await expect(page.getByText("Ekip oluşturuldu")).toBeVisible();
  // Built-ins are read-only (PUT would be a 409): the save creates a copy.
  expect(sc.updated).toHaveLength(0);
  expect(sc.created[0]).toMatchObject({ name: "Derin ekip (kopya)" });
  expect(((sc.created[0] as Json).spec as { members: Json[] }).members).toHaveLength(7);
});

test("builder: a save the engine refuses marks the members it names", async ({ page }) => {
  await installTeamApi(page, undefined, async (route, path) => {
    if (path !== "/engine/teams" || route.request().method() !== "POST") return false;
    await json(route, { error: { code: "validation_failed", message: "Ekip geçersiz: Test ajanının test edeceği üye yok.", details: { errors: [{ code: "tester_target", message: "Test ajanının test edeceği üye yok.", member_id: "test" }] } } }, 422);
    return true;
  });
  await page.goto("/#/teams/hizli-ekip/edit");
  await expect(card(page, "test")).toBeVisible();
  await expect(page.getByTestId("team-validation")).toContainText("Ekip geçerli");
  await page.getByTestId("team-save").click();
  await expect(page.getByText("Ekip geçersiz: Test ajanının test edeceği üye yok.")).toBeVisible();
  await expect(page.getByTestId("issue-test")).toBeVisible();
  await expect(page.getByTestId("team-validation")).toContainText("1 hata");
});

// ----------------------------------------------------------------------------- composer

async function installHome(page: Page) {
  return installTeamApi(page, undefined, async (route, path) => {
    if (path === "/engine/tasks" && route.request().method() === "GET") {
      await json(route, []);
      return true;
    }
    if (path === "/engine/modes") {
      await json(route, [
        { mode: "single", label: "Tek", description: "Tek ajan yazar." },
        { mode: "duo", label: "İkili", description: "Bir sağlayıcı yazar, diğeri inceler." },
        { mode: "race", label: "Yarış", description: "İki ajan yarışır." },
        { mode: "pipeline", label: "Hat", description: "Planlayıcıdan son onaya." },
        { mode: "council", label: "Kurul", description: "Danışmanlar görüş verir." },
      ]);
      return true;
    }
    if (/^\/engine\/modes\/[a-z]+$/.test(path)) {
      await json(route, { nodes: [{ id: "dev", label: "Geliştirici", config: { kind: "agent", provider: "claude" } }], edges: [], settings: {}, inputs: {} });
      return true;
    }
    if (path === "/engine/flows" || path === "/studios" || path === "/engine/queue") {
      await json(route, []);
      return true;
    }
    if (/^\/workspaces\/[^/]+\/repos$/.test(path)) {
      await json(route, [{ id: "repo_1", workspace_id: "ws_1", name: "odeme-servisi", path: "/Users/demo/src/odeme-servisi", host_id: null, remote_url: null, provider: null, default_branch: "main", commands: {}, created_at: iso(-9000) }]);
      return true;
    }
    return false;
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`composer Ekip mode (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    const { sc } = await installHome(page);
    await page.goto("/#/");
    await page.getByRole("radio", { name: "Ekip" }).click();
    const preview = page.getByTestId("team-mode-preview");
    await expect(preview).toBeVisible();
    // The engine's default team ("hizli-ekip") is preselected.
    await expect(preview.getByTestId("team-picker")).toContainText("Hızlı ekip");
    await expect(preview).toContainText("1 lider · 1 üye · 1 test");

    // Pick another team, customize it in the sheet, apply.
    await preview.getByTestId("team-picker").click();
    await page.getByRole("option", { name: /Arayüz ve test ekibi/ }).click();
    await expect(preview.getByTestId("team-picker")).toContainText("Arayüz ve test ekibi");
    await settle(page, 1200);
    await page.screenshot({ path: shot(`teams-composer-${scheme}`) });
    await preview.getByTestId("team-customize").click();
    const sheet = page.getByTestId("team-builder-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByTestId("member-api").click();
    await sheet.getByTestId("tool-add-worker").click();
    await expect(sheet.getByTestId("member-api-1")).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`teams-composer-sheet-${scheme}`) });
    await sheet.getByTestId("team-sheet-apply").click();
    await expect(preview.getByText("Özelleştirildi")).toBeVisible();

    // Submit: mode team, the template id and the customized spec inline.
    await page.getByRole("textbox", { name: "Görev" }).fill("Kart doğrulama hatalarını Türkçeleştir");
    await page.getByRole("textbox", { name: "Görev" }).press(`${mod}+Enter`);
    await expect.poll(() => sc.tasks.length).toBe(1);
    const body = sc.tasks[0] as { mode: string; team_id: string; team: { members: Json[] } };
    expect(body.mode).toBe("team");
    expect(body.team_id).toBe("arayuz-test-ekibi");
    expect(body.team.members.map((m) => m.id).sort()).toEqual(["api", "api-1", "e2e", "lead", "qa", "ui"]);
    expect(errors).toEqual([]);
  });
}

// ----------------------------------------------------------------------------- flows

for (const scheme of ["light", "dark"] as const) {
  test(`flow editor team node (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installTeamApi(page, undefined, async (route, path) => {
      if (/^\/workspaces\/[^/]+\/repos$/.test(path) || path === "/engine/flows" || path === "/engine/modes") {
        await json(route, []);
        return true;
      }
      return false;
    });
    await page.goto("/#/flows/new?blank=1");
    await expect(page.getByTestId("palette-team")).toBeVisible();
    await page.getByTestId("palette-team").dblclick();
    const inspector = page.getByTestId("node-inspector");
    await expect(inspector).toBeVisible();
    await expect(page.getByTestId("flow-node-team")).toContainText("Ekip seçilmedi");
    await inspector.getByRole("button", { name: "Ekip şablonu" }).click();
    await page.getByRole("menuitemradio", { name: /Danışmanlı ekip/ }).click();
    await expect(inspector.getByTestId("team-node-preview")).toBeVisible();
    await expect(page.getByTestId("flow-node-team")).toContainText("Danışmanlı ekip · 5 üye");
    await settle(page, 900);
    await page.screenshot({ path: shot(`teams-flow-node-${scheme}`) });

    // Inline edit through the builder sheet.
    await inspector.getByTestId("team-node-edit").click();
    const sheet = page.getByTestId("team-builder-sheet");
    await expect(sheet.getByTestId("member-lead")).toBeVisible();
    await sheet.getByTestId("team-sheet-apply").click();
    await expect(page.getByTestId("flow-node-team")).toContainText("Satır içi ekip · 5 üye");
    await expect(inspector.getByRole("radio", { name: "Satır içi" })).toHaveAttribute("aria-checked", "true");
    expect(errors).toEqual([]);
  });
}
