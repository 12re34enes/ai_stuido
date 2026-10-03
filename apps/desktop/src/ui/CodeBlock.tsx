import { useEffect, useMemo, useState } from "react";

import { highlightLines, type Token } from "./code/highlight";
import { cn } from "./cn";
import { CopyButton } from "./CopyButton";

export interface CodeBlockProps {
  code: string;
  /** Language name or file extension ("ts", "python", "yaml", "bash"). */
  language?: string;
  filename?: string;
  lineNumbers?: boolean;
  wrap?: boolean;
  /** Max height before the block scrolls (px). */
  maxHeight?: number;
  copyable?: boolean;
  /** Highlight these 1-based line numbers. */
  highlight?: number[];
  className?: string;
}

/**
 * Read-only code with token-colored syntax. Renders plain text immediately and upgrades to
 * highlighted spans once the language parser has loaded (no layout shift: same glyphs).
 */
export function CodeBlock({
  code,
  language,
  filename,
  lineNumbers = false,
  wrap = false,
  maxHeight,
  copyable = true,
  highlight,
  className,
}: CodeBlockProps) {
  const [result, setResult] = useState<{ key: string; lines: Token[][] } | null>(null);
  const key = `${language ?? ""}\u0000${code}`;
  useEffect(() => {
    let alive = true;
    void highlightLines(code, language).then((lines) => {
      if (alive && lines) setResult({ key, lines });
    });
    return () => {
      alive = false;
    };
  }, [code, key, language]);

  const plain = useMemo(() => code.replace(/\n$/, "").split("\n"), [code]);
  const tokens = result?.key === key ? result.lines : null;
  const marked = useMemo(() => new Set(highlight ?? []), [highlight]);
  const header = filename || language;

  return (
    <div className={cn("group/code relative overflow-hidden rounded-lg border border-line bg-code", className)}>
      {header && (
        <div className="flex h-8 items-center justify-between gap-2 border-b border-line-subtle pr-1.5 pl-3">
          <span className="truncate font-mono text-2xs text-fg-muted">{filename ?? language}</span>
          {copyable && <CopyButton value={code} size="xs" />}
        </div>
      )}
      {!header && copyable && (
        <CopyButton
          value={code}
          size="xs"
          className="absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        />
      )}
      <pre
        className={cn("overflow-auto py-2.5 font-mono text-xs leading-5 text-fg", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}
        style={{ maxHeight }}
      >
        <code className="block min-w-fit">
          {plain.map((line, i) => (
            <span
              key={i}
              className={cn("flex px-3", marked.has(i + 1) && "bg-accent-soft/70")}
            >
              {lineNumbers && (
                <span aria-hidden className="mr-4 inline-block w-6 shrink-0 text-right text-fg-faint select-none">
                  {i + 1}
                </span>
              )}
              <span className="min-w-0">
                {tokens?.[i]?.length
                  ? tokens[i]!.map((t, j) =>
                      t.cls ? (
                        <span key={j} className={t.cls}>
                          {t.text}
                        </span>
                      ) : (
                        t.text
                      ),
                    )
                  : line || "​"}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
