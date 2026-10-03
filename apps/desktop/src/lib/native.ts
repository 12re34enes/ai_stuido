/**
 * Adapter to the Tauri shell bridge (`src/native/`, built by the native workstream).
 *
 * The bridge module is picked up with an eager `import.meta.glob`, so this file compiles and
 * runs whether or not `src/native/index.ts` exists yet: without it every helper is a no-op.
 * Once the native module is on main, this keeps working unchanged (it may also be replaced by
 * direct `import … from "@/native"` calls).
 */

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
  initNativeShell?: () => MaybeAsync<void>;
  isTauri?: () => boolean;
  onDeepLink?: (cb: (link: DeepLink) => void) => MaybeAsync<Unlisten | void>;
  onShellAction?: (cb: (action: ShellAction) => void) => MaybeAsync<Unlisten | void>;
  setTrayState?: (state: TrayState) => MaybeAsync<void>;
}

const modules = import.meta.glob<NativeBridge>("../native/index.ts", { eager: true });

export const nativeBridge: NativeBridge = modules["../native/index.ts"] ?? {};

/** Whether the native bridge module is present in this build. */
export const hasNativeBridge = Boolean(modules["../native/index.ts"]);

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
