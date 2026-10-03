import { Bot, PenLine, Sparkles, User, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { createElement } from "react";

import { useNow } from "@/hooks/useNow";
import { spring, stagger, variants } from "@/motion/tokens";
import { Badge, cn, RelativeTime, Tooltip } from "@/ui";

import { memoryStrings as s } from "../strings";
import { actorKind } from "../tree";
import type { MemoryCommit } from "../types";

const actorIcons: Record<string, LucideIcon> = { user: User, agent: Bot, external: PenLine, system: Sparkles };
const actorTone: Record<string, string> = {
  user: "bg-accent-soft text-accent",
  agent: "bg-claude-soft text-claude-strong",
  external: "bg-info-soft text-info",
  system: "bg-surface-sunken text-fg-muted",
};

export function ActorAvatar({ actor }: { actor?: string | null }) {
  const kind = actorKind(actor);
  return (
    <Tooltip content={s.actors[kind]} side="right">
      <span className={cn("grid size-6 shrink-0 place-items-center rounded-full [&_svg]:size-3.5", actorTone[kind])} aria-label={s.actors[kind]} role="img">
        {createElement(actorIcons[kind] ?? Sparkles)}
      </span>
    </Tooltip>
  );
}

/** Selectable list of commits (newest first) with actor, message, time and short sha. */
export function CommitList({
  commits,
  selected,
  onSelect,
  showPaths,
  layoutId,
}: {
  commits: MemoryCommit[];
  selected: string | null;
  onSelect: (sha: string) => void;
  showPaths?: boolean;
  layoutId: string;
}) {
  const now = useNow(60_000);
  return (
    <motion.ol className="flex flex-col gap-0.5" initial="initial" animate="animate" variants={stagger(0.025)} aria-label={s.historyTitle}>
      {commits.map((c, i) => {
        const active = selected === c.sha;
        return (
          <motion.li key={c.sha} variants={variants.listItem} className="relative list-none">
            {active && <motion.span layoutId={layoutId} transition={spring.layout} className="absolute inset-0 rounded-lg border border-accent/35 bg-accent-soft/45" />}
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(c.sha)}
              className="relative flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-150 hover:bg-surface-hover/70 focus-visible:shadow-[var(--focus-ring)]"
            >
              <ActorAvatar actor={c.actor} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="line-clamp-2 text-xs leading-[1.45] text-fg">{c.message}</span>
                <span className="flex items-center gap-1.5 text-2xs text-fg-faint">
                  <span className="font-mono">{c.short_sha}</span>
                  <span>·</span>
                  <RelativeTime value={c.committed_at} now={now} />
                </span>
                {showPaths && c.paths.length > 0 && (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {c.paths.slice(0, 3).map((p) => (
                      <span key={p} className="max-w-full truncate rounded bg-surface-sunken px-1.5 py-px font-mono text-2xs text-fg-muted">
                        {p}
                      </span>
                    ))}
                    {c.paths.length > 3 && <span className="text-2xs text-fg-faint">+{c.paths.length - 3}</span>}
                  </span>
                )}
              </span>
              {i === 0 && <Badge tone="success">{s.current}</Badge>}
            </button>
          </motion.li>
        );
      })}
    </motion.ol>
  );
}
