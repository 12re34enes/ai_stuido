import { color256, parseAnsi, stripAnsi } from "./ansi";

const E = "\x1b";

describe("parseAnsi", () => {
  it("returns plain text as one segment", () => {
    expect(parseAnsi("merhaba").segments).toEqual([{ text: "merhaba" }]);
  });

  it("maps 16 colors to tokens and resets", () => {
    const { segments } = parseAnsi(`${E}[32m✓${E}[0m geçti ${E}[91mhata${E}[39m`);
    expect(segments).toEqual([
      { text: "✓", fg: "var(--ansi-green)" },
      { text: " geçti " },
      { text: "hata", fg: "var(--ansi-bright-red)" },
    ]);
  });

  it("handles bold, dim and combined params", () => {
    const { segments } = parseAnsi(`${E}[1;31mHata${E}[22m normal${E}[2m soluk`);
    expect(segments[0]).toMatchObject({ text: "Hata", bold: true, fg: "var(--ansi-red)" });
    expect(segments[1]).toMatchObject({ text: " normal", bold: false, fg: "var(--ansi-red)" });
    expect(segments[2]).toMatchObject({ text: " soluk", dim: true });
  });

  it("supports 256-color and truecolor", () => {
    const { segments } = parseAnsi(`${E}[38;5;208ma${E}[48;2;10;20;30mb`);
    expect(segments[0]).toMatchObject({ text: "a", fg: "rgb(255, 135, 0)" });
    expect(segments[1]).toMatchObject({ text: "b", bg: "rgb(10, 20, 30)" });
  });

  it("carries state across lines", () => {
    const first = parseAnsi(`${E}[33muyarı başlıyor`);
    const second = parseAnsi("devam ediyor", first.state);
    expect(second.segments[0]).toMatchObject({ fg: "var(--ansi-yellow)" });
  });

  it("strips non-SGR sequences", () => {
    expect(parseAnsi(`a${E}[2Kb${E}]0;title\x07c`).segments).toEqual([{ text: "abc" }]);
  });
});

describe("color256", () => {
  it("covers the palette ranges", () => {
    expect(color256(1)).toBe("var(--ansi-red)");
    expect(color256(9)).toBe("var(--ansi-bright-red)");
    expect(color256(16)).toBe("rgb(0, 0, 0)");
    expect(color256(231)).toBe("rgb(255, 255, 255)");
    expect(color256(232)).toBe("rgb(8, 8, 8)");
    expect(color256(300)).toBeUndefined();
  });
});

describe("stripAnsi", () => {
  it("removes every escape", () => {
    expect(stripAnsi(`${E}[1;32m✓${E}[0m tamam`)).toBe("✓ tamam");
  });
});
