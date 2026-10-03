/**
 * Home screen: composer (modes, studio form, repos/branch, advanced), live flow strips, waiting
 * approvals, recent tasks, first-run onboarding. Engine endpoints are mocked here on top of the
 * shared studiod mock (routes registered later win).
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { installMockApi, NOW, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const iso = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

// ----------------------------------------------------------------------------- graphs (mirror engine/modes.py)

type Json = Record<string, unknown>;
const node = (id: string, label: string, config: Json) => ({ id, label, config, position: null });
const edge = (source: string, target: string, condition = "default") => ({ id: `e_${source}_${target}${condition === "default" ? "" : `_${condition}`}`, source, target, condition });
const agent = (provider: string, role = "writer") => ({ kind: "agent", provider, role });
const gate = (g: string, max_rounds = 3) => ({ kind: "gate", gate: g, max_rounds });

function modeGraph(mode: string): Json {
  const graphs: Record<string, { nodes: Json[]; edges: Json[] }> = {
    single: {
      nodes: [node("dev", "Geliştirici", agent("claude")), node("boundary", "Sınır denetimi", gate("boundary_check", 2)), node("build", "Build/test kanıtı", gate("build_test")), node("final", "Son onay", gate("user_final", 2))],
      edges: [edge("dev", "boundary"), edge("boundary", "build"), edge("build", "final"), edge("boundary", "dev", "failed"), edge("build", "dev", "failed"), edge("final", "dev", "failed")],
    },
    duo: {
      nodes: [
        node("dev", "Yazar (Claude)", agent("claude")),
        node("boundary", "Sınır denetimi", gate("boundary_check", 2)),
        node("build", "Build/test kanıtı", gate("build_test")),
        node("review", "Çapraz inceleme (Codex)", gate("cross_review")),
        node("final", "Son onay", gate("user_final", 2)),
      ],
      edges: [edge("dev", "boundary"), edge("boundary", "build"), edge("build", "review"), edge("review", "final"), edge("boundary", "dev", "failed"), edge("build", "dev", "failed"), edge("review", "dev", "failed"), edge("final", "dev", "failed")],
    },
    race: {
      nodes: [node("fork", "Paralel başlat", { kind: "parallel" }), node("dev_a", "Ajan A (Claude)", agent("claude")), node("dev_b", "Ajan B (Codex)", agent("codex")), node("compare", "Karşılaştır", { kind: "compare", judge: "user" }), node("merge", "Seçilen birleşir", { kind: "merge" })],
      edges: [edge("fork", "dev_a"), edge("fork", "dev_b"), edge("dev_a", "compare"), edge("dev_b", "compare"), edge("compare", "merge")],
    },
    pipeline: {
      nodes: [
        node("plan", "Planlayıcı", agent("claude", "planner")),
        node("plan_gate", "Plan onayı", gate("plan_approval")),
        node("dev", "Geliştirici", agent("claude")),
        node("review", "İnceleyen", gate("cross_review")),
        node("test", "Test eden", agent("codex", "tester")),
        node("boundary", "Sınır denetimi", gate("boundary_check", 2)),
        node("build", "Build/test kanıtı", gate("build_test")),
        node("final", "Son onay", gate("user_final", 2)),
      ],
      edges: [
        edge("plan", "plan_gate"), edge("plan_gate", "dev"), edge("dev", "review"), edge("review", "test"), edge("test", "boundary"), edge("boundary", "build"), edge("build", "final"),
        edge("plan_gate", "plan", "failed"), edge("review", "dev", "failed"), edge("boundary", "dev", "failed"), edge("build", "dev", "failed"), edge("final", "dev", "failed"),
      ],
    },
    council: {
      nodes: [node("fork", "Paralel başlat", { kind: "parallel" }), node("advisor_a", "Danışman A (Claude)", { kind: "advisor", provider: "claude" }), node("advisor_b", "Danışman B (Codex)", { kind: "advisor", provider: "codex" }), node("synthesis", "Karşı tez ve sentez", { kind: "synthesis", provider: "claude" })],
      edges: [edge("fork", "advisor_a"), edge("fork", "advisor_b"), edge("advisor_a", "synthesis"), edge("advisor_b", "synthesis")],
    },
  };
  return { ...graphs[mode], settings: {}, inputs: {} };
}

const MODE_INFO = [
  { mode: "single", label: "Tek", description: "Tek ajan yazar; build/test kanıtı ve son onaydan geçer." },
  { mode: "duo", label: "İkili", description: "Bir sağlayıcı yazar, diğeri inceler. Engelleyici bulgu varsa iş yazara döner." },
  { mode: "race", label: "Yarış", description: "İki ajan aynı işi paralel yapar; sonuçlar karşılaştırılır, seçilen birleşir." },
  { mode: "pipeline", label: "Hat", description: "Planlayıcı, plan onayı, geliştirici, inceleyen, test eden ve son onay." },
  { mode: "council", label: "Kurul", description: "Danışmanlar bağımsız görüş verir; karşı tez ve sentezle tek karar belgesi yazılır." },
  { mode: "custom", label: "Özel", description: "Tuvalde kendi akışını kur." },
];

// ----------------------------------------------------------------------------- data

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

function nodeRun(runId: string, nodeId: string, status: string, attempt = 1, startedMin = -30): Json {
  return { id: `nr_${runId}_${nodeId}_${attempt}`, run_id: runId, node_id: nodeId, status, attempt, session_ids: [], worktree_ids: [], output: null, data: null, error: null, started_at: iso(startedMin), finished_at: null };
}

interface EngineState {
  tasks: Json[];
  runs: Record<string, Json>;
  queue: Json[];
  repos: Json[];
  created: Json[];
  health: Json[];
  flows: Json[];
}

function engineState(): EngineState {
  const tasks = [
    task("task_201", { title: "Limit çubuklarını üst çubuğa ekle", status: "running", mode: "duo", current_run_id: "run_201", created_at: iso(-42), updated_at: iso(-2) }),
    task("task_202", { title: "Ödeme webhook'larına tekrar deneme ekle", status: "waiting", mode: "pipeline", current_run_id: "run_202", created_at: iso(-25), updated_at: iso(-4) }),
    task("task_203", { title: "Fatura PDF üretimini hızlandır", status: "queued", mode: "race", created_at: iso(-8), updated_at: iso(-8) }),
    task("task_190", { title: "Kur farkı hesaplamasındaki yuvarlama hatasını düzelt", status: "completed", quality_score: 92, created_at: iso(-200), updated_at: iso(-150) }),
    task("task_188", { title: "Sipariş tablosuna bileşik indeks ekle", status: "failed", mode: "single", created_at: iso(-1500), updated_at: iso(-1440) }),
    task("task_185", { title: "Mimari tasarım: Olay kaynaklı ödeme defteri", status: "completed", mode: "council", studio_id: "architecture", quality_score: 81, created_at: iso(-2900), updated_at: iso(-2850) }),
    task("task_177", { title: "Gece bağımlılık güncellemesi", status: "completed", mode: "single", source: "schedule", quality_score: 64, created_at: iso(-4400), updated_at: iso(-4300) }),
  ];
  const run201 = {
    id: "run_201",
    task_id: "task_201",
    workspace_id: "ws_1",
    graph: modeGraph("duo"),
    status: "running",
    nodes: [nodeRun("run_201", "dev", "passed", 1, -40), nodeRun("run_201", "boundary", "passed", 1, -12), nodeRun("run_201", "build", "passed", 1, -10), nodeRun("run_201", "review", "running", 1, -3)],
    started_at: iso(-41),
    finished_at: null,
  };
  const run202 = {
    id: "run_202",
    task_id: "task_202",
    workspace_id: "ws_1",
    graph: modeGraph("pipeline"),
    status: "waiting",
    nodes: [nodeRun("run_202", "plan", "passed", 1, -24), nodeRun("run_202", "plan_gate", "waiting", 1, -5)],
    started_at: iso(-24),
    finished_at: null,
  };
  return {
    tasks,
    runs: { run_201: run201, run_202: run202 },
    queue: [{ task: tasks[2], position: 1, hold_until: iso(134), hold_reason: "Codex limiti dolu; limit sıfırlanınca başlayacak." }],
    repos: [
      { id: "repo_1", workspace_id: "ws_1", name: "odeme-servisi", path: "/Users/demo/src/odeme-servisi", host_id: null, remote_url: "git@github.com:demo/odeme-servisi.git", provider: "github", default_branch: "main", commands: {}, created_at: iso(-9000) },
      { id: "repo_2", workspace_id: "ws_1", name: "odeme-web", path: "/Users/demo/src/odeme-web", host_id: null, remote_url: null, provider: null, default_branch: "main", commands: {}, created_at: iso(-8000) },
    ],
    created: [],
    health: [
      { provider: "claude", installed: true, binary: "/opt/homebrew/bin/claude", version: "2.1.4", logged_in: true, compatible: true, tested_range: ">=2.0", message: null },
      { provider: "codex", installed: false, binary: null, version: null, logged_in: null, compatible: null, tested_range: null, message: "codex komutu PATH içinde bulunamadı." },
    ],
    flows: [{ id: "flow_1", version: 3, workspace_id: "ws_1", name: "Hızlı düzeltme", description: "Tek yazar, build kanıtı ve son onay.", graph: modeGraph("single"), is_template: false, studio_id: null, created_at: iso(-3000) }],
  };
}

const STUDIOS = [
  {
    id: "architecture",
    name: "Mimari tasarım",
    description: "Claude ve Codex bağımsız görüş yazar; karşı tez ve sentezle karar kaydı (ADR) çıkar.",
    icon: "blocks",
    version: 1,
    builtin: true,
    inputs: [
      { name: "question", label: "Karar sorusu", type: "textarea", required: true, help: "Hangi mimari kararı vermemiz gerekiyor?" },
      { name: "context", label: "Bağlam", type: "textarea", required: false, default: "" },
      { name: "repo", label: "Repo", type: "repo", required: false },
    ],
    graph: modeGraph("council"),
  },
  {
    id: "database",
    name: "Veritabanı",
    description: "Şema tasarımı, çapraz inceleme ve test ortamında migration denemesi.",
    icon: "database",
    version: 1,
    builtin: true,
    inputs: [
      { name: "change", label: "İstenen değişiklik", type: "textarea", required: true },
      { name: "dialect", label: "Veritabanı", type: "select", required: false, default: "PostgreSQL", options: ["PostgreSQL", "MySQL", "SQLite"] },
      { name: "repo", label: "Repo", type: "repo", required: true },
      { name: "test_deploy_profile", label: "Test ortamı profili", type: "deploy_profile", environment: "test", required: true, help: "Yalnız test ortamı profilleri kabul edilir." },
    ],
    graph: modeGraph("single"),
  },
  {
    id: "debugging",
    name: "Hata ayıklama",
    description: "Teşhis, hipotezler, hatayı yeniden üreten test, düzeltme ve inceleme.",
    icon: "bug",
    version: 1,
    builtin: true,
    inputs: [{ name: "symptom", label: "Hata belirtisi", type: "textarea", required: true }],
    graph: modeGraph("single"),
  },
];

const DEPLOY_PROFILES = [
  { id: "dp_test", workspace_id: "ws_1", name: "Test DB migration", kind: "command", environment: "test" },
  { id: "dp_prod", workspace_id: "ws_1", name: "Production DB", kind: "ci", environment: "production" },
];

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installEngine(page: Page, mutate?: (e: EngineState) => void): Promise<EngineState> {
  const e = engineState();
  mutate?.(e);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    if (path === "/engine/tasks" && method === "GET") {
      const statuses = url.searchParams.get("status")?.split(",") ?? null;
      const ws = url.searchParams.get("workspace_id");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const list = e.tasks
        .filter((t) => !ws || t.workspace_id === ws)
        .filter((t) => !statuses || statuses.includes(t.status as string))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return json(route, list.slice(0, limit));
    }
    if (path === "/engine/tasks" && method === "POST") {
      const body = req.postDataJSON() as Json;
      e.created.push(body);
      const created = task("task_300", { ...body, status: "running", current_run_id: "run_300", created_at: iso(0), updated_at: iso(0) });
      e.tasks.unshift(created);
      return json(route, { task: created, runs: [], current_run: null, error: null, hold_until: null, hold_reason: null, start_on_reset: false }, 201);
    }
    const runMatch = /^\/engine\/runs\/([^/]+)$/.exec(path);
    if (runMatch) {
      const run = e.runs[runMatch[1]!];
      return run ? json(route, run) : json(route, { error: { code: "not_found", message: "Koşu bulunamadı" } }, 404);
    }
    if (path === "/engine/queue") return json(route, e.queue);
    if (path === "/engine/modes") return json(route, MODE_INFO);
    const modeMatch = /^\/engine\/modes\/([a-z]+)$/.exec(path);
    if (modeMatch) return json(route, modeGraph(modeMatch[1]!));
    if (path === "/engine/flows") return json(route, e.flows);
    if (path === "/studios") return json(route, STUDIOS);
    const repos = /^\/workspaces\/([^/]+)\/repos$/.exec(path);
    if (repos && method === "GET") return json(route, e.repos.filter((r) => r.workspace_id === repos[1]));
    if (repos && method === "POST") {
      const body = req.postDataJSON() as { path: string; name?: string | null };
      const repo = { id: `repo_${e.repos.length + 1}`, workspace_id: repos[1], name: body.name || body.path.split("/").pop(), path: body.path, host_id: null, remote_url: null, provider: null, default_branch: "main", commands: {}, created_at: iso(0) };
      e.repos.push(repo);
      return json(route, repo, 201);
    }
    if (/^\/gitops\/repos\/[^/]+\/branches$/.test(path)) {
      const b = (name: string, extra: Json = {}) => ({ name, ref: `refs/heads/${name}`, sha: "0a1b2c3", remote: null, upstream: null, subject: "", committed_at: iso(-60), checked_out: false, is_default: false, ...extra });
      return json(route, {
        repo_id: path.split("/")[3],
        default_branch: "main",
        local: [b("main", { is_default: true, checked_out: true, subject: "Limit uyarılarını sadeleştir" }), b("feature/limit-bars", { subject: "Üst çubuğa limit çubukları" }), b("fix/kur-farki", { subject: "Yuvarlama hatası" })],
        remote: [b("origin/main", { remote: "origin" }), b("origin/release/2026-10", { remote: "origin", subject: "Ekim sürümü" })],
      });
    }
    if (path === "/agents/health") return json(route, e.health);
    if (path === "/deploy/profiles") return json(route, DEPLOY_PROFILES);
    return route.fallback();
  });
  return e;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function openHome(page: Page) {
  await page.goto("/#/");
  await expect(page.getByRole("form", { name: "Yeni görev" })).toBeVisible();
}

// ----------------------------------------------------------------------------- tests

for (const scheme of ["light", "dark"] as const) {
  test(`home renders composer, live strips, approvals and recent tasks (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    await installEngine(page);
    await openHome(page);

    await expect(page.getByRole("heading", { name: "Günaydın" })).toBeVisible();
    const active = page.getByRole("region", { name: "Etkin görevler" });
    await expect(active.getByRole("group", { name: "Limit çubuklarını üst çubuğa ekle akışı" })).toBeVisible();
    await expect(active.getByText("Çapraz inceleme (Codex) çalışıyor")).toBeVisible();
    await expect(active.getByText("Plan onayı · seni bekliyor")).toBeVisible();
    await expect(active.getByText(/sonra başlayacak · Codex limiti dolu/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Seni bekleyenler" })).toBeVisible();
    const recent = page.getByRole("region", { name: "Son görevler" });
    await expect(recent.getByText("Kur farkı hesaplamasındaki yuvarlama hatasını düzelt")).toBeVisible();
    await expect(recent.getByLabel("Kalite puanı 92")).toBeVisible();
    await expect(page.getByRole("img", { name: /Akış önizlemesi: Yazar \(Claude\)/ })).toBeVisible();
    await settle(page, 1200);
    await page.screenshot({ path: shot(`home-${scheme}`) });
    // The page scrolls inside the outlet: a tall viewport captures every section.
    await page.setViewportSize({ width: 1440, height: 1560 });
    await settle(page, 600);
    await page.screenshot({ path: shot(`home-full-${scheme}`) });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Mode switch re-draws the preview.
    await page.getByRole("radio", { name: "Hat" }).click();
    await expect(page.getByRole("img", { name: /Akış önizlemesi: Planlayıcı, Plan onayı/ })).toBeVisible();
    await page.getByRole("radio", { name: "Yarış" }).click();
    await expect(page.getByRole("img", { name: /Ajan A \(Claude\), Ajan B \(Codex\)/ })).toBeVisible();
    await settle(page, 900);
    await page.locator("main").screenshot({ path: shot(`home-mode-race-${scheme}`) });

    // Studio swaps the composer into its form; production-only targets are filtered by environment.
    await page.getByRole("button", { name: "Stüdyo", exact: true }).click();
    await page.getByRole("option", { name: /Veritabanı/ }).click();
    const form = page.getByRole("group", { name: "Veritabanı girdileri" });
    await expect(form.getByText("İstenen değişiklik")).toBeVisible();
    await expect(page.getByText("Stüdyo kendi akışını kullanır.")).toBeVisible();
    await form.getByRole("button", { name: "Test ortamı profili" }).click();
    await expect(page.getByRole("menuitemradio", { name: /Test DB migration/ })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /Production DB/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await settle(page, 700);
    await page.locator("main").screenshot({ path: shot(`home-studio-${scheme}`) });

    // Advanced options.
    await page.getByRole("button", { name: "Stüdyoyu kaldır" }).click();
    await page.getByRole("button", { name: "Gelişmiş" }).click();
    await expect(page.getByRole("group", { name: "Gelişmiş" })).toBeVisible();
    await settle(page, 700);
    await page.locator("main").screenshot({ path: shot(`home-advanced-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("submit with ⌘↵ creates the task and opens its page", async ({ page }) => {
  await installMockApi(page);
  const engine = await installEngine(page);
  // Warm the lazy tasks route (prefetched when idle in real use) so the surface can morph.
  await page.goto("/#/tasks");
  await expect(page.getByRole("heading", { name: "Görevler", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Ana sayfa" }).click();
  await expect(page.getByRole("form", { name: "Yeni görev" })).toBeVisible();
  const prompt = page.getByRole("textbox", { name: "Görev" });
  await prompt.click();
  await prompt.fill("Ödeme özeti e-postasına kur farkı satırı ekle.\n\nTestler geçmeli, şablon değişikliği küçük kalmalı.");
  await expect(page.getByRole("textbox", { name: "Başlık (isteğe bağlı)" })).toHaveAttribute("placeholder", "Başlık: Ödeme özeti e-postasına kur farkı satırı ekle.");
  await page.getByRole("radio", { name: "Kurul" }).click();

  // Repo multi-select + branch.
  await page.getByRole("button", { name: "Repo: Tüm repolar" }).click();
  await page.getByRole("option", { name: /odeme-web/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Repo: odeme-servisi" })).toBeVisible();
  await page.getByRole("button", { name: "Temel branch: main" }).click();
  await page.getByRole("option", { name: /feature\/limit-bars/ }).click();
  await expect(page.getByRole("button", { name: "Temel branch: feature/limit-bars" })).toBeVisible();

  // Budget.
  await page.getByRole("button", { name: "Gelişmiş" }).click();
  await page.getByLabel("5 saatlik pencere").fill("25");
  await page.getByRole("radio", { name: "Yüksek" }).click();
  await settle(page, 300);
  await page.locator("main").screenshot({ path: shot("home-composer-filled") });

  await prompt.focus();
  await page.keyboard.press(`${mod}+Enter`);
  await page.waitForTimeout(40);
  await page.screenshot({ path: shot("home-submit-morph-1") });
  await page.waitForTimeout(120);
  await page.screenshot({ path: shot("home-submit-morph-2") });
  await expect(page).toHaveURL(/#\/tasks\/task_300$/);
  expect(engine.created).toHaveLength(1);
  expect(engine.created[0]).toMatchObject({
    workspace_id: "ws_1",
    title: "Ödeme özeti e-postasına kur farkı satırı ekle.",
    mode: "council",
    repo_ids: ["repo_1"],
    base_ref: "feature/limit-bars",
    budget: { max_five_hour_percent: 25 },
    priority: 1,
    source: "user",
    start: true,
    start_on_reset: false,
  });
  await expect(page.getByText(/başlatıldı/).first()).toBeVisible();
});

test("opening an active task expands its card into the task page", async ({ page }) => {
  await installMockApi(page);
  await installEngine(page);
  // Warm the lazy tasks route once (the shell prefetches it when idle in real use).
  await page.goto("/#/tasks");
  await expect(page.getByRole("heading", { name: "Görevler", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Ana sayfa" }).click();
  await expect(page.getByRole("form", { name: "Yeni görev" })).toBeVisible();
  await settle(page, 700);
  await page.getByRole("link", { name: "Görevi aç: Limit çubuklarını üst çubuğa ekle" }).click();
  await page.waitForTimeout(60);
  await page.screenshot({ path: shot("home-morph-1") });
  await page.waitForTimeout(140);
  await page.screenshot({ path: shot("home-morph-2") });
  await expect(page).toHaveURL(/#\/tasks\/task_201$/);
  await expect(page.getByText("Görev task_201")).toBeVisible();
  await settle(page, 700);
  await page.screenshot({ path: shot("home-morph-3") });
});

test("reduced motion: home renders calmly without looping animations", async ({ page }) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMockApi(page);
  await installEngine(page);
  await openHome(page);
  await expect(page.getByRole("img", { name: /Akış önizlemesi/ })).toBeVisible();
  await expect(page.getByRole("group", { name: "Limit çubuklarını üst çubuğa ekle akışı" })).toBeVisible();
  await settle(page, 600);
  await page.screenshot({ path: shot("home-reduced-motion") });
  expect(errors).toEqual([]);
});

test("empty prompt shakes with a Turkish hint instead of submitting", async ({ page }) => {
  await installMockApi(page);
  const engine = await installEngine(page);
  await openHome(page);
  await page.getByRole("button", { name: /Başlat/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Görevi birkaç cümleyle anlat." })).toBeVisible();
  expect(engine.created).toHaveLength(0);
});

test("live events advance the strip, pass the baton and finish the task", async ({ page }) => {
  const api: MockApi = await installMockApi(page);
  const engine = await installEngine(page);
  await openHome(page);
  const strip = page.getByRole("group", { name: "Limit çubuklarını üst çubuğa ekle akışı" });
  await expect(strip.getByLabel("Çapraz inceleme (Codex): çalışıyor")).toBeVisible();

  const ctx = { task_id: "task_201", run_id: "run_201" };
  api.push("node.completed", { node_id: "review", node_run_id: "nr_run_201_review_1", status: "passed", kind: "gate", label: "Çapraz inceleme (Codex)" }, ctx);
  api.push("run.edge", { edge_id: "e_review_final", source: "review", target: "final" }, ctx);
  api.push("node.started", { node_id: "final", node_run_id: "nr_final", kind: "gate", attempt: 1, label: "Son onay" }, ctx);
  api.push("node.waiting", { node_id: "final", node_run_id: "nr_final", label: "Son onay", reason: "Son onay bekleniyor" }, ctx);
  await expect(strip.getByLabel("Çapraz inceleme (Codex): tamamlandı")).toBeVisible();
  await expect(strip.getByLabel("Son onay: çalışıyor")).toBeVisible();
  await expect(page.getByText("Son onay bekleniyor")).toBeVisible();
  await settle(page, 500);
  await page.getByRole("region", { name: "Etkin görevler" }).screenshot({ path: shot("home-active-live") });

  // Completion: the card leaves the active list and the task shows up in recent with its score.
  const finished = engine.tasks.find((t) => t.id === "task_201")!;
  finished.status = "completed";
  finished.quality_score = 88;
  finished.updated_at = iso(0);
  api.push("run.completed", { status: "completed" }, ctx);
  api.push("task.completed", { title: "Limit çubuklarını üst çubuğa ekle", quality_score: 88 }, ctx);
  const recent = page.getByRole("region", { name: "Son görevler" });
  await expect(recent.getByText("Limit çubuklarını üst çubuğa ekle")).toBeVisible();
  await expect(recent.getByLabel("Kalite puanı 88")).toBeVisible();
  await expect(page.getByRole("group", { name: "Limit çubuklarını üst çubuğa ekle akışı" })).toHaveCount(0);
});

test("palette: 'Yeni görev: Kurul' opens the composer in council mode", async ({ page }) => {
  await installMockApi(page);
  await installEngine(page);
  await page.goto("/#/settings");
  await expect(page.getByRole("navigation", { name: "Gezinme" })).toBeVisible();
  await page.waitForTimeout(800); // feature chunks are prefetched (and register their commands) when idle
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByTestId("command-palette");
  await page.keyboard.type("yeni gorev kurul");
  await expect(palette.getByRole("option", { name: /Yeni görev: Kurul/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("radio", { name: "Kurul" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("textbox", { name: "Görev" })).toBeFocused();
});

test("engine not ready: quiet message instead of an error", async ({ page }) => {
  const api = await installMockApi(page);
  api.state.missing.push("/engine");
  await page.route("**/api/studios", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/workspaces/ws_1/repos", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(engineState().repos) }));
  await openHome(page);
  await expect(page.getByText("Görev motoru henüz hazır değil; görevler studiod güncellenince burada görünür.")).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`first run onboarding: workspace → repo → CLI check → first task (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page, (s) => {
      s.workspaces = [];
      s.approvals = [];
      s.sessions = [];
    });
    await installEngine(page, (e) => {
      e.tasks = [];
      e.queue = [];
    });
    await page.goto("/#/");
    await expect(page.getByRole("heading", { name: "AI Studio'ya hoş geldin" })).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`home-onboarding-workspace-${scheme}`) });

    await page.getByRole("button", { name: "Oluştur" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Bir ad girin." })).toBeVisible();
    await page.getByRole("textbox", { name: "Ad", exact: true }).fill("Ödeme servisi");
    await page.getByRole("button", { name: "Oluştur" }).click();

    await expect(page.getByRole("heading", { name: "Bir repo ekle" })).toBeVisible();
    await page.getByLabel("Repo yolu").fill("/Users/demo/src/odeme-servisi");
    await settle(page, 500);
    await page.screenshot({ path: shot(`home-onboarding-repo-${scheme}`) });
    await page.getByRole("button", { name: "Repoyu ekle" }).click();

    await expect(page.getByRole("heading", { name: "Ajan CLI'larını denetle" })).toBeVisible();
    await expect(page.getByText("npm install -g @openai/codex")).toBeVisible();
    await expect(page.getByText("Hazır", { exact: true })).toBeVisible();
    await settle(page, 600);
    await page.screenshot({ path: shot(`home-onboarding-cli-${scheme}`) });
    await page.getByRole("button", { name: "Devam et" }).click();

    await expect(page.getByRole("heading", { name: "Hazırsın" })).toBeVisible();
    await page.getByRole("button", { name: "İlk görevi yaz" }).click();
    await expect(page.getByRole("form", { name: "Yeni görev" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Görev" })).toBeFocused();
    await expect(page.getByRole("region", { name: "Hızlı başlangıç" })).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`home-empty-${scheme}`) });
    expect(errors).toEqual([]);
  });
}
