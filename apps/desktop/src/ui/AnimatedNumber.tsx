import { motion } from "motion/react";
import { useMemo } from "react";

import { spring } from "@/motion/tokens";

import { cn } from "./cn";
import { numberColumns } from "./numbers";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export interface AnimatedNumberProps {
  value: number;
  /** Custom formatter (Turkish by default: 12.345 / 12,5). */
  format?: (n: number) => string;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}

function DigitColumn({ digit }: { digit: number }) {
  return (
    <span className="relative inline-block h-[1lh] overflow-hidden" aria-hidden>
      <span className="invisible">0</span>
      <motion.span
        className="absolute inset-x-0 top-0 flex flex-col items-center"
        initial={false}
        animate={{ y: `${-digit * 10}%` }}
        transition={spring.digit}
      >
        {DIGITS.map((d) => (
          <span key={d} className="h-[1lh]">
            {d}
          </span>
        ))}
      </motion.span>
    </span>
  );
}

/** Rolling digits (spec §20 "Sayılar kayarak değişir"). Uses tabular numerals so width stays put. */
export function AnimatedNumber({ value, format, decimals = 0, prefix = "", suffix = "", className }: AnimatedNumberProps) {
  const text = useMemo(() => {
    const body = format
      ? format(value)
      : new Intl.NumberFormat("tr-TR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
    return `${prefix}${body}${suffix}`;
  }, [decimals, format, prefix, suffix, value]);
  const cols = numberColumns(text);
  return (
    <span className={cn("relative inline-flex align-top tabular", className)}>
      <span className="sr-only">{text}</span>
      {cols.map((c) =>
        c.digit ? (
          <DigitColumn key={c.key} digit={Number(c.char)} />
        ) : (
          <span key={c.key} aria-hidden className="whitespace-pre">
            {c.char}
          </span>
        ),
      )}
    </span>
  );
}
