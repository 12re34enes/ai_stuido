import { useState, type ReactNode } from "react";

import { toast } from "@/ui";

import { useTestHost, useTrustHost } from "../api";
import { errorMessage } from "../kit";
import { connStrings as s } from "../strings";
import type { Host, HostTestResult } from "../types";
import { TrustDialog, type HostKeyProblem } from "./TrustDialog";

const HOST_KEY_CODES = new Set(["host_key_unknown", "host_key_changed", "host_key_revoked"]);

/** Extract a host-key problem from a failed test (backend `remote/ssh.py::host_key_error`). */
export function hostKeyProblem(host: Host, r: HostTestResult): HostKeyProblem | null {
  if (r.ok || !r.error_code || !HOST_KEY_CODES.has(r.error_code)) return null;
  const d = r.details ?? {};
  return {
    code: r.error_code as HostKeyProblem["code"],
    message: r.message,
    fingerprint: typeof d.fingerprint === "string" ? d.fingerprint : null,
    keyType: typeof d.key_type === "string" ? d.key_type : null,
    hostname: typeof d.hostname === "string" ? d.hostname : host.hostname,
    port: typeof d.port === "number" ? d.port : host.port,
  };
}

/**
 * Connection test with the host-key trust flow: unknown/changed keys open the fingerprint dialog;
 * after trusting, the test runs again automatically. Results are kept per host for inline display.
 */
export function useHostTest(opts: { quiet?: boolean } = {}): {
  test: (host: Host) => void;
  testingId: string | null;
  results: Record<string, HostTestResult>;
  dialog: ReactNode;
} {
  const testMut = useTestHost();
  const trustMut = useTrustHost();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, HostTestResult>>({});
  const [pending, setPending] = useState<{ host: Host; problem: HostKeyProblem } | null>(null);

  const test = (host: Host) => {
    setTestingId(host.id);
    testMut.mutate(host.id, {
      onSuccess: (r) => {
        setResults((old) => ({ ...old, [host.id]: r }));
        const problem = hostKeyProblem(host, r);
        if (problem) setPending({ host, problem });
        else if (!opts.quiet) {
          if (r.ok) toast.success(`${host.name}: ${s.hosts.detail.testOk}`, { description: r.latency_ms !== null ? s.hosts.detail.latency(r.latency_ms) : undefined });
          else toast.error(`${host.name}: bağlanılamadı`, { description: r.message });
        }
      },
      onError: (err) => toast.error(`${host.name}: test başarısız`, { description: errorMessage(err) }),
      onSettled: () => setTestingId(null),
    });
  };

  const dialog = (
    <TrustDialog
      host={pending?.host ?? null}
      problem={pending?.problem ?? null}
      onOpenChange={(o) => !o && setPending(null)}
      trusting={trustMut.isPending}
      onTrust={(fingerprint, replace) => {
        const host = pending?.host;
        if (!host) return;
        trustMut.mutate(
          { id: host.id, fingerprint, replace },
          {
            onSuccess: () => {
              setPending(null);
              toast.success(s.hosts.trust.trusted, { description: `${host.hostname}:${host.port}` });
              test(host);
            },
            onError: (err) => toast.error(s.hosts.trust.trustFailed, { description: errorMessage(err) }),
          },
        );
      }}
    />
  );

  return { test, testingId, results, dialog };
}
