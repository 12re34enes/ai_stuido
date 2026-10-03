import { LayoutGrid, ListPlus, Monitor, Moon, PanelLeft, PanelRightClose, Plus, Sparkles, Sun } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router";

import { features } from "@/app/routes";
import { useAppearance } from "@/lib/appearance";
import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { useDrawer } from "@/lib/drawer";
import { useUpdateSetting } from "@/lib/queries";
import { useShell } from "@/lib/shell";
import type { ThemePref } from "@/lib/types";
import { useCurrentWorkspace, useWorkspaceStore } from "@/lib/workspace";

import { shellShortcuts } from "./keys";
import { featurePath } from "./route";
import { shellStrings as s } from "./strings";

const ACTIVE = "Etkin";

/** Registers the shell's own palette commands: navigation, appearance, workspace, drawer, dev. */
export function useShellCommands(): void {
  const navigate = useNavigate();
  const theme = useAppearance((st) => st.theme);
  const reduceMotion = useAppearance((st) => st.reduceMotion);
  const drawerOpen = useDrawer((st) => st.entry !== null);
  const { workspace, workspaces } = useCurrentWorkspace();
  const updateSetting = useUpdateSetting();
  const { mutate } = updateSetting;

  const commands = useMemo<StudioCommand[]>(() => {
    const setTheme = (pref: ThemePref) => {
      useAppearance.getState().setTheme(pref);
      mutate({ key: "appearance.theme", value: pref });
    };
    const list: StudioCommand[] = features.map((f, i) => ({
      id: `nav.${f.id}`,
      title: f.label,
      group: commandGroups.navigation,
      icon: f.icon,
      shortcut: f.shortcut,
      keywords: f.keywords,
      order: i,
      run: () => void navigate(featurePath(f)),
    }));
    list.push(
      { id: "view.theme.light", title: s.commands.themeLight, subtitle: theme === "light" ? ACTIVE : undefined, group: commandGroups.view, icon: Sun, keywords: ["light", "tema", "görünüm"], order: 1, run: () => setTheme("light") },
      { id: "view.theme.dark", title: s.commands.themeDark, subtitle: theme === "dark" ? ACTIVE : undefined, group: commandGroups.view, icon: Moon, keywords: ["dark", "tema", "görünüm"], order: 2, run: () => setTheme("dark") },
      { id: "view.theme.system", title: s.commands.themeSystem, subtitle: theme === "system" ? ACTIVE : undefined, group: commandGroups.view, icon: Monitor, keywords: ["system", "tema", "otomatik"], order: 3, run: () => setTheme("system") },
      {
        id: "view.sidebar",
        title: s.commands.toggleSidebar,
        group: commandGroups.view,
        icon: PanelLeft,
        shortcut: shellShortcuts.toggleSidebar,
        global: true,
        keywords: ["sidebar", "kenar"],
        order: 4,
        run: () => useShell.getState().toggleSidebar(),
      },
      {
        id: "view.reduceMotion",
        title: reduceMotion === "on" ? s.commands.reduceMotionOff : s.commands.reduceMotionOn,
        group: commandGroups.view,
        icon: Sparkles,
        keywords: ["motion", "animasyon", "hareket", "erişilebilirlik"],
        order: 5,
        run: () => {
          const next = reduceMotion === "on" ? "system" : "on";
          useAppearance.getState().setReduceMotion(next);
          mutate({ key: "appearance.reduce_motion", value: next });
        },
      },
      {
        id: "task.new",
        title: s.commands.newTask,
        group: commandGroups.actions,
        icon: ListPlus,
        shortcut: shellShortcuts.newTask,
        global: true,
        keywords: ["new task", "görev", "yeni"],
        order: 0,
        run: () => {
          void navigate("/");
          useShell.getState().requestComposerFocus();
        },
      },
      {
        id: "drawer.close",
        title: s.commands.closeDrawer,
        group: commandGroups.actions,
        icon: PanelRightClose,
        visible: drawerOpen,
        keywords: ["drawer", "çekmece", "kapat"],
        run: () => useDrawer.getState().closeDrawer(),
      },
      {
        id: "workspace.new",
        title: s.commands.newWorkspace,
        group: commandGroups.workspace,
        icon: Plus,
        keywords: ["workspace", "çalışma alanı", "yeni"],
        order: 0,
        run: () => useShell.getState().setNewWorkspaceOpen(true),
      },
    );
    for (const w of workspaces) {
      if (w.id === workspace?.id) continue;
      list.push({
        id: `workspace.switch.${w.id}`,
        title: s.commands.switchTo(w.name),
        group: commandGroups.workspace,
        keywords: ["workspace", "çalışma alanı", w.slug],
        order: 1,
        run: () => useWorkspaceStore.getState().setCurrentId(w.id),
      });
    }
    if (import.meta.env.DEV) {
      list.push({
        id: "dev.gallery",
        title: s.commands.gallery,
        group: commandGroups.developer,
        icon: LayoutGrid,
        keywords: ["gallery", "galeri", "bileşen", "components"],
        run: () => void navigate("/__gallery"),
      });
    }
    return list;
  }, [drawerOpen, mutate, navigate, reduceMotion, theme, workspace?.id, workspaces]);

  useRegisterCommands(commands);
}
