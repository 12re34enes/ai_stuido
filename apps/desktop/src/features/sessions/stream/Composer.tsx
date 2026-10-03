/**
 * Message box: Gönder (new turn) while idle, Yönlendir (steer the running turn) while busy,
 * Durdur (interrupt) next to it. ↵ sends, ⇧↵ adds a line, Esc interrupts a running turn.
 */
import { ArrowUp, Check, Eye, Navigation, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { ApiError } from "@/lib/api";
import { spring, transition, variants } from "@/motion/tokens";
import { Button, cn, Kbd, toast } from "@/ui";
import { textareaHeight } from "@/ui/textareaSize";

import { sessionStrings as t } from "../strings";

const c = t.stream.composer;

export interface ComposerProps {
  provider: "claude" | "codex";
  busy: boolean;
  ended: boolean;
  readonly?: boolean;
  compact?: boolean;
  onSend: (text: string) => Promise<unknown>;
  onSteer: (text: string) => Promise<unknown>;
  onInterrupt: () => Promise<unknown>;
  /** DOM id of the textarea (palette commands focus it). */
  inputId?: string;
  /** Changes when the centered column moves (side rail): the box glides along. */
  layoutKey?: string | number | boolean;
}

export function Composer({ provider, busy, ended, readonly, compact, onSend, onSteer, onInterrupt, inputId, layoutKey }: ComposerProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<"send" | "steer" | "interrupt" | null>(null);
  // Inline confirmation in the hint row (a toast would cover the buttons).
  const [flash, setFlash] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(timer);
  }, [flash]);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const claude = provider === "claude";

  // Auto-grow between 1 and 10 rows (6 in compact).
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    el.style.height = "auto";
    const { height, overflow } = textareaHeight({
      scrollHeight: el.scrollHeight,
      lineHeight,
      paddingY: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
      borderY: 0,
      minRows: 1,
      maxRows: compact ? 6 : 10,
    });
    el.style.height = `${height}px`;
    el.style.overflowY = overflow ? "auto" : "hidden";
  }, [compact, text]);

  if (readonly) {
    return (
      <div
        className={cn("flex shrink-0 items-center justify-center gap-2 border-t border-line-subtle text-xs text-fg-muted", compact ? "h-10 px-4" : "h-12 px-8")}
      >
        <Eye className="size-3.5" aria-hidden />
        {c.readonly}
      </div>
    );
  }

  const run = async (kind: "send" | "steer" | "interrupt") => {
    const body = text.trim();
    if (kind !== "interrupt" && !body) return;
    setPending(kind);
    try {
      if (kind === "send") await onSend(body);
      else if (kind === "steer") await onSteer(body);
      else await onInterrupt();
      if (kind !== "interrupt") setText("");
      setFlash((f) => ({ text: kind === "steer" ? c.steered : kind === "interrupt" ? c.interrupted : c.sent, n: (f?.n ?? 0) + 1 }));
    } catch (err) {
      toast.error(c.failed, { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setPending(null);
    }
  };

  const submit = () => void run(busy ? "steer" : "send");

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && busy && !text) {
      e.preventDefault();
      void run("interrupt");
    }
  };

  const empty = !text.trim();
  return (
    <div className={cn("shrink-0", compact ? "px-3 pt-2 pb-3" : "px-8 pt-2 pb-5")}>
      <motion.div
        layout={layoutKey === undefined ? false : "position"}
        layoutDependency={layoutKey}
        transition={spring.layout}
        className={cn(!compact && "mx-auto max-w-[760px]")}
      >
        <div
          className={cn(
            "border bg-surface shadow-1 transition-[border-color,box-shadow] duration-150",
            "focus-within:border-accent focus-within:shadow-[var(--focus-ring)]",
            claude ? "rounded-[16px] border-line" : "rounded-[8px] border-codex-line",
            busy && !claude && "border-codex",
          )}
        >
          <textarea
            ref={area}
            id={inputId}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={c.placeholder}
            placeholder={busy ? c.placeholderBusy : ended ? c.placeholderEnded : c.placeholder}
            className={cn(
              "block w-full resize-none bg-transparent text-fg outline-none focus-visible:shadow-none placeholder:text-fg-faint",
              compact ? "px-3 pt-2.5 pb-1 text-xs leading-[18px]" : "px-4 pt-3 pb-1 text-sm leading-5",
            )}
          />
          <div className={cn("flex items-center justify-between gap-3", compact ? "px-2 pb-2" : "px-2.5 pb-2.5")}>
            <AnimatePresence mode="popLayout" initial={false}>
              {flash ? (
                <motion.span
                  key={`flash-${flash.n}`}
                  {...variants.fadeUp}
                  role="status"
                  className="flex items-center gap-1.5 pl-1.5 text-2xs font-medium text-success"
                >
                  <Check className="size-3.5" aria-hidden />
                  {flash.text}
                </motion.span>
              ) : (
                <motion.span key="hint" {...variants.fade} className="flex items-center gap-1.5 pl-1.5 text-2xs text-fg-faint">
                  <Kbd shortcut="↵" />
                  <span>{busy ? c.steer.toLocaleLowerCase("tr-TR") : c.send.toLocaleLowerCase("tr-TR")}</span>
                  <span aria-hidden className="px-0.5">
                    ·
                  </span>
                  <AnimatePresence mode="popLayout" initial={false}>
                    {busy ? (
                      <motion.span key="esc" {...variants.fade} className="flex items-center gap-1.5">
                        <Kbd shortcut="Esc" />
                        <span>{c.interrupt.toLocaleLowerCase("tr-TR")}</span>
                      </motion.span>
                    ) : (
                      <motion.span key="nl" {...variants.fade} className="flex items-center gap-1.5">
                        <Kbd shortcut="⇧↵" />
                        <span>{c.newline}</span>
                      </motion.span>
                    )}
                  </AnimatePresence>
                </motion.span>
              )}
            </AnimatePresence>
            <div className="flex items-center gap-1.5">
              <AnimatePresence initial={false} mode="popLayout">
                {busy && (
                  <motion.span
                    key="stop"
                    initial={{ opacity: 0, scale: 0.85, x: 8 }}
                    animate={{ opacity: 1, scale: 1, x: 0, transition: spring.snappy }}
                    exit={{ opacity: 0, scale: 0.85, transition: transition.exit }}
                    className="flex"
                  >
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Square className="fill-current" />}
                      loading={pending === "interrupt"}
                      onClick={() => void run("interrupt")}
                    >
                      {c.interrupt}
                    </Button>
                  </motion.span>
                )}
              </AnimatePresence>
              <motion.span layout transition={spring.layout} className="flex">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={empty}
                  loading={pending === "send" || pending === "steer"}
                  icon={busy ? <Navigation /> : <ArrowUp />}
                  onClick={submit}
                >
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span key={busy ? "steer" : "send"} {...variants.fade}>
                      {busy ? c.steer : c.send}
                    </motion.span>
                  </AnimatePresence>
                </Button>
              </motion.span>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
