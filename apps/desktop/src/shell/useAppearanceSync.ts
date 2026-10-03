import { useEffect } from "react";

import { isReduceMotionPref, isThemePref, useAppearance } from "@/lib/appearance";
import { useSettings } from "@/lib/queries";

/** Applies `appearance.theme` / `appearance.reduce_motion` from studiod settings (live via settings.changed). */
export function useAppearanceSync(): void {
  const { data } = useSettings();
  useEffect(() => {
    if (!data) return;
    const store = useAppearance.getState();
    const theme = data["appearance.theme"];
    if (isThemePref(theme) && theme !== store.theme) store.setTheme(theme);
    const motion = data["appearance.reduce_motion"];
    if (isReduceMotionPref(motion) && motion !== store.reduceMotion) store.setReduceMotion(motion);
  }, [data]);
}
