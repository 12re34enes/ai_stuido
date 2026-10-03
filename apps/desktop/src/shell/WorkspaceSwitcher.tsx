import { ChevronsUpDown, Plus } from "lucide-react";
import { motion } from "motion/react";

import { useShell } from "@/lib/shell";
import { useCurrentWorkspace, useWorkspaceStore } from "@/lib/workspace";
import { transition } from "@/motion/tokens";
import { cn, Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, Skeleton, Tooltip } from "@/ui";

import { shellStrings as s } from "./strings";
import { WorkspaceAvatar } from "./WorkspaceAvatar";

export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { workspace, workspaces, query } = useCurrentWorkspace();
  const setCurrent = useWorkspaceStore((st) => st.setCurrentId);
  const openNew = useShell((st) => st.setNewWorkspaceOpen);

  if (query.isPending) {
    return (
      <div className="flex h-9 items-center gap-2.5 px-3">
        <Skeleton width={24} height={24} className="rounded-[7px]" />
        {!collapsed && <Skeleton height={10} className="flex-1" />}
      </div>
    );
  }
  // Endpoint missing or studiod down with nothing cached: nothing meaningful to switch.
  if (query.isError && workspaces.length === 0) return null;

  const trigger = (
    <button
      type="button"
      aria-label={s.sidebar.switchWorkspace}
      className={cn(
        "group flex h-9 w-full items-center gap-2.5 rounded-md pr-2 pl-3 text-left outline-none",
        "transition-colors duration-150 hover:bg-fg/[0.05] focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-fg/[0.06]",
      )}
    >
      <WorkspaceAvatar workspace={workspace} />
      <motion.span
        className="flex min-w-0 flex-1 items-center gap-1"
        initial={false}
        animate={{ opacity: collapsed ? 0 : 1 }}
        transition={transition.micro}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{workspace?.name ?? s.sidebar.noWorkspace}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fg-faint" />
      </motion.span>
    </button>
  );

  return (
    <Menu
      align="start"
      side={collapsed ? "right" : "bottom"}
      className="w-60"
      trigger={
        collapsed ? (
          <span className="block">
            <Tooltip content={workspace?.name ?? s.sidebar.workspaces} side="right">
              {trigger}
            </Tooltip>
          </span>
        ) : (
          trigger
        )
      }
    >
      {workspaces.length > 0 && (
        <>
          <MenuLabel>{s.sidebar.workspaces}</MenuLabel>
          <MenuRadioGroup value={workspace?.id ?? ""} onValueChange={setCurrent}>
            {workspaces.map((w) => (
              <MenuRadioItem key={w.id} value={w.id} icon={<WorkspaceAvatar workspace={w} size={18} className="rounded-[5px]" />}>
                {w.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
        </>
      )}
      <MenuItem icon={<Plus />} onSelect={() => openNew(true)}>
        {s.sidebar.newWorkspace}
      </MenuItem>
    </Menu>
  );
}
