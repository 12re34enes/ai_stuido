import { BookText, MessagesSquare, Scale, ShieldHalf, type LucideIcon } from "lucide-react";

import type { MemoryLayer } from "./types";

export const layerIcons: Record<MemoryLayer, LucideIcon> = {
  facts: BookText,
  decisions: Scale,
  boundaries: ShieldHalf,
  sessions: MessagesSquare,
};

/** Route of a memory document (`decisions/x.md` → `/memory/doc/decisions/x.md`). */
export function docHref(path: string, mode?: "edit" | "history"): string {
  const base = `/memory/doc/${path.split("/").map(encodeURIComponent).join("/")}`;
  return mode ? `${base}?mode=${mode}` : base;
}

/** Document path of a `/memory/doc/...` location (or facts.md on the memory index). */
export function docPathFrom(pathname: string): string | null {
  if (pathname.startsWith("/memory/doc/")) return pathname.slice("/memory/doc/".length).split("/").map(decodeURIComponent).join("/");
  if (pathname === "/memory" || pathname === "/memory/") return "facts.md";
  return null;
}
