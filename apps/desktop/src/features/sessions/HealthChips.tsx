/** CLI health (`/api/agents/health`): one quiet chip per provider, details on hover. */
import { motion } from "motion/react";

import { stagger, variants } from "@/motion/tokens";
import { cn, ProviderMark, StatusDot, Tooltip, uiStrings, type DotStatus } from "@/ui";

import { useAgentHealth, type AdapterHealth } from "./api";
import { sessionStrings as t } from "./strings";

function healthStatus(h: AdapterHealth): { dot: DotStatus; text: string } {
  if (!h.installed) return { dot: "error", text: t.health.missing };
  if (h.logged_in === false) return { dot: "waiting", text: t.health.loggedOut };
  if (h.compatible === false) return { dot: "waiting", text: t.health.incompatible };
  return { dot: "success", text: t.health.ok(h.version) };
}

function detail(h: AdapterHealth): string {
  return [h.message, h.binary, h.tested_range ? `Test aralığı: ${h.tested_range}` : null].filter(Boolean).join(" · ") || healthStatus(h).text;
}

export function HealthChips({ hostId = null, className }: { hostId?: string | null; className?: string }) {
  const { data } = useAgentHealth(hostId);
  if (!data?.length) return null;
  return (
    <motion.ul initial="initial" animate="animate" variants={stagger(0.05)} className={cn("flex items-center gap-1.5", className)} aria-label={t.health.title}>
      {data.map((h) => {
        const st = healthStatus(h);
        return (
          <motion.li key={h.provider} variants={variants.listItem} className="list-none">
            <Tooltip content={detail(h)} side="bottom">
              <span
                tabIndex={0}
                aria-label={`${uiStrings.providers[h.provider]}: ${st.text}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface pr-2.5 pl-2 text-2xs text-fg-muted outline-none focus-visible:shadow-[var(--focus-ring)]"
              >
                <ProviderMark provider={h.provider} size={13} label="" />
                <span className="font-medium text-fg">{uiStrings.providers[h.provider]}</span>
                <span className="max-w-[120px] truncate tabular">{h.version ?? st.text}</span>
                <StatusDot status={st.dot} size={10} label={st.text} />
              </span>
            </Tooltip>
          </motion.li>
        );
      })}
    </motion.ul>
  );
}
