import { useEffect } from "react";
import { useNavigate } from "react-router";

import { features } from "@/app/routes";
import { runCommand, useCommandStore } from "@/lib/commands";
import { useShell } from "@/lib/shell";
import { isTypingTarget, matchesShortcut, parseShortcut } from "@/ui/shortcuts";

import { shellShortcuts } from "./keys";
import { featurePath } from "./route";

function hasModifier(shortcut: string) {
  const p = parseShortcut(shortcut);
  return p.meta || p.ctrl || p.alt;
}

/**
 * App-wide keyboard shortcuts: ⌘K palette, ⌘1…8 / ⌘, navigation from the feature registry, and
 * every registered command marked `global`. Plain-key shortcuts never fire while typing.
 */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (matchesShortcut(e, shellShortcuts.palette)) {
        e.preventDefault();
        useShell.getState().togglePalette();
        return;
      }
      for (const f of features) {
        if (f.shortcut && matchesShortcut(e, f.shortcut)) {
          e.preventDefault();
          useShell.getState().setPaletteOpen(false);
          void navigate(featurePath(f));
          return;
        }
      }
      for (const c of useCommandStore.getState().commands) {
        if (!c.global || !c.shortcut) continue;
        if (!hasModifier(c.shortcut) && isTypingTarget(e.target)) continue;
        if (matchesShortcut(e, c.shortcut)) {
          e.preventDefault();
          void runCommand(c.id);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}
