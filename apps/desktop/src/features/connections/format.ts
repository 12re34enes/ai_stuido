/** Display helpers shared by the connection views (pure; unit-tested in format.test.ts). */
import { GitBranch, Server, SquareTerminal } from "lucide-react";

import { actorKind } from "./logic";
import { connStrings as s } from "./strings";
import type { DbProfile, DeployKind, DeployRun, Host } from "./types";

export function hostAddress(h: Pick<Host, "username" | "hostname" | "port">): string {
  return `${h.username}@${h.hostname}${h.port === 22 ? "" : `:${h.port}`}`;
}

export function dbTarget(db: Pick<DbProfile, "kind" | "host" | "port" | "database" | "username">): string {
  if (db.kind === "sqlite") return db.database ?? "—";
  const user = db.username ? `${db.username}@` : "";
  const port = db.port ? `:${db.port}` : "";
  const name = db.database ? `/${db.database}` : "";
  return `${user}${db.host ?? "?"}${port}${name}`;
}

/** Display text for one result cell (NULL, JSON for objects, plain otherwise). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function toTsv(columns: string[], rows: unknown[][]): string {
  const esc = (t: string) => t.replace(/[\t\n\r]/g, " ");
  return [columns.map(esc).join("\t"), ...rows.map((r) => r.map((v) => esc(v === null || v === undefined ? "" : cellText(v))).join("\t"))].join("\n");
}

export const deployKindIcon: Record<DeployKind, typeof GitBranch> = { ci: GitBranch, ssh: Server, command: SquareTerminal };

/** Latest run per profile (runs arrive newest first). */
export function latestRuns(runs: DeployRun[] | undefined): Map<string, DeployRun> {
  const out = new Map<string, DeployRun>();
  for (const r of runs ?? []) if (!out.has(r.profile_id)) out.set(r.profile_id, r);
  return out;
}

/** "[HH:MM:SS] text" lines of a stored deploy log. */
export function logLines(log: string): string[] {
  return log ? log.split("\n") : [];
}

/** Stamp a live `deploy.log` line the way the server stamps stored lines (UTC HH:MM:SS). */
export function stampLine(ts: string, line: string): string {
  const time = /T(\d{2}:\d{2}:\d{2})/.exec(ts)?.[1] ?? "";
  return time ? `[${time}] ${line}` : line;
}

/** Group a SHA256 fingerprint into chunks of 4 (easier to compare aloud). */
export function chunkFingerprint(fp: string): string[] {
  const i = fp.indexOf(":");
  const prefix = i >= 0 ? fp.slice(0, i + 1) : "";
  const body = i >= 0 ? fp.slice(i + 1) : fp;
  const chunks = body.match(/.{1,4}/g) ?? [];
  return prefix ? [prefix, ...chunks] : chunks;
}

/** Who approved: "user" is the person at this Mac; channel identities are shown as given. */
export function approverLabel(who: string): string {
  return who === "user" ? s.audit.actor.user : who;
}

export function actorLabel(actor: string): string {
  const k = actorKind(actor);
  if (k.kind === "agent") return s.audit.actor.agent(k.id ?? "");
  return k.kind === "system" ? s.audit.actor.system : s.audit.actor.user;
}
