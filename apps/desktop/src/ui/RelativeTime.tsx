import { useNow } from "@/hooks/useNow";
import { formatDateTime, relativeTime } from "@/i18n/format";

import { Tooltip, type TooltipProps } from "./Tooltip";

export interface RelativeTimeProps {
  value: string | number | Date;
  /** Reference time (ms); defaults to a shared 30 s ticker so the label stays fresh. */
  now?: number;
  className?: string;
  side?: TooltipProps["side"];
}

/** "3 dk. önce" with the exact date and time in a tooltip. */
export function RelativeTime({ value, now, className, side = "top" }: RelativeTimeProps) {
  const ticker = useNow(30_000, now === undefined);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <Tooltip content={formatDateTime(date)} side={side}>
      <time dateTime={date.toISOString()} className={className}>
        {relativeTime(date, new Date(now ?? ticker))}
      </time>
    </Tooltip>
  );
}
