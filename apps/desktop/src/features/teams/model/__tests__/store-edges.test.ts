import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

import { reportFromSaveError, sortTeams } from "../../api";
import { createBuilderStore } from "../../builder/store";
import { edgeLiveData, linkState } from "../../live/edges";
import { parseTeamsRoute, teamsPaths } from "../../route";
import { initialLiveState, reduceTeamEvent, seedFromView } from "../live";
import { emptyRunView, exampleSpec } from "./fixtures";

describe("builder store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("adds, moves, removes with undo / redo", () => {
    const store = createBuilderStore({ spec: exampleSpec() });
    const st = () => store.getState();
    const id = st().add("worker", "dev-a")!;
    expect(id).toBe("dev-a-3");
    expect(st().selected).toBe(id);
    expect(st().fresh[id]).toBe(true);
    expect(st().dirty).toBe(true);

    expect(st().move(id, "dev-c")).toBe(true);
    expect(st().spec.members.find((m) => m.id === id)?.parent_id).toBe("dev-c");
    expect(st().move("dev-a", "dev-a-1")).toBe(false);

    st().undo();
    expect(st().spec.members.find((m) => m.id === id)?.parent_id).toBe("dev-a");
    st().redo();
    expect(st().spec.members.find((m) => m.id === id)?.parent_id).toBe("dev-c");

    // A subtree delete asks first; a leaf goes straight away (after its exit animation).
    st().requestDelete("dev-b");
    expect(st().confirmDelete).toBe("dev-b");
    st().remove("dev-b");
    expect(st().exiting["dev-b-1"]).toBe(true);
    vi.advanceTimersByTime(300);
    expect(st().spec.members.some((m) => m.id.startsWith("dev-b"))).toBe(false);
    st().undo();
    expect(st().spec.members.some((m) => m.id === "dev-b-2")).toBe(true);
  });

  it("keeps advisors read-only and efforts on the provider's scale", () => {
    const store = createBuilderStore({ spec: exampleSpec() });
    store.getState().updateMember("advisor", { writes: true });
    expect(store.getState().spec.members.find((m) => m.id === "advisor")?.writes).toBe(false);
    store.getState().updateMember("dev-a", { effort: "max" });
    store.getState().updateMember("dev-a", { provider: "codex" });
    expect(store.getState().spec.members.find((m) => m.id === "dev-a")).toMatchObject({ provider: "codex", effort: "high" });
  });

  it("coalesces typing into one undo step and previews versions read-only", () => {
    const store = createBuilderStore({ spec: exampleSpec() });
    store.getState().updateMember("dev-a", { name: "A" });
    store.getState().updateMember("dev-a", { name: "Ab" });
    store.getState().updateMember("dev-a", { name: "Abc" });
    expect(store.getState().past).toHaveLength(1);
    store.getState().enterPreview(1, { ...exampleSpec(), members: exampleSpec().members.slice(0, 2) }, { name: "Eski", description: "" });
    expect(store.getState().add("worker", "lead")).toBeNull();
    store.getState().exitPreview();
    expect(store.getState().spec.members.find((m) => m.id === "dev-a")?.name).toBe("Abc");
  });
});

describe("live link data", () => {
  const T = Date.parse("2026-10-03T08:00:00Z");
  const seeded = () =>
    seedFromView(initialLiveState("run_1"), emptyRunView(), T);

  it("colors links by the work on them and routes pulses / bubbles / conflicts", () => {
    let s = seeded();
    s = reduceTeamEvent(s, { type: "assignment", nodeId: null, phase: "created", assignment: { id: "a1", from_member: "lead", to_member: "dev-a", title: "Form" } }, T);
    s = reduceTeamEvent(s, { type: "assignment", nodeId: null, phase: "started", assignment: { id: "a1", status: "running" } }, T);
    s = reduceTeamEvent(s, { type: "report", nodeId: null, from: "dev-a", advisor: "advisor", summary: "Yarısı bitti", kind: "member" }, T);
    s = reduceTeamEvent(s, { type: "merge", nodeId: null, from: "dev-c", to: "lead", status: "conflict", conflicts: ["a.ts"], assignmentId: null, commitSha: null }, T);
    const names = new Map(exampleSpec().members.map((m) => [m.id, m.name]));
    const data = edgeLiveData(s, names);
    expect(data.get("d:lead>dev-a")).toMatchObject({ state: "active", pulse: { dir: "forward", tone: "accent" } });
    // dev-a has no direct link to the advisor: the advisor's link carries the bubble.
    expect(data.get("a:advisor>lead")?.bubble).toMatchObject({ kind: "report", text: "Yarısı bitti", from: "Arayüz" });
    expect(data.get("d:lead>dev-c")?.conflicts).toEqual(["a.ts"]);
    expect(linkState(s, s.edges.find((e) => e.id === "t:dev-b>qa-b")!)).toBe("idle");
  });
});

describe("routes", () => {
  it("parses list, builder and live routes", () => {
    expect(parseTeamsRoute("/teams", "")).toEqual({ page: "list" });
    expect(parseTeamsRoute("/teams/new", "?from=tpl_web")).toEqual({ page: "builder", teamId: null, version: null, fromTeamId: "tpl_web" });
    expect(parseTeamsRoute("/teams/team_1/edit", "?version=3")).toEqual({ page: "builder", teamId: "team_1", version: 3, fromTeamId: null });
    expect(parseTeamsRoute("/teams/live/run_9", "?node=team")).toEqual({ page: "live", runId: "run_9", nodeId: "team" });
    expect(teamsPaths.live("run 9", "team")).toBe("/teams/live/run%209?node=team");
  });
});

describe("api helpers", () => {
  it("turns a 422 save refusal into member markers", () => {
    const err = new ApiError(422, "validation_failed", "Ekip geçersiz: Lider yok", {
      errors: [
        { code: "no_lead", message: "Lider yok", member_id: null },
        { code: "parent_missing", message: "Yönetici yok", member_id: "dev-a" },
      ],
    });
    const report = reportFromSaveError(err)!;
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.member_id)).toEqual([null, "dev-a"]);
    expect(reportFromSaveError(new ApiError(409, "conflict", "Hazır ekip şablonları değiştirilemez"))).toBeNull();
    expect(reportFromSaveError(new Error("x"))).toBeNull();
  });

  it("keeps the engine's built-in order, then saved teams newest first", () => {
    const t = (id: string, builtin: boolean, updated_at: string | null = null) => ({ id, builtin, updated_at, name: id, description: "", version: 1, workspace_id: null, created_at: null, spec: exampleSpec() });
    const sorted = sortTeams([t("old", false, "2026-10-01"), t("danismanli-ekip", true), t("new", false, "2026-10-03"), t("hizli-ekip", true)]);
    expect(sorted.map((x) => x.id)).toEqual(["danismanli-ekip", "hizli-ekip", "new", "old"]);
  });
});
