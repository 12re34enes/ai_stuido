import { parseInline, parseMarkdown, safeHref } from "./parse";

describe("parseMarkdown", () => {
  it("parses headings, paragraphs and rules", () => {
    const blocks = parseMarkdown("# Başlık\n\nBir paragraf\nikinci satır.\n\n---\n## Alt");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "hr", "heading"]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
  });

  it("parses fenced code with language", () => {
    const [code] = parseMarkdown("```ts\nconst a = 1;\n\nlet b = 2;\n```");
    expect(code).toEqual({ type: "code", lang: "ts", text: "const a = 1;\n\nlet b = 2;" });
  });

  it("parses nested lists and task items", () => {
    const [list] = parseMarkdown("- bir\n  - iç\n- [x] bitti\n- [ ] yapılacak");
    expect(list?.type).toBe("list");
    if (list?.type !== "list") throw new Error();
    expect(list.items).toHaveLength(3);
    expect(list.items[0]!.children.map((b) => b.type)).toEqual(["paragraph", "list"]);
    expect(list.items[1]!.checked).toBe(true);
    expect(list.items[2]!.checked).toBe(false);
  });

  it("parses ordered lists with a start number", () => {
    const [list] = parseMarkdown("3. üç\n4. dört");
    expect(list).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  it("parses blockquotes and tables with alignment", () => {
    const blocks = parseMarkdown("> alıntı\n\n| A | B |\n|:--|--:|\n| 1 | 2 |");
    expect(blocks[0]).toMatchObject({ type: "blockquote" });
    expect(blocks[1]).toMatchObject({ type: "table", align: ["left", "right"] });
    if (blocks[1]?.type !== "table") throw new Error();
    expect(blocks[1].rows).toHaveLength(1);
  });
});

describe("parseInline", () => {
  it("parses emphasis, code and strike", () => {
    expect(parseInline("**kalın** ve *italik* `kod` ~~eski~~").map((n) => n.type)).toEqual([
      "strong",
      "text",
      "em",
      "text",
      "code",
      "text",
      "del",
    ]);
  });

  it("keeps snake_case identifiers as text", () => {
    expect(parseInline("workspace_id ve task_id")).toEqual([{ type: "text", text: "workspace_id ve task_id" }]);
  });

  it("only links safe URLs", () => {
    expect(parseInline("[iyi](https://example.com)")[0]).toMatchObject({ type: "link", href: "https://example.com" });
    expect(parseInline("[kötü](javascript:alert(1))")[0]).toMatchObject({ type: "text" });
    expect(parseInline("bkz. https://example.com/a.")[1]).toMatchObject({ type: "link", href: "https://example.com/a" });
  });

  it("treats raw HTML as text", () => {
    expect(parseInline("<b>x</b>")).toEqual([{ type: "text", text: "<b>x</b>" }]);
  });
});

describe("safeHref", () => {
  it("allows http(s) and mailto only", () => {
    expect(safeHref("https://a.b")).toBe("https://a.b");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
  });
});
