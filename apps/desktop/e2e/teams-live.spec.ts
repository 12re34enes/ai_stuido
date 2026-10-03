/**
 * Live team view: a team-mode task's page (team view as the main canvas tab) and the full page
 * /teams/live/:runId, with a scripted run pushed over the mocked event socket — delegation,
 * results, reports/advice, a merge conflict, test verdicts and context usage.
 */
import { expect, test, type Page } from "@playwright/test";

import { NOW, settle, type MockApi } from "./mock";
import { fullstackSpec, installTeamApi, iso, json, type Json, type TeamScenario } from "./teams-mock";

const shot = (name: string) => `test-results/screens/${name}.png`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED|status of 404|status of 500/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

// ----------------------------------------------------------------------------- fixtures

const RUN = "run_t1";
const TASK = "task_t1";

const graph = {
  nodes: [
    { id: "team", label: "Ekip", config: { kind: "team", team_id: "team_web", team: null, prompt_template: "{{ input.prompt }}", repo_ids: null } },
    { id: "build", label: "Build/test kanıtı", config: { kind: "gate", gate: "build_test" } },
    { id: "final", label: "Son onay", config: { kind: "gate", gate: "user_final" } },
  ],
  edges: [
    { id: "e_team_build", source: "team", target: "build", condition: "default" },
    { id: "e_build_final", source: "build", target: "final", condition: "default" },
    { id: "e_build_team_failed", source: "build", target: "team", condition: "failed" },
  ],
};

const CONTRACT_KEYS = ["id", "run_id", "node_id", "from_member", "to_member", "title", "instructions", "depends_on", "status", "round", "session_id", "worktree_id", "result_summary", "error", "merge", "created_at", "started_at", "finished_at"];

let seq = 0;

/** An engine `TeamAssignment`: the contract fields plus seq/kind/parent_id/target_id/phase/tests/delivered. */
function assignment(id: string, from: string, to: string, title: string, status: string, start: number | null, end: number | null, over: Json = {}): Json {
  return {
    id,
    run_id: RUN,
    node_id: "team",
    from_member: from,
    to_member: to,
    title,
    instructions: "",
    depends_on: [],
    status,
    round: 1,
    session_id: null,
    worktree_id: null,
    result_summary: null,
    error: null,
    merge: null,
    created_at: iso((start ?? -2) - 0.5),
    started_at: start === null ? null : iso(start),
    finished_at: end === null ? null : iso(end),
    seq: ++seq,
    kind: from === "engine" ? "test" : "work",
    parent_id: null,
    target_id: null,
    phase: status === "completed" ? "done" : "work",
    tests: [],
    delivered: status === "completed",
    ...over,
  };
}

/**
 * The payload of `team.assignment.*` (runtime `_assignment_payload`): the contract nested under
 * `assignment`, engine extras on top; finished events add summary / error / merge / tests.
 */
function assignmentEvent(a: Json, names: Record<string, string> = {}): Json {
  const contract = Object.fromEntries(CONTRACT_KEYS.map((k) => [k, a[k] ?? null]));
  const done = a.status === "completed" || a.status === "failed" || a.status === "cancelled";
  return {
    assignment: contract,
    assignment_id: a.id,
    kind: a.kind,
    from_member: a.from_member,
    to_member: a.to_member,
    from_name: names[a.from_member as string] ?? a.from_member,
    to_name: names[a.to_member as string] ?? a.to_member,
    title: a.title,
    depends_on: a.depends_on,
    status: a.status,
    round: a.round,
    parent_id: a.parent_id,
    target_id: a.target_id,
    from_session_id: null,
    to_session_id: a.session_id,
    session_id: a.session_id,
    worktree_id: null,
    ...(done ? { summary: a.result_summary ?? "", error: a.error, merge: a.merge, tests: a.tests } : {}),
  };
}

/** Engine `TeamMemberView`: state + name/role/parent and the live provider/model. */
function memberState(id: string, status: string, session: string | null, current: string | null = null, completed = 0, over: Json = {}): Json {
  const spec = (fullstackSpec().members as Json[]).find((m) => m.id === id)!;
  return { member_id: id, status, session_id: session, worktree_id: null, current_assignment_id: current, completed, failed: 0, name: spec.name, role: spec.role, parent_id: spec.parent_id, provider: spec.provider, model: spec.model, effort: spec.effort, switched_from: null, ...over };
}

const ASSIGNMENTS = {
  ui: assignment("as_ui", "lead", "dev-ui", "Ödeme formu arayüzü", "running", -18, null, { session_id: "ses_ui" }),
  ui1: assignment("as_ui1", "dev-ui", "dev-ui-1", "Kart alanı bileşeni", "completed", -16, -8, { merge: { status: "clean", conflicts: [], commit_sha: "a1b2c3d" }, result_summary: "CardField hazır, testleri yazıldı." }),
  ui2: assignment("as_ui2", "dev-ui", "dev-ui-2", "Ekran okuyucu etiketleri", "running", -7, null, { depends_on: ["as_ui1"], session_id: "ses_ui2" }),
  api: assignment("as_api", "lead", "dev-api", "3D Secure uç noktası", "running", -17, null, { session_id: "ses_api" }),
  data: assignment("as_data", "lead", "dev-data", "Ödeme tablosu indeksleri", "pending", null, null, { depends_on: ["as_api"], created_at: iso(-12) }),
};

/** `GET /engine/runs/{run}/team` (engine `TeamRunDetail`). */
function runView(): Json {
  return {
    run_id: RUN,
    node_id: "team",
    spec: fullstackSpec(),
    members: [
      memberState("advisor", "idle", "ses_adv"),
      memberState("lead", "working", "ses_lead"),
      memberState("dev-ui", "working", "ses_ui", "as_ui"),
      memberState("dev-ui-1", "idle", "ses_ui1", null, 1),
      memberState("dev-ui-2", "working", "ses_ui2", "as_ui2"),
      memberState("dev-api", "working", "ses_api", "as_api"),
      memberState("dev-data", "waiting", null, "as_data"),
      memberState("qa-api", "idle", null),
      memberState("qa-e2e", "idle", null),
    ],
    assignments: Object.values(ASSIGNMENTS),
    team_id: "team_web",
    team_version: 3,
    team_name: "Ödeme web ekibi",
    status: "running",
    summary: null,
    error: null,
    attempt: 1,
    active: true,
  };
}

function session(id: string, provider: string, label: string, model: string, state: string, used: number, window: number, tokens: [number, number]): Json {
  return {
    id,
    workspace_id: "ws_1",
    provider,
    profile_id: null,
    native_id: null,
    location: { kind: "local", host_id: null },
    cwd: "/Users/demo/src/odeme-web",
    worktree_id: null,
    task_id: TASK,
    run_id: RUN,
    node_id: "team",
    label,
    role: "writer",
    model,
    state,
    origin: "created",
    title: null,
    created_at: iso(-19),
    updated_at: iso(-1),
    last_usage: { input_tokens: tokens[0], output_tokens: tokens[1], context_used: used, context_window: window },
    live: true,
  };
}

const SESSIONS = [
  session("ses_lead", "claude", "Lider", "claude-opus-5-5", "thinking", 61_000, 200_000, [84_200, 9_800]),
  session("ses_adv", "claude", "Mimari danışman", "claude-opus-5-5", "idle", 22_000, 200_000, [18_400, 2_100]),
  session("ses_ui", "claude", "Arayüz geliştirici", "claude-sonnet-5", "running_tool", 118_000, 200_000, [142_000, 21_300]),
  session("ses_ui1", "claude", "Bileşenler", "claude-sonnet-5", "done", 74_000, 200_000, [66_100, 12_400]),
  session("ses_ui2", "codex", "Erişilebilirlik", "gpt-5.5-codex", "responding", 41_000, 192_000, [38_900, 4_200]),
  session("ses_api", "codex", "Sunucu geliştirici", "gpt-5.5-codex", "running_tool", 96_000, 192_000, [101_500, 11_900]),
];

const task = {
  id: TASK,
  workspace_id: "ws_1",
  title: "Ödeme formuna 3D Secure ekle",
  prompt: "Kart ödemelerinde 3D Secure doğrulamasını ekle; erişilebilir hata mesajları ve testlerle birlikte.",
  mode: "team",
  flow_id: null,
  studio_id: null,
  repo_ids: ["repo_web"],
  base_ref: "main",
  inputs: {},
  budget: null,
  priority: 0,
  status: "running",
  scheduled_at: null,
  source: "user",
  source_ref: null,
  current_run_id: RUN,
  quality_score: null,
  created_at: iso(-20),
  updated_at: iso(-1),
};

const nodeRun = (id: string, status: string, start: number | null) => ({ id: `nr_${id}`, run_id: RUN, node_id: id, status, attempt: 1, session_ids: [], worktree_ids: [], output: null, data: null, error: null, started_at: start === null ? null : iso(start), finished_at: null });
const run = { id: RUN, task_id: TASK, workspace_id: "ws_1", graph, status: "running", nodes: [nodeRun("team", "running", -19)], started_at: iso(-19), finished_at: null };

async function installLive(page: Page, opts: { viewMissing?: boolean } = {}): Promise<{ api: MockApi; sc: TeamScenario }> {
  return installTeamApi(page, undefined, async (route, path, url) => {
    let m: RegExpExecArray | null;
    if (path === `/engine/runs/${RUN}/team`) {
      if (opts.viewMissing) await json(route, { error: { code: "not_found", message: "Ekip henüz başlamadı." } }, 404);
      else await json(route, runView());
      return true;
    }
    if (path === `/engine/tasks/${TASK}`) {
      await json(route, { task, runs: [{ id: RUN, status: "running", error: null, started_at: iso(-19), finished_at: null }], current_run: run, quality: null, rating: null, rating_note: null, error: null, hold_until: null, hold_reason: null, start_on_reset: false, has_explicit_graph: false });
      return true;
    }
    if (path === `/engine/runs/${RUN}`) {
      await json(route, run);
      return true;
    }
    if ((m = /^\/engine\/runs\/[^/]+\/(gates|evidence|checkpoints)$/.exec(path))) {
      await json(route, []);
      return true;
    }
    if (path === "/agents/sessions" && url.searchParams.get("run_id")) {
      await json(route, SESSIONS);
      return true;
    }
    if ((m = /^\/agents\/sessions\/([^/]+)$/.exec(path))) {
      const sv = SESSIONS.find((x) => x.id === m![1]);
      await json(route, sv ?? {}, sv ? 200 : 404);
      return true;
    }
    if (path === "/events") {
      const sid = url.searchParams.get("session_id");
      const ev = (id: number, type: string, payload: Json) => ({ id, ts: iso(-3 + id / 100), type, severity: "info", actor: "system", workspace_id: "ws_1", task_id: TASK, run_id: RUN, session_id: sid, payload, ephemeral: false });
      await json(route, { events: [ev(1, "agent.message", { message_id: "m1", role: "assistant", text: "3D Secure yönlendirmesini ekliyorum; önce mevcut ödeme akışını okudum." }), ev(2, "agent.tool.call", { call_id: "c1", tool: "Bash", kind: "command", summary: "pnpm test api" })], has_more: false });
      return true;
    }
    if (path === "/gitops/worktrees" || /^\/workspaces\/[^/]+\/repos$/.test(path)) {
      await json(route, []);
      return true;
    }
    if (/^\/limits\/tasks\/[^/]+$/.test(path)) {
      await json(route, { input_tokens: 451_100, output_tokens: 61_700, duration_ms: 19 * 60_000, turns: 31, five_hour_percent_spent: 12.5, weekly_percent_spent: 3.1, by_provider: {} });
      return true;
    }
    return false;
  });
}

/** Team events as the engine emits them: NodeContext adds node_id / node_run_id / label, the runtime run/task/workspace ids. */
const push = (api: MockApi, type: string, payload: Json, session?: string) =>
  api.push(type, { node_id: "team", node_run_id: "nr_team", label: "Ekip", run_id: RUN, task_id: TASK, workspace_id: "ws_1", ...payload }, { task_id: TASK, run_id: RUN, session_id: session ?? null });

const NAMES = Object.fromEntries((fullstackSpec().members as Json[]).map((m) => [m.id as string, m.name as string]));

const memberEvent = (id: string, status: string, session: string | null, assignmentId: string | null, over: Json = {}): Json => {
  const m = (fullstackSpec().members as Json[]).find((x) => x.id === id)!;
  return { member_id: id, member_name: m.name, role: m.role, status, session_id: session, assignment_id: assignmentId, provider: m.provider, model: m.model, effort: m.effort, worktree_id: null, ...over };
};

const member = (page: Page, id: string) => page.getByTestId(`live-member-${id}`);

/** The scripted part of the run: work flowing back, a merge conflict, a tester run failing then passing, a report. */
async function script(page: Page, api: MockApi) {
  push(api, "agent.usage", { input_tokens: 128_400, output_tokens: 14_100, context_used: 151_000, context_window: 192_000 }, "ses_api");

  // dev-ui-2 finishes: merge into dev-ui (conflict), the assignment completes, the result is handed up.
  const ui2 = { ...ASSIGNMENTS.ui2, status: "completed", finished_at: NOW.toISOString(), result_summary: "Etiketler eklendi; axe denetimi temiz.", phase: "done", merge: { status: "conflict", conflicts: ["apps/web/src/payment/CardField.tsx", "apps/web/src/payment/strings.ts"], commit_sha: null } };
  push(api, "team.merge", { assignment_id: "as_ui2", from_member: "dev-ui-2", to_member: "dev-ui", status: "conflict", conflicts: (ui2.merge as Json).conflicts, commit_sha: null, message: null, from_session_id: "ses_ui2", to_session_id: "ses_ui" }, "ses_ui2");
  push(api, "team.member", memberEvent("dev-ui-2", "idle", "ses_ui2", null), "ses_ui2");
  push(api, "team.assignment.completed", assignmentEvent(ui2, NAMES), "ses_ui2");
  push(api, "agent.handoff", { from: NAMES["dev-ui-2"], to: NAMES["dev-ui"], reason: ASSIGNMENTS.ui2.title, summary: ui2.result_summary, kind: "result", from_member: "dev-ui-2", to_member: "dev-ui", assignment_id: "as_ui2", from_node_id: "team", agent_label: NAMES["dev-ui-2"], provider: "codex" }, "ses_ui2");
  await settle(page, 250);

  // The API work is tested by its dependent tester (engine → qa-api): round 1 fails, round 2 passes.
  const qa1 = assignment("as_qa1", "engine", "qa-api", "Test: 3D Secure uç noktası", "pending", null, null, { created_at: NOW.toISOString(), target_id: "as_api" });
  push(api, "team.assignment.created", assignmentEvent(qa1, NAMES));
  push(api, "team.assignment.started", assignmentEvent({ ...qa1, status: "running", started_at: NOW.toISOString(), session_id: "ses_qa" }, NAMES), "ses_qa");
  push(api, "team.member", memberEvent("qa-api", "testing", "ses_qa", "as_qa1"), "ses_qa");
  const v1 = { tester: "qa-api", member: "dev-api", mode: "dependent", status: "failed", summary: "2 test kaldı: imza doğrulaması", round: 1, test_assignment_id: "as_qa1" };
  push(api, "team.assignment.failed", assignmentEvent({ ...qa1, status: "failed", session_id: "ses_qa", finished_at: NOW.toISOString(), result_summary: v1.summary, tests: [v1] }, NAMES), "ses_qa");
  push(api, "team.test", { tester: "qa-api", member: "dev-api", status: "failed", summary: v1.summary, round: 1, mode: "dependent", assignment_id: "as_api", test_assignment_id: "as_qa1", findings_count: 2, blocking_count: 1, tester_session_id: "ses_qa" }, "ses_qa");
  await settle(page, 250);
  const qa2 = assignment("as_qa2", "engine", "qa-api", "Test: 3D Secure uç noktası", "completed", 0, 0, { round: 2, target_id: "as_api", session_id: "ses_qa" });
  const v2 = { ...v1, status: "passed", summary: "Tüm API testleri geçti", round: 2, test_assignment_id: "as_qa2" };
  push(api, "team.assignment.created", assignmentEvent({ ...qa2, status: "pending" }, NAMES));
  push(api, "team.assignment.completed", assignmentEvent({ ...qa2, result_summary: v2.summary, tests: [v2] }, NAMES), "ses_qa");
  push(api, "team.test", { tester: "qa-api", member: "dev-api", status: "passed", summary: v2.summary, round: 2, mode: "dependent", assignment_id: "as_api", test_assignment_id: "as_qa2", findings_count: 0, blocking_count: 0, tester_session_id: "ses_qa" }, "ses_qa");
  push(api, "team.member", memberEvent("qa-api", "idle", "ses_qa", null), "ses_qa");

  // dev-data had no session yet and Claude is out of limits: the engine switches it to Codex.
  push(api, "node.provider_switched", { from: "claude", to: "codex", reason: "Claude 5 saatlik limiti doldu", purpose: NAMES["dev-data"], member_id: "dev-data" });

  push(api, "team.report", { from_member: "lead", advisor: "advisor", summary: "Arayüz ve sunucu paralel ilerliyor; veri işi API'yi bekliyor.", kind: "member", from_session_id: "ses_lead", advisor_session_id: "ses_adv" }, "ses_lead");
}

// ----------------------------------------------------------------------------- tests

for (const scheme of ["light", "dark"] as const) {
  test(`live team view in the task page (${scheme})`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    const { api } = await installLive(page);
    await page.goto(`/#/tasks/${TASK}`);
    const view = page.getByTestId("team-live-view");
    await expect(view).toBeVisible();
    await expect(page.getByRole("radio", { name: "Canlı ekip" })).toHaveAttribute("aria-checked", "true");
    await expect(member(page, "dev-ui")).toContainText("Ödeme formu arayüzü");
    await expect(member(page, "dev-api")).toHaveAttribute("data-status", "working");
    await expect(page.getByTestId("kpi-assignments")).toContainText("1");
    await expect(page.getByTestId("kpi-assignments")).toContainText("5");
    await expect(page.getByTestId("team-live-name")).toContainText("Ödeme web ekibi");
    await expect(page.getByTestId("team-timeline")).toBeVisible();
    await settle(page, 600);

    await script(page, api);
    await expect(page.getByTestId("team-bubble")).toContainText("Arayüz ve sunucu paralel ilerliyor");
    await expect(page.getByTestId("merge-conflict")).toContainText("2");
    await expect(member(page, "qa-api").getByTestId("test-verdict")).toContainText("geçti");
    await expect(member(page, "qa-api").getByTestId("test-verdict")).toContainText("tur 2");
    await expect(page.getByTestId("kpi-tests")).toContainText("1/2");
    await expect(page.getByTestId("kpi-merges")).toContainText("1 çakışma");
    // "İş" counts delegated work only (2 of 5 done); tester runs show as the pass rate.
    await expect(page.getByTestId("kpi-assignments")).toContainText("2");
    await expect(page.getByTestId("kpi-assignments")).toContainText("5");
    await expect(member(page, "dev-ui-2")).toHaveAttribute("data-status", "idle");
    await expect(member(page, "dev-data").getByTestId("provider-switched")).toContainText("Claude");
    await settle(page, 450);
    await page.screenshot({ path: shot(`teams-live-task-${scheme}`), fullPage: true });

    // Advice flows back down; the bubble follows the newest message.
    push(api, "team.advice", { advisor: "advisor", to_member: "lead", text: "Önce 3D Secure akışının hata yollarını kapsayın.", kind: "reply", question: null, advisor_session_id: "ses_adv", to_session_id: "ses_lead", delivered: "steer" }, "ses_adv");
    await expect(page.getByTestId("team-bubble").filter({ hasText: "hata yollarını" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("member detail, live stream and message box", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  const { sc } = await installLive(page);
  await page.goto(`/#/tasks/${TASK}`);
  await expect(page.getByTestId("team-live-view")).toBeVisible();

  // Hover card: full detail with history and context.
  await member(page, "dev-api").locator("div").first().hover();
  const details = page.getByTestId("member-details-dev-api");
  await expect(details).toBeVisible();
  await expect(details).toContainText("İş geçmişi");
  await expect(details).toContainText("3D Secure uç noktası");
  await expect(details).toContainText("%50");
  await settle(page, 500);
  await page.screenshot({ path: shot("teams-live-hover") });

  // Click: the drawer streams the member's session; the quick panel sends / steers.
  await member(page, "dev-api").click();
  await expect(page.getByTestId("member-panel")).toBeVisible();
  await expect(page.getByRole("complementary").filter({ hasText: "Sunucu geliştirici" }).first()).toBeVisible();
  const panel = page.getByTestId("member-panel");
  await panel.getByRole("radio", { name: "Yönlendir" }).click();
  await panel.getByRole("textbox").fill("İmza doğrulamasında sabit zamanlı karşılaştırma kullan.");
  await panel.getByTestId("member-send").click();
  await expect(page.getByText("Sunucu geliştirici çalışan turuna yönlendirildi")).toBeVisible();
  expect(sc.messages).toEqual([{ path: `/engine/runs/${RUN}/team/members/dev-api/message`, body: { text: "İmza doğrulamasında sabit zamanlı karşılaştırma kullan.", mode: "steer", node_id: "team" } }]);
  await settle(page, 500);
  await page.screenshot({ path: shot("teams-live-member") });

  // Timeline: a bar focuses its member.
  await page.getByTestId("timeline-bar-as_ui1").click();
  await expect(page.getByTestId("member-panel")).toContainText("Bileşenler");
  expect(errors).toEqual([]);
});

test("flow tab, full page and a team that hasn't started", async ({ page }) => {
  const errors = collectErrors(page);
  await installLive(page);
  await page.goto(`/#/tasks/${TASK}`);
  await expect(page.getByTestId("team-live-view")).toBeVisible();
  await page.getByRole("radio", { name: "Akış" }).click();
  await expect(page.getByRole("group", { name: "Akış ilerlemesi" })).toBeVisible();
  await page.getByRole("radio", { name: "Canlı ekip" }).click();
  await page.getByRole("button", { name: "Tam sayfada aç" }).click();
  await expect(page).toHaveURL(new RegExp(`#/teams/live/${RUN}\\?node=team$`));
  await expect(page.getByTestId("team-live-page")).toBeVisible();
  await expect(member(page, "lead")).toBeVisible();
  await settle(page, 900);
  await page.screenshot({ path: shot("teams-live-page") });
  await page.getByRole("button", { name: "Görevi aç" }).click();
  await expect(page).toHaveURL(new RegExp(`#/tasks/${TASK}$`));
  expect(errors).toEqual([]);
});

test("live view before the team starts, then it comes alive and finishes", async ({ page }) => {
  const errors = collectErrors(page);
  const { api } = await installLive(page, { viewMissing: true });
  await page.goto(`/#/teams/live/${RUN}`);
  await expect(page.getByTestId("team-live-empty")).toContainText("Ekip henüz başlamadı");

  // team.started carries the members: the chart renders from the event alone.
  const spec = fullstackSpec();
  push(api, "team.started", {
    team_id: "team_web",
    team_name: "Ödeme web ekibi",
    attempt: 1,
    resumed: false,
    members: (spec.members as Json[]).map((m) => ({ id: m.id, name: m.name, role: m.role, parent_id: m.parent_id, provider: m.provider, model: m.model, effort: m.effort, writes: m.writes, test_mode: m.role === "tester" ? m.test_mode : null, tests_member_id: m.tests_member_id })),
    settings: spec.settings,
  }, "ses_lead");
  await expect(page.getByTestId("team-live-view")).toBeVisible();
  await expect(member(page, "lead")).toBeVisible();
  await expect(member(page, "qa-e2e")).toBeVisible();

  // The lead waits for Claude's limit window (node-level event: no member_id), then works.
  push(api, "run.limit_wait", { provider: "claude", purpose: "Ekip · Lider", reason: "Claude 5 saatlik limiti doldu", resets_at: new Date(NOW.getTime() + 40 * 60_000).toISOString() });
  await expect(member(page, "lead")).toContainText("Limit bekleniyor");
  push(api, "team.member", memberEvent("lead", "working", "ses_lead", null), "ses_lead");
  await expect(member(page, "lead")).toHaveAttribute("data-status", "working");
  await expect(member(page, "lead")).not.toContainText("Limit bekleniyor");

  // The run fails: the banner says so with the engine's reason.
  push(api, "team.finished", { status: "failed", summary: null, error: "Lider görevi tamamlayamadı.", assignments: { total: 0, completed: 0, failed: 0, cancelled: 0 }, test_rounds: 0, test_failures: 0, merge_conflicts: 0 }, "ses_lead");
  await expect(page.getByTestId("team-finished")).toContainText("Ekip başarısız oldu");
  await expect(page.getByTestId("team-finished")).toContainText("Lider görevi tamamlayamadı.");
  expect(errors).toEqual([]);
});
