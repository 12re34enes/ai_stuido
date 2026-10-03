import { useState, type ReactNode } from "react";

import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Input } from "./Input";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  loading?: boolean;
  onConfirm: () => void;
  /** Extra content (warnings, options). */
  children?: ReactNode;
  /** The user must type this exact text before confirming (strong confirmations). */
  requireText?: string;
  requireTextLabel?: ReactNode;
  confirmDisabled?: boolean;
  size?: "sm" | "md";
}

/** Destructive / high-stakes confirmation. Optional "type the name to confirm" guard. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  // Remount the body on every open so typed confirmation text never survives a reopen.
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.description}
      size={props.size ?? "sm"}
    >
      {props.open && <ConfirmBody {...props} />}
    </Dialog>
  );
}

function ConfirmBody({
  onOpenChange,
  confirmLabel,
  cancelLabel = "Vazgeç",
  tone = "danger",
  loading,
  onConfirm,
  children,
  requireText,
  requireTextLabel,
  confirmDisabled,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const blocked = Boolean(confirmDisabled) || (requireText !== undefined && typed.trim() !== requireText);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked && !loading) onConfirm();
      }}
    >
      {children}
      {requireText !== undefined && (
        <label className="flex flex-col gap-1.5 text-xs font-medium text-fg">
          {requireTextLabel ?? (
            <span>
              Onaylamak için <code className="rounded-[4px] bg-surface-sunken px-1 py-px font-mono text-xs">{requireText}</code> yazın
            </span>
          )}
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} aria-label="Onay metni" />
        </label>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </Button>
        <Button type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={loading} disabled={blocked} data-testid="confirm">
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
