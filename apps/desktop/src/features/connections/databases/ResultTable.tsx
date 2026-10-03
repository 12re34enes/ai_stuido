import { Clock, Rows3, UserCheck } from "lucide-react";
import { motion } from "motion/react";

import { formatNumber } from "@/i18n/format";
import { variants } from "@/motion/tokens";
import { cn, CopyButton } from "@/ui";

import { approverLabel, cellText, toTsv } from "../format";
import { connStrings as s } from "../strings";
import type { DbQueryResult } from "../types";

const c = s.databases.consoleUi;

/** Query result grid: sticky header, row numbers, monospace cells, both-axis scrolling. */
export function ResultTable({ result }: { result: DbQueryResult }) {
  const count = result.row_count ?? result.rows.length;
  // Numeric columns (every non-null value is a number) are right-aligned, header included.
  const numeric = result.columns.map((_, i) => {
    const values = result.rows.map((r) => r[i]).filter((v) => v !== null && v !== undefined);
    return values.length > 0 && values.every((v) => typeof v === "number");
  });
  return (
    <motion.div variants={variants.fadeUp} initial="initial" animate="animate" className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-1">
      <div className="flex h-10 items-center gap-4 border-b border-line-subtle px-3.5 text-xs text-fg-muted">
        <span className="flex items-center gap-1.5 font-medium text-fg">
          <Rows3 className="size-3.5 text-fg-faint" aria-hidden />
          {c.rows(count)}
        </span>
        {result.truncated && <span className="text-warning">{c.truncated(result.rows.length)}</span>}
        {result.duration_ms !== null && (
          <span className="flex items-center gap-1 tabular">
            <Clock className="size-3.5 text-fg-faint" aria-hidden />
            {formatNumber(result.duration_ms)} ms
          </span>
        )}
        {result.approved_by && (
          <span className="flex items-center gap-1">
            <UserCheck className="size-3.5 text-fg-faint" aria-hidden />
            {c.approvedBy(approverLabel(result.approved_by))}
          </span>
        )}
        <span className="flex-1" />
        {result.columns.length > 0 && <CopyButton size="xs" value={() => toTsv(result.columns, result.rows)} label={c.copyTsv} />}
      </div>
      {result.columns.length === 0 || result.rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-fg-muted">{c.noRows}</p>
      ) : (
        <div className="max-h-[420px] overflow-auto" data-selectable>
          <table className="w-max min-w-full border-separate border-spacing-0 font-mono text-xs" aria-label={c.results}>
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-20 w-10 border-r border-b border-line-subtle bg-canvas-subtle px-2 py-1.5 text-right font-normal text-fg-faint">#</th>
                {result.columns.map((col, i) => (
                  <th
                    key={`${col}-${i}`}
                    scope="col"
                    className={cn(
                      "sticky top-0 z-10 border-b border-line-subtle bg-canvas-subtle px-3 py-1.5 font-sans text-2xs font-medium tracking-wide whitespace-nowrap text-fg-muted",
                      numeric[i] ? "text-right" : "text-left",
                    )}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r} className="group">
                  <td className="sticky left-0 z-10 border-r border-b border-line-subtle bg-surface px-2 py-1 text-right text-fg-faint tabular group-hover:bg-surface-hover">
                    {r + 1}
                  </td>
                  {row.map((v, i) => (
                    <td
                      key={i}
                      title={cellText(v)}
                      className={cn(
                        "max-w-[360px] truncate border-b border-line-subtle px-3 py-1 group-hover:bg-surface-hover",
                        v === null || v === undefined ? "text-fg-faint italic" : "text-fg",
                        numeric[i] && "text-right tabular",
                      )}
                    >
                      {cellText(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}
