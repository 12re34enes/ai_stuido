/**
 * Tiny left-to-right diagram of a flow graph (mode / studio / saved flow preview): provider tiles
 * for agents, diamonds for gates, fork lines for parallel branches and one loop arc for the
 * "fails → goes back" edge. A baton runs through the columns and lights each node as it arrives.
 * Re-mount (key) per graph: positions are measured once per mount.
 */
import { GitMerge, GitPullRequest, Lightbulb, Rocket, Scale, ShieldCheck, Sparkles, Split, User, Bot, type LucideIcon } from "lucide-react";
import { animate, motion, useMotionValue, useMotionValueEvent } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useHeavyAnimationSlot } from "@/motion/hooks";
import { ease, spring } from "@/motion/tokens";
import { cn, ProviderMark } from "@/ui";

import { layoutGraph, loopRounds, primaryLoop } from "../list/graph";
import type { FlowGraph, FlowNode, NodeKind } from "../list/types";
import { createStrings as s } from "./strings";

const GLYPH = 24;
const LABEL_H = 26;
const ROW_GAP = 14;
const LOOP_PAD = 26; // room for the loop arc above the nodes
const PLAIN_PAD = 4;
const STEP_S = 0.62; // seconds per column hop
const MAX_COLUMN = 176; // small graphs stay compact and centred

const kindIcon: Partial<Record<NodeKind, LucideIcon>> = {
  agent: Bot,
  advisor: Lightbulb,
  gate: ShieldCheck,
  compare: Scale,
  condition: Split,
  synthesis: Sparkles,
  merge: GitMerge,
  git: GitPullRequest,
  deploy: Rocket,
  human: User,
};

function Glyph({ node, lit }: { node: FlowNode; lit: boolean }) {
  const provider = node.config.provider ?? undefined;
  const kind = node.config.kind;
  const Icon = kindIcon[kind] ?? Bot;
  const gate = kind === "gate";
  return (
    <span className="relative grid place-items-center" style={{ width: GLYPH, height: GLYPH }}>
      <motion.span
        aria-hidden
        className={cn(
          "absolute",
          gate ? "inset-0.5 rotate-45 rounded-[6px]" : provider === "codex" ? "inset-[-4px] rounded-[8px]" : "inset-[-4px] rounded-[10px]",
          provider === "claude" ? "bg-claude-soft" : provider === "codex" ? "bg-codex-soft" : "bg-accent-soft",
        )}
        initial={false}
        animate={{ opacity: lit ? 1 : 0, scale: lit ? 1 : 0.7 }}
        transition={spring.smooth}
      />
      {gate ? (
        <span className="relative grid size-[17px] rotate-45 place-items-center rounded-[4px] border border-line-strong bg-surface shadow-1">
          <Icon className="size-2.5 -rotate-45 text-fg-muted" strokeWidth={2.25} />
        </span>
      ) : provider ? (
        <ProviderMark provider={provider} variant="tile" size={GLYPH - 2} className="relative shadow-1" label="" />
      ) : (
        <span className="relative grid size-[22px] place-items-center rounded-[7px] border border-line bg-surface text-fg-muted shadow-1">
          <Icon className="size-3" strokeWidth={2} />
        </span>
      )}
    </span>
  );
}

interface Point {
  x: number;
  y: number;
}

interface Geometry {
  width: number;
  height: number;
  centers: Record<string, Point>;
}

function edgePath(a: Point, b: Point): string {
  const r = GLYPH / 2 + 5;
  const x1 = a.x + r;
  const x2 = b.x - r;
  if (Math.abs(a.y - b.y) < 0.5) return `M ${x1} ${a.y} L ${x2} ${b.y}`;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${x2} ${b.y}`;
}

function loopPath(from: Point, to: Point): { d: string; apex: Point } {
  const y0 = Math.min(from.y, to.y) - GLYPH / 2 - 4;
  const lift = 20;
  const d = `M ${from.x} ${y0} C ${from.x} ${y0 - lift}, ${to.x} ${y0 - lift}, ${to.x} ${y0}`;
  return { d, apex: { x: (from.x + to.x) / 2, y: y0 - lift * 0.75 } };
}

export interface FlowDiagramProps {
  graph: FlowGraph;
  className?: string;
  "aria-label"?: string;
}

export function FlowDiagram({ graph, className, ...aria }: FlowDiagramProps) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const loop = useMemo(() => primaryLoop(graph, layout), [graph, layout]);
  const rounds = loop ? loopRounds(graph, loop) : null;
  const rootRef = useRef<HTMLDivElement>(null);
  const glyphs = useRef(new Map<string, HTMLElement>());
  const pathRefs = useRef(new Map<string, SVGPathElement>());
  const batonRefs = useRef(new Map<string, SVGGElement>());
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [litColumn, setLitColumn] = useState(-1);
  const columns = layout.columns.length;
  const animated = useHeavyAnimationSlot(columns > 1 && geo !== null);

  // Measure node centers (relative to the root) whenever the root resizes.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const box = root.getBoundingClientRect();
      if (box.width === 0) return;
      const centers: Record<string, Point> = {};
      for (const [id, el] of glyphs.current) {
        const r = el.getBoundingClientRect();
        centers[id] = { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
      }
      setGeo({ width: box.width, height: box.height, centers });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // Baton: one motion value walks 0 → columns; each hop moves batons along that column's edges.
  const t = useMotionValue(0);
  useMotionValueEvent(t, "change", (v) => {
    const hop = Math.floor(v);
    const frac = v - hop;
    const col = frac > 0.92 ? hop + 1 : hop;
    setLitColumn((cur) => (cur === col ? cur : col));
    for (const e of layout.edges) {
      const g = batonRefs.current.get(e.id);
      const p = pathRefs.current.get(e.id);
      if (!g || !p) continue;
      const from = layout.column.get(e.source) ?? 0;
      if (from !== hop || v >= columns - 1) {
        g.style.opacity = "0";
        continue;
      }
      const len = p.getTotalLength();
      const pt = p.getPointAtLength(smooth(frac) * len);
      g.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
      g.style.opacity = String(frac < 0.12 ? frac / 0.12 : frac > 0.88 ? Math.max(0, (1 - frac) / 0.12) : 1);
    }
  });

  useEffect(() => {
    if (!animated) return;
    const total = columns - 1;
    const controls = animate(t, [0, total + 0.999], {
      duration: STEP_S * total + 0.6,
      ease: "linear",
      repeat: Infinity,
      repeatDelay: 0.9,
    });
    return () => {
      controls.stop();
      t.set(0);
    };
  }, [animated, columns, t]);

  const rowsMax = Math.max(1, ...layout.columns.map((c) => c.length));
  const blockH = GLYPH + 6 + LABEL_H;
  const topPad = loop ? LOOP_PAD : PLAIN_PAD;
  const height = topPad + rowsMax * blockH + (rowsMax - 1) * ROW_GAP + 4;
  const loopGeo = loop && geo?.centers[loop.source] && geo.centers[loop.target] ? loopPath(geo.centers[loop.source]!, geo.centers[loop.target]!) : null;

  return (
    <div
      ref={rootRef}
      className={cn("relative mx-auto w-full", className)}
      style={{ height, maxWidth: Math.max(1, columns) * MAX_COLUMN }}
      role="img"
      aria-label={aria["aria-label"]}
    >
      {geo && (
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={geo.width} height={geo.height} aria-hidden>
          {layout.edges.map((e, i) => {
            const a = geo.centers[e.source];
            const b = geo.centers[e.target];
            if (!a || !b) return null;
            const d = edgePath(a, b);
            return (
              <g key={e.id}>
                <motion.path
                  ref={(el) => {
                    if (el) pathRefs.current.set(e.id, el);
                    else pathRefs.current.delete(e.id);
                  }}
                  d={d}
                  fill="none"
                  strokeWidth={1.25}
                  strokeLinecap="round"
                  className="stroke-line-strong"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ pathLength: { duration: 0.42, ease: ease.out, delay: 0.06 + i * 0.035 }, opacity: { duration: 0.1, delay: 0.06 + i * 0.035 } }}
                />
                {animated && (
                  <g
                    ref={(el) => {
                      if (el) batonRefs.current.set(e.id, el);
                      else batonRefs.current.delete(e.id);
                    }}
                    style={{ opacity: 0 }}
                  >
                    <circle r={5.5} className="fill-accent opacity-20" />
                    <circle r={2.75} className="fill-accent" />
                  </g>
                )}
              </g>
            );
          })}
          {loopGeo && (
            <motion.path
              d={loopGeo.d}
              fill="none"
              strokeWidth={1.25}
              strokeDasharray="2.5 3.5"
              strokeLinecap="round"
              className="stroke-fg-faint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.9 }}
              transition={{ duration: 0.3, delay: 0.3 }}
            />
          )}
        </svg>
      )}
      {loopGeo && (
        <motion.span
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-canvas px-1.5 text-2xs leading-4 whitespace-nowrap text-fg-faint"
          style={{ left: loopGeo.apex.x, top: loopGeo.apex.y }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.32 }}
        >
          ↺ {s.mode.loop(rounds)}
        </motion.span>
      )}
      <div
        className="absolute inset-x-0 bottom-0 grid"
        style={{ top: topPad, gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }}
      >
        {layout.columns.map((col, ci) => (
          <div key={ci} className="flex flex-col items-center justify-center" style={{ rowGap: ROW_GAP }}>
            {col.map((node, ni) => (
              <motion.div
                key={node.id}
                className="flex w-full flex-col items-center gap-1.5 px-1"
                initial={{ opacity: 0, scale: 0.85, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ ...spring.smooth, delay: ci * 0.04 + ni * 0.02 }}
              >
                <span
                  ref={(el) => {
                    if (el) glyphs.current.set(node.id, el);
                    else glyphs.current.delete(node.id);
                  }}
                  className="grid place-items-center"
                >
                  <Glyph node={node} lit={animated && litColumn === ci} />
                </span>
                <span
                  className={cn(
                    "line-clamp-2 w-full text-center text-2xs leading-[13px] transition-colors duration-200",
                    animated && litColumn === ci ? "text-fg" : "text-fg-muted",
                  )}
                  style={{ height: LABEL_H }}
                  title={node.label}
                >
                  {node.label}
                </span>
              </motion.div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ease-in-out for the baton along one hop. */
function smooth(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}
