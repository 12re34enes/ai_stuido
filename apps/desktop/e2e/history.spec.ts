/**
 * E2E: history — event explorer (filters, inspector, live arrivals, hash-chain verify), replay
 * hub + session replay scrubber, remote audit log (+ export) and agent performance charts.
 * Light and dark screenshots go to test-results/screens/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { installMockApi, NOW, session, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const HASH = (n: number) => `${n.toString(16).padStart(8, "0")}${"ab12cd34ef56".repeat(4)}`.slice(0, 64);

interface Ev {
  id: number;
  ts: string;
  type: string;
  severity: string;
  actor: string;
  workspace_id: string | null;
  task_id: string | null;
  run_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  ephemeral: boolean;
}

function logEvents(): Ev[] {
  const specs: [string, string, string, Record<string, unknown>, Partial<Ev>?][] = [
    ["task.created", "info", "user", { title: "Limit çubuklarına sıfırlanma geri sayımı", mode: "duo" }, { task_id: "task_142" }],
    ["run.started", "info", "engine", { mode: "duo" }, { task_id: "task_142", run_id: "run_7" }],
    [
      "agent.session.created",
      "info",
      "system",
      { provider: "claude", label: "Limit çubukları" },
      { session_id: "ses_1", task_id: "task_142", run_id: "run_7" },
    ],
    [
      "agent.turn.started",
      "info",
      "agent:ses_1",
      { turn_id: "t1", input: "Üst çubuktaki limit çubuklarına sıfırlanma geri sayımı ekle." },
      { session_id: "ses_1" },
    ],
    [
      "agent.tool.call",
      "info",
      "agent:ses_1",
      { call_id: "c1", tool: "Read", kind: "file_read", input: { file_path: "src/ui/LimitBar.tsx" } },
      { session_id: "ses_1" },
    ],
    [
      "agent.tool.call",
      "info",
      "agent:ses_1",
      { call_id: "c2", tool: "Bash", kind: "command", input: { command: "pnpm test --run src/ui/limits.test.ts" } },
      { session_id: "ses_1" },
    ],
    ["agent.tool.result", "info", "agent:ses_1", { call_id: "c2", exit_code: 0, output: "9 passed" }, { session_id: "ses_1" }],
    ["agent.message", "info", "agent:ses_1", { message_id: "m1", text: "Geri sayımı ekledim; 9/9 test geçti." }, { session_id: "ses_1" }],
    ["gate.passed", "info", "engine", { label: "Build/test", summary: "lint, typecheck, test ve build geçti" }, { task_id: "task_142", run_id: "run_7" }],
    [
      "approval.requested",
      "high",
      "agent:ses_2",
      { approval_id: "apr_2", kind: "remote_command", title: "Production komutu: api-prod-1", production: true },
      { session_id: "ses_2" },
    ],
    ["remote.command", "high", "agent:ses_2", { command: "sudo systemctl restart payments-api", host_name: "api-prod-1" }, { session_id: "ses_2" }],
    ["approval.decided", "info", "user", { approval_id: "apr_2", status: "approved", note: "Bellek sızıntısı doğrulandı" }],
    ["limit.warning", "normal", "system", { provider: "codex", window: "seven_day", used_percent: 93, label: "Haftalık" }],
    ["agent.stalled", "critical", "system", { minutes: 12, state: "running_tool", label: "fix/flaky-test" }, { session_id: "ses_4" }],
    ["memory.proposed", "info", "agent:ses_1", { path: "decisions/2026-10-03-limit-esikleri.md", summary: "Limit eşikleri kararı" }],
    ["deploy.succeeded", "info", "engine", { profile_name: "web-test", environment: "test", summary: "web-test ortamına deploy edildi" }],
    ["run.completed", "info", "engine", { status: "completed" }, { task_id: "task_142", run_id: "run_7" }],
  ];
  const out: Ev[] = [];
  for (let i = 0; i < 48; i++) {
    const [type, severity, actor, payload, extra] = specs[i % specs.length]!;
    const id = 1000 + i;
    out.push({
      id,
      ts: iso(-(48 - i) * 17),
      type,
      severity,
      actor,
      workspace_id: "ws_1",
      task_id: null,
      run_id: null,
      session_id: null,
      payload,
      prev_hash: HASH(id - 1),
      hash: HASH(id),
      ephemeral: false,
      ...extra,
    });
  }
  return out.reverse(); // newest first (descending)
}

function sessionEvents(): Ev[] {
  const base = (i: number, type: string, payload: Record<string, unknown>): Ev => ({
    id: 500 + i,
    ts: iso(-40 + i * 0.2),
    type,
    severity: "info",
    actor: "agent:ses_1",
    workspace_id: "ws_1",
    task_id: null,
    run_id: null,
    session_id: "ses_1",
    payload,
    prev_hash: "",
    hash: "",
    ephemeral: false,
  });
  return [
    base(0, "agent.session.started", { native_id: "6f1c2a", model: "claude-opus-5-5", cwd: "/Users/demo/src/odeme-servisi/apps/web", cli_version: "2.1.288" }),
    base(1, "agent.turn.started", { turn_id: "t1", input: "Limit çubuklarına geri sayım ekle." }),
    base(2, "agent.message", { message_id: "m1", text: "LimitBar bileşenini inceliyorum." }),
    base(3, "agent.tool.call", {
      call_id: "c1",
      tool: "Read",
      kind: "file_read",
      input: { file_path: "/Users/demo/src/odeme-servisi/apps/web/src/ui/LimitBar.tsx" },
    }),
    base(4, "agent.tool.result", { call_id: "c1", output: "…" }),
    base(5, "agent.tool.call", { call_id: "c2", tool: "Bash", kind: "command", input: { command: "pnpm test --run" } }),
    base(6, "agent.tool.result", { call_id: "c2", output: "Tests 9 passed (9)", exit_code: 0 }),
    base(7, "agent.message", { message_id: "m2", text: "Geri sayım eklendi; **9/9** test geçti." }),
    base(8, "agent.turn.completed", { turn_id: "t1", status: "success", usage: { input_tokens: 48210, output_tokens: 6120, duration_ms: 52000 } }),
  ];
}

function auditEntries() {
  const e = (i: number, over: Record<string, unknown>) => ({
    event_id: 900 - i,
    ts: iso(-i * 41),
    type: "remote.command",
    severity: "info",
    actor: "agent:ses_2",
    workspace_id: "ws_1",
    task_id: null,
    session_id: "ses_2",
    target_kind: "host",
    target_id: "host_prod",
    target_name: "api-prod-1",
    environment: "production",
    command: "journalctl -u payments-api --since '10 min ago'",
    klass: "read",
    reasons: ["journalctl salt okuma komutu"],
    decision: "allow",
    denied: false,
    denial_reason: null,
    approval_id: null,
    approved_by: null,
    exit_code: 0,
    row_count: null,
    duration_ms: 840,
    output_preview: "Eki 03 10:52:11 api-prod-1 payments-api[812]: heap 1.9 GB\nEki 03 10:52:41 api-prod-1 payments-api[812]: GC pause 412ms",
    source: "remote.exec",
    reason: null,
    error: null,
    hash: HASH(900 - i),
    ...over,
  });
  return [
    e(0, {
      command: "sudo systemctl restart payments-api",
      klass: "write",
      reasons: ["systemctl restart yazma sayılır", "sudo yetki yükseltir"],
      approval_id: "apr_2",
      approved_by: "user",
      decision: "ask",
      duration_ms: 2310,
      output_preview: "",
    }),
    e(1, {}),
    e(2, {
      target_kind: "db",
      target_name: "orders-test",
      environment: "test",
      type: "db.query",
      command: "SELECT count(*) FROM carts WHERE status = 'expired'",
      klass: "read",
      row_count: 1,
      output_preview: "count\n412",
      actor: "user",
    }),
    e(3, {
      command: "rm -rf /var/log/payments/*",
      klass: "write",
      denied: true,
      denial_reason: "Production'da salt okuma: yazma komutu engellendi.",
      exit_code: null,
      duration_ms: null,
      output_preview: "",
      decision: "deny",
    }),
    e(4, {
      target_name: "db-test-1",
      environment: "test",
      command: "pg_repack orders",
      klass: "unknown",
      approval_id: "apr_old2",
      denied: true,
      denial_reason: "Kullanıcı reddetti: Önce yedek alın.",
      exit_code: null,
      duration_ms: null,
    }),
    e(5, { target_name: "web-test-1", environment: "test", command: "docker ps --format '{{.Names}}'", output_preview: "web\nworker" }),
  ];
}

const STATS = {
  stats: [
    {
      profile_id: "prof_cw",
      provider: "claude",
      model: "claude-opus-5-5",
      node_runs: 42,
      passed: 37,
      failed: 5,
      success_rate: 0.881,
      avg_duration_s: 412.5,
      gate_checks: 30,
      gate_first_pass: 24,
      gate_first_pass_rate: 0.8,
      avg_quality: 86.4,
      tasks: 18,
      roles: { writer: 40 },
    },
    {
      profile_id: "prof_xr",
      provider: "codex",
      model: "gpt-5.5-codex",
      node_runs: 35,
      passed: 33,
      failed: 2,
      success_rate: 0.943,
      avg_duration_s: 188.2,
      gate_checks: 12,
      gate_first_pass: 11,
      gate_first_pass_rate: 0.917,
      avg_quality: 82.1,
      tasks: 21,
      roles: { reviewer: 35 },
    },
    {
      profile_id: null,
      provider: "claude",
      model: "claude-sonnet-5",
      node_runs: 14,
      passed: 11,
      failed: 3,
      success_rate: 0.786,
      avg_duration_s: 96.4,
      gate_checks: 6,
      gate_first_pass: 3,
      gate_first_pass_rate: 0.5,
      avg_quality: 74.0,
      tasks: 7,
      roles: { advisor: 14 },
    },
    {
      profile_id: "prof_xw",
      provider: "codex",
      model: "gpt-5.5-codex-mini",
      node_runs: 9,
      passed: 6,
      failed: 3,
      success_rate: 0.667,
      avg_duration_s: 61.0,
      gate_checks: 8,
      gate_first_pass: 4,
      gate_first_pass_rate: 0.5,
      avg_quality: null,
      tasks: 4,
      roles: { tester: 9 },
    },
  ],
  recommendations: [
    "İncelemede Codex (gpt-5.5-codex) daha başarılı: %94 başarı, kapılardan ilk denemede %92 geçiş.",
    "claude-sonnet-5 danışmanlık koşularında kapı ilk geçişi düşük (%50); planlama için Opus'u deneyin.",
  ],
  since: iso(-30 * 24 * 60),
};

interface Extra {
  requests: string[];
  verify: { ok: boolean; first_bad_id: number | null };
}

async function setup(page: Page, scheme?: "light" | "dark"): Promise<MockApi & Extra> {
  if (scheme) await page.emulateMedia({ colorScheme: scheme });
  const api = await installMockApi(page, (s) => {
    s.sessions = [
      session("ses_1", { state: "done", updated_at: iso(-30) }),
      session("ses_2", { provider: "codex", label: "review/limit-bars", role: "reviewer", model: "gpt-5.5-codex", state: "idle", updated_at: iso(-90) }),
      session("ses_3", { label: "Mimari kurul", role: "advisor", model: "claude-sonnet-5", state: "done", origin: "imported", updated_at: iso(-600) }),
    ];
  });
  const extra: Extra = { requests: [], verify: { ok: true, first_bad_id: null } };
  const events = logEvents();
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    extra.requests.push(`${path}${url.search}`);
    if (path === "/events/verify") return json(route, extra.verify);
    if (path === "/events") {
      if (url.searchParams.get("session_id") === "ses_1") return json(route, { events: sessionEvents(), has_more: false });
      const after = url.searchParams.get("after_id");
      if (after) return json(route, { events: events.filter((x) => x.id === Number(after) + 1), has_more: false });
      const types = url.searchParams.get("types")?.split(",") ?? null;
      const shown = types ? events.filter((x) => types.some((p) => (p.endsWith(".*") ? x.type.startsWith(p.slice(0, -1)) : x.type === p))) : events;
      return json(route, { events: shown, has_more: false });
    }
    const one = /^\/agents\/sessions\/([^/]+)$/.exec(path);
    if (one) {
      const s = api.state.sessions.find((x) => x.id === one[1]);
      return s ? json(route, s) : json(route, { error: { code: "not_found", message: "Oturum bulunamadı." } }, 404);
    }
    if (path === "/engine/tasks") {
      return json(route, [
        {
          id: "task_142",
          workspace_id: "ws_1",
          title: "Limit çubuklarına sıfırlanma geri sayımı",
          mode: "duo",
          status: "completed",
          current_run_id: "run_7",
          quality_score: 86,
          created_at: iso(-200),
          updated_at: iso(-35),
        },
        {
          id: "task_141",
          workspace_id: "ws_1",
          title: "Onay kutusu animasyonları",
          mode: "race",
          status: "running",
          current_run_id: "run_6",
          quality_score: null,
          created_at: iso(-300),
          updated_at: iso(-3),
        },
        {
          id: "task_139",
          workspace_id: "ws_1",
          title: "Ödeme servisi bağlantı havuzu",
          mode: "pipeline",
          status: "failed",
          current_run_id: "run_5",
          quality_score: 41,
          created_at: iso(-3000),
          updated_at: iso(-2400),
        },
      ]);
    }
    if (path === "/engine/stats/agents") return json(route, STATS);
    if (path === "/agents/profiles") {
      return json(route, [
        {
          id: "prof_cw",
          workspace_id: null,
          name: "Claude yazar",
          provider: "claude",
          model: "claude-opus-5-5",
          effort: null,
          role: "writer",
          instructions: "",
          color: null,
        },
        {
          id: "prof_xr",
          workspace_id: null,
          name: "Codex inceleyen",
          provider: "codex",
          model: "gpt-5.5-codex",
          effort: null,
          role: "reviewer",
          instructions: "",
          color: null,
        },
        {
          id: "prof_xw",
          workspace_id: null,
          name: "Codex test eden",
          provider: "codex",
          model: "gpt-5.5-codex-mini",
          effort: null,
          role: "tester",
          instructions: "",
          color: null,
        },
      ]);
    }
    if (path === "/remote/audit") return json(route, { entries: auditEntries(), has_more: false, next_before_id: null });
    if (path === "/remote/audit/export") {
      return route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: { "content-disposition": 'attachment; filename="aistudio-remote-audit.csv"' },
        body: "event_id,ts,command\n900,2026-10-03T08:00:00Z,journalctl\n",
      });
    }
    return route.fallback();
  });
  return Object.assign(api, extra);
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
  test(`event explorer + inspector (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, scheme);
    await page.goto("/#/history");
    const list = page.getByRole("listbox", { name: "Olaylar" });
    await expect(list.getByRole("option").first()).toBeVisible();
    await list
      .getByRole("option", { name: /Production komutu: api-prod-1/ })
      .first()
      .click();
    const inspector = page.getByRole("complementary", { name: "Olay" });
    await expect(inspector.getByText("approval.requested")).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`history-events-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("event filters go to the API; severity filters on the client; live events arrive", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/history");
  const list = page.getByRole("listbox", { name: "Olaylar" });
  await expect(list.getByRole("option").first()).toBeVisible();
  await page.getByRole("button", { name: "Tür" }).click();
  await page.getByRole("menuitemradio", { name: /Uzak bağlantı/ }).click();
  await expect.poll(() => api.requests.some((r) => r.includes("types=remote.*%2Cdb.*") || r.includes("types=remote.*,db.*"))).toBe(true);
  await expect(list.getByRole("option")).toHaveCount(3);
  await page.getByRole("button", { name: "Tür" }).click();
  await page.getByRole("menuitemradio", { name: /Tüm türler/ }).click();
  await page.getByRole("button", { name: "Önem" }).click();
  await page.getByRole("menuitemradio", { name: "Yüksek" }).click();
  await expect(list.getByRole("option")).toHaveCount(6);
  await page.getByRole("button", { name: "Önem" }).click();
  await page.getByRole("menuitemradio", { name: "Tümü" }).click();
  await page.getByRole("textbox", { name: "Oturum, görev veya koşu kimliği" }).fill("run_7");
  await expect.poll(() => api.requests.some((r) => r.includes("run_id=run_7"))).toBe(true);
  await page.getByRole("textbox", { name: "Oturum, görev veya koşu kimliği" }).fill("");

  api.push("agent.error", { message: "Codex süreci beklenmedik şekilde kapandı" }, { id: 5000, severity: "high", actor: "agent:ses_2", session_id: "ses_2" });
  await expect(list.getByRole("option", { name: /Codex süreci beklenmedik şekilde kapandı/ })).toBeVisible();
});

test("hash chain verification: ok, then a broken link jumps to the event", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/history");
  await page.getByRole("button", { name: "Zinciri doğrula" }).click();
  await expect(page.getByText("Olay zinciri sağlam")).toBeVisible();
  await settle(page, 600);
  await page.screenshot({ path: shot("history-verify-ok") });
  Object.assign(api.verify, { ok: false, first_bad_id: 1010 });
  await page.getByRole("button", { name: "Zinciri doğrula" }).click();
  await expect(page.getByText("Zincir #1010 numaralı olayda bozuk")).toBeVisible();
  await page.getByRole("button", { name: "Olaya git" }).click();
  await expect(page.getByRole("complementary", { name: "Olay" }).getByText("#1.010")).toBeVisible();
  await settle(page, 600);
  await page.screenshot({ path: shot("history-verify-bad") });
});

for (const scheme of ["light", "dark"] as const) {
  test(`replay hub and session replay scrubber (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, scheme);
    await page.goto("/#/history/replay");
    await expect(page.getByRole("link", { name: /Limit çubuklarına sıfırlanma geri sayımı/ })).toHaveAttribute("href", "#/tasks/runs/run_7");
    await settle(page, 900);
    await page.screenshot({ path: shot(`history-replay-hub-${scheme}`) });
    await page.getByRole("link", { name: "Tekrar oynat: Limit çubukları" }).click();
    await expect(page).toHaveURL(/#\/history\/replay\/ses_1$/);
    const log = page.getByRole("log", { name: "Oturum akışı" });
    await expect(log.getByText("Geri sayım eklendi;")).toBeVisible();
    const slider = page.getByRole("slider", { name: "Konum" });
    await slider.fill("3");
    await expect(log.getByText("Geri sayım eklendi;")).toHaveCount(0);
    await expect(log.getByText("LimitBar bileşenini inceliyorum.")).toBeVisible();
    await page.getByRole("button", { name: "Oynat", exact: true }).click();
    await expect(log.getByText("Geri sayım eklendi;")).toBeVisible({ timeout: 8000 });
    await expect(page.getByRole("button", { name: "Oynat", exact: true })).toBeVisible();
    await settle(page, 600);
    await page.screenshot({ path: shot(`history-session-replay-${scheme}`) });
    expect(errors).toEqual([]);
  });

  test(`remote audit log (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, scheme);
    await page.goto("/#/history/audit");
    const row = page.getByRole("button", { name: /sudo systemctl restart payments-api/ });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByText("systemctl restart yazma sayılır · sudo yetki yükseltir")).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`history-audit-${scheme}`) });
    if (scheme === "light") {
      await page.getByRole("button", { name: "Dışa aktar" }).click();
      const download = page.waitForEvent("download");
      await page.getByRole("menuitem", { name: "CSV" }).click();
      expect((await download).suggestedFilename()).toBe("aistudio-remote-audit.csv");
      await expect(page.getByText("Kayıt CSV olarak indirildi")).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test(`agent performance (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, scheme);
    await page.goto("/#/history/performance");
    await expect(page.getByText("Ajan koşusu")).toBeVisible();
    await expect(page.getByRole("img", { name: /gpt-5.5-codex · Codex inceleyen: %94/ }).first()).toBeVisible();
    await settle(page, 1200);
    await page.screenshot({ path: shot(`history-performance-${scheme}`) });
    await page.getByRole("radio", { name: "Tablo" }).click();
    await expect(page.getByRole("table").getByText("Codex test eden")).toBeVisible();
    await settle(page, 500);
    await page.screenshot({ path: shot(`history-performance-table-${scheme}`) });
    expect(errors).toEqual([]);
  });
}
