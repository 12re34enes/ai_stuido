/** Icons for modes and studios (studio YAMLs name lucide icons: "bug", "chart-line"…). */
import {
  ArrowRightLeft,
  Blocks,
  BookOpen,
  Bot,
  Bug,
  ChartLine,
  ClipboardList,
  Database,
  Flag,
  ListOrdered,
  Palette,
  ScanSearch,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { BuiltinMode } from "../list/types";

export const modeIcons: Record<BuiltinMode, LucideIcon> = {
  single: Bot,
  duo: ArrowRightLeft,
  race: Flag,
  pipeline: ListOrdered,
  council: Users,
};

const studioIconMap: Record<string, LucideIcon> = {
  blocks: Blocks,
  "book-open": BookOpen,
  bug: Bug,
  "chart-line": ChartLine,
  "clipboard-list": ClipboardList,
  database: Database,
  palette: Palette,
  "scan-search": ScanSearch,
  sparkles: Sparkles,
};

export function studioIcon(name: string | null | undefined): LucideIcon {
  return (name && studioIconMap[name]) || Sparkles;
}
