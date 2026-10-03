import { Save, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { useBlocker } from "react-router";

import { ApiError } from "@/lib/api";
import { variants } from "@/motion/tokens";
import { Button, Dialog, Input, Kbd, toast } from "@/ui";

import { LazyCodeEditor } from "@/features/studios/code/LazyCodeEditor";
import { useShortcut } from "@/features/studios/hooks";

import { useWriteDoc } from "../api";
import { memoryStrings as s } from "../strings";
import type { MemoryDoc } from "../types";

/** Markdown editor for one memory document; each save is a commit with a message. */
export function DocEditor({ ws, doc, onDone }: { ws: string; doc: MemoryDoc; onDone: () => void }) {
  const [base] = useState(doc.content);
  const [text, setText] = useState(doc.content);
  const [message, setMessage] = useState("");
  const write = useWriteDoc(ws);
  const dirty = text !== base;
  const changedElsewhere = doc.content !== base;

  // Set right before leaving after a successful save, so the guard lets that navigation through.
  const saved = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !saved.current && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search,
  );

  const save = () => {
    if (!dirty || write.isPending) return;
    write.mutate(
      { path: doc.path, content: text, message: message.trim() || undefined },
      {
        onSuccess: (res) => {
          saved.current = true;
          toast.success(s.saved, { description: s.savedHint(res.commit.slice(0, 8)) });
          onDone();
        },
        onError: (err) => toast.error(s.saveFailed, { description: err instanceof ApiError ? err.message : undefined }),
      },
    );
  };
  useShortcut("⌘S", save);

  return (
    <motion.div {...variants.fadeUp} className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {changedElsewhere && (
          <motion.div key="elsewhere" {...variants.fadeUp} role="status" className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-soft/60 px-4 py-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-fg">{s.changedElsewhere}</span>
              <span className="text-xs text-fg-muted">{s.changedElsewhereHint}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="relative h-[calc(100vh-var(--topbar-height)-260px)] min-h-[360px] overflow-hidden rounded-lg border border-line bg-code focus-within:border-accent focus-within:shadow-[var(--focus-ring)]">
        <LazyCodeEditor value={text} onChange={setText} language="markdown" ariaLabel={s.editorLabel(doc.path)} onSave={save} autoFocus className="absolute inset-0" />
        <span className="pointer-events-none absolute right-3 bottom-2.5 rounded-md bg-surface/80 px-2 py-1 text-2xs text-fg-faint backdrop-blur">{s.editorHint}</span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder={s.commitPlaceholder(doc.path)}
          aria-label={s.commitMessage}
          wrapperClassName="flex-1"
        />
        <AnimatePresence initial={false}>
          {dirty && (
            <motion.span key="dirty" {...variants.fade} className="flex items-center gap-1.5 px-1 text-2xs whitespace-nowrap text-fg-muted">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              {s.dirty}
            </motion.span>
          )}
        </AnimatePresence>
        <Button variant="ghost" onClick={onDone} disabled={write.isPending}>
          {s.cancel}
        </Button>
        <Button variant="primary" icon={<Save />} disabled={!dirty} loading={write.isPending} onClick={save} iconRight={<Kbd shortcut="⌘S" tone="accent" className="ml-1" />}>
          {s.save}
        </Button>
      </div>
      <Dialog
        open={blocker.state === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.state === "blocked") blocker.reset();
        }}
        title={s.leaveTitle}
        description={s.leaveDescription}
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.state === "blocked" && blocker.reset()}>
              {s.stay}
            </Button>
            <Button variant="danger" onClick={() => blocker.state === "blocked" && blocker.proceed()}>
              {s.leave}
            </Button>
          </>
        }
      />
    </motion.div>
  );
}
