import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "@/lib/types";
import { renderWithRouter } from "@/test/render";

import { useComposer } from "./composerStore";
import { TaskComposer } from "./TaskComposer";

const post = vi.fn();

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status = 400;
    code = "validation";
    details: Record<string, unknown> = {};
  }
  return {
    ApiError,
    api: {
      get: vi.fn(async (path: string) => {
        if (path === "/studios") return [];
        if (path === "/engine/modes") return [{ mode: "duo", label: "İkili", description: "Bir sağlayıcı yazar, diğeri inceler." }];
        if (path.startsWith("/engine/modes/")) return { nodes: [], edges: [] };
        if (path === "/engine/flows") return [];
        if (path.endsWith("/repos")) return [];
        return [];
      }),
      post: (path: string, body: unknown) => post(path, body),
    },
  };
});

const workspace: Workspace = { id: "ws_1", name: "Ödeme servisi", slug: "odeme", color: "#C96442", archived: false, settings: {}, created_at: "", updated_at: "" };

describe("TaskComposer", () => {
  beforeEach(() => {
    post.mockReset();
    useComposer.getState().reset();
    useComposer.getState().setMode("duo");
  });

  it("shows the derived title and refuses an empty prompt", async () => {
    renderWithRouter(<TaskComposer workspace={workspace} />);
    fireEvent.click(screen.getByRole("button", { name: /Başlat/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Görevi birkaç cümleyle anlat.");
    expect(post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "Görev" }), { target: { value: "## Kur farkı satırı ekle\nayrıntı" } });
    expect(screen.getByRole("textbox", { name: "Başlık (isteğe bağlı)" })).toHaveAttribute("placeholder", "Başlık: Kur farkı satırı ekle");
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("creates the task with ⌘↵ / Ctrl↵ and navigates to it", async () => {
    post.mockResolvedValue({ task: { id: "task_9", title: "Kur farkı satırı ekle", workspace_id: "ws_1", status: "running" }, current_run: null });
    const { router } = renderWithRouter(<TaskComposer workspace={workspace} />);
    const prompt = screen.getByRole("textbox", { name: "Görev" });
    fireEvent.change(prompt, { target: { value: "Kur farkı satırı ekle" } });
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true, ctrlKey: true });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[0]).toBe("/engine/tasks");
    expect(post.mock.calls[0]?.[1]).toMatchObject({ workspace_id: "ws_1", title: "Kur farkı satırı ekle", mode: "duo", start: true });
    await waitFor(() => expect(router.state.location.pathname).toBe("/tasks/task_9"));
  });
});
