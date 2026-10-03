import { Eye, FileQuestion, History, PencilLine } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createElement } from "react";
import { useSearchParams } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { ApiError } from "@/lib/api";
import { variants } from "@/motion/tokens";
import { CopyButton, EmptyState, SegmentedControl, Skeleton, SkeletonText } from "@/ui";

import { LoadError } from "@/features/studios/components/Page";
import { useShortcut } from "@/features/studios/hooks";

import { useMemoryDoc } from "../api";
import { DocEditor } from "../components/DocEditor";
import { DocHistory } from "../components/DocHistory";
import { DocView } from "../components/DocView";
import { layerIcons } from "../links";
import { memoryStrings as s } from "../strings";
import { layerOf } from "../tree";

type Mode = "view" | "edit" | "history";

export function DocPage({ ws, path }: { ws: string; path: string }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("mode");
  const mode: Mode = raw === "edit" || raw === "history" ? raw : "view";
  const doc = useMemoryDoc(ws, path);
  const now = useNow(60_000);
  const setMode = (m: Mode) => setParams(m === "view" ? {} : { mode: m }, { replace: false });
  useShortcut("⌘E", () => setMode("edit"), mode !== "edit" && !!doc.data);

  const layer = doc.data?.layer ?? layerOf(path) ?? "facts";
  // The backend's own NotFound (code "not_found") means the document is gone; a bare 404 means
  // the memory module is not available, which LoadError explains.
  const notFound = doc.error instanceof ApiError && doc.error.status === 404 && doc.error.code === "not_found";

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-10 pt-8 pb-20">
      <header className="flex items-end justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs text-fg-muted">
            <span className="flex text-fg-faint [&_svg]:size-3.5">{createElement(layerIcons[layer])}</span>
            {s.layers[layer]}
          </span>
          {doc.data ? (
            <motion.h2 key={doc.data.path} {...variants.fadeUp} className="truncate text-2xl text-fg">
              {doc.data.title}
            </motion.h2>
          ) : (
            <Skeleton width={280} height={30} />
          )}
          <span className="flex items-center gap-2 text-xs text-fg-faint">
            <span className="font-mono">{path}</span>
            <CopyButton value={path} size="xs" label={s.copyPath} />
            {doc.data?.updated_at && (
              <>
                <span>·</span>
                <span>{s.updated(relativeTime(doc.data.updated_at, new Date(now)))}</span>
              </>
            )}
          </span>
        </div>
        <SegmentedControl
          aria-label={s.view}
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "view", label: s.view, icon: <Eye /> },
            { value: "edit", label: s.edit, icon: <PencilLine />, hint: "⌘E" },
            { value: "history", label: s.docHistory, icon: <History /> },
          ]}
        />
      </header>

      {notFound ? (
        <EmptyState icon={<FileQuestion />} title={s.docNotFound} description={s.docNotFoundHint} className="mt-8" />
      ) : doc.isError && !doc.data ? (
        <LoadError title={s.loadError} error={doc.error} onRetry={() => void doc.refetch()} className="mt-8" />
      ) : !doc.data ? (
        <div className="flex max-w-[72ch] flex-col gap-5" aria-busy>
          <SkeletonText lines={4} />
          <SkeletonText lines={6} />
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={`${path}:${mode}`} {...variants.fade}>
            {mode === "edit" ? (
              <DocEditor ws={ws} doc={doc.data} onDone={() => setMode("view")} />
            ) : mode === "history" ? (
              <DocHistory ws={ws} doc={doc.data} onRestored={() => setMode("view")} />
            ) : (
              <DocView doc={doc.data} onEdit={() => setMode("edit")} />
            )}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}
