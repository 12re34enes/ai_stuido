import { describe, expect, it } from "vitest";

import { buildTaskBody, deriveTitle, serverFieldErrors, studioPrompt } from "./buildTask";
import { EMPTY_BUDGET, type ComposerDraft } from "./composerStore";
import type { Studio } from "./types";

function draft(over: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    title: "",
    prompt: "",
    mode: "duo",
    studioId: null,
    studioInputs: {},
    repoIds: null,
    baseRef: null,
    flowId: null,
    budget: { ...EMPTY_BUDGET },
    priority: 0,
    schedule: "now",
    scheduledAt: "",
    ...over,
  };
}

const studio: Studio = {
  id: "debugging",
  name: "Hata ayıklama",
  description: "",
  icon: "bug",
  version: 1,
  builtin: true,
  graph: { nodes: [], edges: [] },
  inputs: [
    { name: "symptom", label: "Hata belirtisi", type: "textarea", required: true },
    { name: "logs", label: "Log", type: "textarea", required: false, default: "" },
    { name: "environment", label: "Ortam", type: "select", required: false, default: "Yerel", options: ["Yerel", "Test"] },
    { name: "repo", label: "Repo", type: "repo", required: true },
  ],
};

const ctx = { workspaceId: "ws_1", studio: null, now: new Date("2026-10-03T08:00:00Z") };

describe("deriveTitle", () => {
  it("takes the first meaningful line without markdown markers", () => {
    expect(deriveTitle("\n\n## Ödeme özetine kur farkı ekle\nayrıntılar")).toBe("Ödeme özetine kur farkı ekle");
    expect(deriveTitle("- madde  bir   iki")).toBe("madde bir iki");
  });

  it("truncates long lines on a word boundary", () => {
    const title = deriveTitle("Bu çok uzun bir görev açıklaması ve başlığa sığmaması gereken pek çok kelime içeriyor, gerçekten uzun");
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });
});

describe("buildTaskBody", () => {
  it("requires a prompt", () => {
    expect(buildTaskBody(draft(), ctx)).toEqual({ ok: false, errors: { prompt: "Görevi birkaç cümleyle anlat." } });
  });

  it("builds a plain task with derived title, repos, branch and budget", () => {
    const res = buildTaskBody(
      draft({ prompt: "Limit çubuklarını ekle\n\nTestler geçmeli", mode: "council", repoIds: ["repo_1"], baseRef: "feature/x", budget: { fiveHour: "25", weekly: "", duration: "90", turns: "" }, priority: 1 }),
      ctx,
    );
    expect(res).toEqual({
      ok: true,
      body: {
        workspace_id: "ws_1",
        title: "Limit çubuklarını ekle",
        prompt: "Limit çubuklarını ekle\n\nTestler geçmeli",
        mode: "council",
        flow_id: null,
        studio_id: null,
        repo_ids: ["repo_1"],
        base_ref: "feature/x",
        inputs: {},
        budget: { max_five_hour_percent: 25, max_duration_minutes: 90 },
        priority: 1,
        scheduled_at: null,
        source: "user",
        start: true,
        start_on_reset: false,
      },
    });
  });

  it("keeps an explicit title and the saved flow", () => {
    const res = buildTaskBody(draft({ prompt: "x", title: "  Özel başlık ", flowId: "flow_1", schedule: "reset" }), ctx);
    expect(res.ok && res.body).toMatchObject({ title: "Özel başlık", flow_id: "flow_1", start_on_reset: true });
  });

  it("validates the budget and the start time", () => {
    const res = buildTaskBody(draft({ prompt: "x", budget: { fiveHour: "120", weekly: "abc", duration: "1.5", turns: "0" }, schedule: "at", scheduledAt: "2026-10-01T09:00" }), ctx);
    expect(res.ok).toBe(false);
    expect(!res.ok && Object.keys(res.errors).sort()).toEqual(["budget.duration", "budget.fiveHour", "budget.turns", "budget.weekly", "scheduledAt"]);
  });

  it("schedules in the future", () => {
    const res = buildTaskBody(draft({ prompt: "x", schedule: "at", scheduledAt: "2026-10-05T09:30" }), ctx);
    expect(res.ok && res.body.scheduled_at).toBe(new Date("2026-10-05T09:30").toISOString());
  });

  it("checks required studio inputs", () => {
    const res = buildTaskBody(draft({ studioId: "debugging", studioInputs: { symptom: " " } }), { ...ctx, studio });
    expect(res).toEqual({ ok: false, errors: { "input.symptom": "“Hata belirtisi” alanı zorunlu.", "input.repo": "“Repo” alanı zorunlu." } });
  });

  it("builds a studio task: inputs with defaults, prompt from the texts, studio title", () => {
    const res = buildTaskBody(draft({ studioId: "debugging", studioInputs: { symptom: "Ödeme sayfası 500 veriyor", logs: "Traceback…", repo: "repo_1" }, flowId: "flow_1" }), { ...ctx, studio });
    expect(res.ok && res.body).toMatchObject({
      title: "Hata ayıklama: Ödeme sayfası 500 veriyor",
      prompt: "Ödeme sayfası 500 veriyor\n\n**Log:** Traceback…",
      studio_id: "debugging",
      flow_id: null,
      source: "studio",
      inputs: { symptom: "Ödeme sayfası 500 veriyor", logs: "Traceback…", environment: "Yerel", repo: "repo_1" },
    });
  });
});

describe("studio helpers", () => {
  it("falls back to the studio name when no text was entered", () => {
    expect(studioPrompt({ ...studio, inputs: [] }, {})).toBe("Hata ayıklama");
  });

  it("maps server validation errors onto fields", () => {
    expect(serverFieldErrors({ errors: { repo: "Bu çalışma alanında böyle bir repo yok." } })).toEqual({ "input.repo": "Bu çalışma alanında böyle bir repo yok." });
    expect(serverFieldErrors(undefined)).toEqual({});
  });
});
