/**
 * Ayarlar (spec §15, §17, §18, §20, §23): appearance, agent profiles, CLI health, limits and
 * budgets, alerts, safety, shortcuts, backup and about. `/settings/:section`.
 */
import { Bell, Bot, DatabaseBackup, Gauge, Info, Keyboard, Palette, ShieldAlert, TerminalSquare, type LucideIcon } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useMemo, type ComponentType } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";

import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { spring, variants } from "@/motion/tokens";
import { cn } from "@/ui";

import { useSettingsLive } from "./api";
import { AlertsSection } from "./alerts/AlertsSection";
import { AboutSection } from "./sections/About";
import { AppearanceSection } from "./sections/Appearance";
import { BackupSection } from "./sections/Backup";
import { CliHealthSection } from "./sections/CliHealth";
import { LimitsSection } from "./sections/Limits";
import { ProfilesSection } from "./sections/Profiles";
import { SafetySection } from "./sections/Safety";
import { ShortcutsSection } from "./sections/Shortcuts";
import { setStrings as s } from "./strings";

type SectionId = keyof typeof s.sections;

const SECTIONS: { id: SectionId; icon: LucideIcon; Component: ComponentType; keywords: string[] }[] = [
  { id: "appearance", icon: Palette, Component: AppearanceSection, keywords: ["tema", "theme", "koyu", "açık", "hareket"] },
  { id: "profiles", icon: Bot, Component: ProfilesSection, keywords: ["ajan", "profil", "model", "sınır"] },
  { id: "clis", icon: TerminalSquare, Component: CliHealthSection, keywords: ["cli", "claude code", "codex", "kurulum"] },
  { id: "limits", icon: Gauge, Component: LimitsSection, keywords: ["limit", "bütçe", "kota"] },
  { id: "alerts", icon: Bell, Component: AlertsSection, keywords: ["uyarı", "bildirim", "telegram", "slack", "sessiz saatler"] },
  { id: "safety", icon: ShieldAlert, Component: SafetySection, keywords: ["güvenlik", "production", "onay"] },
  { id: "shortcuts", icon: Keyboard, Component: ShortcutsSection, keywords: ["kısayol", "shortcut", "klavye"] },
  { id: "backup", icon: DatabaseBackup, Component: BackupSection, keywords: ["yedek", "backup", "geri yükle"] },
  { id: "about", icon: Info, Component: AboutSection, keywords: ["hakkında", "sürüm", "version"] },
];

function useSettingsCommands() {
  const navigate = useNavigate();
  const commands = useMemo<StudioCommand[]>(
    () =>
      SECTIONS.map((sec, i) => ({
        id: `settings.${sec.id}`,
        title: `${s.title}: ${s.sections[sec.id].title}`,
        group: commandGroups.navigation,
        icon: sec.icon,
        keywords: ["ayarlar", "settings", ...sec.keywords],
        order: 60 + i,
        run: () => void navigate(`/settings/${sec.id}`),
      })),
    [navigate],
  );
  useRegisterCommands(commands);
}

export default function SettingsPage() {
  useSettingsLive();
  useSettingsCommands();
  const { "*": rest = "" } = useParams();
  const sectionId = rest.split("/")[0] || "appearance";
  const current = SECTIONS.find((x) => x.id === sectionId);
  if (!current) return <Navigate to="/settings/appearance" replace />;
  const { Component } = current;

  return (
    <div className="mx-auto flex w-full max-w-[1120px] gap-10 px-8 pt-8 pb-16" data-feature="settings">
      <nav aria-label={s.title} className="sticky top-8 flex h-fit w-52 shrink-0 flex-col gap-4">
        <h1 className="px-2.5 text-xl text-fg">{s.title}</h1>
        <LayoutGroup id="settings-nav">
          <ul className="flex flex-col gap-0.5">
            {SECTIONS.map((sec) => {
              const active = sec.id === current.id;
              const Icon = sec.icon;
              return (
                <li key={sec.id}>
                  <Link
                    to={`/settings/${sec.id}`}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
                      active ? "text-fg" : "text-fg-muted hover:text-fg",
                    )}
                  >
                    {active && <motion.span layoutId="settings-nav-active" className="absolute inset-0 rounded-md bg-surface shadow-1" transition={spring.layout} />}
                    <Icon className={cn("relative size-4 shrink-0", active ? "text-accent" : "text-fg-faint")} strokeWidth={1.75} aria-hidden />
                    <span className="relative truncate">{s.sections[sec.id].title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </LayoutGroup>
      </nav>
      <div className="relative min-w-0 max-w-[760px] flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={current.id} variants={variants.fadeUp} initial="initial" animate="animate" exit="exit">
            <Component />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
