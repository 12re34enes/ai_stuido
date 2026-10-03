import { Fingerprint, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useState } from "react";

import { Button, Checkbox, CodeBlock, CopyButton, Dialog, EnvBadge } from "@/ui";

import { chunkFingerprint } from "../format";
import { Callout } from "../kit";
import { connStrings as s } from "../strings";
import type { Host } from "../types";

export interface HostKeyProblem {
  code: "host_key_unknown" | "host_key_changed" | "host_key_revoked";
  message: string;
  fingerprint: string | null;
  keyType: string | null;
  hostname: string;
  port: number;
}

function verifyCommand(keyType: string | null): string {
  const t = (keyType ?? "").toLowerCase();
  const file = t.includes("ed25519") ? "ed25519" : t.includes("ecdsa") ? "ecdsa" : t.includes("rsa") ? "rsa" : "ed25519";
  return `ssh-keygen -lf /etc/ssh/ssh_host_${file}_key.pub`;
}

/**
 * Unknown / changed host key (spec §12 "known_hosts sıkı biçimde doğrulanır"). Shows the offered
 * fingerprint and only trusts it after an explicit confirmation; a changed key needs the stronger
 * "replace" confirmation and is styled as a danger.
 */
export function TrustDialog({
  host,
  problem,
  onOpenChange,
  onTrust,
  trusting,
}: {
  host: Host | null;
  problem: HostKeyProblem | null;
  onOpenChange: (open: boolean) => void;
  onTrust: (fingerprint: string, replace: boolean) => void;
  trusting: boolean;
}) {
  const open = Boolean(problem && host);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        problem?.code === "host_key_changed"
          ? s.hosts.trust.changedTitle
          : problem?.code === "host_key_revoked"
            ? s.hosts.trust.revokedTitle
            : s.hosts.trust.unknownTitle
      }
      description={host ? `${host.username}@${problem?.hostname ?? host.hostname}:${problem?.port ?? host.port}` : undefined}
    >
      {open && host && problem && <TrustBody host={host} problem={problem} onCancel={() => onOpenChange(false)} onTrust={onTrust} trusting={trusting} />}
    </Dialog>
  );
}

function TrustBody({
  host,
  problem,
  onCancel,
  onTrust,
  trusting,
}: {
  host: Host;
  problem: HostKeyProblem;
  onCancel: () => void;
  onTrust: (fingerprint: string, replace: boolean) => void;
  trusting: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const changed = problem.code === "host_key_changed";
  const revoked = problem.code === "host_key_revoked";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <EnvBadge environment={host.environment} label={host.name} />
      </div>
      <Callout
        tone={changed || revoked ? "danger" : "warning"}
        icon={changed || revoked ? <ShieldAlert /> : <ShieldQuestion />}
        title={changed ? s.hosts.trust.changedTitle : revoked ? s.hosts.trust.revokedTitle : undefined}
      >
        {revoked ? problem.message : changed ? s.hosts.trust.changedBody : s.hosts.trust.unknownBody}
      </Callout>
      {problem.fingerprint && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-sunken/60 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
              <Fingerprint className="size-3.5" aria-hidden />
              {s.hosts.trust.fingerprint}
              {problem.keyType && <span className="font-mono text-2xs text-fg-faint">· {problem.keyType}</span>}
            </span>
            <CopyButton value={problem.fingerprint} size="xs" />
          </div>
          <p data-testid="host-fingerprint" data-fingerprint={problem.fingerprint} className="flex flex-wrap gap-x-1.5 gap-y-1 font-mono text-[13px] leading-5 text-fg" data-selectable>
            <span className="sr-only">{problem.fingerprint}</span>
            {chunkFingerprint(problem.fingerprint).map((c, i) => (
              <span key={i} aria-hidden className={i === 0 && c.endsWith(":") ? "text-fg-muted" : undefined}>
                {c}
              </span>
            ))}
          </p>
        </div>
      )}
      {!revoked && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-muted">{s.hosts.trust.verifyHow}</span>
          <CodeBlock code={verifyCommand(problem.keyType)} language="bash" copyable />
        </div>
      )}
      {!revoked && (
        <Checkbox
          checked={confirmed}
          onCheckedChange={setConfirmed}
          label={changed ? s.hosts.trust.confirmChanged : s.hosts.trust.confirm}
        />
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel}>
          {s.common.cancel}
        </Button>
        {!revoked && problem.fingerprint && (
          <Button
            variant={changed ? "danger" : "primary"}
            disabled={!confirmed}
            loading={trusting}
            onClick={() => onTrust(problem.fingerprint ?? "", changed)}
          >
            {changed ? s.hosts.trust.replace : s.hosts.trust.trust}
          </Button>
        )}
      </div>
    </div>
  );
}
