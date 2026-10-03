import { createContext, useContext } from "react";

import type { Provider } from "@/lib/types";

export interface StreamContextValue {
  sessionId: string;
  provider: Provider;
  compact: boolean;
  cwd: string | null;
  /** Inline permission decisions and other actions are allowed. */
  interactive: boolean;
  /** Reading persisted history (no actions). */
  replay: boolean;
  /** Disclosure state lives above the virtualized rows so it survives scrolling. */
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}

export const StreamContext = createContext<StreamContextValue | null>(null);

export function useStreamContext(): StreamContextValue {
  const ctx = useContext(StreamContext);
  if (!ctx) throw new Error("StreamContext missing");
  return ctx;
}
