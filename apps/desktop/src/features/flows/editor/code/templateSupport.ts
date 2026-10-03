/**
 * CodeMirror support for Jinja prompt templates, built only on @codemirror/view + state:
 *
 * - highlighting of `{{ … }}` / `{% … %}` (variables, filters, keywords, strings) and a warning
 *   underline for references to nodes that don't exist,
 * - `{{` / `{%` auto-closing,
 * - a token-styled completion popover for template variables and filters (↑↓, Enter/Tab, Esc,
 *   ⌃Space to open explicitly).
 */
import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  MatchDecorator,
  showTooltip,
  tooltips,
  ViewPlugin,
  type DecorationSet,
  type Tooltip,
  type TooltipView,
  type ViewUpdate,
} from "@codemirror/view";

import { completionSite, rankVars, TEMPLATE_FILTERS, type TemplateVar, type VarGroup } from "../../model/templateVars";

export type TemplateMode = "template" | "expression";

// ----------------------------------------------------------------------------- variables

export const setVariables = StateEffect.define<{ vars: TemplateVar[]; nodeIds: string[] }>();

const variablesField = StateField.define<{ vars: TemplateVar[]; nodeIds: Set<string> }>({
  create: () => ({ vars: [], nodeIds: new Set() }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setVariables)) return { vars: e.value.vars, nodeIds: new Set(e.value.nodeIds) };
    return value;
  },
});

// ----------------------------------------------------------------------------- highlighting

const deco = {
  delim: Decoration.mark({ class: "cm-tpl-delim" }),
  variable: Decoration.mark({ class: "tok-propertyName" }),
  filter: Decoration.mark({ class: "tok-function" }),
  keyword: Decoration.mark({ class: "tok-keyword" }),
  string: Decoration.mark({ class: "tok-string" }),
  number: Decoration.mark({ class: "tok-number" }),
  tag: Decoration.mark({ class: "cm-tpl-tag" }),
};

const KEYWORDS = new Set(["if", "elif", "else", "endif", "for", "endfor", "in", "not", "and", "or", "is", "set", "endset", "true", "false", "none", "True", "False", "None", "loop"]);

function unknownMark(ref: string) {
  return Decoration.mark({ class: "cm-tpl-unknown", attributes: { title: `Bilinmeyen düğüm: ${ref}` } });
}

/** Decorate the inside of one tag/expression starting at document offset `base`. */
function decorateBody(add: (from: number, to: number, d: Decoration) => void, body: string, base: number, nodeIds: Set<string> | null) {
  const token = /'[^']*'?|"[^"]*"?|\d+(?:\.\d+)?|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\|/g;
  let afterPipe = false;
  for (let m = token.exec(body); m; m = token.exec(body)) {
    const text = m[0];
    const from = base + m.index;
    const to = from + text.length;
    if (text === "|") {
      afterPipe = true;
      continue;
    }
    if (text.startsWith("'") || text.startsWith('"')) add(from, to, deco.string);
    else if (/^\d/.test(text)) add(from, to, deco.number);
    else if (afterPipe) add(from, to, deco.filter);
    else if (KEYWORDS.has(text)) add(from, to, deco.keyword);
    else {
      const parts = text.split(".");
      const missing = nodeIds && (parts[0] === "nodes" || parts[0] === "gate") && parts[1] && !nodeIds.has(parts[1]);
      add(from, to, missing ? unknownMark(`${parts[0]}.${parts[1]}`) : deco.variable);
    }
    afterPipe = false;
  }
}

function templateDecorator(nodeIdsOf: (view: EditorView) => Set<string> | null) {
  return new MatchDecorator({
    regexp: /(\{\{|\{%)([\s\S]*?)(\}\}|%\})/g,
    decorate: (add, from, to, match, view) => {
      const open = match[1]!;
      const close = match[3]!;
      add(from, to, deco.tag);
      add(from, from + open.length, deco.delim);
      decorateBody(add, match[2] ?? "", from + open.length, nodeIdsOf(view));
      add(to - close.length, to, deco.delim);
    },
  });
}

function highlighter(mode: TemplateMode): Extension {
  const nodeIdsOf = (view: EditorView) => {
    const ids = view.state.field(variablesField, false)?.nodeIds;
    return ids && ids.size ? ids : null;
  };
  if (mode === "expression") {
    const build = (view: EditorView): DecorationSet => {
      const ranges: { from: number; to: number; d: Decoration }[] = [];
      decorateBody((from, to, d) => ranges.push({ from, to, d }), view.state.doc.toString(), 0, nodeIdsOf(view));
      return Decoration.set(
        ranges.map((r) => r.d.range(r.from, r.to)),
        true,
      );
    };
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setVariables)))) this.decorations = build(u.view);
        }
      },
      { decorations: (v) => v.decorations },
    );
  }
  const decorator = templateDecorator(nodeIdsOf);
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        if (u.transactions.some((t) => t.effects.some((e) => e.is(setVariables)))) this.decorations = decorator.createDeco(u.view);
        else this.decorations = decorator.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ----------------------------------------------------------------------------- auto-close

const autoClose = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "{" && text !== "%") return false;
  const state = view.state;
  const before = state.sliceDoc(Math.max(0, from - 1), from);
  const after = state.sliceDoc(to, to + 2);
  if (before !== "{" || after.startsWith("}") || after.startsWith("%")) return false;
  const insert = text === "{" ? "{  }}" : "%  %}";
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + 2),
    userEvent: "input.type",
  });
  return true;
});

// ----------------------------------------------------------------------------- completion

interface CompletionState {
  from: number;
  to: number;
  options: TemplateVar[];
  selected: number;
  needsClose: boolean;
}

const openCompletion = StateEffect.define<boolean>();
const closeCompletion = StateEffect.define<null>();
const moveSelection = StateEffect.define<number>();

function computeCompletion(state: EditorState, mode: TemplateMode, explicit: boolean): CompletionState | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const pos = sel.head;
  const line = state.doc.lineAt(pos);
  const before = mode === "expression" ? state.sliceDoc(0, pos) : state.sliceDoc(Math.max(0, pos - 2000), pos);
  const after = state.sliceDoc(pos, line.to);
  const site = completionSite(before, after, mode);
  if (!site) return null;
  if (!explicit && !site.prefix && !site.filter && !/(\{\{|\{%)\s*$/.test(before) && mode === "template") return null;
  if (!explicit && !site.prefix && mode === "expression") return null;
  const vars = site.filter ? TEMPLATE_FILTERS : state.field(variablesField).vars;
  const options = rankVars(vars, site.prefix, 50);
  if (!options.length) return null;
  if (options.length === 1 && options[0]!.path === site.prefix) return null;
  return { from: pos - site.prefix.length, to: pos, options, selected: 0, needsClose: site.needsClose && !site.filter };
}

function completionField(mode: TemplateMode) {
  return StateField.define<CompletionState | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(closeCompletion)) return null;
        if (e.is(openCompletion)) return computeCompletion(tr.state, mode, true);
        if (e.is(moveSelection) && value) {
          const n = value.options.length;
          return { ...value, selected: (value.selected + e.value + n) % n };
        }
      }
      if (tr.docChanged) {
        const typing = tr.isUserEvent("input.type") || tr.isUserEvent("delete.backward") || tr.isUserEvent("input.complete");
        if (tr.isUserEvent("input.complete")) return null;
        if (typing) return computeCompletion(tr.state, mode, false);
        return null;
      }
      if (tr.selection && value) {
        const head = tr.state.selection.main.head;
        if (head < value.from || head > value.to + 0) return null;
      }
      return value;
    },
    provide: (f) => showTooltip.from(f, (v) => (v ? completionTooltip(v) : null)),
  });
}

const GROUP_LABEL: Record<VarGroup, string> = {
  input: "girdi",
  nodes: "düğüm",
  memory: "hafıza",
  review: "inceleme",
  gate: "kapı",
  task: "görev",
  workspace: "alan",
  repo: "repo",
  feedback: "döngü",
  filter: "filtre",
};

function completionTooltip(v: CompletionState): Tooltip {
  return { pos: v.from, above: false, strictSide: false, create: createCompletionView };
}

function createCompletionView(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  dom.className = "cm-tpl-completions";
  dom.setAttribute("role", "listbox");
  dom.setAttribute("aria-label", "Şablon değişkenleri");
  const list = document.createElement("ul");
  dom.appendChild(list);
  let lastKey = "";

  const render = () => {
    const v = stateOf(view)?.value;
    if (!v) return;
    const key = v.options.map((o) => o.path).join("|");
    if (key !== lastKey) {
      lastKey = key;
      list.replaceChildren(
        ...v.options.map((o, i) => {
          const li = document.createElement("li");
          li.setAttribute("role", "option");
          li.dataset.index = String(i);
          const label = document.createElement("span");
          label.className = "cm-tpl-c-label";
          label.textContent = o.path;
          const detail = document.createElement("span");
          detail.className = "cm-tpl-c-detail";
          detail.textContent = o.detail;
          const group = document.createElement("span");
          group.className = "cm-tpl-c-group";
          group.textContent = GROUP_LABEL[o.group];
          li.append(label, detail, group);
          li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            accept(view, i);
          });
          return li;
        }),
      );
    }
    list.querySelectorAll("li").forEach((li, i) => {
      const on = i === v.selected;
      li.classList.toggle("is-selected", on);
      li.setAttribute("aria-selected", String(on));
      if (on) li.scrollIntoView({ block: "nearest" });
    });
  };

  render();
  return { dom, update: () => render(), offset: { x: -10, y: 6 } };
}

/** One completion field per editor mode (shared by every editor of that mode). */
const fieldsByMode: Record<TemplateMode, StateField<CompletionState | null>> = {
  template: completionField("template"),
  expression: completionField("expression"),
};
const fields = Object.values(fieldsByMode);

function stateOf(view: EditorView): { field: StateField<CompletionState | null>; value: CompletionState } | null {
  for (const f of fields) {
    const v = view.state.field(f, false);
    if (v) return { field: f, value: v };
  }
  return null;
}

function accept(view: EditorView, index?: number): boolean {
  const found = stateOf(view);
  if (!found) return false;
  const v = found.value;
  const option = v.options[index ?? v.selected];
  if (!option) return false;
  const after = view.state.sliceDoc(v.to, v.to + 3);
  const insert = option.path + (v.needsClose && !/^\s*\}\}/.test(after) ? " }}" : "");
  // Place the cursor inside a call's parentheses: clip(|4000) is more useful at the end though.
  view.dispatch({
    changes: { from: v.from, to: v.to, insert },
    selection: EditorSelection.cursor(v.from + option.path.length),
    userEvent: "input.complete",
    effects: closeCompletion.of(null),
  });
  return true;
}

const completionKeymap = Prec.highest(
  keymap.of([
    {
      key: "ArrowDown",
      run: (view) => {
        if (!stateOf(view)) return false;
        view.dispatch({ effects: moveSelection.of(1) });
        return true;
      },
    },
    {
      key: "ArrowUp",
      run: (view) => {
        if (!stateOf(view)) return false;
        view.dispatch({ effects: moveSelection.of(-1) });
        return true;
      },
    },
    { key: "Enter", run: (view) => accept(view) },
    { key: "Tab", run: (view) => accept(view) },
    {
      key: "Escape",
      run: (view) => {
        if (!stateOf(view)) return false;
        view.dispatch({ effects: closeCompletion.of(null) });
        return true;
      },
    },
    {
      key: "Ctrl-Space",
      run: (view) => {
        view.dispatch({ effects: openCompletion.of(true) });
        return true;
      },
    },
  ]),
);

const closeOnBlur = EditorView.domEventHandlers({
  blur: (_e, view) => {
    if (stateOf(view)) setTimeout(() => view.dispatch({ effects: closeCompletion.of(null) }), 0);
    return false;
  },
});

const completionTheme = EditorView.theme({
  ".cm-tpl-delim": { color: "var(--accent)" },
  ".cm-tpl-tag": { backgroundColor: "color-mix(in srgb, var(--accent-soft) 55%, transparent)", borderRadius: "3px" },
  ".cm-tpl-unknown": {
    textDecoration: "underline wavy var(--warning)",
    textUnderlineOffset: "3px",
    textDecorationThickness: "1px",
  },
  ".cm-tooltip": { border: "none", background: "transparent", zIndex: "var(--z-tooltip)" },
  ".cm-tpl-completions": {
    minWidth: "300px",
    maxWidth: "420px",
    maxHeight: "232px",
    overflowY: "auto",
    padding: "4px",
    border: "1px solid var(--line)",
    borderRadius: "10px",
    background: "var(--surface-raised)",
    boxShadow: "var(--shadow-2)",
    fontFamily: "var(--font-sans)",
    transformOrigin: "top left",
    animation: "studio-line-in var(--dur-micro) var(--ease-out)",
  },
  ".cm-tpl-completions ul": { listStyle: "none", margin: "0", padding: "0" },
  ".cm-tpl-completions li": {
    display: "grid",
    gridTemplateColumns: "minmax(0, auto) minmax(0, 1fr) auto",
    alignItems: "baseline",
    columnGap: "10px",
    padding: "5px 8px",
    borderRadius: "6px",
    cursor: "default",
    transition: "background-color var(--dur-micro) var(--ease-out)",
  },
  ".cm-tpl-completions li.is-selected": { backgroundColor: "var(--accent-soft)" },
  ".cm-tpl-c-label": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    color: "var(--fg)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".cm-tpl-c-detail": {
    fontSize: "11px",
    color: "var(--fg-muted)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".cm-tpl-c-group": { fontSize: "10px", color: "var(--fg-faint)", textTransform: "uppercase", letterSpacing: "0.04em" },
  ".cm-placeholder": { color: "var(--fg-faint)" },
});

/** Everything a template / expression editor needs. */
export function templateSupport(mode: TemplateMode): Extension {
  return [
    variablesField,
    fieldsByMode[mode],
    highlighter(mode),
    mode === "template" ? autoClose : [],
    completionKeymap,
    closeOnBlur,
    completionTheme,
    // Render popovers into <body>: inspector panels are transformed and clip their overflow.
    tooltips({ parent: document.body, position: "fixed" }),
  ];
}

/** Whether a completion popover is open in this view. */
export function completionOpen(view: EditorView): boolean {
  return stateOf(view) !== null;
}
