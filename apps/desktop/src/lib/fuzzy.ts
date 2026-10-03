/**
 * Turkish-aware fuzzy matching for the command palette.
 *
 * - Folds case with the Turkish locale (İ→i, I→ı) and then strips diacritics, so "gorev",
 *   "GÖREV" and "görev" all match "Görevler", and "isik" matches "Işık".
 * - Scores contiguous and word-start matches higher than scattered subsequences.
 */

const FOLD: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };

export function foldTurkish(input: string): string {
  return input
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşüâîû]/g, (c) => FOLD[c] ?? c)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] ?? "";
  return /[\s\-_/.:·(]/.test(prev);
}

/** Score one folded query token against folded text: 0 = no match, up to 1. */
function scoreToken(text: string, token: string): number {
  if (!token) return 1;
  const idx = text.indexOf(token);
  if (idx !== -1) {
    // Contiguous: best at the start, then at a word start, then anywhere.
    if (idx === 0) return 1;
    return isBoundary(text, idx) ? 0.92 : 0.8;
  }
  // Subsequence with bonuses for word starts and runs.
  let ti = 0;
  let score = 0;
  let run = 0;
  let first = -1;
  let prev = -2;
  for (let qi = 0; qi < token.length; qi++) {
    const found = text.indexOf(token[qi] ?? "", ti);
    if (found === -1) return 0;
    if (first === -1) first = found;
    run = found === prev + 1 ? run + 1 : 0;
    score += 1 + (isBoundary(text, found) ? 0.8 : 0) + run * 0.5;
    prev = found;
    ti = found + 1;
  }
  const max = token.length * 2.3;
  const spread = (ti - first) / Math.max(token.length, 1);
  return Math.max(0.05, Math.min(0.7, (score / max) * 0.75 - Math.min(0.25, (spread - 1) * 0.02)));
}

/**
 * Score a candidate. `fields[0]` is the primary label (weighted fully); others (subtitle,
 * keywords, group) count at 85%. Every whitespace-separated query token must match some field.
 */
export function fuzzyScore(query: string, fields: readonly (string | undefined)[]): number {
  const tokens = foldTurkish(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;
  const folded = fields.map((f) => (f ? foldTurkish(f) : ""));
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    folded.forEach((text, i) => {
      if (!text) return;
      const s = scoreToken(text, token) * (i === 0 ? 1 : 0.85);
      if (s > best) best = s;
    });
    if (best === 0) return 0;
    total += best;
  }
  return total / tokens.length;
}
