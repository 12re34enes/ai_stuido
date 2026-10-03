/** Page scaffolding shared by the studio pages: scroll container, back link, section header, error state. */
import { CloudOff, RotateCw } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { ApiError } from "@/lib/api";
import { isUnreachable } from "@/lib/connection";
import { common } from "@/i18n/common";
import { Button, cn, EmptyState } from "@/ui";

/** Each page owns its scroll (the feature animates whole pages in and out). */
export function Page({ children, className, wide, scrollRef }: { children: ReactNode; className?: string; wide?: boolean; scrollRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={scrollRef} className="absolute inset-0 overflow-y-auto overscroll-contain">
      <div className={cn("mx-auto w-full px-8 pt-7 pb-20", wide ? "max-w-[1320px]" : "max-w-[1180px]", className)}>{children}</div>
    </div>
  );
}

export { BackLink } from "@/ui";

export function SectionHeader({ title, count, hint, actions, className, id }: { title: ReactNode; count?: number; hint?: ReactNode; actions?: ReactNode; className?: string; id?: string }) {
  return (
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id={id} className="flex items-baseline gap-2 text-lg text-fg">
          {title}
          {count !== undefined && <span className="font-sans text-sm text-fg-faint tabular">{count}</span>}
        </h2>
        {hint && <p className="text-xs text-fg-muted">{hint}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

function errorMessage(error: unknown): string | undefined {
  if (isUnreachable(error)) return common.backendDown;
  return error instanceof ApiError ? error.message : undefined;
}

export function LoadError({ title, error, onRetry, className }: { title: string; error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <EmptyState
      className={className}
      icon={<CloudOff />}
      title={title}
      description={errorMessage(error)}
      action={
        onRetry && (
          <Button size="sm" icon={<RotateCw />} onClick={onRetry}>
            {common.retry}
          </Button>
        )
      }
    />
  );
}
