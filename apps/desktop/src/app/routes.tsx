/**
 * Feature registry: every page of the app. The shell builds navigation from this list, the
 * router builds routes from it. Feature workstreams only edit their own `features/<id>/`.
 */
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  History,
  Home,
  Inbox,
  ListChecks,
  Server,
  Settings,
  Sparkles,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import type { ComponentType } from "react";

export interface FeatureRoute {
  id: string;
  /** Route path; nested routes live inside the feature (path ends with "/*"). */
  path: string;
  label: string;
  icon: LucideIcon;
  /** main = sidebar top group, secondary = sidebar bottom, hidden = reachable but not in nav. */
  section: "main" | "secondary" | "hidden";
  /** Keyboard shortcut shown in the palette, e.g. "⌘1". */
  shortcut?: string;
  load: () => Promise<{ default: ComponentType }>;
}

export const features: FeatureRoute[] = [
  { id: "home", path: "/", label: "Ana sayfa", icon: Home, section: "main", shortcut: "⌘1", load: () => import("@/features/home") },
  { id: "tasks", path: "/tasks/*", label: "Görevler", icon: ListChecks, section: "main", shortcut: "⌘2", load: () => import("@/features/tasks") },
  { id: "flows", path: "/flows/*", label: "Akışlar", icon: Workflow, section: "main", shortcut: "⌘3", load: () => import("@/features/flows") },
  { id: "studios", path: "/studios/*", label: "Stüdyolar", icon: Sparkles, section: "main", shortcut: "⌘4", load: () => import("@/features/studios") },
  { id: "memory", path: "/memory/*", label: "Hafıza", icon: BookOpen, section: "main", shortcut: "⌘5", load: () => import("@/features/memory") },
  { id: "sessions", path: "/sessions/*", label: "Oturumlar", icon: TerminalSquare, section: "main", shortcut: "⌘6", load: () => import("@/features/sessions") },
  { id: "connections", path: "/connections/*", label: "Bağlantılar", icon: Server, section: "main", shortcut: "⌘7", load: () => import("@/features/connections") },
  { id: "history", path: "/history/*", label: "Geçmiş", icon: History, section: "main", shortcut: "⌘8", load: () => import("@/features/history") },
  { id: "approvals", path: "/approvals/*", label: "Onaylar", icon: Inbox, section: "hidden", load: () => import("@/features/approvals") },
  { id: "settings", path: "/settings/*", label: "Ayarlar", icon: Settings, section: "secondary", shortcut: "⌘,", load: () => import("@/features/settings") },
];
