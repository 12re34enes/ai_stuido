/** Canvas node subtitles / footers / provider styling, shared by the live page and the replay. */
import { useMemo } from "react";

import type { Provider } from "@/lib/types";
import { uiStrings } from "@/ui";

import type { FlowView } from "../graph";
import { s } from "../strings";
import type { GateKind, SessionView } from "../types";
import type { NodeInfo } from "./FlowCanvas";
import { NodeFooter } from "./NodeFooter";

export interface GateSummary {
  node_id: string;
  summary: string;
  attempt: number;
}

export function useNodeInfo({
  view,
  sessions,
  gates,
  progress,
  at,
}: {
  view: FlowView | null;
  sessions: readonly Pick<SessionView, "node_id" | "provider" | "model">[];
  gates?: readonly GateSummary[];
  progress?: ReadonlyMap<string, { status: string; pct: number | null }>;
  at?: number;
}): { info: Record<string, NodeInfo>; providers: Map<string, Provider> } {
  return useMemo(() => {
    const providers = new Map<string, Provider>();
    const models = new Map<string, string>();
    for (const sv of sessions) {
      if (!sv.node_id) continue;
      if (!providers.has(sv.node_id)) providers.set(sv.node_id, sv.provider);
      if (sv.model) models.set(sv.node_id, sv.model);
    }
    const info: Record<string, NodeInfo> = {};
    if (!view) return { info, providers };
    for (const nv of Object.values(view.nodes)) {
      const cfg = nv.node.config;
      const provider = cfg.kind === "gate" ? undefined : (cfg.provider ?? providers.get(nv.id) ?? undefined);
      if (provider) providers.set(nv.id, provider);
      let subtitle: string;
      if (cfg.kind === "agent" || cfg.kind === "advisor" || cfg.kind === "synthesis") {
        const role = cfg.role ?? (cfg.kind === "advisor" ? "advisor" : cfg.kind === "synthesis" ? "synthesizer" : "writer");
        subtitle = models.get(nv.id) ?? cfg.model ?? (cfg.kind === "advisor" && cfg.perspective ? cfg.perspective : uiStrings.agentRole[role]);
      } else if (cfg.kind === "gate") {
        const latestAttempt = nv.run?.attempt ?? 0;
        const gate = nv.stale ? undefined : [...(gates ?? [])].reverse().find((g) => g.node_id === nv.id && g.attempt === latestAttempt);
        const kind = cfg.gate as GateKind | undefined;
        subtitle = gate?.summary || (kind ? (s.gateKind[kind] !== nv.node.label ? s.gateKind[kind] : s.gateHint[kind]) : s.nodeKind.gate);
        if (kind === "custom_command" && !gate && cfg.command) subtitle = `$ ${cfg.command}`;
      } else {
        subtitle = s.nodeKind[cfg.kind];
      }
      const run = nv.stale ? null : nv.run;
      info[nv.id] = {
        provider,
        subtitle,
        footer: (
          <NodeFooter
            status={nv.status}
            attempts={nv.attempts}
            startedAt={run?.started_at}
            finishedAt={run?.finished_at}
            progress={progress?.get(nv.id)?.pct}
            at={at}
          />
        ),
      };
    }
    return { info, providers };
  }, [at, gates, progress, sessions, view]);
}
