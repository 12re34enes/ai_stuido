import { render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { PromptEditor } from "./PromptEditor";

function viewOf(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("no editor view");
  return view;
}

describe("PromptEditor", () => {
  it("reports user edits but not external value syncs (keeps undo/redo history intact)", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<PromptEditor value="{{ input.prompt }}" onChange={onChange} aria-label="Prompt" />);
    const view = viewOf(container);
    expect(view.state.doc.toString()).toBe("{{ input.prompt }}");

    // External change (e.g. undo in the graph store): applied silently.
    rerender(<PromptEditor value="{{ task.title }}" onChange={onChange} aria-label="Prompt" />);
    expect(view.state.doc.toString()).toBe("{{ task.title }}");
    expect(onChange).not.toHaveBeenCalled();

    // A user edit is reported.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" }, userEvent: "input.type" });
    expect(onChange).toHaveBeenCalledWith("{{ task.title }}!");
  });

  it("keeps single-line editors on one line", () => {
    const onChange = vi.fn();
    const { container } = render(<PromptEditor value="main" onChange={onChange} singleLine aria-label="Branch" />);
    const view = viewOf(container);
    view.dispatch({ changes: { from: 4, insert: "\nnext" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe("main");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("auto-closes {{ and opens variable suggestions", () => {
    const onChange = vi.fn();
    const { container } = render(<PromptEditor value="" onChange={onChange} variables={[{ path: "input.prompt", detail: "Görev metni", group: "input", boost: 10 }]} aria-label="Prompt" />);
    const view = viewOf(container);
    // Simulate typing "{" twice through the input handlers.
    view.dispatch({ changes: { from: 0, insert: "{" }, selection: { anchor: 1 }, userEvent: "input.type" });
    const handled = view.state.facet(EditorView.inputHandler).some((h) => h(view, 1, 1, "{", () => view.state.update({ changes: { from: 1, insert: "{" } })));
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe("{{  }}");
    expect(view.state.selection.main.head).toBe(3);
    view.dispatch({ changes: { from: 3, insert: "inp" }, selection: { anchor: 6 }, userEvent: "input.type" });
    expect(document.querySelector('[role="listbox"][aria-label="Şablon değişkenleri"]')?.textContent).toContain("input.prompt");
  });
});
