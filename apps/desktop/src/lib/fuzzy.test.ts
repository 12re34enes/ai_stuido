import { foldTurkish, fuzzyScore } from "./fuzzy";

describe("foldTurkish", () => {
  it("folds Turkish case and diacritics", () => {
    expect(foldTurkish("GÖREVLER")).toBe("gorevler");
    expect(foldTurkish("Işık")).toBe("isik");
    expect(foldTurkish("İstanbul")).toBe("istanbul");
    expect(foldTurkish("Çalışma alanı")).toBe("calisma alani");
    expect(foldTurkish("Şişli Ğ Ü")).toBe("sisli g u");
  });
});

describe("fuzzyScore", () => {
  it("matches regardless of Turkish characters and case", () => {
    expect(fuzzyScore("gorev", ["Görevler"])).toBeGreaterThan(0.9);
    expect(fuzzyScore("GÖREV", ["görevler"])).toBeGreaterThan(0.9);
    expect(fuzzyScore("baglanti", ["Bağlantılar"])).toBeGreaterThan(0.9);
  });

  it("ranks prefix > word start > inside > scattered", () => {
    const prefix = fuzzyScore("tema", ["Tema ayarları"]);
    const word = fuzzyScore("tema", ["Koyu tema"]);
    const inside = fuzzyScore("ema", ["Koyu tema"]);
    const scattered = fuzzyScore("kyt", ["Koyu tema"]);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
  });

  it("requires every token to match some field", () => {
    expect(fuzzyScore("koyu tema", ["Koyu tema"])).toBeGreaterThan(0.9);
    expect(fuzzyScore("koyu zzz", ["Koyu tema"])).toBe(0);
    expect(fuzzyScore("dark", ["Koyu tema", "dark", "tema"])).toBeGreaterThan(0.8);
  });

  it("weights the primary label above keywords", () => {
    expect(fuzzyScore("ayar", ["Ayarlar"])).toBeGreaterThan(fuzzyScore("ayar", ["Başka", "ayarlar"]));
  });

  it("returns 0 when nothing matches and 1 for an empty query", () => {
    expect(fuzzyScore("xyz", ["Görevler"])).toBe(0);
    expect(fuzzyScore("   ", ["Görevler"])).toBe(1);
  });
});
