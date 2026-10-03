import { useCallback, useLayoutEffect, useRef, type Ref, type TextareaHTMLAttributes } from "react";

import { cn } from "./cn";
import { fieldChrome, fieldState } from "./field";
import { textareaHeight } from "./textareaSize";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with content between minRows and maxRows (default true). */
  autoGrow?: boolean;
  minRows?: number;
  maxRows?: number;
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({
  autoGrow = true,
  minRows = 2,
  maxRows = 12,
  invalid,
  disabled,
  className,
  onInput,
  value,
  ref,
  ...rest
}: TextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = inner.current;
    if (!el || !autoGrow) return;
    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 18;
    el.style.height = "auto";
    const { height, overflow } = textareaHeight({
      scrollHeight: el.scrollHeight,
      lineHeight,
      paddingY: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
      borderY: (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0),
      minRows,
      maxRows,
    });
    el.style.height = `${height}px`;
    el.style.overflowY = overflow ? "auto" : "hidden";
  }, [autoGrow, maxRows, minRows]);

  useLayoutEffect(() => {
    resize();
  }, [resize, value]);

  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  return (
    <textarea
      ref={setRefs}
      rows={minRows}
      value={value}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onInput={(e) => {
        resize();
        onInput?.(e);
      }}
      className={cn(
        fieldChrome,
        fieldState(invalid, disabled),
        "block w-full resize-none px-2.5 py-[7px] text-sm leading-[var(--text-sm-lh)] outline-none",
        "focus:border-accent focus:shadow-[var(--focus-ring)] focus-visible:shadow-[var(--focus-ring)] placeholder:text-fg-faint",
        invalid && "focus:border-danger",
        className,
      )}
      {...rest}
    />
  );
}
