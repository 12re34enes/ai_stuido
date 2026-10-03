/**
 * Per-kind decision drafts: what the user can edit before approving, how it becomes the
 * backend's `decision_payload`, and what blocks approval.
 *
 *   plan     → { plan }      (only when edited; engine compares with the original)
 *   memory   → { content }   (only when edited)
 *   question → { answer }
 *   budget   → { action }    (same_provider | switch | wait | continue)
 *   custom   → human: the form values ({ text } without a schema); compare: { winner }
 */
import type { ApprovalRecord } from "./api";
import { budgetPayload, customPayload, memoryPayload, planPayload } from "./payload";
import { approvalStrings as s } from "./strings";

export type Draft = Record<string, unknown>;

export function initialDraft(a: ApprovalRecord): Draft {
  switch (a.kind) {
    case "plan":
      return { plan: planPayload(a.payload).plan };
    case "memory":
      return { content: memoryPayload(a.payload).content };
    case "question":
      return { answer: "" };
    case "budget":
      return { action: budgetPayload(a.payload).options[0] ?? null };
    case "custom": {
      const c = customPayload(a.payload, a.summary);
      if (c.type === "compare") return { winner: c.suggested ?? c.candidates[0]?.nodeId ?? null };
      if (c.fields.length === 0) return { text: "" };
      return Object.fromEntries(c.fields.map((f) => [f.name, f.default ?? (f.type === "boolean" ? false : f.type === "enum" ? (f.options[0] ?? "") : "")]));
    }
    default:
      return {};
  }
}

/** The payload sent with an approval (null when there is nothing to add). */
export function decisionPayload(a: ApprovalRecord, draft: Draft): Record<string, unknown> | null {
  switch (a.kind) {
    case "plan": {
      const original = planPayload(a.payload).plan;
      const plan = typeof draft.plan === "string" ? draft.plan : original;
      return plan.trim() !== original.trim() ? { plan } : null;
    }
    case "memory": {
      const original = memoryPayload(a.payload).content;
      const content = typeof draft.content === "string" ? draft.content : original;
      return content !== original ? { content } : null;
    }
    case "question":
      return { answer: String(draft.answer ?? "").trim() };
    case "budget":
      return draft.action ? { action: draft.action } : null;
    case "custom": {
      const c = customPayload(a.payload, a.summary);
      if (c.type === "compare") return draft.winner ? { winner: draft.winner } : null;
      if (c.fields.length === 0) return String(draft.text ?? "").trim() ? { text: String(draft.text).trim() } : null;
      const out: Record<string, unknown> = {};
      for (const f of c.fields) {
        const v = draft[f.name];
        if (f.type === "number") {
          if (v !== "" && v !== null && v !== undefined && !Number.isNaN(Number(v))) out[f.name] = Number(v);
        } else if (f.type === "boolean") out[f.name] = v === true;
        else if (typeof v === "string" && v.trim()) out[f.name] = v.trim();
      }
      return out;
    }
    default:
      return null;
  }
}

/** Why approval is blocked (Turkish), or null. */
export function blockReason(a: ApprovalRecord, draft: Draft): string | null {
  if (a.kind === "question" && !String(draft.answer ?? "").trim()) return s.question.required;
  if (a.kind === "custom") {
    const c = customPayload(a.payload, a.summary);
    if (c.type === "human") {
      for (const f of c.fields) {
        if (!f.required || f.type === "boolean") continue;
        const v = draft[f.name];
        if (v === undefined || v === null || String(v).trim() === "") return `${f.label}: ${s.custom.required}`;
      }
    }
  }
  return null;
}

/** Whether the draft differs from the original (plan / memory edits). */
export function isEdited(a: ApprovalRecord, draft: Draft): boolean {
  return (a.kind === "plan" || a.kind === "memory") && decisionPayload(a, draft) !== null;
}

/** Primary button label per kind. */
export function primaryLabel(a: ApprovalRecord): string {
  if (a.kind === "question") return s.actions.answer;
  if (a.kind === "budget" || (a.kind === "custom" && customPayload(a.payload).type === "compare")) return s.actions.choose;
  if (a.kind === "custom" && customPayload(a.payload).type === "human") return s.actions.submit;
  return s.actions.approve;
}
