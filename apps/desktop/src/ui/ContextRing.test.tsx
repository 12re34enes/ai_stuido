import { screen } from "@testing-library/react";

import { renderUI } from "@/test/render";

import { ContextBar } from "./ContextBar";
import { ContextRing } from "./ContextRing";
import { contextPercent, contextSummary, contextTone, CONTEXT_CRITICAL_AT, CONTEXT_WARN_AT, isContextJump, totalTokens } from "./contextWindow";
import { TokenMeter } from "./TokenMeter";

describe("context window helpers", () => {
  it("computes the fill and refuses unknown or invalid windows", () => {
    expect(contextPercent(50_000, 200_000)).toBe(25);
    expect(contextPercent(250_000, 200_000)).toBe(100);
    expect(contextPercent(0, 200_000)).toBe(0);
    expect(contextPercent(null, 200_000)).toBeNull();
    expect(contextPercent(10, 0)).toBeNull();
    expect(contextPercent(10, undefined)).toBeNull();
    expect(contextPercent(Number.NaN, 100)).toBeNull();
  });

  it("changes tone at 70% and 90%", () => {
    expect(CONTEXT_WARN_AT).toBe(70);
    expect(CONTEXT_CRITICAL_AT).toBe(90);
    expect(contextTone(0)).toBe("ok");
    expect(contextTone(69.9)).toBe("ok");
    expect(contextTone(70)).toBe("warning");
    expect(contextTone(89.99)).toBe("warning");
    expect(contextTone(90)).toBe("critical");
    expect(contextTone(140)).toBe("critical");
  });

  it("detects jumps worth a pulse", () => {
    expect(isContextJump(20, 26)).toBe(true);
    expect(isContextJump(20, 23)).toBe(false);
    expect(isContextJump(68, 71)).toBe(true); // crossed into warning
    expect(isContextJump(91, 85)).toBe(false); // shrinking never pulses
    expect(isContextJump(null, 50)).toBe(false);
  });

  it("formats the exact figure in Turkish", () => {
    expect(contextSummary(84_000, 200_000)).toBe("84.000 / 200.000 token (%42)");
    expect(totalTokens({ input_tokens: 1200, output_tokens: 300 })).toBe(1500);
    expect(totalTokens(null)).toBe(0);
  });
});

describe("ContextRing", () => {
  it("renders a meter with the exact figure and the tone", () => {
    renderUI(<ContextRing used={150_000} window={200_000} showLabel />);
    const meter = screen.getByRole("meter", { name: "Bağlam" });
    expect(meter).toHaveAttribute("aria-valuenow", "75");
    expect(meter).toHaveAttribute("aria-valuetext", "150.000 / 200.000 token (%75)");
    expect(meter).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("%75")).toBeInTheDocument(); // rolling digits keep an sr-only copy
  });

  it("goes critical at 90% and stays out of the tab order unless asked", () => {
    const { rerender } = renderUI(<ContextRing used={185_000} window={200_000} />);
    expect(screen.getByRole("meter")).toHaveAttribute("data-tone", "critical");
    expect(screen.getByRole("meter")).not.toHaveAttribute("tabindex");
    rerender(<ContextRing used={185_000} window={200_000} focusable label="Alt ajanın bağlamı" />);
    expect(screen.getByRole("meter", { name: "Alt ajanın bağlamı" })).toHaveAttribute("tabindex", "0");
  });

  it("renders nothing when the window is unknown", () => {
    const { container } = renderUI(<ContextRing used={1000} window={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ContextBar and TokenMeter", () => {
  it("shares the thresholds and label", () => {
    renderUI(<ContextBar used={20_000} window={200_000} showLabel />);
    const meter = screen.getByRole("meter", { name: "Bağlam" });
    expect(meter).toHaveAttribute("data-tone", "ok");
    expect(meter).toHaveTextContent(/bağlam$/);
    expect(screen.getByText("%10")).toBeInTheDocument();
  });

  it("shows split or total token counts, nothing for zero", () => {
    const { rerender, container } = renderUI(<TokenMeter usage={{ input_tokens: 48_210, output_tokens: 6_120 }} />);
    expect(container).toHaveTextContent("giriş");
    expect(container).toHaveTextContent("çıkış");
    rerender(<TokenMeter usage={{ input_tokens: 48_210, output_tokens: 6_120 }} variant="total" />);
    expect(screen.getByText("54,3 B")).toBeInTheDocument();
    expect(container).toHaveTextContent(/token$/);
    rerender(<TokenMeter usage={{ input_tokens: 0, output_tokens: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
