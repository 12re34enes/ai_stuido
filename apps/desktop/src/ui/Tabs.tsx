import * as RTabs from "@radix-ui/react-tabs";
import { LayoutGroup, motion } from "motion/react";
import { createContext, useContext, useId, type ReactNode } from "react";

import { useControllable } from "@/hooks/useControllable";
import { spring, variants } from "@/motion/tokens";

import { cn } from "./cn";

const TabsValue = createContext<string | undefined>(undefined);

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: ReactNode;
}

/** Tabs with a sliding underline. Content panels fade in. */
export function Tabs({ value: valueProp, defaultValue = "", onValueChange, className, children }: TabsProps) {
  const [value, setValue] = useControllable(valueProp, defaultValue, onValueChange);
  const id = useId();
  return (
    <TabsValue.Provider value={value}>
      <LayoutGroup id={id}>
        <RTabs.Root value={value} onValueChange={setValue} className={cn("flex flex-col", className)}>
          {children}
        </RTabs.Root>
      </LayoutGroup>
    </TabsValue.Provider>
  );
}

export function TabsList({ className, children, "aria-label": label }: { className?: string; children: ReactNode; "aria-label"?: string }) {
  return (
    <RTabs.List aria-label={label} className={cn("flex items-center gap-5 border-b border-line", className)}>
      {children}
    </RTabs.List>
  );
}

export interface TabsTriggerProps {
  value: string;
  icon?: ReactNode;
  /** Count or badge after the label. */
  trailing?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}

export function TabsTrigger({ value, icon, trailing, disabled, children }: TabsTriggerProps) {
  const active = useContext(TabsValue) === value;
  return (
    <RTabs.Trigger
      value={value}
      disabled={disabled}
      className={cn(
        "relative -mb-px inline-flex h-9 items-center gap-1.5 text-sm font-medium outline-none transition-colors duration-150",
        "focus-visible:shadow-[var(--focus-ring)] disabled:opacity-40 [&_svg]:size-4",
        active ? "text-fg" : "text-fg-muted hover:text-fg",
      )}
    >
      {icon && <span className="flex">{icon}</span>}
      {children}
      {trailing}
      {active && (
        <motion.span
          layoutId="tab-underline"
          className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-fg"
          transition={spring.layout}
        />
      )}
    </RTabs.Trigger>
  );
}

export function TabsContent({ value, className, children }: { value: string; className?: string; children: ReactNode }) {
  return (
    <RTabs.Content value={value} className={cn("outline-none", className)} asChild>
      <motion.div variants={variants.fadeUp} initial="initial" animate="animate">
        {children}
      </motion.div>
    </RTabs.Content>
  );
}
