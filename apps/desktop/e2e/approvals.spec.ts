/**
 * E2E: approvals inbox (production first, filters, keyboard J/K/A/R/Enter), kind-specific
 * detail pages (remote command, plan editing, memory, question, final, merge, budget, human
 * step), decision payloads, production double-press and live updates. Light and dark shots.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { approval, installMockApi, NOW, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const PLAN = [
  "## Hedef",
  "Üst çubuktaki limit çubuklarına sıfırlanma geri sayımı eklemek.",
  "",
  "## Adımlar",
  '1. `resetCountdown` yardımcısını geçmiş zamanlar için "şimdi" döndürecek şekilde güncelle.',
  "2. `LimitBar` içinde paylaşılan `useNow(1000)` saatini kullan.",
  "3. `limits.test.ts` dosyasına sınır durumları için testler ekle.",
  "",
  "## Riskler",
  "- Çok sayıda çubukta zamanlayıcı maliyeti — paylaşılan saat bunu önler.",
].join("\n");

const MEMORY_DIFF = [
  "--- a/decisions/2026-10-03-limit-esikleri.md",
  "+++ b/decisions/2026-10-03-limit-esikleri.md",
  "@@ -0,0 +1,6 @@",
  "+# Limit eşikleri",
  "+",
  "+- Uyarı eşiği: %70 (amber)",
  "+- Kritik eşik: %90 (kırmızı)",
  "+",
  "+Gerekçe: kullanıcı haftalık limite yaklaştığını erken görmeli.",
].join("\n");

const MERGE_PATCH = [
  "diff --git a/src/ui/LimitBar.tsx b/src/ui/LimitBar.tsx",
  "--- a/src/ui/LimitBar.tsx",
  "+++ b/src/ui/LimitBar.tsx",
  "@@ -38,6 +38,8 @@ function Countdown({ resetsAt }: { resetsAt: string | null | undefined }) {",
  "   const now = useNow(1000, Boolean(resetsAt));",
  "-  const left = resetCountdown(resetsAt, Date.now());",
  "+  const left = resetCountdown(resetsAt, now);",
  "+  // Shared ticker: one interval for every bar.",
  "   return (",
].join("\n");

function pendingFixtures() {
  return [
    approval("apr_prod", {
      kind: "remote_command",
      title: "Production komutu: api-prod-1",
      summary: "sudo systemctl restart payments-api — Bellek sızıntısı sonrası servis yeniden başlatılmalı.",
      production: true,
      severity: "critical",
      requested_by: "agent:ses_2",
      session_id: "ses_2",
      created_at: iso(-1),
      expires_at: iso(29),
      payload: {
        host_id: "host_prod",
        host_name: "api-prod-1",
        hostname: "10.0.4.12",
        port: 22,
        environment: "production",
        permission_level: "read",
        command: "sudo systemctl restart payments-api",
        classification: { klass: "write", reasons: ["systemctl restart servis durumunu değiştirir; yazma sayılır.", "sudo yetki yükseltir."] },
        policy_reason: "Production'da her yazma komutu tek tek onaylanır; 'her zaman izin ver' yok.",
        reason: "Bellek sızıntısı sonrası servis yeniden başlatılmalı.",
        source: "remote.exec",
      },
    }),
    approval("apr_plan", {
      kind: "plan",
      title: "Planı onayla: Limit çubuklarına sıfırlanma geri sayımı",
      summary: "3 adım · 2 dosya · çapraz inceleme Codex ile",
      created_at: iso(-4),
      payload: { plan: PLAN, structured: null, node_id: "plan", editable: true },
    }),
    approval("apr_q", {
      kind: "question",
      title: "Geri sayım dakika mı yoksa saniye hassasiyetinde mi gösterilsin?",
      summary: "Haftalık pencerede saniye gereksiz olabilir; 5 saatlik pencerede faydalı.",
      requested_by: "agent:ses_1",
      session_id: "ses_1",
      created_at: iso(-6),
      payload: {
        question: "Geri sayım dakika mı yoksa saniye hassasiyetinde mi gösterilsin?",
        options: ["Dakika", "Saniye", "Pencereye göre"],
        agent_label: "Limit çubukları",
        answer_with: "decision_payload.answer",
      },
    }),
    approval("apr_tool", {
      kind: "tool_permission",
      title: "İzin isteği - review/limit-bars: `rm -rf node_modules/.cache` komutunu çalıştırmak istiyor",
      summary: "Ajan: review/limit-bars (Codex, İnceleyen)\nAraç: shell\nKomut: rm -rf node_modules/.cache",
      requested_by: "agent:ses_2",
      session_id: "ses_2",
      created_at: iso(-8),
      payload: {
        session_id: "ses_2",
        request_id: "r9",
        provider: "codex",
        label: "review/limit-bars",
        tool: "shell",
        kind: "command",
        command: "rm -rf node_modules/.cache",
        paths: ["node_modules/.cache"],
        cwd: "/Users/demo/src/odeme-servisi",
        input: { command: "rm -rf node_modules/.cache" },
        policy_rule: "unknown_command",
        policy_reason: "Silme komutu; kullanıcı onayı gerekiyor.",
      },
    }),
    approval("apr_mem", {
      kind: "memory",
      title: "Hafıza önerisi: decisions/2026-10-03-limit-esikleri.md",
      summary: "Limit eşikleri kararı (%70 / %90) kalıcı hale getirilsin.",
      severity: "normal",
      created_at: iso(-26),
      payload: {
        proposal_id: "mp_1",
        path: "decisions/2026-10-03-limit-esikleri.md",
        layer: "decisions",
        diff: MEMORY_DIFF,
        content:
          "# Limit eşikleri\n\n- Uyarı eşiği: %70 (amber)\n- Kritik eşik: %90 (kırmızı)\n\nGerekçe: kullanıcı haftalık limite yaklaştığını erken görmeli.\n",
        rationale: "Limit eşikleri kararı (%70 / %90) kalıcı hale getirilsin.",
        additions: 6,
        deletions: 0,
      },
    }),
    approval("apr_db", {
      kind: "db_write",
      title: "Veritabanı yazma onayı: orders-test",
      summary: "UPDATE carts SET status = 'expired' …",
      created_at: iso(-31),
      payload: {
        profile_id: "db_1",
        profile_name: "orders-test",
        kind: "postgres",
        database: "orders",
        environment: "test",
        permission_level: "limited",
        query: "UPDATE carts\nSET status = 'expired'\nWHERE updated_at < now() - interval '30 days';",
        classification: { klass: "write", reasons: ["UPDATE ifadesi yazma sayılır."] },
        policy_reason: "Sınırlı yazma: test ortamında onayla çalışır.",
        source: "db.query",
      },
    }),
    approval("apr_final", {
      kind: "final",
      title: "Son onay: Limit çubuklarına sıfırlanma geri sayımı",
      summary: "**Görev:** Limit çubuklarına sıfırlanma geri sayımı",
      created_at: iso(-40),
      payload: {
        summary:
          "**Görev:** Limit çubuklarına sıfırlanma geri sayımı\n\n**Ajanın özeti:**\nGeri sayım eklendi; paylaşılan saat kullanılıyor. 9/9 test geçti.\n\n**Değişiklikler:** 2 dosya, +21 −6",
        diffstat: [
          {
            repo: "odeme-servisi",
            branch: "aistudio/task_142/claude-1",
            files: [
              { path: "src/ui/LimitBar.tsx", status: "M", additions: 14, deletions: 6 },
              { path: "src/ui/limits.ts", status: "M", additions: 7, deletions: 0 },
            ],
            additions: 21,
            deletions: 6,
          },
        ],
        gates: [
          { node_id: "g1", label: "Sınır denetimi", kind: "boundary_check", status: "passed", summary: "Yasak yollara dokunulmadı.", attempt: 1 },
          { node_id: "g2", label: "Build/test", kind: "build_test", status: "passed", summary: "lint, typecheck, test, build geçti.", attempt: 1 },
          { node_id: "g3", label: "Çapraz inceleme (Codex)", kind: "cross_review", status: "passed", summary: "Engelleyici bulgu yok; 1 öneri.", attempt: 2 },
        ],
        evidence: [
          { id: "evd_1", title: "pnpm test çıktısı", kind: "command", source: "gate" },
          { id: "evd_2", title: "İnceleme raporu", kind: "review", source: "gate" },
        ],
      },
    }),
    approval("apr_merge", {
      kind: "merge",
      title: "Birleştirme onayı: Limit çubuklarına sıfırlanma geri sayımı",
      summary: "- odeme-servisi: aistudio/task_142/claude-1 → main (1 dosya)",
      created_at: iso(-44),
      payload: {
        strategy: "squash",
        conflicts_resolved: false,
        merges: [
          {
            repo: "odeme-servisi",
            worktree_id: "wt_1",
            branch: "aistudio/task_142/claude-1",
            target_ref: "main",
            files: ["src/ui/LimitBar.tsx"],
            additions: 2,
            deletions: 1,
            patch: MERGE_PATCH,
          },
        ],
      },
    }),
    approval("apr_budget", {
      kind: "budget",
      title: "Claude limiti dolu: çapraz inceleme",
      summary: "Claude haftalık penceresi %100. Sıfırlanma: 2 sa 14 dk.",
      created_at: iso(-50),
      payload: {
        provider: "claude",
        purpose: "çapraz inceleme",
        exhausted: true,
        options: ["same_provider", "switch", "wait"],
        resets_at: iso(134),
        node_id: "review",
      },
    }),
    approval("apr_human", {
      kind: "custom",
      title: "Sürüm notlarını onayla",
      summary: "Yayın öncesi sürüm numarasını ve notları girin.",
      created_at: iso(-55),
      payload: {
        type: "human",
        instructions: "Yayın öncesi **sürüm numarasını** ve kısa notları girin. Production deploy bu adımdan sonra başlar.",
        input_schema: {
          type: "object",
          required: ["version"],
          properties: {
            version: { type: "string", title: "Sürüm" },
            notes: { type: "string", title: "Notlar", format: "textarea" },
            announce: { type: "boolean", title: "Ekibe duyur" },
          },
        },
      },
    }),
  ];
}

function decidedFixtures() {
  return [
    approval("apr_old1", {
      kind: "deploy",
      title: "Deploy onayı: web-test",
      status: "approved",
      decided_by: "user",
      channel: "app",
      decision_note: "Test ortamı hazır.",
      decided_at: iso(-120),
      created_at: iso(-130),
      payload: { profile_name: "web-test", kind: "ssh", environment: "test", ref: "a1b2c3d4e5f6" },
    }),
    approval("apr_old2", {
      kind: "remote_command",
      title: "Uzak komut onayı: db-test-1",
      status: "rejected",
      decided_by: "channel:telegram",
      channel: "telegram",
      decision_note: "Önce yedek alın.",
      decided_at: iso(-300),
      created_at: iso(-310),
      payload: { host_name: "db-test-1", environment: "test", command: "pg_repack orders", classification: { klass: "write", reasons: [] } },
    }),
    approval("apr_old3", {
      kind: "question",
      title: "Hangi tarayıcılar desteklensin?",
      status: "expired",
      decided_by: "system",
      channel: "system",
      decided_at: iso(-900),
      created_at: iso(-960),
      payload: { question: "Hangi tarayıcılar desteklensin?", options: [] },
    }),
  ];
}

interface Decision {
  id: string;
  approve: boolean;
  note: string | null;
  decision_payload: Record<string, unknown> | null;
}

async function setup(page: Page, opts: { scheme?: "light" | "dark" } = {}): Promise<MockApi & { decided: Decision[] }> {
  if (opts.scheme) await page.emulateMedia({ colorScheme: opts.scheme });
  const api = await installMockApi(page, (s) => {
    s.approvals = [...pendingFixtures(), ...decidedFixtures()];
  });
  const decided: Decision[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    if (path === "/approvals" && method === "GET") {
      const status = url.searchParams.get("status") ?? "pending";
      return json(
        route,
        api.state.approvals.filter((a) => a.status === status),
      );
    }
    const one = /^\/approvals\/([^/]+)$/.exec(path);
    if (one && method === "GET") {
      const a = api.state.approvals.find((x) => x.id === one[1]);
      return a ? json(route, a) : json(route, { error: { code: "not_found", message: "Onay isteği bulunamadı." } }, 404);
    }
    const decision = /^\/approvals\/([^/]+)\/decision$/.exec(path);
    if (decision && method === "POST") {
      const body = req.postDataJSON() as Decision;
      const a = api.state.approvals.find((x) => x.id === decision[1]);
      decided.push({ id: decision[1] ?? "", approve: body.approve, note: body.note, decision_payload: body.decision_payload });
      if (a)
        Object.assign(a, { status: body.approve ? "approved" : "rejected", decided_by: "user", channel: "app", decision_note: body.note, decided_at: iso(0) });
      return json(route, a ?? {});
    }
    return route.fallback();
  });
  return Object.assign(api, { decided });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

const card = (page: Page, title: string | RegExp) => page.getByRole("article", { name: title });

for (const scheme of ["light", "dark"] as const) {
  test(`inbox renders production first (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, { scheme });
    await page.goto("/#/approvals");
    const prod = page.getByRole("region", { name: "Production" });
    await expect(prod.getByRole("article", { name: "Production komutu: api-prod-1" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Diğer" }).getByRole("article")).toHaveCount(9);
    await settle(page, 900);
    await page.screenshot({ path: shot(`approvals-inbox-${scheme}`) });
    await page.getByRole("region", { name: "Diğer" }).getByRole("article").nth(4).scrollIntoViewIfNeeded();
    await settle(page, 500);
    await page.screenshot({ path: shot(`approvals-inbox-scrolled-${scheme}`) });
    expect(errors).toEqual([]);
  });

  test(`production remote command detail (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, { scheme });
    await page.goto("/#/approvals/apr_prod");
    await expect(page.getByRole("heading", { name: "Production komutu: api-prod-1" })).toBeVisible();
    await expect(page.getByText("sudo systemctl restart payments-api").first()).toBeVisible();
    // The detail page pushes the production context: the top bar badge switches.
    await expect(page.locator('[data-environment="production"]').first()).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`approvals-detail-production-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("keyboard: J/K move, A approves, R rejects with a note, Enter opens", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/approvals");
  const first = card(page, "Production komutu: api-prod-1");
  await expect(first).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("j");
  const plan = card(page, "Planı onayla: Limit çubuklarına sıfırlanma geri sayımı");
  await expect(plan).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("a");
  await expect(plan).toHaveCount(0);
  expect(api.decided[0]).toMatchObject({ id: "apr_plan", approve: true, decision_payload: null });
  // Selection moved to the next card (the question needs an answer: A shakes instead).
  const question = card(page, /dakika mı yoksa saniye/);
  await expect(question).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("j");
  const tool = card(page, /rm -rf node_modules/);
  await expect(tool).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("r");
  await tool.getByRole("textbox", { name: "Reddetme nedeni (isteğe bağlı)" }).fill("Önbelleği silmeye gerek yok");
  await settle(page, 300);
  await page.screenshot({ path: shot("approvals-inbox-rejecting") });
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(tool).toHaveCount(0);
  expect(api.decided[1]).toMatchObject({ id: "apr_tool", approve: false, note: "Önbelleği silmeye gerek yok" });
  await page.keyboard.press("k");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/approvals\/apr_q$/);
});

test("production approval needs a second press", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/approvals");
  const prod = card(page, "Production komutu: api-prod-1");
  await prod.getByRole("button", { name: "Onayla" }).click();
  await expect(prod.getByRole("button", { name: "Emin misiniz? Tekrar basın" })).toBeVisible();
  expect(api.decided).toHaveLength(0);
  await settle(page, 200);
  await page.screenshot({ path: shot("approvals-production-confirm") });
  await prod.getByRole("button", { name: "Emin misiniz? Tekrar basın" }).click();
  await expect(prod).toHaveCount(0);
  expect(api.decided[0]).toMatchObject({ id: "apr_prod", approve: true });
});

test("question: answer from an option chip or text", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/approvals/apr_q");
  const answer = page.getByRole("textbox", { name: "Yanıtınız" });
  await expect(page.getByRole("button", { name: "Yanıtla" })).toBeDisabled();
  await page.getByRole("button", { name: "Pencereye göre" }).click();
  await expect(answer).toHaveValue("Pencereye göre");
  await answer.fill("5 saatlik pencerede saniye, haftalıkta dakika");
  await settle(page, 400);
  await page.screenshot({ path: shot("approvals-detail-question") });
  await page.getByRole("button", { name: "Yanıtla" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Onaylandı" })).toBeVisible();
  expect(api.decided[0]).toMatchObject({ id: "apr_q", approve: true, decision_payload: { answer: "5 saatlik pencerede saniye, haftalıkta dakika" } });
  await expect(page.getByRole("button", { name: "Sonraki onay" })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`plan: edit markdown and approve with the edited plan (${scheme})`, async ({ page }) => {
    const api = await setup(page, { scheme });
    await page.goto("/#/approvals/apr_plan");
    await expect(page.getByRole("heading", { name: "Adımlar" })).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`approvals-detail-plan-${scheme}`) });
    if (scheme === "dark") return;
    await page.getByRole("radio", { name: "Düzenle" }).click();
    const editor = page.getByRole("textbox", { name: "Düzenle" });
    await editor.fill(`${PLAN}\n4. Erişilebilirlik için aria-live ekle.`);
    await expect(page.getByText("Düzenlendi · onaylarken düzenlenmiş plan gönderilir")).toBeVisible();
    await settle(page, 400);
    await page.screenshot({ path: shot("approvals-detail-plan-edit") });
    await page.getByRole("button", { name: "Onayla", exact: true }).click();
    await expect.poll(() => api.decided[0]?.decision_payload).toEqual({ plan: `${PLAN}\n4. Erişilebilirlik için aria-live ekle.` });
  });
}

test("memory: diff, then edited content goes back in the payload", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/approvals/apr_mem");
  await expect(page.getByText("decisions/2026-10-03-limit-esikleri.md").first()).toBeVisible();
  await settle(page, 900);
  await page.screenshot({ path: shot("approvals-detail-memory") });
  await page.getByRole("radio", { name: "İçeriği düzenle" }).click();
  await page.getByRole("textbox", { name: "İçeriği düzenle" }).fill("# Limit eşikleri\n\n- Uyarı: %75\n");
  await page.getByRole("button", { name: "Onayla", exact: true }).click();
  await expect.poll(() => api.decided[0]?.decision_payload).toEqual({ content: "# Limit eşikleri\n\n- Uyarı: %75\n" });
});

test("final, merge, budget and human step details", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/approvals/apr_final");
  await expect(page.getByText("Çapraz inceleme (Codex)")).toBeVisible();
  await settle(page, 700);
  await page.screenshot({ path: shot("approvals-detail-final") });

  await page.goto("/#/approvals/apr_merge");
  await expect(page.getByText("src/ui/LimitBar.tsx").first()).toBeVisible();
  await settle(page, 1200);
  await page.screenshot({ path: shot("approvals-detail-merge") });

  await page.goto("/#/approvals/apr_budget");
  await page.getByRole("radio", { name: "Diğer sağlayıcıya geç" }).click();
  await settle(page, 400);
  await page.screenshot({ path: shot("approvals-detail-budget") });
  await page.getByRole("button", { name: "Seçimi onayla" }).click();
  await expect.poll(() => api.decided.at(-1)?.decision_payload).toEqual({ action: "switch" });

  await page.goto("/#/approvals/apr_human");
  await expect(page.getByText("Sürüm: Bu alan gerekli.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gönder" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Sürüm" }).fill("2.4.0");
  await page.getByRole("textbox", { name: "Notlar" }).fill("Limit çubuklarında geri sayım.");
  await page.getByRole("switch", { name: "Ekibe duyur" }).click();
  await settle(page, 400);
  await page.screenshot({ path: shot("approvals-detail-human") });
  await page.getByRole("button", { name: "Gönder" }).click();
  await expect.poll(() => api.decided.at(-1)?.decision_payload).toEqual({ version: "2.4.0", notes: "Limit çubuklarında geri sayım.", announce: true });
});

test("filters, decided tab and live requests", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/#/approvals");
  await page.getByRole("button", { name: "Tür" }).click();
  await page.getByRole("menuitemradio", { name: "Hafıza önerisi" }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("button", { name: "Filtreleri temizle" }).click();
  await expect(page.getByRole("article")).toHaveCount(10);

  api.state.approvals.push(
    approval("apr_live", {
      kind: "deploy",
      title: "Deploy onayı: web-test",
      payload: { profile_name: "web-test", environment: "test", ref: "9f8e7d6c" },
      created_at: iso(0),
    }),
  );
  api.push("approval.requested", { approval_id: "apr_live", kind: "deploy", title: "Deploy onayı: web-test" });
  await expect(card(page, "Deploy onayı: web-test")).toBeVisible();

  await page.getByRole("tab", { name: "Sonuçlanan" }).click();
  await expect(page).toHaveURL(/#\/approvals\/decided$/);
  await expect(card(page, "Uzak komut onayı: db-test-1").getByText("Önce yedek alın.")).toBeVisible();
  await settle(page, 700);
  await page.screenshot({ path: shot("approvals-decided") });
});

test("compact cards adapt to a narrow column", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto("/#/approvals");
  await expect(card(page, "Production komutu: api-prod-1")).toBeVisible();
  await settle(page, 900);
  await page.screenshot({ path: shot("approvals-inbox-narrow") });
});
