import { Check, Monitor, Moon, Sun } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";
import type { ReactNode } from "react";

import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useAppearance } from "@/lib/appearance";
import { useUpdateSetting } from "@/lib/queries";
import type { ReduceMotionPref, ThemePref } from "@/lib/types";
import { spring } from "@/motion/tokens";
import { setNativeTheme } from "@/native";
import { cn, Section, SegmentedControl, SettingRow } from "@/ui";


import { SectionPage } from "../kit";
import { setStrings as s } from "../strings";

const a = s.appearance;

/** A tiny window in a given theme: sidebar, title bar, a card and an accent button. */
function MiniWindow({ theme }: { theme: "light" | "dark" }) {
  return (
    <div data-theme={theme} className="flex size-full overflow-hidden bg-canvas" aria-hidden>
      <div className="flex w-[30%] flex-col gap-1 border-r border-line bg-canvas-subtle p-1.5">
        <span className="mb-1 flex gap-[3px]">
          <span className="size-1.5 rounded-full bg-danger/70" />
          <span className="size-1.5 rounded-full bg-warning/70" />
          <span className="size-1.5 rounded-full bg-success/70" />
        </span>
        <span className="h-1.5 w-[80%] rounded-full bg-accent/80" />
        <span className="h-1.5 w-[65%] rounded-full bg-line-strong" />
        <span className="h-1.5 w-[72%] rounded-full bg-line-strong" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="h-2 w-[55%] rounded-full bg-fg/70" />
        <div className="flex flex-1 flex-col gap-1 rounded-[5px] border border-line bg-surface p-1.5">
          <span className="h-1.5 w-[80%] rounded-full bg-line-strong" />
          <span className="h-1.5 w-[60%] rounded-full bg-line" />
          <span className="mt-auto h-2.5 w-[38%] self-end rounded-[3px] bg-accent" />
        </div>
      </div>
    </div>
  );
}

function ThemeTile({ value, label, icon, active, onSelect }: { value: ThemePref; label: string; icon: ReactNode; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className="group flex flex-col items-center gap-2 rounded-xl p-1.5 outline-none focus-visible:shadow-[var(--focus-ring)]"
    >
      <span className="relative block aspect-[16/10] w-full">
        {active && <motion.span layoutId="theme-ring" className="absolute -inset-[3px] rounded-[11px] border-2 border-accent" transition={spring.layout} />}
        <motion.span
          className="relative block size-full overflow-hidden rounded-lg border border-line shadow-1"
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.98 }}
          transition={spring.snappy}
        >
          {value === "system" ? (
            <span className="relative block size-full">
              <MiniWindow theme="light" />
              <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
                <MiniWindow theme="dark" />
              </span>
            </span>
          ) : (
            <MiniWindow theme={value} />
          )}
        </motion.span>
        {active && (
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={spring.bouncy}
            className="absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full bg-accent text-fg-on-accent shadow-2"
          >
            <Check className="size-3" strokeWidth={3} aria-hidden />
          </motion.span>
        )}
      </span>
      <span className={cn("flex items-center gap-1.5 text-sm transition-colors", active ? "font-medium text-fg" : "text-fg-muted group-hover:text-fg")}>
        <span className="flex [&_svg]:size-3.5">{icon}</span>
        {label}
      </span>
    </button>
  );
}

export function AppearanceSection() {
  const theme = useAppearance((st) => st.theme);
  const reduceMotion = useAppearance((st) => st.reduceMotion);
  const systemReduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const update = useUpdateSetting();

  const setTheme = (pref: ThemePref) => {
    useAppearance.getState().setTheme(pref);
    update.mutate({ key: "appearance.theme", value: pref });
    void setNativeTheme(pref).catch(() => undefined);
  };
  const setMotion = (pref: ReduceMotionPref) => {
    useAppearance.getState().setReduceMotion(pref);
    update.mutate({ key: "appearance.reduce_motion", value: pref });
  };

  return (
    <SectionPage title={s.sections.appearance.title} description={s.sections.appearance.description}>
      <Section title={a.theme} description={a.themeHint} plain>
        <LayoutGroup id="theme-tiles">
          <div role="radiogroup" aria-label={a.theme} className="grid grid-cols-3 gap-4">
            <ThemeTile value="system" label={a.themes.system} icon={<Monitor />} active={theme === "system"} onSelect={() => setTheme("system")} />
            <ThemeTile value="light" label={a.themes.light} icon={<Sun />} active={theme === "light"} onSelect={() => setTheme("light")} />
            <ThemeTile value="dark" label={a.themes.dark} icon={<Moon />} active={theme === "dark"} onSelect={() => setTheme("dark")} />
          </div>
        </LayoutGroup>
      </Section>
      <Section>
        <SettingRow
          label={a.motion}
          description={
            <>
              {a.motionHint}
              {reduceMotion === "system" && <span className="block pt-0.5 text-fg-faint">{a.motionSystemNote(systemReduced)}</span>}
            </>
          }
          control={
            <SegmentedControl<ReduceMotionPref>
              size="sm"
              aria-label={a.motion}
              value={reduceMotion}
              onValueChange={setMotion}
              options={(["system", "on", "off"] as const).map((v) => ({ value: v, label: a.motionOptions[v] }))}
            />
          }
        />
      </Section>
    </SectionPage>
  );
}
