import { History } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { formatDateTime, formatTime } from "@/i18n/format";
import { stagger, variants } from "@/motion/tokens";
import { Badge, EmptyState, Select, Skeleton, Tooltip } from "@/ui";

import { ErrorState, Section } from "@/features/connections/kit";

import { useDeliveryLog } from "../api";
import { SEVERITY_LABEL, SEVERITY_TONE } from "../logic";
import { setStrings as s } from "../strings";
import type { Channel, ChannelKind, DeliveryStatus } from "../types";
import { ChannelTile } from "./channelUi";

const a = s.alerts;
const STATUS_TONE: Record<DeliveryStatus, "success" | "danger" | "neutral" | "warning"> = {
  sent: "success",
  failed: "danger",
  suppressed: "neutral",
  rate_limited: "warning",
  deduplicated: "neutral",
  grouped: "neutral",
};

export function DeliveryLog({ channels }: { channels: Channel[] }) {
  const [status, setStatus] = useState<"" | DeliveryStatus>("");
  const log = useDeliveryLog(status);
  const name = (id: string | null) => channels.find((c) => c.id === id)?.name;
  return (
    <Section
      title={a.log}
      description={a.logHint}
      actions={
        <Select<"" | DeliveryStatus>
          size="sm"
          aria-label={a.logFilter}
          className="w-36"
          value={status}
          onValueChange={setStatus}
          options={[{ value: "", label: a.logAll }, ...(Object.keys(a.status) as DeliveryStatus[]).map((k) => ({ value: k, label: a.status[k] }))]}
        />
      }
    >
      {log.isPending ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton height={12} width="70%" />
          <Skeleton height={12} width="55%" />
        </div>
      ) : log.isError ? (
        <ErrorState size="sm" error={log.error} onRetry={() => void log.refetch()} />
      ) : (log.data ?? []).length === 0 ? (
        <EmptyState size="sm" icon={<History />} title={a.logEmpty} />
      ) : (
        <motion.ul initial="initial" animate="animate" variants={stagger(0.02)} className="max-h-96 divide-y divide-line-subtle overflow-y-auto" aria-label={a.log}>
          {(log.data ?? []).map((e) => (
            <motion.li key={e.id} variants={variants.fade} className="grid grid-cols-[48px_24px_minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2.5">
              <time dateTime={e.created_at} title={formatDateTime(e.created_at)} className="text-xs text-fg-muted tabular">
                {formatTime(e.created_at)}
              </time>
              {e.channel_kind ? <ChannelTile kind={e.channel_kind as ChannelKind} size={24} className="[&_svg]:size-3.5" /> : <span />}
              <div className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm text-fg">{e.title}</span>
                  {e.test && (
                    <Badge tone="neutral" variant="outline" size="sm">
                      {a.testTag}
                    </Badge>
                  )}
                </span>
                <span className="truncate text-2xs text-fg-faint">
                  {name(e.channel_id) ?? e.channel_kind ?? "—"} · <span className="font-mono">{e.event_type}</span>
                  {e.attempts > 1 ? ` · ${e.attempts} deneme` : ""}
                </span>
              </div>
              <Badge tone={SEVERITY_TONE[e.severity]} size="sm">
                {SEVERITY_LABEL[e.severity]}
              </Badge>
              <Tooltip content={e.error ?? ""} side="left" disabled={!e.error}>
                <span className="inline-flex">
                  <Badge tone={STATUS_TONE[e.status]} size="sm" variant={STATUS_TONE[e.status] === "neutral" ? "outline" : "soft"}>
                    {a.status[e.status]}
                  </Badge>
                </span>
              </Tooltip>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </Section>
  );
}
