/**
 * E2E: sessions list, live session stream (backfill + live deltas, tool rows, inline
 * permission), composer actions, new-session dialog and existing-session discovery/import.
 * Screenshots go to test-results/screens/ (light and dark).
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { approval, installMockApi, NOW, session, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const iso = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000).toISOString();
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const LIMITS_DIFF = [
  "--- a/src/ui/limits.ts",
  "+++ b/src/ui/limits.ts",
  "@@ -18,7 +18,12 @@ export function limitTone(percent: number, status?: string): LimitTone {",
  " }",
  " ",
  "-export function resetCountdown(resetsAt: string | null | undefined, now: number): string | null {",
  "-  if (!resetsAt) return null;",
  "+export function resetCountdown(resetsAt: string | null | undefined, now: number): string | null {",
  "+  if (!resetsAt) return null;",
  "+  const ms = Date.parse(resetsAt) - now;",
  "+  if (!Number.isFinite(ms)) return null;",
  '+  if (ms <= 0) return "şimdi";',
  "+  return formatDuration(ms);",
  " }",
  "",
].join("\n");

let seq = 0;
function ev(type: string, payload: Record<string, unknown>, sessionId = "ses_1", ts = -600 + seq * 9) {
  seq += 1;
  return {
    id: seq,
    ts: iso(ts),
    type,
    severity: "info",
    actor: `agent:${sessionId}`,
    workspace_id: "ws_1",
    task_id: null,
    run_id: null,
    session_id: sessionId,
    payload,
    ephemeral: false,
  };
}

function claudeHistory() {
  seq = 0;
  return [
    ev("agent.session.created", { session_id: "ses_1", provider: "claude", role: "writer", label: "Limit çubukları", model: "claude-opus-5-5" }),
    ev("agent.session.started", { native_id: "6f1c2a", model: "claude-opus-5-5", cwd: "/Users/demo/src/odeme-servisi/apps/web", cli_version: "2.1.288" }),
    ev("agent.turn.started", { turn_id: "t1", input: "Üst çubuktaki limit çubuklarına sıfırlanma geri sayımı ekle ve testlerini yaz." }),
    ev("agent.thinking", {
      message_id: "th1",
      text: "Önce LimitBar bileşenine ve limits.ts içindeki yardımcılara bakmalıyım. Geri sayım için useNow ile paylaşılan bir saat var; onu kullanırsam her çubuk ayrı zamanlayıcı açmaz.",
    }),
    ev("agent.message", { message_id: "m1", role: "assistant", text: "LimitBar bileşenini ve sıfırlanma yardımcılarını inceliyorum." }),
    ev("agent.tool.call", {
      call_id: "c1",
      tool: "Read",
      kind: "file_read",
      input: { file_path: "/Users/demo/src/odeme-servisi/apps/web/src/ui/LimitBar.tsx" },
      summary: "src/ui/LimitBar.tsx okunuyor",
    }),
    ev("agent.tool.result", { call_id: "c1", output: 'import { motion } from "motion/react";\n…', is_error: false }),
    ev("agent.tool.call", {
      call_id: "c2",
      tool: "Grep",
      kind: "search",
      input: { pattern: "resetCountdown", path: "src" },
      summary: '"resetCountdown" aranıyor',
    }),
    ev("agent.tool.result", { call_id: "c2", output: "src/ui/limits.ts:21\nsrc/ui/LimitBar.tsx:39", is_error: false }),
    ev("agent.tool.call", {
      call_id: "c3",
      tool: "Edit",
      kind: "file_edit",
      input: { file_path: "/Users/demo/src/odeme-servisi/apps/web/src/ui/limits.ts" },
      summary: "src/ui/limits.ts düzenleniyor",
    }),
    ev("agent.tool.result", { call_id: "c3", output: "Dosya güncellendi.", is_error: false }),
    ev("agent.file.changed", { path: "src/ui/limits.ts", change: "modify", diff: LIMITS_DIFF }),
    ev("agent.tool.call", {
      call_id: "c4",
      tool: "Bash",
      kind: "command",
      input: { command: "pnpm test --run src/ui/limits.test.ts" },
      summary: "`pnpm test` çalıştırılıyor",
    }),
    ev("agent.tool.result", {
      call_id: "c4",
      output:
        "\u001b[32m✓\u001b[39m src/ui/limits.test.ts (9 tests) 14ms\n\n Test Files  \u001b[32m1 passed\u001b[39m (1)\n      Tests  \u001b[32m9 passed\u001b[39m (9)\n   Duration  412ms",
      is_error: false,
      exit_code: 0,
    }),
    ev("agent.message", {
      message_id: "m2",
      role: "assistant",
      text: "Geri sayımı ekledim:\n\n- `resetCountdown` artık geçmiş zamanlar için **şimdi** döndürüyor.\n- `LimitBar` paylaşılan `useNow(1000)` saatini kullanıyor; on çubuk tek zamanlayıcıyla çalışıyor.\n\nTestlerin hepsi geçti (9/9).",
    }),
    ev("agent.usage", { input_tokens: 48210, output_tokens: 6120, context_used: 84000, context_window: 200000 }),
    ev("agent.turn.completed", { turn_id: "t1", status: "success", usage: { input_tokens: 48210, output_tokens: 6120, duration_ms: 74000 } }),
    ev("agent.turn.started", { turn_id: "t2", input: "Lint'i de çalıştırıp düzelt." }),
    ev("agent.permission.request", {
      request_id: "r1",
      tool: "Bash",
      kind: "command",
      summary: "`pnpm lint --fix` komutunu çalıştırmak istiyor",
      command: "pnpm lint --fix",
      paths: [],
      verdict: "ask",
      rule: "unknown_command",
      policy_reason: "Komut güvenli listede değil; kullanıcı onayı gerekiyor.",
    }),
  ];
}

function codexHistory() {
  seq = 100;
  return [
    ev("agent.session.started", { native_id: "thr_9", model: "gpt-5.5-codex", cwd: "/Users/demo/src/odeme-servisi", cli_version: "0.160.0" }, "ses_2"),
    ev("agent.turn.started", { turn_id: "x1", input: "LimitBar değişikliğini incele; engelleyici bulgu varsa yaz." }, "ses_2"),
    ev("agent.tool.call", { call_id: "k1", tool: "shell", kind: "command", input: { command: "bash -lc 'git diff --stat main'" } }, "ses_2"),
    ev(
      "agent.tool.result",
      {
        call_id: "k1",
        output: " src/ui/LimitBar.tsx | 14 ++++++----\n src/ui/limits.ts    |  9 +++++++--\n 2 files changed, 15 insertions(+), 8 deletions(-)",
        exit_code: 0,
      },
      "ses_2",
    ),
    ev("agent.thinking", { message_id: "kt", text: "Countdown uses a shared ticker; check reduced motion and the exhausted state." }, "ses_2"),
    ev(
      "agent.message",
      { message_id: "km", text: "İnceleme bitti. **Engelleyici bulgu yok.** Bir öneri: `resetCountdown` için negatif süre testi ekleyin." },
      "ses_2",
    ),
    ev("agent.turn.completed", { turn_id: "x1", status: "success", usage: { input_tokens: 21400, output_tokens: 1880, duration_ms: 31000 } }, "ses_2"),
  ];
}

interface Extra {
  calls: { method: string; path: string; body: unknown }[];
}

async function setup(page: Page, opts: { scheme?: "light" | "dark" } = {}): Promise<MockApi & Extra> {
  if (opts.scheme) await page.emulateMedia({ colorScheme: opts.scheme });
  const api = await installMockApi(page, (s) => {
    s.sessions = [
      session("ses_1", { state: "waiting_permission", native_id: "6f1c2a", updated_at: iso(-10) }),
      session("ses_2", {
        provider: "codex",
        label: "review/limit-bars",
        role: "reviewer",
        model: "gpt-5.5-codex",
        state: "idle",
        cwd: "/Users/demo/src/odeme-servisi",
        last_usage: { input_tokens: 21400, output_tokens: 1880, context_used: 61000, context_window: 192000 },
        updated_at: iso(-300),
      }),
      session("ses_3", {
        provider: "claude",
        label: "Mimari kurul",
        role: "advisor",
        model: "claude-sonnet-5",
        state: "done",
        origin: "imported",
        last_usage: null,
        updated_at: iso(-7200),
      }),
      session("ses_4", {
        provider: "codex",
        label: "fix/flaky-test",
        role: "tester",
        model: "gpt-5.5-codex",
        state: "error",
        last_usage: { input_tokens: 15020, output_tokens: 920, context_used: 140000, context_window: 192000 },
        updated_at: iso(-9000),
      }),
    ];
    s.approvals = [
      approval("apr_perm", {
        kind: "tool_permission",
        title: "İzin isteği - Limit çubukları: `pnpm lint --fix` komutunu çalıştırmak istiyor",
        session_id: "ses_1",
        payload: { session_id: "ses_1", request_id: "r1", tool: "Bash", kind: "command", command: "pnpm lint --fix", paths: [] },
      }),
    ];
  });
  const calls: Extra["calls"] = [];
  const histories: Record<string, unknown[]> = { ses_1: claudeHistory(), ses_2: codexHistory() };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    if (method !== "GET") calls.push({ method, path, body: req.postDataJSON() as unknown });
    if (path === "/events" && url.searchParams.get("session_id")) {
      return json(route, { events: histories[url.searchParams.get("session_id") ?? ""] ?? [], has_more: false });
    }
    const one = /^\/agents\/sessions\/([^/]+)$/.exec(path);
    if (one && method === "GET") {
      const s = api.state.sessions.find((x) => x.id === one[1]);
      return s ? json(route, s) : json(route, { error: { code: "not_found", message: "Oturum bulunamadı." } }, 404);
    }
    if (/^\/agents\/sessions\/[^/]+\/(send|steer)$/.test(path)) return json(route, { turn_id: "t3" });
    if (/^\/agents\/sessions\/[^/]+\/interrupt$/.test(path)) return route.fulfill({ status: 204 });
    if (path === "/agents/sessions" && method === "POST") {
      const created = session("ses_new", { label: "Yeni oturum", state: "starting", last_usage: null });
      api.state.sessions.unshift(created);
      return json(route, created, 201);
    }
    if (path === "/agents/health") {
      return json(route, [
        {
          provider: "claude",
          installed: true,
          binary: "/opt/homebrew/bin/claude",
          version: "2.1.288",
          logged_in: true,
          compatible: true,
          tested_range: ">=2.1.200",
          message: null,
        },
        {
          provider: "codex",
          installed: true,
          binary: "/opt/homebrew/bin/codex",
          version: "0.160.0",
          logged_in: true,
          compatible: true,
          tested_range: ">=0.150",
          message: null,
        },
      ]);
    }
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
          builtin: true,
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
          builtin: true,
        },
      ]);
    }
    if (path === "/workspaces/ws_1/repos") {
      return json(route, [
        { id: "repo_1", workspace_id: "ws_1", name: "odeme-servisi", path: "/Users/demo/src/odeme-servisi", host_id: null, default_branch: "main" },
      ]);
    }
    if (path === "/remote/hosts") {
      return json(route, [
        {
          id: "host_prod",
          workspace_id: "ws_1",
          name: "api-prod-1",
          hostname: "10.0.4.12",
          port: 22,
          username: "deploy",
          environment: "production",
          permission_level: "read",
        },
      ]);
    }
    if (path === "/agents/discover") {
      const remote = url.searchParams.get("host_id");
      const d = (native_id: string, cwd: string, title: string, over: Record<string, unknown> = {}) => ({
        provider: "claude",
        native_id,
        location: remote ? { kind: "remote", host_id: remote } : { kind: "local", host_id: null },
        cwd,
        title,
        model: "claude-opus-5-5",
        branch: "main",
        message_count: 24,
        created_at: iso(-90000),
        updated_at: iso(-3600),
        file_path: null,
        running: false,
        imported_session_id: null,
        ...over,
      });
      return json(
        route,
        remote
          ? [d("r1", "/srv/api", "Bağlantı havuzu sızıntısı", { message_count: 61 })]
          : [
              d("n1", "/Users/demo/src/odeme-servisi/apps/web", "Limit çubukları tasarımı", { updated_at: iso(-1800), branch: "feat/limit-bars" }),
              d("n2", "/Users/demo/src/odeme-servisi/apps/web", "Onay kutusu animasyonları", {
                provider: "codex",
                model: "gpt-5.5-codex",
                message_count: 12,
                imported_session_id: "ses_3",
              }),
              d("n3", "/Users/demo/src/mobil", "Push bildirim izni", { updated_at: iso(-86400 * 3), message_count: 8, branch: "fix/push", running: true }),
            ],
      );
    }
    if (path === "/agents/import" && method === "POST") {
      const created = session("ses_imp", { label: "Limit çubukları tasarımı", origin: "imported", state: "idle" });
      api.state.sessions.unshift(created);
      return json(route, created, 201);
    }
    return route.fallback();
  });
  return Object.assign(api, { calls });
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
  test(`sessions list (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, { scheme });
    await page.goto("/#/sessions");
    await expect(page.getByRole("heading", { name: "Oturumlar", level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "Etkin" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Limit çubukları/ }).first()).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`sessions-list-${scheme}`) });
    expect(errors).toEqual([]);
  });

  test(`session stream (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, { scheme });
    await page.goto("/#/sessions/ses_1");
    const log = page.getByRole("log", { name: "Oturum akışı" });
    await expect(log.getByText("LimitBar bileşenini ve sıfırlanma yardımcılarını inceliyorum.")).toBeVisible();
    await expect(log.getByRole("group", { name: "İzin isteği" })).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`sessions-stream-${scheme}`) });

    // Expand the test command: output and exit code show in the LogView.
    await log.getByRole("button", { name: /Komut: pnpm test --run src\/ui\/limits.test.ts çalıştırıldı/ }).click();
    await expect(log.getByRole("log", { name: "Çıktı" })).toBeVisible();
    await log.getByRole("button", { name: /Dosya düzenleme: src\/ui\/limits.ts düzenlendi/ }).click();
    await settle(page, 900);
    await page.screenshot({ path: shot(`sessions-stream-expanded-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("codex session keeps its monochrome language (dark)", async ({ page }) => {
  await setup(page, { scheme: "dark" });
  await page.goto("/#/sessions/ses_2");
  await expect(page.getByRole("log", { name: "Oturum akışı" }).getByText("Engelleyici bulgu yok.")).toBeVisible();
  await settle(page, 900);
  await page.screenshot({ path: shot("sessions-stream-codex-dark") });
});

test("inline permission resolves the matching approval; live deltas stream in", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/sessions/ses_1");
  const log = page.getByRole("log", { name: "Oturum akışı" });
  const card = log.getByRole("group", { name: "İzin isteği" });
  await expect(card.getByRole("button", { name: "İzin ver" })).toBeEnabled();
  await card.getByRole("button", { name: "İzin ver" }).click();
  await expect.poll(() => api.state.decisions).toEqual([{ id: "apr_perm", approve: true, note: null }]);
  await expect(card.getByText("İzin verildi")).toBeVisible();

  api.push("agent.permission.decided", { request_id: "r1", allow: true, decided_by: "user", approval_id: "apr_perm" }, { session_id: "ses_1" });
  api.push("agent.status", { state: "running_tool" }, { session_id: "ses_1" });
  api.push("agent.tool.call", { call_id: "c5", tool: "Bash", kind: "command", input: { command: "pnpm lint --fix" } }, { session_id: "ses_1" });
  await expect(log.getByRole("button", { name: /pnpm lint --fix çalıştırılıyor/ })).toBeVisible();
  api.push("agent.tool.result", { call_id: "c5", output: "✔ 0 sorun", exit_code: 0 }, { session_id: "ses_1" });
  api.push("agent.status", { state: "responding" }, { session_id: "ses_1" });
  for (const chunk of ["Lint temiz: ", "**0 sorun**. ", "Değişiklikleri ", "commit'e hazır."]) {
    api.push("agent.message.delta", { message_id: "m3", text: chunk }, { session_id: "ses_1", id: 0, ephemeral: true });
  }
  await expect(log.getByText("commit'e hazır.")).toBeVisible();
  await settle(page, 300);
  await page.screenshot({ path: shot("sessions-stream-live") });
  api.push("agent.message", { message_id: "m3", role: "assistant", text: "Lint temiz: **0 sorun**. Değişiklikleri commit'e hazır." }, { session_id: "ses_1" });
  api.push(
    "agent.turn.completed",
    { turn_id: "t2", status: "success", usage: { input_tokens: 51000, output_tokens: 6400, duration_ms: 12000 } },
    { session_id: "ses_1" },
  );
  await expect(log.getByText(/Tur tamamlandı · 12 sn/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Oturum durumu" }).getByText("Boşta")).toBeVisible();
});

test("composer sends, steers while busy and interrupts", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/sessions/ses_1");
  const box = page.getByRole("textbox", { name: "Ajana bir mesaj yazın…" });
  await expect(box).toBeVisible();
  // waiting_permission counts as busy: the primary action steers.
  await box.fill("Önce testleri çalıştır");
  await page.getByRole("button", { name: "Yönlendir" }).click();
  await expect.poll(() => api.calls.find((c) => c.path.endsWith("/steer"))?.body).toEqual({ text: "Önce testleri çalıştır" });
  await expect(box).toHaveValue("");
  await page.getByRole("button", { name: "Durdur" }).click();
  await expect.poll(() => api.calls.some((c) => c.path.endsWith("/interrupt"))).toBe(true);

  api.push("agent.turn.completed", { turn_id: "t2", status: "interrupted" }, { session_id: "ses_1" });
  api.push("agent.status", { state: "idle" }, { session_id: "ses_1" });
  await expect(page.getByRole("button", { name: "Gönder" })).toBeVisible();
  await box.fill("Devam et");
  await box.press("Enter");
  await expect.poll(() => api.calls.find((c) => c.path.endsWith("/send"))?.body).toEqual({ text: "Devam et" });
});

test("new session dialog starts a session and opens it", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/sessions");
  await page.getByRole("button", { name: "Yeni oturum" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Yeni oturum" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Oturumu başlat" }).click();
  await expect(dialog.getByText("Çalışma dizini gerekli.")).toBeVisible();
  await dialog.getByRole("button", { name: "Repo" }).click();
  await page.getByRole("menuitemradio", { name: /odeme-servisi/ }).click();
  await expect(dialog.getByRole("textbox", { name: "Çalışma dizini" })).toHaveValue("/Users/demo/src/odeme-servisi");
  await dialog.getByRole("textbox", { name: "İlk mesaj" }).fill("README'yi güncelle");
  await settle(page, 400);
  await page.screenshot({ path: shot("sessions-new-dialog") });
  await dialog.getByRole("button", { name: "Oturumu başlat" }).click();
  await expect(page).toHaveURL(/#\/sessions\/ses_new$/);
  const body = api.calls.find((c) => c.path === "/agents/sessions" && c.method === "POST")?.body as Record<string, unknown>;
  expect(body).toMatchObject({
    workspace_id: "ws_1",
    initial_prompt: "README'yi güncelle",
    spec: { provider: "claude", cwd: "/Users/demo/src/odeme-servisi", location: { kind: "local", host_id: null } },
  });
});

for (const scheme of ["light", "dark"] as const) {
  test(`discover existing sessions and import (${scheme})`, async ({ page }) => {
    const api = await setup(page, { scheme });
    await page.goto("/#/sessions/discover");
    const panel = page.getByRole("tabpanel", { name: "Mevcut oturumlar" });
    await expect(panel.getByRole("region", { name: "/Users/demo/src/odeme-servisi/apps/web" })).toBeVisible();
    await expect(panel.getByText("Eklendi")).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`sessions-discover-${scheme}`) });
    if (scheme === "dark") return;
    await panel.getByRole("button", { name: "Ekle: Limit çubukları tasarımı" }).click();
    await expect.poll(() => api.calls.find((c) => c.path === "/agents/import")?.body).toMatchObject({ workspace_id: "ws_1", session: { native_id: "n1" } });
    await expect(page.getByText("Oturum eklendi")).toBeVisible();
    // Remote host discovery.
    await panel.getByRole("radio", { name: /api-prod-1/ }).click();
    await expect(panel.getByText("Bağlantı havuzu sızıntısı")).toBeVisible();
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`compact stream in the drawer (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, { scheme });
    await page.goto("/#/sessions");
    const card = page
      .getByRole("region", { name: "Etkin" })
      .getByRole("button", { name: /Limit çubukları/ })
      .first();
    await card.hover();
    await card.getByRole("button", { name: "Çekmecede aç" }).click();
    const drawer = page.getByRole("complementary", { name: "Limit çubukları" });
    await expect(drawer.getByRole("log", { name: "Oturum akışı" }).getByText("Geri sayımı ekledim:")).toBeVisible();
    await expect(drawer.getByRole("region", { name: "Oturum durumu" })).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`sessions-drawer-${scheme}`) });
    await drawer.getByRole("button", { name: "Kapat" }).click();
    await expect(drawer).toBeHidden();
    expect(errors).toEqual([]);
  });
}
