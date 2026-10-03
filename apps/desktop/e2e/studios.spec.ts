/**
 * Studios e2e: gallery → studio page (shared-element transition), generated run form with Turkish
 * validation → instantiate preview → task creation, the output reader, and the YAML editor with
 * live validation, saving and version history. The eight built-ins come from the real backend
 * YAML files (parsed with the feature's own parser); everything else is mocked here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import { parseYaml } from "../src/features/studios/yaml";
import { installMockApi, NOW, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

type Json = Record<string, unknown>;

const BUILTIN_DIR = join(process.cwd(), "../../backend/src/aistudio/studios/builtin");
const ORDER = ["architecture", "market-analysis", "design", "database", "code-review", "debugging", "documentation", "proposal"];

function loadBuiltins(): Json[] {
  const studios = readdirSync(BUILTIN_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => parseYaml(readFileSync(join(BUILTIN_DIR, f), "utf8")).value as Json);
  return studios.sort((a, b) => ORDER.indexOf(String(a.id)) - ORDER.indexOf(String(b.id)));
}

const CUSTOM: Json = {
  id: "guvenlik-denetimi",
  name: "Güvenlik denetimi",
  description: "Claude tehdit modelini çıkarır, Codex bulguları doğrular; sonuç önem dereceli bir güvenlik raporudur.",
  icon: "shield-check",
  version: 1,
  builtin: false,
  inputs: [{ name: "scope", label: "Kapsam", type: "textarea", required: true, help: "Hangi servis ya da değişiklik incelenecek?" }],
  graph: {
    settings: { gates: { plan_approval: false, boundary_check: false, build_test: false, cross_review: true, user_final: true } },
    nodes: [
      { id: "threats", label: "Tehdit modeli", position: { x: 0, y: 0 }, config: { kind: "advisor", provider: "claude", perspective: "Saldırgan gözüyle", prompt_template: "{{ input.scope }}" } },
      { id: "verify", label: "Doğrulama", position: { x: 300, y: 0 }, config: { kind: "advisor", provider: "codex", perspective: "Bulguları koddan doğrular", prompt_template: "{{ nodes.threats.output }}" } },
      { id: "report", label: "Rapor", position: { x: 600, y: 0 }, config: { kind: "synthesis", provider: "claude", prompt_template: "{{ nodes.verify.output }}" } },
      { id: "final", label: "Son onay", position: { x: 900, y: 0 }, config: { kind: "gate", gate: "user_final" } },
    ],
    edges: [
      { id: "e1", source: "threats", target: "verify" },
      { id: "e2", source: "verify", target: "report" },
      { id: "e3", source: "report", target: "final" },
    ],
  },
  output_format: "markdown",
  output_template: "{{ nodes.report.output }}\n",
};

const ADR = `---
title: Bildirimler kuyruk üzerinden gönderilsin
---

# Bildirimler kuyruk üzerinden gönderilsin

Yerini aldığı karar: yok

## Bağlam

Ödeme servisi her başarılı ödemede **e-posta**, **SMS** ve **push** bildirimi gönderiyor. Bugün bu çağrılar istek sırasında, doğrudan yapılıyor; sağlayıcılardan biri yavaşladığında ödeme yanıtı da yavaşlıyor.

## Karar kriterleri

1. Ödeme yanıt süresi bildirim sağlayıcılarından bağımsız olmalı.
2. Hiçbir bildirim kaybolmamalı; en az bir kez teslim edilmeli.
3. İşletme yükü ekibin bugünkü araçlarıyla taşınabilir olmalı.

## Değerlendirilen seçenekler

| Seçenek | Güvenilirlik | Maliyet | Geliştirme hızı |
|---|---|---|---|
| Doğrudan çağrı | 2 | 5 | 5 |
| Kuyruk (SQS) | 5 | 4 | 4 |
| Olay akışı (Kafka) | 5 | 2 | 2 |

## Karar

Bildirimler **SQS kuyruğuna** yazılır; ayrı bir işçi kuyruğu tüketir ve sağlayıcılara gönderir. Ödeme akışı yalnız kuyruğa yazmayı bekler.

> Kuyruk, sağlayıcı arızasını ödeme akışından yalıtır; Kafka bugünkü ölçek için gereğinden ağır.

## Sonuçlar

- Ödeme yanıtı bildirimlerden bağımsızlaşır.
- Yeniden deneme ve ölü mektup kuyruğu kendiliğinden gelir.
- Bir işçi servisi daha işletilir.

## Uygulama adımları

1. \`notifications\` kuyruğunu ve ölü mektup kuyruğunu oluştur.
2. Ödeme akışında doğrudan çağrıları \`enqueue_notification()\` ile değiştir.
3. İşçiyi yaz; idempotency anahtarıyla tekrarları engelle.

\`\`\`python
def enqueue_notification(payment_id: str, kind: str) -> None:
    queue.send(body={"payment_id": payment_id, "kind": kind}, dedup_id=f"{payment_id}:{kind}")
\`\`\`

## Açık sorular

- SMS sağlayıcısının hız sınırı işçi tarafında nasıl uygulanacak?
`;

interface StudioMockState {
  versions: Record<string, { version: number; studio: Json; note: string | null; created_at: string | null; builtin: boolean }[]>;
  saves: { method: string; studio: Json; note: string | null }[];
  instantiate: Json[];
  tasks: Json[];
  created: Json[];
  validateWarning: boolean;
  /** When set, instantiate answers with these field errors. */
  serverFieldErrors: Record<string, string> | null;
}

function latest(state: StudioMockState, id: string) {
  const list = state.versions[id];
  return list?.[list.length - 1];
}

function studioAt(entry: { version: number; studio: Json; builtin: boolean }) {
  return { ...entry.studio, version: entry.version, builtin: entry.builtin };
}

function architectureTask(id: string, status: string, outputs: Record<string, string>): Json {
  const arch = loadBuiltins().find((s) => s.id === "architecture")!;
  return {
    task: {
      id,
      workspace_id: "ws_1",
      title: status === "completed" ? "Bildirim servisi kuyruk tabanlı mı olmalı?" : "Arama altyapısı: Postgres mi, OpenSearch mi?",
      prompt: "Bildirim servisi kuyruk tabanlı mı olmalı, doğrudan çağrıyla mı?",
      mode: "custom",
      studio_id: "architecture",
      inputs: { question: "Bildirim servisi kuyruk tabanlı mı olmalı?" },
      status,
      source: "studio",
      source_ref: { studio_id: "architecture", version: 1 },
      current_run_id: `run_${id}`,
      created_at: iso(-180),
      updated_at: status === "completed" ? iso(-95) : iso(-3),
    },
    current_run: {
      id: `run_${id}`,
      task_id: id,
      workspace_id: "ws_1",
      graph: { ...(arch.graph as Json), inputs: { question: "Bildirim servisi kuyruk tabanlı mı olmalı?", quality_attributes: "Güvenilirlik, maliyet" } },
      status: status === "completed" ? "completed" : "running",
      nodes: Object.entries(outputs).map(([node_id, output], i) => ({ id: `nr_${i}`, run_id: `run_${id}`, node_id, status: "passed", attempt: 1, output, started_at: iso(-170), finished_at: iso(-100) })),
      started_at: iso(-175),
      finished_at: status === "completed" ? iso(-95) : null,
    },
    error: null,
  };
}

async function installStudioMocks(page: Page, mutate?: (s: StudioMockState) => void): Promise<{ api: MockApi; state: StudioMockState }> {
  const api = await installMockApi(page);
  const builtins = loadBuiltins();
  const state: StudioMockState = {
    versions: {},
    saves: [],
    instantiate: [],
    tasks: [],
    created: [],
    validateWarning: true,
    serverFieldErrors: null,
  };
  for (const b of builtins) state.versions[String(b.id)] = [{ version: 1, studio: b, note: null, created_at: null, builtin: true }];
  // An edited built-in and a custom studio with history.
  const review = builtins.find((b) => b.id === "code-review")!;
  state.versions["code-review"]!.push({ version: 2, studio: { ...review, description: `${review.description} PR yorumları Türkçe yazılır.` }, note: "PR yorum dili Türkçe", created_at: iso(-60 * 26), builtin: false });
  state.versions[CUSTOM.id as string] = [
    { version: 1, studio: { ...CUSTOM, description: "İlk taslak." }, note: "İlk sürüm", created_at: iso(-60 * 50), builtin: false },
    { version: 2, studio: CUSTOM, note: "Doğrulama adımı eklendi", created_at: iso(-60 * 3), builtin: false },
  ];
  state.tasks = [
    architectureTask("task_801", "completed", {
      advisor_claude: "## Öneri\n\nKuyruk tabanlı mimari.",
      advisor_codex: "## Öneri\n\nSQS ile başlanmalı.",
      counter: "## Zayıf varsayımlar\n\nTeslim garantisi abartılıyor.",
      synthesis: ADR,
    }),
    architectureTask("task_802", "running", { advisor_claude: "## Öneri\n\nPostgres tam metin araması yeterli." }),
  ];
  mutate?.(state);

  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();

    if (path === "/studios" && method === "GET") {
      const ids = [...ORDER, ...Object.keys(state.versions).filter((id) => !ORDER.includes(id))];
      return json(route, ids.map((id) => studioAt(latest(state, id)!)));
    }
    if (path === "/studios" && method === "POST") {
      const body = req.postDataJSON() as { studio: Json; note: string | null };
      state.saves.push({ method, studio: body.studio, note: body.note });
      const entry = { version: 1, studio: body.studio, note: body.note, created_at: iso(0), builtin: false };
      state.versions[String(body.studio.id)] = [entry];
      return json(route, { ...studioAt(entry), updated_at: iso(0) }, 201);
    }
    if (path === "/studios/validate-studio" && method === "POST") {
      const studio = req.postDataJSON() as { id: string; graph: { nodes: { id: string }[]; edges: { id: string; source: string; target: string }[] } };
      const ids = new Set(studio.graph.nodes.map((n) => n.id));
      const errors = studio.graph.edges
        .filter((e) => !ids.has(e.source) || !ids.has(e.target))
        .map((e) => ({ level: "error", code: "unknown_edge_node", message: `Bağlantı bilinmeyen bir düğüme işaret ediyor: “${ids.has(e.source) ? e.target : e.source}”.`, edge_id: e.id }));
      const warnings =
        state.validateWarning && studio.id === CUSTOM.id
          ? [{ level: "warning", code: "gate_severity", message: "“Rapor” sentezinde çıktı biçimi belirtilmemiş; varsayılan karar kaydı kullanılır.", node_id: "report" }]
          : [];
      return json(route, { ok: errors.length === 0, errors, warnings });
    }
    const studioMatch = /^\/studios\/([^/]+)(\/versions|\/instantiate)?$/.exec(path);
    if (studioMatch) {
      const id = decodeURIComponent(studioMatch[1]!);
      const list = state.versions[id];
      if (!list) return json(route, { error: { code: "not_found", message: "Stüdyo bulunamadı." } }, 404);
      if (studioMatch[2] === "/versions") {
        return json(
          route,
          [...list].reverse().map((v) => ({ studio_id: id, version: v.version, name: String(v.studio.name), builtin: v.builtin, note: v.note, created_at: v.created_at })),
        );
      }
      if (studioMatch[2] === "/instantiate") {
        const body = req.postDataJSON() as { workspace_id: string; inputs: Record<string, string> };
        state.instantiate.push(body);
        if (state.serverFieldErrors) {
          return json(route, { error: { code: "validation_failed", message: "Stüdyo girdileri eksik veya geçersiz.", details: { errors: state.serverFieldErrors } } }, 422);
        }
        const studio = latest(state, id)!.studio;
        return json(route, { ...(studio.graph as Json), inputs: body.inputs });
      }
      if (method === "PUT") {
        const body = req.postDataJSON() as { studio: Json; note: string | null };
        state.saves.push({ method, studio: body.studio, note: body.note });
        const entry = { version: list[list.length - 1]!.version + 1, studio: body.studio, note: body.note, created_at: iso(0), builtin: false };
        list.push(entry);
        return json(route, { ...studioAt(entry), updated_at: iso(0) });
      }
      const v = url.searchParams.get("version");
      const entry = v ? list.find((x) => x.version === Number(v)) : list[list.length - 1];
      if (!entry) return json(route, { error: { code: "not_found", message: "Stüdyonun bu sürümü bulunamadı." } }, 404);
      return json(route, studioAt(entry));
    }

    if (path === "/workspaces/ws_1/repos") {
      return json(route, [
        { id: "repo_api", workspace_id: "ws_1", name: "odeme-api", path: "/Users/demo/src/odeme-api", default_branch: "main", created_at: iso(-9000) },
        { id: "repo_web", workspace_id: "ws_1", name: "odeme-web", path: "/Users/demo/src/odeme-web", default_branch: "main", created_at: iso(-9000) },
      ]);
    }
    const branches = /^\/gitops\/repos\/([^/]+)\/branches$/.exec(path);
    if (branches) {
      return json(route, {
        repo_id: branches[1],
        default_branch: "main",
        local: [
          { name: "main", ref: "refs/heads/main", sha: "a1b2c3d", subject: "Ödeme yanıt süresi iyileştirildi", is_default: true },
          { name: "feature/coklu-para-birimi", ref: "refs/heads/feature/coklu-para-birimi", sha: "d4e5f6a", subject: "Para birimi tablosu" },
        ],
        remote: [{ name: "origin/main", ref: "refs/remotes/origin/main", sha: "a1b2c3d" }],
      });
    }
    if (path === "/deploy/profiles") {
      return json(route, [
        { id: "dp_test", workspace_id: "ws_1", name: "Test veritabanı migration", kind: "command", environment: "test", config: {}, created_at: iso(-900) },
        { id: "dp_staging", workspace_id: "ws_1", name: "Staging CI", kind: "ci", environment: "test", config: {}, created_at: iso(-900) },
        { id: "dp_prod", workspace_id: "ws_1", name: "Production migration", kind: "ssh", environment: "production", config: {}, created_at: iso(-900) },
      ]);
    }
    if (path === "/remote/hosts") return json(route, []);
    if (path === "/remote/db-profiles") return json(route, []);
    if (path === "/engine/tasks" && method === "POST") {
      const body = req.postDataJSON() as Json;
      state.created.push(body);
      return json(route, { task: { id: "task_901", ...body, status: "queued", created_at: iso(0), updated_at: iso(0) }, runs: [], current_run: null }, 201);
    }
    if (path === "/engine/tasks" && method === "GET") return json(route, state.tasks.map((t) => t.task));
    const task = /^\/engine\/tasks\/([^/]+)$/.exec(path);
    if (task) {
      const t = state.tasks.find((x) => (x.task as Json).id === task[1]);
      return t ? json(route, t) : json(route, { error: { code: "not_found", message: "Görev bulunamadı." } }, 404);
    }
    if (/^\/engine\/runs\/[^/]+\/evidence$/.test(path)) return json(route, []);
    return route.fallback();
  });
  return { api, state };
}

async function openStudios(page: Page, hash = "/studios") {
  await page.goto(`/#${hash}`);
  await expect(page.getByRole("navigation", { name: "Gezinme" })).toBeVisible();
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED|status of 4\d\d/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

for (const scheme of ["light", "dark"] as const) {
  test(`gallery, studio page and reader render (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installStudioMocks(page);
    await openStudios(page);
    await expect(page.getByRole("heading", { name: "Stüdyolar", level: 1 })).toBeVisible();
    await expect(page.locator("[data-studio-card]")).toHaveCount(9);
    await expect(page.getByRole("link", { name: /Mimari tasarım/ })).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`studios-gallery-${scheme}`), fullPage: false });

    await page.locator('[data-studio-card="architecture"]').hover();
    await settle(page, 400);
    await page.screenshot({ path: shot(`studios-card-hover-${scheme}`), clip: { x: 236, y: 48, width: 1204, height: 480 } });

    await page.locator('[data-studio-card="database"]').click();
    await expect(page).toHaveURL(/#\/studios\/database$/);
    await page.waitForTimeout(160);
    await page.screenshot({ path: shot(`studios-transition-${scheme}`) });
    await expect(page.getByRole("heading", { name: "Veritabanı", level: 1 })).toBeVisible();
    await expect(page.getByRole("img", { name: "Veritabanı: Akış" })).toBeVisible();
    await settle(page, 1100);
    await page.screenshot({ path: shot(`studios-detail-${scheme}`) });

    await openStudios(page, "/studios/architecture/outputs/task_801");
    await expect(page.getByRole("heading", { name: "Bildirimler kuyruk üzerinden gönderilsin", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "İçindekiler" })).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`studios-reader-${scheme}`) });

    await openStudios(page, "/studios/architecture/edit");
    await expect(page.locator(".cm-content")).toContainText("id: architecture");
    await expect(page.getByText("Şablon geçerli").first()).toBeVisible();
    await settle(page, 600);
    await page.screenshot({ path: shot(`studios-editor-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("run form: Turkish validation, pickers filtered by environment, preview, task creation", async ({ page }) => {
  const { state } = await installStudioMocks(page);
  await openStudios(page, "/studios/database");
  const form = page.getByRole("complementary", { name: "Çalıştır" });
  await expect(form.getByText("Şema değişikliği")).toBeVisible();

  await form.getByRole("button", { name: "Önizle" }).click();
  await expect(form.getByText("“Şema değişikliği” alanı zorunlu.")).toBeVisible();
  await expect(form.getByText("“Repo” alanı zorunlu.")).toBeVisible();
  await expect(form.getByText("“Test ortamı profili” alanı zorunlu.")).toBeVisible();
  expect(state.instantiate).toHaveLength(0);
  await settle(page, 500);
  await page.screenshot({ path: shot("studios-run-errors") });

  await form.locator("#studio-input-change").fill("Siparişlere çoklu para birimi desteği eklensin.");
  await expect(form.getByText("“Şema değişikliği” alanı zorunlu.")).toBeHidden();
  await form.getByRole("button", { name: "Repo" }).click();
  await page.getByRole("menuitemradio", { name: /odeme-api/ }).click();

  await form.getByRole("button", { name: "Test ortamı profili" }).click();
  // Only test-environment profiles are offered for a test-pinned input.
  await expect(page.getByRole("menuitemradio", { name: /Test veritabanı migration/ })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: /Production migration/ })).toHaveCount(0);
  await page.getByRole("menuitemradio", { name: /Test veritabanı migration/ }).click();

  await page.keyboard.press(`${mod}+Enter`);
  await expect(form.getByRole("heading", { name: "Önizleme" })).toBeVisible();
  await expect(form.locator("dl").getByText("odeme-api")).toBeVisible();
  expect(state.instantiate[0]).toEqual({
    workspace_id: "ws_1",
    inputs: { change: "Siparişlere çoklu para birimi desteği eklensin.", dialect: "PostgreSQL", repo: "repo_api", test_deploy_profile: "dp_test" },
  });
  await settle(page, 600);
  await page.screenshot({ path: shot("studios-run-preview") });

  await form.getByRole("button", { name: /Görevi başlat/ }).click();
  await expect(page).toHaveURL(/#\/tasks\/task_901$/);
  expect(state.created[0]).toMatchObject({
    workspace_id: "ws_1",
    title: "Veritabanı: Siparişlere çoklu para birimi desteği eklensin.",
    studio_id: "database",
    source: "studio",
    source_ref: { studio_id: "database", version: 1 },
    inputs: { repo: "repo_api", test_deploy_profile: "dp_test" },
  });
});

test("run form: server field errors land on their fields", async ({ page }) => {
  await installStudioMocks(page, (s) => {
    s.serverFieldErrors = { question: "Bu soru çok kısa; en az bir cümle yazın." };
  });
  await openStudios(page, "/studios/architecture");
  const form = page.getByRole("complementary", { name: "Çalıştır" });
  await form.locator("#studio-input-question").fill("Kuyruk?");
  await form.getByRole("button", { name: "Önizle" }).click();
  await expect(form.getByText("Bu soru çok kısa; en az bir cümle yazın.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Önizle" })).toBeVisible();
});

test("studio page lists results and opens the reader; export downloads Markdown", async ({ page }) => {
  await installStudioMocks(page);
  await openStudios(page, "/studios/architecture");
  const results = page.getByRole("region", { name: "Sonuçlar" });
  await expect(results.getByRole("link", { name: "Bildirim servisi kuyruk tabanlı mı olmalı?" })).toBeVisible();
  await expect(results.getByText("Çalışıyor")).toBeVisible();
  await results.getByRole("link", { name: "Bildirim servisi kuyruk tabanlı mı olmalı?" }).click();
  await expect(page).toHaveURL(/#\/studios\/architecture\/outputs\/task_801$/);
  await expect(page.getByRole("heading", { name: "Karar kriterleri" })).toBeVisible();
  // The output template appends the advisors' opinions after the decision record.
  await expect(page.getByRole("heading", { name: "Ek C: Karşı tez" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Markdown indir" }).click();
  expect((await download).suggestedFilename()).toBe("bildirim-servisi-kuyruk-tabanli-mi-olmali.md");

  await page.getByRole("navigation", { name: "İçindekiler" }).getByRole("button", { name: "Uygulama adımları" }).click();
  await settle(page, 700);
  await page.screenshot({ path: shot("studios-reader-toc") });

  await openStudios(page, "/studios/architecture/outputs/task_802");
  await expect(page.getByText("Görev henüz tamamlanmadı")).toBeVisible();
});

test("editor: live validation, save as a new version, version diff and restore", async ({ page }) => {
  const { state } = await installStudioMocks(page);
  await openStudios(page, "/studios/guvenlik-denetimi/edit");
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("id: guvenlik-denetimi");
  // Server warning mapped to the node's line; clicking it reveals the line.
  const warning = page.getByRole("button", { name: /çıktı biçimi belirtilmemiş/ });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/satır \d+/);

  // Break the YAML structure: client-side error with a line number, save disabled.
  await editor.click();
  await page.keyboard.press(`${mod}+Home`);
  await page.keyboard.type("x");
  await expect(page.getByText("“id” alanı metin olarak yazılmalı.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Kaydet/ })).toBeDisabled();
  await settle(page, 500);
  await page.screenshot({ path: shot("studios-editor-error") });
  await page.keyboard.press("Backspace");
  await expect(page.getByText("“id” alanı metin olarak yazılmalı.")).toBeHidden();

  // A real change, saved as version 3 with a note.
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type("# not: rapor şablonu");
  await expect(page.getByText("Kaydedilmemiş değişiklikler")).toBeVisible();
  await page.keyboard.press(`${mod}+s`);
  const dialog = page.getByRole("dialog", { name: "Yeni sürümü kaydet" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Sürüm notu").fill("Rapor şablonu notu");
  await settle(page, 300);
  await page.screenshot({ path: shot("studios-editor-save") });
  await dialog.getByRole("button", { name: "Sürüm 3 olarak kaydet" }).click();
  await expect(page.getByText("Sürüm 3 kaydedildi").first()).toBeVisible();
  expect(state.saves[0]).toMatchObject({ method: "PUT", note: "Rapor şablonu notu", studio: { id: "guvenlik-denetimi", name: "Güvenlik denetimi" } });
  await expect(page.getByText("Kaydedilmemiş değişiklikler")).toBeHidden();

  // Version history: diff v1 → current and restore v1 as a new version.
  await page.getByRole("tab", { name: "Sürümler" }).click();
  await page.getByRole("button", { name: /v1 İlk sürüm/ }).click();
  await expect(page.locator(".cm-mergeView, .cm-changedLine, .cm-deletedChunk").first()).toBeVisible();
  await settle(page, 700);
  await page.screenshot({ path: shot("studios-editor-versions") });
  await page.getByRole("button", { name: "Bu sürüme dön" }).click();
  const confirm = page.getByRole("dialog", { name: "Sürüm 1'e dönülsün mü?" });
  await confirm.getByRole("button", { name: "Bu sürüme dön" }).click();
  await expect(page.getByText("Sürüm 1'e dönüldü").first()).toBeVisible();
  expect(state.saves[1]).toMatchObject({ method: "PUT", note: "Sürüm 1'e geri dönüldü", studio: { description: "İlk taslak." } });
});

test("new studio from a template opens the editor and creates it", async ({ page }) => {
  const { state } = await installStudioMocks(page);
  await openStudios(page);
  await page.getByRole("button", { name: "Yeni stüdyo" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Yeni stüdyo" });
  await dialog.getByLabel(/^Ad/).fill("Sızma testi planı");
  await expect(dialog.getByLabel(/^Kimlik/)).toHaveValue("sizma-testi-plani");
  await dialog.getByRole("radio", { name: /Kod inceleme/ }).click();
  await settle(page, 300);
  await page.screenshot({ path: shot("studios-new-dialog") });
  await dialog.getByRole("button", { name: "Düzenleyicide aç" }).click();
  await expect(page).toHaveURL(/#\/studios\/_new\?/);
  await expect(page.locator(".cm-content")).toContainText("id: sizma-testi-plani");
  await expect(page.locator(".cm-content")).toContainText("name: Sızma testi planı");
  await expect(page.getByText("Şablon geçerli").first()).toBeVisible();
  await page.getByRole("button", { name: /^Stüdyoyu oluştur/ }).click();
  await page.getByRole("dialog", { name: "Stüdyoyu oluştur" }).getByRole("button", { name: "Stüdyoyu oluştur" }).click();
  await expect(page).toHaveURL(/#\/studios\/sizma-testi-plani$/);
  expect(state.saves[0]).toMatchObject({ method: "POST", studio: { id: "sizma-testi-plani", name: "Sızma testi planı" } });
  await expect(page.getByRole("heading", { name: "Sızma testi planı", level: 1 })).toBeVisible();
});

test("live studio.saved refreshes the gallery; palette opens a studio", async ({ page }) => {
  const { api, state } = await installStudioMocks(page);
  await openStudios(page);
  await expect(page.locator("[data-studio-card]")).toHaveCount(9);
  state.versions["olay-sonrasi"] = [{ version: 1, studio: { ...CUSTOM, id: "olay-sonrasi", name: "Olay sonrası inceleme", icon: "file-text" }, note: null, created_at: iso(0), builtin: false }];
  api.push("studio.saved", { studio_id: "olay-sonrasi", version: 1, name: "Olay sonrası inceleme" });
  await expect(page.locator('[data-studio-card="olay-sonrasi"]')).toBeVisible();

  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.type("piyasa");
  await page.getByRole("option", { name: /Stüdyo: Piyasa analizi/ }).click();
  await expect(page).toHaveURL(/#\/studios\/market-analysis$/);
});
