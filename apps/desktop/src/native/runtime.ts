/**
 * Low-level access to the Tauri runtime. Everything here is safe to import in a plain browser
 * (`make dev`): Tauri modules are loaded lazily and only when `isTauri()`.
 */
import { isTauri } from "@/lib/backend";

import type { ShellInfo, WindowKind } from "./types";

export { isTauri };

/** Error thrown by native commands: `code` is stable, `message` is Turkish and user-facing. */
export class NativeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeError";
    this.code = code;
  }
}

export function toNativeError(e: unknown): NativeError {
  if (e instanceof NativeError) return e;
  if (e && typeof e === "object" && "message" in e) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    return new NativeError(typeof code === "string" ? code : "native_error", String(message));
  }
  if (typeof e === "string" && e) return new NativeError("native_error", e);
  return new NativeError("native_error", "Yerel işlem başarısız oldu.");
}

/** Invokes a shell command; rejects with `NativeError`. Only call when `isTauri()`. */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toNativeError(e);
  }
}

/** Listens to a Rust → webview event; resolves to an unlisten function. */
export async function listenNative<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload));
}

interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } };
}

/** Label of the window this page runs in ("main" | "palette" | "menubar"), null in a browser. */
export function currentWindowLabel(): string | null {
  if (!isTauri()) return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label ?? null;
}

export function windowKind(): WindowKind {
  const label = currentWindowLabel();
  return label === "main" || label === "palette" || label === "menubar" ? label : "browser";
}

/** Shell facts injected before page scripts run (platform, whether vibrancy is active). */
export function shellInfo(): ShellInfo | null {
  if (!isTauri()) return null;
  return (window as unknown as { __AISTUDIO_SHELL__?: ShellInfo }).__AISTUDIO_SHELL__ ?? null;
}
