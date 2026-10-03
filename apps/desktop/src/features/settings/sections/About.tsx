import { useQuery } from "@tanstack/react-query";
import { BellRing, FolderOpen } from "lucide-react";
import { motion } from "motion/react";

import { stagger, variants } from "@/motion/tokens";
import { backendStatus, getShellStatus, isTauri, openNotificationSettings, revealInFinder } from "@/native";
import { Badge, Button, ErrorState, IconButton, KeyValueList, Section, Skeleton } from "@/ui";


import { useSystem } from "../api";
import { SectionPage } from "../kit";
import { setStrings as s } from "../strings";

const t = s.about;

function AppMark() {
  return (
    <span className="grid size-14 shrink-0 place-items-center rounded-[16px] bg-accent text-2xl text-fg-on-accent shadow-2" aria-hidden>
      ✦
    </span>
  );
}

export function AboutSection() {
  const system = useSystem();
  const shell = useQuery({ queryKey: ["settings", "shell-status"], queryFn: getShellStatus, retry: false, staleTime: 10_000 });
  const backend = useQuery({ queryKey: ["settings", "backend-status"], queryFn: backendStatus, retry: false, staleTime: 10_000 });
  const native = isTauri();

  return (
    <SectionPage title={s.sections.about.title} description={s.sections.about.description}>
      <motion.div variants={variants.fadeUp} initial="initial" animate="animate" className="flex items-center gap-4 rounded-xl border border-line bg-surface p-5 shadow-1">
        <AppMark />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-serif text-lg text-fg">{t.app}</span>
          <span className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {t.version} {shell.data?.version ?? system.data?.version ?? "—"}
            {(shell.data?.dev ?? system.data?.dev) && (
              <Badge tone="warning" size="sm">
                {t.dev}
              </Badge>
            )}
          </span>
        </div>
      </motion.div>

      <Section title={t.engine}>
        {system.isPending ? (
          <div className="p-4">
            <Skeleton height={80} />
          </div>
        ) : system.isError ? (
          <ErrorState size="sm" error={system.error} onRetry={() => void system.refetch()} />
        ) : (
          <>
            <KeyValueList
              items={[
                { label: t.version, value: system.data.version, mono: true },
                { label: t.mode, value: system.data.dev ? t.dev : t.prod },
                { label: t.lastEvent, value: `#${system.data.last_event_id}`, mono: true },
              ]}
            />
            <div className="flex flex-col gap-2 px-4 py-3.5">
              <span className="text-xs text-fg-muted">{t.modules}</span>
              <motion.div initial="initial" animate="animate" variants={stagger(0.015)} className="flex flex-wrap gap-1.5">
                {system.data.modules.map((m) => (
                  <motion.span key={m} variants={variants.pop}>
                    <Badge tone="neutral" variant="outline" size="sm" className="font-mono">
                      {m}
                    </Badge>
                  </motion.span>
                ))}
              </motion.div>
            </div>
          </>
        )}
      </Section>

      <Section title={t.shell}>
        {!native ? (
          <p className="px-4 py-3.5 text-sm text-fg-muted">{t.shellNone}</p>
        ) : shell.isPending ? (
          <div className="p-4">
            <Skeleton height={80} />
          </div>
        ) : shell.data ? (
          <>
            <KeyValueList
              items={[
                { label: t.version, value: shell.data.version, mono: true },
                { label: t.platform, value: shell.data.platform, mono: true },
                {
                  label: t.notifications,
                  value: (
                    <span className="flex items-center gap-2">
                      {t.permission[shell.data.notificationPermission] ?? shell.data.notificationPermission}
                      {shell.data.notificationsPaused && (
                        <Badge tone="warning" size="sm">
                          {t.paused}
                        </Badge>
                      )}
                    </span>
                  ),
                },
              ]}
            />
            <div className="px-4 py-3">
              <Button size="sm" icon={<BellRing />} onClick={() => void openNotificationSettings()}>
                {t.openNotificationSettings}
              </Button>
            </div>
          </>
        ) : null}
      </Section>

      {native && backend.data && (
        <Section title={t.backend}>
          <KeyValueList
            items={[
              {
                label: t.backend,
                value: (
                  <Badge tone={backend.data.running ? "success" : "danger"} size="sm" dot>
                    {backend.data.running ? t.running : t.stopped}
                    {backend.data.pid ? ` · pid ${backend.data.pid}` : ""}
                  </Badge>
                ),
              },
              ...(backend.data.url ? [{ label: "URL", value: backend.data.url, mono: true }] : []),
              ...(backend.data.dataDir
                ? [
                    {
                      label: t.dataDir,
                      value: (
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-xs">{backend.data.dataDir}</span>
                          <IconButton size="xs" label={t.reveal} icon={<FolderOpen />} onClick={() => void revealInFinder(backend.data?.dataDir ?? "")} />
                        </span>
                      ),
                    },
                  ]
                : []),
              ...(backend.data.logFile ? [{ label: t.logFile, value: backend.data.logFile, mono: true }] : []),
            ]}
          />
        </Section>
      )}
    </SectionPage>
  );
}
