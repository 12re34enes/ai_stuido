import { useState, type ReactNode } from "react";

import { cn } from "./cn";
import { PortalContainerContext } from "./portal";

export interface ThemeScopeProps {
  theme: "light" | "dark";
  className?: string;
  children: ReactNode;
}

/**
 * Renders children in a forced theme, including their overlays (which portal into the scope).
 * Used by the gallery to show light and dark side by side.
 */
export function ThemeScope({ theme, className, children }: ThemeScopeProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div data-theme={theme} className={cn("bg-canvas text-fg", className)}>
      <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
      <div ref={setContainer} data-theme={theme} className="contents" />
    </div>
  );
}
