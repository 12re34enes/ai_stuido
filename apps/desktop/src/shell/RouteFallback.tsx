import { Spinner } from "@/ui";

/** Suspense fallback for lazy pages: appears only if loading takes noticeably long. */
export function RouteFallback() {
  return (
    <div className="grid h-full place-items-center opacity-0 animate-[studio-line-in_200ms_var(--ease-out)_400ms_forwards]">
      <Spinner size={18} className="text-fg-faint" />
    </div>
  );
}
