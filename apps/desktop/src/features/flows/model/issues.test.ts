import { describe, expect, it } from "vitest";

import { EMPTY_INDEX, indexIssues, reportFromErrorDetails, worstLevel } from "./issues";

const issue = (code: string, node_id: string | null = null, edge_id: string | null = null) => ({ code, message: `${code} mesajı`, node_id, edge_id });

describe("validation → canvas markers", () => {
  it("attaches node and edge issues, keeps the rest global", () => {
    const idx = indexIssues(
      {
        ok: false,
        errors: [issue("expression", "cond"), issue("bad_condition", "dev", "e1"), issue("multiple_entries"), issue("template", "ghost")],
        warnings: [issue("thin_join", "join")],
      },
      new Set(["cond", "dev", "join"]),
      new Set(["e1"]),
    );
    expect(Object.keys(idx.byNode).sort()).toEqual(["cond", "join"]);
    expect(idx.byNode.cond![0]!.level).toBe("error");
    expect(idx.byNode.join![0]!.level).toBe("warning");
    // Edge issues mark the edge, not the source node too.
    expect(idx.byEdge.e1!.map((i) => i.code)).toEqual(["bad_condition"]);
    expect(idx.byNode.dev).toBeUndefined();
    // Unknown elements and flow-level issues are global.
    expect(idx.global.map((i) => i.code)).toEqual(["multiple_entries", "template"]);
    expect(idx.errorCount).toBe(4);
    expect(idx.warningCount).toBe(1);
    // Flow-level errors first, then element errors, then warnings.
    expect(idx.all[0]!.code).toBe("multiple_entries");
    expect(idx.all.at(-1)!.code).toBe("thin_join");
  });

  it("is empty without a report", () => {
    expect(indexIssues(null, new Set(), new Set())).toBe(EMPTY_INDEX);
  });

  it("computes the worst level", () => {
    expect(worstLevel(undefined)).toBeNull();
    expect(worstLevel([{ ...issue("a"), level: "warning" }])).toBe("warning");
    expect(worstLevel([{ ...issue("a"), level: "warning" }, { ...issue("b"), level: "error" }])).toBe("error");
  });

  it("recovers issues from a 422 payload", () => {
    expect(reportFromErrorDetails({ errors: [issue("no_entry")] })).toEqual({ ok: false, errors: [issue("no_entry")], warnings: [] });
    // Request-validation errors from FastAPI don't look like issues.
    expect(reportFromErrorDetails({ errors: [{ loc: ["body"], msg: "x" }] })).toBeNull();
    expect(reportFromErrorDetails(undefined)).toBeNull();
  });
});
