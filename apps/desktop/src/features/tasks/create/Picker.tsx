/**
 * Composer pickers: a compact chip trigger and a searchable popover list (single or multiple
 * choice). Keyboard: type to filter (Turkish-aware), ↑/↓ to move, ↵ to choose, Esc to close.
 */
import { Check, ChevronDown, Search, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";

import { foldTurkish } from "@/lib/fuzzy";
import { spring, transition, variants } from "@/motion/tokens";
import { cn, Popover, Spinner, Tooltip } from "@/ui";

// ----------------------------------------------------------------------------- chip

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  /** Has a non-default value: stronger look. */
  active?: boolean;
  /** Shows a small accent dot (e.g. advanced options changed). */
  dot?: boolean;
  caret?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Chip({ icon, active, dot, caret = true, className, children, ref, type = "button", ...rest }: ChipProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "group relative inline-flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium outline-none",
        "transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:shadow-[var(--focus-ring)]",
        "disabled:pointer-events-none disabled:opacity-45 data-[state=open]:border-line-strong data-[state=open]:bg-surface-hover data-[state=open]:text-fg",
        active
          ? "border-line bg-surface-sunken text-fg hover:border-line-strong"
          : "border-transparent text-fg-muted hover:bg-surface-hover hover:text-fg",
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...rest}
    >
      {icon && <span className={cn("flex", active ? "text-fg-muted" : "text-fg-faint group-hover:text-fg-muted")}>{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
      {caret && <ChevronDown className="-mr-0.5 text-fg-faint" />}
      <AnimatePresence>
        {dot && (
          <motion.span
            key="dot"
            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent"
            initial={{ scale: 0 }}
            animate={{ scale: 1, transition: spring.bouncy }}
            exit={{ scale: 0, transition: transition.exit }}
          />
        )}
      </AnimatePresence>
    </button>
  );
}

/** Small round "×" placed after a chip to clear its value. */
export function ClearButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip content={label} side="bottom">
      <motion.button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="-ml-1 grid size-5 shrink-0 place-items-center rounded-md text-fg-faint outline-none transition-colors duration-150 hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.6, transition: transition.exit }}
        transition={spring.snappy}
      >
        <X className="size-3" />
      </motion.button>
    </Tooltip>
  );
}

// ----------------------------------------------------------------------------- list popover

export interface PickerItem {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  /** Section title; consecutive items with the same group share a header. */
  group?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  /** Extra search text. */
  keywords?: string;
}

export interface PickerPopoverProps {
  trigger: ReactElement;
  items: PickerItem[];
  selected: readonly string[];
  onSelect: (value: string) => void;
  multiple?: boolean;
  label: string;
  searchPlaceholder?: string;
  emptyText: string;
  /** Rendered above the list (e.g. "Tüm repolar"). */
  header?: ReactNode;
  footer?: ReactNode;
  loading?: boolean;
  error?: string | null;
  width?: number;
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the search field for short lists. */
  searchable?: boolean;
}

export function PickerPopover({
  trigger,
  items,
  selected,
  onSelect,
  multiple,
  label,
  searchPlaceholder,
  emptyText,
  header,
  footer,
  loading,
  error,
  width = 300,
  align = "start",
  open: openProp,
  onOpenChange,
  searchable = true,
}: PickerPopoverProps) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const setOpen = (o: boolean) => {
    setInner(o);
    onOpenChange?.(o);
    if (!o) setQuery("");
  };
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = foldTurkish(query.trim());
    if (!q) return items;
    return items.filter((i) => foldTurkish(`${i.label} ${i.description ?? ""} ${i.keywords ?? ""}`).includes(q));
  }, [items, query]);

  const choose = (item: PickerItem | undefined) => {
    if (!item || item.disabled) return;
    onSelect(item.value);
    if (!multiple) setOpen(false);
  };

  const move = (delta: number) => {
    if (!filtered.length) return;
    const next = (active + delta + filtered.length) % filtered.length;
    setActive(next);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[active]);
    }
  };

  let lastGroup: string | undefined;
  return (
    <Popover trigger={trigger} open={open} onOpenChange={setOpen} align={align} side="bottom" sideOffset={6} label={label} className="overflow-hidden p-0">
      <div style={{ width }} onKeyDown={onKeyDown} className="flex flex-col">
        {searchable && (
          <div className="flex h-9 items-center gap-2 border-b border-line-subtle px-3">
            <Search className="size-3.5 shrink-0 text-fg-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder ?? label}
              aria-controls={listId}
              aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint focus-visible:shadow-none"
            />
          </div>
        )}
        {header && <div className="border-b border-line-subtle p-1">{header}</div>}
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          aria-multiselectable={multiple || undefined}
          tabIndex={searchable ? -1 : 0}
          className="max-h-[288px] overflow-y-auto overscroll-contain p-1 outline-none"
        >
          {loading ? (
            <div className="flex h-16 items-center justify-center">
              <Spinner size={16} className="text-fg-faint" />
            </div>
          ) : error ? (
            <p className="px-2.5 py-4 text-center text-xs text-danger">{error}</p>
          ) : filtered.length === 0 ? (
            <motion.p {...variants.fade} className="px-2.5 py-4 text-center text-xs text-fg-muted">
              {emptyText}
            </motion.p>
          ) : (
            filtered.map((item, i) => {
              const isSel = selected.includes(item.value);
              const showGroup = item.group && item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.value}>
                  {showGroup && (
                    <div className="px-2 pt-2 pb-1 text-2xs font-medium tracking-wide text-fg-faint uppercase first:pt-1">{item.group}</div>
                  )}
                  <div
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSel}
                    aria-disabled={item.disabled || undefined}
                    onPointerMove={() => setActive(i)}
                    onClick={() => choose(item)}
                    className={cn(
                      "relative flex min-h-8 cursor-default items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-sm transition-colors duration-100",
                      i === active && "bg-surface-hover",
                      item.disabled && "opacity-45",
                    )}
                  >
                    {multiple ? (
                      <span
                        aria-hidden
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors duration-150",
                          isSel ? "border-accent bg-accent text-fg-on-accent" : "border-line-strong bg-surface",
                        )}
                      >
                        <AnimatePresence initial={false}>
                          {isSel && (
                            <motion.span key="c" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={spring.snappy}>
                              <Check className="size-3" strokeWidth={3} />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </span>
                    ) : (
                      item.icon && <span className="flex shrink-0 text-fg-muted [&_svg]:size-4">{item.icon}</span>
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-fg">{item.label}</span>
                      {item.description && <span className="line-clamp-2 text-xs text-fg-muted">{item.description}</span>}
                    </span>
                    {item.trailing && <span className="shrink-0 text-xs text-fg-faint">{item.trailing}</span>}
                    {!multiple && isSel && (
                      <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.snappy} className="flex shrink-0 text-accent">
                        <Check className="size-4" strokeWidth={2.25} />
                      </motion.span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        {footer && <div className="border-t border-line-subtle px-3 py-2 text-xs text-fg-muted">{footer}</div>}
      </div>
    </Popover>
  );
}
