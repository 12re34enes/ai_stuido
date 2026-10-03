import { useState } from "react";

import { toast } from "@/ui";

import { useTestDb } from "../api";
import { errorMessage } from "../kit";
import { connStrings as s } from "../strings";
import type { DbProfile, DbTestResult } from "../types";

/** Test a DB profile; result kept per profile for the inline status dot. */
export function useDbTest() {
  const testMut = useTestDb();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, DbTestResult>>({});
  const test = (db: DbProfile, quiet = false) => {
    setTestingId(db.id);
    testMut.mutate(db.id, {
      onSuccess: (r) => {
        setResults((o) => ({ ...o, [db.id]: r }));
        if (quiet) return;
        if (r.ok) toast.success(`${db.name}: ${s.hosts.detail.testOk}`, { description: [r.server_version, r.latency_ms !== null ? `${r.latency_ms} ms` : null].filter(Boolean).join(" · ") || undefined });
        else toast.error(`${db.name}: bağlanılamadı`, { description: r.message });
      },
      onError: (err) => toast.error(`${db.name}: test başarısız`, { description: errorMessage(err) }),
      onSettled: () => setTestingId(null),
    });
  };
  return { test, testingId, results };
}
