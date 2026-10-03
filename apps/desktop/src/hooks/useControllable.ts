import { useCallback, useState } from "react";

/**
 * Controlled/uncontrolled state in one hook: uses `value` when provided, otherwise internal state
 * seeded from `defaultValue`. `onChange` fires in both modes.
 */
export function useControllable<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T) => void] {
  const [inner, setInner] = useState<T>(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const set = useCallback(
    (next: T) => {
      if (!controlled) setInner(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [current, set];
}
