import { screen, waitFor } from "@testing-library/react";

import { ApiError, api } from "@/lib/api";
import { renderUI } from "@/test/render";

import { SubagentTree } from "./SubagentTree";
import { resetSubagentLive } from "./subagent/store";

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, get: vi.fn() } };
});

vi.mock("@/lib/events", () => ({
  EventStream: class {
    subscribe() {
      return () => undefined;
    }
    close() {}
  },
}));

const get = vi.mocked(api.get);

const LIST = [
  { subagent_id: "a", name: "Explore", description: "Modülleri tara", status: "success", input_tokens: 1200, output_tokens: 300, tool_calls: 2 },
  { subagent_id: "b", name: "general-purpose", description: "Testleri yaz", status: "running", last_text: "pnpm test çalıştırılıyor" },
  { subagent_id: "c", parent_subagent_id: "b", name: "fixture-builder", description: "Fikstür", status: "running" },
];

beforeEach(() => {
  resetSubagentLive();
  get.mockReset();
});

describe("SubagentTree (contract component)", () => {
  it("full: backfills from the API and renders the nested tree", async () => {
    get.mockResolvedValue(LIST);
    const { container } = renderUI(<SubagentTree sessionId="ses_1" provider="claude" />);
    expect(screen.getByText("Alt ajanlar yükleniyor…")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll("[data-subagent-id]")).toHaveLength(3));
    expect(get).toHaveBeenCalledWith("/agents/sessions/ses_1/subagents");
    expect(container.querySelector('[data-subagent-id="c"]')).toHaveAttribute("data-depth", "1");
  });

  it("full: an empty list and a missing endpoint both read as 'no subagents yet'", async () => {
    get.mockRejectedValue(new ApiError(404, "not_found", "Bulunamadı"));
    renderUI(<SubagentTree sessionId="ses_2" />);
    expect(await screen.findByText("Henüz alt ajan yok")).toBeInTheDocument();
  });

  it("full: a real failure offers a retry", { timeout: 15_000 }, async () => {
    get.mockRejectedValue(new ApiError(500, "boom", "Sunucu hatası"));
    renderUI(<SubagentTree sessionId="ses_3" />);
    // Transient server errors are retried twice before the error state shows.
    expect(await screen.findByText("Alt ajanlar yüklenemedi", undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tekrar dene" })).toBeInTheDocument();
  });

  it("compact: dots with a count, nothing while there are no subagents", async () => {
    get.mockResolvedValue(LIST);
    renderUI(<SubagentTree sessionId="ses_4" compact />);
    expect(await screen.findByRole("button", { name: "Alt ajanlar: 3 alt ajan · 2 çalışıyor" })).toHaveTextContent("3");
    get.mockResolvedValue([]);
    const { container } = renderUI(<SubagentTree sessionId="ses_5" compact />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/agents/sessions/ses_5/subagents"));
    expect(container).toBeEmptyDOMElement();
  });
});
