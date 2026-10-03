/** Small, consistent markers: permission level, command class, target tile, deploy run status. */
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  Eye,
  FlaskConical,
  Laptop,
  ShieldAlert,
  Hourglass,
  Loader2,
  PencilLine,
  ShieldCheck,
  Unlock,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import type { Environment } from "@/lib/types";
import { spring } from "@/motion/tokens";
import { Badge, cn, Tooltip } from "@/ui";

import { classTone } from "../logic";
import { connStrings as s } from "../strings";
import type { CommandClass, DeployRunStatus, PermissionLevel } from "../types";

const permIcon: Record<PermissionLevel, LucideIcon> = { read: Eye, limited: PencilLine, full: Unlock };

export function PermissionBadge({ level, environment, size = "sm" }: { level: PermissionLevel; environment?: Environment; size?: "sm" | "md" }) {
  const Icon = permIcon[level];
  // A write-capable level on production is called out in red (writes still need approval there).
  const tone = level === "read" ? "neutral" : environment === "production" ? "danger" : level === "full" ? "accent" : "warning";
  return (
    <Tooltip content={s.permission.hint[level]} side="top">
      <span className="inline-flex">
        <Badge tone={tone} variant="outline" size={size} icon={<Icon strokeWidth={2.25} aria-hidden />}>
          {s.permission[level]}
        </Badge>
      </span>
    </Tooltip>
  );
}

const classIcon: Record<CommandClass, LucideIcon> = { read: ShieldCheck, write: PencilLine, unknown: CircleDashed };

export function ClassBadge({ klass, size = "sm" }: { klass: CommandClass | string | null; size?: "sm" | "md" }) {
  if (!klass) return null;
  const k = (["read", "write", "unknown"].includes(klass) ? klass : "unknown") as CommandClass;
  const Icon = classIcon[k];
  return (
    <motion.span key={k} initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.bouncy} className="inline-flex">
      <Badge tone={classTone(k)} size={size} icon={<Icon strokeWidth={2.25} aria-hidden />}>
        {s.classification[k]}
      </Badge>
    </motion.span>
  );
}

/** Rounded icon tile tinted by environment; production is solid red so it never blends in. */
export function TargetIcon({ environment, icon, size = 32, className }: { environment: Environment; icon: ReactNode; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center rounded-[9px] [&_svg]:size-4",
        environment === "production" && "bg-env-production text-fg-on-accent shadow-[0_0_0_3px_var(--env-production-soft)]",
        environment === "test" && "bg-env-test-soft text-env-test",
        environment === "local" && "bg-surface-sunken text-fg-muted",
        className,
      )}
    >
      {icon}
    </span>
  );
}

const envIconComp = { local: Laptop, test: FlaskConical, production: ShieldAlert };
const envIconClass = { local: "text-env-local", test: "text-env-test", production: "text-env-production" };

/** Small environment glyph for menus and selects (production stays recognisable everywhere). */
export function EnvIcon({ environment }: { environment: Environment }) {
  const Icon = envIconComp[environment];
  return <Icon className={envIconClass[environment]} strokeWidth={2.25} aria-label={s.environment.group[environment]} />;
}

const runTone: Record<DeployRunStatus, "warning" | "info" | "success" | "danger" | "neutral"> = {
  pending_approval: "warning",
  running: "info",
  succeeded: "success",
  failed: "danger",
  rejected: "danger",
  cancelled: "neutral",
};

const runIcon: Record<DeployRunStatus, LucideIcon> = {
  pending_approval: Hourglass,
  running: Loader2,
  succeeded: CheckCircle2,
  failed: XCircle,
  rejected: Ban,
  cancelled: Ban,
};

export function RunStatusBadge({ status, size = "sm" }: { status: DeployRunStatus; size?: "sm" | "md" }) {
  const Icon = runIcon[status];
  return (
    <motion.span key={status} initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.bouncy} className="inline-flex">
      <Badge
        tone={runTone[status]}
        variant={status === "rejected" ? "outline" : "soft"}
        size={size}
        icon={<Icon strokeWidth={2.25} aria-hidden className={cn(status === "running" && "animate-[studio-spin_1s_linear_infinite]")} />}
      >
        {s.deploy.status[status]}
      </Badge>
    </motion.span>
  );
}
