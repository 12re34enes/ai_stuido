/** Pure helpers for the composer's repo picker. */
import { createStrings as s } from "./strings";
import type { Repo } from "./types";

/** "~/src/app" instead of "/Users/me/src/app". */
export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

export function repoSummary(repos: Repo[], value: string[] | null): string {
  if (repos.length === 0) return s.repos.none;
  if (value === null) return repos.length === 1 ? repos[0]!.name : s.repos.all;
  if (value.length === 1) return repos.find((r) => r.id === value[0])?.name ?? s.repos.count(1);
  return s.repos.count(value.length);
}

/** Toggle one repo; returns null when every repo ends up selected (= all). */
export function toggleRepo(repos: Repo[], value: string[] | null, id: string): string[] | null {
  const current = new Set(value ?? repos.map((r) => r.id));
  if (current.has(id)) {
    if (current.size === 1) return value;
    current.delete(id);
  } else current.add(id);
  const next = repos.map((r) => r.id).filter((rid) => current.has(rid));
  return next.length === repos.length ? null : next;
}
