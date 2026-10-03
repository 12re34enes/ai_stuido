/**
 * Preparing memory Markdown for display: HTML comments (the starter files are full of writing
 * hints) are removed, and headings left without content get a quiet placeholder.
 */

/** Remove `<!-- … -->` comments outside fenced code blocks. */
export function stripHtmlComments(markdown: string): string {
  const parts = markdown.split(/(^\s{0,3}(?:```|~~~)[^\n]*\n[\s\S]*?^\s{0,3}(?:```|~~~)[ \t]*$)/m);
  return parts.map((part, i) => (i % 2 === 1 ? part : part.replace(/<!--[\s\S]*?-->/g, ""))).join("");
}

/** Add `placeholder` under headings whose section is empty (up to the next heading of any level). */
export function fillEmptySections(markdown: string, placeholder: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
    out.push(line);
    if (inFence || !/^#{2,6}\s+\S/.test(line)) continue;
    // Look ahead: blank lines until the next heading or end of document → empty section.
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === "") j++;
    const next = lines[j];
    const level = /^(#+)/.exec(line)![1]!.length;
    const nextLevel = next ? /^(#+)\s/.exec(next)?.[1]?.length : undefined;
    if (next === undefined || (nextLevel !== undefined && nextLevel <= level)) out.push("", placeholder);
  }
  return out.join("\n");
}

/** Collapse runs of blank lines left behind by removed comments. */
export function tidy(markdown: string): string {
  return markdown.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function displayMarkdown(markdown: string, placeholder: string): string {
  return fillEmptySections(tidy(stripHtmlComments(markdown)), placeholder);
}

/** Drop one trailing newline: diff views would otherwise show (and count) an empty last line. */
export function forDiff(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
