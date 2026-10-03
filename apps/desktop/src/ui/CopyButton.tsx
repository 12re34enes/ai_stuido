import { Check, Copy } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { spring, transition } from "@/motion/tokens";

import { IconButton } from "./IconButton";
import { uiStrings } from "./strings";

export interface CopyButtonProps {
  value: string | (() => string);
  size?: "xs" | "sm" | "md";
  className?: string;
  label?: string;
  copiedLabel?: string;
}

/** Copies to the clipboard; the icon morphs into a check for a moment. */
export function CopyButton({ value, size = "sm", className, label = uiStrings.copy, copiedLabel = uiStrings.copied }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <IconButton
      label={copied ? copiedLabel : label}
      size={size}
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(typeof value === "function" ? value() : value);
          setCopied(true);
        } catch {
          // clipboard unavailable (permissions): nothing to do
        }
      }}
      icon={
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={copied ? "done" : "copy"}
            className="flex"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
            exit={{ opacity: 0, scale: 0.5, transition: transition.exit }}
          >
            {copied ? <Check className="text-success" /> : <Copy />}
          </motion.span>
        </AnimatePresence>
      }
    />
  );
}
