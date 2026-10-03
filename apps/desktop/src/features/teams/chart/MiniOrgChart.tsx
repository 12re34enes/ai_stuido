/**
 * Tiny org chart of a team (list cards, the composer's Ekip preview, the flow inspector): provider
 * tiles for the lead and workers, a hollow bulb for advisors, diamonds for testers, elbow links.
 * Rows pop in one after another and links draw themselves; `animated` sends a calm baton from the
 * lead down to a leaf every few seconds (heavy-animation budget, off with reduced motion).
 */
import { animate, motion, useMotionValue } from "motion/react";
import { useEffect, useMemo, useRef } from "react";

import { useHeavyAnimationSlot } from "@/motion/hooks";
import { ease, spring } from "@/motion/tokens";
import { cn } from "@/ui";

import { orgEdges } from "../model/graph";
import { layoutTeam } from "../model/layout";
import { indexTeam } from "../model/tree";
import type { TeamMember, TeamSpec } from "../types";
import { elbowPath, sidePath } from "./paths";

const TILE = 15;
const LEAD = 19;
const MAX_SCALE = 1.6;

function tileSize(m: TeamMember) {
  const d = m.role === "lead" ? LEAD : m.role === "worker" ? TILE : 13;
  return { w: d, h: d };
}

function Tile({ m, x, y, w, row }: { m: TeamMember; x: number; y: number; w: number; row: number }) {
  const cx = x + w / 2;
  const cy = y + w / 2;
  const delay = 0.05 + row * 0.07;
  const common = { initial: { opacity: 0, scale: 0.4 }, animate: { opacity: 1, scale: 1 }, transition: { ...spring.bouncy, delay } };
  const stroke = m.provider === "codex" ? "stroke-codex" : "stroke-claude";
  if (m.role === "advisor") {
    return <motion.circle {...common} cx={cx} cy={cy} r={w / 2 - 0.75} strokeWidth={1.6} strokeDasharray="2.6 2.2" className={cn("fill-surface", stroke)} />;
  }
  if (m.role === "tester") {
    const r = w / 2;
    return <motion.path {...common} d={`M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`} strokeWidth={1.6} strokeLinejoin="round" className={cn("fill-surface", stroke)} />;
  }
  return (
    <motion.g {...common}>
      {m.role === "lead" && <rect x={x - 2.5} y={y - 2.5} width={w + 5} height={w + 5} rx={m.provider === "codex" ? 5 : 7.5} className="fill-accent-soft" />}
      <rect x={x} y={y} width={w} height={w} rx={m.provider === "codex" ? w * 0.22 : w * 0.3} className={m.provider === "codex" ? "fill-codex" : "fill-claude"} />
    </motion.g>
  );
}

export interface MiniOrgChartProps {
  spec: Pick<TeamSpec, "members">;
  className?: string;
  animated?: boolean;
  "aria-label"?: string;
}

export function MiniOrgChart({ spec, className, animated = false, ...aria }: MiniOrgChartProps) {
  const layout = useMemo(() => layoutTeam(spec, tileSize, { hGap: 10, satGap: 10, vGap: 16 }), [spec]);
  const edges = useMemo(() => orgEdges(spec), [spec]);
  const pad = 4;
  const w = Math.max(layout.width, 1) + pad * 2;
  const h = Math.max(layout.height, 1) + pad * 2;

  const pos = (id: string) => {
    const p = layout.positions.get(id) ?? { x: 0, y: 0 };
    const sz = layout.sizes.get(id) ?? { w: TILE, h: TILE };
    return { x: p.x + pad, y: p.y + pad, w: sz.w, h: sz.h };
  };

  const paths = edges.map((e) => {
    const a = pos(e.source);
    const b = pos(e.target);
    const side = e.sourceHandle === "r";
    const d = side ? sidePath(a.x + a.w + 1.5, a.y + a.h / 2, b.x - 1.5, b.y + b.h / 2, e.lane, 12) : elbowPath(a.x + a.w / 2, a.y + a.h + 1.5, b.x + b.w / 2, b.y - 1.5, 3);
    return { e, d, row: layout.rows.get(e.target) ?? 0 };
  });

  // A root → leaf delegation path for the baton.
  const trail = useMemo(() => {
    const idx = indexTeam(spec);
    const out: string[] = [];
    let cur = idx.lead;
    while (cur) {
      out.push(cur.id);
      const kids: TeamMember[] = idx.workers.get(cur.id) ?? [];
      cur = kids[Math.floor(kids.length / 2)] ?? null;
      if (out.length > 6) break;
    }
    return out;
  }, [spec]);

  return (
    <div className={cn("relative", className)}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={aria["aria-label"]}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 m-auto size-full overflow-visible"
        // Small teams don't blow up: at most this much larger than the natural tile size.
        style={{ maxWidth: w * MAX_SCALE, maxHeight: h * MAX_SCALE }}
      >
        {paths.map(({ e, d, row }) => (
          <motion.path
            key={e.id}
            d={d}
            fill="none"
            strokeWidth={1.25}
            strokeLinecap="round"
            strokeDasharray={e.kind === "delegate" ? undefined : "2.5 2.5"}
            className={e.kind === "delegate" ? "stroke-line-strong" : "stroke-fg-faint"}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ pathLength: { duration: 0.4, ease: ease.out, delay: 0.1 + row * 0.07 }, opacity: { duration: 0.1, delay: 0.1 + row * 0.07 } }}
          />
        ))}
        {spec.members.map((m) => {
          const p = pos(m.id);
          return <Tile key={m.id} m={m} x={p.x} y={p.y} w={p.w} row={layout.rows.get(m.id) ?? 0} />;
        })}
        {animated && trail.length > 1 && <TrailBaton points={trail.map((id) => pos(id))} />}
      </svg>
    </div>
  );
}

/** Loops a soft baton down a chain of tiles, pausing between trips. */
function TrailBaton({ points }: { points: { x: number; y: number; w: number; h: number }[] }) {
  const ref = useRef<SVGPathElement>(null);
  const allowed = useHeavyAnimationSlot(true);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const opacity = useMotionValue(0);
  const d = points
    .slice(1)
    .map((b, i) => {
      const a = points[i]!;
      return elbowPath(a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y, 3);
    })
    .join(" ");
  useEffect(() => {
    const p = ref.current;
    if (!allowed || !p) return;
    const len = p.getTotalLength();
    const controls = animate(0, 1, {
      duration: 0.7 * (points.length - 1) + 0.4,
      ease: ease.inOut,
      repeat: Infinity,
      repeatDelay: 2.4,
      onUpdate: (t) => {
        const pt = p.getPointAtLength(t * len);
        x.set(pt.x);
        y.set(pt.y);
        opacity.set(t < 0.08 ? t / 0.08 : t > 0.9 ? Math.max(0, (1 - t) / 0.1) : 1);
      },
    });
    return () => {
      controls.stop();
      opacity.set(0);
    };
  }, [allowed, opacity, points.length, x, y]);
  return (
    <g pointerEvents="none">
      <path ref={ref} d={d} fill="none" stroke="none" />
      {allowed && (
        <motion.g style={{ x, y, opacity }}>
          <circle r={4.5} className="fill-accent opacity-25" />
          <circle r={2.25} className="fill-accent" />
        </motion.g>
      )}
    </g>
  );
}
