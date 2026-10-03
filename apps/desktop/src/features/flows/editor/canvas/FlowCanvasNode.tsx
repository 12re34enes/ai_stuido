/**
 * Canvas node: the FlowNodeCard visual language (provider looks: Claude warm + serif, Codex mono
 * + sharp) with per-kind icons, gate-kind badges, validation markers and editor motion
 * (spring in, quick fade out, error pulse + shake).
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CircleAlert, Lock, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef } from "react";

import { useShake } from "@/motion/hooks";
import { spring, transition } from "@/motion/tokens";
import { Badge, cn, ProviderMark, Tooltip } from "@/ui";

import { kindInfo } from "../../model/kinds";
import type { CanvasNode } from "../../model/graph";
import { worstLevel } from "../../model/issues";
import { nodeSummary, outputFormatLabel } from "../../model/summary";
import { gateStrings } from "../../strings";
import { resolveProvider, useEditorEnv } from "../context";
import { useEditor } from "../store";

const handleClass =
  "size-2.5! rounded-full! border-[1.5px]! border-line-strong! bg-surface! transition-[border-color,background-color] duration-150 " +
  "before:absolute before:-inset-2 before:rounded-full before:content-[''] hover:border-accent! hover:bg-accent-soft!";

function FlowCanvasNodeView({ id, data, selected }: NodeProps<CanvasNode>) {
  const env = useEditorEnv();
  const issues = useEditor((s) => s.issues.byNode[id]);
  // Only nodes with markers care whether the report is stale (keeps drags from re-rendering all nodes).
  const stale = useEditor((s) => (s.issues.byNode[id] ? s.reportRevision !== s.revision : false));
  const pulse = useEditor((s) => s.pulse);
  const exiting = useEditor((s) => s.exiting[id] === true);
  const delay = useEditor((s) => s.introDelays[id] ?? 0);
  const outgoing = useEditor((s) => (data.config.kind === "parallel" ? s.edges.filter((e) => e.source === id).length : 0));
  const [shakeScope, shake] = useShake<HTMLDivElement>();

  const level = worstLevel(issues);
  const lastPulse = useRef(pulse);
  useEffect(() => {
    if (pulse !== lastPulse.current) {
      lastPulse.current = pulse;
      if (level === "error") shake();
    }
  }, [level, pulse, shake]);

  const config = data.config;
  const info = kindInfo(config.kind);
  const Icon = config.kind === "gate" && config.gate === "deploy_approval" ? Lock : info.icon;
  const provider = resolveProvider(config, env.profilesById);
  const isGate = config.kind === "gate";
  const look =
    provider === "claude"
      ? "rounded-xl border-claude-line bg-claude-surface"
      : provider === "codex"
        ? "rounded-[6px] border-codex-line bg-codex-surface"
        : "rounded-lg border-line bg-surface";
  const radius = provider === "claude" ? "rounded-xl" : provider === "codex" ? "rounded-[6px]" : "rounded-lg";
  const summary = nodeSummary(config, { profiles: env.profilesById, deployProfiles: env.deployProfilesById, teams: env.teamsById, outgoing });
  const format = outputFormatLabel(config);
  const issueText = issues?.map((i) => i.message).join("\n");

  return (
    <motion.div
      className="group/node relative w-[220px]"
      data-testid={`flow-node-${id}`}
      data-kind={config.kind}
      initial={{ opacity: 0, scale: 0.9, y: 6 }}
      animate={exiting ? { opacity: 0, scale: 0.94, y: 0, transition: transition.exit } : { opacity: 1, scale: 1, y: 0, transition: { ...spring.smooth, delay } }}
    >
      {/* Selection ring: fades in around the card, radius follows the provider look. */}
      <motion.span
        aria-hidden
        className={cn("pointer-events-none absolute -inset-[3px] border-[1.5px] border-accent shadow-[0_0_0_4px_var(--accent-soft)]", radius === "rounded-[6px]" ? "rounded-[9px]" : radius === "rounded-xl" ? "rounded-[15px]" : "rounded-[11px]")}
        initial={false}
        animate={{ opacity: selected ? 1 : 0, scale: selected ? 1 : 0.985 }}
        transition={spring.snappy}
      />
      {/* One-shot pulse when an explicit validation finds problems here. */}
      <AnimatePresence>
        {level && (
          <motion.span
            key={`pulse-${pulse}`}
            aria-hidden
            className={cn("pointer-events-none absolute inset-0 border-2", radius, level === "error" ? "border-danger" : "border-warning")}
            initial={{ opacity: 0.85, scale: 1 }}
            animate={{ opacity: 0, scale: 1.12 }}
            transition={{ duration: 0.9, ease: [0.32, 0.72, 0, 1] }}
          />
        )}
      </AnimatePresence>
      <div
        ref={shakeScope}
        className={cn(
          "relative flex flex-col gap-1.5 overflow-hidden border px-3 py-2.5 shadow-1 transition-[border-color,box-shadow] duration-200",
          look,
          "group-hover/node:shadow-2",
          level === "error" && !stale && "border-danger/70",
          level === "warning" && !stale && "border-warning/60",
        )}
      >
        <div className="relative flex items-center gap-2">
          {provider ? (
            <ProviderMark provider={provider} variant="tile" size={18} />
          ) : (
            <span
              className={cn(
                "grid size-[18px] shrink-0 place-items-center rounded-[5px] [&_svg]:size-3",
                isGate ? "bg-accent-soft text-accent" : "bg-surface-sunken text-fg-muted",
              )}
            >
              <Icon aria-hidden />
            </span>
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm leading-[18px] text-fg",
              provider === "claude" && "font-serif",
              provider === "codex" && "font-mono text-xs font-medium",
            )}
          >
            {data.label || info.label}
          </span>
        </div>
        <span className="relative truncate text-2xs text-fg-muted">{summary}</span>
        <div className="relative flex min-w-0 items-center gap-1">
          {isGate ? (
            <Badge tone={config.gate === "deploy_approval" ? "warning" : "accent"} icon={config.gate === "deploy_approval" ? <Lock /> : undefined}>
              {gateStrings[config.gate].short}
            </Badge>
          ) : (
            <Badge tone={provider ?? "neutral"}>{info.label}</Badge>
          )}
          {format && <Badge>{format}</Badge>}
          {config.kind === "gate" && config.gate === "deploy_approval" && <span className="truncate text-2xs text-fg-faint">kilitli</span>}
          <span className="ml-auto min-w-0 truncate pl-1 font-mono text-2xs text-fg-faint">{id}</span>
        </div>
      </div>

      <AnimatePresence>
        {level && (
          <motion.span
            key="issue"
            className="absolute -top-2 -right-2 z-10"
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: stale ? 0.55 : 1 }}
            exit={{ scale: 0.4, opacity: 0, transition: transition.exit }}
            transition={spring.bouncy}
          >
            <Tooltip content={<span className="whitespace-pre-line">{issueText}</span>} side="top">
              <span
                role="img"
                aria-label={issueText}
                tabIndex={-1}
                className={cn(
                  "grid size-5 place-items-center rounded-full text-fg-on-accent shadow-1 [&_svg]:size-3",
                  level === "error" ? "bg-danger" : "bg-warning",
                )}
              >
                {level === "error" ? <CircleAlert strokeWidth={2.5} /> : <TriangleAlert strokeWidth={2.5} />}
              </span>
            </Tooltip>
          </motion.span>
        )}
      </AnimatePresence>

      <Handle type="target" position={Position.Left} className={handleClass} />
      <Handle type="source" position={Position.Right} className={handleClass} />
    </motion.div>
  );
}

export const FlowCanvasNode = memo(FlowCanvasNodeView);
