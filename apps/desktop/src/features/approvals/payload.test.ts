import { QueryClient } from "@tanstack/react-query";

import type { StudioEvent } from "@/lib/events";

import { applyApprovalEvents, applyDecided, approvalKeys, type ApprovalRecord } from "./api";
import { blockReason, decisionPayload, initialDraft, isEdited, primaryLabel } from "./draft";
import { filterApprovals, nextAfter, NO_FILTERS, sortPending, splitProduction } from "./filters";
import {
  actorOf,
  approvalEnvironment,
  budgetPayload,
  customPayload,
  deployPayload,
  finalPayload,
  memoryPayload,
  mergePayload,
  questionPayload,
  remotePayload,
  schemaFields,
  toolPayload,
} from "./payload";

const a = (id: string, over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id,
  kind: "plan",
  title: id,
  summary: null,
  payload: {},
  severity: "high",
  production: false,
  status: "pending",
  workspace_id: "ws_1",
  task_id: null,
  run_id: null,
  session_id: null,
  requested_by: "engine",
  decided_by: null,
  decision_note: null,
  channel: null,
  created_at: "2026-10-03T08:00:00Z",
  decided_at: null,
  expires_at: null,
  ...over,
});

describe("payload readers", () => {
  it("remote command: exact command, host, environment and classification", () => {
    const p = remotePayload(
      {
        host_name: "api-prod-1",
        hostname: "10.0.4.12",
        port: 2222,
        environment: "production",
        permission_level: "read",
        command: "systemctl restart api",
        classification: { klass: "write", reasons: ["systemctl restart yazma sayılır"] },
        policy_reason: "Production'da yazma komutu",
      },
      "remote_command",
    );
    expect(p).toMatchObject({
      target: "api-prod-1",
      targetDetail: "10.0.4.12:2222",
      environment: "production",
      command: "systemctl restart api",
      language: "bash",
      klass: "write",
    });
    expect(p.reasons).toEqual(["systemctl restart yazma sayılır"]);
  });

  it("db write reads the query and profile", () => {
    const p = remotePayload(
      {
        profile_name: "orders-db",
        kind: "postgres",
        database: "orders",
        query: "DELETE FROM carts",
        environment: "test",
        classification: { klass: "write", reasons: [] },
      },
      "db_write",
    );
    expect(p).toMatchObject({ target: "orders-db", targetDetail: "postgres · orders", command: "DELETE FROM carts", language: "sql", environment: "test" });
  });

  it("memory, plan-ish and tool permission payloads tolerate missing fields", () => {
    expect(memoryPayload({ path: "facts.md", content: "x", additions: 2, boundary_warnings: ["ağ erişimi açılıyor"] })).toMatchObject({
      path: "facts.md",
      content: "x",
      additions: 2,
      deletions: 0,
      boundaryWarnings: ["ağ erişimi açılıyor"],
    });
    expect(toolPayload({ tool: "Bash", command: "rm -rf dist", paths: ["dist"], provider: "codex" })).toMatchObject({
      tool: "Bash",
      command: "rm -rf dist",
      paths: ["dist"],
      provider: "codex",
    });
    expect(memoryPayload({})).toMatchObject({ path: "", content: "", diff: null });
  });

  it("final and deploy diffstats", () => {
    const final = finalPayload({
      summary: "**Görev:** limit",
      diffstat: [{ repo: "web", branch: "aistudio/t/1", files: [{ path: "a.ts", status: "M", additions: 3, deletions: 1 }], additions: 3, deletions: 1 }],
      gates: [{ label: "Build/test", kind: "build_test", status: "passed", summary: "4 komut geçti", attempt: 1 }],
      evidence: [{ id: "evd_1", title: "pnpm test", kind: "command", source: "gate" }],
    });
    expect(final.diff[0]?.files[0]).toEqual({ path: "a.ts", status: "M", additions: 3, deletions: 1 });
    expect(final.gates[0]).toMatchObject({ label: "Build/test", status: "passed" });
    const engineDeploy = deployPayload({ profiles: [{ name: "web-prod", environment: "production", kind: "ssh" }], summary: "x" });
    expect(engineDeploy).toMatchObject({ profile: "web-prod", environment: "production", kind: "ssh" });
    const serviceDeploy = deployPayload({ profile_name: "web-test", environment: "test", ref: "abc123", health_check: { url: "https://test/health" } });
    expect(serviceDeploy).toMatchObject({ profile: "web-test", environment: "test", ref: "abc123", healthCheck: "https://test/health" });
  });

  it("merge, question, budget", () => {
    const m = mergePayload({
      strategy: "squash",
      conflicts_resolved: true,
      merges: [{ repo: "web", branch: "b", target_ref: "main", files: ["a.ts"], additions: 1, deletions: 0, patch: "@@" }],
    });
    expect(m).toMatchObject({ strategy: "squash", conflictsResolved: true });
    expect(m.merges[0]).toMatchObject({ repo: "web", targetRef: "main", files: ["a.ts"] });
    expect(questionPayload({ question: "Hangi DB?", options: ["Postgres", "SQLite"] }, "t")).toEqual({
      question: "Hangi DB?",
      options: ["Postgres", "SQLite"],
      agentLabel: null,
    });
    expect(budgetPayload({ provider: "claude", exhausted: true, options: ["switch", "wait"] })).toMatchObject({
      provider: "claude",
      exhausted: true,
      options: ["switch", "wait"],
    });
  });

  it("custom human step: JSON schema → form fields; compare candidates", () => {
    const fields = schemaFields({
      type: "object",
      required: ["version"],
      properties: {
        version: { type: "string", title: "Sürüm" },
        notes: { type: "string", format: "textarea" },
        count: { type: "integer" },
        confirm: { type: "boolean" },
        env: { type: "string", enum: ["test", "production"] },
      },
    });
    expect(fields.map((f) => [f.name, f.type, f.required])).toEqual([
      ["version", "string", true],
      ["notes", "text", false],
      ["count", "number", false],
      ["confirm", "boolean", false],
      ["env", "enum", false],
    ]);
    const c = customPayload({
      type: "compare",
      candidates: [{ node_id: "n1", label: "Claude", provider: "claude", files: 2, gates: { build_test: { status: "passed" } } }],
      suggested: "n1",
    });
    expect(c.candidates[0]).toMatchObject({ nodeId: "n1", provider: "claude", files: 2, gates: [{ kind: "build_test", status: "passed" }] });
    expect(c.suggested).toBe("n1");
  });

  it("environment and actor", () => {
    expect(approvalEnvironment({ production: true, payload: { environment: "test" } })).toBe("production");
    expect(approvalEnvironment({ production: false, payload: { environment: "test" } })).toBe("test");
    expect(actorOf("agent:ses_1")).toEqual({ who: "agent", id: "ses_1" });
    expect(actorOf("engine").who).toBe("engine");
  });
});

describe("inbox order and filters", () => {
  const list = [
    a("old-high", { created_at: "2026-10-03T07:00:00Z" }),
    a("new-normal", { severity: "normal", created_at: "2026-10-03T09:00:00Z" }),
    a("prod", { production: true, severity: "critical", kind: "remote_command", workspace_id: "ws_2" }),
    a("new-high", { created_at: "2026-10-03T08:30:00Z" }),
  ];

  it("puts production first, then severity, then newest", () => {
    expect(sortPending(list).map((x) => x.id)).toEqual(["prod", "new-high", "old-high", "new-normal"]);
    expect(splitProduction(sortPending(list)).production.map((x) => x.id)).toEqual(["prod"]);
  });

  it("filters by kind, workspace and severity", () => {
    expect(filterApprovals(list, { ...NO_FILTERS, kind: "remote_command" }).map((x) => x.id)).toEqual(["prod"]);
    expect(filterApprovals(list, { ...NO_FILTERS, workspaceId: "ws_1", severity: "normal" }).map((x) => x.id)).toEqual(["new-normal"]);
  });

  it("keeps the keyboard selection in place when an item leaves", () => {
    const sorted = sortPending(list);
    expect(nextAfter(sorted, "new-high")).toBe("old-high");
    expect(nextAfter(sorted, "new-normal")).toBe("old-high");
    expect(nextAfter([sorted[0]!], "prod")).toBeNull();
  });
});

describe("approval cache patching", () => {
  const ev = (type: string, payload: Record<string, unknown>): StudioEvent => ({
    id: 1,
    ts: "2026-10-03T09:00:00Z",
    type,
    severity: "info",
    actor: "user",
    workspace_id: "ws_1",
    task_id: null,
    run_id: null,
    session_id: null,
    payload,
    ephemeral: false,
  });

  it("moves a decided approval out of pending and into decided", () => {
    const qc = new QueryClient();
    qc.setQueryData(approvalKeys.pending, [a("apr_1"), a("apr_2")]);
    qc.setQueryData(approvalKeys.decided, [] as ApprovalRecord[]);
    applyDecided(qc, a("apr_1", { status: "approved" }));
    expect(qc.getQueryData<ApprovalRecord[]>(approvalKeys.pending)?.map((x) => x.id)).toEqual(["apr_2"]);
    expect(qc.getQueryData<ApprovalRecord[]>(approvalKeys.decided)?.map((x) => x.status)).toEqual(["approved"]);
  });

  it("routes approval.requested / approval.decided events", async () => {
    const qc = new QueryClient();
    qc.setQueryData(approvalKeys.pending, [a("apr_1")]);
    applyApprovalEvents(qc, [ev("approval.decided", { approval_id: "apr_1", status: "rejected", note: "hayır", channel: "telegram" })], () =>
      Promise.reject(new Error("unused")),
    );
    expect(qc.getQueryData<ApprovalRecord[]>(approvalKeys.pending)).toEqual([]);
    expect(qc.getQueryData<ApprovalRecord>(approvalKeys.one("apr_1"))).toMatchObject({ status: "rejected", decision_note: "hayır", channel: "telegram" });

    applyApprovalEvents(qc, [ev("approval.requested", { approval_id: "apr_9" })], (id) => Promise.resolve(a(id, { title: "yeni" })));
    await vi.waitFor(() => expect(qc.getQueryData<ApprovalRecord[]>(approvalKeys.pending)?.map((x) => x.id)).toEqual(["apr_9"]));
  });
});

describe("decision drafts", () => {
  it("plan and memory send edits only", () => {
    const plan = a("p", { kind: "plan", payload: { plan: "1. A" } });
    expect(decisionPayload(plan, initialDraft(plan))).toBeNull();
    expect(decisionPayload(plan, { plan: "1. A\n2. B" })).toEqual({ plan: "1. A\n2. B" });
    expect(isEdited(plan, { plan: "1. A " })).toBe(false);
    const mem = a("m", { kind: "memory", payload: { content: "x" } });
    expect(decisionPayload(mem, { content: "y" })).toEqual({ content: "y" });
  });

  it("question needs an answer; budget and compare pick a default", () => {
    const q = a("q", { kind: "question", payload: { question: "?", options: ["A"] } });
    expect(blockReason(q, initialDraft(q))).toBe("Yanıt gerekli.");
    expect(decisionPayload(q, { answer: " A " })).toEqual({ answer: "A" });
    expect(primaryLabel(q)).toBe("Yanıtla");
    const b = a("b", { kind: "budget", payload: { options: ["switch", "wait"] } });
    expect(decisionPayload(b, initialDraft(b))).toEqual({ action: "switch" });
    const c = a("c", { kind: "custom", payload: { type: "compare", candidates: [{ node_id: "n1" }, { node_id: "n2" }], suggested: "n2" } });
    expect(decisionPayload(c, initialDraft(c))).toEqual({ winner: "n2" });
  });

  it("human step: typed values and required fields", () => {
    const h = a("h", {
      kind: "custom",
      payload: {
        type: "human",
        input_schema: {
          required: ["version"],
          properties: { version: { type: "string", title: "Sürüm" }, count: { type: "integer" }, ok: { type: "boolean" } },
        },
      },
    });
    const d = initialDraft(h);
    expect(blockReason(h, d)).toBe("Sürüm: Bu alan gerekli.");
    expect(decisionPayload(h, { ...d, version: "2.4.0", count: "3", ok: true })).toEqual({ version: "2.4.0", count: 3, ok: true });
    const free = a("f", { kind: "custom", payload: { type: "human" } });
    expect(decisionPayload(free, { text: " tamam " })).toEqual({ text: "tamam" });
  });
});
