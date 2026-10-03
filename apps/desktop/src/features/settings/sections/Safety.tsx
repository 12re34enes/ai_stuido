import { Ban, Eye, Frame, Laptop, ShieldAlert, ShieldCheck, Stamp } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { useSettings, useUpdateSetting } from "@/lib/queries";
import { stagger, variants } from "@/motion/tokens";
import { Badge, Checkbox, Skeleton, Switch, toast } from "@/ui";

import { Callout, ConfirmDialog, errorMessage, Section } from "@/features/connections/kit";

import { SectionPage } from "../kit";
import { setStrings as s } from "../strings";

const KEY = "safety.remote_production_approvals";
const icons = [Frame, Eye, Stamp, Ban, Laptop];
const f = s.safety;

export function SafetySection() {
  const settings = useSettings();
  const update = useUpdateSetting();
  const [confirming, setConfirming] = useState(false);
  const [checks, setChecks] = useState<boolean[]>([false, false, false]);
  const enabled = settings.data?.[KEY] === true;

  const write = (value: boolean) =>
    update.mutate(
      { key: KEY, value },
      {
        onSuccess: () => {
          setConfirming(false);
          if (value) toast.warning(f.enabledToast);
          else toast.success(f.disabledToast);
        },
        onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }),
      },
    );

  return (
    <SectionPage title={s.sections.safety.title} description={s.sections.safety.description}>
      <Section title={f.rulesTitle}>
        <motion.ul initial="initial" animate="animate" variants={stagger(0.04)} className="divide-y divide-line-subtle">
          {f.rules.map((r, i) => {
            const Icon = icons[i] ?? ShieldCheck;
            return (
              <motion.li key={r.title} variants={variants.listItem} className="flex items-start gap-3.5 px-4 py-3">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-env-production-soft text-env-production">
                  <Icon className="size-3.5" strokeWidth={2.25} aria-hidden />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-fg">{r.title}</span>
                  <span className="text-sm text-fg-muted">{r.body}</span>
                </div>
              </motion.li>
            );
          })}
        </motion.ul>
      </Section>

      <Section>
        <div className="flex items-start justify-between gap-6 px-4 py-4">
          <div className="flex min-w-0 gap-3.5">
            <span className={enabled ? "mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-env-production text-fg-on-accent" : "mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-success-soft text-success"}>
              {enabled ? <ShieldAlert className="size-4" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                {f.remoteTitle}
                {settings.data && (
                  <Badge tone={enabled ? "danger" : "success"} size="sm" dot>
                    {enabled ? f.on : f.off}
                  </Badge>
                )}
              </span>
              <span className="text-sm text-fg-muted">{f.remoteBody}</span>
            </div>
          </div>
          {settings.data ? (
            <Switch
              aria-label={f.remoteTitle}
              checked={enabled}
              onCheckedChange={(on) => {
                if (on) {
                  setChecks([false, false, false]);
                  setConfirming(true);
                } else write(false);
              }}
            />
          ) : (
            <Skeleton width={32} height={18} className="rounded-full" />
          )}
        </div>
      </Section>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        size="md"
        title={f.confirmTitle}
        confirmLabel={f.confirm}
        loading={update.isPending}
        requireText={f.confirmType}
        confirmDisabled={!checks.every(Boolean)}
        onConfirm={() => write(true)}
      >
        <Callout tone="production" title={f.remoteTitle}>
          {f.confirmBody}
        </Callout>
        <div className="flex flex-col gap-2.5">
          {f.confirmChecks.map((text, i) => (
            <Checkbox key={i} checked={checks[i] ?? false} onCheckedChange={(on) => setChecks((c) => c.map((x, j) => (j === i ? on : x)))} label={text} />
          ))}
        </div>
      </ConfirmDialog>
    </SectionPage>
  );
}
