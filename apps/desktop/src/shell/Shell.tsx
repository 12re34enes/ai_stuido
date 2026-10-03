/**
 * App chrome (spec §19): vibrancy sidebar, top bar (env, limits, approvals, agents), animated
 * page outlet, right drawer, ⌘K palette, toasts, production frame and connection banner.
 */
import { useEffect } from "react";
import { useLocation } from "react-router";

import { features } from "@/app/routes";
import { useShellLiveSync } from "@/lib/live";
import { Toaster } from "@/ui";

import { AnimatedOutlet } from "./AnimatedOutlet";
import { CommandPalette } from "./CommandPalette";
import { ConnectionBanner } from "./ConnectionBanner";
import { DrawerHost } from "./DrawerHost";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import { ProductionFrame } from "./ProductionFrame";
import { featureForPath } from "./route";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { useAppearanceSync } from "./useAppearanceSync";
import { useConnectionMonitor } from "./useConnectionMonitor";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useNativeIntegration } from "./useNativeIntegration";
import { useShellCommands } from "./useShellCommands";

/** Warm every feature chunk when idle so the first visit to a page animates without a gap. */
function usePrefetchFeatures() {
  useEffect(() => {
    const run = () => features.forEach((f) => void f.load().catch(() => undefined));
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(run, 400);
    return () => clearTimeout(t);
  }, []);
}

export function Shell() {
  useShellLiveSync();
  const retry = useConnectionMonitor();
  useAppearanceSync();
  useGlobalShortcuts();
  useShellCommands();
  useNativeIntegration();
  usePrefetchFeatures();

  const location = useLocation();
  const feature = featureForPath(location.pathname);

  return (
    <div className="flex h-full overflow-hidden text-fg">
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col bg-canvas">
        <TopBar sectionLabel={feature && feature.id !== "home" ? feature.label : undefined} />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatedOutlet />
          <ConnectionBanner onRetry={retry} />
        </main>
      </div>
      <DrawerHost />
      <CommandPalette />
      <NewWorkspaceDialog />
      <Toaster />
      <ProductionFrame />
    </div>
  );
}
