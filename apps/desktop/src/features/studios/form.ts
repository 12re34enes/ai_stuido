/**
 * Run form logic, generated from a studio's `inputs` (contracts/studios.py::StudioInput).
 * Validation mirrors the backend's `resolve_inputs` so the user sees the same Turkish message
 * before the round trip; the server stays authoritative (environment checks, repo lookup).
 */
import { ApiError } from "@/lib/api";
import type { Environment } from "@/lib/types";

import { studioStrings as s } from "./strings";
import type { Studio, StudioInput, TaskCreateBody } from "./types";

export type FieldKind = "text" | "textarea" | "select" | "repo" | "branch" | "host" | "db" | "deploy_profile";

const KINDS = new Set<FieldKind>(["text", "textarea", "select", "repo", "branch", "host", "db", "deploy_profile"]);

export type FormValues = Record<string, string>;
export type FormErrors = Record<string, string>;

export function fieldKind(input: StudioInput): FieldKind {
  const t = (input.type ?? "text") as FieldKind;
  if (!KINDS.has(t)) return "text";
  // A select without options cannot be chosen from: fall back to free text.
  if (t === "select" && !input.options?.length) return "text";
  return t;
}

export function isRequired(input: StudioInput): boolean {
  return input.required !== false;
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Starting values: defaults, keeping anything the user already typed (`previous`). */
export function initialValues(inputs: StudioInput[], previous: FormValues = {}): FormValues {
  const out: FormValues = {};
  for (const input of inputs) out[input.name] = previous[input.name] ?? asText(input.default);
  return out;
}

/** The value the backend will use: trimmed input, else the trimmed default. */
export function effectiveValue(input: StudioInput, values: FormValues): string {
  const own = (values[input.name] ?? "").trim();
  return own || asText(input.default).trim();
}

export function validateField(input: StudioInput, values: FormValues): string | null {
  const value = effectiveValue(input, values);
  if (!value) return isRequired(input) ? s.required(input.label) : null;
  if (fieldKind(input) === "select" && input.options && !input.options.includes(value)) return s.invalidChoice(input.options);
  return null;
}

export function validateValues(inputs: StudioInput[], values: FormValues): FormErrors {
  const errors: FormErrors = {};
  for (const input of inputs) {
    const e = validateField(input, values);
    if (e) errors[input.name] = e;
  }
  return errors;
}

/** Request payload: trimmed non-empty values only, so the server applies defaults to the rest. */
export function requestInputs(inputs: StudioInput[], values: FormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of inputs) {
    const v = (values[input.name] ?? "").trim();
    if (v) out[input.name] = v;
  }
  return out;
}

/** The input that best describes the task: first required textarea, then any textarea, then text. */
export function primaryInput(inputs: StudioInput[]): StudioInput | undefined {
  const kinds = inputs.map((i) => ({ i, k: fieldKind(i) }));
  return (
    kinds.find(({ i, k }) => k === "textarea" && isRequired(i))?.i ??
    kinds.find(({ k }) => k === "textarea")?.i ??
    kinds.find(({ i, k }) => k === "text" && isRequired(i))?.i ??
    kinds.find(({ k }) => k === "text")?.i
  );
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Task prompt (the engine requires one): the primary input's text, else the studio name. */
export function buildPrompt(studio: Studio, values: FormValues): string {
  const primary = primaryInput(studio.inputs ?? []);
  const text = primary ? effectiveValue(primary, values) : "";
  return text || studio.name;
}

export function defaultTitle(studio: Studio, values: FormValues): string {
  const primary = primaryInput(studio.inputs ?? []);
  const line = primary ? firstLine(effectiveValue(primary, values)) : "";
  return truncate(line ? `${studio.name}: ${line}` : studio.name, 80);
}

export function buildTaskBody(studio: Studio, values: FormValues, workspaceId: string, title: string): TaskCreateBody {
  return {
    workspace_id: workspaceId,
    title: title.trim() || defaultTitle(studio, values),
    prompt: buildPrompt(studio, values),
    studio_id: studio.id,
    inputs: requestInputs(studio.inputs ?? [], values),
    source: "studio",
    source_ref: { studio_id: studio.id, version: studio.version ?? 1 },
    start: true,
  };
}

/** Field errors from a backend ValidationFailed (`details.errors` = {input name: message}). */
export function serverFieldErrors(err: unknown): FormErrors {
  if (!(err instanceof ApiError)) return {};
  const raw = err.details?.errors;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FormErrors = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

/** The repo a branch picker lists branches for: the first repo input that has a value. */
export function branchRepo(inputs: StudioInput[], values: FormValues): string | undefined {
  for (const input of inputs) {
    if (fieldKind(input) === "repo") {
      const v = effectiveValue(input, values);
      if (v) return v;
    }
  }
  return undefined;
}

/** Targets usable for an input that is pinned to one environment. */
export function forEnvironment<T extends { environment: Environment }>(items: T[], env: Environment | null | undefined): T[] {
  return env ? items.filter((i) => i.environment === env) : items;
}

/** Labels for the preview step: [{label, value}] with defaults applied. */
export function resolvedSummary(inputs: StudioInput[], values: FormValues, display: (input: StudioInput, value: string) => string) {
  return inputs.map((input) => {
    const v = effectiveValue(input, values);
    return { name: input.name, label: input.label, value: v ? display(input, v) : "" };
  });
}
