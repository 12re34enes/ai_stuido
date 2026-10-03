import { describe, expect, it } from "vitest";

import type { Approval } from "@/lib/types";

import { buildPaletteSections, flatItems, moveSelection, nextMode, taskTitle, type PageEntry, type TaskSummary } from "./quickPalette";

const approval = (id: string, title: string, production = false) => ({ id, title, summary: null, kind: "plan", production }) as unknown as Approval;
const tasks: TaskSummary[] = [
  { id: "t1", title: "Limit çubuklarını üst çubuğa ekle", status: "running", mode: "duo", updated_at: "" },
  { id: "t2", title: "Ödeme webhook testleri", status: "completed", mode: "single", updated_at: "" },
];
const pages: PageEntry[] = [
  { id: "tasks", label: "Görevler", path: "/tasks", keywords: ["tasks"] },
  { id: "connections", label: "Bağlantılar", path: "/connections", keywords: ["ssh", "deploy"] },
];
const build = (query: string, approvals: Approval[] = []) => buildPaletteSections({ query, approvals, tasks, pages, kindLabel: () => "Plan onayı" });

describe("quick palette", () => {
  it("starts with new task, then approvals, recent tasks and pages", () => {
    const sections = build("", [approval("a1", "Plan onayı: limitler", true)]);
    expect(sections.map((s) => s.group)).toEqual(["actions", "approvals", "tasks", "pages"]);
    expect(sections[1]?.items[0]).toMatchObject({ kind: "approval", route: "/approvals/a1", production: true });
    expect(sections[2]?.items.map((i) => i.id)).toEqual(["task:t1", "task:t2"]);
  });

  it("turns the query into a task and filters the rest (Turkish folding)", () => {
    const sections = build("odeme");
    expect(sections[0]?.items[0]).toMatchObject({ kind: "new-task", title: "Yeni görev: “odeme”", prompt: "odeme" });
    expect(sections.find((s) => s.group === "tasks")?.items.map((i) => i.title)).toEqual(["Ödeme webhook testleri"]);
    expect(build("ssh").find((s) => s.group === "pages")?.items.map((i) => i.title)).toEqual(["Bağlantılar"]);
  });

  it("moves the selection with wrap-around", () => {
    const items = flatItems(build(""));
    expect(moveSelection(items, null, 1)).toBe(items[0]?.id);
    expect(moveSelection(items, items[0]?.id ?? null, -1)).toBe(items[items.length - 1]?.id);
    expect(moveSelection([], null, 1)).toBeNull();
  });

  it("cycles modes and derives task titles", () => {
    expect(nextMode("council")).toBe("single");
    expect(nextMode("single", -1)).toBe("council");
    expect(taskTitle("  Kısa başlık\nayrıntı")).toBe("Kısa başlık");
    const long = "Kullanım limitlerini menü çubuğundaki halkalarda göster ve sıfırlanma geri sayımını ekle lütfen";
    expect(taskTitle(long).length).toBeLessThanOrEqual(81);
    expect(taskTitle(long).endsWith("…")).toBe(true);
  });
});
