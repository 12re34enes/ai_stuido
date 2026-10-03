import { ApiError } from "@/lib/api";

import {
  branchRepo,
  buildTaskBody,
  defaultTitle,
  fieldKind,
  forEnvironment,
  initialValues,
  primaryInput,
  requestInputs,
  serverFieldErrors,
  validateValues,
} from "./form";
import type { Studio, StudioInput } from "./types";

const inputs: StudioInput[] = [
  { name: "change", label: "Şema değişikliği", type: "textarea", required: true },
  { name: "dialect", label: "Veritabanı", type: "select", required: false, default: "PostgreSQL", options: ["PostgreSQL", "MySQL"] },
  { name: "tool", label: "Migration aracı", type: "text", required: false, default: "" },
  { name: "repo", label: "Repo", type: "repo", required: true },
  { name: "branch", label: "Branch", type: "branch", required: false },
  { name: "profile", label: "Test profili", type: "deploy_profile", environment: "test", required: true },
];

const studio: Studio = {
  id: "database",
  name: "Veritabanı",
  description: "",
  version: 3,
  inputs,
  graph: { nodes: [], edges: [] },
};

describe("fieldKind", () => {
  it("maps known types and falls back to text", () => {
    expect(fieldKind(inputs[0]!)).toBe("textarea");
    expect(fieldKind(inputs[3]!)).toBe("repo");
    expect(fieldKind({ name: "x", label: "X", type: "color" })).toBe("text");
    expect(fieldKind({ name: "x", label: "X", type: "select", options: [] })).toBe("text");
  });
});

describe("initialValues", () => {
  it("uses defaults and keeps typed values", () => {
    expect(initialValues(inputs)).toEqual({ change: "", dialect: "PostgreSQL", tool: "", repo: "", branch: "", profile: "" });
    expect(initialValues(inputs, { change: "Para birimi" }).change).toBe("Para birimi");
  });
});

describe("validateValues", () => {
  it("reports required fields with the backend's Turkish message", () => {
    const errors = validateValues(inputs, initialValues(inputs));
    expect(errors).toEqual({
      change: "“Şema değişikliği” alanı zorunlu.",
      repo: "“Repo” alanı zorunlu.",
      profile: "“Test profili” alanı zorunlu.",
    });
  });

  it("treats whitespace as empty and checks select options", () => {
    const errors = validateValues(inputs, { change: "   ", dialect: "Oracle", repo: "repo_1", profile: "dp_1" });
    expect(errors.change).toBe("“Şema değişikliği” alanı zorunlu.");
    expect(errors.dialect).toBe("Geçersiz seçim. Seçenekler: PostgreSQL, MySQL.");
  });

  it("accepts a complete form", () => {
    expect(validateValues(inputs, { change: "x", dialect: "MySQL", repo: "r", profile: "p" })).toEqual({});
  });
});

describe("request building", () => {
  const values = { change: "  Siparişlere çoklu para birimi\nayrıntı  ", dialect: "PostgreSQL", tool: "", repo: "repo_1", branch: "", profile: "dp_test" };

  it("sends only trimmed non-empty values", () => {
    expect(requestInputs(inputs, values)).toEqual({
      change: "Siparişlere çoklu para birimi\nayrıntı",
      dialect: "PostgreSQL",
      repo: "repo_1",
      profile: "dp_test",
    });
  });

  it("derives the prompt and title from the primary input", () => {
    expect(primaryInput(inputs)?.name).toBe("change");
    expect(defaultTitle(studio, values)).toBe("Veritabanı: Siparişlere çoklu para birimi");
    const body = buildTaskBody(studio, values, "ws_1", "");
    expect(body).toMatchObject({
      workspace_id: "ws_1",
      title: "Veritabanı: Siparişlere çoklu para birimi",
      prompt: "Siparişlere çoklu para birimi\nayrıntı",
      studio_id: "database",
      source: "studio",
      source_ref: { studio_id: "database", version: 3 },
      start: true,
    });
    expect(buildTaskBody(studio, values, "ws_1", "  Özel başlık ").title).toBe("Özel başlık");
  });

  it("truncates long titles", () => {
    const long = "a".repeat(200);
    expect(defaultTitle(studio, { change: long }).length).toBe(80);
  });

  it("falls back to the studio name when there is no text input", () => {
    const bare: Studio = { ...studio, inputs: [{ name: "repo", label: "Repo", type: "repo" }] };
    expect(buildTaskBody(bare, { repo: "r" }, "ws", "").prompt).toBe("Veritabanı");
  });
});

describe("pickers", () => {
  it("finds the repo a branch picker depends on", () => {
    expect(branchRepo(inputs, { repo: "" })).toBeUndefined();
    expect(branchRepo(inputs, { repo: "repo_2" })).toBe("repo_2");
  });

  it("filters targets by environment", () => {
    const items = [
      { id: "a", environment: "test" as const },
      { id: "b", environment: "production" as const },
    ];
    expect(forEnvironment(items, "test").map((i) => i.id)).toEqual(["a"]);
    expect(forEnvironment(items, null)).toHaveLength(2);
  });
});

describe("serverFieldErrors", () => {
  it("extracts per-field messages from a ValidationFailed", () => {
    const err = new ApiError(422, "validation_failed", "Stüdyo girdileri eksik veya geçersiz.", {
      errors: { profile: "Bu alan yalnız test ortamındaki hedefleri kabul eder; seçilen hedef production ortamında." },
    });
    expect(serverFieldErrors(err)).toEqual({ profile: "Bu alan yalnız test ortamındaki hedefleri kabul eder; seçilen hedef production ortamında." });
    expect(serverFieldErrors(new Error("x"))).toEqual({});
    expect(serverFieldErrors(new ApiError(422, "validation_failed", "x", { errors: [{ loc: ["body"] }] }))).toEqual({});
  });
});
