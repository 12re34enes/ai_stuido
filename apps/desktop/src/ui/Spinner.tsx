import { cn } from "./cn";
import { uiStrings } from "./strings";

export interface SpinnerProps {
  size?: number;
  className?: string;
  /** Accessible label; omit when a parent already announces loading. */
  label?: string;
}

/** Arc spinner: a faint track with a rotating arc in the current text color. */
export function Spinner({ size = 16, className, label = uiStrings.loading }: SpinnerProps) {
  const stroke = size <= 14 ? 1.75 : 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role={label ? "status" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0 animate-[studio-spin_0.75s_linear_infinite]", className)}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * 0.28} ${c}`}
      />
    </svg>
  );
}
