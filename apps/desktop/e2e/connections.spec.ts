/**
 * E2E: Bağlantılar (hosts, databases + query console, deploy, git accounts, audit, remote
 * terminal) against the shared mocked studiod plus remote/deploy/git handlers defined here.
 * Screenshots go to test-results/screens/connections-*.png (light and dark).
 */
import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";

import { installMockApi, NOW, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/connections-${name}.png`;
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();
/** Token-shaped values are assembled at runtime (never committed as literals). */
const fakeToken = () => ["tok", "e2e", "x".repeat(12)].join("-");
const FINGERPRINT = ["SHA256", "q3Jf8kVd2mZpL0aN7cT5xR1yU9wE4bH6sG2oK8iM0vA"].join(":");

function host(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: "ws_1",
    name: id,
    hostname: "10.0.0.12",
    port: 22,
    username: "deploy",
    jump_host_id: null,
    auth: "key",
    key_path: "~/.ssh/id_ed25519",
    environment: "test",
    permission_level: "read",
    created_at: iso(-9000),
    limited_write_patterns: [],
    has_password: false,
    has_passphrase: false,
    updated_at: null,
    ...over,
  };
}

function db(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: "ws_1",
    name: id,
    kind: "postgres",
    host: "db.internal",
    port: 5432,
    database: "orders",
    username: "readonly",
    via_host_id: null,
    options: {},
    environment: "test",
    permission_level: "read",
    created_at: iso(-8000),
    limited_write_patterns: [],
    has_password: true,
    updated_at: null,
    ...over,
  };
}

function run(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    profile_id: "dep_web",
    workspace_id: "ws_1",
    profile_name: "web — production",
    kind: "ssh",
    environment: "production",
    status: "succeeded",
    ref: "v1.4.1",
    summary: null,
    actor: "user",
    task_id: null,
    run_id: null,
    approval_id: null,
    approved_by: "user",
    health_ok: true,
    external_id: null,
    rollback_of: null,
    rollback_available: false,
    error: null,
    log: "",
    started_at: iso(-60 * 26),
    finished_at: iso(-60 * 26 + 3),
    ...over,
  };
}

function audit(id: number, over: Record<string, unknown> = {}) {
  return {
    event_id: id,
    ts: iso(-id * 7),
    type: "remote.command",
    severity: "info",
    actor: "user",
    workspace_id: "ws_1",
    task_id: null,
    session_id: null,
    target_kind: "host",
    target_id: "web-prod-1",
    target_name: "web-prod-1",
    environment: "production",
    command: "journalctl -u web --since '10 min ago'",
    klass: "read",
    reasons: ["journalctl salt okuma komutları listesinde"],
    decision: "executed",
    denied: false,
    denial_reason: null,
    approval_id: null,
    approved_by: null,
    exit_code: 0,
    row_count: null,
    duration_ms: 412,
    output_preview: "Oct 03 10:52:01 web-prod-1 web[812]: GET /healthz 200 2ms",
    source: "terminal",
    reason: null,
    error: null,
    hash: "9f2c1b7e4d3a5f60b8c9d0e1f2a3b4c5",
    prev_hash: "",
    ...over,
  };
}

interface ConnState {
  hosts: Record<string, unknown>[];
  dbs: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  posts: { path: string; body: unknown }[];
  /** Hosts whose next test reports an unknown host key (until trusted). */
  untrusted: Set<string>;
  queryDelayMs: number;
}

function connState(): ConnState {
  return {
    hosts: [
      host("web-prod-1", { hostname: "web1.odeme.com", environment: "production", permission_level: "read", jump_host_id: "bastion" }),
      host("bastion", { hostname: "bastion.odeme.com", environment: "production", permission_level: "limited", limited_write_patterns: ["systemctl restart web"] }),
      host("staging-2", { hostname: "10.0.4.22", port: 2222, environment: "test", permission_level: "full", auth: "password", has_password: true, key_path: null }),
      host("mac-mini", { hostname: "mac-mini.local", username: "enes", environment: "local", permission_level: "full", auth: "agent", key_path: null }),
    ],
    dbs: [
      db("orders-prod", { environment: "production", via_host_id: "bastion", host: "orders.cluster.internal" }),
      db("analytics", { kind: "mysql", port: 3306, database: "events", username: "analyst", environment: "test", permission_level: "limited" }),
      db("dev.sqlite", { kind: "sqlite", host: null, port: null, username: null, database: "~/Projeler/odeme/dev.sqlite3", environment: "local", permission_level: "full", has_password: false }),
    ],
    profiles: [
      {
        id: "dep_web",
        workspace_id: "ws_1",
        name: "web — production",
        kind: "ssh",
        environment: "production",
        config: { host_ids: ["web-prod-1", "bastion"], script: "cd /srv/web && git pull && systemctl restart web", strategy: "rolling", batch_size: 1, cwd: "/srv/web" },
        health_check: { url: "https://odeme.com/healthz", expect_status: [200] },
        rollback: { host_ids: ["web-prod-1", "bastion"], script: "cd /srv/web && git checkout HEAD~1 && systemctl restart web" },
        created_at: iso(-7000),
      },
      {
        id: "dep_api",
        workspace_id: "ws_1",
        name: "api — staging",
        kind: "ci",
        environment: "test",
        config: { repo_id: "repo_api", workflow: "deploy.yml", variables: { ENVIRONMENT: "staging" } },
        health_check: null,
        rollback: null,
        created_at: iso(-6000),
      },
      {
        id: "dep_docs",
        workspace_id: "ws_1",
        name: "Dokümantasyon",
        kind: "command",
        environment: "local",
        config: { command: "pnpm docs:build && rsync -a dist/ ~/Sites/docs", cwd: "~/Projeler/odeme" },
        health_check: null,
        rollback: null,
        created_at: iso(-5000),
      },
    ],
    runs: [
      run("dr_3", { status: "failed", ref: "v1.4.2", health_ok: false, error: "Sağlık kontrolü başarısız.", rollback_available: true, started_at: iso(-42), finished_at: iso(-40) }),
      run("dr_2"),
      run("dr_1", { profile_id: "dep_api", profile_name: "api — staging", kind: "ci", environment: "test", ref: "main", started_at: iso(-60 * 5) }),
    ],
    accounts: [
      { id: "gitacc_1", kind: "github", name: "enes@github.com", api_url: "https://api.github.com", web_url: "https://github.com", username: "enes", scopes: ["repo", "workflow", "read:org"], created_at: iso(-9000), updated_at: iso(-60) },
      { id: "gitacc_2", kind: "gitlab", name: "Şirket GitLab", api_url: "https://gitlab.sirket.com/api/v4", web_url: "https://gitlab.sirket.com", username: "enes.a", scopes: ["api", "read_repository", "write_repository"], created_at: iso(-4000), updated_at: iso(-600) },
    ],
    audit: [
      audit(1),
      audit(2, { command: "UPDATE orders SET status = 'refunded' WHERE id = 4211", target_kind: "db", target_id: "orders-prod", target_name: "orders-prod", type: "db.query", klass: "write", reasons: ["UPDATE yazma sayılır"], decision: "executed", approved_by: "user", approval_id: "apr_77", exit_code: null, row_count: 1, source: "api" }),
      audit(3, { command: "rm -rf /var/cache/web/*", klass: "write", reasons: ["rm yazma komutu"], decision: "denied", denied: true, denial_reason: "Ajanın uzak erişimi salt okuma; yazma komutları reddedilir.", actor: "agent:ses_2", exit_code: null, output_preview: null }),
      audit(4, { command: "docker ps", target_id: "staging-2", target_name: "staging-2", environment: "test", source: "api" }),
    ],
    posts: [],
    untrusted: new Set(["staging-2"]),
    queryDelayMs: 0,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installConnections(page: Page, mutate?: (s: ConnState) => void): Promise<{ api: MockApi; conn: ConnState }> {
  const api = await installMockApi(page);
  const conn = connState();
  mutate?.(conn);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, "");
    const method = req.method();
    const body = () => (req.postData() ? (req.postDataJSON() as Record<string, unknown>) : {});
    if (method !== "GET") conn.posts.push({ path: `${method} ${path}`, body: req.postData() ? req.postDataJSON() : null });

    if (path === "/remote/hosts" && method === "GET") return json(route, conn.hosts);
    if (path === "/remote/hosts" && method === "POST") {
      const b = body();
      const created = host(String(b.name), { ...b, has_password: Boolean(b.password), password: undefined, passphrase: undefined });
      conn.hosts.push(created);
      return json(route, created, 201);
    }
    if (path === "/remote/ssh-config") {
      return json(route, [
        { alias: "web-prod-1", hostname: "web1.odeme.com", user: "deploy", port: 22, identity_file: "~/.ssh/id_ed25519", proxy_jump: "bastion", exists: true },
        { alias: "worker-3", hostname: "10.0.6.13", user: "ubuntu", port: 22, identity_file: "~/.ssh/work", proxy_jump: "bastion", exists: false },
        { alias: "nas", hostname: "nas.local", user: "admin", port: 2200, identity_file: null, proxy_jump: null, exists: false },
      ]);
    }
    if (path === "/remote/hosts/import-ssh-config") {
      const b = body();
      const aliases = (b.aliases as string[]) ?? [];
      const created = aliases.map((a) => host(a, { environment: b.environment, permission_level: b.permission_level }));
      conn.hosts.push(...created);
      return json(route, { created, skipped: [] });
    }
    const hostTest = /^\/remote\/hosts\/([^/]+)\/test$/.exec(path);
    if (hostTest) {
      const id = decodeURIComponent(hostTest[1] ?? "");
      const h = conn.hosts.find((x) => x.id === id);
      if (conn.untrusted.has(id)) {
        return json(route, {
          ok: false,
          message: `Bilinmeyen host anahtarı: ${String(h?.hostname)}:${String(h?.port)}`,
          latency_ms: null,
          server_version: null,
          uname: null,
          error_code: "host_key_unknown",
          details: { host_id: id, hostname: h?.hostname, port: h?.port, fingerprint: FINGERPRINT, key_type: "ssh-ed25519" },
        });
      }
      return json(route, { ok: true, message: "Bağlantı başarılı.", latency_ms: 38, server_version: "SSH-2.0-OpenSSH_9.6", uname: "Linux web1 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux", error_code: null, details: {} });
    }
    const trust = /^\/remote\/hosts\/([^/]+)\/trust$/.exec(path);
    if (trust) {
      const id = decodeURIComponent(trust[1] ?? "");
      conn.untrusted.delete(id);
      return json(route, { host_id: id, hostname: "10.0.4.22", port: 2222, fingerprint: FINGERPRINT, key_type: "ssh-ed25519", known_hosts_path: "~/Library/Application Support/AI Studio/known_hosts", already_trusted: false });
    }
    const agents = /^\/remote\/hosts\/([^/]+)\/agents$/.exec(path);
    if (agents) {
      return json(route, [
        { provider: "claude", installed: true, path: "/usr/local/bin/claude", version: "2.1.288 (Claude Code)", message: null },
        { provider: "codex", installed: false, path: null, version: null, message: "`codex` bu hostta bulunamadı." },
      ]);
    }
    const hostOne = /^\/remote\/hosts\/([^/]+)$/.exec(path);
    if (hostOne) {
      const h = conn.hosts.find((x) => x.id === decodeURIComponent(hostOne[1] ?? ""));
      if (method === "DELETE") {
        conn.hosts = conn.hosts.filter((x) => x !== h);
        return route.fulfill({ status: 204 });
      }
      return h ? json(route, h) : json(route, { error: { code: "not_found", message: "Host bulunamadı." } }, 404);
    }
    if (path === "/remote/db-profiles" && method === "GET") return json(route, conn.dbs);
    const dbQuery = /^\/remote\/db-profiles\/([^/]+)\/query$/.exec(path);
    if (dbQuery) {
      const q = String(body().query ?? "");
      if (conn.queryDelayMs) await new Promise((r) => setTimeout(r, conn.queryDelayMs));
      const write = !/^\s*select/i.test(q);
      return json(route, {
        profile_id: decodeURIComponent(dbQuery[1] ?? ""),
        query: q,
        classification: { klass: write ? "write" : "read", reasons: [] },
        approved_by: write ? "user" : null,
        columns: write ? [] : ["id", "status", "total", "customer", "paid_at"],
        rows: write
          ? []
          : [
              [4211, "paid", 1249.9, "Ayşe Yılmaz", "2026-10-03 10:12"],
              [4210, "refunded", 89.5, "Mehmet Öz", "2026-10-03 09:58"],
              [4209, "paid", 412, "Zeynep Kaya", null],
              [4208, "pending", 15.75, "Can Demir", "2026-10-03 09:31"],
            ],
        row_count: write ? 1 : 4,
        truncated: false,
        duration_ms: 18,
        denied: false,
        denial_reason: null,
        error: null,
      });
    }
    const dbOne = /^\/remote\/db-profiles\/([^/]+)$/.exec(path);
    if (dbOne) {
      const d = conn.dbs.find((x) => x.id === decodeURIComponent(dbOne[1] ?? ""));
      return d ? json(route, d) : json(route, { error: { code: "not_found", message: "Profil bulunamadı." } }, 404);
    }
    if (path === "/remote/classify") {
      const text = String(body().text ?? "");
      const statements = text.split(";").map((t) => t.trim()).filter(Boolean);
      const seg = (t: string) =>
        /^select|^explain|^show/i.test(t)
          ? { text: t, klass: "read", reasons: ["SELECT okuma sayılır"] }
          : { text: t, klass: "write", reasons: [`${t.split(/\s+/)[0]?.toUpperCase() ?? ""} yazma sayılır`] };
      const segments = statements.map(seg);
      const klass = segments.some((x) => x.klass === "write") ? "write" : "read";
      return json(route, { klass, reasons: segments.flatMap((x) => x.reasons), parsed: true, segments });
    }
    if (path === "/remote/audit") return json(route, { entries: conn.audit, has_more: false, next_before_id: null });
    if (path === "/deploy/profiles" && method === "GET") return json(route, conn.profiles);
    const depOne = /^\/deploy\/profiles\/([^/]+)$/.exec(path);
    if (depOne && method === "GET") {
      const p = conn.profiles.find((x) => x.id === decodeURIComponent(depOne[1] ?? ""));
      return p ? json(route, p) : json(route, { error: { code: "not_found", message: "Profil bulunamadı." } }, 404);
    }
    const depRun = /^\/deploy\/profiles\/([^/]+)\/run$/.exec(path);
    if (depRun) {
      const p = conn.profiles.find((x) => x.id === decodeURIComponent(depRun[1] ?? ""));
      const b = body();
      const r = run("dr_9", {
        profile_id: p?.id,
        profile_name: p?.name,
        environment: p?.environment,
        status: p?.environment === "production" ? "pending_approval" : "running",
        ref: b.ref,
        summary: b.summary,
        approval_id: "apr_deploy",
        approved_by: null,
        health_ok: null,
        log: "",
        started_at: iso(0),
        finished_at: null,
      });
      conn.runs.unshift(r);
      return json(route, r, 202);
    }
    if (path === "/deploy/runs") {
      const pid = new URL(req.url()).searchParams.get("profile_id");
      return json(route, conn.runs.filter((r) => !pid || r.profile_id === pid).map((r) => ({ ...r, log: "" })));
    }
    const runOne = /^\/deploy\/runs\/([^/]+)$/.exec(path);
    if (runOne) {
      const r = conn.runs.find((x) => x.id === decodeURIComponent(runOne[1] ?? ""));
      const log = [
        "[07:58:01] Strateji: kademeli (1 host/grup)",
        "[07:58:02] web-prod-1: cd /srv/web && git pull && systemctl restart web",
        "[07:58:05] web-prod-1: Already up to date.",
        "[07:58:09] Sağlık kontrolü: https://odeme.com/healthz",
        "[07:58:19] HATA: Sağlık kontrolü başarısız (503).",
      ].join("\n");
      return r ? json(route, { ...r, log: r.status === "failed" ? log : r.log }) : json(route, { error: { code: "not_found", message: "Deploy bulunamadı." } }, 404);
    }
    if (path === "/workspaces/ws_1/repos") return json(route, [{ id: "repo_api", workspace_id: "ws_1", name: "odeme-api", path: "~/Projeler/odeme-api", remote_url: "git@github.com:odeme/api.git", provider: "github", default_branch: "main" }]);
    if (path === "/git/accounts" && method === "GET") return json(route, conn.accounts);
    if (path === "/git/accounts" && method === "POST") {
      const b = body();
      const acc = { id: "gitacc_3", kind: b.kind, name: b.name || "enes@gitlab.com", api_url: "https://gitlab.com/api/v4", web_url: "https://gitlab.com", username: "enes", scopes: ["api"], created_at: iso(0), updated_at: iso(0) };
      conn.accounts.push(acc);
      return json(route, acc, 201);
    }
    const verify = /^\/git\/accounts\/([^/]+)\/verify$/.exec(path);
    if (verify) return json(route, conn.accounts.find((a) => a.id === decodeURIComponent(verify[1] ?? "")));
    const repos = /^\/git\/accounts\/([^/]+)\/repos$/.exec(path);
    if (repos) {
      return json(route, [
        { full_name: "odeme/api", name: "api", web_url: "https://github.com/odeme/api", clone_url: null, ssh_url: null, default_branch: "main", private: true, description: "Ödeme servisi API", updated_at: iso(-90) },
        { full_name: "odeme/web", name: "web", web_url: "https://github.com/odeme/web", clone_url: null, ssh_url: null, default_branch: "main", private: true, description: "Müşteri paneli", updated_at: iso(-60 * 30) },
        { full_name: "enes/dotfiles", name: "dotfiles", web_url: "https://github.com/enes/dotfiles", clone_url: null, ssh_url: null, default_branch: "master", private: false, description: null, updated_at: iso(-60 * 24 * 9) },
      ]);
    }
    return route.fallback();
  });
  return { api, conn };
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

for (const scheme of ["light", "dark"] as const) {
  test(`tabs render with production grouped first (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installConnections(page);
    await open(page, "/connections");
    await expect(page.getByRole("link", { name: "web-prod-1" })).toBeVisible();
    const groups = page.getByRole("region", { name: /^Hostlar: / });
    await expect(groups.first()).toHaveAccessibleName("Hostlar: Production");
    await settle(page, 900);
    await page.screenshot({ path: shot(`hosts-${scheme}`) });

    for (const [tab, name] of [
      ["Veritabanları", "databases"],
      ["Deploy", "deploy"],
      ["Git hesapları", "git"],
      ["Denetim kaydı", "audit"],
    ] as const) {
      await page.getByRole("tab", { name: new RegExp(tab) }).click();
      await expect(page).toHaveURL(new RegExp(`#/connections/${name}$`));
      await settle(page, 900);
      await page.screenshot({ path: shot(`${name}-${scheme}`) });
    }
    expect(errors).toEqual([]);
  });
}

test("host form: validation, write-only secrets and the new row", async ({ page }) => {
  const { conn } = await installConnections(page);
  await open(page, "/connections/hosts");
  await page.getByRole("button", { name: "Yeni host" }).click();
  const sheet = page.getByRole("dialog", { name: "Yeni host" });
  await sheet.getByRole("button", { name: "Ekle" }).click();
  await expect(sheet.getByText("Bir ad girin.")).toBeVisible();
  await expect(sheet.getByText("Bir adres girin.")).toBeVisible();
  await settle(page, 400);
  await page.screenshot({ path: shot("host-form-errors") });
  await sheet.getByLabel(/^Ad\*?$/).fill("worker-4");
  await sheet.getByLabel(/^Adres/).fill("10.0.6.14");
  await sheet.getByLabel(/^Kullanıcı/).fill("ubuntu");
  await sheet.getByRole("radio", { name: "Parola" }).click();
  const secret = fakeToken();
  await sheet.getByLabel(/^Parola/).fill(secret);
  await sheet.getByRole("radio", { name: "Production" }).click();
  await expect(sheet.getByText(/Production'da her yazma komutu tek tek onaylanır/)).toBeVisible();
  await settle(page, 400);
  await page.screenshot({ path: shot("host-form-production") });
  await sheet.getByRole("button", { name: "Ekle" }).click();
  await expect(sheet).toBeHidden();
  const post = conn.posts.find((p) => p.path === "POST /remote/hosts")?.body as Record<string, unknown>;
  expect(post).toMatchObject({ name: "worker-4", hostname: "10.0.6.14", username: "ubuntu", auth: "password", password: secret, environment: "production", permission_level: "read" });
  await expect(page.getByRole("region", { name: "Hostlar: Production" }).getByRole("link", { name: "worker-4" })).toBeVisible();
});

test("unknown host key: fingerprint dialog, explicit trust, automatic re-test", async ({ page }) => {
  const { conn } = await installConnections(page);
  await open(page, "/connections/hosts");
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "staging-2" }) });
  await row.getByRole("button", { name: "Test" }).click();
  const dialog = page.getByRole("dialog", { name: "Bilinmeyen host anahtarı" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("host-fingerprint")).toHaveAttribute("data-fingerprint", FINGERPRINT);
  const trust = dialog.getByRole("button", { name: "Güven ve bağlan" });
  await expect(trust).toBeDisabled();
  await settle(page, 600);
  await page.screenshot({ path: shot("trust-dialog") });
  await dialog.getByRole("checkbox").click();
  await trust.click();
  await expect(dialog).toBeHidden();
  expect(conn.posts.find((p) => p.path.endsWith("/trust"))?.body).toEqual({ fingerprint: FINGERPRINT, replace: false });
  await expect(page.getByText("staging-2: Bağlantı başarılı")).toBeVisible();
});

test("ssh config import selects importable entries", async ({ page }) => {
  const { conn } = await installConnections(page);
  await open(page, "/connections/hosts");
  await page.getByRole("button", { name: "~/.ssh/config'ten içe aktar" }).click();
  const dialog = page.getByRole("dialog", { name: "~/.ssh/config'ten içe aktar" });
  await expect(dialog.getByText("Zaten ekli")).toBeVisible();
  await settle(page, 600);
  await page.screenshot({ path: shot("import-dialog") });
  await dialog.getByRole("button", { name: "2 hostu içe aktar" }).click();
  await expect(dialog).toBeHidden();
  expect(conn.posts.find((p) => p.path.endsWith("/import-ssh-config"))?.body).toMatchObject({ aliases: ["worker-3", "nas"], environment: "test", permission_level: "read" });
});

for (const scheme of ["light", "dark"] as const) {
  test(`production host detail: red frame, CLIs and recent commands (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await installConnections(page);
    await open(page, "/connections/hosts/web-prod-1");
    await expect(page.getByRole("heading", { level: 1, name: /web-prod-1/ })).toBeVisible();
    await expect(page.getByTestId("production-frame")).toBeVisible();
    await expect(page.getByRole("banner").locator('[data-environment="production"]')).toBeVisible();
    await page.getByRole("button", { name: "CLI'ları bul" }).click();
    await expect(page.getByText("2.1.288 (Claude Code)")).toBeVisible();
    await page.getByRole("button", { name: "Bağlantıyı test et" }).click();
    await expect(page.getByText("Linux web1 6.8.0-45-generic", { exact: false })).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`host-detail-${scheme}`) });
    await page.getByRole("link", { name: "Hostlar" }).click();
    await expect(page.getByTestId("production-frame")).toHaveCount(0);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`query console: live classification, approval wait and results (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const { conn } = await installConnections(page);
    await open(page, "/connections/databases/orders-prod");
    const editor = page.getByRole("textbox", { name: "Sorgu konsolu" });
    await editor.fill("SELECT id, status, total FROM orders LIMIT 4;");
    const cls = page.getByTestId("classification");
    await expect(cls).toContainText("Okuma");
    await expect(cls).toContainText("salt okuma işlemi açılır");
    await page.getByRole("button", { name: "Çalıştır", exact: true }).click();
    await expect(page.getByRole("table", { name: "Sonuç" })).toBeVisible();
    await expect(page.getByText("4 satır")).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`console-read-${scheme}`) });

    await editor.fill("UPDATE orders SET status = 'refunded' WHERE id = 4211; SELECT 1");
    await expect(cls).toContainText("Yazma");
    await expect(cls).toContainText("Production yazması");
    await expect(page.getByText("2 ifade ayrı ayrı değerlendirildi")).toBeVisible();
    await page.getByLabel("Gerekçe").fill("Müşteri iadesi #4211");
    conn.queryDelayMs = 1500;
    await editor.press("Control+Enter");
    await expect(page.getByText("Onay bekleniyor")).toBeVisible();
    await settle(page, 500);
    await page.screenshot({ path: shot(`console-waiting-${scheme}`) });
    await expect(page.getByText("Sorgu çalıştı, satır dönmedi.")).toBeVisible({ timeout: 5000 });
    expect(conn.posts.find((p) => p.path.endsWith("/query") && JSON.stringify(p.body).includes("UPDATE"))?.body).toMatchObject({ reason: "Müşteri iadesi #4211", max_rows: 500 });
  });
}

test("deploy: production run explains the locked approval, then streams the log", async ({ page }) => {
  const { api, conn } = await installConnections(page);
  await open(page, "/connections/deploy");
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "web — production" }) });
  await row.getByRole("button", { name: "Deploy et" }).click();
  const dialog = page.getByRole("dialog", { name: "web — production deploy edilsin mi?" });
  await expect(dialog.getByText("Production deploy kilitli onaydan geçer")).toBeVisible();
  await dialog.getByRole("button", { name: "Onaya gönder" }).click();
  await expect(dialog.getByText("Production deploy için değişiklik özeti gerekli.")).toBeVisible();
  await dialog.getByLabel("Ref").fill("v1.4.3");
  await dialog.getByLabel(/^Değişiklik özeti/).fill("Ödeme webhook zaman aşımı düzeltmesi");
  await expect(dialog.getByText("Production deploy için değişiklik özeti gerekli.")).toHaveCount(0);
  await settle(page, 500);
  await page.screenshot({ path: shot("deploy-run-dialog") });
  await dialog.getByRole("button", { name: "Onaya gönder" }).click();
  await expect(page).toHaveURL(/#\/connections\/deploy\/dep_web\?run=dr_9$/);
  await expect(page.getByTestId("production-frame")).toBeVisible();
  await expect(page.getByText("Onay bekleniyor").first()).toBeVisible();
  expect(conn.posts.find((p) => p.path.endsWith("/run"))?.body).toEqual({ ref: "v1.4.3", summary: "Ödeme webhook zaman aşımı düzeltmesi" });

  // Approved elsewhere: the run starts and log lines stream in live (ephemeral events).
  const r = conn.runs.find((x) => x.id === "dr_9");
  if (r) r.status = "running";
  api.push("deploy.started", { deploy_id: "dr_9" });
  await expect(page.getByText("Çalışıyor").first()).toBeVisible();
  for (const line of ["web-prod-1: git pull", "web-prod-1: systemctl restart web", "Sağlık kontrolü: 200 OK"]) {
    api.push("deploy.log", { deploy_id: "dr_9", line }, { id: 0, ephemeral: true });
    await page.waitForTimeout(60);
  }
  await expect(page.getByRole("log", { name: "Günlük" })).toContainText("Sağlık kontrolü: 200 OK");
  await settle(page, 600);
  await page.screenshot({ path: shot("deploy-live-log") });

  // A failed earlier run offers rollback.
  await page.getByRole("button", { name: /Başarısız/ }).click();
  await expect(page.getByRole("log", { name: "Günlük" }).filter({ hasText: "HATA: Sağlık kontrolü başarısız (503)." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Geri al" })).toBeVisible();
  await settle(page, 600);
  await page.screenshot({ path: shot("deploy-failed-run") });
});

test("deploy form: kind-specific fields with health check and rollback", async ({ page }) => {
  const { conn } = await installConnections(page);
  await open(page, "/connections/deploy");
  await page.getByRole("button", { name: "Yeni deploy profili" }).click();
  const sheet = page.getByRole("dialog", { name: "Yeni deploy profili" });
  await sheet.getByLabel(/^Ad\*?$/).fill("worker — test");
  await sheet.getByRole("radio", { name: "SSH" }).click();
  await sheet.getByRole("checkbox", { name: "staging-2" }).click();
  await sheet.getByLabel(/^Betik/).fill("cd /srv/worker && ./deploy.sh");
  await sheet.getByRole("radio", { name: "URL" }).click();
  await sheet.getByLabel(/^Adres/).fill("https://worker.odeme.com/healthz");
  await sheet.getByRole("switch", { name: /Tek tıkla geri alma tanımla/ }).click();
  await sheet.getByLabel(/^Geri alma betiği/).fill("cd /srv/worker && ./rollback.sh");
  await sheet.evaluate((el) => (el.scrollTop = 0));
  await settle(page, 500);
  await page.screenshot({ path: shot("deploy-form") });
  await sheet.getByRole("button", { name: "Oluştur" }).click();
  await expect.poll(() => conn.posts.find((p) => p.path === "POST /deploy/profiles")?.body).toMatchObject({
    workspace_id: "ws_1",
    name: "worker — test",
    kind: "ssh",
    config: { host_ids: ["staging-2"], script: "cd /srv/worker && ./deploy.sh", strategy: "sequential" },
    health_check: { url: "https://worker.odeme.com/healthz" },
    rollback: { host_ids: ["staging-2"], script: "cd /srv/worker && ./rollback.sh" },
  });
});

test("git accounts: token help, add, verify and repos", async ({ page }) => {
  const { conn } = await installConnections(page);
  await open(page, "/connections/git");
  await page.getByRole("button", { name: "Hesap ekle" }).click();
  const sheet = page.getByRole("dialog", { name: "Git hesabı ekle" });
  await sheet.getByRole("radio", { name: "GitLab" }).click();
  await expect(sheet.getByText(/api, read_repository ve write_repository/)).toBeVisible();
  const token = fakeToken();
  await sheet.getByLabel(/^Kişisel erişim belirteci/).fill(token);
  await settle(page, 500);
  await page.screenshot({ path: shot("git-form") });
  await sheet.getByRole("button", { name: "Doğrula ve ekle" }).click();
  await expect(sheet).toBeHidden();
  expect(conn.posts.find((p) => p.path === "POST /git/accounts")?.body).toEqual({ kind: "gitlab", token, api_url: null, name: null });

  const card = page.getByRole("listitem").filter({ hasText: "enes@github.com" });
  await card.getByRole("button", { name: "Doğrula" }).click();
  await expect(page.getByText("Belirteç geçerli")).toBeVisible();
  await card.getByRole("button", { name: "Repolar" }).click();
  await expect(card.getByText("odeme/api")).toBeVisible();
  await card.getByRole("textbox", { name: "Repo ara" }).fill("dot");
  await expect(card.getByText("odeme/api")).toHaveCount(0);
  await expect(card.getByText("enes/dotfiles")).toBeVisible();
  await settle(page, 500);
  await page.screenshot({ path: shot("git-repos") });
});

test("audit: production records stand out and expand in place", async ({ page }) => {
  await installConnections(page);
  await open(page, "/connections/audit");
  const list = page.getByRole("list", { name: "Denetim kaydı" });
  await expect(list.locator('[data-environment="production"]')).toHaveCount(3);
  await list.getByRole("button", { name: /rm -rf/ }).click();
  await expect(list.getByText("Ajanın uzak erişimi salt okuma; yazma komutları reddedilir.")).toBeVisible();
  await settle(page, 600);
  await page.screenshot({ path: shot("audit-expanded") });
});

for (const scheme of ["light", "dark"] as const) {
  test(`remote terminal: production waits for approval, then streams output (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await installConnections(page);
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/remote\/hosts\/[^/]+\/terminal/, (ws) => {
      ws.onMessage(() => undefined);
      sockets.push(ws);
      ws.send(JSON.stringify({ kind: "status", state: "waiting_approval", approval_id: "apr_term" }));
    });
    await open(page, "/connections/hosts/web-prod-1/terminal");
    await expect(page.getByText("Production terminali onay bekliyor")).toBeVisible();
    await expect(page.getByTestId("production-frame")).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`terminal-waiting-${scheme}`) });
    const ws = sockets[sockets.length - 1];
    if (!ws) throw new Error("terminal socket not opened");
    ws.send(JSON.stringify({ kind: "status", state: "connecting" }));
    ws.send(JSON.stringify({ kind: "status", state: "open", terminal_session_id: "term_1" }));
    ws.send(
      JSON.stringify({
        kind: "output",
        data: "\u001b[1;32mdeploy@web1\u001b[0m:\u001b[1;34m~\u001b[0m$ uptime\r\n 11:02:14 up 41 days,  3:12,  1 user,  load average: 0.31, 0.27, 0.22\r\n\u001b[1;32mdeploy@web1\u001b[0m:\u001b[1;34m~\u001b[0m$ ",
      }),
    );
    await expect(page.getByTestId("terminal-status")).toContainText("Bağlı");
    await expect(page.getByTestId("terminal")).toContainText("load average");
    await settle(page, 700);
    await page.screenshot({ path: shot(`terminal-open-${scheme}`) });
    ws.send(JSON.stringify({ kind: "exit", code: 0 }));
    await expect(page.getByText("Oturum kapandı (çıkış kodu 0).")).toBeVisible();
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`empty lists and endpoints the engine does not have yet (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await installConnections(page, (c) => {
      c.hosts = [];
      c.dbs = [];
      c.audit = [];
    });
    // Deploy not built into this studiod: the tab explains instead of erroring.
    await page.route("**/api/deploy/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: "Bulunamadı" } }) }));
    await open(page, "/connections/hosts");
    await expect(page.getByText("Henüz host yok")).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "~/.ssh/config'ten içe aktar" })).toHaveCount(2);
    await settle(page, 800);
    await page.screenshot({ path: shot(`hosts-empty-${scheme}`) });
    await page.getByRole("tab", { name: /Deploy/ }).click();
    await expect(page.getByText("Bu özellik motorda henüz yok")).toBeVisible();
    await settle(page, 800);
    await page.screenshot({ path: shot(`deploy-unavailable-${scheme}`) });
    await page.getByRole("tab", { name: /Denetim kaydı/ }).click();
    await expect(page.getByText("Henüz kayıt yok")).toBeVisible();
  });
}
