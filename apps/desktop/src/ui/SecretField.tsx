import { Eye, EyeOff, KeyRound, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { variants } from "@/motion/tokens";
import { Button } from "./Button";
import { cn } from "./cn";
import { IconButton } from "./IconButton";
import { Field, Input } from "./Input";

import { KEEP, type SecretDraft } from "./secret";

export interface SecretFieldProps {
  id: string;
  label: string;
  /** A value already exists in the Keychain (only a flag comes from the API). */
  stored: boolean;
  draft: SecretDraft;
  onChange: (draft: SecretDraft) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Allow removing a stored value. */
  removable?: boolean;
  autoFocus?: boolean;
}

/**
 * Write-only secret input. A stored secret is never displayed: the field shows a "kept in the
 * Keychain" chip with Change / Remove. New values are sent once on save.
 */
export function SecretField({ id, label, stored, draft, onChange, placeholder, hint, error, required, removable = true, autoFocus }: SecretFieldProps) {
  const [reveal, setReveal] = useState(false);
  const editing = !stored || draft.action === "set";
  const value = draft.action === "set" ? draft.value : "";
  return (
    <Field label={label} htmlFor={editing ? id : undefined} hint={hint ?? "Bir kez gönderilir, Anahtar Zinciri'nde saklanır ve bir daha gösterilmez."} error={error} required={required}>
      <AnimatePresence mode="popLayout" initial={false}>
        {editing ? (
          <motion.div key="edit" {...variants.fade} className="flex items-center gap-2">
            <Input
              id={id}
              type={reveal ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              autoFocus={autoFocus || (stored && draft.action === "set")}
              value={value}
              invalid={Boolean(error)}
              placeholder={placeholder}
              wrapperClassName="flex-1"
              className="font-mono"
              onChange={(e) => onChange(e.target.value ? { action: "set", value: e.target.value } : stored ? { action: "set", value: "" } : KEEP)}
              trailing={
                <IconButton
                  size="xs"
                  label={reveal ? "Gizle" : "Göster"}
                  icon={reveal ? <EyeOff /> : <Eye />}
                  onClick={() => setReveal((r) => !r)}
                  tooltip={false}
                />
              }
            />
            {stored && (
              <Button size="sm" variant="ghost" onClick={() => onChange(KEEP)}>
                Vazgeç
              </Button>
            )}
          </motion.div>
        ) : (
          <motion.div
            key={draft.action}
            {...variants.fade}
            className={cn(
              "flex h-8 items-center gap-2 rounded-md border border-dashed px-2.5 text-sm",
              draft.action === "clear" ? "border-danger/40 bg-danger-soft/50 text-danger" : "border-line-strong bg-surface-sunken/60 text-fg-muted",
            )}
          >
            <KeyRound className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{draft.action === "clear" ? "Kaydedince kaldırılacak" : "Anahtar Zinciri'nde kayıtlı"}</span>
            {draft.action === "clear" ? (
              <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => onChange(KEEP)}>
                Geri al
              </Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => onChange({ action: "set", value: "" })}>
                  Değiştir
                </Button>
                {removable && (
                  <Button size="sm" variant="ghost" onClick={() => onChange({ action: "clear" })}>
                    <span className="text-danger">Kaldır</span>
                  </Button>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Field>
  );
}
