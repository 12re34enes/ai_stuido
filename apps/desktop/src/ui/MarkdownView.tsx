import { Check } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { CodeBlock } from "./CodeBlock";
import { cn } from "./cn";
import { parseMarkdown, type Block, type Inline } from "./markdown/parse";

export interface MarkdownViewProps {
  source: string;
  /** `compact` tightens spacing for cards and drawers. */
  density?: "comfortable" | "compact";
  className?: string;
}

function renderInline(nodes: Inline[], keyPrefix = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    switch (n.type) {
      case "text":
        return n.text;
      case "strong":
        return (
          <strong key={key} className="font-semibold text-fg">
            {renderInline(n.children, `${key}.`)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderInline(n.children, `${key}.`)}</em>;
      case "del":
        return (
          <del key={key} className="text-fg-muted">
            {renderInline(n.children, `${key}.`)}
          </del>
        );
      case "code":
        return (
          <code key={key} className="rounded-[4px] bg-surface-sunken px-[0.35em] py-[0.1em] font-mono text-[0.9em] text-fg">
            {n.text}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            href={n.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent underline decoration-accent/35 underline-offset-2 transition-colors hover:decoration-accent"
          >
            {renderInline(n.children, `${key}.`)}
          </a>
        );
      case "br":
        return <br key={key} />;
    }
  });
}

const headingClass: Record<number, string> = {
  1: "font-serif text-xl text-fg",
  2: "font-serif text-lg text-fg",
  3: "font-serif text-md text-fg",
  4: "text-base font-semibold text-fg",
  5: "text-sm font-semibold text-fg",
  6: "text-xs font-semibold tracking-wide text-fg-muted uppercase",
};

function renderBlocks(blocks: Block[], compact: boolean, keyPrefix = ""): ReactNode[] {
  return blocks.map((b, i) => {
    const key = `${keyPrefix}${i}`;
    switch (b.type) {
      case "heading": {
        const Tag = `h${b.level}` as const;
        return (
          <Tag key={key} className={cn(headingClass[b.level], "mt-[1.2em] first:mt-0")}>
            {renderInline(b.children)}
          </Tag>
        );
      }
      case "paragraph":
        return <p key={key}>{renderInline(b.children)}</p>;
      case "code":
        return <CodeBlock key={key} code={b.text} language={b.lang || undefined} />;
      case "hr":
        return <hr key={key} className="my-2 h-px border-0 bg-line" />;
      case "blockquote":
        return (
          <blockquote key={key} className="flex flex-col gap-2 border-l-2 border-line-strong pl-3 text-fg-muted">
            {renderBlocks(b.children, compact, `${key}.`)}
          </blockquote>
        );
      case "list": {
        const ListTag = b.ordered ? "ol" : "ul";
        const task = b.items.some((it) => it.checked !== null);
        return (
          <ListTag
            key={key}
            start={b.ordered && b.start !== 1 ? b.start : undefined}
            className={cn(
              "flex flex-col gap-1",
              task ? "list-none pl-0.5" : b.ordered ? "list-decimal pl-5 marker:text-fg-muted" : "list-disc pl-5 marker:text-fg-faint",
            )}
          >
            {b.items.map((it, j) => (
              <li key={j} className={cn(task && "flex items-start gap-2", "pl-0.5")}>
                {it.checked !== null && (
                  <span
                    aria-label={it.checked ? "Tamamlandı" : "Yapılacak"}
                    className={cn(
                      "mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-[4px] border",
                      it.checked ? "border-success bg-success text-fg-on-accent" : "border-line-strong",
                    )}
                  >
                    {it.checked && <Check className="size-2.5" strokeWidth={3} />}
                  </span>
                )}
                <div className={cn("flex min-w-0 flex-col gap-1", it.checked && "text-fg-muted line-through decoration-fg-faint")}>
                  {renderBlocks(it.children, compact, `${key}.${j}.`)}
                </div>
              </li>
            ))}
          </ListTag>
        );
      }
      case "table":
        return (
          <div key={key} className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="bg-surface-sunken text-fg-muted">
                <tr>
                  {b.header.map((cell, c) => (
                    <th key={c} className="px-3 py-1.5 font-medium" style={{ textAlign: b.align[c] ?? undefined }}>
                      {renderInline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r} className="border-t border-line-subtle">
                    {row.map((cell, c) => (
                      <td key={c} className="px-3 py-1.5 text-fg" style={{ textAlign: b.align[c] ?? undefined }}>
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** Safe Markdown rendering (no HTML injection): React elements only, links limited to http(s)/mailto. */
export function MarkdownView({ source, density = "comfortable", className }: MarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const compact = density === "compact";
  return (
    <div
      data-selectable
      className={cn(
        "flex min-w-0 flex-col text-fg [overflow-wrap:anywhere]",
        compact ? "gap-2 text-xs leading-[1.6]" : "gap-3 text-sm leading-[1.65]",
        className,
      )}
    >
      {renderBlocks(blocks, compact)}
    </div>
  );
}
