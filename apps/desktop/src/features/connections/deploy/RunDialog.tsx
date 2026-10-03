import { HeartPulse, Rocket, Undo2 } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { stagger, variants } from "@/motion/tokens";
import { Button, Dialog, EnvBadge, Field, Input, Textarea, toast } from "@/ui";

import { useStartDeploy } from "../api";
import { Callout, errorMessage } from "../kit";
import { connStrings as s } from "../strings";
import type { DeployProfile, DeployRun } from "../types";

const r = s.deploy.runDialog;

/**
 * Start a deploy. Production explains the locked approval up front and requires a change
 * summary (spec §14: "kilitli onay, değişiklik özeti, sağlık kontrolü, geri alma").
 */
export function RunDialog({
  profile,
  open,
  onOpenChange,
  onStarted,
}: {
  profile: DeployProfile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted?: (run: DeployRun) => void;
}) {
  return (
    <Dialog
      open={open && profile !== null}
      onOpenChange={onOpenChange}
      size="md"
      title={profile ? r.title(profile.name) : ""}
      description={profile ? `${s.deploy.kind[profile.kind]} · ${s.deploy.kindHint[profile.kind]}` : undefined}
    >
      {open && profile && <RunBody profile={profile} onClose={() => onOpenChange(false)} onStarted={onStarted} />}
    </Dialog>
  );
}

function RunBody({ profile, onClose, onStarted }: { profile: DeployProfile; onClose: () => void; onStarted?: (run: DeployRun) => void }) {
  const start = useStartDeploy();
  const [ref, setRef] = useState("");
  const [summary, setSummary] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const production = profile.environment === "production";
  const summaryError = production && submitted && !summary.trim() ? r.summaryRequired : undefined;

  const submit = () => {
    setSubmitted(true);
    if (production && !summary.trim()) return;
    start.mutate(
      { profileId: profile.id, ref: ref.trim() || undefined, summary: summary.trim() || undefined },
      {
        onSuccess: (run) => {
          toast(
            run.status === "pending_approval"
              ? { title: s.deploy.startedApproval, description: profile.name, tone: "warning" }
              : { title: s.deploy.started, description: profile.name, tone: "success" },
          );
          onClose();
          onStarted?.(run);
        },
      },
    );
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center gap-2">
        <EnvBadge environment={profile.environment} label={profile.name} size="md" />
      </div>
      {production ? (
        <Callout tone="production" title={r.productionTitle}>
          <motion.ol initial="initial" animate="animate" variants={stagger(0.06, 0.1)} className="mt-1 flex flex-col gap-1.5">
            {r.productionSteps.map((step, i) => (
              <motion.li key={i} variants={variants.fadeUp} className="flex gap-2">
                <span className="grid size-4 shrink-0 place-items-center rounded-full bg-env-production text-[10px] font-semibold text-fg-on-accent tabular">{i + 1}</span>
                <span>{step}</span>
              </motion.li>
            ))}
          </motion.ol>
        </Callout>
      ) : (
        profile.kind === "ssh" && <Callout tone="neutral">{r.approvalNeeded}</Callout>
      )}
      <div className="flex flex-wrap gap-2 text-xs text-fg-muted">
        <span className="flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-1">
          <HeartPulse className="size-3.5" aria-hidden />
          {profile.health_check?.url ? s.deploy.healthUrl : profile.health_check?.command ? s.deploy.healthCommand : s.deploy.healthNone}
        </span>
        <span className="flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-1">
          <Undo2 className="size-3.5" aria-hidden />
          {profile.rollback ? s.deploy.rollbackDefined : s.deploy.rollbackNone}
        </span>
      </div>
      <Field label={r.ref} htmlFor="deploy-ref">
        <Input id="deploy-ref" autoFocus value={ref} onChange={(e) => setRef(e.target.value)} placeholder={r.refPlaceholder} spellCheck={false} className="font-mono" />
      </Field>
      <Field label={r.summary} htmlFor="deploy-summary" error={summaryError} required={production}>
        <Textarea id="deploy-summary" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={r.summaryPlaceholder} minRows={3} maxRows={8} invalid={Boolean(summaryError)} />
      </Field>
      {start.isError && (
        <Callout tone="danger" title={s.common.unknownError}>
          {errorMessage(start.error)}
        </Callout>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          {s.common.cancel}
        </Button>
        <Button type="submit" variant={production ? "danger" : "primary"} icon={<Rocket />} loading={start.isPending}>
          {production ? r.submitProduction : r.submit}
        </Button>
      </div>
    </form>
  );
}
