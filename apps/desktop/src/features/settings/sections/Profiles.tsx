import { Lock, MoreHorizontal, Pencil, Plus, Trash2, Wifi, WifiOff } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { useSettings, useUpdateSetting } from "@/lib/queries";
import type { Provider } from "@/lib/types";
import { stagger, variants } from "@/motion/tokens";
import { Badge, Button, cn, ConfirmDialog, errorMessage, ErrorState, IconButton, ListSkeleton, Menu, MenuItem, MenuSeparator, ProviderMark, Section, SettingRow, toast, Tooltip, uiStrings } from "@/ui";


import { useDeleteProfile, useProfiles } from "../api";
import { CommitNumber, SectionPage } from "../kit";
import { setStrings as s } from "../strings";
import type { AgentProfile } from "../types";
import { ProfileSheet } from "./ProfileForm";

const p = s.profiles;

function ProfileRow({ profile, onEdit, onDelete }: { profile: AgentProfile; onEdit: () => void; onDelete: () => void }) {
  const claude = profile.provider === "claude";
  return (
    <motion.li layout="position" variants={variants.listItem} className="group flex items-center gap-3.5 px-4 py-3">
      <ProviderMark provider={profile.provider} variant="tile" size={28} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate text-fg", claude ? "font-serif text-[15px]" : "font-mono text-[13px] font-medium tracking-tight")}>{profile.name}</span>
          {profile.builtin && (
            <Badge tone={claude ? "claude" : "codex"} size="sm">
              {p.builtin}
            </Badge>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          <span>{uiStrings.agentRole[profile.role]}</span>
          <span aria-hidden className="text-fg-faint">
            ·
          </span>
          <span className="truncate font-mono text-2xs">{profile.model ?? p.modelDefault}</span>
          {profile.effort && (
            <>
              <span aria-hidden className="text-fg-faint">
                ·
              </span>
              <span className="font-mono text-2xs">{profile.effort}</span>
            </>
          )}
        </span>
      </div>
      <div className="hidden items-center gap-1.5 md:flex">
        <Badge tone={profile.boundaries.sandbox === "full" ? "warning" : "neutral"} variant="outline" size="sm">
          {p.sandbox[profile.boundaries.sandbox]}
        </Badge>
        <Tooltip content={`${p.network}: ${profile.boundaries.network ? s.common.enabled : s.common.disabled}`} side="top">
          <span className="flex text-fg-faint [&_svg]:size-3.5" aria-label={p.network}>
            {profile.boundaries.network ? <Wifi /> : <WifiOff />}
          </span>
        </Tooltip>
      </div>
      <IconButton label={s.common.edit} icon={<Pencil />} onClick={onEdit} />
      <Menu align="end" trigger={<IconButton label={s.common.more} icon={<MoreHorizontal />} tooltip={false} />}>
        <MenuItem icon={<Pencil />} onSelect={onEdit}>
          {s.common.edit}
        </MenuItem>
        <MenuSeparator />
        {profile.builtin ? (
          <MenuItem icon={<Lock />} disabled>
            {p.builtinLocked}
          </MenuItem>
        ) : (
          <MenuItem icon={<Trash2 />} tone="danger" onSelect={onDelete}>
            {s.common.delete}
          </MenuItem>
        )}
      </Menu>
    </motion.li>
  );
}

function ProviderGroup({ provider, profiles, onEdit, onDelete }: { provider: Provider; profiles: AgentProfile[]; onEdit: (p: AgentProfile) => void; onDelete: (p: AgentProfile) => void }) {
  const claude = provider === "claude";
  return (
    <section aria-label={uiStrings.providers[provider]} className="flex flex-col gap-2.5">
      <header className="flex items-center gap-2 px-0.5">
        <ProviderMark provider={provider} size={14} label="" />
        <span className={cn("text-fg", claude ? "font-serif text-sm" : "font-mono text-xs font-medium")}>{uiStrings.providers[provider]}</span>
        <span className="text-xs text-fg-faint tabular">{profiles.length}</span>
      </header>
      <motion.ul
        initial="initial"
        animate="animate"
        variants={stagger(0.03)}
        className={cn("divide-y overflow-hidden rounded-lg border shadow-1", claude ? "divide-claude-line/60 border-claude-line bg-claude-surface" : "divide-codex-line/70 border-codex-line bg-codex-surface")}
      >
        {profiles.map((x) => (
          <ProfileRow key={x.id} profile={x} onEdit={() => onEdit(x)} onDelete={() => onDelete(x)} />
        ))}
      </motion.ul>
    </section>
  );
}

function AgentBehavior() {
  const settings = useSettings();
  const update = useUpdateSetting();
  const num = (key: string, fallback: number) => {
    const v = settings.data?.[key];
    return typeof v === "number" ? v : fallback;
  };
  const save = (key: string) => (v: number | null) =>
    update.mutate({ key, value: v ?? 0 }, { onSuccess: () => toast.success(s.common.saved), onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }) });
  return (
    <Section title={p.behavior}>
      <SettingRow
        label={p.stallMinutes}
        description={p.stallMinutesHint}
        control={<CommitNumber aria-label={p.stallMinutes} value={num("agents.stall_minutes", 10)} min={1} max={240} unit={p.minutes} onCommit={save("agents.stall_minutes")} />}
      />
      <SettingRow
        label={p.permissionTimeout}
        description={p.permissionTimeoutHint}
        control={
          <CommitNumber aria-label={p.permissionTimeout} value={num("agents.permission_timeout_minutes", 0)} min={0} max={1440} unit={p.minutes} onCommit={save("agents.permission_timeout_minutes")} />
        }
      />
    </Section>
  );
}

export function ProfilesSection() {
  const profiles = useProfiles();
  const del = useDeleteProfile();
  const [form, setForm] = useState<{ open: boolean; key: number; profile?: AgentProfile }>({ open: false, key: 0 });
  const [deleting, setDeleting] = useState<AgentProfile | null>(null);
  const list = profiles.data ?? [];
  const edit = (profile?: AgentProfile) => setForm((f) => ({ open: true, key: f.key + 1, profile }));

  return (
    <SectionPage
      title={s.sections.profiles.title}
      description={s.sections.profiles.description}
      actions={
        <Button variant="primary" icon={<Plus />} onClick={() => edit()}>
          {p.add}
        </Button>
      }
    >
      {profiles.isPending ? (
        <ListSkeleton rows={4} />
      ) : profiles.isError ? (
        <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          {(["claude", "codex"] as const).map((prov) => {
            const items = list.filter((x) => x.provider === prov);
            return items.length ? <ProviderGroup key={prov} provider={prov} profiles={items} onEdit={edit} onDelete={setDeleting} /> : null;
          })}
        </div>
      )}
      <AgentBehavior />
      <ProfileSheet key={form.key} open={form.open} onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))} profile={form.profile} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? p.deleteTitle(deleting.name) : ""}
        description={p.deleteBody}
        confirmLabel={s.common.delete}
        loading={del.isPending}
        onConfirm={() => {
          const x = deleting;
          if (!x) return;
          del.mutate(x.id, {
            onSuccess: () => {
              toast.success(s.common.deleted, { description: x.name });
              setDeleting(null);
            },
            onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }),
          });
        }}
      />
    </SectionPage>
  );
}
