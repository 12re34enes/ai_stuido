import { describe, expect, it } from "vitest";

import { gateStrings, kindStrings } from "../strings";
import { NODE_KINDS } from "../types";
import { conditionsFor, defaultConfig, defaultLabel, defaultSettings, isValidNodeId, kindInfo, nextNodeId, normalizeSettings, PALETTE_GROUPS, suggestCondition } from "./kinds";

describe("node kinds", () => {
  it("has palette entries, Turkish names and one-line descriptions for every kind", () => {
    const listed = PALETTE_GROUPS.flatMap((g) => g.kinds).sort();
    expect(listed).toEqual([...NODE_KINDS].sort());
    for (const k of NODE_KINDS) {
      const info = kindInfo(k);
      expect(info.label).toBe(kindStrings[k].label);
      expect(info.description.length).toBeLessThanOrEqual(38);
      expect(info.icon).toBeTruthy();
    }
    expect(NODE_KINDS.map((k) => kindStrings[k].label)).toEqual(["Ajan", "Danışman", "Kapı", "Paralel", "Birleşme", "Karşılaştır", "Koşul", "Sentez", "Merge", "Git", "Deploy", "İnsan"]);
  });

  it("mirrors the pydantic defaults", () => {
    expect(defaultConfig("agent")).toEqual({
      kind: "agent",
      profile_id: null,
      provider: null,
      model: null,
      effort: null,
      role: "writer",
      prompt_template: "{{ input.prompt }}",
      repo_ids: null,
      writes: true,
      boundaries: null,
      tool_names: null,
      max_turns: null,
      output_format: "text",
    });
    expect(defaultConfig("gate")).toMatchObject({ gate: "build_test", max_rounds: 3, blocking_severities: ["critical", "high"] });
    expect(defaultConfig("compare")).toMatchObject({ judge: "user", run_gates: ["build_test"] });
    expect(defaultConfig("git")).toMatchObject({ action: "open_pr", title_template: "{{ task.title }}", watch: true, autofix: true });
    expect(defaultConfig("merge")).toMatchObject({ strategy: "squash", require_approval: true, resolve_conflicts_with_agent: true });
    expect(defaultConfig("synthesis")).toMatchObject({ devil_advocate: true, output_format: "decision", propose_memory: true, prompt_template: "" });
    expect(defaultConfig("agent", { fresh: true }).provider).toBe("claude");
    // Configs are fresh copies.
    const a = defaultConfig("gate");
    a.blocking_severities.push("low");
    expect(defaultConfig("gate").blocking_severities).toEqual(["critical", "high"]);
  });

  it("mirrors FlowSettings defaults and fills partial settings", () => {
    expect(defaultSettings()).toMatchObject({ max_parallel_agents: 4, checkpoint_every_node: true, limit_policy: { on_exhausted: "queue" } });
    expect(normalizeSettings({ gates: { plan_approval: false } } as never).gates).toEqual({ plan_approval: false, boundary_check: true, build_test: true, cross_review: true, user_final: true });
  });

  it("offers edge conditions by source kind", () => {
    expect(conditionsFor("condition")).toEqual(["true", "false", "default"]);
    expect(conditionsFor("gate")).toContain("approved");
    expect(conditionsFor("agent")).toEqual(["default", "failed"]);
  });

  it("suggests the next sensible condition", () => {
    expect(suggestCondition("condition", [])).toBe("true");
    expect(suggestCondition("condition", ["true"])).toBe("false");
    expect(suggestCondition("gate", [])).toBe("default");
    expect(suggestCondition("gate", ["default"])).toBe("failed");
    expect(suggestCondition("agent", ["default"])).toBe("default");
  });

  it("names and ids new nodes", () => {
    expect(defaultLabel(defaultConfig("gate"), (g) => gateStrings[g].label)).toBe("Build/test kanıtı");
    expect(defaultLabel(defaultConfig("human"), (g) => g)).toBe("İnsan");
    expect(nextNodeId(defaultConfig("agent"), new Set())).toBe("agent");
    expect(nextNodeId(defaultConfig("agent"), new Set(["agent", "agent_2"]))).toBe("agent_3");
    expect(nextNodeId(defaultConfig("gate"), new Set())).toBe("gate_build_test");
    expect(isValidNodeId("dev_a")).toBe(true);
    expect(isValidNodeId("2dev")).toBe(false);
    expect(isValidNodeId("dev-a")).toBe(false);
  });
});
