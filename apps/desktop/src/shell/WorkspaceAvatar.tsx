import type { Workspace } from "@/lib/types";
import { cn } from "@/ui";

/** Workspace initial on its own color (the color is user data, chosen per workspace). */
export function WorkspaceAvatar({ workspace, size = 24, className }: { workspace: Pick<Workspace, "name" | "color"> | null; size?: number; className?: string }) {
  const initial = (workspace?.name.trim()[0] ?? "?").toLocaleUpperCase("tr-TR");
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, backgroundColor: workspace?.color ?? undefined, fontSize: size * 0.46 }}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-[7px] leading-none font-semibold text-fg-on-accent",
        !workspace && "bg-line-strong",
        className,
      )}
    >
      {initial}
    </span>
  );
}
