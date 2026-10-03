import { describe, expect, it } from "vitest";

import { parseFlowsRoute } from "./route";

describe("parseFlowsRoute", () => {
  it("maps /flows/* locations to pages", () => {
    expect(parseFlowsRoute("/flows", "")).toEqual({ page: "list" });
    expect(parseFlowsRoute("/flows/", "")).toEqual({ page: "list" });
    expect(parseFlowsRoute("/flows/schedules", "")).toEqual({ page: "schedules" });
    expect(parseFlowsRoute("/flows/flow_1", "")).toEqual({ page: "editor", flowId: "flow_1", mode: null, studio: null, blank: false });
    expect(parseFlowsRoute("/flows/new", "?mode=duo")).toEqual({ page: "editor", flowId: null, mode: "duo", studio: null, blank: false });
    expect(parseFlowsRoute("/flows/new", "?mode=nope")).toMatchObject({ mode: null });
    expect(parseFlowsRoute("/flows/new", "?studio=architecture")).toMatchObject({ studio: "architecture" });
    expect(parseFlowsRoute("/flows/new", "?blank=1")).toMatchObject({ blank: true });
  });
});
