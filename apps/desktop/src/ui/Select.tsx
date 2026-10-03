import { ChevronsUpDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "./cn";
import { fieldChrome, fieldState } from "./field";
import { Menu, MenuRadioGroup, MenuRadioItem } from "./Menu";
import { uiStrings } from "./strings";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  size?: "sm" | "md";
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  /** Accessible name when there is no visible label. */
  "aria-label"?: string;
  id?: string;
}

/** Field-styled select backed by a radio menu (keyboard: arrows, type-ahead, Enter, Esc). */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder = uiStrings.selectPlaceholder,
  size = "md",
  invalid,
  disabled,
  className,
  id,
  ...aria
}: SelectProps<V>) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      matchTriggerWidth
      trigger={
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-label={aria["aria-label"]}
          aria-invalid={invalid || undefined}
          className={cn(
            fieldChrome,
            fieldState(invalid, disabled),
            "inline-flex items-center gap-2 text-left outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]",
            open && "border-accent shadow-[var(--focus-ring)]",
            size === "sm" ? "h-7 px-2 text-xs [&_svg]:size-3.5" : "h-8 px-2.5 text-sm [&_svg]:size-4",
            className,
          )}
        >
          {selected?.icon && <span className="flex text-fg-muted">{selected.icon}</span>}
          <span className={cn("min-w-0 flex-1 truncate", !selected && "text-fg-faint")}>{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="shrink-0 text-fg-faint" />
        </button>
      }
    >
      <MenuRadioGroup value={value ?? ""} onValueChange={(v) => onValueChange(v as V)}>
        {options.map((o) => (
          <MenuRadioItem key={o.value} value={o.value} icon={o.icon} description={o.description} disabled={o.disabled}>
            {o.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
}
