/**
 * Test helpers for the native bridge (imported by *.test.ts only).
 */
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";

import { resetBackendInfo } from "@/lib/backend";

import { resetNativeEventsForTests } from "./events";

export type IpcHandler = (cmd: string, args?: Record<string, unknown>) => unknown;

/** Simulates running inside the given Tauri window, routing commands to `handler`. */
export function enterTauri(label: string, handler: IpcHandler): void {
  mockWindows(label);
  mockIPC((cmd, args) => handler(cmd, args as Record<string, unknown> | undefined), { shouldMockEvents: true });
}

/** Back to a plain browser: no `__TAURI_INTERNALS__`, no bridge state. */
export function leaveTauri(): void {
  resetNativeEventsForTests();
  clearMocks();
  const w = window as unknown as Record<string, unknown>;
  delete w.__TAURI_INTERNALS__;
  delete w.__TAURI_EVENT_PLUGIN_INTERNALS__;
  delete w.__AISTUDIO_SHELL__;
  resetBackendInfo();
}

/** Lets pending promise chains (dynamic imports, mocked IPC) settle. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
