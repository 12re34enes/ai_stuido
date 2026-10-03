/**
 * Flows feature e2e: list, editor (templates, palette, connect, inspector, validation markers,
 * save, versions, start task, keyboard) and schedules (cron builder). Uses the shared mock for
 * the shell and its own page.route handlers for the engine/studio/agent endpoints.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { installMockApi, NOW, settle } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

// ----------------------------------------------------------------------------- fixtures

type Json = Record<string, unknown>;

const settings = () => ({
  gates: { plan_approval: true, boundary_check: true, build_test: true, cross_review: true, user_final: true },
  budget: { max_five_hour_percent: null, max_weekly_percent: null, max_duration_minutes: null, max_turns: null },
  limit_policy: { on_exhausted: "queue" },
  max_parallel_agents: 4,
  checkpoint_every_node: true,
});

const agent = (provider: "claude" | "codex", extra: Json = {}) => ({
  kind: "agent",
  profile_id: null,
  provider,
  model: null,
  effort: null,
  role: "writer",
  prompt_template: "{{ input.prompt }}\n{% if feedback.text %}\n## Düzeltilmesi gerekenler\n{{ feedback.text }}\n{% endif %}",
  repo_ids: null,
  writes: true,
  boundaries: null,
  tool_names: null,
  max_turns: null,
  output_format: "text",
  ...extra,
});

const gate = (kind: string, extra: Json = {}) => ({
  kind: "gate",
  gate: kind,
  commands: null,
  command: null,
  reviewer_profile_id: null,
  reviewer_model: null,
  review_focus: null,
  target_node_id: null,
  max_rounds: 3,
  blocking_severities: ["critical", "high"],
  ...extra,
});

const node = (id: string, label: string, config: Json, x = 0, y = 240) => ({ id, label, config, position: { x, y } });
const edge = (source: string, target: string, condition = "default") => ({
  id: `e_${source}_${target}${condition === "default" ? "" : `_${condition}`}`,
  source,
  target,
  condition,
});

function duoGraph() {
  return {
    nodes: [
      node("dev", "Yazar (Claude)", agent("claude"), 80),
      node("boundary", "Sınır denetimi", gate("boundary_check", { max_rounds: 2 }), 360),
      node("build", "Build/test kanıtı", gate("build_test"), 640),
      node("review", "Çapraz inceleme (Codex)", gate("cross_review"), 920),
      node("final", "Son onay", gate("user_final", { max_rounds: 2 }), 1200),
    ],
    edges: [
      edge("dev", "boundary"),
      edge("boundary", "build"),
      edge("build", "review"),
      edge("review", "final"),
      edge("boundary", "dev", "failed"),
      edge("build", "dev", "failed"),
      edge("review", "dev", "failed"),
      edge("final", "dev", "failed"),
    ],
    settings: settings(),
    inputs: {},
  };
}

function singleGraph() {
  const g = duoGraph();
  return { ...g, nodes: g.nodes.filter((n) => n.id !== "review"), edges: [edge("dev", "boundary"), edge("boundary", "build"), edge("build", "final"), edge("build", "dev", "failed"), edge("final", "dev", "failed")] };
}

function raceGraph() {
  return {
    nodes: [
      node("fork", "Paralel başlat", { kind: "parallel" }, 80),
      node("dev_a", "Ajan A (Claude)", agent("claude"), 360, 155),
      node("dev_b", "Ajan B (Codex)", agent("codex"), 360, 325),
      node("compare", "Karşılaştır", { kind: "compare", judge: "user", judge_profile_id: null, criteria: "Doğruluk, test sonuçları, sadelik ve sınırlara uyum.", run_gates: ["boundary_check", "build_test"] }, 640),
      node("merge", "Seçilen birleşir", { kind: "merge", target_ref: null, strategy: "squash", require_approval: false, resolve_conflicts_with_agent: true }, 920),
    ],
    edges: [edge("fork", "dev_a"), edge("fork", "dev_b"), edge("dev_a", "compare"), edge("dev_b", "compare"), edge("compare", "merge")],
    settings: settings(),
    inputs: {},
  };
}

function pipelineGraph() {
  return {
    nodes: [
      node("plan", "Planlayıcı", agent("claude", { role: "planner", writes: false, output_format: "plan" })),
      node("plan_gate", "Plan onayı", gate("plan_approval")),
      node("dev", "Geliştirici", agent("claude")),
      node("review", "İnceleyen", gate("cross_review", { target_node_id: "dev" })),
      node("test", "Test eden", agent("codex", { role: "tester" })),
      node("build", "Build/test kanıtı", gate("build_test")),
      node("final", "Son onay", gate("user_final")),
    ].map((n) => ({ ...n, position: null })),
    edges: [
      edge("plan", "plan_gate"),
      edge("plan_gate", "dev"),
      edge("dev", "review"),
      edge("review", "test"),
      edge("test", "build"),
      edge("build", "final"),
      edge("plan_gate", "plan", "failed"),
      edge("review", "dev", "failed"),
      edge("build", "dev", "failed"),
    ],
    settings: settings(),
    inputs: {},
  };
}

function councilGraph() {
  const advisor = (provider: string, perspective: string) => ({ kind: "advisor", profile_id: null, provider, model: null, effort: null, perspective, prompt_template: "{{ input.prompt }}", web_access: false });
  return {
    nodes: [
      node("fork", "Paralel başlat", { kind: "parallel" }),
      node("advisor_a", "Danışman A (Claude)", advisor("claude", "Uygulanabilirlik, sadelik ve bakım maliyeti")),
      node("advisor_b", "Danışman B (Codex)", advisor("codex", "Riskler, güvenlik ve ölçeklenebilirlik")),
      node("synthesis", "Karşı tez ve sentez", { kind: "synthesis", profile_id: null, provider: "claude", model: null, devil_advocate: true, prompt_template: "", output_format: "decision", propose_memory: true }),
    ].map((n) => ({ ...n, position: null })),
    edges: [edge("fork", "advisor_a"), edge("fork", "advisor_b"), edge("advisor_a", "synthesis"), edge("advisor_b", "synthesis")],
    settings: settings(),
    inputs: {},
  };
}

const MODE_GRAPHS: Record<string, () => Json> = { single: singleGraph, duo: duoGraph, race: raceGraph, pipeline: pipelineGraph, council: councilGraph };

const MODES = [
  { mode: "single", label: "Tek", description: "Tek ajan yazar; build/test kanıtı ve son onaydan geçer." },
  { mode: "duo", label: "İkili", description: "Bir sağlayıcı yazar, diğeri inceler. Engelleyici bulgu varsa iş yazara döner." },
  { mode: "race", label: "Yarış", description: "İki ajan aynı işi paralel yapar; sonuçlar karşılaştırılır, seçilen birleşir." },
  { mode: "pipeline", label: "Hat", description: "Planlayıcı, plan onayı, geliştirici, inceleyen, test eden ve son onay." },
  { mode: "council", label: "Kurul", description: "Danışmanlar bağımsız görüş verir; karşı tez ve sentezle tek karar belgesi yazılır." },
  { mode: "custom", label: "Özel", description: "Tuvalde kendi akışını kur." },
];

const PROFILES = [
  { id: "prof_claude_writer", workspace_id: null, name: "Claude yazar", provider: "claude", model: "claude-opus-5-5", effort: "high", role: "writer", instructions: "", boundaries: { forbidden_paths: [], readonly_paths: [], allowed_commands: [], denied_commands: [], network: true, sandbox: "workspace_write", remote_access: "none" }, color: null, builtin: true },
  { id: "prof_codex_reviewer", workspace_id: null, name: "Codex inceleyen", provider: "codex", model: "gpt-5.5-codex", effort: "medium", role: "reviewer", instructions: "", boundaries: { forbidden_paths: [], readonly_paths: [], allowed_commands: [], denied_commands: [], network: true, sandbox: "read_only", remote_access: "none" }, color: null, builtin: true },
];

function savedFlow(id: string, name: string, graph: Json, version: number, over: Json = {}) {
  return { id, version, workspace_id: "ws_1", name, description: "", graph, is_template: false, studio_id: null, created_by: "user", created_at: iso(-version * 90), first_created_at: iso(-4000), ...over };
}

interface FlowMock {
  flows: Json[];
  versions: Record<string, Json[]>;
  schedules: Json[];
  validations: Json[];
  creates: Json[];
  updates: { id: string; body: Json }[];
  tasks: Json[];
  scheduleRuns: string[];
  deletedFlows: string[];
}

/** A tiny validator mirroring the engine's most common rules (Turkish messages). */
function validate(graph: Json): Json {
  const nodes = (graph.nodes as Json[]) ?? [];
  const edges = (graph.edges as Json[]) ?? [];
  const errors: Json[] = [];
  const warnings: Json[] = [];
  if (!nodes.length) return { ok: false, errors: [{ code: "empty", message: "Akışta hiç düğüm yok.", node_id: null, edge_id: null }], warnings };
  const loops = new Set(["failed", "false", "rejected"]);
  const entries = nodes.filter((n) => !edges.some((e) => e.target === n.id && !loops.has(String(e.condition))));
  if (entries.length > 1) errors.push({ code: "multiple_entries", message: `Akışın tek bir başlangıç düğümü olmalı; şu an birden fazla var: ${entries.map((n) => n.id).join(", ")}.`, node_id: null, edge_id: null });
  for (const n of nodes) {
    const c = n.config as Json;
    if (c.kind === "condition" && !String(c.expression ?? "").trim()) errors.push({ code: "expression", message: "Koşul ifadesi boş olamaz.", node_id: n.id, edge_id: null });
    if (c.kind === "human" && !String(c.instructions ?? "").trim()) errors.push({ code: "missing_instructions", message: "Kullanıcı adımı için talimat yazılmalı.", node_id: n.id, edge_id: null });
    if (c.kind === "deploy" && !String(c.profile_id ?? "").trim()) errors.push({ code: "missing_profile", message: "Deploy düğümü için bir deploy profili seçilmeli.", node_id: n.id, edge_id: null });
    if (c.kind === "join" && edges.filter((e) => e.target === n.id).length < 2) warnings.push({ code: "thin_join", message: "Birleşme düğümüne en az iki dal bağlanmalı.", node_id: n.id, edge_id: null });
  }
  for (const e of edges) {
    const src = nodes.find((n) => n.id === e.source);
    if ((e.condition === "true" || e.condition === "false") && (src?.config as Json)?.kind !== "condition") {
      errors.push({ code: "bad_condition", message: "'doğru/yanlış' bağlantıları yalnız koşul düğümünden çıkabilir.", node_id: e.source, edge_id: e.id });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFlowMock(page: Page, mutate?: (m: FlowMock) => void): Promise<FlowMock> {
  const m: FlowMock = {
    flows: [
      savedFlow("flow_duo", "İkili inceleme akışı", duoGraph(), 3, { description: "Claude yazar, Codex inceler; engelleyici bulgu varsa yazara döner." }),
      savedFlow("flow_race", "Ödeme formu yarışı", raceGraph(), 1, { description: "İki ajan paralel çalışır, en iyisi birleşir.", created_at: iso(-60 * 26) }),
      savedFlow("flow_council", "Mimari kurul", councilGraph(), 2, { description: "Bağımsız görüşler, karşı tez ve tek karar belgesi.", is_template: true, created_at: iso(-60 * 24 * 4) }),
    ],
    versions: {},
    schedules: [
      {
        id: "sch_1",
        workspace_id: "ws_1",
        name: "Sabah bağımlılık taraması",
        cron: "45 8 * * 1-5",
        timezone: "Europe/Istanbul",
        template: { title: "Bağımlılıkları güncelle", prompt: "Güvenlik açığı olan bağımlılıkları güncelle.", mode: "duo", flow_id: null, studio_id: null, repo_ids: null, base_ref: null, inputs: {}, budget: null, priority: 0 },
        enabled: true,
        next_run_at: null,
        last_run_at: iso(-60 * 26),
        last_task_id: "task_90",
        created_at: iso(-9000),
        updated_at: iso(-60),
      },
      {
        id: "sch_2",
        workspace_id: "ws_1",
        name: "Cuma sürüm notları",
        cron: "0 16 * * 5",
        timezone: "Europe/Istanbul",
        template: { title: "Sürüm notlarını yaz", prompt: "Bu haftanın PR'larından sürüm notu hazırla.", mode: "custom", flow_id: "flow_duo", studio_id: null, repo_ids: null, base_ref: null, inputs: {}, budget: null, priority: 0 },
        enabled: false,
        next_run_at: null,
        last_run_at: null,
        last_task_id: null,
        created_at: iso(-9000),
        updated_at: iso(-60),
      },
    ],
    validations: [],
    creates: [],
    updates: [],
    tasks: [],
    scheduleRuns: [],
    deletedFlows: [],
  };
  for (const f of m.flows) {
    const versions: Json[] = [];
    for (let v = 1; v <= Number(f.version); v++) versions.push({ ...f, version: v, created_at: iso(-(Number(f.version) - v + 1) * 180) });
    m.versions[String(f.id)] = versions;
  }
  mutate?.(m);
  let seq = 0;

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();

    if (path === "/engine/modes") return json(route, MODES);
    const modeMatch = /^\/engine\/modes\/(\w+)$/.exec(path);
    if (modeMatch) return json(route, (MODE_GRAPHS[modeMatch[1]!] ?? (() => ({ nodes: [], edges: [], settings: settings(), inputs: {} })))());
    if (path === "/engine/flows/validate" && method === "POST") {
      const graph = req.postDataJSON() as Json;
      m.validations.push(graph);
      return json(route, validate(graph));
    }
    if (path === "/engine/flows" && method === "GET") return json(route, m.flows);
    if (path === "/engine/flows" && method === "POST") {
      const body = req.postDataJSON() as Json;
      m.creates.push(body);
      const flow = savedFlow(`flow_new${++seq}`, String(body.name), body.graph as Json, 1, { description: body.description, created_at: iso(0) });
      m.flows.push(flow);
      m.versions[String(flow.id)] = [flow];
      return json(route, flow, 201);
    }
    const versionMatch = /^\/engine\/flows\/([^/]+)\/versions(?:\/(\d+))?$/.exec(path);
    if (versionMatch) {
      const list = m.versions[versionMatch[1]!] ?? [];
      if (versionMatch[2]) return json(route, list.find((v) => v.version === Number(versionMatch[2])) ?? {}, list.length ? 200 : 404);
      return json(route, list.map((v) => ({ version: v.version, name: v.name, created_by: v.created_by, created_at: v.created_at })));
    }
    const flowMatch = /^\/engine\/flows\/([^/]+)$/.exec(path);
    if (flowMatch) {
      const id = decodeURIComponent(flowMatch[1]!);
      const i = m.flows.findIndex((f) => f.id === id);
      if (method === "GET") return i < 0 ? json(route, { error: { code: "not_found", message: "Akış bulunamadı." } }, 404) : json(route, m.flows[i]);
      if (method === "PUT") {
        const body = req.postDataJSON() as Json;
        m.updates.push({ id, body });
        const cur = m.flows[i]!;
        const next = { ...cur, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined)), version: Number(cur.version) + 1, created_at: iso(0) };
        m.flows[i] = next;
        (m.versions[id] ??= []).push(next);
        return json(route, next);
      }
      if (method === "DELETE") {
        m.deletedFlows.push(id);
        m.flows.splice(i, 1);
        return route.fulfill({ status: 204 });
      }
    }
    if (path === "/engine/schedules" && method === "GET") return json(route, m.schedules);
    if (path === "/engine/schedules" && method === "POST") {
      const body = req.postDataJSON() as Json;
      const sch = { id: `sch_new${++seq}`, ...body, next_run_at: null, last_run_at: null, last_task_id: null, created_at: iso(0), updated_at: iso(0) };
      m.schedules.push(sch);
      return json(route, sch, 201);
    }
    const runMatch = /^\/engine\/schedules\/([^/]+)\/run$/.exec(path);
    if (runMatch && method === "POST") {
      m.scheduleRuns.push(runMatch[1]!);
      return json(route, { id: "task_201", title: "Bağımlılıkları güncelle", status: "queued" });
    }
    const schMatch = /^\/engine\/schedules\/([^/]+)$/.exec(path);
    if (schMatch) {
      const i = m.schedules.findIndex((x) => x.id === schMatch[1]);
      if (method === "PATCH") {
        m.schedules[i] = { ...m.schedules[i], ...(req.postDataJSON() as Json), updated_at: iso(0) };
        return json(route, m.schedules[i]);
      }
      if (method === "DELETE") {
        m.schedules.splice(i, 1);
        return route.fulfill({ status: 204 });
      }
    }
    if (path === "/engine/tasks" && method === "POST") {
      const body = req.postDataJSON() as Json;
      m.tasks.push(body);
      return json(route, { task: { id: "task_300", title: body.title, status: "running" } }, 201);
    }
    if (path === "/agents/profiles") return json(route, PROFILES);
    if (path === "/workspaces/ws_1/repos") return json(route, [{ id: "repo_web", workspace_id: "ws_1", name: "web", path: "/Users/demo/src/odeme-servisi", default_branch: "main", commands: { install: null, lint: "pnpm lint", typecheck: "pnpm typecheck", test: "pnpm test", build: "pnpm build" } }]);
    if (path === "/tools") return json(route, [{ name: "studio_memory_read", description: "Read shared memory", mutating: false }, { name: "studio_propose_memory", description: "Propose a memory change", mutating: true }]);
    if (path === "/studios") return json(route, [{ id: "architecture", name: "Mimari tasarım", description: "Kurul: Claude ve Codex bağımsız görüş, karşı tez, sentez.", icon: "sparkles", version: 1, builtin: true, inputs: [], graph: councilGraph() }]);
    if (path === "/studios/architecture") return json(route, { id: "architecture", name: "Mimari tasarım", description: "Kurul: Claude ve Codex bağımsız görüş, karşı tez, sentez.", icon: "sparkles", version: 1, builtin: true, inputs: [], graph: councilGraph() });
    if (path === "/deploy/profiles") return json(route, [{ id: "dep_test", workspace_id: "ws_1", name: "Test ortamı", kind: "ci", environment: "test" }, { id: "dep_prod", workspace_id: "ws_1", name: "Production", kind: "ci", environment: "production" }]);
    return route.fallback();
  });
  return m;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED/i.test(msg.text())) errors.push(msg.text());
  });
  return errors;
}

async function open(page: Page, hash: string) {
  await page.goto(`/#${hash}`);
  await expect(page.getByRole("navigation", { name: "Gezinme" })).toBeVisible();
}

// ----------------------------------------------------------------------------- tests

for (const scheme of ["light", "dark"] as const) {
  test(`flows list, editor and schedules render (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    await installFlowMock(page);

    await open(page, "/flows");
    await expect(page.getByTestId("flow-card-flow_duo")).toBeVisible();
    await expect(page.getByTestId("mode-duo")).toBeVisible();
    await settle(page, 1100);
    await page.screenshot({ path: shot(`flows-list-${scheme}`) });

    await page.getByTestId("flow-card-flow_duo").getByRole("button", { name: /İkili inceleme akışı/ }).click();
    await expect(page.getByTestId("flow-editor")).toBeVisible();
    await expect(page.getByTestId("flow-node-dev")).toBeVisible();
    await settle(page, 1400);
    await page.screenshot({ path: shot(`flows-editor-${scheme}`) });

    // 100% zoom close-up of the node and edge visuals.
    await page.getByRole("button", { name: /^Yakınlaştırma/ }).click();
    await settle(page, 600);
    await page.screenshot({ path: shot(`flows-editor-zoom-${scheme}`), clip: { x: 480, y: 280, width: 920, height: 460 } });
    await page.keyboard.press("Shift+1");
    await settle(page, 600);

    await page.getByTestId("flow-node-dev").click();
    await expect(page.getByTestId("node-inspector")).toBeVisible();
    await settle(page, 600);
    await page.screenshot({ path: shot(`flows-editor-inspector-${scheme}`) });

    await page.getByTestId("settings-button").click();
    await expect(page.getByTestId("flow-settings")).toBeVisible();
    await settle(page, 600);
    await page.screenshot({ path: shot(`flows-editor-settings-${scheme}`) });

    await open(page, "/flows/schedules");
    await expect(page.getByTestId("schedule-sch_1")).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`flows-schedules-${scheme}`) });

    await page.getByTestId("new-schedule").click();
    await expect(page.getByTestId("schedule-form")).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`flows-schedule-dialog-${scheme}`) });

    expect(errors).toEqual([]);
  });
}

function nodeHandle(page: Page, id: string, type: "source" | "target") {
  return page.locator(`.react-flow__node[data-id="${id}"] .react-flow__handle.${type}`);
}

/** Close the inspector, fit the whole flow, then click a node (panels can cover nodes). */
async function selectNode(page: Page, id: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+1");
  await settle(page, 600);
  await page.getByTestId(`flow-node-${id}`).click();
}

async function connect(page: Page, from: string, to: string) {
  const a = await nodeHandle(page, from, "source").boundingBox();
  const b = await nodeHandle(page, to, "target").boundingBox();
  if (!a || !b) throw new Error("handles not found");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2 + 40, { steps: 8 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("new flow from a mode template: palette, connect with condition, validate markers, save", async ({ page }) => {
  const errors = collectErrors(page);
  await installMockApi(page);
  const m = await installFlowMock(page);
  await open(page, "/flows");
  await page.getByTestId("mode-duo").click();
  await expect(page).toHaveURL(/#\/flows\/new\?mode=duo$/);
  await expect(page.getByTestId("flow-node-final")).toBeVisible();
  await expect(page.getByLabel("Akış adı")).toHaveValue("İkili akışı");
  await expect(page.getByTestId("save-state")).toHaveText(/Kaydedilmedi/);

  // Add a condition from the palette (double-click adds at the canvas center).
  await page.getByTestId("palette-condition").dblclick();
  await expect(page.getByTestId("flow-node-condition")).toBeVisible();
  await expect(page.getByTestId("node-inspector")).toBeVisible();
  await expect(page.getByTestId("inspector").getByRole("heading", { name: "Koşul", exact: true })).toBeVisible();

  // Explicit validation: markers on the canvas and the issue list.
  await page.getByTestId("validate").click();
  await expect(page.getByTestId("validation-status")).toHaveText(/2 hata/);
  const list = page.getByTestId("issue-list");
  await expect(list).toContainText("Koşul ifadesi boş olamaz.");
  await expect(list).toContainText("tek bir başlangıç düğümü");
  await expect(page.getByTestId("flow-node-condition").getByRole("img", { name: "Koşul ifadesi boş olamaz." })).toBeVisible();
  await settle(page, 900);
  await page.screenshot({ path: shot("flows-editor-validation") });
  await page.keyboard.press("Escape");

  // Fix it: expression + connect dev → condition (picker opens on connect).
  const expression = page.getByTestId("node-inspector").locator(".cm-content");
  await expression.click();
  await page.keyboard.type("nodes.dev.data.ok");
  await connect(page, "dev", "condition");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: /Varsayılan/ })).toBeVisible();
  await settle(page, 400);
  await page.screenshot({ path: shot("flows-editor-connect-picker") });
  await menu.getByRole("menuitemradio", { name: /Başarısız/ }).click();
  await expect(page.getByTestId("edge-pill-e_dev_condition")).toHaveText("Başarısız");
  await page.getByTestId("validate").click();
  await expect(page.getByTestId("validation-status")).toHaveText(/Geçerli/);

  // Save creates the flow and moves to its URL without reloading the canvas.
  await page.getByTestId("save").click();
  await expect(page).toHaveURL(/#\/flows\/flow_new1$/);
  await expect(page.getByTestId("save-state")).toHaveText(/Kaydedildi/);
  await expect(page.getByTestId("flow-node-condition")).toBeVisible();
  expect(m.creates).toHaveLength(1);
  const created = m.creates[0] as { name: string; workspace_id: string; graph: { nodes: Json[]; edges: Json[] } };
  expect(created.name).toBe("İkili akışı");
  expect(created.workspace_id).toBe("ws_1");
  expect(created.graph.nodes).toHaveLength(6);
  expect(created.graph.nodes.find((n) => n.id === "condition")?.config).toMatchObject({ kind: "condition", expression: "nodes.dev.data.ok", max_loops: 3 });
  expect(created.graph.edges).toContainEqual({ id: "e_dev_condition", source: "dev", target: "condition", condition: "failed" });
  expect(errors).toEqual([]);
});

test("drag a node from the palette onto the canvas", async ({ page }) => {
  const errors = collectErrors(page);
  await installMockApi(page);
  await installFlowMock(page);
  await open(page, "/flows/new?blank=1");
  await expect(page.getByTestId("canvas-empty")).toBeVisible();
  await page.getByTestId("palette-human").dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 520, y: 260 } });
  await expect(page.getByTestId("flow-node-human")).toBeVisible();
  await expect(page.getByTestId("canvas-empty")).toBeHidden();
  await expect(page.getByTestId("node-inspector").getByText("Talimat", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("inspector edits, undo/redo, delete, duplicate and keyboard", async ({ page }) => {
  const errors = collectErrors(page);
  await installMockApi(page);
  await installFlowMock(page);
  await open(page, "/flows/flow_duo");
  await expect(page.getByTestId("flow-node-build")).toBeVisible();

  // Gate kind → custom command; the node summary follows.
  await page.getByTestId("flow-node-build").click();
  await page.getByTestId("node-inspector").getByRole("button", { name: "Kapı türü" }).click();
  await page.getByRole("menuitemradio", { name: /Özel komut/ }).click();
  const command = page.getByTestId("node-inspector").getByRole("textbox", { name: "Komut" });
  await command.fill("pnpm e2e");
  await expect(page.getByTestId("flow-node-build")).toContainText("pnpm e2e");
  await expect(page.getByTestId("flow-node-build")).toContainText("Komut");

  // Undo twice via the toolbar: back to build/test.
  await page.getByRole("button", { name: "Geri al" }).click();
  await page.getByRole("button", { name: "Geri al" }).click();
  await expect(page.getByTestId("flow-node-build")).toContainText("Build/test");
  await page.getByRole("button", { name: "Yinele" }).click();
  await expect(page.getByTestId("flow-node-build")).toContainText("Komut");

  // Delete with the keyboard, then undo.
  await selectNode(page, "review");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("flow-node-review")).toHaveCount(0);
  await expect(page.locator('.react-flow__edge[data-id="e_review_final"]')).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);
  await expect(page.getByTestId("flow-node-review")).toBeVisible();
  await expect(page.locator('.react-flow__edge[data-id="e_review_final"]')).toHaveCount(1);

  // Duplicate and copy/paste.
  await selectNode(page, "dev");
  await page.keyboard.press(`${mod}+d`);
  await expect(page.getByTestId("flow-node-agent")).toBeVisible();
  await page.keyboard.press(`${mod}+c`);
  await page.keyboard.press(`${mod}+v`);
  await expect(page.getByTestId("flow-node-agent_2")).toBeVisible();

  // Rename the id from the inspector: edges follow.
  await selectNode(page, "final");
  const idField = page.getByTestId("node-inspector").getByRole("textbox", { name: "Kimlik" });
  await idField.fill("son_onay");
  await idField.press("Enter");
  await expect(page.getByTestId("flow-node-son_onay")).toBeVisible();
  await expect(page.locator('.react-flow__edge[data-id="e_review_final"]')).toHaveCount(1);
  await expect(page.getByTestId("save-state")).toHaveText(/Kaydedilmedi/);

  // Prompt edits are one undo step and redo survives the editor re-sync.
  await selectNode(page, "dev");
  const prompt = page.getByTestId("node-inspector").locator(".cm-content").first();
  await prompt.click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type(" Testleri de yaz.");
  await expect(prompt).toContainText("Testleri de yaz.");
  await page.getByRole("button", { name: "Geri al" }).click();
  await expect(prompt).not.toContainText("Testleri de yaz.");
  await page.getByRole("button", { name: "Yinele" }).click();
  await expect(prompt).toContainText("Testleri de yaz.");
  expect(errors).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`prompt template autocomplete (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    await installFlowMock(page);
    await open(page, "/flows/flow_duo");
    await page.getByTestId("flow-node-dev").click();
    const editor = page.getByTestId("node-inspector").locator(".cm-content").first();
    await editor.click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.press("Enter");
    await page.keyboard.type("{{");
    await page.keyboard.type("nodes.re");
    const popup = page.getByRole("listbox", { name: "Şablon değişkenleri" });
    await expect(popup).toBeVisible();
    await expect(popup.getByRole("option").first()).toContainText("nodes.review.output");
    await settle(page, 400);
    await page.screenshot({ path: shot(`flows-editor-autocomplete-${scheme}`) });
    await page.keyboard.press("Enter");
    await expect(popup).toBeHidden();
    await expect(editor).toContainText("{{ nodes.review.output }}");
    // Filters after a pipe.
    await page.keyboard.type(" | cl");
    await expect(popup.getByRole("option").first()).toContainText("clip(4000)");
    await page.keyboard.press("Tab");
    await expect(editor).toContainText("{{ nodes.review.output | clip(4000) }}");
    expect(errors).toEqual([]);
  });
}

test("versions: preview an older version, restore it as a new version", async ({ page }) => {
  const errors = collectErrors(page);
  await installMockApi(page);
  const m = await installFlowMock(page, (mock) => {
    // v1 had only the author and the final approval.
    const v1 = mock.versions.flow_duo![0]!;
    const g = duoGraph();
    v1.graph = { ...g, nodes: [g.nodes[0], g.nodes[4]], edges: [edge("dev", "final"), edge("final", "dev", "failed")] };
    v1.name = "İlk taslak";
  });
  await open(page, "/flows/flow_duo");
  await expect(page.getByTestId("flow-node-review")).toBeVisible();
  await page.getByTestId("versions-button").click();
  const versions = page.getByTestId("version-list");
  await expect(versions.getByRole("listitem")).toHaveCount(3);
  await expect(versions.getByRole("listitem").first()).toContainText("Güncel");
  await settle(page, 500);
  await page.screenshot({ path: shot("flows-editor-versions") });
  await versions.getByRole("button", { name: "Görüntüle v1" }).click();
  await expect(page.getByTestId("preview-banner")).toContainText("v1 görüntüleniyor");
  await expect(page.getByTestId("flow-node-review")).toHaveCount(0);
  await expect(page.getByLabel("Akış adı")).toHaveValue("İlk taslak");
  await settle(page, 900);
  await page.screenshot({ path: shot("flows-editor-preview") });
  // Read-only: deleting does nothing.
  await page.getByTestId("flow-node-dev").click();
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("flow-node-dev")).toBeVisible();

  await page.getByTestId("preview-banner").getByRole("button", { name: "Bu sürümü geri yükle" }).click();
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("preview-banner")).toBeHidden();
  await expect(page.getByText("v1 geri yüklendi · yeni sürüm v4")).toBeVisible();
  expect(m.updates).toHaveLength(1);
  expect((m.updates[0]!.body.graph as { nodes: unknown[] }).nodes).toHaveLength(2);
  await expect(page.getByTestId("flow-toolbar").getByText("v4", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("start a task with this flow", async ({ page }) => {
  const errors = collectErrors(page);
  await installMockApi(page);
  const m = await installFlowMock(page);
  await open(page, "/flows/flow_duo");
  await page.getByTestId("start-task").click();
  const dialog = page.getByRole("dialog", { name: "Bu akışla görev başlat" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /İstem/ }).fill("Limit çubuklarını üst çubuğa ekle\nRenkler %70 ve %90'da değişsin.");
  await settle(page, 300);
  await page.screenshot({ path: shot("flows-start-task") });
  await dialog.getByTestId("start-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Görev başlatıldı")).toBeVisible();
  expect(m.tasks).toEqual([
    { workspace_id: "ws_1", title: "Limit çubuklarını üst çubuğa ekle", prompt: "Limit çubuklarını üst çubuğa ekle\nRenkler %70 ve %90'da değişsin.", mode: "custom", flow_id: "flow_duo", start: true },
  ]);
  expect(errors).toEqual([]);
});

test("leaving with unsaved changes asks first", async ({ page }) => {
  const errors = collectErrors(page);
  await installMockApi(page);
  await installFlowMock(page);
  await open(page, "/flows/flow_duo");
  await page.getByLabel("Akış adı").fill("İkili inceleme akışı (yeni)");
  await page.getByRole("link", { name: /Görevler/ }).click();
  const dialog = page.getByRole("dialog", { name: "Kaydedilmemiş değişiklikler var" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Sayfada kal" }).click();
  await expect(page).toHaveURL(/#\/flows\/flow_duo$/);
  await page.getByRole("link", { name: /Görevler/ }).click();
  await page.getByTestId("confirm").click();
  await expect(page).toHaveURL(/#\/tasks$/);
  expect(errors).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`template chooser for a new flow (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    await installFlowMock(page);
    await open(page, "/flows/new");
    await expect(page.getByTestId("template-chooser")).toBeVisible();
    await expect(page.getByTestId("studio-architecture")).toBeVisible();
    await settle(page, 1200);
    await page.screenshot({ path: shot(`flows-chooser-${scheme}`) });
    await page.getByTestId("studio-architecture").click();
    await expect(page.getByTestId("flow-node-synthesis")).toBeVisible();
    await expect(page.getByLabel("Akış adı")).toHaveValue("Mimari tasarım");
    await settle(page, 600);
    expect(errors).toEqual([]);
  });
}

test("schedules: build a cron, create, toggle, run now, delete", async ({ page }) => {
  const errors = collectErrors(page);
  await installMockApi(page);
  const m = await installFlowMock(page);
  await open(page, "/flows/schedules");
  await expect(page.getByTestId("schedule-sch_1").getByTestId("schedule-description")).toHaveText("Hafta içi her gün 08:45");
  await expect(page.getByTestId("schedule-sch_1")).toContainText("5 Eki Pzt 08:45");

  await page.getByTestId("new-schedule").click();
  const form = page.getByTestId("schedule-form");
  await form.getByRole("textbox", { name: "Ad" }).fill("Haftalık güvenlik taraması");
  await form.getByRole("textbox", { name: "Görev başlığı" }).fill("Güvenlik taraması");
  await form.getByRole("textbox", { name: "İstem" }).fill("Bağımlılıklardaki açıkları tara ve düzelt.");
  await form.getByRole("radio", { name: "Haftalık" }).click();
  await form.getByRole("button", { name: "Çarşamba" }).click();
  await expect(page.getByTestId("cron-description")).toHaveText("Pazartesi ve çarşamba 08:45");
  await expect(page.getByTestId("next-runs").getByRole("listitem")).toHaveCount(5);
  await expect(page.getByTestId("next-runs").getByRole("listitem").first()).toContainText("5 Eki Pzt");
  await form.getByRole("textbox", { name: "Saat" }).fill("10");
  await expect(page.getByTestId("cron-description")).toHaveText("Pazartesi ve çarşamba 10:45");
  await settle(page, 500);
  await page.screenshot({ path: shot("flows-schedule-builder") });

  // Advanced cron: errors are explained, valid input is described.
  await form.getByRole("radio", { name: "Özel" }).click();
  await page.getByTestId("cron-input").fill("61 * * * *");
  await expect(form.getByRole("alert")).toContainText(/dakika/i);
  await expect(page.getByTestId("schedule-submit")).toBeDisabled();
  await page.getByTestId("cron-input").fill("45 10 * * 1,3");
  await expect(page.getByTestId("cron-description")).toHaveText("Pazartesi ve çarşamba 10:45");
  await page.getByTestId("schedule-submit").click();
  await expect(page.getByTestId("schedule-form")).toBeHidden();
  const created = m.schedules.at(-1)!;
  expect(created).toMatchObject({ name: "Haftalık güvenlik taraması", cron: "45 10 * * 1,3", timezone: "Europe/Istanbul", enabled: true, template: { title: "Güvenlik taraması", mode: "duo", flow_id: null } });
  await expect(page.getByTestId(`schedule-${String(created.id)}`)).toBeVisible();

  // Enable the paused one.
  await page.getByTestId("schedule-sch_2").getByRole("switch").click();
  await expect.poll(() => m.schedules.find((x) => x.id === "sch_2")?.enabled).toBe(true);

  // Run now.
  await page.getByTestId("schedule-sch_1").getByTestId("run-now").click();
  await expect(page.getByText("Görev oluşturuldu")).toBeVisible();
  expect(m.scheduleRuns).toEqual(["sch_1"]);

  // Delete.
  await page.getByTestId("schedule-sch_1").getByRole("button", { name: "Sil" }).click();
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("schedule-sch_1")).toHaveCount(0);
  expect(m.schedules.some((x) => x.id === "sch_1")).toBe(false);
  expect(errors).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`empty and error states (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMockApi(page);
    await installFlowMock(page, (m) => {
      m.flows = [];
      m.schedules = [];
    });
    await open(page, "/flows");
    await expect(page.getByText("Henüz kayıtlı akış yok")).toBeVisible();
    await settle(page, 800);
    await page.screenshot({ path: shot(`flows-list-empty-${scheme}`) });

    await open(page, "/flows/schedules");
    await expect(page.getByText("Henüz zamanlama yok")).toBeVisible();
    await settle(page, 600);
    await page.screenshot({ path: shot(`flows-schedules-empty-${scheme}`) });

    await open(page, "/flows/flow_missing");
    await expect(page.getByText("Akış bulunamadı")).toBeVisible();
    await settle(page, 600);
    await page.screenshot({ path: shot(`flows-editor-missing-${scheme}`) });

    // studiod answers with an error: a Turkish message and a retry.
    await page.route(/\/api\/engine\/flows(\?.*)?$/, (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Akış deposu okunamadı." } }) }) : route.fallback(),
    );
    await open(page, "/flows");
    await page.reload(); // drop the cached (fresh) list
    await expect(page.getByText("Akışlar yüklenemedi")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Akış deposu okunamadı.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Tekrar dene" })).toBeVisible();
    await settle(page, 500);
    await page.screenshot({ path: shot(`flows-list-error-${scheme}`) });
    expect(errors.filter((e) => !/500/.test(e))).toEqual([]);
  });
}

function everyKindGraph() {
  const g = (id: string, label: string, config: Json) => ({ id, label, config, position: null });
  return {
    nodes: [
      g("plan", "Planlayıcı", agent("claude", { role: "planner", writes: false, output_format: "plan", boundaries: { forbidden_paths: ["infra/**"], readonly_paths: [], allowed_commands: ["pnpm test*"], denied_commands: [], network: true, sandbox: "workspace_write", remote_access: "none" }, tool_names: ["studio_memory_read"], repo_ids: ["repo_web"], max_turns: 40 })),
      g("fork", "Paralel başlat", { kind: "parallel" }),
      g("advisor", "Güvenlik danışmanı", { kind: "advisor", profile_id: "prof_codex_reviewer", provider: null, model: null, effort: null, perspective: "Güvenlik odaklı", prompt_template: "{{ input.prompt }}", web_access: true }),
      g("dev", "Geliştirici", agent("codex")),
      g("join", "Birleş", { kind: "join", mode: "any" }),
      g("review", "Çapraz inceleme", gate("cross_review", { reviewer_profile_id: "prof_codex_reviewer", review_focus: "Hata yönetimi" })),
      g("cond", "Bulgu yok mu?", { kind: "condition", expression: "nodes.review.data.findings | length == 0", max_loops: 2 }),
      g("compare", "Karşılaştır", { kind: "compare", judge: "agent", judge_profile_id: "prof_claude_writer", criteria: "Doğruluk ve sadelik.", run_gates: ["build_test"] }),
      g("synth", "Sentez", { kind: "synthesis", profile_id: null, provider: "claude", model: "claude-opus-5-5", devil_advocate: true, prompt_template: "", output_format: "report", propose_memory: false }),
      g("human", "Ürün onayı", { kind: "human", instructions: "Ekran görüntülerini kontrol et.", input_schema: { type: "object", properties: { ok: { type: "boolean" } } } }),
      g("merge", "Birleştir", { kind: "merge", target_ref: "main", strategy: "merge", require_approval: true, resolve_conflicts_with_agent: false }),
      g("git", "PR aç", { kind: "git", action: "open_pr", base_ref: "main", draft: true, title_template: "{{ task.title }}", body_template: null, watch: true, autofix: true, push_branch_template: null }),
      g("deploy", "Production deploy", { kind: "deploy", profile_id: "dep_prod" }),
      g("deploy_gate", "Deploy onayı", gate("deploy_approval")),
    ],
    edges: [
      edge("plan", "fork"),
      edge("fork", "advisor"),
      edge("fork", "dev"),
      edge("advisor", "join"),
      edge("dev", "join"),
      edge("join", "review"),
      edge("review", "cond"),
      edge("cond", "compare", "true"),
      edge("cond", "dev", "false"),
      edge("compare", "synth"),
      edge("synth", "human"),
      edge("human", "merge", "approved"),
      edge("merge", "git"),
      edge("git", "deploy_gate"),
      edge("deploy_gate", "deploy"),
    ],
    settings: settings(),
    inputs: { push_branch: { type: "string" } },
  };
}

test("inspector forms for every node kind", async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 2200 });
  await installMockApi(page);
  await installFlowMock(page, (m) => m.flows.push(savedFlow("flow_all", "Tüm düğümler", everyKindGraph(), 1)));
  await open(page, "/flows/flow_all");
  await expect(page.locator(".react-flow__node")).toHaveCount(14);
  await settle(page, 900);
  await page.screenshot({ path: shot("flows-every-kind-canvas"), clip: { x: 236, y: 48, width: 1204, height: 900 } });
  const ids = ["plan", "advisor", "review", "cond", "compare", "synth", "human", "merge", "git", "deploy", "deploy_gate", "join", "fork"];
  for (const id of ids) {
    await selectNode(page, id);
    await expect(page.getByTestId("inspector")).toHaveCount(1);
    await expect(page.getByTestId("node-inspector")).toHaveCount(1);
    await settle(page, 450);
    await page.getByTestId("inspector").screenshot({ path: shot(`flows-inspector-${id}`) });
  }
  // Edge inspector and multi-selection.
  await page.keyboard.press("Escape");
  await page.getByTestId("edge-pill-e_cond_compare_true").click();
  await expect(page.getByTestId("edge-inspector")).toHaveCount(1);
  await expect(page.getByTestId("inspector")).toHaveCount(1);
  await settle(page, 400);
  await page.getByTestId("inspector").screenshot({ path: shot("flows-inspector-edge") });
  await page.keyboard.press("Escape");
  await page.locator(".react-flow__pane").click({ position: { x: 640, y: 1900 } });
  await page.keyboard.press(`${mod}+a`);
  await expect(page.getByTestId("inspector")).toContainText("öğe seçili");
  await settle(page, 400);
  await page.getByTestId("inspector").screenshot({ path: shot("flows-inspector-multi") });
  expect(errors).toEqual([]);
});

test("a 60-node flow renders, lays out and drags smoothly", async ({ page }) => {
  const errors = collectErrors(page);
  await installMockApi(page);
  const nodes: Json[] = [];
  const edges: Json[] = [];
  for (let i = 0; i < 60; i++) {
    const config = i % 5 === 4 ? gate("build_test") : agent(i % 2 ? "codex" : "claude");
    nodes.push({ id: `n${i}`, label: `Adım ${i + 1}`, config, position: null });
    if (i > 0) edges.push(edge(`n${Math.floor((i - 1) / 2)}`, `n${i}`));
  }
  await installFlowMock(page, (m) => m.flows.push(savedFlow("flow_big", "Büyük akış", { nodes, edges, settings: settings(), inputs: {} }, 1)));
  await open(page, "/flows/flow_big");
  await expect(page.locator(".react-flow__node")).toHaveCount(60);
  await page.getByRole("button", { name: "Otomatik yerleşim" }).click();
  await settle(page, 900);

  const idle = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0;
        const start = performance.now();
        const tick = () => {
          count++;
          if (performance.now() - start < 1000) requestAnimationFrame(tick);
          else resolve(count);
        };
        requestAnimationFrame(tick);
      }),
  );
  test.info().annotations.push({ type: "idle-fps", description: String(idle) });
  const box = await page.locator('.react-flow__node[data-id="n0"]').boundingBox();
  if (!box) throw new Error("node missing");
  const frames = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0;
        const start = performance.now();
        const tick = () => {
          count++;
          if (performance.now() - start < 1000) requestAnimationFrame(tick);
          else resolve(count);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  for (let i = 0; i < 30; i++) await page.mouse.move(box.x + 40 + i * 6, box.y + 20 + i * 3);
  await page.mouse.up();
  const fps = await frames;
  test.info().annotations.push({ type: "fps-while-dragging", description: String(fps) });
  // Headless software rendering: compare against the idle frame rate of this machine.
  expect(fps).toBeGreaterThan(Math.min(20, idle * 0.4));
  await page.screenshot({ path: shot("flows-editor-large") });
  expect(errors).toEqual([]);
});
