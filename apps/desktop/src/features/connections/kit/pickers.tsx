import { FlaskConical, Laptop, ShieldAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { Environment } from "@/lib/types";
import { variants } from "@/motion/tokens";
import { Field, SegmentedControl, Textarea } from "@/ui";

import { connStrings as s } from "../strings";
import type { PermissionLevel } from "../types";
import { Callout } from "./layout";

const envIcons = { local: <Laptop />, test: <FlaskConical />, production: <ShieldAlert /> };

/** Environment picker with an explanation of what the choice means. Production gets a callout. */
export function EnvironmentPicker({ value, onChange, id }: { value: Environment; onChange: (v: Environment) => void; id?: string }) {
  return (
    <Field label={s.common.environment} hint={value === "production" ? undefined : s.environment.hint[value]}>
      <SegmentedControl<Environment>
        aria-label={s.common.environment}
        fullWidth
        value={value}
        onValueChange={onChange}
        options={(["local", "test", "production"] as const).map((e) => ({ value: e, label: s.environment.group[e], icon: envIcons[e] }))}
      />
      <AnimatePresence initial={false}>
        {value === "production" && (
          <motion.div key="prod" {...variants.fadeUp} id={id}>
            <Callout tone="production" className="mt-1" animate={false}>
              {s.environment.productionNote}
            </Callout>
          </motion.div>
        )}
      </AnimatePresence>
    </Field>
  );
}

/** Permission level picker; shows the limited-write patterns editor when "limited" is chosen. */
export function PermissionPicker({
  value,
  onChange,
  environment,
  patterns,
  onPatternsChange,
}: {
  value: PermissionLevel;
  onChange: (v: PermissionLevel) => void;
  environment: Environment;
  patterns?: string;
  onPatternsChange?: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field
        label={s.common.permission}
        hint={environment === "production" && value !== "read" ? undefined : s.permission.hint[value]}
        error={environment === "production" && value !== "read" ? s.permission.productionWide : undefined}
      >
        <SegmentedControl<PermissionLevel>
          aria-label={s.common.permission}
          fullWidth
          value={value}
          onValueChange={onChange}
          options={(["read", "limited", "full"] as const).map((p) => ({ value: p, label: s.permission[p] }))}
        />
      </Field>
      <AnimatePresence initial={false}>
        {value === "limited" && onPatternsChange && (
          <motion.div key="patterns" {...variants.fadeUp}>
            <Field label={s.permission.patterns} hint={s.permission.patternsHint} htmlFor="limited-patterns">
              <Textarea
                id="limited-patterns"
                value={patterns ?? ""}
                onChange={(e) => onPatternsChange(e.target.value)}
                minRows={3}
                maxRows={8}
                spellCheck={false}
                className="font-mono"
                placeholder="systemctl restart web"
              />
            </Field>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Small uppercase group label inside forms. */
export function FormGroupLabel({ children }: { children: string }) {
  return <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{children}</span>;
}
