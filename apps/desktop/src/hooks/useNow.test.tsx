import { act, render } from "@testing-library/react";

import { useNow } from "./useNow";

/** Regression: an unstable subscribe re-subscribed every render and looped with a real clock. */
describe("useNow", () => {
  it("renders a bounded number of times with a real clock", async () => {
    let renders = 0;
    function Clock({ enabled = true }: { enabled?: boolean }) {
      renders++;
      const now = useNow(1000, enabled);
      return <span>{now}</span>;
    }
    render(
      <>
        <Clock />
        <Clock />
        <Clock enabled={false} />
      </>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(renders).toBeLessThan(12);
  });

  it("ticks on the interval", async () => {
    vi.useFakeTimers();
    const values: number[] = [];
    function Clock() {
      values.push(useNow(1000));
      return null;
    }
    render(<Clock />);
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    vi.useRealTimers();
    expect(new Set(values).size).toBeGreaterThanOrEqual(3);
  });
});
