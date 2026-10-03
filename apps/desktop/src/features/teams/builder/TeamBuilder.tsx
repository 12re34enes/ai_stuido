/**
 * The team builder surface (page or sheet): org-chart canvas with the floating tool row, the
 * inspector, live validation (instant local checks, then the server's), keyboard control and the
 * subtree delete confirmation. Wrap in <BuilderStoreContext> + <ReactFlowProvider>.
 */
import { useReactFlow } from "@xyflow/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { useReducedMotionPref } from "@/motion/hooks";
import { spring, transition } from "@/motion/tokens";
import { Button, cn, Dialog } from "@/ui";
import { isTypingTarget, matchesShortcut } from "@/ui/shortcuts";

import type { AgentProfile } from "../../flows/types";
import { neighborInDirection, type Direction } from "../model/layout";
import { subtreeIds } from "../model/tree";
import { s } from "../strings";
import { Inspector } from "./Inspector";
import { OrgCanvas } from "./OrgCanvas";
import { SummaryChips, ToolRow } from "./parts";
import { useBuilder, useBuilderStore } from "./store";
import { builderFit, useBuilderLayout } from "./useBuilderLayout";

function DeleteConfirm() {
  const store = useBuilderStore();
  const id = useBuilder((st) => st.confirmDelete);
  const spec = useBuilder((st) => st.spec);
  const m = id ? spec.members.find((x) => x.id === id) : undefined;
  const count = id ? subtreeIds(spec, id).length : 0;
  return (
    <Dialog
      open={!!m}
      onOpenChange={(o) => !o && store.getState().cancelDelete()}
      title={m ? s.builder.deleteTitle(m.name, count) : ""}
      description={s.builder.deleteBody}
      footer={
        <>
          <Button variant="ghost" onClick={() => store.getState().cancelDelete()}>
            {s.cancel}
          </Button>
          <Button variant="danger" onClick={() => id && store.getState().remove(id)} data-testid="confirm-delete">
            {s.builder.deleteMember}
          </Button>
        </>
      }
    />
  );
}

/** Keyboard control of the builder; returns a handler (sheet) and installs a window one (page). */
function useBuilderKeys(scope: "page" | "sheet") {
  const store = useBuilderStore();
  const layout = useBuilderLayout();
  const rf = useReactFlow();
  const reduced = useReducedMotionPref();
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  });

  const handle = useCallback(
    (e: KeyboardEvent): boolean => {
      if (e.defaultPrevented || e.isComposing) return false;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[role="menu"],[role="listbox"],[role="dialog"] [role="dialog"]')) return false;
      if (isTypingTarget(e.target)) return false;
      const st = store.getState();
      const sel = st.selected;
      const lead = st.spec.members.find((m) => m.role === "lead")?.id ?? null;
      const run = (fn: () => unknown) => {
        fn();
        return true;
      };
      if (matchesShortcut(e, "⌘Z")) return run(st.undo);
      if (matchesShortcut(e, "⌘⇧Z")) return run(st.redo);
      if (matchesShortcut(e, "⌘D")) return sel ? run(() => st.duplicate(sel)) : false;
      if (matchesShortcut(e, "⇧1")) return run(() => rf.fitView(builderFit(sel !== null || st.panel !== null, reduced ? 0 : 320)));
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === "+" || e.key === "=") return run(() => st.add("worker", sel ?? lead));
      if (e.key === "t" || e.key === "T") return run(() => st.add("dependent", sel ?? lead));
      if ((e.key === "Backspace" || e.key === "Delete") && sel) return run(() => st.requestDelete(sel));
      if (e.key === "Enter") {
        const focused = target?.closest?.<HTMLElement>(".react-flow__node")?.dataset.id;
        return focused ? run(() => st.select(focused)) : false;
      }
      if (e.key === "Escape" && (sel || st.panel)) {
        return run(() => {
          st.select(null);
          st.setPanel(null);
        });
      }
      const dirs: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
      const dir = dirs[e.key];
      if (dir) {
        const next = sel ? neighborInDirection(layoutRef.current, sel, dir) : lead;
        return run(() => next && st.select(next));
      }
      return false;
    },
    [reduced, rf, store],
  );

  useEffect(() => {
    if (scope !== "page") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[role="dialog"]')) return;
      if (handle(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handle, scope]);

  return useCallback(
    (e: ReactKeyboardEvent) => {
      if (scope === "sheet" && handle(e.nativeEvent)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [handle, scope],
  );
}

export interface TeamBuilderProps {
  profiles: AgentProfile[];
  scope?: "page" | "sheet";
  /** Overlay content at the top-right of the canvas, left of the inspector (e.g. version banner). */
  banner?: ReactNode;
  className?: string;
}

export function TeamBuilder({ profiles, scope = "page", banner, className }: TeamBuilderProps) {
  const onKeyDown = useBuilderKeys(scope);
  const onlyLead = useBuilder((st) => st.spec.members.length === 1 && st.spec.members[0]?.role === "lead" && !st.preview);
  const spec = useBuilder((st) => st.spec);
  const [announce, setAnnounce] = useState("");
  return (
    <div className={cn("relative min-h-0 flex-1 overflow-hidden", className)} onKeyDown={onKeyDown} data-testid="team-builder">
      <OrgCanvas onAnnounce={setAnnounce} />
      <div className="pointer-events-none absolute top-3 right-[388px] left-3 z-10 flex items-center gap-3">
        <ToolRow />
        <SummaryChips spec={spec} className="pointer-events-auto min-w-0" />
      </div>
      {banner && <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2">{banner}</div>}
      <div className="pointer-events-none absolute top-3 right-3 bottom-3 z-10 flex flex-col items-end">
        <Inspector profiles={profiles} />
      </div>
      <AnimatePresence>
        {onlyLead && (
          <motion.p
            key="hint"
            className="pointer-events-none absolute bottom-16 left-1/2 z-5 -translate-x-1/2 rounded-full border border-dashed border-line-strong bg-surface/85 px-3 py-1 text-xs text-fg-muted backdrop-blur-sm"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: { ...spring.smooth, delay: 0.4 } }}
            exit={{ opacity: 0, transition: transition.exit }}
            data-testid="builder-empty-hint"
          >
            {s.builder.emptyHint}
          </motion.p>
        )}
      </AnimatePresence>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <DeleteConfirm />
    </div>
  );
}
