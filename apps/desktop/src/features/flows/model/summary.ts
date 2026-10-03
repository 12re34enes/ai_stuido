/** One-line Turkish summaries shown under node titles on the canvas (and in pickers). */
import { uiStrings } from "@/ui/strings";

import { s as teamStrings } from "../../teams/strings";

import { gateStrings, mergeStrategyStrings, outputFormatStrings, synthesisFormatStrings } from "../strings";
import type { AgentProfile, DeployProfile, NodeConfig } from "../types";

export interface SummaryContext {
  profiles?: Map<string, AgentProfile>;
  deployProfiles?: Map<string, DeployProfile>;
  /** Saved teams / templates by id (team nodes). */
  teams?: Map<string, { name: string; members: number }>;
  outgoing?: number;
}

const firstLine = (text: string, max = 60) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function modelPart(c: { profile_id: string | null; model: string | null; provider: string | null }, ctx: SummaryContext): string | null {
  if (c.profile_id) return ctx.profiles?.get(c.profile_id)?.name ?? c.profile_id;
  return c.model;
}

export function nodeSummary(config: NodeConfig, ctx: SummaryContext = {}): string {
  switch (config.kind) {
    case "agent": {
      const parts = [uiStrings.agentRole[config.role], modelPart(config, ctx)];
      if (!config.writes) parts.push("salt okuma");
      return parts.filter(Boolean).join(" · ");
    }
    case "advisor":
      return [config.perspective ? firstLine(config.perspective, 40) : "Görüş belgesi", modelPart(config, ctx), config.web_access ? "web" : null]
        .filter(Boolean)
        .join(" · ");
    case "gate":
      if (config.gate === "custom_command") return config.command ? firstLine(config.command, 40) : "Komut girilmedi";
      if (config.gate === "build_test") return config.commands?.length ? config.commands.join(" · ") : "lint · typecheck · test · build";
      if (config.gate === "cross_review") return config.review_focus ? firstLine(config.review_focus, 40) : `En fazla ${config.max_rounds} tur`;
      return gateStrings[config.gate].description.split(";")[0]!.split(".")[0]!;
    case "parallel":
      return ctx.outgoing ? `${ctx.outgoing} dal aynı anda` : "Dallar aynı anda başlar";
    case "join":
      return config.mode === "all" ? "Hepsini bekler" : "İlk biteni bekler";
    case "compare":
      return config.judge === "user" ? "Sen seçersin" : "Hakem ajan seçer";
    case "condition":
      return config.expression.trim() ? firstLine(config.expression, 44) : "İfade yazılmadı";
    case "synthesis":
      return [synthesisFormatStrings[config.output_format], config.devil_advocate ? "karşı tez" : null, modelPart(config, ctx)].filter(Boolean).join(" · ");
    case "merge":
      return `${mergeStrategyStrings[config.strategy]} → ${config.target_ref || "varsayılan branch"}`;
    case "git":
      return config.action === "open_pr" ? `${config.draft ? "Taslak PR" : "PR/MR"}${config.base_ref ? ` → ${config.base_ref}` : ""}` : `Push${config.push_branch_template ? ` → ${firstLine(config.push_branch_template, 30)}` : ""}`;
    case "deploy": {
      if (!config.profile_id) return "Profil seçilmedi";
      const p = ctx.deployProfiles?.get(config.profile_id);
      return p ? p.name : config.profile_id;
    }
    case "human":
      return config.instructions.trim() ? firstLine(config.instructions, 50) : "Talimat yazılmadı";
    case "team": {
      if (config.team) return teamStrings.node.inlineSummary(config.team.members.length);
      if (!config.team_id) return teamStrings.node.noTeamSummary;
      const t = ctx.teams?.get(config.team_id);
      return t ? teamStrings.node.templateSummary(t.name, t.members) : config.team_id;
    }
  }
}

/** Output format label for agent nodes (used in badges). */
export function outputFormatLabel(config: NodeConfig): string | null {
  return config.kind === "agent" && config.output_format !== "text" ? outputFormatStrings[config.output_format] : null;
}
