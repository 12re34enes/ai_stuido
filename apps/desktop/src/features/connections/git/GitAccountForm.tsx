import { ExternalLink, HelpCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { openExternal } from "@/native";
import { stagger, variants } from "@/motion/tokens";
import { Button, Field, Input, SegmentedControl, Sheet, Switch, toast } from "@/ui";

import { useAddGitAccount } from "../api";
import { Callout, errorMessage, KEEP, SecretField, type SecretDraft } from "../kit";
import { hasErrors, tokenPageUrl, validateGitAccount, type GitAccountFormValues } from "../logic";
import { connStrings as s } from "../strings";
import type { HostingKind } from "../types";
import { HostingMark } from "./marks";

const FORM_ID = "git-form";
const f = s.git.form;

/** Add a GitHub / GitLab account with a personal access token (validated by studiod before saving). */
export function GitAccountSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const add = useAddGitAccount();
  const [v, setV] = useState<Omit<GitAccountFormValues, "token">>({ kind: "github", selfHosted: false, server: "", name: "" });
  const [token, setToken] = useState<SecretDraft>(KEEP);
  const [submitted, setSubmitted] = useState(false);
  const [help, setHelp] = useState(true);
  const tokenValue = token.action === "set" ? token.value : "";
  const errors = validateGitAccount({ ...v, token: tokenValue });
  const shown = submitted ? errors : {};
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((old) => ({ ...old, [k]: value }));

  const submit = () => {
    setSubmitted(true);
    if (hasErrors(errors)) return;
    add.mutate(
      { kind: v.kind, token: tokenValue.trim(), api_url: v.selfHosted ? v.server.trim() : null, name: v.name.trim() || null },
      {
        onSuccess: (acc) => {
          toast.success(s.common.created(acc.name), { description: `${s.git.kind[acc.kind]} · ${acc.username}` });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={f.title}
      description={f.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.common.cancel}
          </Button>
          <Button variant="primary" type="submit" form={FORM_ID} loading={add.isPending}>
            {add.isPending ? f.verifying : f.submit}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        className="flex flex-col gap-4 pr-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <AnimatePresence initial={false}>
          {add.isError && (
            <motion.div key="err" {...variants.fadeUp}>
              <Callout tone="danger" title={s.git.verifyFailed}>
                {errorMessage(add.error)}
              </Callout>
            </motion.div>
          )}
        </AnimatePresence>
        <Field label={f.kind}>
          <SegmentedControl<HostingKind>
            aria-label={f.kind}
            fullWidth
            value={v.kind}
            onValueChange={(k) => set("kind", k)}
            options={(["github", "gitlab"] as const).map((k) => ({ value: k, label: s.git.kind[k], icon: <HostingMark kind={k} size={14} /> }))}
          />
        </Field>
        <Switch checked={v.selfHosted} onCheckedChange={(on) => set("selfHosted", on)} label={f.selfHosted} description={f.selfHostedHint} />
        <AnimatePresence initial={false}>
          {v.selfHosted && (
            <motion.div key="server" {...variants.fadeUp}>
              <Field label={f.server} htmlFor="git-server" error={shown.server} required>
                <Input id="git-server" value={v.server} onChange={(e) => set("server", e.target.value)} placeholder={f.serverPlaceholder} invalid={Boolean(shown.server)} spellCheck={false} className="font-mono" />
              </Field>
            </motion.div>
          )}
        </AnimatePresence>
        <SecretField id="git-token" label={f.token} stored={false} draft={token} onChange={setToken} error={shown.token} required placeholder="••••••••••••••••" />
        <Field label={f.name} htmlFor="git-name">
          <Input id="git-name" value={v.name} onChange={(e) => set("name", e.target.value)} placeholder={f.namePlaceholder} />
        </Field>

        <div className="rounded-lg border border-line bg-surface-sunken/50">
          <button
            type="button"
            aria-expanded={help}
            onClick={() => setHelp((h) => !h)}
            className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm font-medium text-fg outline-none focus-visible:shadow-[var(--focus-ring)]"
          >
            <HelpCircle className="size-4 text-fg-muted" aria-hidden />
            {f.helpTitle}
          </button>
          <AnimatePresence initial={false}>
            {help && (
              <motion.div key={v.kind} {...variants.fadeUp} className="flex flex-col gap-3 px-3.5 pb-3.5">
                <motion.ol initial="initial" animate="animate" variants={stagger(0.05)} className="flex flex-col gap-2 text-sm text-fg-muted">
                  {s.git.help[v.kind].map((step, i) => (
                    <motion.li key={i} variants={variants.fadeUp} className="flex gap-2.5">
                      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface text-2xs font-semibold text-fg shadow-1 tabular">{i + 1}</span>
                      <span className="pt-px">{step}</span>
                    </motion.li>
                  ))}
                </motion.ol>
                <Button size="sm" className="self-start" icon={<ExternalLink />} onClick={() => void openExternal(tokenPageUrl(v.kind, v.selfHosted ? v.server : undefined))}>
                  {f.createToken}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </form>
    </Sheet>
  );
}
