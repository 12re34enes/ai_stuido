import type { StudioEvent } from "@/lib/events";

import { replayDelay } from "../sessions/stream/replay";
import {
  actorKind,
  actorLabel,
  auditDecision,
  auditQuery,
  DEFAULT_AUDIT_FILTERS,
  DEFAULT_EVENT_FILTERS,
  eventQuery,
  kpis,
  matchesClient,
  niceMax,
  orderStats,
  pageReachesWindow,
  summarizeEvent,
  type AgentStat,
} from "./model";

const NOW = Date.parse("2026-10-03T08:00:00Z");
const ev = (type: string, payload: Record<string, unknown> = {}, extra: Partial<StudioEvent> = {}): StudioEvent => ({
  id: 1,
  ts: "2026-10-03T07:30:00Z",
  type,
  severity: "info",
  actor: "system",
  workspace_id: null,
  task_id: null,
  run_id: null,
  session_id: null,
  payload,
  ephemeral: false,
  ...extra,
});

describe("event filters", () => {
  it("builds the server query from presets and ids", () => {
    expect(eventQuery({ ...DEFAULT_EVENT_FILTERS, preset: "remote", id: " ses_1 ", workspaceId: "ws_1" })).toEqual({
      workspace_id: "ws_1",
      types: "remote.*,db.*",
      session_id: "ses_1",
      task_id: undefined,
      run_id: undefined,
    });
    expect(eventQuery({ ...DEFAULT_EVENT_FILTERS, id: "task_142" }).task_id).toBe("task_142");
    expect(eventQuery({ ...DEFAULT_EVENT_FILTERS, id: "run_7" }).run_id).toBe("run_7");
    expect(eventQuery(DEFAULT_EVENT_FILTERS).types).toBeUndefined();
  });

  it("filters severity and the time window on the client", () => {
    const f = { ...DEFAULT_EVENT_FILTERS, range: "1h" as const, severity: "high" as const };
    expect(matchesClient(ev("x", {}, { severity: "high" }), f, NOW)).toBe(true);
    expect(matchesClient(ev("x", {}, { severity: "info" }), f, NOW)).toBe(false);
    expect(matchesClient(ev("x", {}, { severity: "high", ts: "2026-10-03T06:00:00Z" }), f, NOW)).toBe(false);
    expect(pageReachesWindow(ev("x", {}, { ts: "2026-10-03T06:00:00Z" }), f, NOW)).toBe(false);
    expect(pageReachesWindow(undefined, f, NOW)).toBe(true);
  });
});

describe("event summaries", () => {
  it("speaks Turkish for known types and falls back to payload fields", () => {
    expect(summarizeEvent(ev("agent.status", { state: "running_tool" }))).toBe("Araç çalıştırıyor");
    expect(summarizeEvent(ev("agent.tool.call", { tool: "Bash", kind: "command", input: { command: "pnpm lint" } }))).toBe("pnpm lint çalıştırılıyor");
    expect(summarizeEvent(ev("approval.decided", { status: "rejected", note: "Önce test" }))).toBe("reddedildi · Önce test");
    expect(summarizeEvent(ev("task.created", { title: "Limit çubukları" }))).toBe("Limit çubukları");
    expect(summarizeEvent(ev("checkpoint.created", { node_id: "n1", refs: ["a"] }))).toBe("node_id: n1");
  });

  it("labels actors", () => {
    expect(actorKind("agent:ses_1")).toBe("agent");
    expect(actorLabel("channel:telegram")).toBe("Telegram");
    expect(actorLabel("engine")).toBe("Akış motoru");
  });
});

describe("remote audit", () => {
  it("sends filters with an anchored since", () => {
    const q = auditQuery({ ...DEFAULT_AUDIT_FILTERS, kind: "db", denied: true, q: " DROP ", range: "24h" }, NOW);
    expect(q).toEqual({ kind: "db", environment: undefined, klass: undefined, denied: "true", q: "DROP", since: "2026-10-02T08:00:00.000Z" });
    expect(auditQuery({ ...DEFAULT_AUDIT_FILTERS, range: "all" }, NOW).since).toBeUndefined();
  });

  it("explains how a command came to run", () => {
    expect(auditDecision({ denied: true, approval_id: null, approved_by: null, decision: "deny" })).toBe("denied");
    expect(auditDecision({ denied: true, approval_id: "apr_1", approved_by: null, decision: null })).toBe("rejected");
    expect(auditDecision({ denied: false, approval_id: "apr_1", approved_by: "user", decision: null })).toBe("approved");
    expect(auditDecision({ denied: false, approval_id: null, approved_by: null, decision: "allow" })).toBe("auto");
  });
});

describe("agent performance", () => {
  const stat = (over: Partial<AgentStat>): AgentStat => ({
    profile_id: null,
    provider: "claude",
    model: "claude-opus-5-5",
    node_runs: 0,
    passed: 0,
    failed: 0,
    success_rate: null,
    avg_duration_s: null,
    gate_checks: 0,
    gate_first_pass: 0,
    gate_first_pass_rate: null,
    avg_quality: null,
    tasks: 0,
    roles: {},
    ...over,
  });

  it("weights totals by runs, not by averaging rates", () => {
    const stats = [
      stat({ node_runs: 9, passed: 9, failed: 0, avg_duration_s: 100, gate_checks: 10, gate_first_pass: 8, avg_quality: 90, tasks: 3 }),
      stat({ model: "gpt-5.5-codex", provider: "codex", node_runs: 1, passed: 0, failed: 1, avg_duration_s: 200, gate_checks: 0, avg_quality: 50, tasks: 1 }),
    ];
    const k = kpis(stats);
    expect(k.runs).toBe(10);
    expect(k.success).toBeCloseTo(0.9);
    expect(k.durationS).toBeCloseTo(110);
    expect(k.firstPass).toBeCloseTo(0.8);
    expect(k.quality).toBeCloseTo(80);
    expect(orderStats(stats).map((s) => s.model)).toEqual(["claude-opus-5-5", "gpt-5.5-codex"]);
    expect(kpis([])).toEqual({ runs: 0, success: null, durationS: null, firstPass: null, quality: null });
  });

  it("rounds axis maxima to friendly values", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(47)).toBe(50);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(2.2)).toBe(2.5);
  });
});

describe("replay timing", () => {
  it("follows real gaps, scaled by speed and capped", () => {
    const a = ev("x", {}, { ts: "2026-10-03T08:00:00.000Z" });
    const b = ev("x", {}, { ts: "2026-10-03T08:00:00.400Z" });
    const c = ev("x", {}, { ts: "2026-10-03T08:10:00.000Z" });
    expect(replayDelay(a, b, 1)).toBe(400);
    expect(replayDelay(a, b, 4)).toBe(100);
    expect(replayDelay(b, c, 2)).toBe(600);
    expect(replayDelay(undefined, a, 1)).toBe(0);
  });
});
