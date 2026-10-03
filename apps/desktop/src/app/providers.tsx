import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

import { motionConfigFor, useAppearance } from "@/lib/appearance";
import { queryClient } from "@/lib/queryClient";
import { spring } from "@/motion/tokens";
import { TooltipProvider } from "@/ui/Tooltip";

export function Providers({ children }: { children: ReactNode }) {
  const reduceMotion = useAppearance((s) => s.reduceMotion);
  return (
    <QueryClientProvider client={queryClient}>
      {/* "user": honour macOS "Reduce motion" (transforms off, fades stay); the app setting can force it. */}
      <MotionConfig reducedMotion={motionConfigFor(reduceMotion)} transition={spring.smooth}>
        <TooltipProvider>{children}</TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
