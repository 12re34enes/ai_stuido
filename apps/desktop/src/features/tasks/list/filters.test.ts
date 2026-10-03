import { describe, expect, it } from "vitest";

import { EMPTY_FILTERS, filtersToParams, hasActiveFilters, parseFilters, toggleStatus } from "./filters";
import { listAccepts } from "./queries";
import type { Task } from "./types";

describe("task list filters", () => {
  it("parses the URL and drops unknown values", () => {
    const f = parseFilters(new URLSearchParams("view=queue&status=failed,bogus,running,failed&mode=duo&source=nope&q=indeks"));
    expect(f).toEqual({ view: "queue", statuses: ["failed", "running"], mode: "duo", source: null, q: "indeks" });
    expect(parseFilters(new URLSearchParams(""))).toEqual(EMPTY_FILTERS);
  });

  it("serializes in a stable order and round-trips", () => {
    const f = { view: "list" as const, statuses: ["failed" as const, "running" as const], mode: "race", source: "schedule" as const, q: "pdf" };
    const params = filtersToParams(f);
    expect(params.toString()).toBe("status=running%2Cfailed&mode=race&source=schedule&q=pdf");
    expect(parseFilters(params)).toEqual({ ...f, statuses: ["running", "failed"] });
    expect(filtersToParams(EMPTY_FILTERS).toString()).toBe("");
  });

  it("knows when filters are active and toggles statuses", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, q: "x" })).toBe(true);
    expect(toggleStatus(["running"], "failed")).toEqual(["running", "failed"]);
    expect(toggleStatus(["running", "failed"], "running")).toEqual(["failed"]);
  });

  it("decides which cached lists a new task belongs to", () => {
    const t = { workspace_id: "ws_1", status: "queued", mode: "duo", source: "user", title: "Fatura PDF", prompt: "" } as Task;
    expect(listAccepts({ workspaceId: "ws_1" }, t)).toBe(true);
    expect(listAccepts({ workspaceId: "ws_2" }, t)).toBe(false);
    expect(listAccepts({ workspaceId: "ws_1", statuses: ["running", "queued"] }, t)).toBe(true);
    expect(listAccepts({ workspaceId: "ws_1", statuses: ["failed"] }, t)).toBe(false);
    expect(listAccepts({ workspaceId: "ws_1", mode: "race" }, t)).toBe(false);
    expect(listAccepts({ workspaceId: "ws_1", q: "pdf" }, t)).toBe(true);
    expect(listAccepts({ workspaceId: "ws_1", q: "csv" }, t)).toBe(false);
  });
});
