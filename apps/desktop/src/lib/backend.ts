/**
 * Where studiod lives and how to authenticate.
 *
 * - Inside Tauri: the Rust shell exposes `backend_info` → { url, token } (token from Keychain).
 * - Browser dev (`make dev`): same-origin; Vite proxies /api and /ws and injects the dev token.
 */

export interface BackendInfo {
  /** Base URL without trailing slash; "" means same-origin (browser dev). */
  url: string;
  token: string | null;
}

let cached: Promise<BackendInfo> | null = null;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function backendInfo(): Promise<BackendInfo> {
  if (!cached) {
    cached = (async () => {
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<BackendInfo>("backend_info");
      }
      return { url: "", token: (import.meta.env.VITE_AISTUDIO_TOKEN as string | undefined) ?? null };
    })();
    cached.catch(() => {
      cached = null; // retry on next call (backend may still be starting)
    });
  }
  return cached;
}

/** Forget cached info (e.g. after studiod restarted on a new port). */
export function resetBackendInfo(): void {
  cached = null;
}

export async function wsUrl(path: string, params: Record<string, string | number | undefined>): Promise<string> {
  const info = await backendInfo();
  const base = info.url
    ? info.url.replace(/^http/, "ws")
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  if (info.token) q.set("token", info.token);
  return `${base}${path}?${q.toString()}`;
}
