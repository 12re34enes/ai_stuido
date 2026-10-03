import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { formatTime } from "@/i18n/format";
import { spring, transition } from "@/motion/tokens";

import { cn } from "./cn";
import { parseAnsi, type AnsiSegment } from "./log/ansi";
import { uiStrings } from "./strings";

export interface LogLine {
  id?: string | number;
  text: string;
  stream?: "stdout" | "stderr" | "system";
  ts?: string;
}

export interface LogViewProps {
  lines: readonly (string | LogLine)[];
  /** Keep scrolled to the newest line while the user is at the bottom (default true). */
  follow?: boolean;
  wrap?: boolean;
  lineNumbers?: boolean;
  timestamps?: boolean;
  emptyLabel?: string;
  /** Row height in px when not wrapping. */
  rowHeight?: number;
  className?: string;
  "aria-label"?: string;
}

const BOTTOM_SLACK = 24;
/** Only the newest lines animate in (older rows remounting during scroll stay still). */
const ANIMATE_TAIL = 40;

const parsed = new Map<string, AnsiSegment[]>();
function segmentsOf(text: string): AnsiSegment[] {
  if (!text.includes("\x1b")) return [{ text }];
  let s = parsed.get(text);
  if (!s) {
    s = parseAnsi(text).segments;
    if (parsed.size > 4000) parsed.clear();
    parsed.set(text, s);
  }
  return s;
}

function segmentStyle(s: AnsiSegment): CSSProperties | undefined {
  if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline && !s.strike && !s.inverse) return undefined;
  const fg = s.inverse ? (s.bg ?? "var(--code-bg)") : s.fg;
  const bg = s.inverse ? (s.fg ?? "var(--fg)") : s.bg;
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ");
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.62 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: deco || undefined,
  };
}

/**
 * Virtualized terminal-style output: ANSI colors, smooth appends (new lines slide in), and
 * stick-to-bottom with a "new lines" pill when the user has scrolled up.
 */
export function LogView({
  lines,
  follow = true,
  wrap = false,
  lineNumbers = false,
  timestamps = false,
  emptyLabel = uiStrings.noOutput,
  rowHeight = 20,
  className,
  ...aria
}: LogViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const [awayAt, setAwayAt] = useState<number | null>(null);
  const [mountCount] = useState(lines.length);
  const count = lines.length;

  // TanStack Virtual is not React-Compiler-memoizable; this component opts out (warning only).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 24,
  });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && follow && stuck) el.scrollTop = el.scrollHeight;
  }, [count, follow, stuck]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (atBottom !== stuck) {
      setStuck(atBottom);
      setAwayAt(atBottom ? null : count);
    }
  };

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setStuck(true);
    setAwayAt(null);
  };

  const unseen = awayAt === null ? 0 : Math.max(0, count - awayAt);
  const digits = String(count).length;

  return (
    <div className={cn("relative min-h-0 overflow-hidden bg-code font-mono text-xs text-fg", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label={aria["aria-label"]}
        aria-live="off"
        data-selectable
        className="size-full overflow-auto overscroll-contain py-2"
      >
        {count === 0 ? (
          <p className="px-3 font-sans text-xs text-fg-faint">{emptyLabel}</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const raw = lines[row.index];
              const line: LogLine = typeof raw === "string" ? { text: raw } : (raw ?? { text: "" });
              const fresh = row.index >= mountCount && row.index >= count - ANIMATE_TAIL;
              return (
                <div
                  key={line.id ?? row.key}
                  data-index={row.index}
                  ref={wrap ? virtualizer.measureElement : undefined}
                  className={cn(
                    "absolute top-0 left-0 flex min-w-full px-3",
                    !wrap && "w-max",
                    fresh && "animate-[studio-line-in_180ms_var(--ease-out)_both]",
                  )}
                  style={{ transform: `translateY(${row.start}px)`, height: wrap ? undefined : rowHeight, lineHeight: `${rowHeight}px` }}
                >
                  {lineNumbers && (
                    <span aria-hidden className="mr-3 shrink-0 text-right text-fg-faint tabular select-none" style={{ width: `${digits + 1}ch` }}>
                      {row.index + 1}
                    </span>
                  )}
                  {timestamps && (
                    <span aria-hidden className="mr-3 shrink-0 text-fg-faint tabular select-none">
                      {line.ts ? formatTime(line.ts) : ""}
                    </span>
                  )}
                  <span
                    className={cn(
                      "min-w-0",
                      wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
                      line.stream === "stderr" && "text-danger",
                      line.stream === "system" && "text-fg-muted italic",
                    )}
                  >
                    {segmentsOf(line.text).map((s, i) => (
                      <span key={i} style={segmentStyle(s)}>
                        {s.text}
                      </span>
                    ))}
                    {line.text === "" && "​"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <AnimatePresence>
        {!stuck && unseen > 0 && (
          <motion.button
            type="button"
            onClick={jump}
            initial={{ opacity: 0, y: 10, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: spring.smooth }}
            exit={{ opacity: 0, y: 6, transition: transition.exit }}
            className="absolute bottom-3 left-1/2 flex items-center gap-1.5 rounded-full bg-fg px-3 py-1 font-sans text-xs font-medium text-canvas shadow-2"
            style={{ x: "-50%" }}
          >
            <ArrowDown className="size-3.5" aria-hidden />
            {uiStrings.newLines(unseen)}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
