/** Turns the composer draft into a `POST /engine/tasks` body, with Turkish validation messages. */
import type { Budget } from "../list/types";
import type { ComposerDraft } from "./composerStore";
import { createStrings as s } from "./strings";
import type { Studio, StudioInput, TaskCreateBody } from "./types";

export const TITLE_MAX = 80;

/** Title derived from the prompt: first meaningful line, markdown markers stripped, ≤ 80 chars. */
export function deriveTitle(prompt: string, max = TITLE_MAX): string {
  const line =
    prompt
      .split("\n")
      .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*>]\s+|\d+[.)]\s+)/, "").trim())
      .find((l) => l.length > 0) ?? "";
  const clean = line.replace(/\s+/g, " ");
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type FieldErrors = Record<string, string>;

export type BuildResult = { ok: true; body: TaskCreateBody } | { ok: false; errors: FieldErrors };

function blank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** Studio inputs whose text best describes the task (for the title / prompt). */
function textInputs(studio: Studio): StudioInput[] {
  return studio.inputs.filter((i) => i.type === "text" || i.type === "textarea");
}

/** Default value of a studio input as the form shows it. */
export function inputDefault(input: StudioInput): string {
  return typeof input.default === "string" ? input.default : input.default == null ? "" : String(input.default);
}

/** Prompt for a studio task: the primary text first (it becomes the title), then the other texts. */
export function studioPrompt(studio: Studio, values: Record<string, string>): string {
  const texts = textInputs(studio)
    .map((i) => ({ input: i, value: (values[i.name] ?? inputDefault(i)).trim() }))
    .filter((t) => t.value);
  const primary = texts.find((t) => t.input.required) ?? texts[0];
  if (!primary) return studio.name;
  const rest = texts.filter((t) => t !== primary).map((t) => `**${t.input.label}:** ${t.value}`);
  return [primary.value, ...rest].join("\n\n");
}

function parseNumber(raw: string, { min, max, integer }: { min: number; max?: number; integer?: boolean }): number | null | "invalid" {
  const text = raw.trim().replace(",", ".");
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || (max !== undefined && n > max) || (integer && !Number.isInteger(n))) return "invalid";
  return n;
}

export function buildBudget(d: ComposerDraft["budget"], errors: FieldErrors): Budget | null {
  const five = parseNumber(d.fiveHour, { min: 1, max: 100 });
  const weekly = parseNumber(d.weekly, { min: 1, max: 100 });
  const duration = parseNumber(d.duration, { min: 1, integer: true });
  const turns = parseNumber(d.turns, { min: 1, integer: true });
  if (five === "invalid") errors["budget.fiveHour"] = s.errors.percent;
  if (weekly === "invalid") errors["budget.weekly"] = s.errors.percent;
  if (duration === "invalid") errors["budget.duration"] = s.errors.positiveInt;
  if (turns === "invalid") errors["budget.turns"] = s.errors.positiveInt;
  const budget: Budget = {};
  if (typeof five === "number") budget.max_five_hour_percent = five;
  if (typeof weekly === "number") budget.max_weekly_percent = weekly;
  if (typeof duration === "number") budget.max_duration_minutes = duration;
  if (typeof turns === "number") budget.max_turns = turns;
  return Object.keys(budget).length ? budget : null;
}

export interface BuildContext {
  workspaceId: string;
  studio: Studio | null;
  now?: Date;
}

/** Validate the draft and build the request body. */
export function buildTaskBody(d: ComposerDraft, ctx: BuildContext): BuildResult {
  const errors: FieldErrors = {};
  const studio = ctx.studio;
  let prompt = d.prompt.trim();
  let inputs: Record<string, unknown> = {};

  if (studio) {
    for (const input of studio.inputs) {
      const value = (d.studioInputs[input.name] ?? inputDefault(input)).trim();
      if (input.required && blank(value)) errors[`input.${input.name}`] = s.errors.required(input.label);
      inputs[input.name] = value;
    }
    prompt = studioPrompt(studio, d.studioInputs);
  } else if (!prompt) {
    errors.prompt = s.errors.prompt;
  }

  // Ekip mode needs a team (a studio or a saved flow overrides the mode, as for the other modes).
  const teamMode = d.mode === "team" && !studio && !d.flowId;
  if (teamMode && !d.teamId && !d.teamSpec) errors.team = s.errors.team;

  const budget = buildBudget(d.budget, errors);

  let scheduledAt: string | null = null;
  if (d.schedule === "at") {
    const at = d.scheduledAt ? new Date(d.scheduledAt) : null;
    if (!at || Number.isNaN(at.getTime())) errors.scheduledAt = s.errors.scheduleMissing;
    else if (at.getTime() <= (ctx.now ?? new Date()).getTime()) errors.scheduledAt = s.errors.schedulePast;
    else scheduledAt = at.toISOString();
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  const explicitTitle = d.title.trim();
  const title = explicitTitle || (studio ? deriveTitle(`${studio.name}: ${deriveTitle(prompt, TITLE_MAX)}`) : deriveTitle(prompt));
  if (!studio) inputs = {};

  const body: TaskCreateBody = {
    workspace_id: ctx.workspaceId,
    title,
    prompt,
    mode: d.mode,
    flow_id: studio ? null : d.flowId,
    studio_id: studio?.id ?? null,
    repo_ids: d.repoIds && d.repoIds.length ? d.repoIds : null,
    base_ref: d.baseRef || null,
    inputs,
    budget,
    priority: d.priority,
    scheduled_at: scheduledAt,
    source: studio ? "studio" : "user",
    start: true,
    start_on_reset: d.schedule === "reset",
  };
  if (teamMode) {
    body.team_id = d.teamId;
    if (d.teamSpec) body.team = d.teamSpec;
  } else if (d.mode === "team") {
    // Overridden by a studio / saved flow: the engine runs that graph; keep the body mode valid.
    body.mode = "custom";
  }
  return { ok: true, body };
}

/** Map a backend validation error (`details.errors` of a studio) onto composer field keys. */
export function serverFieldErrors(details: Record<string, unknown> | undefined): FieldErrors {
  const raw = details?.errors;
  const out: FieldErrors = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[`input.${k}`] = v;
  }
  return out;
}
