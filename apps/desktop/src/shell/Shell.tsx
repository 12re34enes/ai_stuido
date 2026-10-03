/**
 * Minimal app chrome. The design-system workstream replaces this with the full shell
 * (vibrancy sidebar, top bar with env/limits/approvals, drawer, palette).
 */
import { NavLink, Outlet } from "react-router";

import { features } from "@/app/routes";
import { cn } from "@/ui";

export function Shell() {
  return (
    <div className="flex h-full">
      <nav className="flex w-[var(--sidebar-width)] flex-col gap-0.5 border-r border-line bg-sidebar p-3">
        {features
          .filter((f) => f.section !== "hidden")
          .map((f) => (
            <NavLink
              key={f.id}
              to={f.path.replace("/*", "") || "/"}
              end={f.path === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-fg-muted transition-colors",
                  isActive ? "bg-surface text-fg shadow-1" : "hover:bg-surface-hover",
                )
              }
            >
              <f.icon size={15} strokeWidth={1.75} />
              {f.label}
            </NavLink>
          ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
