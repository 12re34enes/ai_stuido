import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderUI } from "@/test/render";

import { subagentSummaryLabel } from "./format";
import { summarizeSubagents, type SubagentNode } from "./model";
import { SubagentTreeView } from "./SubagentTreeView";

const node = (id: string, over: Partial<SubagentNode> = {}): SubagentNode => ({
  id,
  parentId: null,
  name: null,
  description: null,
  status: "running",
  model: null,
  startedAt: "2026-10-03T08:00:00Z",
  finishedAt: null,
  lastText: null,
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  ...over,
});

const nodes = [
  node("a", { name: "Explore", description: "Modülleri tara", status: "success", inputTokens: 18_000, outputTokens: 2_000, toolCalls: 2 }),
  node("b", { name: "general-purpose", description: "Testleri yaz", lastText: "pnpm test çalıştırılıyor" }),
  node("c", { parentId: "b", name: "fixture-builder", description: "Fikstür hazırla", status: "error" }),
];

describe("SubagentTreeView", () => {
  it("renders the nested tree with depth, status and live line", () => {
    const { container } = renderUI(<SubagentTreeView nodes={nodes} provider="claude" />);
    expect(screen.getByRole("group", { name: "Alt ajan ağacı" })).toBeInTheDocument();
    const rows = container.querySelectorAll("[data-subagent-id]");
    expect([...rows].map((r) => [r.getAttribute("data-subagent-id"), r.getAttribute("data-depth"), r.getAttribute("data-status")])).toEqual([
      ["a", "0", "success"],
      ["b", "0", "running"],
      ["c", "1", "error"],
    ]);
    expect(screen.getByText("pnpm test çalıştırılıyor")).toBeInTheDocument();
    expect(screen.getByText("20 B token")).toBeInTheDocument();
  });

  it("selects a subagent and collapses a subtree", async () => {
    const onSelect = vi.fn();
    renderUI(<SubagentTreeView nodes={nodes} provider="codex" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /fixture-builder · Fikstür hazırla · Hata/ }));
    expect(onSelect).toHaveBeenCalledWith("c");
    await userEvent.click(screen.getByRole("button", { name: /Alt ağacı kapat/ }));
    await waitFor(() => expect(screen.queryByText("Fikstür hazırla")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Alt ağacı aç/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("labels summaries in Turkish", () => {
    expect(subagentSummaryLabel(summarizeSubagents(nodes))).toBe("3 alt ajan · 1 çalışıyor · 1 hatalı");
    expect(subagentSummaryLabel({ total: 2, running: 0, error: 0 })).toBe("2 alt ajan");
  });
});
