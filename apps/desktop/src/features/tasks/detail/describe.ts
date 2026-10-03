/** Turkish one-line descriptions of run events (replay event list, scrubber markers, toasts). */
import type { StudioEvent } from "@/lib/events";
import { uiStrings } from "@/ui";

import { s } from "./strings";
import type { GateKind } from "./types";

export type EventTone = "neutral" | "success" | "danger" | "warning" | "accent" | "info";
export type EventIcon =
  | "play"
  | "flag"
  | "x"
  | "check"
  | "arrow"
  | "gate"
  | "loop"
  | "approval"
  | "checkpoint"
  | "agent"
  | "message"
  | "tool"
  | "file"
  | "alert"
  | "pause"
  | "progress"
  | "dot";

export interface EventDescription {
  title: string;
  detail?: string;
  tone: EventTone;
  icon: EventIcon;
}

export interface DescribeContext {
  nodeLabel: (nodeId: string) => string;
  sessionLabel: (sessionId: string) => string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function clip(text: string, max = 160): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function gateName(kind: string): string {
  return (s.gateKind as Record<string, string>)[kind as GateKind] ?? kind;
}

export function describeEvent(ev: StudioEvent, ctx: DescribeContext): EventDescription {
  const p = ev.payload;
  const node = () => str(p.label) || ctx.nodeLabel(str(p.node_id));
  const agent = () => (ev.session_id ? ctx.sessionLabel(ev.session_id) : "Ajan");
  switch (ev.type) {
    case "run.started":
      return { title: "Koşu başladı", tone: "accent", icon: "play" };
    case "run.completed":
      return { title: "Koşu tamamlandı", tone: "success", icon: "flag" };
    case "run.failed":
      return { title: "Koşu başarısız oldu", detail: str(p.error) ? clip(str(p.error)) : undefined, tone: "danger", icon: "x" };
    case "run.cancelled":
      return { title: "Koşu iptal edildi", tone: "neutral", icon: "x" };
    case "run.updated":
      return { title: str(p.status) === "waiting" ? "Koşu beklemede" : "Koşu devam ediyor", tone: "neutral", icon: "dot" };
    case "run.reopened":
      return { title: "Koşu yeniden açıldı", tone: "accent", icon: "play" };
    case "run.resumed":
      return { title: "Koşu kaldığı yerden sürdü", tone: "accent", icon: "play" };
    case "run.edge":
      return { title: `${ctx.nodeLabel(str(p.source))} → ${ctx.nodeLabel(str(p.target))}`, detail: "Devretme", tone: "accent", icon: "arrow" };
    case "run.loop":
      return {
        title: `${ctx.nodeLabel(str(p.from))} işi ${ctx.nodeLabel(str(p.to))} adımına geri gönderdi`,
        detail: `${s.round(Number(p.round) || 1)}${p.max_rounds ? ` / ${String(p.max_rounds)}` : ""}${str(p.reason) ? ` · ${clip(str(p.reason), 120)}` : ""}`,
        tone: "warning",
        icon: "loop",
      };
    case "run.limit_wait":
      return { title: "Limit sıfırlanması bekleniyor", detail: str(p.reason) ? clip(str(p.reason)) : undefined, tone: "warning", icon: "pause" };
    case "node.started":
      return { title: `${node()} başladı`, detail: Number(p.attempt) > 1 ? s.round(Number(p.attempt)) : undefined, tone: "neutral", icon: "play" };
    case "node.completed":
      return { title: `${node()} tamamlandı`, detail: str(p.output_preview) ? clip(str(p.output_preview)) : undefined, tone: "success", icon: "check" };
    case "node.failed":
      return { title: `${node()} başarısız oldu`, detail: str(p.error) ? clip(str(p.error)) : undefined, tone: "danger", icon: "x" };
    case "node.skipped":
      return { title: `${node()} atlandı`, tone: "neutral", icon: "dot" };
    case "node.cancelled":
      return { title: `${node()} iptal edildi`, detail: str(p.reason) || undefined, tone: "neutral", icon: "x" };
    case "node.waiting":
      return { title: `${node()} bekliyor`, detail: str(p.reason) || undefined, tone: "warning", icon: "pause" };
    case "node.running":
      return { title: `${node()} sürüyor`, tone: "neutral", icon: "dot" };
    case "node.retry":
      return { title: `${node()} yeniden deneniyor`, tone: "accent", icon: "loop" };
    case "node.progress":
      return { title: `${node()}: ${clip(str(p.status), 120)}`, detail: typeof p.progress === "number" ? `%${Math.round(p.progress)}` : undefined, tone: "neutral", icon: "progress" };
    case "node.session":
      return { title: `${agent()} oturumu açıldı`, detail: [str(p.provider) === "codex" ? "Codex" : str(p.provider) === "claude" ? "Claude" : "", str(p.model)].filter(Boolean).join(" · ") || undefined, tone: "neutral", icon: "agent" };
    case "node.worktree":
      return { title: `${node()} için worktree açıldı`, detail: str(p.branch) || undefined, tone: "neutral", icon: "file" };
    case "node.winner":
      return { title: `Kazanan: ${str(p.label) || str(p.winner)}`, detail: str(p.rationale) ? clip(str(p.rationale)) : undefined, tone: "success", icon: "flag" };
    case "node.provider_switched":
      return { title: `Sağlayıcı değişti: ${str(p.from)} → ${str(p.to)}`, detail: str(p.reason) || undefined, tone: "warning", icon: "alert" };
    case "gate.passed":
      return { title: `${gateName(str(p.gate)) || node()} geçti`, detail: str(p.summary) ? clip(str(p.summary)) : undefined, tone: "success", icon: "gate" };
    case "gate.failed":
      return { title: `${gateName(str(p.gate)) || node()} geçmedi`, detail: str(p.summary) ? clip(str(p.summary)) : undefined, tone: "danger", icon: "gate" };
    case "gate.skipped":
      return { title: `${gateName(str(p.gate)) || node()} atlandı`, detail: str(p.summary) ? clip(str(p.summary)) : undefined, tone: "neutral", icon: "gate" };
    case "gate.loop_exhausted":
      return { title: `${node()}: tur sınırı aşıldı`, detail: `${String(p.rounds ?? "?")}/${String(p.max_rounds ?? "?")}`, tone: "danger", icon: "alert" };
    case "boundary.violation":
      return { title: `${Number(p.count) || 0} sınır ihlali`, tone: "danger", icon: "alert" };
    case "checkpoint.created":
      return { title: `Checkpoint: ${str(p.label)}`, tone: "info", icon: "checkpoint" };
    case "checkpoint.restored":
      return { title: `Checkpoint'e dönüldü: ${str(p.label)}`, tone: "warning", icon: "checkpoint" };
    case "conflict.detected":
      return { title: `${str(p.repo)}: birleştirme çakışması`, detail: Array.isArray(p.conflicts) ? (p.conflicts as unknown[]).slice(0, 3).map(String).join(", ") : undefined, tone: "danger", icon: "alert" };
    case "approval.requested":
      return { title: `Onay istendi: ${str(p.title)}`, detail: str(p.summary) ? clip(str(p.summary)) : undefined, tone: "warning", icon: "approval" };
    case "approval.decided": {
      const status = str(p.status);
      return {
        title: `Onay ${s.approvalStatus[status]?.toLocaleLowerCase("tr") ?? status}`,
        detail: str(p.note) || undefined,
        tone: status === "approved" ? "success" : status === "rejected" ? "danger" : "neutral",
        icon: "approval",
      };
    }
    case "agent.handoff":
      return { title: `${str(p.from) || agent()} → ${str(p.to)}`, detail: str(p.reason) ? clip(str(p.reason)) : undefined, tone: "accent", icon: "arrow" };
    case "agent.session.started":
      return { title: `${agent()} başladı`, detail: str(p.model) || undefined, tone: "neutral", icon: "agent" };
    case "agent.session.ended":
      return { title: `${agent()} oturumu kapandı`, tone: str(p.reason) === "error" ? "danger" : "neutral", icon: "agent" };
    case "agent.status":
      return { title: `${agent()}: ${uiStrings.agentState[str(p.state) as keyof typeof uiStrings.agentState] ?? str(p.state)}`, tone: "neutral", icon: "agent" };
    case "agent.message":
      return { title: `${agent()} yazdı`, detail: clip(str(p.text)), tone: "neutral", icon: "message" };
    case "agent.thinking":
      return { title: `${agent()} düşündü`, detail: clip(str(p.text)), tone: "neutral", icon: "message" };
    case "agent.tool.call":
      return { title: `${agent()}: ${str(p.summary) || str(p.tool)}`, tone: "neutral", icon: "tool" };
    case "agent.tool.result":
      return { title: `${agent()}: araç sonucu`, detail: typeof p.exit_code === "number" ? s.exitCode(p.exit_code) : undefined, tone: p.is_error ? "danger" : "neutral", icon: "tool" };
    case "agent.file.changed":
      return { title: `${agent()}: ${str(p.path)}`, detail: str(p.change), tone: "neutral", icon: "file" };
    case "agent.turn.started":
      return { title: `${agent()} yeni tura başladı`, tone: "neutral", icon: "agent" };
    case "agent.turn.completed":
      return { title: `${agent()} turu bitirdi`, tone: str(p.status) === "error" ? "danger" : "neutral", icon: "agent" };
    case "agent.usage":
      return { title: `${agent()}: kullanım`, tone: "neutral", icon: "dot" };
    case "agent.error":
      return { title: `${agent()} hata verdi`, detail: str(p.message) ? clip(str(p.message)) : undefined, tone: "danger", icon: "alert" };
    case "agent.permission.request":
      return { title: `${agent()} izin istedi`, tone: "warning", icon: "approval" };
    default:
      return { title: ev.type, tone: "neutral", icon: "dot" };
  }
}

const KEY_TYPES = new Set([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.reopened",
  "run.loop",
  "run.edge",
  "run.limit_wait",
  "node.started",
  "node.completed",
  "node.failed",
  "node.waiting",
  "node.retry",
  "node.winner",
  "node.provider_switched",
  "gate.passed",
  "gate.failed",
  "gate.loop_exhausted",
  "boundary.violation",
  "checkpoint.created",
  "checkpoint.restored",
  "conflict.detected",
  "approval.requested",
  "approval.decided",
  "agent.handoff",
  "agent.error",
]);

/** Events shown in the replay's "Önemli" list (the rest is agent chatter). */
export function isKeyEvent(ev: StudioEvent): boolean {
  return KEY_TYPES.has(ev.type);
}
