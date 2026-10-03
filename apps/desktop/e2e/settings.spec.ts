/**
 * E2E: Ayarlar (appearance, agent profiles, CLI health, limits, alerts, safety, shortcuts,
 * backup, about) against the shared mocked studiod plus the handlers defined here.
 * Screenshots: test-results/screens/settings-*.png (light and dark).
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { installMockApi, NOW, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/settings-${name}.png`;
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();
/** Token-shaped values are assembled at runtime (never committed as literals). */
const fakeSecret = () => ["e2e", "secret", "z".repeat(10)].join("-");

const boundaries = (over: Record<string, unknown> = {}) => ({
  forbidden_paths: [".env"],
  readonly_paths: [],
  allowed_commands: ["pnpm test"],
  denied_commands: [],
  network: true,
  sandbox: "workspace_write",
  remote_access: "none",
  ...over,
});

function profile(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: null,
    name: id,
    provider: "claude",
    model: null,
    effort: null,
    role: "writer",
    instructions: "",
    boundaries: boundaries(),
    color: null,
    builtin: true,
    created_at: iso(-9000),
    updated_at: iso(-9000),
    ...over,
  };
}

const KINDS = [
  { kind: "macos", label: "macOS bildirimi", two_way: false, description: "Butonlu yerel bildirim (Onayla / Reddet / Aç). Ağ gerektirmez.", config_fields: [], secret_fields: [] },
  { kind: "slack", label: "Slack", two_way: true, description: "Gelen webhook ile tek yönlü ya da bot + uygulama belirteci (Socket Mode) ile butonlu, çift yönlü.", config_fields: ["mode", "channel", "allowed_user_ids"], secret_fields: ["webhook_url", "bot_token", "app_token"] },
  { kind: "telegram", label: "Telegram", two_way: true, description: "Bot ile satır içi butonlu, çift yönlü. Uzun sorgulama kullanır, dışarıdan erişim gerekmez.", config_fields: ["chat_id", "linked_user_id"], secret_fields: ["bot_token"] },
  { kind: "discord", label: "Discord", two_way: false, description: "Webhook ile zengin kart (embed).", config_fields: ["username"], secret_fields: ["webhook_url"] },
  { kind: "teams", label: "Microsoft Teams", two_way: false, description: "Teams Workflows (ya da gelen webhook) ile Adaptive Card.", config_fields: [], secret_fields: ["webhook_url"] },
  { kind: "email", label: "E-posta", two_way: false, description: "SMTP (STARTTLS ya da TLS).", config_fields: ["host", "port", "security", "username", "from_addr", "to_addrs"], secret_fields: ["password"] },
  { kind: "ntfy", label: "Telefona push (ntfy)", two_way: false, description: "ntfy konusuna push; öneme göre öncelik, dokununca uygulamada açılır.", config_fields: [], secret_fields: ["topic_url", "token"] },
  { kind: "webhook", label: "Genel webhook", two_way: false, description: "JSON POST; isteğe bağlı HMAC-SHA256 imzası.", config_fields: [], secret_fields: ["url", "signing_secret"] },
];

interface SetState {
  profiles: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  rules: Record<string, unknown>[];
  quiet: Record<string, unknown>;
  backups: Record<string, unknown>[];
  writes: { path: string; body: unknown }[];
}

function setState(): SetState {
  return {
    profiles: [
      profile("prf_claude_writer", { name: "Claude Yazar" }),
      profile("prf_claude_reviewer", { name: "Claude İnceleyen", role: "reviewer", boundaries: boundaries({ sandbox: "read_only" }) }),
      profile("prf_codex_writer", { name: "Codex Yazar", provider: "codex", model: "gpt-5.5-codex", effort: "high" }),
      profile("prf_custom", { name: "Hata ayıklayıcı", builtin: false, model: "claude-opus-5-5", effort: "xhigh", boundaries: boundaries({ network: false }) }),
    ],
    channels: [
      { id: "chan_mac", kind: "macos", name: "macOS bildirimi", enabled: true, config: {}, secrets_set: [], two_way: false, listening: false, last_error: null, created_at: iso(-9000), updated_at: iso(-9000) },
      { id: "chan_tg", kind: "telegram", name: "Telegram", enabled: true, config: { chat_id: null }, secrets_set: ["bot_token"], two_way: true, listening: true, last_error: null, created_at: iso(-8000), updated_at: iso(-60) },
      { id: "chan_mail", kind: "email", name: "E-posta", enabled: false, config: { host: "smtp.odeme.com", port: 587, security: "starttls", from_addr: "ai@odeme.com", to_addrs: ["enes@odeme.com"] }, secrets_set: ["password"], two_way: false, listening: false, last_error: "SMTP kimlik doğrulaması başarısız (535).", created_at: iso(-7000), updated_at: iso(-30) },
    ],
    rules: [
      { id: "rule_1", name: "Production olayları telefona", enabled: true, event_types: ["approval.requested", "deploy.failed"], min_severity: "high", workspace_id: null, channel_ids: ["chan_tg"], sound: true, bypass_quiet_hours: true, created_at: iso(-600), updated_at: iso(-600) },
      { id: "rule_2", name: "Hafıza önerilerini sustur", enabled: false, event_types: ["memory.proposed"], min_severity: "info", workspace_id: "ws_2", channel_ids: [], sound: false, bypass_quiet_hours: false, created_at: iso(-500), updated_at: iso(-500) },
    ],
    quiet: { enabled: true, start: "23:00", end: "08:00", timezone: null, days: [0, 1, 2, 3, 4] },
    backups: [
      { name: "aistudio-20261003T060000Z", path: "~/Library/Application Support/AI Studio/backups/aistudio-20261003T060000Z", created_at: iso(-180), reason: "scheduled", total_size: 18_432_000, workspaces: ["odeme-servisi", "mobil-uygulama"], app_version: "0.1.0" },
      { name: "aistudio-20261001T152210Z", path: "x", created_at: iso(-60 * 44), reason: "manual", total_size: 17_900_000, workspaces: ["odeme-servisi"], app_version: "0.1.0" },
    ],
    writes: [],
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installSettings(page: Page, mutate?: (s: SetState) => void): Promise<{ api: MockApi; st: SetState }> {
  const api = await installMockApi(page, (s) => {
    s.settings["limits.warning_percent"] = 80;
    s.settings["limits.refresh_minutes"] = 5;
    s.settings["limits.default_budget"] = { max_five_hour_percent: 25, max_weekly_percent: 10, max_duration_minutes: null, max_turns: 40 };
    s.settings["safety.remote_production_approvals"] = false;
    s.settings["shortcuts.global_palette"] = "Control+Alt+Space";
    s.settings["agents.stall_minutes"] = 10;
  });
  const st = setState();
  mutate?.(st);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    const body = () => (req.postData() ? (req.postDataJSON() as Record<string, unknown>) : {});
    if (method !== "GET") st.writes.push({ path: `${method} ${path}`, body: req.postData() ? req.postDataJSON() : null });

    if (path === "/agents/profiles" && method === "GET") return json(route, st.profiles);
    if (path === "/agents/profiles" && method === "POST") {
      const p = profile(`prf_${st.profiles.length + 1}`, { ...body(), builtin: false });
      st.profiles.push(p);
      return json(route, p, 201);
    }
    const prof = /^\/agents\/profiles\/([^/]+)$/.exec(path);
    if (prof) {
      const id = decodeURIComponent(prof[1] ?? "");
      if (method === "DELETE") {
        st.profiles = st.profiles.filter((p) => p.id !== id);
        return route.fulfill({ status: 204 });
      }
      const p = st.profiles.find((x) => x.id === id);
      if (p && method === "PATCH") Object.assign(p, body());
      return json(route, p);
    }
    if (path === "/agents/health") {
      const hostId = url.searchParams.get("host_id");
      return json(
        route,
        hostId
          ? [
              { provider: "claude", installed: true, binary: "/usr/local/bin/claude", version: "2.1.288", logged_in: false, compatible: true, tested_range: ">=2.1,<2.2", message: "Claude Code bu hostta oturum açmamış." },
              { provider: "codex", installed: false, binary: null, version: null, logged_in: null, compatible: null, tested_range: null, message: "`codex` bulunamadı." },
            ]
          : [
              { provider: "claude", installed: true, binary: "/opt/homebrew/bin/claude", version: "2.1.288", logged_in: true, compatible: true, tested_range: ">=2.1,<2.2", message: null },
              { provider: "codex", installed: true, binary: "/opt/homebrew/bin/codex", version: "0.161.0", logged_in: true, compatible: false, tested_range: ">=0.160,<0.161", message: "Codex 0.161.0 test edilen aralığın dışında; çoğu özellik çalışır." },
            ],
      );
    }
    if (path === "/remote/hosts") return json(route, [{ id: "staging-2", name: "staging-2", hostname: "10.0.4.22", port: 22, username: "deploy", environment: "test", permission_level: "read" }]);
    if (path === "/limits" && method === "GET") {
      return json(route, {
        windows: api.state.limits,
        availability: { claude: { ok: true, reason: null, resets_at: null }, codex: { ok: true, reason: null, resets_at: null } },
        generated_at: iso(0),
      });
    }
    if (path === "/limits/refresh") return json(route, { windows: api.state.limits, availability: {}, generated_at: iso(0) });
    if (path === "/alerts/kinds") return json(route, KINDS);
    if (path === "/alerts/channels" && method === "GET") return json(route, st.channels);
    if (path === "/alerts/channels" && method === "POST") {
      const b = body();
      const c = { id: `chan_${st.channels.length + 1}`, kind: b.kind, name: b.name || KINDS.find((k) => k.kind === b.kind)?.label, enabled: true, config: b.config, secrets_set: Object.keys((b.secrets as object) ?? {}), two_way: b.kind === "telegram", listening: false, last_error: null, created_at: iso(0), updated_at: iso(0) };
      st.channels.push(c);
      return json(route, c, 201);
    }
    const chanTest = /^\/alerts\/channels\/([^/]+)\/test$/.exec(path);
    if (chanTest) return json(route, { alert_id: "alert_t", channel_id: chanTest[1], channel_kind: "telegram", status: "sent", attempts: 1, error: null });
    const chanLink = /^\/alerts\/channels\/([^/]+)\/link$/.exec(path);
    if (chanLink) return json(route, { code: "482913", expires_at: iso(10), instructions: "Telegram'da botuna şu mesajı gönder: /baglan 482913 (10 dakika geçerli)" });
    const chan = /^\/alerts\/channels\/([^/]+)$/.exec(path);
    if (chan) {
      const c = st.channels.find((x) => x.id === decodeURIComponent(chan[1] ?? ""));
      if (method === "DELETE") {
        st.channels = st.channels.filter((x) => x !== c);
        return route.fulfill({ status: 204 });
      }
      if (c && method === "PATCH") {
        const b = body();
        if (b.enabled !== undefined && b.enabled !== null) c.enabled = b.enabled;
        if (b.name) c.name = b.name;
        if (b.config) c.config = b.config;
      }
      return json(route, c);
    }
    if (path === "/alerts/rules" && method === "GET") return json(route, st.rules);
    if (path === "/alerts/rules" && method === "POST") {
      const r = { id: `rule_${st.rules.length + 1}`, ...body(), created_at: iso(0), updated_at: iso(0) };
      st.rules.push(r);
      return json(route, r, 201);
    }
    const rule = /^\/alerts\/rules\/([^/]+)$/.exec(path);
    if (rule) {
      const r = st.rules.find((x) => x.id === decodeURIComponent(rule[1] ?? ""));
      if (r && method === "PATCH") Object.assign(r, body());
      return json(route, r);
    }
    if (path === "/alerts/defaults") {
      return json(route, {
        routing: [
          { severity: "critical", label: "Kritik", channels: "Tüm etkin kanallar + sesli macOS bildirimi", examples: ["Production komut veya deploy onayı bekliyor", "Sınır ihlali", "Ajan çöktü veya takıldı"], bypasses_quiet_hours: true },
          { severity: "high", label: "Yüksek", channels: "macOS + birincil mobil kanal", examples: ["Onay bekleyen iş", "Kapı tur sınırını aştı"], bypasses_quiet_hours: false },
          { severity: "normal", label: "Normal", channels: "macOS", examples: ["Görev tamamlandı", "Limit %80"], bypasses_quiet_hours: false },
          { severity: "info", label: "Bilgi", channels: "Yalnız uygulama içi", examples: ["Hafıza önerisi", "Limit sıfırlandı"], bypasses_quiet_hours: false },
        ],
        settings: { enabled: true, dedup_seconds: 300, group_window_seconds: 60, rate_limit_per_minute: 20, primary_channel_id: null, confirm_timeout_seconds: 120 },
        quiet_hours: st.quiet,
        primary_channel_id: "chan_tg",
      });
    }
    if (path === "/alerts/quiet-hours") {
      if (method === "PUT") st.quiet = body();
      return json(route, st.quiet);
    }
    if (path === "/alerts/log") {
      return json(route, [
        { id: 3, alert_id: "a3", channel_id: "chan_tg", channel_kind: "telegram", event_id: 91, event_type: "approval.requested", severity: "critical", title: "Production komut onayı bekliyor", status: "sent", attempts: 1, error: null, approval_id: "apr_2", test: false, created_at: iso(-1) },
        { id: 2, alert_id: "a2", channel_id: "chan_mail", channel_kind: "email", event_id: 88, event_type: "task.completed", severity: "normal", title: "Görev tamamlandı: limit çubukları", status: "failed", attempts: 3, error: "SMTP kimlik doğrulaması başarısız (535).", approval_id: null, test: false, created_at: iso(-14) },
        { id: 1, alert_id: "a1", channel_id: "chan_tg", channel_kind: "telegram", event_id: null, event_type: "alert.test", severity: "normal", title: "AI Studio test bildirimi", status: "sent", attempts: 1, error: null, approval_id: null, test: true, created_at: iso(-40) },
      ]);
    }
    if (path === "/backup" && method === "GET") return json(route, st.backups);
    if (path === "/backup" && method === "POST") {
      const b = { name: "aistudio-20261003T080000Z", path: "x", created_at: iso(0), reason: "manual", total_size: 18_500_000, workspaces: ["odeme-servisi", "mobil-uygulama"], app_version: "0.1.0" };
      st.backups.unshift(b);
      return json(route, b, 201);
    }
    if (path === "/backup/settings") {
      return json(route, { interval_hours: 24, dir: null, keep: 14, resolved_dir: "~/Library/Application Support/AI Studio/backups", last_backup_at: iso(-180), next_backup_at: iso(60 * 21), ...(method === "PUT" ? body() : {}) });
    }
    const restore = /^\/backup\/([^/]+)\/restore$/.exec(path);
    if (restore) return json(route, { name: restore[1], restored_workspaces: ["odeme-servisi"], safety_backup: "aistudio-20261003T080500Z", restart_required: true });
    if (path === "/system") return json(route, { version: "0.1.0", modules: ["workspaces", "approvals", "agents", "limits", "gitops", "memory", "engine", "remote", "deploy", "git_hosting", "alerts", "backup"], dev: true, last_event_id: 4211 });
    return route.fallback();
  });
  return { api, st };
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function open(page: Page, hash: string) {
  await page.goto(`/#${hash}`);
  await expect(page.getByRole("navigation", { name: "Gezinme" })).toBeVisible();
}

const SECTIONS = [
  ["appearance", "Görünüm"],
  ["profiles", "Ajan profilleri"],
  ["clis", "CLI durumu"],
  ["limits", "Limitler ve bütçe"],
  ["alerts", "Uyarılar"],
  ["safety", "Güvenlik"],
  ["shortcuts", "Kısayollar"],
  ["backup", "Yedekleme"],
  ["about", "Hakkında"],
] as const;

for (const scheme of ["light", "dark"] as const) {
  test(`every section renders (${scheme})`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installSettings(page);
    await open(page, "/settings");
    const nav = page.getByRole("navigation", { name: "Ayarlar" });
    for (const [id, title] of SECTIONS) {
      await nav.getByRole("link", { name: title }).click();
      await expect(page).toHaveURL(new RegExp(`#/settings/${id}$`));
      await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
      await settle(page, 900);
      await page.screenshot({ path: shot(`${id}-${scheme}`), fullPage: false });
    }
    expect(errors).toEqual([]);
  });
}

test("appearance: theme tiles apply instantly and persist", async ({ page }) => {
  const { api } = await installSettings(page);
  await open(page, "/settings/appearance");
  await page.getByRole("radio", { name: /Koyu/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => api.state.settings["appearance.theme"]).toBe("dark");
  await page.getByRole("radiogroup", { name: "Hareketi azalt" }).getByRole("radio", { name: "Açık" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "on");
  await expect.poll(() => api.state.settings["appearance.reduce_motion"]).toBe("on");
});

test("profiles: built-ins cannot be deleted, custom ones can; create sends boundaries", async ({ page }) => {
  const { st } = await installSettings(page);
  await open(page, "/settings/profiles");
  const claude = page.getByRole("region", { name: "Claude" });
  await claude.getByRole("listitem").filter({ hasText: "Claude Yazar" }).getByRole("button", { name: "Diğer işlemler" }).click();
  await expect(page.getByRole("menuitem", { name: /Hazır profiller silinemez/ })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Yeni profil" }).click();
  const sheet = page.getByRole("dialog", { name: "Yeni ajan profili" });
  await expect(sheet).toBeVisible();
  await settle(page, 600);
  await page.screenshot({ path: shot("profile-form") });
  await sheet.getByRole("button", { name: "Oluştur" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Bir ad girin.");
  await sheet.getByLabel(/^Ad\*?$/).fill("Codex test eden");
  await sheet.getByRole("radio", { name: "Codex" }).click();
  await sheet.getByRole("radio", { name: "Salt okuma" }).first().click();
  await sheet.getByLabel("Dokunulmayacak yollar").fill(".env\nsecrets/**");
  await sheet.getByRole("button", { name: "Oluştur" }).click();
  await expect(sheet).toBeHidden();
  const created = st.writes.find((w) => w.path === "POST /agents/profiles")?.body as Record<string, unknown>;
  expect(created).toMatchObject({ name: "Codex test eden", provider: "codex", boundaries: { sandbox: "read_only", forbidden_paths: [".env", "secrets/**"] } });
  await expect(page.getByRole("region", { name: "Codex" }).getByText("Codex test eden")).toBeVisible();
});

test("alerts: add a Telegram channel, link it live, test send and quiet hours", async ({ page }) => {
  const { api, st } = await installSettings(page);
  await open(page, "/settings/alerts");
  await page.getByRole("button", { name: "Kanal ekle" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Kanal ekle" });
  await expect(sheet.getByRole("button", { name: /macOS bildirimi/ })).toBeDisabled();
  await settle(page, 600);
  await page.screenshot({ path: shot("channel-kinds") });
  await sheet.getByRole("button", { name: /^Telegram/ }).click();
  const form = page.getByRole("dialog", { name: "Telegram kanalı" });
  await form.getByRole("button", { name: "Kaydet" }).click();
  await expect(form.getByText("Telegram için bot belirteci gerekli (BotFather'dan alınır).")).toBeVisible();
  await form.getByLabel("Bot belirteci").fill(fakeSecret());
  await settle(page, 400);
  await page.screenshot({ path: shot("channel-form") });
  await form.getByRole("button", { name: "Kaydet" }).click();
  await expect(form).toBeHidden();
  const created = st.writes.find((w) => w.path === "POST /alerts/channels")?.body as Record<string, unknown>;
  expect(created).toMatchObject({ kind: "telegram", secrets: { bot_token: fakeSecret() } });

  // Link the existing Telegram channel: the code appears, then the live event completes it.
  const row = page.getByRole("list", { name: "Kanallar" }).getByRole("listitem").filter({ hasText: "Telegram" }).first();
  await row.getByRole("button", { name: "Hesabı bağla" }).click();
  const link = page.getByRole("dialog", { name: "Hesabınızı bağlayın" });
  await expect(link.getByTestId("link-code")).toHaveAccessibleName("482913");
  await settle(page, 600);
  await page.screenshot({ path: shot("link-code") });
  api.push("alert.channel_linked", { channel_id: "chan_tg", channel_kind: "telegram" });
  await expect(link.getByText("Hesap bağlandı")).toBeVisible();
  await link.getByRole("button", { name: "Tamam" }).click();

  await row.getByRole("button", { name: "Test gönder" }).click();
  await expect(page.getByText("Test bildirimi gönderildi")).toBeVisible();

  // Quiet hours: change the window, the summary updates live, save sends the body.
  await page.getByLabel("Başlangıç").fill("22:30");
  await expect(page.getByTestId("quiet-summary")).toHaveText("Hafta içi 22:30 – 08:00 (9 sa 30 dk)");
  await page.getByRole("group", { name: "Günler" }).getByRole("button", { name: "Cmt" }).click();
  await page.getByRole("region", { name: "Sessiz saatler" }).getByRole("button", { name: "Kaydet" }).click();
  await expect.poll(() => st.quiet).toMatchObject({ start: "22:30", days: [0, 1, 2, 3, 4, 5] });
});

test("alerts: rule editor builds event types, severity and channels", async ({ page }) => {
  const { st } = await installSettings(page);
  await open(page, "/settings/alerts");
  await page.getByRole("button", { name: "Kural ekle" }).click();
  const sheet = page.getByRole("dialog", { name: "Yeni uyarı kuralı" });
  await sheet.getByLabel(/^Ad\*?$/).fill("CI kırılınca telefona");
  await sheet.getByRole("button", { name: "CI kırıldı" }).click();
  await sheet.getByLabel("Özel olay türü").fill("deploy.*");
  await sheet.getByLabel("Özel olay türü").press("Enter");
  await sheet.getByRole("radio", { name: "Kritik" }).click();
  await sheet.getByRole("checkbox", { name: "Telegram" }).click();
  await settle(page, 500);
  await page.screenshot({ path: shot("rule-form") });
  await sheet.getByRole("button", { name: "Oluştur" }).click();
  await expect(sheet).toBeHidden();
  const created = st.writes.find((w) => w.path === "POST /alerts/rules")?.body as Record<string, unknown>;
  expect(created).toMatchObject({ name: "CI kırılınca telefona", event_types: ["pr.ci_failed", "deploy.*"], min_severity: "critical", channel_ids: ["chan_tg"] });
});

test("safety: enabling channel approvals requires a strong confirmation", async ({ page }) => {
  const { api } = await installSettings(page);
  await open(page, "/settings/safety");
  await page.getByRole("switch", { name: "Kanallardan production onayına izin ver" }).click();
  const dialog = page.getByRole("dialog", { name: "Production onaylarını kanallara aç" });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Kanallara aç" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Onay metni").fill("production");
  await expect(confirm).toBeDisabled();
  for (const box of await dialog.getByRole("checkbox").all()) await box.click();
  await settle(page, 400);
  await page.screenshot({ path: shot("safety-confirm") });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect.poll(() => api.state.settings["safety.remote_production_approvals"]).toBe(true);
  await expect(page.getByText("Kanallara açık")).toBeVisible();
  // Turning it off needs no ceremony.
  await page.getByRole("switch", { name: "Kanallardan production onayına izin ver" }).click();
  await expect.poll(() => api.state.settings["safety.remote_production_approvals"]).toBe(false);
});

test("shortcuts: the recorder captures a combo and rejects modifier-less keys", async ({ page }) => {
  const { api } = await installSettings(page);
  await open(page, "/settings/shortcuts");
  await page.getByRole("button", { name: "Değiştir", exact: true }).click();
  const recorder = page.getByTestId("shortcut-recorder");
  await expect(recorder).toBeFocused();
  await page.keyboard.press("k");
  await expect(page.getByRole("alert").filter({ hasText: "En az bir değiştirici tuş gerekli" })).toBeVisible();
  await settle(page, 300);
  await page.screenshot({ path: shot("shortcut-recording") });
  await page.keyboard.press("Control+Shift+KeyP");
  await expect.poll(() => api.state.settings["shortcuts.global_palette"]).toBe("Control+Shift+P");
  await expect(page.getByText("Genel kısayol: ⌃⇧P")).toBeVisible();
});

test("backup: create and restore with confirmation", async ({ page }) => {
  const { st } = await installSettings(page);
  await open(page, "/settings/backup");
  await page.getByRole("button", { name: "Şimdi yedekle" }).click();
  await expect(page.getByText("Yedek alındı")).toBeVisible();
  await page.getByRole("list", { name: "Yedekler" }).getByRole("button", { name: "Geri yükle" }).nth(1).click();
  const dialog = page.getByRole("dialog", { name: /geri yüklensin mi\?/ });
  await expect(dialog.getByRole("checkbox", { name: /Önce şu anki durumun yedeğini al/ })).toBeChecked();
  await dialog.getByLabel("Onay metni").fill("geri yükle");
  await settle(page, 400);
  await page.screenshot({ path: shot("restore-confirm") });
  await dialog.getByRole("button", { name: "Geri yükle" }).click();
  await expect(page.getByText("Değişikliklerin geçerli olması için motoru yeniden başlatın.").first()).toBeVisible();
  expect(st.writes.find((w) => w.path.endsWith("/restore"))?.body).toEqual({ safety_backup: true });
});
