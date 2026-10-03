/**
 * The live org chart: the same tidy tree as the builder (measured card heights, so subagent trees
 * never collide), links colored by the work on them, one-shot batons for delegation / results /
 * reports / tests, speech bubbles on the advisor link and merge-conflict badges.
 */
import "@xyflow/react/dist/base.css";
import "../chart/chart.css";

import { ReactFlow, useReactFlow, type NodeChange } from "@xyflow/react";
import { Maximize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useReducedMotionPref } from "@/motion/hooks";
import { cn, IconButton } from "@/ui";

import { OrgEdge, type OrgEdgeType } from "../chart/OrgEdge";
import { layoutTeam } from "../model/layout";
import { roleLabel } from "../model/spec";
import { memberStatusStrings, s } from "../strings";
import { useLive } from "./context";
import { arrivals, edgeLiveData } from "./edges";
import { LIVE_CARD_H, LIVE_CARD_W, LiveMemberNode, type LiveNodeType } from "./LiveMemberNode";

const nodeTypes = { live: LiveMemberNode };
const edgeTypes = { org: OrgEdge };
const LAYOUT = { hGap: 36, satGap: 72, vGap: 72 };

function FitButton() {
  const rf = useReactFlow();
  const reduced = useReducedMotionPref();
  return (
    <div className="pointer-events-auto rounded-lg border border-line bg-surface/92 p-0.5 shadow-2 backdrop-blur-md">
      <IconButton size="sm" label={s.builder.fitView} icon={<Maximize2 />} tooltipSide="top" onClick={() => void rf.fitView({ padding: 0.16, duration: reduced ? 0 : 320, maxZoom: 1 })} />
    </div>
  );
}

export function LiveCanvas({ className }: { className?: string }) {
  const { state, selected, select } = useLive();
  const rf = useReactFlow<LiveNodeType, OrgEdgeType>();
  const spec = state.spec;
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [settled, setSettled] = useState(false);
  const fitted = useRef<string>("");

  const layout = useMemo(
    () =>
      spec
        ? layoutTeam(spec, (m) => ({ w: sizes[m.id]?.width ?? LIVE_CARD_W, h: Math.max(LIVE_CARD_H, sizes[m.id]?.height ?? LIVE_CARD_H) }), LAYOUT)
        : null,
    [sizes, spec],
  );

  const names = useMemo(() => new Map((spec?.members ?? []).map((m) => [m.id, m.name])), [spec]);

  const nodes = useMemo<LiveNodeType[]>(() => {
    if (!spec || !layout) return [];
    const arrived = arrivals(state);
    const notes = new Map<string, string>();
    for (const c of state.comms) {
      if (!c.text || (c.kind !== "report" && c.kind !== "advice")) continue;
      notes.set(c.from, c.text);
      if (c.to) notes.set(c.to, c.text);
    }
    return spec.members.map((m) => {
      const live = state.members[m.id];
      const assignment = (live?.assignmentId && state.assignments[live.assignmentId]) || null;
      const running = assignment && (assignment.status === "running" || assignment.status === "testing" || assignment.status === "pending" || assignment.status === "blocked") ? assignment : null;
      return {
        id: m.id,
        type: "live",
        position: layout.positions.get(m.id) ?? { x: 0, y: 0 },
        measured: sizes[m.id],
        data: { member: m, live, assignment: running, verdict: m.role === "tester" ? (state.tests[m.id] ?? null) : null, arrival: arrived.get(m.id) ?? null, note: m.role === "advisor" ? (notes.get(m.id) ?? null) : null, selected: selected === m.id },
        draggable: false,
        selectable: false,
        connectable: false,
        ariaLabel: s.live.statusAria(m.name, `${roleLabel(m)}, ${memberStatusStrings[live?.status ?? "idle"]}`),
      };
    });
  }, [layout, selected, sizes, spec, state]);

  const edges = useMemo<OrgEdgeType[]>(() => {
    const live = edgeLiveData(state, names);
    return state.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: "org",
      data: {
        kind: e.kind,
        side: e.sourceHandle === "r",
        lane: e.lane,
        rise: LIVE_CARD_H / 2 + 26,
        label: e.kind === "advise" ? "rapor/öneri" : e.kind === "test" ? "test eder" : undefined,
        highlight: !!selected && (e.source === selected || e.target === selected),
        ...live.get(e.id),
      },
    }));
  }, [names, selected, state]);

  const onNodesChange = useCallback((changes: NodeChange<LiveNodeType>[]) => {
    const dims = changes.flatMap((c) => (c.type === "dimensions" && c.dimensions ? [[c.id, c.dimensions] as const] : []));
    if (!dims.length) return;
    setSizes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, d] of dims) {
        const p = prev[id];
        if (!p || Math.abs(p.width - d.width) > 0.5 || Math.abs(p.height - d.height) > 0.5) {
          next[id] = d;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Fit once the cards are measured, and again when the team's shape changes.
  const shape = `${spec?.members.length ?? 0}:${Object.keys(sizes).length}`;
  useEffect(() => {
    if (!spec || Object.keys(sizes).length < spec.members.length || fitted.current === String(spec.members.length)) return;
    fitted.current = String(spec.members.length);
    const t = setTimeout(() => {
      void rf.fitView({ padding: 0.14, duration: 0, maxZoom: 1 });
      requestAnimationFrame(() => setSettled(true));
    }, 30);
    return () => clearTimeout(t);
  }, [rf, shape, sizes, spec]);

  return (
    <div className={cn("team-chart relative size-full", settled && "is-settled", className)} data-testid="team-live-canvas">
      <ReactFlow<LiveNodeType, OrgEdgeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => select(n.id === selected ? null : n.id)}
        onPaneClick={() => select(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable
        edgesFocusable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        panActivationKeyCode={null}
        zoomActivationKeyCode={null}
        panOnDrag
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        preventScrolling={false}
        minZoom={0.3}
        maxZoom={1.4}
        proOptions={{ hideAttribution: true }}
        aria-label={s.live.title}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          const id = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node")?.dataset.id;
          if (!id) return;
          e.preventDefault();
          select(id);
        }}
      />
      <div className="pointer-events-none absolute right-3 bottom-3 z-5">
        <FitButton />
      </div>
    </div>
  );
}
