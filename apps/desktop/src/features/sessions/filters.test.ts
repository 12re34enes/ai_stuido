import type { DiscoveredSession, SessionView } from "./api";
import { DEFAULT_FILTERS, filterSessions, groupByProject, guessHome, hasActiveFilters, sortSessions, splitActive } from "./filters";

const s = (id: string, over: Partial<SessionView> = {}): SessionView =>
  ({
    id,
    workspace_id: "ws_1",
    provider: "claude",
    profile_id: null,
    native_id: null,
    location: { kind: "local", host_id: null },
    cwd: "/Users/demo/src/app",
    worktree_id: null,
    task_id: null,
    run_id: null,
    node_id: null,
    label: id,
    role: "writer",
    model: "claude-opus-5-5",
    state: "idle",
    origin: "created",
    title: null,
    created_at: "2026-10-03T08:00:00Z",
    updated_at: "2026-10-03T08:00:00Z",
    last_usage: null,
    ...over,
  }) as SessionView;

describe("session filters", () => {
  const list = [
    s("a", { state: "done", updated_at: "2026-10-03T09:00:00Z" }),
    s("b", { provider: "codex", state: "running_tool", label: "Ödeme düzeltmesi", updated_at: "2026-10-03T07:00:00Z" }),
    s("c", { state: "idle", live: true, workspace_id: "ws_2", updated_at: "2026-10-03T08:30:00Z" }),
    s("d", { state: "error", updated_at: "2026-10-03T10:00:00Z" }),
  ];

  it("filters by provider, state, workspace and Turkish-insensitive search", () => {
    expect(filterSessions(list, { ...DEFAULT_FILTERS, provider: "codex" }).map((x) => x.id)).toEqual(["b"]);
    expect(filterSessions(list, { ...DEFAULT_FILTERS, state: "active" }).map((x) => x.id)).toEqual(["b", "c"]);
    expect(filterSessions(list, { ...DEFAULT_FILTERS, state: "finished" }).map((x) => x.id)).toEqual(["a", "d"]);
    expect(filterSessions(list, { ...DEFAULT_FILTERS, workspaceId: "ws_2" }).map((x) => x.id)).toEqual(["c"]);
    expect(filterSessions(list, { ...DEFAULT_FILTERS, q: "odeme DUZELT" }).map((x) => x.id)).toEqual(["b"]);
  });

  it("puts active sessions first, then the most recent", () => {
    expect(sortSessions(list).map((x) => x.id)).toEqual(["c", "b", "d", "a"]);
    const { active, recent } = splitActive(list);
    expect(active.map((x) => x.id)).toEqual(["c", "b"]);
    expect(recent.map((x) => x.id)).toEqual(["d", "a"]);
  });

  it("knows when filters are applied", () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, q: " x " })).toBe(true);
  });
});

describe("discovery grouping", () => {
  const d = (native_id: string, cwd: string | null, updated_at: string): DiscoveredSession => ({
    provider: "claude",
    native_id,
    location: { kind: "local", host_id: null },
    cwd,
    title: native_id,
    model: null,
    branch: null,
    message_count: 3,
    created_at: null,
    updated_at,
    file_path: null,
    running: false,
    imported_session_id: null,
  });

  it("groups by project dir, newest group and newest session first", () => {
    const list = [
      d("1", "/Users/demo/src/api", "2026-10-01T10:00:00Z"),
      d("2", "/Users/demo/src/web", "2026-10-03T10:00:00Z"),
      d("3", "/Users/demo/src/api", "2026-10-02T10:00:00Z"),
    ];
    const home = guessHome(list);
    expect(home).toBe("/Users/demo");
    const groups = groupByProject(list, home);
    expect(groups.map((g) => [g.name, g.parent, g.items.map((i) => i.native_id)])).toEqual([
      ["web", "~/src", ["2"]],
      ["api", "~/src", ["3", "1"]],
    ]);
  });
});
