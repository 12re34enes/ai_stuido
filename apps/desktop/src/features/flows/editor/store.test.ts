import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfig, defaultSettings } from "../model/kinds";
import type { FlowGraph } from "../types";
import { graphOf } from "./useEditorActions";
import { createEditorStore } from "./store";

function graph(): FlowGraph {
  return {
    nodes: [
      { id: "dev", label: "Yazar", config: { ...defaultConfig("agent"), provider: "claude", prompt_template: "{{ input.prompt }}" }, position: { x: 80, y: 240 } },
      { id: "build", label: "Build/test", config: { ...defaultConfig("gate"), target_node_id: "dev" }, position: { x: 380, y: 240 } },
      { id: "review", label: "İnceleme", config: { ...defaultConfig("gate"), gate: "cross_review" }, position: { x: 680, y: 240 } },
    ],
    edges: [{ id: "e_dev_build", source: "dev", target: "build", condition: "default" }],
    settings: defaultSettings(),
    inputs: {},
  };
}

function setup() {
  const store = createEditorStore();
  store.getState().load({ meta: { flowId: "flow_1", version: 2, name: "Akış", description: "", isTemplate: false, studioId: null }, graph: graph() });
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("editor store", () => {
  it("loads clean and converts back to the same graph", () => {
    const store = setup();
    expect(store.getState().dirty).toBe(false);
    expect(graphOf(store.getState())).toEqual(graph());
    expect(Object.keys(store.getState().introDelays)).toEqual(["dev", "build", "review"]);
  });

  it("connects with a suggested condition and opens the picker", () => {
    const store = setup();
    store.getState().connect({ source: "build", target: "review", sourceHandle: null, targetHandle: null });
    store.getState().connect({ source: "build", target: "dev", sourceHandle: null, targetHandle: null });
    const edges = store.getState().edges;
    expect(edges.map((e) => [e.id, e.data?.condition])).toEqual([
      ["e_dev_build", "default"],
      ["e_build_review", "default"],
      ["e_build_dev_failed", "failed"],
    ]);
    expect(edges[2]!.data?.loop).toBe(true);
    expect(store.getState().pendingCondition).toBe("e_build_dev_failed");
    expect(store.getState().fresh.e_build_dev_failed).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(store.getState().fresh).toEqual({});
    expect(store.getState().dirty).toBe(true);
  });

  it("ignores self loops and exact duplicates", () => {
    const store = setup();
    store.getState().connect({ source: "dev", target: "dev", sourceHandle: null, targetHandle: null });
    store.getState().connect({ source: "dev", target: "build", sourceHandle: null, targetHandle: null });
    expect(store.getState().edges).toHaveLength(1);
    expect(store.getState().past).toHaveLength(0);
  });

  it("undoes and redoes structural edits", () => {
    const store = setup();
    const id = store.getState().addNode("condition", { x: 500, y: 500 });
    expect(id).toBe("condition");
    expect(store.getState().nodes).toHaveLength(4);
    expect(store.getState().nodes.find((n) => n.id === id)!.selected).toBe(true);
    store.getState().undo();
    expect(store.getState().nodes).toHaveLength(3);
    store.getState().redo();
    expect(store.getState().nodes.map((n) => n.id)).toContain("condition");
  });

  it("coalesces typing into one undo step per field", () => {
    const store = setup();
    store.getState().updateNode("dev", { label: "Y" });
    store.getState().updateNode("dev", { label: "Ya" });
    store.getState().updateNode("dev", { label: "Yaz" });
    expect(store.getState().past).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    store.getState().updateNode("dev", { label: "Yazar 2" });
    expect(store.getState().past).toHaveLength(2);
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().nodes[0]!.data.label).toBe("Yazar");
  });

  it("removes nodes with their edges after the exit animation and clears references", () => {
    const store = setup();
    store.getState().removeElements(["dev"], []);
    expect(store.getState().exiting).toEqual({ dev: true, e_dev_build: true });
    expect(store.getState().nodes).toHaveLength(3);
    vi.advanceTimersByTime(200);
    expect(store.getState().nodes.map((n) => n.id)).toEqual(["build", "review"]);
    expect(store.getState().edges).toEqual([]);
    expect(store.getState().exiting).toEqual({});
    const build = store.getState().nodes[0]!.data.config;
    expect(build.kind === "gate" && build.target_node_id).toBeNull();
    store.getState().undo();
    expect(store.getState().nodes).toHaveLength(3);
    expect(store.getState().edges).toHaveLength(1);
  });

  it("renames a node everywhere it is referenced", () => {
    const store = setup();
    store.getState().updateConfig("review", { prompt_template: "x" } as never);
    store.getState().updateConfig("dev", { prompt_template: "{{ nodes.build.output }}" } as never);
    store.getState().renameNode("build", "tests");
    const s = store.getState();
    expect(s.nodes.map((n) => n.id)).toEqual(["dev", "tests", "review"]);
    expect(s.edges[0]!.target).toBe("tests");
    const dev = s.nodes[0]!.data.config;
    expect(dev.kind === "agent" && dev.prompt_template).toBe("{{ nodes.tests.output }}");
    // Taken ids are refused.
    store.getState().renameNode("tests", "dev");
    expect(store.getState().nodes[1]!.id).toBe("tests");
  });

  it("copies and pastes selections with fresh ids and internal edges", () => {
    const store = setup();
    store.getState().selectOnly({ nodes: ["dev", "build"] });
    expect(store.getState().copySelection()).toBe(2);
    expect(store.getState().paste()).toBe(2);
    const s = store.getState();
    expect(s.nodes.map((n) => n.id)).toEqual(["dev", "build", "review", "agent", "gate_build_test"]);
    expect(s.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["agent", "gate_build_test"]);
    const pastedGate = s.nodes[4]!.data.config;
    expect(pastedGate.kind === "gate" && pastedGate.target_node_id).toBe("agent");
    expect(s.edges.at(-1)).toMatchObject({ source: "agent", target: "gate_build_test" });
    // The copy lands in the free band below the originals, then the next band.
    expect(s.nodes[3]!.position).toEqual({ x: 80, y: 360 });
    store.getState().selectOnly({ nodes: ["dev", "build"] });
    store.getState().copySelection();
    store.getState().paste();
    expect(store.getState().nodes.at(-2)!.position).toEqual({ x: 80, y: 480 });
  });

  it("sets edge conditions and settings undoably", () => {
    const store = setup();
    store.getState().setCondition("e_dev_build", "failed");
    expect(store.getState().edges[0]!.data?.condition).toBe("failed");
    store.getState().setSettings((s) => ({ ...s, max_parallel_agents: 2 }));
    expect(store.getState().settings.max_parallel_agents).toBe(2);
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().edges[0]!.data?.condition).toBe("default");
    expect(store.getState().settings.max_parallel_agents).toBe(4);
  });

  it("indexes validation reports and pulses on explicit runs", () => {
    const store = setup();
    store.getState().setReport({ ok: false, errors: [{ code: "x", message: "Hata", node_id: "dev", edge_id: null }], warnings: [] }, { explicit: true });
    expect(store.getState().issues.byNode.dev).toHaveLength(1);
    expect(store.getState().pulse).toBe(1);
    expect(store.getState().reportRevision).toBe(store.getState().revision);
  });

  it("previews an older version read-only and restores the draft", () => {
    const store = setup();
    store.getState().updateNode("dev", { label: "Taslak" });
    const old = graph();
    old.nodes = old.nodes.slice(0, 1);
    store.getState().enterPreview(1, old, { name: "Eski", description: "" });
    expect(store.getState().nodes).toHaveLength(1);
    store.getState().addNode("agent", { x: 0, y: 0 });
    store.getState().connect({ source: "dev", target: "dev", sourceHandle: null, targetHandle: null });
    store.getState().removeElements(["dev"], []);
    expect(store.getState().exiting).toEqual({});
    store.getState().exitPreview();
    expect(store.getState().nodes[0]!.data.label).toBe("Taslak");
    expect(store.getState().name).toBe("Akış");
  });
});
