import { LayoutGrid } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";

import { features } from "@/app/routes";
import { isTauri } from "@/lib/backend";
import { useConnection } from "@/lib/connection";
import { useShell } from "@/lib/shell";
import { spring, transition } from "@/motion/tokens";
import { cn, Kbd, StatusDot, Tooltip } from "@/ui";

import { featurePath } from "./route";
import { shellStrings as s } from "./strings";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const EXPANDED = 236;
const COLLAPSED = 72;

function Label({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return (
    <motion.span
      className="relative min-w-0 flex-1 truncate whitespace-nowrap"
      initial={false}
      animate={{ opacity: collapsed ? 0 : 1 }}
      transition={transition.micro}
      aria-hidden={collapsed || undefined}
    >
      {children}
    </motion.span>
  );
}

function NavItem({ to, end, icon, label, shortcut, collapsed }: { to: string; end?: boolean; icon: ReactNode; label: string; shortcut?: string; collapsed: boolean }) {
  const link = (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      className={({ isActive }) =>
        cn(
          "group relative flex h-8 items-center gap-3 rounded-md pr-2 pl-4 text-sm outline-none",
          "transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
          isActive ? "font-medium text-fg" : "text-fg-muted hover:text-fg",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <motion.span layoutId="sidebar-active" className="absolute inset-0 rounded-md bg-surface shadow-1" transition={spring.layout} />
          ) : (
            <span className="absolute inset-0 rounded-md bg-fg/[0.05] opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
          )}
          <span className={cn("relative flex shrink-0 [&_svg]:size-4", isActive ? "text-accent" : "")}>{icon}</span>
          <Label collapsed={collapsed}>{label}</Label>
          {shortcut && !collapsed && (
            <Kbd shortcut={shortcut} className="relative opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
          )}
        </>
      )}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={label} shortcut={shortcut} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

/** The app's own mark (browser dev only; inside Tauri the traffic lights sit here). */
function AppMark({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex items-center gap-2.5 pl-6">
      <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-accent text-fg-on-accent shadow-1" aria-hidden>
        <svg viewBox="0 0 16 16" className="size-3.5">
          <path d="M8 1.5c.4 3.3 1.9 5.6 6.5 6.5-4.6.9-6.1 3.2-6.5 6.5-.4-3.3-1.9-5.6-6.5-6.5C6.1 7.1 7.6 4.8 8 1.5Z" fill="currentColor" />
        </svg>
      </span>
      <Label collapsed={collapsed}>
        <span className="font-serif text-base text-fg">{s.appName}</span>
      </Label>
    </div>
  );
}

function ConnectionIndicator({ collapsed }: { collapsed: boolean }) {
  const status = useConnection((st) => st.status);
  const label = status === "online" ? s.connection.online : status === "offline" ? s.connection.offline : s.connection.connecting;
  const row = (
    <div className="flex h-7 items-center gap-3 pr-2 pl-[18px] text-2xs text-fg-faint" role="status" aria-label={label}>
      <StatusDot status={status === "online" ? "success" : status === "offline" ? "error" : "waiting"} size={12} label={label} className="shrink-0" />
      <Label collapsed={collapsed}>{label}</Label>
    </div>
  );
  return collapsed ? (
    <Tooltip content={label} side="right">
      {row}
    </Tooltip>
  ) : (
    row
  );
}

/**
 * Left sidebar (spec §19): narrow, collapsible on a spring, translucent over the window's
 * vibrancy. The top row is a drag region that leaves room for the macOS traffic lights.
 */
export function Sidebar() {
  const collapsed = useShell((st) => st.sidebarCollapsed);
  const main = features.filter((f) => f.section === "main");
  const secondary = features.filter((f) => f.section === "secondary");
  const tauri = isTauri();

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? COLLAPSED : EXPANDED }}
      transition={spring.gentle}
      data-sidebar
      data-collapsed={collapsed || undefined}
      className="relative z-(--z-sidebar) flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-sidebar backdrop-blur-xl"
    >
      <div data-tauri-drag-region className="drag-region flex h-(--topbar-height) shrink-0 items-center">
        {!tauri && <AppMark collapsed={collapsed} />}
      </div>

      <div className="px-3 pt-1 pb-2">
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>

      <nav aria-label={s.sidebar.navigation} className="flex flex-col gap-px px-3 pt-1">
        {main.map((f) => (
          <NavItem
            key={f.id}
            to={featurePath(f)}
            end={f.path === "/"}
            icon={<f.icon strokeWidth={1.75} />}
            label={f.label}
            shortcut={f.shortcut}
            collapsed={collapsed}
          />
        ))}
      </nav>

      <div className="min-h-4 flex-1" data-tauri-drag-region />

      <div className="flex flex-col gap-px px-3 pb-3">
        {import.meta.env.DEV && (
          <NavItem to="/__gallery" icon={<LayoutGrid strokeWidth={1.75} />} label={s.sidebar.gallery} collapsed={collapsed} />
        )}
        {secondary.map((f) => (
          <NavItem
            key={f.id}
            to={featurePath(f)}
            icon={<f.icon strokeWidth={1.75} />}
            label={f.label}
            shortcut={f.shortcut}
            collapsed={collapsed}
          />
        ))}
        <div className="mx-1 my-1.5 h-px bg-line" />
        <ConnectionIndicator collapsed={collapsed} />
      </div>
    </motion.aside>
  );
}
