/** Split a formatted number into characters keyed from the right, so new digits mount on the left. */
export function numberColumns(text: string): { key: string; char: string; digit: boolean }[] {
  const chars = [...text];
  return chars.map((char, i) => ({ key: `c${chars.length - i}`, char, digit: char >= "0" && char <= "9" }));
}
