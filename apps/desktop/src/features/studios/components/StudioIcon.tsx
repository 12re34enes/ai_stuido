import { motion } from "motion/react";
import { createElement } from "react";

import { spring } from "@/motion/tokens";
import { cn } from "@/ui";

import { studioIcon } from "../icons";

const sizes = {
  sm: "size-7 rounded-[8px] [&_svg]:size-3.5",
  md: "size-9 rounded-[10px] [&_svg]:size-[18px]",
  lg: "size-14 rounded-[16px] [&_svg]:size-7",
};

/** The studio's icon on a warm tile. `layoutId` lets it fly from the gallery card into the page. */
export function StudioIcon({ name, size = "md", layoutId, className }: { name?: string; size?: keyof typeof sizes; layoutId?: string; className?: string }) {
  return (
    <motion.span
      layoutId={layoutId}
      transition={spring.layout}
      aria-hidden
      className={cn(
        "relative grid shrink-0 place-items-center bg-accent-soft text-accent ring-1 ring-accent/12 ring-inset",
        sizes[size],
        className,
      )}
    >
      {createElement(studioIcon(name), { strokeWidth: 1.75 })}
    </motion.span>
  );
}
