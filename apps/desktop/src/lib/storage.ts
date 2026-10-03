/** Tiny, failure-tolerant localStorage helpers for UI preferences (never for server state). */

const PREFIX = "aistudio.";

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: preferences are best-effort
  }
}
