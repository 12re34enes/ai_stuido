import { agentDotStatus, isAgentBusy } from "./agentStatus";
import { diffStats } from "./code/diffStats";
import { numberColumns } from "./numbers";
import { textareaHeight } from "./textareaSize";

describe("diffStats", () => {
  it("counts added and removed lines", () => {
    expect(diffStats("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: 2, removed: 1 });
    expect(diffStats("", "x\ny")).toEqual({ added: 2, removed: 0 });
    expect(diffStats("same", "same")).toEqual({ added: 0, removed: 0 });
  });
  it("falls back above the size guard", () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const b = `${a}\nextra`;
    expect(diffStats(a, b, 2)).toEqual({ added: 1, removed: 0 });
  });
});

describe("numberColumns", () => {
  it("keys characters from the right so new digits mount on the left", () => {
    const cols = numberColumns("12.840");
    expect(cols.map((c) => c.key)).toEqual(["c6", "c5", "c4", "c3", "c2", "c1"]);
    expect(cols.filter((c) => c.digit)).toHaveLength(5);
    expect(numberColumns("%7")[0]).toMatchObject({ char: "%", digit: false });
  });
});

describe("textareaHeight", () => {
  const base = { lineHeight: 18, paddingY: 14, borderY: 2, minRows: 2, maxRows: 5 };
  it("clamps between min and max rows", () => {
    expect(textareaHeight({ ...base, scrollHeight: 20 })).toEqual({ height: 2 * 18 + 16, overflow: false });
    expect(textareaHeight({ ...base, scrollHeight: 3 * 18 + 14 })).toEqual({ height: 3 * 18 + 16, overflow: false });
    expect(textareaHeight({ ...base, scrollHeight: 10 * 18 + 14 })).toEqual({ height: 5 * 18 + 16, overflow: true });
  });
});

describe("agentDotStatus", () => {
  it("maps agent states to dot states", () => {
    expect(agentDotStatus("running_tool")).toBe("running");
    expect(agentDotStatus("thinking")).toBe("running");
    expect(agentDotStatus("waiting_permission")).toBe("waiting");
    expect(agentDotStatus("done")).toBe("success");
    expect(agentDotStatus("error")).toBe("error");
    expect(agentDotStatus("idle")).toBe("idle");
    expect(agentDotStatus("interrupted")).toBe("offline");
    expect(isAgentBusy("responding")).toBe(true);
    expect(isAgentBusy("done")).toBe(false);
  });
});
