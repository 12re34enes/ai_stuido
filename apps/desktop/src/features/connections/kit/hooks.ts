import { useEffect, useState } from "react";

/** `value`, updated only after it stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [ms, value]);
  return debounced;
}

/** Scroll the page container to the top when a detail view mounts (in-feature navigation). */
export function useScrollTopOnMount(): (el: HTMLElement | null) => void {
  return (el) => {
    if (!el) return;
    let node: HTMLElement | null = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollTop > 0) {
        node.scrollTop = 0;
        break;
      }
      node = node.parentElement;
    }
  };
}
