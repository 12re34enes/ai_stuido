/**
 * Task list: day groups, virtualization, filters in the URL, live status, bulk cancel, keyboard,
 * queue view, empty and error states. The engine is mocked here on top of the shared mock.
 */
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import { installMockApi, NOW, settle } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const iso = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

type Json = Record<string, unknown>;

const TITLES = [
  "Limit çubuklarını üst çubuğa ekle",
  "Ödeme webhook'larına tekrar deneme ekle",
  "Fatura PDF üretimini hızlandır",
  "Kur farkı hesaplamasındaki yuvarlama hatasını düzelt",
  "Sipariş tablosuna bileşik indeks ekle",
  "Mimari tasarım: Olay kaynaklı ödeme defteri",
  "Gece bağımlılık güncellemesi",
  "İade akışına kısmi iade desteği",
  "Kart saklama servisinde loglardaki maskeleme",
  "Abonelik yenileme e-postasını sadeleştir",
];
const STATUSES = ["completed", "completed", "failed", "completed", "cancelled", "completed", "completed", "failed"];
const MODES = ["duo", "single", "pipeline", "race", "council", "duo"];

function task(id: string, over: Json = {}): Json {
  return {
    id,
    workspace_id: "ws_1",
    title: "Görev",
    prompt: "Görev",
    mode: "duo",
    flow_id: null,
    studio_id: null,
    repo_ids: null,
    base_ref: null,
    inputs: {},
    budget: null,
    priority: 0,
    status: "completed",
    scheduled_at: null,
    source: "user",
    source_ref: null,
    current_run_id: null,
    quality_score: null,
    created_at: iso(-60),
    updated_at: iso(-30),
    ...over,
  };
}

function manyTasks(n = 160): Json[] {
  const list: Json[] = [
    task("task_live", { title: "Canlı görev: limit uyarılarını sesli bildir", status: "running", created_at: iso(-12), updated_at: iso(-1) }),
    task("task_wait", { title: "Plan onayı bekleyen görev", status: "waiting", mode: "pipeline", created_at: iso(-30), updated_at: iso(-3) }),
    task("task_q1", { title: "Kuyruktaki görev: rapor dışa aktarımı", status: "queued", mode: "race", priority: 1, created_at: iso(-45) }),
    task("task_q2", { title: "Kuyruktaki görev: CSV içe aktarma", status: "queued", mode: "single", created_at: iso(-50) }),
  ];
  for (let i = 0; i < n; i++) {
    const status = STATUSES[i % STATUSES.length]!;
    list.push(
      task(`task_${1000 + i}`, {
        title: `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` #${i}` : ""}`,
        status,
        mode: MODES[i % MODES.length],
        source: i % 11 === 3 ? "schedule" : i % 13 === 5 ? "pr_watch" : "user",
        studio_id: i % 17 === 4 ? "architecture" : null,
        quality_score: status === "completed" ? 58 + ((i * 7) % 42) : null,
        repo_ids: i % 9 === 2 ? ["repo_1", "repo_2"] : null,
        created_at: iso(-90 - i * 95),
        updated_at: iso(-80 - i * 95),
      }),
    );
  }
  return list;
}

interface EngineState {
  tasks: Json[];
  cancelled: string[];
  failList: boolean;
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installEngine(page: Page, mutate?: (e: EngineState) => void): Promise<EngineState> {
  const e: EngineState = { tasks: manyTasks(), cancelled: [], failList: false };
  mutate?.(e);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/engine/tasks" && req.method() === "GET") {
      if (e.failList) return json(route, { error: { code: "internal", message: "Veritabanı kilitli, tekrar deneyin." } }, 500);
      const statuses = url.searchParams.get("status")?.split(",") ?? null;
      const mode = url.searchParams.get("mode");
      const source = url.searchParams.get("source");
      const q = url.searchParams.get("q")?.toLocaleLowerCase("tr-TR");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const list = e.tasks
        .filter((t) => !statuses || statuses.includes(t.status as string))
        .filter((t) => !mode || t.mode === mode)
        .filter((t) => !source || t.source === source)
        .filter((t) => !q || String(t.title).toLocaleLowerCase("tr-TR").includes(q))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return json(route, list.slice(offset, offset + limit));
    }
    const cancel = /^\/engine\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (cancel && req.method() === "POST") {
      const t = e.tasks.find((x) => x.id === cancel[1]);
      if (!t) return json(route, { error: { code: "not_found", message: "Görev bulunamadı" } }, 404);
      e.cancelled.push(String(t.id));
      t.status = "cancelled";
      return json(route, t);
    }
    if (path === "/engine/queue") {
      const queued = e.tasks.filter((t) => t.status === "queued");
      return json(
        route,
        queued.map((t, i) => ({ task: t, position: i + 1, hold_until: i === 0 ? iso(134) : null, hold_reason: i === 0 ? "Codex limiti dolu; limit sıfırlanınca başlayacak." : null })),
      );
    }
    if (path === "/studios") return json(route, [{ id: "architecture", name: "Mimari tasarım", description: "", icon: "blocks", version: 1, builtin: true, inputs: [], graph: { nodes: [], edges: [] } }]);
    return route.fallback();
  });
  return e;
}

/** Wheel-scroll the hovered list in small steps until the (virtualized) element is on screen. */
async function scrollUntilVisible(page: Page, target: Locator) {
  for (let i = 0; i < 30; i++) {
    if ((await target.count()) > 0 && (await target.isVisible())) {
      const box = await target.boundingBox();
      if (box && box.y > 120 && box.y < 820) return;
    }
    await page.mouse.wheel(0, 220);
    await page.waitForTimeout(80);
  }
  await expect(target).toBeInViewport();
}

async function openList(page: Page, hash = "/tasks") {
  await page.goto(`/#${hash}`);
  await expect(page.getByRole("heading", { name: "Görevler", level: 1 })).toBeVisible();
}

for (const scheme of ["light", "dark"] as const) {
  test(`task list: day groups, live dots, virtualized (${scheme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    await installEngine(page);
    await openList(page);
    const list = page.getByRole("list", { name: "Görevler" });
    await expect(list.getByRole("heading", { name: "Bugün" })).toBeVisible();
    await expect(list.getByRole("link", { name: "Aç: Canlı görev: limit uyarılarını sesli bildir" })).toBeVisible();
    // Virtualized: far fewer rows in the DOM than tasks loaded.
    const rendered = await list.getByRole("listitem").count();
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(60);
    await settle(page, 900);
    await page.screenshot({ path: shot(`tasks-list-${scheme}`) });

    // Scrolling reveals older days (2026-10-03 is a Saturday: Dün = Friday, then Perşembe…).
    await list.hover();
    await scrollUntilVisible(page, list.getByRole("heading", { name: "Dün" }));
    await scrollUntilVisible(page, list.getByRole("heading", { name: "Perşembe" }));
    await settle(page, 400);
    await page.screenshot({ path: shot(`tasks-list-scrolled-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("filters live in the URL and hit the server", async ({ page }) => {
  await installMockApi(page);
  await installEngine(page);
  await openList(page);
  await page.getByRole("button", { name: /^Durum/ }).click();
  await page.getByRole("option", { name: "Başarısız" }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/status=failed/);
  const list = page.getByRole("list", { name: "Görevler" });
  await expect(list.getByRole("img", { name: "Tamamlandı" })).toHaveCount(0);
  await expect(list.getByRole("img", { name: "Başarısız" }).first()).toBeVisible();

  await page.getByRole("searchbox").or(page.getByRole("textbox", { name: "Görevlerde ara" })).fill("indeks");
  await expect(page).toHaveURL(/q=indeks/);
  await expect(list.getByRole("link", { name: /Sipariş tablosuna bileşik indeks ekle/ }).first()).toBeVisible();
  await settle(page, 500);
  await page.screenshot({ path: shot("tasks-list-filtered") });

  await page.getByRole("textbox", { name: "Görevlerde ara" }).fill("böyle bir görev yok");
  await expect(page.getByText("Bu filtrelere uyan görev yok")).toBeVisible();
  await page.getByRole("button", { name: "Filtreleri temizle" }).first().click();
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(list.getByRole("heading", { name: "Bugün" })).toBeVisible();
});

test("bulk cancel: select rows, cancel the cancellable ones", async ({ page }) => {
  await installMockApi(page);
  const engine = await installEngine(page);
  await openList(page);
  const list = page.getByRole("list", { name: "Görevler" });
  await list.getByRole("checkbox", { name: "Seç: Canlı görev: limit uyarılarını sesli bildir" }).click();
  await list.getByRole("checkbox", { name: "Seç: Kuyruktaki görev: rapor dışa aktarımı" }).click();
  await list.getByRole("checkbox", { name: /^Seç: Limit çubuklarını üst çubuğa ekle$/ }).click();
  const bar = page.getByRole("toolbar", { name: "3 görev seçildi" });
  await expect(bar).toBeVisible();
  await settle(page, 500);
  await page.screenshot({ path: shot("tasks-list-bulk") });
  await bar.getByRole("button", { name: /İptal et/ }).click();
  await expect(page.getByText("2 görev iptal edildi")).toBeVisible();
  expect(engine.cancelled.sort()).toEqual(["task_live", "task_q1"]);
  await expect(bar).toBeHidden();
  await expect(list.getByRole("link", { name: "Aç: Canlı görev: limit uyarılarını sesli bildir" }).locator("..").getByRole("img", { name: "İptal edildi" })).toBeVisible();
});

test("live status: task.updated morphs the row's dot", async ({ page }) => {
  const api = await installMockApi(page);
  const engine = await installEngine(page);
  await openList(page);
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Aç: Canlı görev: limit uyarılarını sesli bildir" }) });
  await expect(row.getByRole("img", { name: "Çalışıyor" })).toBeVisible();
  api.push("task.updated", { status: "waiting", task_id: "task_live" }, { task_id: "task_live" });
  await expect(row.getByRole("img", { name: "Seni bekliyor" })).toBeVisible();
  const live = engine.tasks.find((t) => t.id === "task_live")!;
  Object.assign(live, { status: "completed", quality_score: 91 });
  api.push("task.completed", { title: "Canlı görev", quality_score: 91 }, { task_id: "task_live" });
  await expect(row.getByRole("img", { name: "Tamamlandı" })).toBeVisible();
  await expect(row.getByLabel("Kalite puanı 91")).toBeVisible();
});

test("keyboard: arrows move, Enter opens the task with the shared transition", async ({ page }) => {
  await installMockApi(page);
  await installEngine(page);
  await openList(page);
  const first = page.getByRole("link", { name: "Aç: Canlı görev: limit uyarılarını sesli bildir" });
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("link", { name: "Aç: Plan onayı bekleyen görev" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/tasks\/task_wait$/);
  await expect(page.getByText("Görev task_wait")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Görevler", level: 1 })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`queue view: positions, holds, remove from queue (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    const engine = await installEngine(page);
    await openList(page, "/tasks?view=queue");
    const queue = page.getByRole("list", { name: "Kuyruk" });
    await expect(queue.getByRole("link", { name: "Kuyruktaki görev: rapor dışa aktarımı" })).toBeVisible();
    await expect(queue.getByText(/sonra başlayacak · Codex limiti dolu/)).toBeVisible();
    await expect(queue.getByText("Öncelik +1")).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`tasks-queue-${scheme}`) });
    if (scheme === "light") {
      const row = queue.getByRole("listitem").filter({ hasText: "CSV içe aktarma" });
      await row.hover();
      await row.getByRole("button", { name: "Kuyruktan çıkar" }).click();
      await expect(page.getByText("Görev kuyruktan çıkarıldı")).toBeVisible();
      expect(engine.cancelled).toEqual(["task_q2"]);
      await expect(queue.getByText("CSV içe aktarma")).toBeHidden();
    }
  });
}

test("empty workspace shows a helpful call to action", async ({ page }) => {
  await installMockApi(page);
  await installEngine(page, (e) => {
    e.tasks = [];
  });
  await openList(page);
  await expect(page.getByText("Henüz görev yok")).toBeVisible();
  await settle(page, 500);
  await page.screenshot({ path: shot("tasks-list-empty") });
  await page.getByRole("button", { name: "İlk görevi başlat" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("textbox", { name: "Görev" })).toBeFocused();
});

test("load error shows a Turkish message with retry", async ({ page }) => {
  await installMockApi(page);
  const engine = await installEngine(page, (e) => {
    e.failList = true;
  });
  await openList(page);
  await expect(page.getByText("Görevler yüklenemedi")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Veritabanı kilitli, tekrar deneyin.")).toBeVisible();
  engine.failList = false;
  await page.getByRole("button", { name: "Tekrar dene" }).click();
  await expect(page.getByRole("list", { name: "Görevler" }).getByRole("heading", { name: "Bugün" })).toBeVisible();
});
