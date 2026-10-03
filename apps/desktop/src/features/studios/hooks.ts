/** Small keyboard / lifecycle hooks shared by the studio (and memory) pages. */
import { useEffect, useRef, useState } from "react";

import { isTypingTarget, matchesShortcut } from "@/ui";

/**
 * Bind a page-local shortcut while mounted. Plain keys ("/", "e") never fire while typing;
 * modifier shortcuts ("⌘S", "⌘↵") do, so they work inside fields and editors.
 */
export function useShortcut(shortcut: string, fn: (e: KeyboardEvent) => void, enabled = true): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (!enabled) return;
    const plain = !/[⌘⌃⌥]/.test(shortcut);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (plain && (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey)) return;
      if (!matchesShortcut(e, shortcut)) return;
      e.preventDefault();
      // Modifier shortcuts win over focused widgets (a select trigger would open on ⌘↵).
      if (!plain) e.stopPropagation();
      ref.current(e);
    };
    // Capture phase for modifier shortcuts: handled before the focused element sees the key.
    const capture = !plain;
    window.addEventListener("keydown", onKey, { capture });
    return () => window.removeEventListener("keydown", onKey, { capture });
  }, [enabled, shortcut]);
}

/** Debounced value (validation while typing). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [ms, value]);
  return v;
}
