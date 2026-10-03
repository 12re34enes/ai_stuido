import { emit } from "@tauri-apps/api/event";

import {
  NATIVE_EVENTS,
  onDeepLink,
  onGlobalShortcutError,
  onNotificationAction,
  onShellAction,
  onWindowShown,
  startNativeEvents,
} from "./events";
import { enterTauri, flush, leaveTauri } from "./testing";
import type { DeepLinkEvent, NotificationActionEvent } from "./types";

afterEach(() => leaveTauri());

const link: DeepLinkEvent = { url: "aistudio://approval/apr_1", kind: "approval", id: "apr_1" };

describe("native event hub", () => {
  it("delivers Rust events to subscribers and stops after unsubscribe", async () => {
    enterTauri("main", (cmd) => (cmd === "native_ready" ? [] : null));
    const received: DeepLinkEvent[] = [];
    const off = onDeepLink((e) => received.push(e));
    await flush();
    await emit(NATIVE_EVENTS.deepLink, link);
    expect(received).toEqual([link]);
    off();
    await emit(NATIVE_EVENTS.deepLink, link);
    expect(received).toHaveLength(1);
  });

  it("replays events queued by the shell before the main page was ready", async () => {
    const commands: string[] = [];
    enterTauri("main", (cmd) => {
      commands.push(cmd);
      if (cmd === "native_ready") {
        return [
          { event: NATIVE_EVENTS.deepLink, payload: link },
          { event: NATIVE_EVENTS.shortcutError, payload: { accelerator: "Control+Alt+Space", message: "kaydedilemedi" } },
        ];
      }
      return null;
    });
    const links: DeepLinkEvent[] = [];
    onDeepLink((e) => links.push(e));
    await flush();
    expect(commands.filter((c) => c === "native_ready")).toHaveLength(1);
    expect(links).toEqual([link]);

    // Nobody listened for the shortcut error yet: it waits for the first subscriber.
    const errors: string[] = [];
    onGlobalShortcutError((e) => errors.push(e.message));
    await flush();
    expect(errors).toEqual(["kaydedilemedi"]);
  });

  it("buffers actionable events for late subscribers but drops transient ones", async () => {
    enterTauri("main", (cmd) => (cmd === "native_ready" ? [] : null));
    await startNativeEvents();
    const action: NotificationActionEvent = { id: "alr_1", action: "approve", approvalId: "apr_1", deepLink: null };
    await emit(NATIVE_EVENTS.notificationAction, action);
    await emit(NATIVE_EVENTS.windowShown, { label: "main" });

    const actions: NotificationActionEvent[] = [];
    onNotificationAction((e) => actions.push(e));
    const shown: unknown[] = [];
    onWindowShown((e) => shown.push(e));
    await flush();
    expect(actions).toEqual([action]);
    expect(shown).toEqual([]);
  });

  it("does not claim the main window's queue from popups", async () => {
    const commands: string[] = [];
    enterTauri("palette", (cmd) => {
      commands.push(cmd);
      return null;
    });
    const shown: unknown[] = [];
    onWindowShown((e) => shown.push(e));
    await flush();
    await emit(NATIVE_EVENTS.windowShown, { label: "palette" });
    expect(shown).toEqual([{ label: "palette" }]);
    expect(commands).not.toContain("native_ready");
  });

  it("keeps working when one handler throws", async () => {
    enterTauri("main", (cmd) => (cmd === "native_ready" ? [] : null));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    onShellAction(() => {
      throw new Error("boom");
    });
    onShellAction((e) => seen.push(e.action));
    await flush();
    await emit(NATIVE_EVENTS.shellAction, { action: "new-task" });
    expect(seen).toEqual(["new-task"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
