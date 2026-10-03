/**
 * Memory e2e: document tree by layer, view ↔ edit with a commit message, document history with
 * diff and restore, the proposals inbox (edit-before-approve, reject with note, live arrivals),
 * the boundaries map, the per-role agent context and the repo history. Mocks live here.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { installMockApi, NOW, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

type Json = Record<string, unknown>;

const FACTS_V1 = `# Proje gerçekleri

<!--
Bu dosya her ajanın sistem istemine girer.
-->

## Amaç
<!-- Proje ne işe yarıyor? -->

## Teknoloji yığını
<!-- Diller, çatılar -->
`;

const FACTS = `# Proje gerçekleri

<!--
Bu dosya her ajanın sistem istemine girer. Kısa, doğru ve güncel tut.
-->

## Amaç
Ödeme servisi; pazar yeri satıcılarına kartla, havaleyle ve taksitle tahsilat sağlar.

## Teknoloji yığını
- **API:** Python 3.13, FastAPI, SQLAlchemy 2 (async)
- **Veritabanı:** PostgreSQL 16, Redis 7 (oturum ve hız sınırı)
- **Web:** Next.js 15, TypeScript

## Komutlar
\`uv run pytest -q\` testleri çalıştırır; \`pnpm dev\` web uygulamasını açar.

## Ortamlar
<!-- local / test / production -->
`;

const BOUNDARIES = `---
forbidden_paths: [".env", "secrets/**"]
readonly_paths: ["migrations/**", "vendor/**"]
allowed_commands: ["uv run pytest*", "pnpm test"]
denied_commands: ["git push --force*", "rm -rf *"]
network: true
sandbox: workspace_write
remote_access: read
---

# Sınırlar

## Açıklamalar

Production veritabanına yalnız okuma sorguları gider.
`;

const DECISION = `---
title: Limit eşikleri yüzde 80 ve 95
date: 2026-10-03
status: kabul edildi
summary: Limit çubukları yüzde 80'de uyarı, yüzde 95'te kritik renge döner.
---

# Limit eşikleri yüzde 80 ve 95

## Bağlam
Kullanıcılar limit dolmadan önce haber almak istiyor.

## Karar
Uyarı eşiği **%80**, kritik eşik **%95** olsun.
`;

interface MemoryMockState {
  docs: Record<string, { layer: string; title: string; content: string; updated_at: string }>;
  versions: Record<string, Record<string, string>>;
  commits: Json[];
  writes: { path: string; content: string; message: string | null }[];
  restores: string[];
  proposals: Json[];
  decisions: { id: string; body: Json }[];
  contextRoles: string[];
}

function commit(sha: string, message: string, actor: string, minutes: number, paths: string[]): Json {
  return { sha: sha.padEnd(40, "0"), short_sha: sha.slice(0, 8), message, body: "", author: "AI Studio", actor, committed_at: iso(minutes), paths };
}

function proposal(id: string, over: Json): Json {
  return {
    id,
    workspace_id: "ws_1",
    layer: "decisions",
    path: "decisions/2026-10-03-bildirim-kuyrugu.md",
    old_content: null,
    new_content: "# Bildirimler kuyrukla gönderilsin\n\n## Karar\nSQS kuyruğu kullanılır.\n",
    diff: "--- /dev/null\n+++ b/decisions/2026-10-03-bildirim-kuyrugu.md\n@@ -0,0 +1,4 @@\n+# Bildirimler kuyrukla gönderilsin\n+\n+## Karar\n+SQS kuyruğu kullanılır.\n",
    rationale: "Mimari kurulun sentezi bu kararı önerdi; ödeme yanıtını bildirim sağlayıcılarından ayırır.",
    source_session_id: "ses_7",
    approval_id: `apr_${id}`,
    status: "pending",
    created_at: iso(-12),
    edited: false,
    note: null,
    decided_at: null,
    ...over,
  };
}

async function installMemoryMocks(page: Page, mutate?: (s: MemoryMockState) => void): Promise<{ api: MockApi; state: MemoryMockState }> {
  const api = await installMockApi(page);
  const state: MemoryMockState = {
    docs: {
      "facts.md": { layer: "facts", title: "Proje gerçekleri", content: FACTS, updated_at: iso(-90) },
      "boundaries.md": { layer: "boundaries", title: "Sınırlar", content: BOUNDARIES, updated_at: iso(-60 * 30) },
      "decisions/README.md": { layer: "decisions", title: "Karar kayıtları", content: "# Karar kayıtları\n\nHer karar ayrı bir dosyadır.\n", updated_at: iso(-60 * 200) },
      "decisions/2026-10-03-limit-esikleri.md": { layer: "decisions", title: "Limit eşikleri yüzde 80 ve 95", content: DECISION, updated_at: iso(-40) },
      "decisions/2026-09-28-sentry-izleme.md": { layer: "decisions", title: "Hatalar Sentry ile izlensin", content: "# Hatalar Sentry ile izlensin\n\nKarar metni.\n", updated_at: iso(-60 * 24 * 5) },
      "sessions/README.md": { layer: "sessions", title: "Oturum özetleri", content: "# Oturum özetleri\n", updated_at: iso(-60 * 200) },
      "sessions/2026-10-02-ses_1.md": { layer: "sessions", title: "Oturum özeti: limit çubukları", content: "# Oturum özeti: limit çubukları\n\nÜst çubuğa limit göstergeleri eklendi.\n", updated_at: iso(-60 * 20) },
    },
    versions: { "facts.md": { c3: FACTS, c1: FACTS_V1 } },
    commits: [
      commit("c3c3c3c3", "facts.md düzenlendi", "user", -90, ["facts.md"]),
      commit("c2c2c2c2", "Hafıza önerisi uygulandı: decisions/2026-10-03-limit-esikleri.md", "agent:ses_1", -40 - 60, ["decisions/2026-10-03-limit-esikleri.md"]),
      commit("c1c1c1c1", "Hafıza başlatıldı", "system", -60 * 200, ["facts.md", "boundaries.md", "decisions/README.md", "sessions/README.md"]),
    ],
    writes: [],
    restores: [],
    proposals: [
      proposal("memp_1", {}),
      proposal("memp_2", {
        layer: "boundaries",
        path: "boundaries.md",
        old_content: "network: true\n",
        new_content: "network: false\n",
        diff: "--- a/boundaries.md\n+++ b/boundaries.md\n@@ -1 +1 @@\n-network: true\n+network: false\n",
        rationale: "Test ortamında dış ağa çıkış gerekmiyor.",
        source_session_id: "ses_8",
        created_at: iso(-3),
      }),
      proposal("memp_3", { status: "applied", edited: true, commit_sha: "c2c2c2c2".padEnd(40, "0"), decided_at: iso(-100), path: "decisions/2026-10-03-limit-esikleri.md" }),
      proposal("memp_4", { status: "rejected", note: "Bu bilgi zaten facts.md'de var.", decided_at: iso(-300), path: "facts.md", layer: "facts", old_content: FACTS_V1, new_content: FACTS }),
    ],
    decisions: [],
    contextRoles: [],
  };
  mutate?.(state);

  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname.replace(/^\/api/, ""));
    const method = req.method();

    const decision = /^\/approvals\/([^/]+)\/decision$/.exec(path);
    if (decision && method === "POST") {
      const body = req.postDataJSON() as Json;
      state.decisions.push({ id: decision[1]!, body });
      const p = state.proposals.find((x) => x.approval_id === decision[1]);
      if (p) {
        p.status = body.approve ? "applied" : "rejected";
        p.note = (body.note as string | null) ?? null;
        const payload = body.decision_payload as Json | null;
        if (payload && typeof payload.content === "string") {
          p.new_content = payload.content;
          p.edited = true;
        }
        p.decided_at = iso(0);
      }
      return json(route, { id: decision[1], status: body.approve ? "approved" : "rejected" });
    }

    if (!path.startsWith("/memory/ws_1")) return route.fallback();
    const sub = path.slice("/memory/ws_1".length);
    if (sub === "/docs" && method === "GET") {
      return json(route, Object.entries(state.docs).map(([p, d]) => ({ path: p, layer: d.layer, title: d.title, content: url.searchParams.get("content") === "false" ? "" : d.content, updated_at: d.updated_at })));
    }
    if (sub.startsWith("/docs/")) {
      const docPath = sub.slice("/docs/".length);
      if (method === "PUT") {
        const body = req.postDataJSON() as { content: string; message: string | null };
        state.writes.push({ path: docPath, ...body });
        const existing = state.docs[docPath];
        const layer = docPath.startsWith("decisions/") ? "decisions" : docPath.startsWith("sessions/") ? "sessions" : docPath.replace(".md", "");
        const title = /^#\s+(.+)$/m.exec(body.content)?.[1] ?? docPath;
        state.docs[docPath] = { layer: existing?.layer ?? layer, title, content: body.content, updated_at: iso(0) };
        state.commits.unshift(commit(`d${state.writes.length}`.padEnd(8, "d"), body.message ?? `${docPath} düzenlendi`, "user", 0, [docPath]));
        return json(route, { commit: `d${state.writes.length}`.padEnd(40, "d"), doc: { path: docPath, ...state.docs[docPath] } });
      }
      const at = url.searchParams.get("commit");
      if (at) {
        const content = state.versions[docPath]?.[at.slice(0, 2)];
        return content !== undefined
          ? json(route, { path: docPath, layer: "facts", title: "Proje gerçekleri", content })
          : json(route, { error: { code: "not_found", message: "Belge bu sürümde yok." } }, 404);
      }
      const doc = state.docs[docPath];
      return doc ? json(route, { path: docPath, ...doc }) : json(route, { error: { code: "not_found", message: "Hafıza belgesi bulunamadı." } }, 404);
    }
    if (sub === "/history") {
      const p = url.searchParams.get("path");
      return json(route, p ? state.commits.filter((c) => (c.paths as string[]).includes(p)) : state.commits);
    }
    if (sub === "/diff") {
      const base = url.searchParams.get("base") ?? "";
      const head = url.searchParams.get("head") ?? "";
      const diff = head.startsWith("c3")
        ? `diff --git a/facts.md b/facts.md\n--- a/facts.md\n+++ b/facts.md\n@@ -6,6 +6,15 @@ # Proje gerçekleri\n \n ## Amaç\n-<!-- Proje ne işe yarıyor? -->\n+Ödeme servisi; pazar yeri satıcılarına kartla, havaleyle ve taksitle tahsilat sağlar.\n \n ## Teknoloji yığını\n-<!-- Diller, çatılar -->\n+- **API:** Python 3.13, FastAPI, SQLAlchemy 2 (async)\n+- **Veritabanı:** PostgreSQL 16, Redis 7\n`
        : `diff --git a/decisions/2026-10-03-limit-esikleri.md b/decisions/2026-10-03-limit-esikleri.md\nnew file mode 100644\n--- /dev/null\n+++ b/decisions/2026-10-03-limit-esikleri.md\n@@ -0,0 +1,3 @@\n+# Limit eşikleri yüzde 80 ve 95\n+\n+Uyarı eşiği %80, kritik eşik %95 olsun.\n`;
      return json(route, { base, head, path: null, diff, truncated: false });
    }
    if (sub === "/restore" && method === "POST") {
      const body = req.postDataJSON() as { commit: string };
      state.restores.push(body.commit);
      return json(route, { head: "e".repeat(40) });
    }
    if (sub === "/proposals") return json(route, state.proposals);
    if (sub === "/boundaries") {
      return json(route, {
        forbidden_paths: [".env", "secrets/**"],
        readonly_paths: ["migrations/**", "vendor/**"],
        allowed_commands: ["uv run pytest*", "pnpm test"],
        denied_commands: ["git push --force*", "rm -rf *"],
        network: true,
        sandbox: "workspace_write",
        remote_access: "read",
      });
    }
    if (sub === "/context") {
      const role = url.searchParams.get("role") ?? "writer";
      state.contextRoles.push(role);
      const text = `# Ortak hafıza: Ödeme servisi\nBu bölüm çalışma alanının ortak hafızasından gelir; tüm ajanlar aynı bilgiyi görür.\n\n## Sınırlar (zorunlu)\n- Dokunulmayacak yollar (okuma ve yazma yasak): \`.env\`, \`secrets/**\`\n- Salt okunur yollar: \`migrations/**\`, \`vendor/**\`\n- Ağ erişimi: açık\n\n## Proje gerçekleri\n### Amaç\nÖdeme servisi; pazar yeri satıcılarına tahsilat sağlar.\n\n## Kararlar (${role === "advisor" ? 30 : 8} en yeni)\n- 2026-10-03 — Limit eşikleri yüzde 80 ve 95 [kabul edildi] (\`decisions/2026-10-03-limit-esikleri.md\`)\n\nAyrıntı için \`memory_read\` aracını kullan.`;
      return json(route, { role, text, chars: text.length + (role === "advisor" ? 3100 : 2400) });
    }
    return json(route, { error: { code: "not_found", message: "Bulunamadı" } }, 404);
  });
  return { api, state };
}

async function openMemory(page: Page, hash = "/memory") {
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
  test(`memory pages render (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installMemoryMocks(page);
    await openMemory(page);
    const nav = page.getByRole("navigation", { name: "Hafıza" });
    await expect(nav.getByRole("link", { name: /Proje gerçekleri/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Proje gerçekleri", level: 2 })).toBeVisible();
    await expect(page.getByText("Ödeme servisi; pazar yeri satıcılarına kartla")).toBeVisible();
    // HTML comments are hidden; empty sections get a placeholder.
    await expect(page.getByText("Bu dosya her ajanın sistem istemine girer")).toHaveCount(0);
    await expect(page.getByText("Henüz yazılmamış.")).toBeVisible();
    await settle(page, 800);
    await page.screenshot({ path: shot(`memory-doc-${scheme}`) });

    await nav.getByRole("link", { name: /Öneriler/ }).click();
    await expect(page.getByRole("heading", { name: "Hafıza önerileri" })).toBeVisible();
    await expect(page.getByRole("article", { name: "decisions/2026-10-03-bildirim-kuyrugu.md" })).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`memory-proposals-${scheme}`) });

    await nav.getByRole("link", { name: "Sınır haritası" }).click();
    await expect(page.getByRole("region", { name: "Dokunulmaz yollar" }).getByText("secrets/**")).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`memory-boundaries-${scheme}`) });

    await nav.getByRole("link", { name: "Ajan bağlamı" }).click();
    await expect(page.getByRole("heading", { name: "Ortak hafıza: Ödeme servisi" })).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`memory-context-${scheme}`) });

    await nav.getByRole("link", { name: "Geçmiş" }).click();
    await expect(page.getByRole("region", { name: "facts.md", exact: true })).toBeVisible();
    await settle(page, 900);
    await page.screenshot({ path: shot(`memory-history-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("tree: layers with counts, decision front matter, collapse and expand", async ({ page }) => {
  await installMemoryMocks(page);
  await openMemory(page);
  const nav = page.getByRole("navigation", { name: "Hafıza" });
  const decisions = nav.getByRole("button", { name: /Kararlar/ });
  await expect(decisions).toContainText("2");
  await expect(nav.getByRole("button", { name: /Oturum özetleri/ })).toContainText("1");
  await nav.getByRole("link", { name: /Limit eşikleri yüzde 80 ve 95/ }).click();
  await expect(page).toHaveURL(/#\/memory\/doc\/decisions\/2026-10-03-limit-esikleri\.md$/);
  await expect(page.getByText("kabul edildi")).toBeVisible();
  await expect(page.getByText("Limit çubukları yüzde 80'de uyarı, yüzde 95'te kritik renge döner.")).toBeVisible();
  await settle(page, 500);
  await page.screenshot({ path: shot("memory-decision") });

  await decisions.click();
  await expect(decisions).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", { name: /Hatalar Sentry ile izlensin/ })).toHaveCount(0);
  await decisions.click();
  await expect(nav.getByRole("link", { name: /Hatalar Sentry ile izlensin/ })).toBeVisible();
});

test("edit a document and save it with a commit message", async ({ page }) => {
  const { state } = await installMemoryMocks(page);
  await openMemory(page, "/memory/doc/facts.md");
  await expect(page.getByRole("heading", { name: "Proje gerçekleri", level: 2 })).toBeVisible();
  await page.keyboard.press(`${mod}+e`);
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("## Amaç");
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type("\n## Sözlük\nTahsilat: satıcıya aktarılan tutar.");
  await expect(page.getByText("Kaydedilmemiş değişiklikler")).toBeVisible();
  await page.getByLabel("Commit mesajı").fill("Sözlük bölümü eklendi");
  await settle(page, 400);
  await page.screenshot({ path: shot("memory-edit") });
  await page.getByRole("button", { name: /^Kaydet/ }).click();
  await expect(page.getByText("Kaydedildi").first()).toBeVisible();
  expect(state.writes[0]!.message).toBe("Sözlük bölümü eklendi");
  expect(state.writes[0]!.content).toContain("## Sözlük\nTahsilat: satıcıya aktarılan tutar.");
  await expect(page).toHaveURL(/#\/memory\/doc\/facts\.md$/);
  await expect(page.getByText("Tahsilat: satıcıya aktarılan tutar.")).toBeVisible();
});

test("document history: diff against the previous version and restore", async ({ page }) => {
  const { state } = await installMemoryMocks(page);
  await openMemory(page, "/memory/doc/facts.md?mode=history");
  await expect(page.getByRole("button", { name: /facts\.md düzenlendi/ })).toBeVisible();
  await expect(page.locator(".cm-mergeView, .cm-changedLine, .cm-deletedChunk").first()).toBeVisible();
  await page.getByRole("button", { name: /Hafıza başlatıldı/ }).click();
  await page.getByRole("button", { name: "Belgeyi bu sürüme döndür" }).click();
  const dialog = page.getByRole("dialog", { name: /c1c1c1c1 sürümüne döndürülsün mü/ });
  await settle(page, 300);
  await page.screenshot({ path: shot("memory-doc-history") });
  await dialog.getByRole("button", { name: "Belgeyi bu sürüme döndür" }).click();
  await expect(page.getByText("Belge döndürüldü").first()).toBeVisible();
  expect(state.writes[0]).toEqual({ path: "facts.md", content: FACTS_V1, message: "facts.md c1c1c1c1 sürümüne döndürüldü" });
});

test("proposals: edit before approve, reject with a note, counts follow", async ({ page }) => {
  const { state } = await installMemoryMocks(page);
  await openMemory(page, "/memory/proposals");
  const nav = page.getByRole("navigation", { name: "Hafıza" });
  await expect(nav.getByLabel("2 bekleyen öneri")).toBeVisible();

  const first = page.getByRole("article", { name: "decisions/2026-10-03-bildirim-kuyrugu.md" });
  await expect(first.getByText("Mimari kurulun sentezi bu kararı önerdi")).toBeVisible();
  await expect(first.getByRole("link", { name: /Kaynak oturum: ses_7/ })).toHaveAttribute("href", "#/sessions/ses_7");
  await first.getByRole("button", { name: "Onaylamadan düzenle" }).click();
  const editor = first.getByRole("textbox", { name: "Onaylamadan düzenle" });
  await expect(editor).toContainText("SQS kuyruğu kullanılır.");
  await editor.click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type("Ölü mektup kuyruğu da kurulur.\n");
  await expect(first.getByRole("button", { name: "Düzenleyerek onayla" })).toBeVisible();
  await settle(page, 500);
  await page.screenshot({ path: shot("memory-proposal-edit") });
  await first.getByRole("button", { name: "Düzenleyerek onayla" }).click();
  await expect(page.getByText("Öneri onaylandı").first()).toBeVisible();
  await expect(first).toHaveCount(0);
  expect(state.decisions[0]!.id).toBe("apr_memp_1");
  expect(state.decisions[0]!.body).toMatchObject({ approve: true, note: null });
  expect((state.decisions[0]!.body.decision_payload as Json).content).toContain("Ölü mektup kuyruğu da kurulur.");
  await expect(nav.getByLabel("1 bekleyen öneri")).toBeVisible();

  const second = page.getByRole("article", { name: "boundaries.md" });
  await expect(second.getByText("Sınırları değiştiren öneri; dikkatle inceleyin.")).toBeVisible();
  await second.getByRole("button", { name: "Reddet" }).click();
  await second.getByPlaceholder("Not (isteğe bağlı)").fill("Test ortamı dış servislere bağlanıyor.");
  await second.getByRole("button", { name: "Reddet" }).click();
  await expect(page.getByText("Bekleyen öneri yok")).toBeVisible();
  expect(state.decisions[1]!.body).toEqual({ approve: false, note: "Test ortamı dış servislere bağlanıyor.", decision_payload: null });

  await page.getByRole("radio", { name: /Uygulanan/ }).click();
  await expect(page.getByRole("article", { name: "decisions/2026-10-03-bildirim-kuyrugu.md" }).getByText("Düzenlenerek onaylandı")).toBeVisible();
  await settle(page, 700);
  await page.screenshot({ path: shot("memory-proposals-applied") });
});

test("live memory.proposed shows a new proposal and bumps the count", async ({ page }) => {
  const { api, state } = await installMemoryMocks(page);
  await openMemory(page, "/memory/proposals");
  const nav = page.getByRole("navigation", { name: "Hafıza" });
  await expect(nav.getByLabel("2 bekleyen öneri")).toBeVisible();
  state.proposals.push(proposal("memp_9", { path: "sessions/2026-10-03-ses_9.md", layer: "sessions", rationale: "Oturum sona erdiği için otomatik oluşturulan özet.", created_at: iso(0) }));
  api.push("memory.proposed", { proposal_id: "memp_9", path: "sessions/2026-10-03-ses_9.md", layer: "sessions" });
  await expect(nav.getByLabel("3 bekleyen öneri")).toBeVisible();
  await expect(page.getByRole("article", { name: "sessions/2026-10-03-ses_9.md" })).toBeVisible();
});

test("repo history: multi-file diff and restoring the whole memory", async ({ page }) => {
  const { state } = await installMemoryMocks(page);
  await openMemory(page, "/memory/history");
  await expect(page.getByRole("region", { name: "facts.md", exact: true })).toContainText("Ödeme servisi; pazar yeri");
  await page.getByRole("button", { name: /Hafıza önerisi uygulandı/ }).click();
  await expect(page.getByRole("region", { name: "decisions/2026-10-03-limit-esikleri.md", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hafızayı bu sürüme geri yükle" }).click();
  await page.getByRole("dialog", { name: /c2c2c2c2 sürümüne geri yüklensin mi/ }).getByRole("button", { name: "Hafızayı bu sürüme geri yükle" }).click();
  await expect(page.getByText("Hafıza geri yüklendi").first()).toBeVisible();
  expect(state.restores).toEqual(["c2c2c2c2".padEnd(40, "0")]);
});

test("new decision record opens in the editor", async ({ page }) => {
  const { state } = await installMemoryMocks(page);
  await openMemory(page);
  const nav = page.getByRole("navigation", { name: "Hafıza" });
  await nav.getByRole("button", { name: /Kararlar/ }).hover();
  await nav.getByRole("button", { name: "Yeni karar" }).click();
  const dialog = page.getByRole("dialog", { name: "Yeni karar kaydı" });
  await dialog.getByLabel(/Başlık/).fill("Bildirimler kuyrukla gönderilsin");
  await expect(dialog.getByText("decisions/2026-10-03-bildirimler-kuyrukla-gonderilsin.md")).toBeVisible();
  await dialog.getByRole("button", { name: "Oluştur" }).click();
  await expect(page).toHaveURL(/#\/memory\/doc\/decisions\/2026-10-03-bildirimler-kuyrukla-gonderilsin\.md\?mode=edit$/);
  expect(state.writes[0]!.path).toBe("decisions/2026-10-03-bildirimler-kuyrukla-gonderilsin.md");
  expect(state.writes[0]!.content).toContain("status: önerildi");
  await expect(page.locator(".cm-content")).toContainText("# Bildirimler kuyrukla gönderilsin");
});

test("context preview follows the selected role; boundaries link to the editor", async ({ page }) => {
  const { state } = await installMemoryMocks(page);
  await openMemory(page, "/memory/context");
  await expect(page.getByText(/\/ 8\.000 karakter/)).toBeVisible();
  await page.getByRole("radio", { name: "Danışman" }).click();
  await expect(page.getByText("Kararlar (30 en yeni)")).toBeVisible();
  expect(state.contextRoles).toContain("advisor");
  await page.getByRole("radio", { name: "Ham metin" }).click();
  await expect(page.locator("pre")).toContainText("# Ortak hafıza: Ödeme servisi");

  await openMemory(page, "/memory/boundaries");
  await expect(page.getByRole("meter", { name: "Sandbox" })).toHaveAttribute("aria-valuetext", "Çalışma alanı");
  await expect(page.getByRole("meter", { name: "Uzak erişim" })).toHaveAttribute("aria-valuetext", "Salt okuma");
  await page.getByRole("link", { name: "boundaries.md'yi düzenle" }).click();
  await expect(page).toHaveURL(/#\/memory\/doc\/boundaries\.md\?mode=edit$/);
  await expect(page.locator(".cm-content")).toContainText("forbidden_paths");
});
