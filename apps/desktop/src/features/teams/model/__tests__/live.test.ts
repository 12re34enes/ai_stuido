import { describe, expect, it } from "vitest";

import type { StudioEvent } from "@/lib/events";

import type { TeamMemberState, TeamRunView } from "../../types";
import { applySessions, initialLiveState, memberAssignments, memberDot, prunePulses, PULSE_TTL, reduceTeamEvent, seedFromView, teamKpis, tokenShare, type TeamLiveState } from "../live";
import { parseAssignment, parseRunView, parseTeamEvent, parseTeams, parseVersions, type TeamEvent } from "../wire";
import { exampleSpec } from "./fixtures";

const T0 = Date.parse("2026-10-03T08:00:00Z");
const ISO = new Date(T0).toISOString();

function ev(type: string, payload: Record<string, unknown>, extra: Partial<StudioEvent> = {}): StudioEvent {
  return { id: 1, ts: ISO, type, severity: "info", actor: "system", workspace_id: "ws", task_id: "t", run_id: "run_1", session_id: null, payload, ephemeral: false, ...extra };
}

/** `_assignment_payload` of the engine: the contract nested under `assignment`, extras on top. */
function asg(a: { id: string; from_member: string; to_member: string; title?: string; status?: string; kind?: "work" | "test" | "check"; target_id?: string | null; [k: string]: unknown }, top: Record<string, unknown> = {}) {
  const { kind = "work", target_id = null, ...contract } = a;
  const nested = { run_id: "run_1", node_id: "team", title: a.id, instructions: "", depends_on: [], status: "pending", round: 1, session_id: null, worktree_id: null, result_summary: null, error: null, merge: null, created_at: ISO, started_at: null, finished_at: null, ...contract };
  return {
    node_id: "team",
    assignment: nested,
    assignment_id: a.id,
    kind,
    from_member: a.from_member,
    to_member: a.to_member,
    title: nested.title,
    depends_on: nested.depends_on,
    status: nested.status,
    round: nested.round,
    parent_id: null,
    target_id,
    session_id: nested.session_id,
    worktree_id: null,
    ...top,
  };
}

function member(id: string, over: Partial<TeamMemberState> = {}): TeamMemberState {
  return { member_id: id, status: "idle", session_id: null, worktree_id: null, current_assignment_id: null, completed: 0, failed: 0, provider: null, model: null, effort: null, switched_from: null, ...over };
}

function view(over: Partial<TeamRunView> = {}): TeamRunView {
  return {
    run_id: "run_1",
    node_id: "team",
    spec: exampleSpec(),
    members: [member("lead", { status: "working", session_id: "ses_lead" }), member("dev-a")],
    assignments: [],
    team_id: "team_x",
    team_version: 2,
    team_name: "Ödeme ekibi",
    status: "running",
    summary: null,
    error: null,
    attempt: 1,
    active: true,
    ...over,
  };
}

function fold(state: TeamLiveState, events: StudioEvent[], now = T0): TeamLiveState {
  return events.reduce((s, e) => {
    const parsed = parseTeamEvent(e);
    return parsed ? reduceTeamEvent(s, parsed, now) : s;
  }, state);
}

describe("wire parsing", () => {
  it("reads engine assignment payloads (nested contract + top-level extras) and flat rows", () => {
    const nested = parseAssignment(asg({ id: "as_1", from_member: "lead", to_member: "dev-a", title: "Form", depends_on: ["as_0"], status: "running" }, { parent_id: "as_0" }));
    expect(nested).toMatchObject({ id: "as_1", from_member: "lead", to_member: "dev-a", title: "Form", depends_on: ["as_0"], status: "running", kind: "work", parent_id: "as_0", target_id: null });
    const tester = parseAssignment(
      asg({ id: "as_t", from_member: "engine", to_member: "qa-b", status: "failed", kind: "test", target_id: "as_1" }, { summary: "2 test kaldı", tests: [{ tester: "qa-b", member: "dev-b", mode: "dependent", status: "failed", summary: "2 test kaldı", round: 1, test_assignment_id: "as_t" }] }),
    );
    expect(tester).toMatchObject({ kind: "test", target_id: "as_1", tests: [{ tester: "qa-b", status: "failed", test_assignment_id: "as_t" }] });
    const flat = parseAssignment({ assignment_id: "as_2", from: "dev-a", to: "dev-a-1", title: "Alan", seq: 4, phase: "merge", delivered: true });
    expect(flat).toMatchObject({ id: "as_2", from_member: "dev-a", to_member: "dev-a-1", seq: 4, phase: "merge", delivered: true });
    expect(parseAssignment({ title: "no id" })).toBeNull();
  });

  it("normalizes team events with aliases and implied statuses", () => {
    const created = parseTeamEvent(ev("team.assignment.created", { assignment: { id: "as_1", from_member: "lead", to_member: "dev-a", title: "Form" } }));
    expect(created).toMatchObject({ type: "assignment", phase: "created", assignment: { status: "pending", created_at: ISO } });
    expect(parseTeamEvent(ev("team.member", { member: "dev-a", state: "running", session_id: "s1", provider: "codex", model: "gpt-5.5" }))).toMatchObject({ type: "member", memberId: "dev-a", status: "working", sessionId: "s1", provider: "codex", model: "gpt-5.5" });
    expect(parseTeamEvent(ev("team.test", { tester: "qa-b", member: "dev-b", verdict: "pass", round: 2 }))).toMatchObject({ type: "test", status: "passed", round: 2 });
    expect(parseTeamEvent(ev("team.test", { tester: "qa-b", member: "dev-b", status: "error", mode: "dependent", test_assignment_id: "as_t" }))).toMatchObject({ status: "error", mode: "dependent", testAssignmentId: "as_t" });
    expect(parseTeamEvent(ev("team.merge", { from_member: "dev-a", to_member: "lead", conflicts: ["a.ts", "b.ts"], commit_sha: "abc" }))).toMatchObject({ type: "merge", status: "conflict", conflicts: ["a.ts", "b.ts"], commitSha: "abc" });
    expect(parseTeamEvent(ev("team.finished", { status: "cancelled", summary: null, error: "Ekip iptal edildi.", assignments: { total: 3 } }))).toMatchObject({ type: "finished", status: "cancelled", error: "Ekip iptal edildi." });
    expect(parseTeamEvent(ev("team.message", { member_id: "dev-a", mode: "steer", delivered: "steer", text: "Dur" }))).toMatchObject({ type: "message", memberId: "dev-a", mode: "steer", delivered: "steer" });
    expect(parseTeamEvent(ev("agent.handoff", { from: "Lider", to: "Geliştirici A", kind: "delegate", from_member: "lead", to_member: "dev-a", assignment_id: "as_1" }))).toMatchObject({ kind: "delegate", fromMember: "lead", toMember: "dev-a", assignmentId: "as_1" });
    expect(parseTeamEvent(ev("node.session", { provider: "codex", model: "gpt-5.5", member_id: "dev-b" }, { session_id: "ses_b" }))).toMatchObject({ type: "session", memberId: "dev-b", sessionId: "ses_b" });
    expect(parseTeamEvent(ev("node.session", { provider: "codex" }, { session_id: "ses_x" }))).toBeNull();
    expect(parseTeamEvent(ev("node.provider_switched", { from: "claude", to: "codex", reason: "limit", purpose: "Geliştirici A", member_id: "dev-a" }))).toMatchObject({ type: "providerSwitched", memberId: "dev-a", from: "claude", to: "codex" });
    expect(parseTeamEvent(ev("run.limit_wait", { provider: "claude", purpose: "Lider", reason: "5 saatlik limit", resets_at: "2026-10-03T09:30:00Z", member_id: "lead" }))).toMatchObject({ type: "limitWait", memberId: "lead", resetsAt: "2026-10-03T09:30:00Z" });
    expect(parseTeamEvent(ev("agent.usage", { input_tokens: 5, subagent_id: "sub" }, { session_id: "s" }))).toBeNull();
    expect(parseTeamEvent(ev("node.started", {}))).toBeNull();
  });

  it("seeds a spec from team.started members", () => {
    const started = parseTeamEvent(
      ev("team.started", {
        node_id: "team",
        team_id: "hizli-ekip",
        team_name: "Hızlı ekip",
        attempt: 1,
        resumed: false,
        members: [
          { id: "lead", name: "Lider", role: "lead", parent_id: null, provider: "claude", model: null, effort: "high", writes: true, test_mode: null, tests_member_id: null },
          { id: "dev", name: "Geliştirici", role: "worker", parent_id: "lead", provider: "codex", model: null, effort: "medium", writes: true, test_mode: null, tests_member_id: null },
          { id: "test", name: "Test ajanı", role: "tester", parent_id: "dev", provider: "claude", model: null, effort: "low", writes: false, test_mode: "dependent", tests_member_id: "dev" },
        ],
        settings: { max_parallel_members: 2 },
      }),
    );
    expect(started).toMatchObject({ type: "started", teamName: "Hızlı ekip" });
    const s = reduceTeamEvent(initialLiveState("run_1"), started!, T0);
    expect(s.spec?.members.map((m) => m.id)).toEqual(["lead", "dev", "test"]);
    expect(s.spec?.settings.max_parallel_members).toBe(2);
    expect(s.edges.map((e) => e.id)).toContain("t:dev>test");
    expect(s.teamName).toBe("Hızlı ekip");
  });

  it("parses REST lists, versions and the run view (TeamRunDetail) defensively", () => {
    expect(parseTeams({ items: [{ id: "t1", name: "Ekip", spec: { members: [{ id: "lead", role: "lead" }] } }, { name: "no id" }] }).map((t) => t.id)).toEqual(["t1"]);
    expect(parseVersions([{ version: 1, name: "A", created_by: "user", created_at: null }, { version: 2, name: "B", created_by: "user" }]).map((v) => [v.version, v.created_by])).toEqual([
      [2, "user"],
      [1, "user"],
    ]);
    const v = parseRunView(
      {
        node_id: "team",
        spec: exampleSpec(),
        members: [{ member_id: "lead", status: "running", name: "Lider", role: "lead", provider: "codex", switched_from: "claude" }],
        assignments: [{ id: "as_1", to_member: "dev-a", seq: 3, kind: "work", tests: [] }],
        team_id: "danismanli-ekip",
        team_version: 1,
        team_name: "Danışmanlı ekip",
        status: "failed",
        error: "Lider başarısız",
        attempt: 2,
        active: false,
      },
      "run_1",
    )!;
    expect(v.members[0]).toMatchObject({ status: "working", provider: "codex", switched_from: "claude" });
    expect(v.assignments[0]).toMatchObject({ id: "as_1", run_id: "run_1", status: "pending", depends_on: [], seq: 3, kind: "work" });
    expect(v).toMatchObject({ team_name: "Danışmanlı ekip", status: "failed", error: "Lider başarısız", attempt: 2, active: false });
    expect(parseRunView({ members: [] }, "run_1")).toBeNull();
  });
});

describe("live reducer", () => {
  const seeded = () => seedFromView(initialLiveState("run_1"), view(), T0);

  it("seeds members, session map, edges and the team name from the view", () => {
    const s = seeded();
    expect(s.nodeId).toBe("team");
    expect(s.teamName).toBe("Ödeme ekibi");
    expect(s.members.lead!.status).toBe("working");
    expect(s.sessionToMember.ses_lead).toBe("lead");
    expect(Object.keys(s.members)).toHaveLength(13);
    expect(s.edges.length).toBeGreaterThan(10);
    expect(s.finished).toBeNull();
  });

  it("seeds verdicts (deduped) and the outcome of a finished run", () => {
    const verdict = { tester: "qa-b", member: "dev-b", mode: "dependent" as const, status: "failed" as const, summary: "2 test kaldı", round: 1, test_assignment_id: "as_t1" };
    const passed = { ...verdict, status: "passed" as const, summary: "Geçti", round: 2, test_assignment_id: "as_t2" };
    const base = { run_id: "run_1", node_id: "team", instructions: "", depends_on: [], round: 1, session_id: null, worktree_id: null, result_summary: null, error: null, merge: null, created_at: ISO, started_at: ISO, parent_id: null, phase: "done" as const, delivered: true };
    const s = seedFromView(
      initialLiveState("run_1"),
      view({
        status: "completed",
        summary: "Ödeme akışı bitti",
        assignments: [
          { ...base, id: "as_w", seq: 1, kind: "work", from_member: "lead", to_member: "dev-b", title: "API", status: "completed", round: 2, finished_at: "2026-10-03T08:10:00Z", target_id: null, tests: [verdict, passed], merge: { status: "clean", conflicts: [], commit_sha: null } },
          { ...base, id: "as_t1", seq: 2, kind: "test", from_member: "engine", to_member: "qa-b", title: "Test", status: "failed", finished_at: "2026-10-03T08:05:00Z", target_id: "as_w", tests: [verdict] },
          { ...base, id: "as_t2", seq: 3, kind: "test", from_member: "engine", to_member: "qa-b", title: "Test", status: "completed", finished_at: "2026-10-03T08:09:00Z", target_id: "as_w", tests: [passed] },
        ],
      }),
      T0,
    );
    expect(s.testHistory.map((v) => v.key)).toEqual(["as_t1", "as_t2"]);
    expect(s.tests["qa-b"]).toMatchObject({ status: "passed", round: 2 });
    expect(s.finished).toMatchObject({ status: "completed", summary: "Ödeme akışı bitti" });
    expect(s.order).toEqual(["as_w", "as_t1", "as_t2"]);
    // "İş" counts work only; tester runs feed the pass rate.
    expect(teamKpis(s)).toMatchObject({ done: 1, total: 1, testsPassed: 1, testsRun: 2, merges: 1 });
  });

  it("delegation sends a baton down, completion sends a green result up", () => {
    let s = fold(seeded(), [ev("team.assignment.created", asg({ id: "as_1", from_member: "lead", to_member: "dev-a", title: "Ödeme formu" }))]);
    expect(s.pulses).toHaveLength(1);
    expect(s.pulses[0]).toMatchObject({ kind: "delegate", edgeId: "d:lead>dev-a", from: "lead", to: "dev-a", tone: "accent", text: "Ödeme formu" });
    s = fold(s, [
      ev("agent.handoff", { from: "Lider", to: "Geliştirici A", kind: "delegate", from_member: "lead", to_member: "dev-a", assignment_id: "as_1", summary: "..." }),
      ev("team.assignment.started", asg({ id: "as_1", from_member: "lead", to_member: "dev-a", title: "Ödeme formu", status: "running", session_id: "ses_a" })),
      ev("team.member", { member_id: "dev-a", status: "working", session_id: "ses_a", assignment_id: "as_1" }),
    ]);
    // The hand-off of an assignment doesn't add a second baton.
    expect(s.pulses).toHaveLength(1);
    expect(s.members["dev-a"]).toMatchObject({ status: "working", assignmentId: "as_1", sessionId: "ses_a" });
    expect(s.assignments.as_1!.status).toBe("running");
    s = fold(s, [
      ev("team.assignment.completed", asg({ id: "as_1", from_member: "lead", to_member: "dev-a", title: "Ödeme formu", status: "completed", result_summary: "Form hazır", merge: { status: "clean", conflicts: [], commit_sha: "abc" } }, { summary: "Form hazır", error: null, merge: { status: "clean", conflicts: [], commit_sha: "abc" }, tests: [] })),
    ]);
    expect(s.assignments.as_1).toMatchObject({ status: "completed", title: "Ödeme formu", result_summary: "Form hazır", merge: { commit_sha: "abc" } });
    expect(s.members["dev-a"]).toMatchObject({ completed: 1, assignmentId: null });
    expect(s.pulses.at(-1)).toMatchObject({ kind: "result", edgeId: "d:lead>dev-a", from: "dev-a", to: "lead", tone: "success" });
    expect(s.merges["dev-a"]!.status).toBe("clean");
    // Replayed completion is not counted twice.
    s = fold(s, [ev("team.assignment.completed", { assignment: { id: "as_1" } })]);
    expect(s.members["dev-a"]!.completed).toBe(1);
  });

  it("failed work flows back up in red; cancelled work silently", () => {
    let s = fold(seeded(), [
      ev("team.assignment.created", asg({ id: "as_9", from_member: "dev-b", to_member: "dev-b-1", title: "API" })),
      ev("team.assignment.failed", asg({ id: "as_9", from_member: "dev-b", to_member: "dev-b-1", title: "API", status: "failed", error: "Testler kırık" }, { error: "Testler kırık" })),
    ]);
    expect(s.pulses.at(-1)).toMatchObject({ kind: "result", tone: "danger", from: "dev-b-1", to: "dev-b", text: "Testler kırık" });
    expect(s.members["dev-b-1"]!.failed).toBe(1);
    const before = s.pulses.length;
    s = fold(s, [
      ev("team.assignment.created", asg({ id: "as_10", from_member: "dev-b", to_member: "dev-b-2" })),
      ev("team.assignment.failed", asg({ id: "as_10", from_member: "dev-b", to_member: "dev-b-2", status: "cancelled", error: "Ekip iptal edildi." })),
    ]);
    expect(s.pulses.length).toBe(before + 1);
    expect(s.members["dev-b-2"]!.failed).toBe(0);
  });

  it("tester runs come from the engine along the tester's link; verdicts animate once", () => {
    let s = fold(seeded(), [ev("team.assignment.created", asg({ id: "as_t", from_member: "engine", to_member: "qa-b", title: "Test: API", kind: "test", target_id: "as_1" }))]);
    expect(s.pulses.at(-1)).toMatchObject({ kind: "delegate", edgeId: "t:dev-b>qa-b", from: "dev-b", to: "qa-b" });
    s = fold(s, [ev("team.assignment.started", asg({ id: "as_t", from_member: "engine", to_member: "qa-b", status: "running", kind: "test" }))]);
    expect(s.members["qa-b"]!.status).toBe("testing");
    const verdict = { tester: "qa-b", member: "dev-b", mode: "dependent", status: "failed", summary: "2 test kaldı", round: 1, test_assignment_id: "as_t" };
    const pulses = s.pulses.length;
    s = fold(s, [ev("team.assignment.failed", asg({ id: "as_t", from_member: "engine", to_member: "qa-b", status: "failed", kind: "test" }, { tests: [verdict] }))]);
    // No result baton for a tester run; the verdict is recorded already.
    expect(s.pulses.length).toBe(pulses);
    expect(s.tests["qa-b"]).toMatchObject({ status: "failed", key: "as_t" });
    expect(s.members["qa-b"]!.failed).toBe(0);
    s = fold(s, [ev("team.test", { tester: "qa-b", member: "dev-b", status: "failed", summary: "2 test kaldı", round: 1, mode: "dependent", test_assignment_id: "as_t" })]);
    expect(s.testHistory).toHaveLength(1);
    expect(s.pulses.at(-1)).toMatchObject({ kind: "test", edgeId: "t:dev-b>qa-b", tone: "danger" });
    expect(teamKpis(s)).toMatchObject({ total: 0, testsRun: 1, testsPassed: 0 });
  });

  it("reports and advice pulse the advisor link with the text", () => {
    const s = fold(seeded(), [
      ev("team.report", { from_member: "lead", advisor: "advisor", summary: "2/3 iş bitti", kind: "assignment" }),
      ev("team.advice", { advisor: "advisor", to_member: "lead", text: "Önce testleri sağlamlaştır", kind: "reply", delivered: "steer" }),
    ]);
    expect(s.pulses.map((p) => [p.kind, p.edgeId, p.from])).toEqual([
      ["report", "a:advisor>lead", "lead"],
      ["advice", "a:advisor>lead", "advisor"],
    ]);
    expect(s.comms.map((c) => c.text)).toEqual(["2/3 iş bitti", "Önce testleri sağlamlaştır"]);
  });

  it("merge conflicts and test verdicts feed the KPIs", () => {
    let s = fold(seeded(), [
      ev("team.merge", { from_member: "dev-a", to_member: "lead", status: "conflict", conflicts: ["src/form.ts"] }),
      ev("team.merge", { from_member: "dev-c", to_member: "lead", status: "clean", conflicts: [] }),
      ev("team.test", { tester: "qa-b", member: "dev-b", status: "running", round: 1 }),
    ]);
    expect(s.members["qa-b"]!.status).toBe("testing");
    expect(s.pulses.filter((p) => p.kind === "test")).toHaveLength(0);
    s = fold(s, [ev("team.test", { tester: "qa-b", member: "dev-b", status: "failed", summary: "2 test kaldı", round: 1 }), ev("team.test", { tester: "qa-b", member: "dev-b", status: "passed", summary: "Hepsi geçti", round: 2 })]);
    expect(s.tests["qa-b"]).toMatchObject({ status: "passed", round: 2 });
    expect(s.pulses.at(-1)).toMatchObject({ kind: "test", edgeId: "t:dev-b>qa-b", tone: "success" });
    const k = teamKpis(s);
    expect(k).toMatchObject({ testsPassed: 1, testsRun: 2, merges: 2, conflicts: 1 });
    expect(s.merges["dev-a"]!.conflicts).toEqual(["src/form.ts"]);
  });

  it("user messages flash the member; the outcome lands on team.finished", () => {
    let s = fold(seeded(), [ev("team.message", { member_id: "dev-a", mode: "send", delivered: "queued", text: "Kenar durumları unutma" })]);
    expect(s.pulses.at(-1)).toMatchObject({ kind: "message", to: "dev-a", edgeId: null });
    expect(s.comms.at(-1)).toMatchObject({ kind: "message", to: "dev-a" });
    s = fold(s, [ev("team.finished", { status: "failed", summary: null, error: "Lider başarısız oldu" })]);
    expect(s.finished).toMatchObject({ status: "failed", error: "Lider başarısız oldu" });
  });

  it("tracks sessions, provider switches and limit waits per member", () => {
    let s = fold(seeded(), [
      ev("node.session", { node_id: "team", provider: "codex", model: "gpt-5.5", role: "writer", member_id: "dev-a" }, { session_id: "ses_a" }),
      ev("node.provider_switched", { node_id: "team", from: "claude", to: "codex", reason: "Claude limiti doldu", purpose: "Geliştirici C", member_id: "dev-c" }),
      ev("run.limit_wait", { node_id: "team", provider: "claude", purpose: "Lider", reason: "5 saatlik limit", resets_at: "2026-10-03T09:30:00Z" }),
    ]);
    expect(s.sessionToMember.ses_a).toBe("dev-a");
    expect(s.members["dev-a"]).toMatchObject({ sessionId: "ses_a", provider: "codex", model: "gpt-5.5" });
    expect(s.members["dev-c"]).toMatchObject({ provider: "codex", switchedFrom: "claude" });
    // Without member_id the node-level wait is the lead's.
    expect(s.members.lead!.limitWait).toMatchObject({ provider: "claude", resetsAt: "2026-10-03T09:30:00Z" });
    expect(memberDot(s.members.lead)).toBe("waiting");
    s = fold(s, [ev("team.member", { member_id: "lead", status: "working" })]);
    expect(s.members.lead!.limitWait).toBeNull();
  });

  it("maps agent status / usage / lines through the member's session", () => {
    const s = fold(seeded(), [
      ev("agent.status", { state: "waiting_permission" }, { session_id: "ses_lead" }),
      ev("agent.usage", { input_tokens: 1200, output_tokens: 300, context_used: 50_000, context_window: 200_000 }, { session_id: "ses_lead" }),
      ev("agent.tool.call", { tool: "Bash", summary: "pnpm test" }, { session_id: "ses_lead" }),
      ev("agent.status", { state: "thinking" }, { session_id: "unknown" }),
    ]);
    expect(s.members.lead).toMatchObject({ agentState: "waiting_permission", lastLine: "pnpm test", usage: { input: 1200, output: 300, contextUsed: 50_000, contextWindow: 200_000 } });
    expect(memberDot(s.members.lead)).toBe("waiting");
    expect(tokenShare(s, "lead")).toBe(100);
  });

  it("ignores events of another team node and bounds pulses", () => {
    let s = seeded();
    const other = parseTeamEvent(ev("team.member", { node_id: "team_2", member_id: "dev-a", status: "working" }))!;
    expect(reduceTeamEvent(s, other, T0)).toBe(s);
    for (let i = 0; i < 20; i++) s = reduceTeamEvent(s, { type: "advice", nodeId: null, advisor: "advisor", to: "lead", text: `${i}`, kind: "reply", question: null } satisfies TeamEvent, T0);
    expect(s.pulses.length).toBeLessThanOrEqual(8);
    expect(prunePulses(s, T0 + 60_000).pulses).toHaveLength(0);
    const fresh = reduceTeamEvent(seeded(), { type: "merge", nodeId: null, from: "dev-a", to: "lead", status: "clean", conflicts: [], assignmentId: null, commitSha: null }, T0);
    expect(prunePulses(fresh, T0 + PULSE_TTL - 10)).toBe(fresh);
  });

  it("fills model and usage from session rows", () => {
    const s = applySessions(seeded(), [
      { id: "ses_lead", provider: "claude", label: null, title: null, role: "writer", model: "claude-opus-5-5", state: "thinking", node_id: "team", last_usage: { input_tokens: 10, output_tokens: 2, context_used: 1000, context_window: 200_000 } },
    ]);
    expect(s.members.lead).toMatchObject({ model: "claude-opus-5-5", agentState: "thinking", usage: { contextUsed: 1000 } });
  });

  it("lists a member's assignments in delegation order", () => {
    const s = fold(seeded(), [
      ev("team.assignment.created", asg({ id: "as_1", from_member: "lead", to_member: "dev-a", title: "1", created_at: "2026-10-03T08:00:00Z" })),
      ev("team.assignment.created", asg({ id: "as_2", from_member: "lead", to_member: "dev-b", title: "2" })),
      ev("team.assignment.created", asg({ id: "as_3", from_member: "lead", to_member: "dev-a", title: "3" })),
    ]);
    expect(memberAssignments(s, "dev-a").map((a) => a.id)).toEqual(["as_1", "as_3"]);
    expect(teamKpis(s)).toMatchObject({ done: 0, total: 3 });
  });
});
