import { createContext, useContext } from "react";

/**
 * Where overlays (popovers, menus, tooltips, dialogs) portal to. Defaults to document.body; a
 * <ThemeScope> provides its own element so overlays inherit the scoped theme.
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
