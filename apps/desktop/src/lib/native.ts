/**
 * Adapter between the app shell and the Tauri bridge (`src/native/`).
 *
 * The bridge is imported directly and checked against the subset the web app relies on, so a
 * signature change in `src/native/` fails the typecheck here. In a plain browser the bridge's
 * helpers are no-ops.
 */
import * as native from "@/native";

export interface DeepLink {
  kind: "approval" | "task" | "run" | string;
  id: string;
}

export interface ShellAction {
  action: "new-task" | "navigate" | string;
  route?: string;
}

export interface TrayState {
  pendingApprovals: number;
  activeAgents: number;
  critical: boolean;
}

type Unlisten = () => void;
type MaybeAsync<T> = T | Promise<T>;

/** The subset of the bridge the web app relies on (shapes per the native workstream's contract). */
export interface NativeBridge {
  initNativeShell?: () => MaybeAsync<void | (() => void)>;
  isTauri?: () => boolean;
  onDeepLink?: (cb: (link: DeepLink) => void) => MaybeAsync<Unlisten | void>;
  onShellAction?: (cb: (action: ShellAction) => void) => MaybeAsync<Unlisten | void>;
  setTrayState?: (state: TrayState) => MaybeAsync<void>;
}

export const nativeBridge: NativeBridge = native;

/** Kept for callers written before the bridge landed; the bridge is always part of the build now. */
export const hasNativeBridge = true;

/** Call once at startup (main.tsx). Never throws: the web build runs without the shell. */
export function initNative(): void {
  try {
    const result = nativeBridge.initNativeShell?.();
    if (result instanceof Promise) result.catch((e: unknown) => console.warn("initNativeShell failed", e));
  } catch (e) {
    console.warn("initNativeShell failed", e);
  }
}

/** Subscribe through a bridge listener that may return an unlisten function or a promise of one. */
export function listenNative<T>(
  register: ((cb: (value: T) => void) => MaybeAsync<Unlisten | void>) | undefined,
  cb: (value: T) => void,
): Unlisten {
  if (!register) return () => {};
  let off: Unlisten | void;
  let disposed = false;
  try {
    const r = register(cb);
    if (r instanceof Promise) {
      void r.then((fn) => {
        if (disposed) fn?.();
        else off = fn;
      });
    } else off = r;
  } catch (e) {
    console.warn("native listener failed", e);
  }
  return () => {
    disposed = true;
    off?.();
  };
}

/** Route for a deep link (aistudio://approval/<id> …). */
export function deepLinkRoute(link: DeepLink): string | null {
  const id = encodeURIComponent(link.id);
  switch (link.kind) {
    case "approval":
      return `/approvals/${id}`;
    case "task":
      return `/tasks/${id}`;
    case "run":
      return `/tasks/runs/${id}`;
    default:
      return null;
  }
}
