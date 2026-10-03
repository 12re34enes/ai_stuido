import { render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import { useShell } from "@/lib/shell";

import { useNewTaskParam } from "./useNewTaskParam";

function Probe({ onLocation }: { onLocation: (search: string) => void }) {
  useNewTaskParam();
  onLocation(useLocation().search);
  return null;
}

describe("useNewTaskParam", () => {
  it("focuses the composer once and drops ?new=1", () => {
    const spy = vi.spyOn(useShell.getState(), "requestComposerFocus");
    const seen: string[] = [];
    render(
      <MemoryRouter initialEntries={["/?new=1&x=2"]}>
        <Probe onLocation={(s) => seen.push(s)} />
      </MemoryRouter>,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe("?x=2");
    spy.mockRestore();
  });
});
