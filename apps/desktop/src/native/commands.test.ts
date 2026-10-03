import { backendInfo } from "@/lib/backend";

import {
  applyShellDataset,
  backendStatus,
  currentWindowLabel,
  detectEditors,
  getShellStatus,
  hideCurrentWindow,
  initNativeShell,
  isTauri,
  NativeError,
  notificationPermission,
  notify,
  onDeepLink,
  onNotificationAction,
  openExternal,
  openInEditor,
  restartBackend,
  revealInFinder,
  setGlobalShortcut,
  setTrayState,
  shellInfo,
  showMainWindow,
  windowKind,
} from "./index";
import { enterTauri, leaveTauri } from "./testing";

afterEach(() => {
  leaveTauri();
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("in a plain browser", () => {
  it("reports no Tauri and no window", () => {
    expect(isTauri()).toBe(false);
    expect(currentWindowLabel()).toBeNull();
    expect(windowKind()).toBe("browser");
    expect(shellInfo()).toBeNull();
  });

  it("degrades every command to a no-op", async () => {
    await expect(notify({ id: "a", title: "t", body: "b" })).resolves.toEqual({
      delivered: false,
      backend: "none",
      reason: "browser",
    });
    await expect(setTrayState({ pendingApprovals: 3 })).resolves.toBeUndefined();
    await expect(setGlobalShortcut("Control+Alt+Space")).resolves.toBeNull();
    await expect(getShellStatus()).resolves.toBeNull();
    await expect(backendStatus()).resolves.toBeNull();
    await expect(notificationPermission()).resolves.toBe("unsupported");
    await expect(revealInFinder("/tmp")).resolves.toBe(false);
    await expect(openInEditor("/tmp")).resolves.toBeNull();
    await expect(detectEditors()).resolves.toEqual([]);
    await expect(restartBackend()).resolves.toBeUndefined();
  });

  it("returns no-op unsubscribers for native events", () => {
    const off = onDeepLink(() => {});
    expect(typeof off).toBe("function");
    off();
    expect(onNotificationAction(() => {})).toBeTypeOf("function");
    const cleanup = initNativeShell();
    cleanup();
  });

  it("opens safe external links in a new tab only", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await expect(openExternal("https://github.com/org/repo")).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith("https://github.com/org/repo", "_blank", "noopener,noreferrer");
    await expect(openExternal("javascript:alert(1)")).resolves.toBe(false);
    await expect(openExternal("file:///etc/hosts")).resolves.toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("navigates in-page instead of showing a main window", async () => {
    await showMainWindow("/approvals/apr_1");
    expect(window.location.hash).toBe("#/approvals/apr_1");
  });

  it("leaves the document untouched", () => {
    const root = document.createElement("html");
    applyShellDataset(root);
    expect(root.dataset.window).toBeUndefined();
  });
});

describe("inside Tauri", () => {
  it("maps notify() to the notify command with camelCase args", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    enterTauri("main", (cmd, args) => {
      calls.push([cmd, args]);
      return { delivered: true, backend: "usernotifications", reason: null };
    });
    const result = await notify({
      id: "alr_1",
      title: "Onay bekliyor",
      body: "Deploy",
      severity: "critical",
      actions: ["approve", "reject", "open"],
      deepLink: "aistudio://approval/apr_1",
      approvalId: "apr_1",
    });
    expect(result.delivered).toBe(true);
    expect(calls).toEqual([
      [
        "notify",
        {
          id: "alr_1",
          title: "Onay bekliyor",
          body: "Deploy",
          severity: "critical",
          actions: ["approve", "reject", "open"],
          deepLink: "aistudio://approval/apr_1",
          sound: undefined,
          approvalId: "apr_1",
        },
      ],
    ]);
  });

  it("clamps tray state numbers", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    enterTauri("main", (cmd, args) => {
      if (cmd === "set_tray_state") calls.push(args);
      return null;
    });
    await setTrayState({ pendingApprovals: 2.7, activeAgents: -4 });
    expect(calls).toEqual([{ pendingApprovals: 2, activeAgents: 0, critical: false }]);
  });

  it("turns Rust errors into NativeError with the Turkish message", async () => {
    enterTauri("main", () => {
      throw { code: "shortcut_unavailable", message: 'Kısayol "Control+Alt+Space" kaydedilemedi.' };
    });
    const err = await setGlobalShortcut("Control+Alt+Space").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NativeError);
    expect((err as NativeError).code).toBe("shortcut_unavailable");
    expect((err as NativeError).message).toContain("kaydedilemedi");
  });

  it("forgets cached backend info after a restart", async () => {
    let infoCalls = 0;
    enterTauri("main", (cmd) => {
      if (cmd === "backend_info") {
        infoCalls += 1;
        return { url: `http://127.0.0.1:${9000 + infoCalls}`, token: "t" };
      }
      return null;
    });
    await expect(backendInfo()).resolves.toEqual({ url: "http://127.0.0.1:9001", token: "t" });
    await backendInfo();
    expect(infoCalls).toBe(1);
    await restartBackend();
    await expect(backendInfo()).resolves.toEqual({ url: "http://127.0.0.1:9002", token: "t" });
  });

  it("knows its window and marks the document", () => {
    enterTauri("palette", () => null);
    (window as unknown as Record<string, unknown>).__AISTUDIO_SHELL__ = { platform: "macos", vibrancy: true };
    expect(windowKind()).toBe("palette");
    expect(shellInfo()).toEqual({ platform: "macos", vibrancy: true });
    const root = document.createElement("html");
    applyShellDataset(root);
    expect(root.dataset.window).toBe("palette");
    expect(root.dataset.vibrancy).toBe("true");
  });

  it("dismisses popups through the shell so focus can return to the previous app", async () => {
    const calls: string[] = [];
    enterTauri("palette", (cmd) => {
      calls.push(cmd);
      return null;
    });
    await hideCurrentWindow();
    expect(calls).toEqual(["dismiss_window"]);
  });

  it("passes editor choice through", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    enterTauri("main", (cmd, args) => {
      calls.push([cmd, args]);
      return { id: "cursor", name: "Cursor", path: "/Applications/Cursor.app" };
    });
    await expect(openInEditor("/Users/u/repo", "cursor")).resolves.toMatchObject({ id: "cursor" });
    expect(calls[0]).toEqual(["open_in_editor", { path: "/Users/u/repo", editor: "cursor" }]);
  });
});
