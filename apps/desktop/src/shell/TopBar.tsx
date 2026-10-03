import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { useActiveEnvironment } from "@/lib/environment";
import { useShell } from "@/lib/shell";
import { useCurrentWorkspace } from "@/lib/workspace";
import { variants } from "@/motion/tokens";
import { EnvBadge, IconButton, Kbd } from "@/ui";

import { AgentsWidget } from "./AgentsWidget";
import { ApprovalsWidget } from "./ApprovalsWidget";
import { shellShortcuts } from "./keys";
import { LimitsWidget } from "./LimitsWidget";
import { shellStrings as s } from "./strings";

/**
 * Top bar (spec §19): workspace and environment on the left; agent dots, limit bars, approval
 * counter and search on the right. The empty space is the window's drag region.
 */
export function TopBar({ sectionLabel }: { sectionLabel?: string }) {
  const collapsed = useShell((st) => st.sidebarCollapsed);
  const toggleSidebar = useShell((st) => st.toggleSidebar);
  const openPalette = useShell((st) => st.setPaletteOpen);
  const env = useActiveEnvironment();
  const { workspace } = useCurrentWorkspace();

  return (
    <header
      data-tauri-drag-region
      className="drag-region relative z-(--z-topbar) flex h-(--topbar-height) shrink-0 items-center gap-2 border-b border-line bg-canvas pr-3 pl-2"
    >
      <IconButton
        className="no-drag"
        label={collapsed ? s.sidebar.expand : s.sidebar.collapse}
        shortcut={shellShortcuts.toggleSidebar}
        icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        onClick={toggleSidebar}
      />
      <div className="flex min-w-0 items-center gap-2" data-tauri-drag-region>
        <span className="truncate text-sm font-medium text-fg" data-tauri-drag-region>
          {workspace?.name ?? s.appName}
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          {sectionLabel && (
            <motion.span key={sectionLabel} {...variants.fade} className="flex min-w-0 items-center gap-2 text-sm text-fg-muted" data-tauri-drag-region>
              <span aria-hidden className="text-fg-faint">
                /
              </span>
              <span className="truncate">{sectionLabel}</span>
            </motion.span>
          )}
        </AnimatePresence>
        <EnvBadge environment={env.environment} label={env.label} className="ml-1" />
      </div>

      <div className="h-full min-w-6 flex-1" data-tauri-drag-region />

      <div className="flex items-center gap-1.5">
        <AgentsWidget />
        <LimitsWidget />
        <ApprovalsWidget />
        <button
          type="button"
          onClick={() => openPalette(true)}
          aria-label={s.topbar.searchHint}
          className="no-drag ml-1 flex h-7 items-center gap-2 rounded-md border border-line bg-surface pr-1 pl-2 text-xs text-fg-muted outline-none transition-colors duration-150 hover:border-line-strong hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        >
          <Search className="size-3.5" aria-hidden />
          <span className="pr-3">{s.topbar.search}</span>
          <Kbd shortcut={shellShortcuts.palette} />
        </button>
      </div>
    </header>
  );
}
