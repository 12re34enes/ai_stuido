import { ArrowUpRight } from "lucide-react";
import { motion } from "motion/react";
import { useMemo } from "react";
import { Link } from "react-router";

import { spring, variants } from "@/motion/tokens";
import { Badge, cn } from "@/ui";

import { sharedIds } from "../icons";
import { isBuiltinId, stepCount, studioGates, studioTeam } from "../model";
import { studioStrings as s } from "../strings";
import type { Studio } from "../types";
import { StudioIcon } from "./StudioIcon";
import { GateBadges, TeamMarks } from "./TeamMarks";

const MotionLink = motion.create(Link);

/** "Yerleşik" for an untouched built-in; "v3 · Düzenlendi" for an edited one; "v2 · Özel" for custom studios. */
export function StudioVersionBadges({ studio, className, size = "sm" }: { studio: Studio; className?: string; size?: "sm" | "md" }) {
  const version = studio.version ?? 1;
  const original = studio.builtin !== false;
  const custom = !original && !isBuiltinId(studio.id);
  return (
    <span className={cn("flex items-center gap-1", className)}>
      {!original && (version > 1 || !custom) && (
        <Badge tone="accent" size={size}>
          {s.version(version)}
        </Badge>
      )}
      {original ? (
        <Badge tone="neutral" size={size}>
          {s.builtin}
        </Badge>
      ) : (
        <Badge tone="neutral" variant="outline" size={size}>
          {custom ? s.custom : s.modified}
        </Badge>
      )}
    </span>
  );
}

/**
 * `returning`: this card is where the studio page header flies back to; it skips the entrance
 * fade so the morph stays visible while the other cards fade in.
 */
export function StudioCard({ studio, custom, returning }: { studio: Studio; custom?: boolean; returning?: boolean }) {
  const team = useMemo(() => studioTeam(studio.graph), [studio.graph]);
  const gates = useMemo(() => studioGates(studio.graph), [studio.graph]);
  const steps = stepCount(studio.graph);
  return (
    <motion.li variants={variants.listItem} initial={returning ? false : undefined} className="list-none">
      <MotionLink
        to={`/studios/${encodeURIComponent(studio.id)}`}
        layoutId={sharedIds.surface(studio.id)}
        transition={spring.layout}
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.985 }}
        aria-label={`${studio.name}: ${s.openStudio}`}
        data-studio-card={studio.id}
        className={cn(
          "group relative flex h-full flex-col gap-3 rounded-xl border bg-surface p-4 shadow-1 outline-none",
          "transition-[box-shadow,border-color] duration-200 ease-out hover:border-line-strong hover:shadow-2 focus-visible:shadow-[var(--focus-ring)]",
          custom ? "border-line border-dashed hover:border-solid" : "border-line",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <StudioIcon name={studio.icon} layoutId={sharedIds.icon(studio.id)} />
          <StudioVersionBadges studio={studio} className="pt-0.5" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <motion.h3 layoutId={sharedIds.name(studio.id)} layout="position" transition={spring.layout} className="truncate text-md leading-6 text-fg">
            {studio.name}
          </motion.h3>
          <motion.p layout="position" transition={spring.layout} className="line-clamp-3 text-xs leading-[1.55] text-fg-muted" title={studio.description}>
            {studio.description}
          </motion.p>
        </div>
        <motion.div layout="position" transition={spring.layout} className="mt-auto">
          <GateBadges gates={gates} max={2} interactive={false} className="flex-nowrap justify-start overflow-hidden" />
        </motion.div>
        <motion.div layout="position" transition={spring.layout} className="flex items-center gap-2.5 border-t border-line-subtle pt-3">
          <TeamMarks team={team} interactive={false} />
          <span className="text-2xs whitespace-nowrap text-fg-faint tabular">· {s.steps(steps)}</span>
          <ArrowUpRight
            aria-hidden
            className="ml-auto size-4 -translate-x-1 text-fg-faint opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover:translate-x-0 group-hover:text-accent group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
          />
        </motion.div>
      </MotionLink>
    </motion.li>
  );
}
