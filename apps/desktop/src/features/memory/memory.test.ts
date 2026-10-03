import { QueryClient } from "@tanstack/react-query";

import type { StudioEvent } from "@/lib/events";

import { applyMemoryEvents, memoryKeys } from "./api";
import { diffTotals, parseUnifiedDiff } from "./diff";
import { displayMarkdown, fillEmptySections, stripHtmlComments } from "./markdown";
import { actorKind, actorSession, buildTree, decisionPath, isoDate, layerOf } from "./tree";

describe("buildTree", () => {
  const docs = [
    { path: "facts.md", layer: "facts" as const, title: "Proje gerçekleri" },
    { path: "boundaries.md", layer: "boundaries" as const, title: "Sınırlar" },
    { path: "decisions/README.md", layer: "decisions" as const, title: "Karar kayıtları" },
    { path: "decisions/2026-09-28-kuyruk.md", layer: "decisions" as const, title: "Kuyruk kararı" },
    { path: "decisions/2026-10-03-limit-esikleri.md", layer: "decisions" as const, title: "Limit eşikleri" },
    { path: "sessions/2026-10-02-ses_1.md", layer: "sessions" as const, title: "Oturum özeti: limit çubukları" },
  ];

  it("groups by layer in spec order with counts excluding guides", () => {
    const tree = buildTree(docs);
    expect(tree.map((g) => [g.layer, g.label, g.count])).toEqual([
      ["facts", "Proje gerçekleri", 1],
      ["decisions", "Kararlar", 2],
      ["boundaries", "Sınırlar", 1],
      ["sessions", "Oturum özetleri", 1],
    ]);
  });

  it("sorts dated documents newest first and puts the folder guide last", () => {
    const decisions = buildTree(docs)[1]!;
    expect(decisions.items.map((i) => [i.title, i.date, i.guide])).toEqual([
      ["Limit eşikleri", "2026-10-03", false],
      ["Kuyruk kararı", "2026-09-28", false],
      ["Rehber", null, true],
    ]);
  });

  it("keeps empty layers", () => {
    expect(buildTree([]).every((g) => g.items.length === 0 && g.count === 0)).toBe(true);
  });
});

describe("tree helpers", () => {
  it("derives layers from paths", () => {
    expect(layerOf("facts.md")).toBe("facts");
    expect(layerOf("decisions/x.md")).toBe("decisions");
    expect(layerOf("notes.md")).toBeNull();
  });

  it("classifies commit actors", () => {
    expect(actorKind("user")).toBe("user");
    expect(actorKind("agent:ses_9")).toBe("agent");
    expect(actorSession("agent:ses_9")).toBe("ses_9");
    expect(actorKind("external")).toBe("external");
    expect(actorKind(null)).toBe("system");
  });

  it("builds unique Turkish-safe decision paths", () => {
    expect(decisionPath("Bildirimler kuyrukla gönderilsin", "2026-10-03")).toBe("decisions/2026-10-03-bildirimler-kuyrukla-gonderilsin.md");
    expect(decisionPath("Şık", "2026-10-03", ["decisions/2026-10-03-sik.md"])).toBe("decisions/2026-10-03-sik-2.md");
    expect(decisionPath("???", "2026-10-03")).toBe("decisions/2026-10-03-karar.md");
    expect(isoDate(new Date(2026, 9, 3, 23, 59))).toBe("2026-10-03");
  });
});

describe("parseUnifiedDiff", () => {
  const git = `diff --git a/facts.md b/facts.md
index 1111111..2222222 100644
--- a/facts.md
+++ b/facts.md
@@ -1,4 +1,5 @@ # Proje gerçekleri
 # Proje gerçekleri

-## Amaç
+## Amaç ve kapsam
+Ödeme servisi.
 ## Teknoloji yığını
diff --git a/decisions/2026-10-03-x.md b/decisions/2026-10-03-x.md
new file mode 100644
--- /dev/null
+++ b/decisions/2026-10-03-x.md
@@ -0,0 +1,2 @@
+# Karar
+Metin
\\ No newline at end of file
`;

  it("splits files, hunks and numbered lines", () => {
    const files = parseUnifiedDiff(git);
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["facts.md", "modified", 2, 1],
      ["decisions/2026-10-03-x.md", "added", 2, 0],
    ]);
    const hunk = files[0]!.hunks[0]!;
    expect(hunk.section).toBe("# Proje gerçekleri");
    expect(hunk.lines.map((l) => [l.type, l.oldNo ?? null, l.newNo ?? null])).toEqual([
      ["ctx", 1, 1],
      ["ctx", 2, 2],
      ["del", 3, null],
      ["add", null, 3],
      ["add", null, 4],
      ["ctx", 4, 5],
    ]);
    expect(files[1]!.hunks[0]!.lines.at(-1)).toEqual({ type: "meta", text: "No newline at end of file" });
    expect(diffTotals(files)).toEqual({ added: 4, removed: 1 });
  });

  it("parses difflib output without a git header", () => {
    const files = parseUnifiedDiff("--- a/boundaries.md\n+++ b/boundaries.md\n@@ -1 +1 @@\n-network: true\n+network: false\n");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "boundaries.md", status: "modified", added: 1, removed: 1 });
  });

  it("treats a deleted line starting with dashes as content", () => {
    const files = parseUnifiedDiff("--- a/x.md\n+++ b/x.md\n@@ -1,2 +1,1 @@\n--- ayraç\n metin\n");
    expect(files).toHaveLength(1);
    expect(files[0]!.removed).toBe(1);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("display markdown", () => {
  it("strips HTML comments but not inside code fences", () => {
    expect(stripHtmlComments("a <!-- not --> b\n```\n<!-- keep -->\n```\n")).toBe("a  b\n```\n<!-- keep -->\n```\n");
  });

  it("fills empty sections with a placeholder", () => {
    expect(fillEmptySections("# T\n\n## Amaç\n\n## Yığın\nPython\n", "_boş_")).toBe("# T\n\n## Amaç\n\n_boş_\n\n## Yığın\nPython\n");
  });

  it("prepares the starter facts file", () => {
    const out = displayMarkdown("# Proje gerçekleri\n\n<!--\nİpucu\n-->\n\n## Amaç\n<!-- Proje ne işe yarıyor? -->\n\n## Komutlar\n`pnpm test`\n", "_Henüz yazılmamış._");
    expect(out).toBe("# Proje gerçekleri\n\n## Amaç\n\n_Henüz yazılmamış._\n\n## Komutlar\n`pnpm test`");
  });
});

describe("applyMemoryEvents", () => {
  const ev = (type: string, payload: Record<string, unknown> = {}, workspace_id: string | null = "ws_1"): StudioEvent => ({
    id: 1,
    ts: "2026-10-03T08:00:00Z",
    type,
    severity: "info",
    actor: "system",
    workspace_id,
    task_id: null,
    run_id: null,
    session_id: null,
    payload,
    ephemeral: false,
  });

  function setup() {
    const qc = new QueryClient();
    const keys = [memoryKeys.docs("ws_1"), memoryKeys.proposals("ws_1"), memoryKeys.history("ws_1"), memoryKeys.boundaries("ws_1"), memoryKeys.doc("ws_1", "facts.md")];
    for (const k of keys) qc.setQueryData(k, []);
    const stale = (k: readonly unknown[]) => qc.getQueryState(k)?.isInvalidated ?? false;
    return { qc, stale };
  }

  it("refreshes documents and history on a direct edit", () => {
    const { qc, stale } = setup();
    applyMemoryEvents(qc, "ws_1", [ev("memory.updated", { path: "facts.md", layer: "facts" })]);
    expect(stale(memoryKeys.docs("ws_1"))).toBe(true);
    expect(stale(memoryKeys.history("ws_1"))).toBe(true);
    expect(stale(memoryKeys.doc("ws_1", "facts.md"))).toBe(true);
    expect(stale(memoryKeys.proposals("ws_1"))).toBe(false);
    expect(stale(memoryKeys.boundaries("ws_1"))).toBe(false);
  });

  it("refreshes proposals on approvals, boundaries on boundary changes", () => {
    const { qc, stale } = setup();
    applyMemoryEvents(qc, "ws_1", [ev("approval.decided", { kind: "memory" }), ev("memory.applied", { path: "boundaries.md", layer: "boundaries" })]);
    expect(stale(memoryKeys.proposals("ws_1"))).toBe(true);
    expect(stale(memoryKeys.boundaries("ws_1"))).toBe(true);
  });

  it("ignores other workspaces and stores boundary warnings", () => {
    const { qc, stale } = setup();
    applyMemoryEvents(qc, "ws_1", [ev("memory.updated", { path: "facts.md" }, "ws_2")]);
    expect(stale(memoryKeys.docs("ws_1"))).toBe(false);
    applyMemoryEvents(qc, "ws_1", [ev("memory.boundaries_invalid", { warnings: ["Bilinmeyen alan yok sayıldı: netwrok"] })]);
    expect(qc.getQueryData(memoryKeys.boundaryWarnings("ws_1"))).toEqual(["Bilinmeyen alan yok sayıldı: netwrok"]);
  });
});
