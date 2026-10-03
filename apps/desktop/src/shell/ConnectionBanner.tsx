import { WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { useConnection } from "@/lib/connection";
import { variants } from "@/motion/tokens";
import { Button, Spinner } from "@/ui";

import { shellStrings as s } from "./strings";

/** Grace period before warning on startup (studiod may still be booting). */
const STARTUP_GRACE_MS = 2500;

/** Floating Turkish banner while studiod is unreachable; disappears on its own on reconnect. */
export function ConnectionBanner({ onRetry }: { onRetry: () => void }) {
  const status = useConnection((st) => st.status);
  const since = useConnection((st) => st.since);
  const everOnline = useConnection((st) => st.everOnline);
  // The `since` stamp of the offline period whose startup grace has elapsed.
  const [graceOver, setGraceOver] = useState<number | null>(null);
  useEffect(() => {
    if (status !== "offline" || everOnline) return;
    const t = setTimeout(() => setGraceOver(since), STARTUP_GRACE_MS);
    return () => clearTimeout(t);
  }, [everOnline, since, status]);
  const show = status === "offline" && (everOnline || graceOver === since);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-(--z-banner) flex justify-center px-6">
      <AnimatePresence>
        {show && (
          <motion.div
            key="banner"
            role="alert"
            {...variants.banner}
            className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft py-2 pr-2 pl-3 text-xs text-fg shadow-2"
          >
            <WifiOff className="size-4 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 flex-1">{s.connection.banner}</span>
            <Spinner size={14} className="text-warning" label={s.connection.connecting} />
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {s.connection.retry}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
