/**
 * Mocked team API for the teams e2e specs, layered on the shared studiod mock (routes registered
 * later win): /engine/teams (+ versions, validate), the run's team view, member messages, task
 * creation, the minimal task-detail endpoints and a scripted live run over the mocked socket.
 */
import type { Page, Route } from "@playwright/test";

import { installMockApi, NOW, type MockApi } from "./mock";

export type Json = Record<string, unknown>;

export const iso = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

export function member(id: string, role: string, over: Json = {}): Json {
  return {
    id,
    name: id,
    role,
    parent_id: null,
    provider: "claude",
    model: null,
    effort: null,
    profile_id: null,
    instructions: "",
    writes: role === "lead" || role === "worker",
    tests_member_id: null,
    test_mode: "dependent",
    test_command: null,
    boundaries: null,
    position: null,
    ...over,
  };
}

const settings = { report_mode: "each_assignment", report_interval_minutes: 15, max_parallel_members: 4, max_depth: 4, max_assignments: 40, test_max_rounds: 2, independent_tests_trigger: "at_end", merge_strategy: "merge" };

/** The team from the spec: advisor, lead, three developers (one with two sub-agents), testers. */
export function fullstackSpec(): Json {
  return {
    settings,
    members: [
      member("advisor", "advisor", { name: "Mimari danışman", parent_id: "lead", model: "claude-opus-5-5", effort: "max", instructions: "Mimari kararları gözden geçir." }),
      member("lead", "lead", { name: "Lider", model: "claude-opus-5-5", effort: "high" }),
      member("dev-ui", "worker", { name: "Arayüz geliştirici", parent_id: "lead", model: "claude-sonnet-5", effort: "high" }),
      member("dev-ui-1", "worker", { name: "Bileşenler", parent_id: "dev-ui", effort: "medium" }),
      member("dev-ui-2", "worker", { name: "Erişilebilirlik", parent_id: "dev-ui", provider: "codex", model: "gpt-5.5-codex", effort: "medium" }),
      member("dev-api", "worker", { name: "Sunucu geliştirici", parent_id: "lead", provider: "codex", model: "gpt-5.5-codex", effort: "high" }),
      member("dev-data", "worker", { name: "Veri geliştirici", parent_id: "lead", effort: "medium" }),
      member("qa-api", "tester", { name: "API testçisi", parent_id: "dev-api", tests_member_id: "dev-api", effort: "low", test_command: "pnpm test api" }),
      member("qa-e2e", "tester", { name: "Uçtan uca test", parent_id: "lead", test_mode: "independent", provider: "codex", model: "gpt-5.5-codex", test_command: "pnpm e2e" }),
    ],
  };
}

// --------------------------------------------------------------------------- built-in templates
// Mirrors backend/src/aistudio/engine/team/templates.py (ids, names, providers, efforts, layout).

const LEAD = "Görevi anla, uygulanabilir parçalara böl ve her parçayı en uygun üyeye ver. Üyelerin sonuçlarını kontrol et, çakışmaları çöz ve işi tutarlı bir bütün olarak bitir.";
const DEV = "Sana verilen işi temiz, test edilebilir kodla yap; kapsam dışına çıkma.";
const SUB = "Yöneticinin verdiği küçük ve net işi yap; bitirince kısa bir özet ver.";
const at = (x: number, y = 0) => ({ position: { x, y } });

function danismanliSpec(): Json {
  return {
    settings: { ...settings, max_parallel_members: 3 },
    members: [
      member("advisor", "advisor", { name: "Danışman", parent_id: "lead", provider: "codex", effort: "high", instructions: "Mimari, risk ve kalite açısından lideri yönlendir; kod yazma.", ...at(-260) }),
      member("lead", "lead", { name: "Lider", effort: "high", instructions: LEAD, ...at(0) }),
      member("dev-1", "worker", { name: "Geliştirici 1", parent_id: "lead", effort: "medium", instructions: DEV, ...at(-260, 180) }),
      member("dev-2", "worker", { name: "Geliştirici 2", parent_id: "lead", provider: "codex", effort: "medium", instructions: DEV, ...at(0, 180) }),
      member("dev-3", "worker", { name: "Geliştirici 3", parent_id: "lead", effort: "medium", instructions: DEV, ...at(260, 180) }),
    ],
  };
}

function derinSpec(): Json {
  const members: Json[] = [member("lead", "lead", { name: "Lider", effort: "high", instructions: LEAD, ...at(0) })];
  (["claude", "codex", "claude"] as const).forEach((provider, k) => {
    const i = k + 1;
    const x = (i - 2) * 360;
    members.push(member(`dev-${i}`, "worker", { name: `Geliştirici ${i}`, parent_id: "lead", provider, effort: "medium", instructions: `${DEV} İşi gerekirse alt ajanlarına böl ve sonuçlarını birleştir.`, ...at(x, 180) }));
    ["a", "b"].forEach((suffix, j) => {
      members.push(member(`dev-${i}-${suffix}`, "worker", { name: `Alt ajan ${i}${suffix.toUpperCase()}`, parent_id: `dev-${i}`, provider: provider === "claude" ? "codex" : "claude", effort: "low", instructions: SUB, ...at(x - 90 + 180 * j, 360) }));
    });
  });
  return { settings: { ...settings, max_parallel_members: 4, max_depth: 2 }, members };
}

function arayuzTestSpec(): Json {
  return {
    settings: { ...settings, max_parallel_members: 3, independent_tests_trigger: "at_end" },
    members: [
      member("lead", "lead", { name: "Lider", effort: "high", instructions: LEAD, ...at(0) }),
      member("ui", "worker", { name: "Arayüz geliştirici", parent_id: "lead", effort: "medium", instructions: "Arayüz bileşenlerini, durumları ve erişilebilirliği uygula.", ...at(-220, 180) }),
      member("api", "worker", { name: "API geliştirici", parent_id: "lead", provider: "codex", effort: "medium", instructions: "API uç noktalarını, doğrulamayı ve hata durumlarını uygula.", ...at(220, 180) }),
      member("e2e", "tester", { name: "E2E test ajanı", parent_id: "ui", provider: "codex", effort: "low", test_mode: "dependent", tests_member_id: "ui", instructions: "Arayüz değişikliklerini kullanıcı akışları üzerinden uçtan uca test et.", ...at(-220, 360) }),
      member("qa", "tester", { name: "Kalite kontrol", parent_id: "lead", provider: "codex", effort: "low", test_mode: "independent", instructions: "Birleştirilmiş çalışmayı bütün olarak test et; arayüz ile API uyumuna dikkat et.", ...at(440) }),
    ],
  };
}

function hizliSpec(): Json {
  return {
    settings: { ...settings, max_parallel_members: 2, test_max_rounds: 2 },
    members: [
      member("lead", "lead", { name: "Lider", effort: "high", instructions: LEAD, ...at(0) }),
      member("dev", "worker", { name: "Geliştirici", parent_id: "lead", provider: "codex", effort: "medium", instructions: DEV, ...at(0, 180) }),
      member("test", "tester", { name: "Test ajanı", parent_id: "dev", effort: "low", test_mode: "dependent", tests_member_id: "dev", instructions: "Geliştiricinin her işini çalıştırarak doğrula; hataları önem derecesiyle bildir.", ...at(0, 360) }),
    ],
  };
}

/** Built-ins come without workspace, timestamps or history (version 1, read-only). */
export function builtin(id: string, name: string, description: string, spec: Json): Json {
  return { id, workspace_id: null, name, description, version: 1, builtin: true, spec, created_at: null, updated_at: null };
}

export function builtinTeams(): Json[] {
  return [
    builtin("danismanli-ekip", "Danışmanlı ekip", "Bir danışman lideri yönlendirir; lider işi üç geliştiriciye böler ve sonuçları birleştirir. Danışman her iş bitince rapor alır.", danismanliSpec()),
    builtin("derin-ekip", "Derin ekip", "Lider ve üç geliştirici; her geliştiricinin iki alt ajanı var. Büyük işleri iki seviyede paralel böler.", derinSpec()),
    builtin("arayuz-test-ekibi", "Arayüz ve test ekibi", "Lider, arayüz ve API geliştiricileri. E2E test ajanı arayüzün her işini test eder; kalite kontrol ajanı en sonda bütünü test eder.", arayuzTestSpec()),
    builtin("hizli-ekip", "Hızlı ekip", "Lider ve bir geliştirici; test ajanı geliştiricinin her işini doğrular. Küçük işler için.", hizliSpec()),
  ];
}

/** A saved team (versioned like flows). */
export function team(id: string, name: string, spec: Json, over: Json = {}): Json {
  return { id, workspace_id: "ws_1", name, description: "", version: 1, builtin: false, spec, created_at: iso(-9000), updated_at: iso(-9000), ...over };
}

export interface TeamScenario {
  teams: Json[];
  versions: Record<string, Json[]>;
  created: Json[];
  updated: { id: string; body: Json }[];
  validated: Json[];
  tasks: Json[];
  messages: { path: string; body: Json }[];
  flowsValidated: number;
}

export function teamScenario(): TeamScenario {
  return {
    // GET /engine/teams: built-ins first (engine order), then saved teams newest first.
    teams: [...builtinTeams(), team("team_web", "Ödeme web ekibi", fullstackSpec(), { version: 3, description: "Ödeme sayfaları için özelleştirilmiş tam yığın ekip.", created_at: iso(-5000), updated_at: iso(-90) })],
    versions: {
      // TeamVersionInfo rows, oldest first (as the engine lists them).
      team_web: [
        { version: 1, name: "Web ekibi", created_by: "user", created_at: iso(-5000) },
        { version: 2, name: "Ödeme web ekibi", created_by: "user", created_at: iso(-2000) },
        { version: 3, name: "Ödeme web ekibi", created_by: "user", created_at: iso(-90) },
      ],
    },
    created: [],
    updated: [],
    validated: [],
    tasks: [],
    messages: [],
    flowsValidated: 0,
  };
}

export function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const apiError = (route: Route, status: number, code: string, message: string, details: Json = {}) => json(route, { error: { code, message, details } }, status);

/** Server-side validation stand-in (TeamValidationReport): members without a name are errors. */
function validate(spec: Json): { ok: boolean; errors: Json[]; warnings: Json[] } {
  const members = (spec.members as Json[] | undefined) ?? [];
  const errors = members.filter((m) => !String(m.name ?? "").trim()).map((m) => ({ code: "name_missing", message: "Ajanın bir adı olmalı.", member_id: m.id }));
  return { ok: errors.length === 0, errors, warnings: [] };
}

const BUILTIN_READONLY = "Hazır ekip şablonları değiştirilemez; kendi kopyanızı oluşturun.";

export const PROFILES = [
  { id: "prof_opus", workspace_id: null, name: "Claude Opus · derin", provider: "claude", model: "claude-opus-5-5", effort: "max", role: "writer", instructions: "", color: null, builtin: true },
  { id: "prof_codex", workspace_id: null, name: "Codex · hızlı", provider: "codex", model: "gpt-5.5-codex", effort: "medium", role: "writer", instructions: "", color: null, builtin: true },
];

/** Shared studiod mock + the team API (and the bits of the engine the pages around teams need). */
export async function installTeamApi(page: Page, mutate?: (sc: TeamScenario) => void, extra?: (route: Route, path: string, url: URL) => Promise<boolean> | boolean): Promise<{ api: MockApi; sc: TeamScenario }> {
  const api = await installMockApi(page, (st) => {
    st.approvals = [];
  });
  const sc = teamScenario();
  mutate?.(sc);
  let seq = 0;
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    let m: RegExpExecArray | null;
    if (extra && (await extra(route, path, url))) return;

    if (path === "/engine/teams" && method === "GET") return json(route, sc.teams);
    if (path === "/engine/teams" && method === "POST") {
      const body = req.postDataJSON() as Json;
      const report = validate(body.spec as Json);
      if (!report.ok) return apiError(route, 422, "validation_failed", `Ekip geçersiz: ${String(report.errors[0]!.message)}`, { errors: report.errors });
      sc.created.push(body);
      const t = team(`team_new_${++seq}`, String(body.name), body.spec as Json, { workspace_id: body.workspace_id, description: body.description ?? "", updated_at: iso(0), created_at: iso(0) });
      sc.teams.push(t);
      return json(route, t, 201);
    }
    if (path === "/engine/teams/validate" && method === "POST") {
      const body = req.postDataJSON() as Json;
      sc.validated.push(body);
      return json(route, validate(body));
    }
    if ((m = /^\/engine\/teams\/([^/]+)\/versions$/.exec(path))) {
      const t = sc.teams.find((x) => x.id === m![1]);
      if (!t) return apiError(route, 404, "not_found", "Ekip bulunamadı.");
      if (t.builtin) return json(route, [{ version: 1, name: t.name, created_by: "builtin", created_at: null }]);
      return json(route, sc.versions[t.id as string] ?? [{ version: 1, name: t.name, created_by: "user", created_at: t.created_at }]);
    }
    if ((m = /^\/engine\/teams\/([^/]+)$/.exec(path))) {
      const t = sc.teams.find((x) => x.id === m![1]);
      if (!t) return apiError(route, 404, "not_found", "Ekip bulunamadı.");
      if ((method === "PUT" || method === "DELETE") && t.builtin) return apiError(route, 409, "conflict", BUILTIN_READONLY);
      if (method === "PUT") {
        const body = req.postDataJSON() as Json;
        const report = body.spec ? validate(body.spec as Json) : { ok: true, errors: [] };
        if (!report.ok) return apiError(route, 422, "validation_failed", `Ekip geçersiz: ${String(report.errors[0]!.message)}`, { errors: report.errors });
        sc.updated.push({ id: t.id as string, body });
        Object.assign(t, body, { version: (t.version as number) + 1, updated_at: iso(0) });
        return json(route, t);
      }
      if (method === "DELETE") {
        sc.teams = sc.teams.filter((x) => x !== t);
        return route.fulfill({ status: 204 });
      }
      const v = Number(url.searchParams.get("version"));
      if (v && t.builtin && v !== 1) return apiError(route, 404, "not_found", "Ekibin bu sürümü bulunamadı.");
      if (v && v !== t.version) return json(route, { ...t, version: v, name: v === 1 ? "Web ekibi" : t.name, spec: { ...(t.spec as Json), members: ((t.spec as Json).members as Json[]).slice(0, 4) } });
      return json(route, t);
    }
    if ((m = /^\/engine\/runs\/([^/]+)\/team\/members\/([^/]+)\/message$/.exec(path))) {
      const body = req.postDataJSON() as Json;
      sc.messages.push({ path, body });
      // MemberMessageResult: a steer goes into the running turn, a message rides the next one.
      return json(route, { member_id: m[2], session_id: null, delivered: body.mode === "steer" ? "steer" : "queued" });
    }
    if (path === "/engine/tasks" && method === "POST") {
      const body = req.postDataJSON() as Json;
      sc.tasks.push(body);
      return json(route, { task: { id: "task_new", workspace_id: "ws_1", title: body.title, status: "running", mode: body.mode }, runs: [], current_run: null }, 201);
    }
    if (path === "/engine/flows/validate") {
      sc.flowsValidated += 1;
      return json(route, { ok: true, errors: [], warnings: [] });
    }
    if (path === "/agents/profiles") return json(route, PROFILES);
    return route.fallback();
  });
  return { api, sc };
}
