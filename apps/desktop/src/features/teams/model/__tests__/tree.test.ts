import { describe, expect, it } from "vitest";

import { effortLevel, mapEffort, nextMemberId, normalizeSpec, slugify, summaryChips, summaryText } from "../spec";
import { addMember, canAdd, canReparent, depthMap, duplicateSubtree, indexTeam, removeSubtree, renameMember, reparent, subtreeIds, treeOrder } from "../tree";
import { exampleSpec, member } from "./fixtures";

describe("spec helpers", () => {
  it("summarizes roles and providers like the builder chip row", () => {
    expect(summaryText(exampleSpec())).toBe("1 danışman · 1 lider · 9 üye · 2 test · Claude ×8 · Codex ×5");
    expect(summaryChips({ members: [member("lead", "lead")] }).map((c) => c.key)).toEqual(["leads", "claude"]);
  });

  it("normalizes partial payloads with contract defaults", () => {
    const spec = normalizeSpec({ members: [{ id: "lead", role: "lead" } as never, { id: "adv", role: "advisor", writes: true } as never] });
    expect(spec.settings.max_depth).toBe(4);
    expect(spec.members[0]).toMatchObject({ name: "Lider", provider: "claude", writes: true, test_mode: "dependent" });
    // Advisors never write, whatever the payload says.
    expect(spec.members[1]!.writes).toBe(false);
  });

  it("makes readable ids and slugs", () => {
    expect(slugify("Arayüz geliştirici İş")).toBe("arayuz-gelistirici-is");
    expect(nextMemberId("worker", new Set(["lead", "dev-1"]))).toBe("dev-2");
    expect(nextMemberId("worker", new Set(["lead", "dev-1"]), "dev-1")).toBe("dev-1-1");
    expect(nextMemberId("tester", new Set())).toBe("qa-1");
  });

  it("maps efforts across providers by relative level", () => {
    expect(effortLevel("claude", "high")).toEqual({ index: 3, of: 5, label: "Yüksek" });
    expect(effortLevel("codex", null).index).toBe(0);
    expect(mapEffort("max", "claude", "codex")).toBe("high");
    expect(mapEffort("minimal", "codex", "claude")).toBe("low");
    expect(mapEffort("medium", "claude", "codex")).toBe("medium");
  });
});

describe("tree structure", () => {
  it("indexes delegation children and satellites", () => {
    const idx = indexTeam(exampleSpec());
    expect(idx.lead?.id).toBe("lead");
    expect(idx.workers.get("lead")?.map((m) => m.id)).toEqual(["dev-a", "dev-b", "dev-c"]);
    expect(idx.advisors.get("lead")?.map((m) => m.id)).toEqual(["advisor"]);
    expect(idx.dependentTesters.get("dev-b")?.map((m) => m.id)).toEqual(["qa-b"]);
    expect(idx.independentTesters.get("lead")?.map((m) => m.id)).toEqual(["qa-all"]);
  });

  it("computes depths (satellites take their anchor's depth)", () => {
    const d = depthMap(exampleSpec());
    expect(d.get("lead")).toBe(0);
    expect(d.get("dev-a")).toBe(1);
    expect(d.get("dev-a-2")).toBe(2);
    expect(d.get("qa-b")).toBe(1);
    expect(d.get("advisor")).toBe(0);
  });

  it("orders members for lanes: lead advisors, then depth-first with satellites", () => {
    expect(treeOrder(exampleSpec())).toEqual(["advisor", "lead", "dev-a", "dev-a-1", "dev-a-2", "dev-b", "qa-b", "dev-b-1", "dev-b-2", "dev-c", "dev-c-1", "dev-c-2", "qa-all"]);
  });

  it("collects a subtree with attached testers and advisors", () => {
    expect(subtreeIds(exampleSpec(), "dev-b").sort()).toEqual(["dev-b", "dev-b-1", "dev-b-2", "qa-b"]);
    expect(subtreeIds(exampleSpec(), "qa-all")).toEqual(["qa-all"]);
  });
});

describe("re-parent validity", () => {
  const spec = exampleSpec();

  it("allows moving a worker under another manager", () => {
    expect(canReparent(spec, "dev-a-1", "dev-b")).toEqual({ ok: true });
    const next = reparent(spec, "dev-a-1", "dev-b");
    expect(next.members.find((m) => m.id === "dev-a-1")?.parent_id).toBe("dev-b");
  });

  it("rejects cycles, the lead, satellites as targets and no-ops", () => {
    expect(canReparent(spec, "dev-a", "dev-a-1").ok).toBe(false);
    expect(canReparent(spec, "lead", "dev-a").ok).toBe(false);
    expect(canReparent(spec, "dev-a-1", "qa-b").ok).toBe(false);
    expect(canReparent(spec, "dev-a-1", "advisor").ok).toBe(false);
    const noop = canReparent(spec, "dev-a-1", "dev-a");
    expect(noop.ok).toBe(false);
    expect(!noop.ok && noop.noop).toBe(true);
    // Invalid moves leave the spec untouched.
    expect(reparent(spec, "dev-a", "dev-a-1")).toBe(spec);
  });

  it("respects the maximum depth (subtree height counts)", () => {
    const shallow = { ...spec, settings: { ...spec.settings, max_depth: 2 } };
    // dev-a (height 1) under dev-b (depth 1) → leaves at depth 3 > 2.
    const check = canReparent(shallow, "dev-a", "dev-b");
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toContain("derinlik");
    expect(canReparent(shallow, "dev-a-1", "dev-b").ok).toBe(true);
  });

  it("moves testers and advisors by retargeting them", () => {
    const tester = reparent(spec, "qa-b", "dev-c");
    expect(tester.members.find((m) => m.id === "qa-b")).toMatchObject({ tests_member_id: "dev-c", parent_id: "dev-c" });
    expect(canReparent(spec, "advisor", "dev-a")).toEqual({ ok: true });
    const withSecond = { ...spec, members: [...spec.members, member("advisor", "adv-2", { parent_id: "dev-a" })] };
    expect(canReparent(withSecond, "advisor", "dev-a").ok).toBe(false);
  });
});

describe("structural edits", () => {
  it("adds members next to their manager's subtree with sensible defaults", () => {
    const res = addMember(exampleSpec(), "worker", "dev-b")!;
    expect(res.id).toBe("dev-b-3");
    const added = res.spec.members.find((m) => m.id === res.id)!;
    expect(added).toMatchObject({ role: "worker", parent_id: "dev-b", provider: "codex", writes: true });
    // Inserted right after dev-b's subtree (before dev-c).
    const ids = res.spec.members.map((m) => m.id);
    expect(ids.indexOf("dev-b-3")).toBeLessThan(ids.indexOf("dev-c"));

    const tester = addMember(exampleSpec(), "dependent", "dev-a")!;
    expect(tester.spec.members.find((m) => m.id === tester.id)).toMatchObject({ role: "tester", tests_member_id: "dev-a", provider: "codex", writes: false });
  });

  it("refuses a second advisor and adding below the depth limit", () => {
    expect(canAdd(exampleSpec(), "advisor", "lead").ok).toBe(false);
    expect(addMember(exampleSpec(), "advisor", "lead")).toBeNull();
    const shallow = { ...exampleSpec(), settings: { ...exampleSpec().settings, max_depth: 2 } };
    expect(canAdd(shallow, "worker", "dev-a-1").ok).toBe(false);
  });

  it("removes a subtree but never the lead", () => {
    const { spec, removed } = removeSubtree(exampleSpec(), "dev-b");
    expect(removed.sort()).toEqual(["dev-b", "dev-b-1", "dev-b-2", "qa-b"]);
    expect(spec.members).toHaveLength(9);
    expect(removeSubtree(exampleSpec(), "lead").removed).toEqual([]);
  });

  it("duplicates a subtree with fresh ids and remapped references", () => {
    const res = duplicateSubtree(exampleSpec(), "dev-b")!;
    const copy = res.spec.members.find((m) => m.id === res.id)!;
    expect(copy).toMatchObject({ parent_id: "lead", name: "Sunucu (kopya)" });
    const copies = res.spec.members.filter((m) => m.parent_id === res.id || m.tests_member_id === res.id);
    expect(copies.map((m) => m.role).sort()).toEqual(["tester", "worker", "worker"]);
    expect(res.spec.members).toHaveLength(17);
    expect(duplicateSubtree(exampleSpec(), "lead")).toBeNull();
  });

  it("renames a member id everywhere", () => {
    const spec = renameMember(exampleSpec(), "dev-b", "api");
    expect(spec.members.filter((m) => m.parent_id === "api").map((m) => m.id).sort()).toEqual(["dev-b-1", "dev-b-2", "qa-b"]);
    expect(spec.members.find((m) => m.id === "qa-b")?.tests_member_id).toBe("api");
  });
});
