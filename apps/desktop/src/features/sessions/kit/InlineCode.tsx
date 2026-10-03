/**
 * Renders `backtick` spans of short agent/system texts ("`npm test` komutunu çalıştırmak
 * istiyor") as code chips; everything else stays plain text.
 */
import { Fragment } from "react";

import { cn, CopyButton } from "@/ui";

function splitInlineCode(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[1] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

export function InlineCode({ text, className, codeClassName }: { text: string; className?: string; codeClassName?: string }) {
  return (
    <span className={className}>
      {splitInlineCode(text).map((part, i) =>
        part.code ? (
          <code key={i} className={cn("rounded-[4px] bg-surface-sunken px-1 py-px font-mono text-[0.92em] text-fg", codeClassName)}>
            {part.text}
          </code>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </span>
  );
}

/** A single shell command, monospace, with a "$" prompt and copy on hover. */
export function CommandLine({ command, className }: { command: string; className?: string }) {
  return (
    <div className={cn("group/cmd relative flex items-start gap-2 rounded-md border border-line bg-code px-3 py-2 font-mono text-xs leading-5", className)}>
      <span aria-hidden className="text-fg-faint select-none">
        $
      </span>
      <span data-selectable className="min-w-0 flex-1 break-all whitespace-pre-wrap text-fg">
        {command}
      </span>
      <CopyButton value={command} size="xs" className="-my-0.5 -mr-1.5 opacity-0 transition-opacity group-hover/cmd:opacity-100 focus-visible:opacity-100" />
    </div>
  );
}
