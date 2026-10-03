import { describe, expect, it } from "vitest";

import { pendingForWorkspace } from "@/features/home/approvals";
import { elapsedLabel } from "@/features/home/format";
import type { Approval } from "@/lib/types";

import type { Task } from "../list/types";
import { recentFromCache } from "./commands";
import { repoSummary, shortPath, toggleRepo } from "./pickerLogic";
import type { Repo } from "./types";

const repo = (id: string, name: string): Repo => ({
  id,
  workspace_id: "ws_1",
  name,
  path: `/Users/demo/src/${name}`,
  host_id: null,
  remote_url: null,
  provider: null,
  default_branch: "main",
  commands: {},
  created_at: "2026-10-01T00:00:00Z",
});

const repos = [repo("r1", "api"), repo("r2", "web"), repo("r3", "mobile")];

describe("repo picker", () => {
  it("summarizes the selection", () => {
    expect(repoSummary([], null)).toBe("Repo yok");
    expect(repoSummary([repos[0]!], null)).toBe("api");
    expect(repoSummary(repos, null)).toBe("Tüm repolar");
    expect(repoSummary(repos, ["r2"])).toBe("web");
    expect(repoSummary(repos, ["r1", "r3"])).toBe("2 repo");
  });

  it("toggles repos, collapses to 'all' and keeps at least one", () => {
    expect(toggleRepo(repos, null, "r2")).toEqual(["r1", "r3"]);
    expect(toggleRepo(repos, ["r1", "r3"], "r2")).toBeNull();
    expect(toggleRepo(repos, ["r2"], "r2")).toEqual(["r2"]);
    expect(toggleRepo(repos, ["r3"], "r1")).toEqual(["r1", "r3"]);
  });

  it("shortens home paths", () => {
    expect(shortPath("/Users/demo/src/api")).toBe("~/src/api");
    expect(shortPath("/home/dev/work")).toBe("~/work");
    expect(shortPath("/opt/repo")).toBe("/opt/repo");
  });
});

describe("recent task commands", () => {
  const t = (id: string, ws: string, created: string) => ({ id, workspace_id: ws, created_at: created }) as Task;
  it("merges every cached list, newest first, for the current workspace", () => {
    const lists = [[t("a", "ws_1", "2026-10-03T08:00:00Z"), t("b", "ws_2", "2026-10-03T09:00:00Z")], { pages: [[t("c", "ws_1", "2026-10-03T10:00:00Z"), t("a", "ws_1", "2026-10-03T08:00:00Z")]] }, undefined];
    expect(recentFromCache(lists, "ws_1").map((x) => x.id)).toEqual(["c", "a"]);
    expect(recentFromCache(lists, null, 1).map((x) => x.id)).toEqual(["c"]);
  });
});

describe("home helpers", () => {
  it("formats elapsed time with minute precision", () => {
    expect(elapsedLabel(20_000)).toBe("1 dk");
    expect(elapsedLabel(12 * 60_000 + 40_000)).toBe("12 dk");
    expect(elapsedLabel(75 * 60_000)).toBe("1 sa 15 dk");
  });

  it("orders waiting approvals: production and critical first", () => {
    const a = (id: string, over: Partial<Approval>) => ({ id, status: "pending", workspace_id: "ws_1", production: false, severity: "normal", created_at: "2026-10-03T08:00:00Z", ...over }) as Approval;
    const list = [a("old", { created_at: "2026-10-03T07:00:00Z" }), a("prod", { production: true }), a("crit", { severity: "critical" }), a("other-ws", { workspace_id: "ws_2" }), a("done", { status: "approved" }), a("new", {})];
    expect(pendingForWorkspace(list, "ws_1").map((x) => x.id)).toEqual(["prod", "crit", "new", "old"]);
  });
});
