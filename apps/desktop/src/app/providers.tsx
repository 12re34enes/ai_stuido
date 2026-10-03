import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

import { queryClient } from "@/lib/queryClient";
import { spring } from "@/motion/tokens";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {/* reducedMotion="user": honour macOS "Reduce motion" (transforms off, fades stay). */}
      <MotionConfig reducedMotion="user" transition={spring.smooth}>
        {children}
      </MotionConfig>
    </QueryClientProvider>
  );
}
