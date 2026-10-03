/**
 * Builder card of a member: provider look (Claude warm + serif, Codex mono + sharp), role glyph,
 * role · model line, effort meter, validation marker, a "+" that adds sub-agents / testers /
 * an advisor (new cards spring in), and drop-target feedback while another card is dragged.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { CircleAlert, FlaskConical, Lightbulb, Plus, TriangleAlert, UserPlus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef } from "react";

import { useShake } from "@/motion/hooks";
import { spring, transition } from "@/motion/tokens";
import { cn, Menu, MenuItem, MenuSeparator, ProviderMark, Tooltip } from "@/ui";

import { EffortMeter, RoleGlyph } from "../chart/glyphs";
import { nameFont, providerRadius, providerRing, providerSurface } from "../chart/looks";
import { roleShort } from "../model/spec";
import { canAdd, canReparent, isManager, type AddKind } from "../model/tree";
import { worstLevel } from "../model/validate";
import { s } from "../strings";
import type { TeamMember } from "../types";
import { useBuilder, useBuilderStore } from "./store";

export const CARD_W = 212;
export const CARD_H = 64;

export interface MemberNodeData extends Record<string, unknown> {
  member: TeamMember;
}

export type MemberNodeType = Node<MemberNodeData, "member">;

const handle = "!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0";

function AddMenu({ member }: { member: TeamMember }) {
  const store = useBuilderStore();
  const spec = useBuilder((st) => st.spec);
  const add = (kind: AddKind) => {
    store.getState().add(kind, member.id);
  };
  const worker = canAdd(spec, "worker", member.id);
  const advisor = canAdd(spec, "advisor", member.id);
  return (
    // React events from the menu's portal bubble through the node: keep them from selecting / dragging it.
    <div className="nodrag nopan" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
    <Menu
      align="center"
      side="bottom"
      trigger={
        <motion.button
          type="button"
          aria-label={s.builder.addMenu(member.name)}
          data-testid={`add-${member.id}`}
          className="nodrag nopan grid size-[22px] place-items-center rounded-full border border-line-strong bg-surface text-fg-muted shadow-1 outline-none transition-colors duration-150 hover:border-accent hover:bg-accent hover:text-fg-on-accent focus-visible:shadow-[var(--focus-ring)] data-[state=open]:border-accent data-[state=open]:bg-accent data-[state=open]:text-fg-on-accent"
          whileTap={{ scale: 0.9 }}
          transition={spring.snappy}
        >
          <Plus className="size-3.5" strokeWidth={2.5} aria-hidden />
        </motion.button>
      }
    >
      <MenuItem icon={<UserPlus />} disabled={!worker.ok} onSelect={() => add("worker")} trailing={!worker.ok ? undefined : "+"}>
        {s.builder.addChild}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<FlaskConical />} onSelect={() => add("dependent")} trailing="T">
        {s.builder.addDependentTester}
      </MenuItem>
      <MenuItem icon={<FlaskConical />} onSelect={() => add("independent")}>
        {s.builder.addIndependentTester}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Lightbulb />} disabled={!advisor.ok} onSelect={() => add("advisor")}>
        {s.builder.addAdvisor}
      </MenuItem>
    </Menu>
    </div>
  );
}

function MemberNodeView({ id, data, dragging }: NodeProps<MemberNodeType>) {
  const m = data.member;
  const selected = useBuilder((st) => st.selected === id);
  const issues = useBuilder((st) => st.issues.byMember[id]);
  const stale = useBuilder((st) => (st.issues.byMember[id] ? st.reportRevision !== st.revision : false));
  const pulse = useBuilder((st) => st.pulse);
  const fresh = useBuilder((st) => st.fresh[id] === true);
  const exiting = useBuilder((st) => st.exiting[id] === true);
  const readOnly = useBuilder((st) => st.preview !== null);
  const drag = useBuilder((st) => st.drag);
  const parentName = useBuilder((st) => {
    const ref = m.role === "tester" && m.test_mode === "dependent" ? m.tests_member_id : m.role === "advisor" ? m.parent_id : null;
    return ref ? (st.spec.members.find((x) => x.id === ref)?.name ?? null) : null;
  });
  const [shakeRef, shake] = useShake<HTMLDivElement>();
  const level = worstLevel(issues);
  const lastPulse = useRef(pulse);
  useEffect(() => {
    if (pulse !== lastPulse.current) {
      lastPulse.current = pulse;
      if (level === "error") shake();
    }
  }, [level, pulse, shake]);

  const dragOther = drag && drag.id !== id;
  const canDrop = useBuilder((st) => (st.drag && st.drag.id !== id ? canReparent(st.spec, st.drag.id, id).ok : false));
  const isOver = dragOther && drag.over === id;
  const dropState = isOver ? (drag.valid ? "valid" : "invalid") : null;
  const issueText = issues?.map((i) => i.message).join("\n");
  const subtitle = [roleShort(m), m.role === "tester" || m.role === "advisor" ? parentName : null, m.profile_id ? null : m.model].filter(Boolean).join(" · ");
  const satellite = m.role === "advisor" || m.role === "tester";

  return (
    <motion.div
      className="group/member relative"
      style={{ width: CARD_W, height: CARD_H }}
      data-testid={`member-${id}`}
      data-role={m.role}
      initial={fresh ? { opacity: 0, scale: 0.6, y: -18 } : false}
      animate={exiting ? { opacity: 0, scale: 0.9, transition: transition.exit } : { opacity: 1, scale: dragging ? 1.03 : 1, y: 0, transition: spring.bouncy }}
    >
      {/* Possible drop target while another card is dragged */}
      <motion.span
        aria-hidden
        className={cn("pointer-events-none absolute -inset-[5px] border-[1.5px] border-dashed border-accent/60", providerRing(m.provider))}
        initial={false}
        animate={{ opacity: canDrop && !isOver ? 1 : 0 }}
        transition={transition.micro}
      />
      {/* Selection / drop-target ring */}
      <motion.span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -inset-[3px] border-[1.5px]",
          providerRing(m.provider),
          dropState === "invalid" ? "border-danger shadow-[0_0_0_4px_var(--danger-soft)]" : "border-accent shadow-[0_0_0_4px_var(--accent-soft)]",
        )}
        initial={false}
        animate={{ opacity: selected || dropState ? 1 : 0, scale: dropState === "valid" ? 1.02 : 1 }}
        transition={spring.snappy}
      />
      <AnimatePresence>
        {level && (
          <motion.span
            key={`pulse-${pulse}`}
            aria-hidden
            className={cn("pointer-events-none absolute inset-0 border-2", providerRadius(m.provider), level === "error" ? "border-danger" : "border-warning")}
            initial={{ opacity: 0.85, scale: 1 }}
            animate={{ opacity: 0, scale: 1.12 }}
            transition={{ duration: 0.9, ease: [0.32, 0.72, 0, 1] }}
          />
        )}
      </AnimatePresence>
      <div
        ref={shakeRef}
        className={cn(
          "relative flex size-full flex-col justify-center gap-1 overflow-hidden border px-3 shadow-1 transition-[border-color,box-shadow,opacity] duration-200",
          providerSurface(m.provider),
          satellite && "border-dashed",
          "group-hover/member:shadow-2",
          dragging && "shadow-3",
          level === "error" && !stale && "border-danger/70",
          level === "warning" && !stale && "border-warning/60",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ProviderMark provider={m.provider} variant="tile" size={20} />
          <span className={cn("min-w-0 flex-1 truncate leading-[18px] text-fg", nameFont(m.provider))}>{m.name || "—"}</span>
          <RoleGlyph member={m} />
        </div>
        <div className="flex min-w-0 items-center gap-2 pl-7">
          <span className="min-w-0 flex-1 truncate text-2xs text-fg-muted">{subtitle}</span>
          {(m.role === "worker" || m.role === "lead") && !m.writes && <span className="shrink-0 text-2xs text-fg-faint">salt okur</span>}
          <EffortMeter provider={m.provider} effort={m.effort} />
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
                data-testid={`issue-${id}`}
                className={cn("grid size-5 place-items-center rounded-full text-fg-on-accent shadow-1 [&_svg]:size-3", level === "error" ? "bg-danger" : "bg-warning")}
              >
                {level === "error" ? <CircleAlert strokeWidth={2.5} /> : <TriangleAlert strokeWidth={2.5} />}
              </span>
            </Tooltip>
          </motion.span>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dropState && (
          <motion.span
            key="drop"
            className={cn(
              "pointer-events-none absolute -top-7 left-1/2 z-20 -translate-x-1/2 rounded-full px-2 py-0.5 text-2xs font-medium whitespace-nowrap shadow-1",
              dropState === "valid" ? "bg-accent text-fg-on-accent" : "bg-danger text-fg-on-accent",
            )}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: spring.snappy }}
            exit={{ opacity: 0, transition: transition.exit }}
          >
            {dropState === "valid" ? s.builder.dropHere(m.name) : (drag?.reason ?? s.builder.dropInvalid)}
          </motion.span>
        )}
      </AnimatePresence>

      {isManager(m) && !readOnly && !drag && (
        <div
          className={cn(
            "absolute -bottom-[11px] left-1/2 z-10 -translate-x-1/2 transition-[opacity,scale] duration-150",
            selected ? "opacity-100" : "scale-75 opacity-0 group-hover/member:scale-100 group-hover/member:opacity-100 focus-within:scale-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100",
          )}
        >
          <AddMenu member={m} />
        </div>
      )}

      <Handle id="t" type="target" position={Position.Top} className={handle} isConnectable={false} />
      <Handle id="l" type="target" position={Position.Left} className={handle} isConnectable={false} />
      <Handle id="b" type="source" position={Position.Bottom} className={handle} isConnectable={false} />
      <Handle id="r" type="source" position={Position.Right} className={handle} isConnectable={false} />
    </motion.div>
  );
}

export const MemberNode = memo(MemberNodeView);
