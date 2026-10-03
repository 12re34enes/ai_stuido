import { act, renderHook } from "@testing-library/react";

import { applyReduceMotion, applyTheme, isThemePref, motionConfigFor } from "./appearance";
import { registerCommand, runCommand, useCommandStore, useRegisterCommands, type StudioCommand } from "./commands";
import { ApiError } from "./api";
import { isMissingEndpoint, isUnreachable } from "./connection";
import { clampDrawerWidth, DRAWER_MIN_WIDTH, useDrawer } from "./drawer";
import { activeEnvironment, pushEnvironment, useActiveEnvironment, useEnvironment, useEnvironmentScope } from "./environment";

describe("drawer store", () => {
  beforeEach(() => useDrawer.setState({ entry: null }));

  it("opens, replaces and closes with onClose", () => {
    const onClose = vi.fn();
    act(() => useDrawer.getState().openDrawer({ id: "a", title: "A", content: "x", onClose }));
    expect(useDrawer.getState().entry?.id).toBe("a");
    act(() => useDrawer.getState().closeDrawer("other"));
    expect(useDrawer.getState().entry?.id).toBe("a");
    act(() => useDrawer.getState().closeDrawer("a"));
    expect(useDrawer.getState().entry).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("toggles by id", () => {
    const entry = { id: "t", title: "T", content: null };
    act(() => useDrawer.getState().toggleDrawer(entry));
    expect(useDrawer.getState().entry?.id).toBe("t");
    act(() => useDrawer.getState().toggleDrawer(entry));
    expect(useDrawer.getState().entry).toBeNull();
  });

  it("clamps width to [min, 70% of viewport]", () => {
    expect(clampDrawerWidth(100, 1400)).toBe(DRAWER_MIN_WIDTH);
    expect(clampDrawerWidth(5000, 1400)).toBe(980);
    expect(clampDrawerWidth(500, 1400)).toBe(500);
  });
});

describe("environment stack", () => {
  beforeEach(() => useEnvironment.getState().reset());

  it("defaults to local and stacks contexts", () => {
    expect(activeEnvironment().environment).toBe("local");
    const popTest = pushEnvironment({ environment: "test", label: "staging" });
    const popProd = pushEnvironment({ environment: "production", label: "db-prod-1" });
    expect(activeEnvironment()).toMatchObject({ environment: "production", label: "db-prod-1" });
    popProd();
    expect(activeEnvironment()).toMatchObject({ environment: "test" });
    popTest();
    expect(activeEnvironment().environment).toBe("local");
  });

  it("scopes a context to a component's lifetime", () => {
    const active = renderHook(() => useActiveEnvironment());
    const scope = renderHook(() => useEnvironmentScope("production", "db"));
    expect(active.result.current).toMatchObject({ environment: "production", label: "db" });
    scope.unmount();
    expect(active.result.current.environment).toBe("local");
  });
});

describe("command registry", () => {
  beforeEach(() => useCommandStore.setState({ commands: [], recent: [] }));
  const cmd = (id: string, run = vi.fn()): StudioCommand => ({ id, title: id, run });

  it("registers, replaces by id and unregisters only its own entry", () => {
    const first = cmd("a");
    const offFirst = registerCommand(first);
    const second = cmd("a");
    const offSecond = registerCommand(second);
    expect(useCommandStore.getState().commands).toEqual([second]);
    offFirst();
    expect(useCommandStore.getState().commands).toEqual([second]);
    offSecond();
    expect(useCommandStore.getState().commands).toEqual([]);
  });

  it("runs commands and records recents (most recent first, max 5)", async () => {
    const run = vi.fn();
    registerCommand(cmd("x", run));
    for (const id of ["1", "2", "3", "4", "5"]) registerCommand(cmd(id));
    expect(await runCommand("x")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    for (const id of ["1", "2", "3", "4", "5"]) await runCommand(id);
    expect(useCommandStore.getState().recent).toEqual(["5", "4", "3", "2", "1"]);
    expect(await runCommand("missing")).toBe(false);
  });

  it("useRegisterCommands follows the component lifecycle", () => {
    const list = [cmd("hook")];
    const { unmount } = renderHook(() => useRegisterCommands(list));
    expect(useCommandStore.getState().commands.map((c) => c.id)).toEqual(["hook"]);
    unmount();
    expect(useCommandStore.getState().commands).toEqual([]);
  });
});

describe("connection helpers", () => {
  it("classifies unreachable vs missing endpoints", () => {
    expect(isUnreachable(new ApiError(0, "network", "x"))).toBe(true);
    expect(isUnreachable(new ApiError(502, "http_error", "x"))).toBe(true);
    expect(isUnreachable(new ApiError(500, "http_error", "x"))).toBe(true);
    expect(isUnreachable(new ApiError(500, "internal", "x"))).toBe(false);
    expect(isUnreachable(new ApiError(404, "not_found", "x"))).toBe(false);
    expect(isUnreachable(new SyntaxError("bad json"))).toBe(true);
    expect(isMissingEndpoint(new ApiError(404, "not_found", "x"))).toBe(true);
    expect(isMissingEndpoint(new ApiError(401, "unauthorized", "x"))).toBe(false);
  });
});

describe("appearance", () => {
  it("applies theme preferences to the root element", () => {
    const root = document.createElement("html");
    applyTheme("dark", root);
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.hasAttribute("data-theme-switching")).toBe(true);
    applyTheme("system", root);
    expect(root.hasAttribute("data-theme")).toBe(false);
    applyReduceMotion("on", root);
    expect(root.getAttribute("data-reduce-motion")).toBe("on");
    applyReduceMotion("system", root);
    expect(root.hasAttribute("data-reduce-motion")).toBe(false);
  });

  it("validates prefs and maps motion config", () => {
    expect(isThemePref("dark")).toBe(true);
    expect(isThemePref("sepia")).toBe(false);
    expect(motionConfigFor("on")).toBe("always");
    expect(motionConfigFor("off")).toBe("never");
    expect(motionConfigFor("system")).toBe("user");
  });
});
