/**
 * E2E: CLI-native subagents (spec §25 "Yerel alt ajanlar") and first-class context windows.
 *
 * A Claude session splits its work into parallel subagents (one nested inside another); the
 * backfill comes from `/events` + `/agents/sessions/{id}/subagents`, then the mocked socket pushes
 * a live scenario: a nested subagent finishes, a new parallel one starts, one fails. Covers the
 * card badge + tree popover, nested collapsible blocks in the stream, the tree rail with deep
 * links, the shell hover card (context ring + subagents) and the "Hesap limitleri" panel with
 * its 24h sparkline. Screenshots (light and dark) go to test-results/screens/subagents-*.png.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { approval, installMockApi, NOW, session, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/subagents-${name}.png`;
const iso = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000).toISOString();
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const SID = "ses_sa";
const CWD = "/Users/demo/src/odeme-servisi";

let seq = 0;
function ev(type: string, payload: Record<string, unknown>, at: number) {
  seq += 1;
  return { id: seq, ts: iso(at), type, severity: "info", actor: `agent:${SID}`, workspace_id: "ws_1", task_id: null, run_id: null, session_id: SID, payload, ephemeral: false };
}

/** What happened before the page opened: two parallel subagents, one with a nested child. */
function history() {
  seq = 0;
  const t = -420;
  return [
    ev("agent.session.started", { native_id: "9a1f", model: "claude-opus-5-5", cwd: CWD, cli_version: "2.1.288" }, t),
    ev("agent.turn.started", { turn_id: "t1", input: "Ödeme akışını yeniden düzenle: önce modülleri tara, sonra testleri yaz." }, t + 2),
    ev("agent.message", { message_id: "m1", role: "assistant", text: "İşi paralel alt ajanlara bölüyorum: biri ödeme modüllerini tarayacak, biri testleri yazacak." }, t + 8),
    ev(
      "agent.tool.call",
      {
        call_id: "toolu_explore",
        tool: "Agent",
        kind: "subagent",
        input: { description: "Ödeme modüllerini tara", subagent_type: "Explore", prompt: "src/payments altındaki akışı çıkar; riskli yerleri işaretle." },
      },
      t + 10,
    ),
    ev(
      "agent.subagent.started",
      { subagent_id: "toolu_explore", parent_call_id: "toolu_explore", name: "Explore", description: "Ödeme modüllerini tara", model: "claude-sonnet-5" },
      t + 10,
    ),
    ev(
      "agent.tool.call",
      {
        call_id: "toolu_tests",
        tool: "Agent",
        kind: "subagent",
        input: { description: "Ödeme testlerini yaz", subagent_type: "general-purpose", prompt: "Refund ve capture için birim testleri yaz; fikstürleri ayrı bir alt ajana hazırlat." },
      },
      t + 11,
    ),
    ev("agent.subagent.started", { subagent_id: "toolu_tests", parent_call_id: "toolu_tests", name: "general-purpose", description: "Ödeme testlerini yaz" }, t + 11),
    ev("agent.tool.call", { call_id: "e1", tool: "Grep", kind: "search", input: { pattern: "PaymentIntent", path: "src" }, subagent_id: "toolu_explore" }, t + 14),
    ev("agent.tool.result", { call_id: "e1", output: "src/payments/intent.ts:12\nsrc/payments/refund.ts:40", subagent_id: "toolu_explore" }, t + 15),
    ev("agent.thinking", { message_id: "tt1", text: "Önce mevcut test düzenine bakmalıyım.", subagent_id: "toolu_tests" }, t + 16),
    ev("agent.tool.call", { call_id: "e2", tool: "Read", kind: "file_read", input: { file_path: `${CWD}/src/payments/refund.ts` }, subagent_id: "toolu_explore" }, t + 18),
    ev("agent.tool.result", { call_id: "e2", output: "export async function refund(…)", subagent_id: "toolu_explore" }, t + 19),
    ev(
      "agent.tool.call",
      {
        call_id: "toolu_fixture",
        tool: "Agent",
        kind: "subagent",
        input: { description: "Test fikstürlerini hazırla", subagent_type: "fixture-builder" },
        subagent_id: "toolu_tests",
      },
      t + 22,
    ),
    ev(
      "agent.subagent.started",
      { subagent_id: "toolu_fixture", parent_subagent_id: "toolu_tests", parent_call_id: "toolu_fixture", name: "fixture-builder", description: "Test fikstürlerini hazırla" },
      t + 22,
    ),
    ev("agent.tool.call", { call_id: "f1", tool: "Write", kind: "file_edit", input: { file_path: `${CWD}/tests/fixtures/payments.json` }, subagent_id: "toolu_fixture" }, t + 30),
    ev("agent.tool.result", { call_id: "f1", output: "Dosya yazıldı.", subagent_id: "toolu_fixture" }, t + 31),
    ev(
      "agent.message",
      { message_id: "em1", role: "assistant", text: "Akış dört modülde: intent, capture, refund, webhook. Refund'da yarış durumu riski var.", subagent_id: "toolu_explore" },
      t + 60,
    ),
    ev(
      "agent.subagent.completed",
      {
        subagent_id: "toolu_explore",
        status: "success",
        result_text: "Akış dört modülde: intent, capture, refund, webhook.\n\n**Risk:** `refund()` eşzamanlı çağrılarda iki kez iade yapabilir.",
        usage: { input_tokens: 18400, output_tokens: 2100, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, context_used: 31000, duration_ms: 52000, turns: 3 },
      },
      t + 62,
    ),
    ev("agent.tool.result", { call_id: "toolu_explore", output: "Akış dört modülde: intent, capture, refund, webhook." }, t + 62),
    ev("agent.usage", { input_tokens: 61200, output_tokens: 7400, context_used: 124000, context_window: 200000, partial: false }, t + 64),
  ];
}

const SNAPSHOT = [
  {
    session_id: SID,
    subagent_id: "toolu_explore",
    parent_subagent_id: null,
    parent_call_id: "toolu_explore",
    depth: 0,
    prompt: "src/payments altındaki akışı çıkar; riskli yerleri işaretle.",
    updated_at: iso(-358),
    name: "Explore",
    description: "Ödeme modüllerini tara",
    status: "success",
    model: "claude-sonnet-5",
    started_at: iso(-410),
    finished_at: iso(-358),
    input_tokens: 18400,
    output_tokens: 2100,
    tool_calls: 2,
    last_text: "Akış dört modülde: intent, capture, refund, webhook.",
  },
  {
    session_id: SID,
    subagent_id: "toolu_tests",
    parent_subagent_id: null,
    parent_call_id: "toolu_tests",
    depth: 0,
    prompt: "Refund ve capture için birim testleri yaz; fikstürleri ayrı bir alt ajana hazırlat.",
    updated_at: iso(-390),
    name: "general-purpose",
    description: "Ödeme testlerini yaz",
    status: "running",
    model: null,
    started_at: iso(-409),
    finished_at: null,
    input_tokens: 0,
    output_tokens: 0,
    tool_calls: 1,
    last_text: null,
  },
  {
    session_id: SID,
    subagent_id: "toolu_fixture",
    parent_subagent_id: "toolu_tests",
    parent_call_id: "toolu_fixture",
    depth: 1,
    prompt: null,
    updated_at: iso(-389),
    name: "fixture-builder",
    description: "Test fikstürlerini hazırla",
    status: "running",
    model: null,
    started_at: iso(-398),
    finished_at: null,
    input_tokens: 0,
    output_tokens: 0,
    tool_calls: 1,
    last_text: null,
  },
];

/** 24h of 5-hour-window snapshots: rises while agents work, drops at each reset. */
function limitHistory(provider: string, window: string) {
  const out: Record<string, unknown>[] = [];
  for (let i = 47; i >= 0; i -= 1) {
    const minutes = i * 30;
    const phase = (47 - i) % 10;
    const base = provider === "claude" ? 6 + phase * 9 : 4 + phase * 4;
    out.push({
      provider,
      window,
      label: "5 saat",
      used_percent: i === 0 ? (provider === "claude" ? 42 : 18) : Math.min(98, base + (i % 3)),
      resets_at: null,
      status: "ok",
      source: "event",
      observed_at: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    });
  }
  return out;
}

interface Setup extends MockApi {
  subagentRequests: number;
}

async function setup(page: Page, opts: { scheme?: "light" | "dark" } = {}): Promise<Setup> {
  if (opts.scheme) await page.emulateMedia({ colorScheme: opts.scheme });
  const api = await installMockApi(page, (s) => {
    s.sessions = [
      session(SID, {
        label: "Ödeme akışı yeniden düzenleme",
        cwd: CWD,
        state: "running_tool",
        model: "claude-opus-5-5",
        profile_id: "prof_cw",
        subagent_count: 3,
        active_subagents: 2,
        last_usage: { input_tokens: 61200, output_tokens: 7400, context_used: 124000, context_window: 200000 },
        updated_at: iso(-5),
      }),
      session("ses_rv", {
        provider: "codex",
        label: "review/payments",
        role: "reviewer",
        model: "gpt-5.5-codex",
        state: "thinking",
        cwd: CWD,
        subagent_count: 0,
        active_subagents: 0,
        last_usage: { input_tokens: 21400, output_tokens: 1880, context_used: 176000, context_window: 192000 },
        updated_at: iso(-30),
      }),
      session("ses_old", {
        label: "Mimari kurul",
        role: "advisor",
        model: "claude-sonnet-5",
        state: "done",
        last_usage: { input_tokens: 9020, output_tokens: 1100, context_used: 41000, context_window: 200000 },
        updated_at: iso(-7200),
      }),
    ];
  });
  const extra = { subagentRequests: 0 };
  const events = history();
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/events" && url.searchParams.get("session_id")) {
      return json(route, { events: url.searchParams.get("session_id") === SID ? events : [], has_more: false });
    }
    if (path === `/agents/sessions/${SID}/subagents`) {
      extra.subagentRequests += 1;
      return json(route, SNAPSHOT);
    }
    if (/^\/agents\/sessions\/[^/]+\/subagents$/.test(path)) return json(route, []);
    const one = /^\/agents\/sessions\/([^/]+)$/.exec(path);
    if (one) {
      const s = api.state.sessions.find((x) => x.id === one[1]);
      return s ? json(route, s) : json(route, { error: { code: "not_found", message: "Oturum bulunamadı." } }, 404);
    }
    if (path === "/limits/history") return json(route, limitHistory(url.searchParams.get("provider") ?? "claude", url.searchParams.get("window") ?? "five_hour"));
    if (path === "/agents/profiles") {
      return json(route, [
        { id: "prof_cw", workspace_id: null, name: "Claude yazar", provider: "claude", model: "claude-opus-5-5", effort: "high", role: "writer", instructions: "", color: null, builtin: true },
      ]);
    }
    if (path === "/agents/health") return json(route, []);
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

const push = (api: MockApi, type: string, payload: Record<string, unknown>) => api.push(type, payload, { session_id: SID });

/** The live part: a nested subagent finishes, a new parallel one starts, the test writer fails. */
function liveScenario(api: MockApi) {
  push(api, "agent.message", { message_id: "fm1", role: "assistant", text: "Fikstürler hazır: 6 senaryo.", subagent_id: "toolu_fixture" });
  push(api, "agent.subagent.completed", {
    subagent_id: "toolu_fixture",
    status: "success",
    result_text: "Fikstürler hazır: 6 senaryo.",
    usage: { input_tokens: 2900, output_tokens: 520, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, context_used: 6100, duration_ms: 41000, turns: 2 },
  });
  push(api, "agent.tool.result", { call_id: "toolu_fixture", output: "Fikstürler hazır: 6 senaryo.", subagent_id: "toolu_tests" });
  push(api, "agent.tool.call", { call_id: "toolu_review", tool: "Agent", kind: "subagent", input: { description: "Refund değişikliğini incele", subagent_type: "code-reviewer" } });
  push(api, "agent.subagent.started", { subagent_id: "toolu_review", parent_call_id: "toolu_review", name: "code-reviewer", description: "Refund değişikliğini incele" });
  // The model is learned later: the same start repeats (an upsert).
  push(api, "agent.subagent.started", { subagent_id: "toolu_review", parent_call_id: "toolu_review", model: "claude-sonnet-5" });
  push(api, "agent.usage", { input_tokens: 63800, output_tokens: 7700, context_used: 131000, context_window: 200000, partial: true });
  push(api, "agent.tool.call", { call_id: "r1", tool: "Bash", kind: "command", input: { command: "git diff --stat" }, subagent_id: "toolu_review" });
  push(api, "agent.tool.call", { call_id: "x1", tool: "Bash", kind: "command", input: { command: "pnpm test payments" }, subagent_id: "toolu_tests" });
}

function failTests(api: MockApi) {
  push(api, "agent.tool.result", { call_id: "x1", output: "✗ refund: eşzamanlı iade iki kez yapıldı\n2 failed, 14 passed", is_error: true, exit_code: 1, subagent_id: "toolu_tests" });
  push(api, "agent.subagent.completed", {
    subagent_id: "toolu_tests",
    status: "error",
    result_text: "2 test başarısız: refund eşzamanlı çağrıda iki kez iade yapıyor.",
    usage: { input_tokens: 14200, output_tokens: 1900, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, context_used: 22000, duration_ms: 95000, turns: 6 },
  });
  push(api, "agent.usage", { input_tokens: 66400, output_tokens: 8100, context_used: 151000, context_window: 200000, partial: false });
}

/** The reviewer subagent asks for permission (prefixed summary + subagent fields). */
function reviewerAsks(api: MockApi) {
  api.state.approvals.push(
    approval("apr_sub", {
      kind: "tool_permission",
      title: "İzin isteği - Ödeme akışı: Alt ajan (code-reviewer): `git stash` komutunu çalıştırmak istiyor",
      session_id: SID,
      payload: { session_id: SID, request_id: "rp1", tool: "Bash", kind: "command", command: "git stash", paths: [], subagent_id: "toolu_review", subagent_name: "code-reviewer" },
    }),
  );
  push(api, "agent.permission.request", {
    request_id: "rp1",
    tool: "Bash",
    kind: "command",
    command: "git stash",
    paths: [],
    summary: "Alt ajan (code-reviewer): `git stash` komutunu çalıştırmak istiyor",
    verdict: "ask",
    policy_reason: "Komut güvenli listede değil; kullanıcı onayı gerekiyor.",
    subagent_id: "toolu_review",
    subagent_name: "code-reviewer",
  });
  push(api, "approval.requested", { approval_id: "apr_sub", kind: "tool_permission" });
}

// ----------------------------------------------------------------------------- tests

for (const scheme of ["light", "dark"] as const) {
  test(`card badge and tree popover (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    const api = await setup(page, { scheme });
    await page.goto("/#/sessions");
    const card = page.getByRole("region", { name: "Etkin" }).getByRole("button", { name: /Ödeme akışı yeniden düzenleme/ }).first();
    await expect(card).toBeVisible();
    const badge = card.getByRole("button", { name: "Alt ajanlar: 3 alt ajan · 2 çalışıyor" });
    await expect(badge).toBeVisible();
    // Context ring with the exact figure for screen readers; effort chip from the profile.
    await expect(card.getByRole("meter", { name: "Bağlam" })).toHaveAttribute("aria-valuetext", "124.000 / 200.000 token (%62)");
    await expect(card.getByText("high")).toBeVisible();
    // The near-full Codex reviewer turns red.
    await expect(page.getByRole("button", { name: /review\/payments/ }).getByRole("meter", { name: "Bağlam" })).toHaveAttribute("data-tone", "critical");
    expect(api.subagentRequests).toBe(0); // counts come from the record; the list loads on demand
    await settle(page, 900);
    await page.screenshot({ path: shot(`list-${scheme}`) });

    await badge.hover();
    const pop = page.getByRole("dialog", { name: "Alt ajanlar" });
    await expect(pop.getByRole("group", { name: "Alt ajan ağacı" })).toBeVisible();
    await expect(pop.locator('[data-subagent-id="toolu_fixture"]')).toHaveAttribute("data-depth", "1");
    await expect(pop.getByText("Test fikstürlerini hazırla")).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`card-popover-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`stream: nested blocks, tree rail and live scenario (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    const api = await setup(page, { scheme });
    await page.addInitScript(() => window.localStorage.removeItem("aistudio.sessions.subagentRail"));
    await page.goto(`/#/sessions/${SID}`);
    const log = page.getByRole("log", { name: "Oturum akışı" });
    await expect(log.getByText("İşi paralel alt ajanlara bölüyorum")).toBeVisible();

    // Subagent internals stay folded: blocks with a summary line, no inner tool rows.
    const explore = log.locator('[data-subagent-id="toolu_explore"]');
    const tests = log.locator('[data-subagent-id="toolu_tests"]');
    await expect(explore).toHaveAttribute("data-status", "success");
    await expect(tests).toHaveAttribute("data-status", "running");
    await expect(explore.getByText("Akış dört modülde: intent, capture, refund, webhook.")).toBeVisible();
    await expect(log.getByRole("button", { name: /src\/ui|refund\.ts okundu/ })).toHaveCount(0);
    // The spawning Agent calls became the blocks (no duplicate tool rows).
    await expect(log.getByRole("button", { name: /Alt ajan: Alt ajan/ })).toHaveCount(0);

    // Header: subagent toggle + context ring.
    const status = page.getByRole("region", { name: "Oturum durumu" });
    await expect(status.getByRole("meter", { name: "Bağlam" })).toHaveAttribute("aria-valuenow", "62");
    const toggle = status.getByRole("button", { name: /^Alt ajan ağacı:/ });
    await expect(toggle).toHaveAccessibleName("Alt ajan ağacı: 3 alt ajan · 2 çalışıyor");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const rail = page.getByRole("complementary", { name: "Alt ajan ağacı" });
    await expect(rail).toBeVisible();
    await expect(rail.locator('[data-subagent-id="toolu_fixture"]')).toHaveAttribute("data-depth", "1");
    await settle(page, 1100);
    await page.screenshot({ path: shot(`stream-rail-${scheme}`) });

    // Live: the nested fixture builder finishes, a reviewer starts in parallel, tests run.
    liveScenario(api);
    await expect(rail.locator('[data-subagent-id="toolu_review"]')).toBeVisible();
    await expect(rail.locator('[data-subagent-id="toolu_fixture"]')).toHaveAttribute("data-status", "success");
    await expect(log.locator('[data-subagent-id="toolu_review"]')).toHaveAttribute("data-status", "running");
    await expect(tests.getByText(/pnpm test payments/)).toBeVisible(); // live summary line
    await expect(toggle).toHaveAccessibleName(/4 alt ajan · 2 çalışıyor/);

    // The test writer fails: block, rail and header follow.
    failTests(api);
    await expect(tests).toHaveAttribute("data-status", "error");
    await expect(rail.locator('[data-subagent-id="toolu_tests"]')).toHaveAttribute("data-status", "error");
    await expect(toggle).toHaveAccessibleName("Alt ajan ağacı: 4 alt ajan · 1 çalışıyor · 1 hatalı");
    await expect(status.getByRole("meter", { name: "Bağlam" })).toHaveAttribute("aria-valuenow", "76");
    await expect(status.getByRole("meter", { name: "Bağlam" })).toHaveAttribute("data-tone", "warning");
    // The reviewer asks for permission: the card names it, its block and tree node wait.
    reviewerAsks(api);
    const card = log.getByRole("group", { name: "İzin isteği" });
    await expect(card.getByRole("button", { name: "code-reviewer alt ajanı soruyor" })).toBeVisible();
    await expect(card.getByText("komutunu çalıştırmak istiyor")).toBeVisible();
    await expect(card.getByText(/^Alt ajan \(/)).toHaveCount(0);
    await expect(card.getByRole("button", { name: "İzin ver" })).toBeEnabled(); // matched its approval
    const review = log.locator('[data-subagent-id="toolu_review"]');
    await expect(review.getByText(/İzin bekliyor: .*git stash/)).toBeVisible();
    await expect(rail.locator('[data-subagent-id="toolu_review"]')).toHaveAttribute("data-waiting", "true");
    await settle(page, 1100);
    await page.screenshot({ path: shot(`stream-live-${scheme}`) });

    // Deep link from the rail into the nested block: parents open, the target is centered.
    await rail.getByRole("button", { name: /fixture-builder · Test fikstürlerini hazırla/ }).click();
    const fixture = log.locator('[data-subagent-id="toolu_fixture"]');
    await expect(fixture).toBeVisible();
    await expect(fixture.getByRole("button", { name: /Alt ajanlar: fixture-builder/ })).toHaveAttribute("aria-expanded", "true");
    await expect(fixture.getByRole("button", { name: /tests\/fixtures\/payments\.json yazıldı/ })).toBeVisible();
    await expect(fixture).toBeInViewport();
    await settle(page, 1200);
    await page.screenshot({ path: shot(`stream-deeplink-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("expanding a block shows its own steps and the answer", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/sessions/${SID}`);
  const log = page.getByRole("log", { name: "Oturum akışı" });
  const explore = log.locator('[data-subagent-id="toolu_explore"]');
  const header = explore.getByRole("button", { name: /Alt ajanlar: Explore · Ödeme modüllerini tara/ });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(explore.getByRole("button", { name: /Arama: PaymentIntent arandı/ })).toBeVisible();
  await expect(explore.getByRole("button", { name: /Dosya okuma: src\/payments\/refund\.ts okundu/ })).toBeVisible();
  await expect(explore.getByText("Sonuç")).toBeVisible();
  await expect(explore.getByText("eşzamanlı çağrılarda iki kez iade yapabilir")).toBeVisible();
  // Collapsing again keeps the stream clean.
  await header.click();
  await expect(explore.getByRole("button", { name: /Arama: PaymentIntent arandı/ })).toHaveCount(0);
});

test("card tree deep-links into the session page", async ({ page }) => {
  await setup(page);
  await page.goto("/#/sessions");
  const card = page.getByRole("region", { name: "Etkin" }).getByRole("button", { name: /Ödeme akışı yeniden düzenleme/ }).first();
  await card.getByRole("button", { name: /Alt ajanlar: 3 alt ajan/ }).hover();
  const pop = page.getByRole("dialog", { name: "Alt ajanlar" });
  await pop.getByRole("button", { name: /Explore · Ödeme modüllerini tara/ }).click();
  await expect(page).toHaveURL(/#\/sessions\/ses_sa\?subagent=toolu_explore$/);
  const explore = page.getByRole("log", { name: "Oturum akışı" }).locator('[data-subagent-id="toolu_explore"]');
  await expect(explore.getByRole("button", { name: /Alt ajanlar: Explore/ })).toHaveAttribute("aria-expanded", "true");
  await expect(explore).toBeInViewport();
});

for (const scheme of ["light", "dark"] as const) {
  test(`shell: agent hover card and account limits panel (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await setup(page, { scheme });
    await page.goto("/#/");
    await expect(page.getByRole("navigation", { name: "Gezinme" })).toBeVisible();

    await page.getByRole("button", { name: /Ödeme akışı yeniden düzenleme: / }).hover();
    const card = page.getByRole("dialog", { name: "Ödeme akışı yeniden düzenleme" });
    await expect(card.getByText("124.000 / 200.000 token")).toBeVisible();
    await expect(card.getByText("3 alt ajan · 2 çalışıyor")).toBeVisible();
    await expect(card.getByText("fixture-builder")).toBeVisible();
    await settle(page, 800);
    await page.screenshot({ path: shot(`shell-hover-${scheme}`) });
    await page.mouse.move(10, 600);
    await expect(card).toBeHidden();

    await page.getByRole("button", { name: "Kullanım limitleri" }).click();
    const panel = page.getByRole("dialog", { name: /Hesap limitleri/ });
    await expect(panel.getByRole("heading", { name: "Hesap limitleri" })).toBeVisible();
    const claude = panel.getByRole("region", { name: "Claude" });
    await expect(claude.getByText("Sıfırlanma: 2 sa 14 dk")).toBeVisible();
    await expect(claude.getByRole("img", { name: /Son 24 saat/ })).toBeVisible();
    await expect(claude.getByRole("button", { name: /Ödeme akışı yeniden düzenleme/ })).toBeVisible();
    await expect(panel.getByRole("region", { name: "Codex" }).getByRole("button", { name: /review\/payments/ })).toBeVisible();
    await settle(page, 1000);
    await page.screenshot({ path: shot(`limits-${scheme}`) });

    // Consumers open their session.
    await claude.getByRole("button", { name: /Ödeme akışı yeniden düzenleme/ }).click();
    await expect(page).toHaveURL(/#\/sessions\/ses_sa$/);
    expect(errors).toEqual([]);
  });
}

test("compact stream in the drawer: subagent popover jumps to the block", async ({ page }) => {
  await setup(page);
  await page.goto("/#/sessions");
  const card = page.getByRole("region", { name: "Etkin" }).getByRole("button", { name: /Ödeme akışı yeniden düzenleme/ }).first();
  await card.hover();
  await card.getByRole("button", { name: "Çekmecede aç" }).click();
  const drawer = page.getByRole("complementary", { name: "Ödeme akışı yeniden düzenleme" });
  const status = drawer.getByRole("region", { name: "Oturum durumu" });
  await status.getByRole("button", { name: /Alt ajan ağacı: 3 alt ajan/ }).click();
  const pop = page.getByRole("dialog", { name: "Alt ajan ağacı" });
  await pop.getByRole("button", { name: /general-purpose · Ödeme testlerini yaz/ }).click();
  const tests = drawer.locator('[data-subagent-id="toolu_tests"]');
  await expect(tests.getByRole("button", { name: /Alt ajanlar: general-purpose/ })).toHaveAttribute("aria-expanded", "true");
  await expect(tests).toBeInViewport();
  await settle(page, 900);
  await page.screenshot({ path: shot("drawer") });
});
