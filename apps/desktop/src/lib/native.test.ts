import { act, renderHook } from "@testing-library/react";

import { deepLinkRoute, initNative, listenNative } from "./native";
import { useComposerFocusRequest, useShell } from "./shell";

describe("native adapter", () => {
  it("maps deep links to routes", () => {
    expect(deepLinkRoute({ kind: "approval", id: "apr_1" })).toBe("/approvals/apr_1");
    expect(deepLinkRoute({ kind: "task", id: "t 2" })).toBe("/tasks/t%202");
    expect(deepLinkRoute({ kind: "run", id: "run_9" })).toBe("/tasks/runs/run_9");
    expect(deepLinkRoute({ kind: "unknown", id: "x" })).toBeNull();
  });

  it("is a no-op without the bridge", () => {
    expect(() => initNative()).not.toThrow();
    const off = listenNative(undefined, () => {});
    expect(() => off()).not.toThrow();
  });

  it("handles sync and async unlisten functions", async () => {
    const syncOff = vi.fn();
    const off1 = listenNative<number>((cb) => {
      cb(1);
      return syncOff;
    }, vi.fn());
    off1();
    expect(syncOff).toHaveBeenCalledOnce();

    const asyncOff = vi.fn();
    const off2 = listenNative<number>(() => Promise.resolve(asyncOff), vi.fn());
    off2(); // disposed before the promise resolved: unlisten as soon as it does
    await Promise.resolve();
    await Promise.resolve();
    expect(asyncOff).toHaveBeenCalledOnce();
  });
});

describe("useComposerFocusRequest", () => {
  it("fires for requests made before and after mount", () => {
    act(() => useShell.getState().requestComposerFocus());
    const cb = vi.fn();
    renderHook(() => useComposerFocusRequest(cb));
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => useShell.getState().requestComposerFocus());
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
