import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Keyboard, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { features } from "@/app/routes";
import { useSettings, useUpdateSetting } from "@/lib/queries";
import { variants } from "@/motion/tokens";
import { getShellStatus, isTauri, onGlobalShortcutError, setGlobalShortcut } from "@/native";
import { Badge, Button, cn, Kbd, toast } from "@/ui";

import { Callout, errorMessage, Section, SettingRow } from "@/features/connections/kit";

import { SectionPage } from "../kit";
import { acceleratorLabel, recordShortcut } from "../logic";
import { setStrings as s } from "../strings";

const k = s.shortcuts;
const DEFAULT = "Control+Alt+Space";
const KEY = "shortcuts.global_palette";

function Recorder({ onRecorded, onCancel }: { onRecorded: (accelerator: string, label: string) => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
      <motion.button
        type="button"
        autoFocus
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onKeyDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = recordShortcut(e);
          if (r.kind === "cancel") onCancel();
          else if (r.kind === "error") setError(r.message);
          else if (r.kind === "ok") onRecorded(r.accelerator, r.label);
        }}
        className="flex h-8 min-w-44 items-center justify-center gap-2 rounded-md border border-accent bg-accent-soft px-3 text-sm text-accent shadow-[var(--focus-ring)] outline-none"
        aria-label={k.recording}
        data-testid="shortcut-recorder"
      >
        <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
        {k.recording}
      </motion.button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {s.common.cancel}
      </Button>
      </div>
      <span className={cn("text-2xs", error ? "text-danger" : "text-fg-faint")} role={error ? "alert" : undefined}>
        {error ?? k.recordingHint}
      </span>
    </div>
  );
}

export function ShortcutsSection() {
  const qc = useQueryClient();
  const settings = useSettings();
  const update = useUpdateSetting();
  const shell = useQuery({ queryKey: ["settings", "shell-status"], queryFn: getShellStatus, staleTime: 10_000, retry: false });
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const stored = typeof settings.data?.[KEY] === "string" ? (settings.data[KEY] as string) : DEFAULT;
  const status = shell.data?.globalShortcut ?? null;
  const label = status?.label ?? acceleratorLabel(stored);

  useEffect(() => onGlobalShortcutError((e) => setNativeError(e.message)), []);

  const apply = async (accelerator: string, shown: string) => {
    setRecording(false);
    setSaving(true);
    setNativeError(null);
    try {
      const result = await setGlobalShortcut(accelerator);
      if (result && !result.registered) throw new Error(result.error ?? k.failed);
      update.mutate({ key: KEY, value: accelerator });
      if (result) qc.setQueryData(["settings", "shell-status"], (old: typeof shell.data) => (old ? { ...old, globalShortcut: result } : old));
      toast.success(k.saved(result?.label ?? shown));
    } catch (e) {
      setNativeError(errorMessage(e, k.failed));
    } finally {
      setSaving(false);
    }
  };

  const inApp = [
    { label: k.palette, shortcut: "⌘K" },
    { label: k.newTask, shortcut: "⌘N" },
    { label: k.sidebar, shortcut: "⌃⌘S" },
    ...features.filter((f) => f.shortcut).map((f) => ({ label: f.label, shortcut: f.shortcut ?? "" })),
  ];

  return (
    <SectionPage title={s.sections.shortcuts.title} description={s.sections.shortcuts.description}>
      <Section>
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              {k.global}
              {status && (
                <Badge tone={status.registered ? "success" : "danger"} size="sm" dot>
                  {status.registered ? k.registered : k.notRegistered}
                </Badge>
              )}
            </span>
          }
          description={isTauri() ? k.globalHint : `${k.globalHint} ${s.common.browserOnlyHint}`}
          control={
            <AnimatePresence mode="popLayout" initial={false}>
              {recording ? (
                <motion.div key="rec" {...variants.fade}>
                  <Recorder onRecorded={(acc, l) => void apply(acc, l)} onCancel={() => setRecording(false)} />
                </motion.div>
              ) : (
                <motion.div key="show" {...variants.fade} className="flex items-center gap-2">
                  <Kbd shortcut={label} className="[&>span]:h-6 [&>span]:min-w-6 [&>span]:px-1.5 [&>span]:text-xs" />
                  <Button size="sm" icon={<Keyboard />} loading={saving} onClick={() => setRecording(true)}>
                    {k.record}
                  </Button>
                  {stored !== DEFAULT && (
                    <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => void apply(DEFAULT, acceleratorLabel(DEFAULT))}>
                      {k.reset}
                    </Button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          }
        >
          <AnimatePresence initial={false}>
            {(nativeError || status?.error) && (
              <motion.div key="err" {...variants.fadeUp}>
                <Callout tone="danger" title={k.failed}>
                  {nativeError ?? status?.error}
                </Callout>
              </motion.div>
            )}
          </AnimatePresence>
        </SettingRow>
      </Section>

      <Section title={k.inApp} description={k.inAppHint}>
        <ul className="grid grid-cols-2 divide-line-subtle">
          {inApp.map((x, i) => (
            <li key={x.label} className={cn("flex items-center justify-between gap-3 px-4 py-2.5", i % 2 === 0 && "border-r border-line-subtle", i >= 2 && "border-t border-line-subtle")}>
              <span className="truncate text-sm text-fg">{x.label}</span>
              <Kbd shortcut={x.shortcut} />
            </li>
          ))}
        </ul>
      </Section>
    </SectionPage>
  );
}
