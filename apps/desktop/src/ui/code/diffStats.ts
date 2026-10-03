/**
 * Line-level added/removed counts for a diff header ("+12 −3"). LCS on lines; above the size
 * guard it falls back to a cheap multiset comparison so huge files never block the UI.
 */
export function diffStats(original: string, modified: string, guard = 1500): { added: number; removed: number } {
  const a = original === "" ? [] : original.split("\n");
  const b = modified === "" ? [] : modified.split("\n");
  // Trim common prefix/suffix first (most diffs are local).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length === 0 || y.length === 0) return { added: y.length, removed: x.length };
  if (x.length * y.length > guard * guard) {
    const counts = new Map<string, number>();
    for (const l of x) counts.set(l, (counts.get(l) ?? 0) + 1);
    let common = 0;
    for (const l of y) {
      const c = counts.get(l) ?? 0;
      if (c > 0) {
        common++;
        counts.set(l, c - 1);
      }
    }
    return { added: y.length - common, removed: x.length - common };
  }
  // Classic DP with two rows.
  let prev = new Array<number>(y.length + 1).fill(0);
  let cur = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[y.length] ?? 0;
  return { added: y.length - lcs, removed: x.length - lcs };
}
