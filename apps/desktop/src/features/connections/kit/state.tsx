/** Loading / error / unavailable states with Turkish copy, shared by every list in the feature. */
import { AlertTriangle, PlugZap, RefreshCw } from "lucide-react";
import { motion } from "motion/react";

import { isMissingEndpoint } from "@/lib/connection";
import { stagger, variants } from "@/motion/tokens";
import { Button, cn, EmptyState, Skeleton } from "@/ui";

import { errorMessage } from "./errors";

export function ErrorState({
  error,
  onRetry,
  title = "Yüklenemedi",
  size = "md",
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  if (isMissingEndpoint(error)) {
    return (
      <EmptyState
        size={size}
        className={className}
        icon={<PlugZap />}
        title="Bu özellik motorda henüz yok"
        description="studiod güncellendiğinde burada görünecek."
      />
    );
  }
  return (
    <EmptyState
      size={size}
      className={className}
      icon={<AlertTriangle />}
      title={title}
      description={errorMessage(error)}
      action={
        onRetry && (
          <Button size="sm" icon={<RefreshCw />} onClick={onRetry}>
            Tekrar dene
          </Button>
        )
      }
    />
  );
}

/** Row-shaped skeletons that match the list rows (icon tile, two text lines, trailing badges). */
export function ListSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <motion.ul
      aria-busy
      aria-label="Yükleniyor"
      initial="initial"
      animate="animate"
      variants={stagger(0.05)}
      className={cn("divide-y divide-line-subtle overflow-hidden rounded-lg border border-line bg-surface shadow-1", className)}
    >
      {Array.from({ length: rows }, (_, i) => (
        <motion.li key={i} variants={variants.fade} className="flex items-center gap-3.5 px-4 py-3.5">
          <Skeleton className="size-8 rounded-[9px]" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton height={10} width={`${32 + ((i * 17) % 20)}%`} />
            <Skeleton height={8} width={`${48 + ((i * 11) % 24)}%`} />
          </div>
          <Skeleton height={18} width={64} className="rounded-full" />
        </motion.li>
      ))}
    </motion.ul>
  );
}
