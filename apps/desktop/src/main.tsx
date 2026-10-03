import "@/styles/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { Providers } from "@/app/providers";
import { initAppearance } from "@/lib/appearance";
import { isTauri } from "@/lib/backend";
import { initNative } from "@/lib/native";

// Native shell first (sets <html data-window/data-vibrancy>, wires tray/menu events). Calls
// `initNativeShell()` from `@/native` when that module is present; a no-op in the browser build.
initNative();
// Apply the cached theme before the first paint (no light flash in dark mode).
initAppearance(isTauri());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
