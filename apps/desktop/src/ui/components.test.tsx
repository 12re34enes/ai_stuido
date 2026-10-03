import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { renderUI } from "@/test/render";

import { AgentCard } from "./AgentCard";
import { AnimatedNumber } from "./AnimatedNumber";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { CountBadge } from "./CountBadge";
import { EnvBadge } from "./EnvBadge";
import { LimitBar } from "./LimitBar";
import { LogView } from "./LogView";
import { MarkdownView } from "./MarkdownView";
import { RelativeTime } from "./RelativeTime";
import { SegmentedControl } from "./SegmentedControl";
import { StatusDot } from "./StatusDot";
import { Switch } from "./Switch";
import { Textarea } from "./Textarea";

describe("Button", () => {
  it("clicks, and is busy + disabled while loading", async () => {
    const onClick = vi.fn();
    const { rerender } = renderUI(<Button onClick={onClick}>Kaydet</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(
      <Button onClick={onClick} loading>
        Kaydet
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Kaydet" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });
});

describe("Switch and Checkbox", () => {
  it("toggles a switch (uncontrolled) and reports changes", async () => {
    const onChange = vi.fn();
    renderUI(<Switch label="Çapraz inceleme" onCheckedChange={onChange} />);
    const sw = screen.getByRole("switch", { name: "Çapraz inceleme" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("toggles a checkbox and supports indeterminate", async () => {
    renderUI(<Checkbox label="Sınır denetimi" defaultChecked="indeterminate" />);
    const box = screen.getByRole("checkbox", { name: "Sınır denetimi" });
    expect(box).toHaveAttribute("aria-checked", "mixed");
    await userEvent.click(box);
    expect(box).toHaveAttribute("aria-checked", "true");
    await userEvent.click(box);
    expect(box).toHaveAttribute("aria-checked", "false");
  });
});

describe("SegmentedControl", () => {
  function ModePicker() {
    const [mode, setMode] = useState("tek");
    return (
      <SegmentedControl
        aria-label="Mod"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: "tek", label: "Tek" },
          { value: "ikili", label: "İkili" },
          { value: "kurul", label: "Kurul", disabled: true },
          { value: "hat", label: "Hat" },
        ]}
      />
    );
  }

  it("selects by click and moves with arrow keys, skipping disabled options", async () => {
    renderUI(<ModePicker />);
    await userEvent.click(screen.getByRole("radio", { name: "İkili" }));
    expect(screen.getByRole("radio", { name: "İkili" })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Hat" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Hat" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Tek" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("meters and numbers", () => {
  it("LimitBar exposes value and threshold tone", () => {
    renderUI(<LimitBar label="Haftalık" value={93.4} resetsAt={null} />);
    const meter = screen.getByRole("meter", { name: "Haftalık" });
    expect(meter).toHaveAttribute("aria-valuenow", "93");
    expect(meter.firstElementChild).toHaveClass("bg-danger");
    expect(screen.getByText("Sıfırlanma zamanı bilinmiyor")).toBeInTheDocument();
  });

  it("AnimatedNumber formats in Turkish for screen readers", () => {
    renderUI(<AnimatedNumber value={12840} />);
    expect(screen.getByText("12.840")).toHaveClass("sr-only");
  });

  it("CountBadge shows the count, caps it and hides at zero", async () => {
    const { rerender } = renderUI(<CountBadge count={3} aria-label="sayaç" />);
    expect(screen.getByLabelText("sayaç")).toHaveTextContent("3");
    rerender(<CountBadge count={140} aria-label="sayaç" />);
    expect(screen.getByLabelText("sayaç")).toHaveTextContent("99+");
    rerender(<CountBadge count={0} aria-label="sayaç" />);
    await waitFor(() => expect(screen.queryByLabelText("sayaç")).not.toBeInTheDocument());
  });
});

describe("status and identity", () => {
  it("StatusDot announces its state in Turkish", () => {
    const { rerender } = renderUI(<StatusDot status="running" />);
    expect(screen.getByRole("img", { name: "Çalışıyor" })).toBeInTheDocument();
    rerender(<StatusDot status="error" label="Ajan hata verdi" />);
    expect(screen.getByRole("img", { name: "Ajan hata verdi" })).toBeInTheDocument();
  });

  it("EnvBadge labels environments", () => {
    renderUI(<EnvBadge environment="production" label="db-prod-1" />);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("db-prod-1")).toBeInTheDocument();
  });

  it("AgentCard shows provider, state, role, last line and usage", async () => {
    const onClick = vi.fn();
    renderUI(
      <AgentCard
        provider="codex"
        title="review/limit-bars"
        model="gpt-5.5-codex"
        role="reviewer"
        state="waiting_permission"
        lastLine="apply_patch izni bekliyor"
        usage={{ input_tokens: 21400, output_tokens: 1880, context_used: 96000, context_window: 192000 }}
        onClick={onClick}
      />,
    );
    const card = screen.getByRole("button", { name: /review\/limit-bars/ });
    expect(card).toHaveAttribute("data-provider", "codex");
    expect(screen.getByText("İzin bekliyor")).toBeInTheDocument();
    expect(screen.getByText("İnceleyen")).toBeInTheDocument();
    expect(screen.getByText("apply_patch izni bekliyor")).toBeInTheDocument();
    expect(screen.getByText(/%50 bağlam/)).toBeInTheDocument();
    card.focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("text views", () => {
  it("MarkdownView renders safe links only", () => {
    renderUI(<MarkdownView source={"[iyi](https://example.com) ve [kötü](javascript:alert(1))"} />);
    expect(screen.getByRole("link", { name: "iyi" })).toHaveAttribute("href", "https://example.com");
    expect(screen.queryByRole("link", { name: "kötü" })).not.toBeInTheDocument();
  });

  it("LogView shows the empty label without lines", () => {
    renderUI(<LogView lines={[]} emptyLabel="Çıktı bekleniyor" />);
    expect(screen.getByText("Çıktı bekleniyor")).toBeInTheDocument();
  });

  it("Textarea grows with its content up to maxRows", () => {
    renderUI(<Textarea aria-label="Görev" minRows={2} maxRows={4} defaultValue="" />);
    const ta = screen.getByRole("textbox", { name: "Görev" }) as HTMLTextAreaElement;
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 400 });
    act(() => {
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ta.style.overflowY).toBe("auto");
    expect(parseFloat(ta.style.height)).toBeGreaterThan(0);
  });
});

describe("RelativeTime", () => {
  it("shows the relative label with the exact time on hover", async () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    renderUI(<RelativeTime value="2026-10-03T11:57:00Z" now={now} />);
    const time = screen.getByText(/önce/);
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe("2026-10-03T11:57:00.000Z");
    await userEvent.hover(time);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("2026");
  });

  it("renders nothing for an invalid date", () => {
    const { container } = renderUI(<RelativeTime value="yok" now={0} />);
    expect(container.querySelector("time")).toBeNull();
  });
});
