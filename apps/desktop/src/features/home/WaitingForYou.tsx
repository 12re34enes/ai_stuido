/** "Seni bekleyenler": the workspace's pending approvals, decidable in place (compact cards). */
import { ArrowRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router";

import type { Approval } from "@/lib/types";
import { spring, variants } from "@/motion/tokens";

import { ApprovalCard } from "../approvals/ApprovalCard";
import { Section } from "./Section";
import { homeStrings as s } from "./strings";

const MAX = 3;

export function WaitingForYou({ approvals }: { approvals: Approval[] }) {
  return (
    <Section
      id="waiting"
      title={s.waiting.title}
      count={approvals.length}
      action={
        approvals.length > MAX ? (
          <Link
            to="/approvals"
            className="inline-flex items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted outline-none transition-colors duration-150 hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
          >
            {s.waiting.viewAll(approvals.length)}
            <ArrowRight className="size-3" />
          </Link>
        ) : undefined
      }
    >
      <ul className="flex flex-col gap-2">
        <AnimatePresence initial={false} mode="popLayout">
          {approvals.slice(0, MAX).map((a) => (
            <motion.li key={a.id} layout="position" variants={variants.dismissRight} initial="initial" animate="animate" exit="exit" transition={spring.layout}>
              <ApprovalCard approval={a} variant="compact" />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </Section>
  );
}
