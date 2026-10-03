import { buildStudioDocument, documentHeadings, exportFileName, fromServerDocument, latestNodeRuns, readingStats, splitDocument } from "./document";
import type { FlowGraph, NodeRun, TaskDetail } from "./types";

const graph: FlowGraph = {
  nodes: [
    { id: "research", label: "Araştırma", config: { kind: "advisor", provider: "claude" } },
    { id: "critique", label: "Eleştiri", config: { kind: "advisor", provider: "codex" } },
    { id: "final", label: "Son onay", config: { kind: "gate", gate: "user_final" } },
  ],
  edges: [],
  inputs: { topic: "Elektrikli bisiklet pazarı" },
};

function nodeRun(node_id: string, output: string | null, over: Partial<NodeRun> = {}): NodeRun {
  return { id: `nr_${node_id}_${over.attempt ?? 1}`, run_id: "run_1", node_id, status: "passed", output, ...over };
}

function detail(nodes: NodeRun[], status: TaskDetail["task"]["status"] = "completed"): TaskDetail {
  return {
    task: {
      id: "task_1",
      workspace_id: "ws_1",
      title: "Piyasa analizi",
      prompt: "Elektrikli bisiklet pazarı",
      mode: "custom",
      studio_id: "market-analysis",
      inputs: { topic: "Elektrikli bisiklet pazarı" },
      status,
      created_at: "2026-10-03T08:00:00Z",
      updated_at: "2026-10-03T09:00:00Z",
    },
    current_run: { id: "run_1", task_id: "task_1", workspace_id: "ws_1", graph, status: "completed", nodes, started_at: "2026-10-03T08:00:00Z" },
  };
}

describe("latestNodeRuns", () => {
  it("keeps the newest attempt, but not an empty one over real output", () => {
    const map = latestNodeRuns([
      nodeRun("research", "v1", { attempt: 1 }),
      nodeRun("research", "v2", { attempt: 2 }),
      nodeRun("critique", "eski", { attempt: 1 }),
      nodeRun("critique", null, { attempt: 2, status: "running" }),
    ]);
    expect(map.get("research")?.output).toBe("v2");
    expect(map.get("critique")?.output).toBe("eski");
  });
});

describe("buildStudioDocument", () => {
  const template = "# {{ input.topic }}\n\n{{ nodes.research.output }}\n\n\n\n## Ek\n\n{{ nodes.critique.output }}\n";

  it("renders the output template with node outputs and inputs", () => {
    const doc = buildStudioDocument({ graph, output_template: template }, detail([nodeRun("research", "Rapor"), nodeRun("critique", "Notlar")]));
    expect(doc.source).toBe("template");
    expect(doc.markdown).toBe("# Elektrikli bisiklet pazarı\n\nRapor\n\n## Ek\n\nNotlar\n");
  });

  it("falls back to the last output node without a template", () => {
    const doc = buildStudioDocument({ graph, output_template: null }, detail([nodeRun("research", "Rapor"), nodeRun("critique", "Notlar")]));
    expect(doc).toEqual({ markdown: "Notlar\n", source: "fallback" });
  });

  it("falls back with a reason when the template cannot be rendered", () => {
    const doc = buildStudioDocument({ graph, output_template: "{% macro x() %}{% endmacro %}" }, detail([nodeRun("research", "Rapor")]));
    expect(doc.source).toBe("fallback");
    expect(doc.markdown).toBe("Rapor\n");
    expect(doc.error).toMatch(/Desteklenmeyen/);
  });

  it("is empty until some node produced output", () => {
    expect(buildStudioDocument({ graph, output_template: template }, detail([], "running")).source).toBe("empty");
  });
});

describe("splitDocument", () => {
  it("lifts front matter and the leading title out of the body", () => {
    const parts = splitDocument("---\ntitle: Kuyruk\nsummary: Bildirimler kuyruktan gider.\nstatus: önerildi\n---\n\n# Bildirimler kuyrukla\n\n## Bağlam\n\nMetin\n");
    expect(parts).toEqual({
      title: "Bildirimler kuyrukla",
      summary: "Bildirimler kuyruktan gider.",
      meta: { title: "Kuyruk", summary: "Bildirimler kuyruktan gider.", status: "önerildi" },
      body: "## Bağlam\n\nMetin\n",
    });
  });

  it("leaves documents without front matter or title alone", () => {
    expect(splitDocument("## Bölüm\n\nMetin\n")).toEqual({ title: null, summary: null, meta: {}, body: "## Bölüm\n\nMetin\n" });
  });

  it("does not treat a horizontal rule as front matter", () => {
    expect(splitDocument("---\n\nMetin: değil eşleme ama\n- liste\n---\n").body.startsWith("---")).toBe(true);
  });
});

describe("reader helpers", () => {
  it("extracts headings outside code fences", () => {
    expect(documentHeadings("# Başlık\n\n```md\n# kod\n```\n## Bölüm *bir*\n#### derin")).toEqual([
      { level: 1, text: "Başlık" },
      { level: 2, text: "Bölüm bir" },
    ]);
  });

  it("estimates reading time", () => {
    expect(readingStats("kelime ".repeat(400))).toEqual({ words: 400, minutes: 2 });
    expect(readingStats("kısa").minutes).toBe(1);
  });

  it("builds a Turkish-safe export file name", () => {
    expect(exportFileName("Mimari tasarım: Kuyruk mu, doğrudan çağrı mı?")).toBe("mimari-tasarim-kuyruk-mu-dogrudan-cagri-mi.md");
    expect(exportFileName("???")).toBe("studyo-ciktisi.md");
  });
});

describe("fromServerDocument", () => {
  it("keeps a rendered template and tidies it", () => {
    expect(fromServerDocument({ task_id: "t", markdown: "# Karar\n\n\n\nMetin  \n", source: "template" })).toEqual({
      markdown: "# Karar\n\nMetin\n",
      source: "template",
    });
  });

  it("maps the last-output fallback and carries the template warning", () => {
    expect(fromServerDocument({ task_id: "t", markdown: "Çıktı", source: "last_output", warning: "Şablon hatası" })).toEqual({
      markdown: "Çıktı\n",
      source: "fallback",
      error: "Şablon hatası",
    });
  });

  it("treats a blank document as empty", () => {
    expect(fromServerDocument({ task_id: "t", markdown: "  \n", source: "last_output", warning: null })).toEqual({ markdown: "", source: "empty" });
  });
});
