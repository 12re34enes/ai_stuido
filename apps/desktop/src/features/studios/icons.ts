import {
  Blocks,
  BookOpen,
  Brain,
  Bug,
  ChartLine,
  ClipboardList,
  Code,
  Compass,
  Database,
  FileText,
  FlaskConical,
  GitPullRequest,
  Globe,
  Layers,
  Lightbulb,
  ListChecks,
  Megaphone,
  Palette,
  Puzzle,
  Rocket,
  Scale,
  ScanSearch,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  WandSparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/** Icon names a studio YAML may use (`icon:`). Unknown names fall back to sparkles. */
export const STUDIO_ICONS: Record<string, LucideIcon> = {
  blocks: Blocks,
  "book-open": BookOpen,
  brain: Brain,
  bug: Bug,
  "chart-line": ChartLine,
  "clipboard-list": ClipboardList,
  code: Code,
  compass: Compass,
  database: Database,
  "file-text": FileText,
  "flask-conical": FlaskConical,
  "git-pull-request": GitPullRequest,
  globe: Globe,
  layers: Layers,
  lightbulb: Lightbulb,
  "list-checks": ListChecks,
  megaphone: Megaphone,
  palette: Palette,
  puzzle: Puzzle,
  rocket: Rocket,
  scale: Scale,
  "scan-search": ScanSearch,
  search: Search,
  server: Server,
  "shield-check": ShieldCheck,
  sparkles: Sparkles,
  terminal: Terminal,
  "wand-sparkles": WandSparkles,
  workflow: Workflow,
};

export function studioIcon(name: string | undefined): LucideIcon {
  return (name && STUDIO_ICONS[name]) || Sparkles;
}

/** Shared-element ids: a gallery card's surface, icon and name morph into the studio page header. */
export const sharedIds = {
  surface: (id: string) => `studio-surface-${id}`,
  icon: (id: string) => `studio-icon-${id}`,
  name: (id: string) => `studio-name-${id}`,
};

export const BLANK_TEMPLATE = "__blank";

/** Editor route for a new studio copied from `template` (or the blank skeleton). */
export function newStudioPath(template: string, id: string, name: string): string {
  const q = new URLSearchParams({ from: template, id, name });
  return `/studios/_new?${q.toString()}`;
}
