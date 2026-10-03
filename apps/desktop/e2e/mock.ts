/**
 * Mocked studiod for e2e: REST via page.route, the live event stream via page.routeWebSocket.
 * State is mutable so tests can flip endpoints off, take studiod down, or push events.
 */
import type { Page, Route, WebSocketRoute } from "@playwright/test";

/** Fixed "now" for deterministic relative times and countdowns. */
export const NOW = new Date("2026-10-03T11:00:00+03:00");

const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

export interface MockState {
  down: boolean;
  /** Endpoint prefixes that answer 404 (not built yet). */
  missing: string[];
  workspaces: Record<string, unknown>[];
  settings: Record<string, unknown>;
  limits: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  decisions: { id: string; approve: boolean; note: string | null }[];
}

export function approval(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: "plan",
    title: "Plan onayı: limit çubuklarını üst çubuğa ekle",
    summary: "3 adım · 2 dosya · çapraz inceleme Codex ile",
    payload: {},
    severity: "high",
    production: false,
    status: "pending",
    workspace_id: "ws_1",
    task_id: "task_142",
    run_id: null,
    session_id: null,
    requested_by: "agent:ses_1",
    decided_by: null,
    decision_note: null,
    channel: null,
    created_at: iso(-4),
    decided_at: null,
    expires_at: null,
    ...over,
  };
}

export function session(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    workspace_id: "ws_1",
    provider: "claude",
    profile_id: null,
    native_id: null,
    location: { kind: "local", host_id: null },
    cwd: "/Users/demo/src/odeme-servisi/apps/web",
    worktree_id: null,
    task_id: "task_142",
    run_id: null,
    node_id: null,
    label: "Limit çubukları",
    role: "writer",
    model: "claude-opus-5-5",
    state: "running_tool",
    origin: "created",
    title: null,
    created_at: iso(-20),
    updated_at: iso(-1),
    last_usage: { input_tokens: 48210, output_tokens: 6120, context_used: 84000, context_window: 200000 },
    ...over,
  };
}

export function defaultState(): MockState {
  return {
    down: false,
    missing: [],
    workspaces: [
      { id: "ws_1", name: "Ödeme servisi", slug: "odeme-servisi", color: "#C96442", archived: false, settings: {}, created_at: iso(-9000), updated_at: iso(-60) },
      { id: "ws_2", name: "Mobil uygulama", slug: "mobil-uygulama", color: "#3F6DB0", archived: false, settings: {}, created_at: iso(-8000), updated_at: iso(-600) },
    ],
    settings: { "appearance.theme": "system", "appearance.reduce_motion": "system" },
    limits: [
      { provider: "claude", window: "five_hour", label: "5 saat", used_percent: 42, resets_at: iso(134), status: "ok", source: "event", observed_at: iso(-2) },
      { provider: "claude", window: "seven_day", label: "Haftalık", used_percent: 76, resets_at: iso(60 * 52), status: "warning", source: "event", observed_at: iso(-2) },
      { provider: "codex", window: "five_hour", label: "5 saat", used_percent: 18, resets_at: iso(201), status: "ok", source: "probe", observed_at: iso(-7) },
      { provider: "codex", window: "seven_day", label: "Haftalık", used_percent: 93, resets_at: iso(60 * 20), status: "warning", source: "probe", observed_at: iso(-7) },
    ],
    approvals: [
      approval("apr_1"),
      approval("apr_2", {
        kind: "remote_command",
        title: "db-prod-1 üzerinde komut: VACUUM ANALYZE orders",
        summary: "Yazma sayıldı · production · ajan: Codex inceleyen",
        production: true,
        severity: "critical",
        created_at: iso(-1),
      }),
      approval("apr_3", { kind: "memory", title: "Hafıza önerisi: limit eşikleri kararı", summary: "decisions/2026-10-03-limit-esikleri.md", created_at: iso(-26) }),
    ],
    sessions: [
      session("ses_1"),
      session("ses_2", { provider: "codex", label: "review/limit-bars", role: "reviewer", model: "gpt-5.5-codex", state: "waiting_permission", last_usage: { input_tokens: 21400, output_tokens: 1880, context_used: 172000, context_window: 192000 } }),
      session("ses_3", { provider: "claude", label: "Mimari kurul", role: "advisor", model: "claude-sonnet-5", state: "thinking", last_usage: null }),
    ],
    decisions: [],
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export interface MockApi {
  state: MockState;
  /** Push a live event to the app over the mocked WebSocket. */
  push: (type: string, payload?: Record<string, unknown>, extra?: Record<string, unknown>) => void;
}

export async function installMockApi(page: Page, mutate?: (s: MockState) => void): Promise<MockApi> {
  const state = defaultState();
  mutate?.(state);
  let seq = 100;
  const sockets: WebSocketRoute[] = [];

  await page.clock.setFixedTime(NOW);

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    if (state.down) return route.abort("connectionrefused");
    if (state.missing.some((m) => path.startsWith(m))) {
      return json(route, { error: { code: "not_found", message: "Bulunamadı" } }, 404);
    }
    if (path === "/system") return json(route, { version: "0.1.0", modules: [], dev: true, last_event_id: seq });
    if (path === "/workspaces" && method === "GET") return json(route, state.workspaces);
    if (path === "/workspaces" && method === "POST") {
      const body = req.postDataJSON() as { name: string };
      const ws = { id: `ws_${state.workspaces.length + 1}`, name: body.name, slug: body.name.toLowerCase(), color: "#5FB27C", archived: false, settings: {}, created_at: iso(0), updated_at: iso(0) };
      state.workspaces.push(ws);
      return json(route, ws, 201);
    }
    if (path === "/settings" && method === "GET") return json(route, state.settings);
    if (path.startsWith("/settings/") && method === "PUT") {
      const key = decodeURIComponent(path.slice("/settings/".length));
      const body = req.postDataJSON() as { value: unknown };
      state.settings[key] = body.value;
      return json(route, { key, value: body.value });
    }
    if (path === "/limits") return json(route, state.limits);
    if (path === "/approvals" && method === "GET") return json(route, state.approvals.filter((a) => a.status === "pending"));
    const decision = /^\/approvals\/([^/]+)\/decision$/.exec(path);
    if (decision && method === "POST") {
      const id = decodeURIComponent(decision[1] ?? "");
      const body = req.postDataJSON() as { approve: boolean; note: string | null };
      state.decisions.push({ id, approve: body.approve, note: body.note });
      const a = state.approvals.find((x) => x.id === id);
      if (a) a.status = body.approve ? "approved" : "rejected";
      return json(route, a ?? {});
    }
    if (path === "/agents/sessions") return json(route, state.sessions);
    return json(route, { error: { code: "not_found", message: "Bulunamadı" } }, 404);
  });

  await page.routeWebSocket(/\/ws\/events/, (ws) => {
    if (state.down) {
      // Let the connection really fail (the dev proxy points at a closed port) instead of
      // "opening" a mocked socket, which the app would rightly read as studiod being up.
      ws.connectToServer();
      return;
    }
    sockets.push(ws);
    ws.send(JSON.stringify({ kind: "ready", last_id: seq }));
  });

  return {
    state,
    push: (type, payload = {}, extra = {}) => {
      seq += 1;
      const event = {
        id: seq,
        ts: iso(0),
        type,
        severity: "info",
        actor: "system",
        workspace_id: "ws_1",
        task_id: null,
        run_id: null,
        session_id: null,
        payload,
        ephemeral: false,
        ...extra,
      };
      for (const ws of sockets) ws.send(JSON.stringify({ kind: "event", event }));
    },
  };
}

/** Wait for springs to settle (JS-driven animations are not affected by Playwright's animation freezing). */
export async function settle(page: Page, ms = 700) {
  await page.waitForTimeout(ms);
}
