import { ArrowLeftRight, BellOff, Link2, ListFilter, MoreHorizontal, Pencil, Plus, Send, Trash2, VolumeX } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { stagger, variants } from "@/motion/tokens";
import { Badge, Button, cn, ConfirmDialog, EmptyState, errorMessage, ErrorState, IconButton, Menu, MenuItem, MenuSeparator, Section, Select, SettingRow, Skeleton, StatusDot, Switch, toast, Tooltip } from "@/ui";


import { useAlertDefaults, useChannelKinds, useChannels, useDeleteChannel, useDeleteRule, useRules, useSaveChannel, useSaveRule, useTestChannel, useUpdateAlertSettings } from "../api";
import { CommitNumber, SectionPage } from "../kit";
import { canLink, eventTypeLabel, SEVERITY_LABEL, SEVERITY_TONE } from "../logic";
import { setStrings as s } from "../strings";
import type { AlertRule, AlertSettings, Channel } from "../types";
import { ChannelSheet } from "./ChannelSheet";
import { ChannelTile } from "./channelUi";
import { DeliveryLog } from "./DeliveryLog";
import { LinkDialog } from "./LinkDialog";
import { QuietHoursCard } from "./QuietHoursCard";
import { RuleSheet } from "./RuleSheet";

const a = s.alerts;

function ChannelRow({ channel, onEdit, onDelete, onLink }: { channel: Channel; onEdit: () => void; onDelete: () => void; onLink: () => void }) {
  const save = useSaveChannel();
  const test = useTestChannel();
  const kinds = useChannelKinds();
  const kindLabel = kinds.data?.find((k) => k.kind === channel.kind)?.label ?? channel.kind;
  const linkable = canLink(channel);
  return (
    <motion.li layout="position" variants={variants.listItem} className={cn("flex items-center gap-3.5 px-4 py-3 transition-opacity duration-200", !channel.enabled && "opacity-60")}>
      <ChannelTile kind={channel.kind} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{channel.name}</span>
          {channel.two_way && (
            <Badge tone="accent" size="sm" icon={<ArrowLeftRight aria-hidden />}>
              {a.twoWay}
            </Badge>
          )}
        </span>
        {channel.last_error ? (
          <Tooltip content={channel.last_error} side="bottom">
            <span className="truncate text-xs text-danger">{channel.last_error}</span>
          </Tooltip>
        ) : channel.two_way && linkable ? (
          <span className="flex items-center gap-1.5 text-xs text-fg-muted">
            <StatusDot status={channel.listening ? "running" : "idle"} size={10} tone="accent" label={channel.listening ? a.listening : a.notListening} />
            {channel.listening ? a.listening : a.notListening}
          </span>
        ) : (
          <span className="truncate text-xs text-fg-muted">{kindLabel}</span>
        )}
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={<Send />}
        loading={test.isPending}
        disabled={!channel.enabled}
        onClick={() =>
          test.mutate(channel.id, {
            onSuccess: (r) =>
              r.status === "sent"
                ? toast.success(a.testSent, { description: channel.name })
                : toast.error(a.testFailed, { description: r.error ?? a.status[r.status] }),
            onError: (e) => toast.error(a.testFailed, { description: errorMessage(e) }),
          })
        }
      >
        {a.test}
      </Button>
      {linkable && (
        <Button size="sm" variant="ghost" icon={<Link2 />} disabled={!channel.enabled} onClick={onLink}>
          {a.link}
        </Button>
      )}
      <Switch
        size="sm"
        aria-label={`${channel.name}: ${s.common.enabled}`}
        checked={channel.enabled}
        onCheckedChange={(on) => save.mutate({ id: channel.id, body: { enabled: on } }, { onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }) })}
      />
      <Menu align="end" trigger={<IconButton label={s.common.more} icon={<MoreHorizontal />} tooltip={false} />}>
        <MenuItem icon={<Pencil />} onSelect={onEdit}>
          {s.common.edit}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} tone="danger" onSelect={onDelete}>
          {s.common.delete}
        </MenuItem>
      </Menu>
    </motion.li>
  );
}

function RuleRow({ rule, channels, onEdit, onDelete }: { rule: AlertRule; channels: Channel[]; onEdit: () => void; onDelete: () => void }) {
  const save = useSaveRule();
  const names = rule.channel_ids.map((id) => channels.find((c) => c.id === id)?.name ?? id);
  return (
    <motion.li layout="position" variants={variants.listItem} className={cn("flex items-center gap-3.5 px-4 py-3", !rule.enabled && "opacity-60")}>
      <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-surface-sunken text-fg-muted">
        <ListFilter className="size-4" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{rule.name}</span>
          <Badge tone={SEVERITY_TONE[rule.min_severity]} size="sm">
            ≥ {SEVERITY_LABEL[rule.min_severity]}
          </Badge>
          {rule.sound && <span className="text-2xs text-fg-faint">♪</span>}
        </span>
        <span className="truncate text-xs text-fg-muted">
          {rule.event_types.length ? rule.event_types.map(eventTypeLabel).join(", ") : a.allEvents}
          <span className="text-fg-faint"> → </span>
          {names.length ? (
            names.join(", ")
          ) : (
            <span className="inline-flex items-center gap-1 text-warning">
              <VolumeX className="inline size-3" aria-hidden />
              {a.mutes}
            </span>
          )}
        </span>
      </div>
      <Switch size="sm" aria-label={`${rule.name}: ${s.common.enabled}`} checked={rule.enabled} onCheckedChange={(on) => save.mutate({ id: rule.id, body: { enabled: on } })} />
      <Menu align="end" trigger={<IconButton label={s.common.more} icon={<MoreHorizontal />} tooltip={false} />}>
        <MenuItem icon={<Pencil />} onSelect={onEdit}>
          {s.common.edit}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} tone="danger" onSelect={onDelete}>
          {s.common.delete}
        </MenuItem>
      </Menu>
    </motion.li>
  );
}

function Advanced({ settings }: { settings: AlertSettings }) {
  const update = useUpdateAlertSettings();
  const save = (patch: Partial<AlertSettings>) => update.mutate(patch, { onSuccess: () => toast.success(s.common.saved), onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }) });
  return (
    <Section title={a.advanced}>
      <SettingRow label={a.dedup} control={<CommitNumber aria-label={a.dedup} value={settings.dedup_seconds} min={0} max={86400} unit={a.seconds} onCommit={(v) => save({ dedup_seconds: v ?? 0 })} />} />
      <SettingRow label={a.group} control={<CommitNumber aria-label={a.group} value={settings.group_window_seconds} min={0} max={3600} unit={a.seconds} onCommit={(v) => save({ group_window_seconds: v ?? 0 })} />} />
      <SettingRow label={a.rate} control={<CommitNumber aria-label={a.rate} value={settings.rate_limit_per_minute} min={1} max={600} unit={a.perMinute} onCommit={(v) => save({ rate_limit_per_minute: v ?? 20 })} />} />
      <SettingRow
        label={a.confirmTimeout}
        control={<CommitNumber aria-label={a.confirmTimeout} value={settings.confirm_timeout_seconds} min={10} max={3600} unit={a.seconds} onCommit={(v) => save({ confirm_timeout_seconds: v ?? 120 })} />}
      />
    </Section>
  );
}

export function AlertsSection() {
  const channels = useChannels();
  const rules = useRules();
  const defaults = useAlertDefaults();
  const update = useUpdateAlertSettings();
  const delChannel = useDeleteChannel();
  const delRule = useDeleteRule();
  const [channelForm, setChannelForm] = useState<{ open: boolean; key: number; channel?: Channel }>({ open: false, key: 0 });
  const [ruleForm, setRuleForm] = useState<{ open: boolean; key: number; rule?: AlertRule }>({ open: false, key: 0 });
  const [linking, setLinking] = useState<Channel | null>(null);
  const [deleting, setDeleting] = useState<{ kind: "channel"; item: Channel } | { kind: "rule"; item: AlertRule } | null>(null);
  const channelList = channels.data ?? [];
  const ruleList = rules.data ?? [];
  const settings = defaults.data?.settings;
  const mobile = channelList.filter((c) => ["telegram", "slack", "ntfy"].includes(c.kind));

  const openChannel = (channel?: Channel) => setChannelForm((f) => ({ open: true, key: f.key + 1, channel }));
  const openRule = (rule?: AlertRule) => setRuleForm((f) => ({ open: true, key: f.key + 1, rule }));

  return (
    <SectionPage title={s.sections.alerts.title} description={s.sections.alerts.description}>
      <Section>
        <SettingRow
          label={a.master}
          description={a.masterHint}
          control={
            settings ? (
              <Switch aria-label={a.master} checked={settings.enabled} onCheckedChange={(on) => update.mutate({ enabled: on }, { onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }) })} />
            ) : (
              <Skeleton width={32} height={18} className="rounded-full" />
            )
          }
        />
      </Section>

      <Section
        title={a.channels}
        description={a.channelsHint}
        actions={
          <Button size="sm" icon={<Plus />} onClick={() => openChannel()}>
            {a.addChannel}
          </Button>
        }
      >
        {channels.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton height={32} />
            <Skeleton height={32} />
          </div>
        ) : channels.isError ? (
          <ErrorState size="sm" error={channels.error} onRetry={() => void channels.refetch()} />
        ) : channelList.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<BellOff />}
            title={a.noChannels}
            description={a.noChannelsHint}
            action={
              <Button size="sm" variant="primary" icon={<Plus />} onClick={() => openChannel()}>
                {a.addChannel}
              </Button>
            }
          />
        ) : (
          <motion.ul initial="initial" animate="animate" variants={stagger(0.03)} className="divide-y divide-line-subtle" aria-label={a.channels}>
            {channelList.map((c) => (
              <ChannelRow key={c.id} channel={c} onEdit={() => openChannel(c)} onDelete={() => setDeleting({ kind: "channel", item: c })} onLink={() => setLinking(c)} />
            ))}
          </motion.ul>
        )}
      </Section>

      <Section title={a.routing} description={a.routingHint}>
        {defaults.isPending ? (
          <div className="p-4">
            <Skeleton height={120} />
          </div>
        ) : defaults.isError ? (
          <ErrorState size="sm" error={defaults.error} onRetry={() => void defaults.refetch()} />
        ) : (
          <>
            <ul className="divide-y divide-line-subtle">
              {(defaults.data?.routing ?? []).map((row) => (
                <li key={row.severity} className="grid grid-cols-[88px_1fr] gap-4 px-4 py-3">
                  <span>
                    <Badge tone={SEVERITY_TONE[row.severity]} size="md">
                      {row.label}
                    </Badge>
                  </span>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm text-fg">
                      {row.channels}
                      {row.bypasses_quiet_hours && (
                        <Badge tone="neutral" variant="outline" size="sm">
                          {a.bypassesQuiet}
                        </Badge>
                      )}
                    </span>
                    <span className="text-xs text-fg-muted">{row.examples.join(" · ")}</span>
                  </div>
                </li>
              ))}
            </ul>
            <SettingRow
              label={a.primary}
              description={a.primaryHint}
              control={
                <Select
                  aria-label={a.primary}
                  className="w-64"
                  value={settings?.primary_channel_id ?? ""}
                  onValueChange={(v) => update.mutate(v ? { primary_channel_id: v } : { clear_primary_channel: true })}
                  options={[{ value: "", label: a.primaryAuto }, ...mobile.map((c) => ({ value: c.id, label: c.name }))]}
                />
              }
            />
          </>
        )}
      </Section>

      <Section
        title={a.rules}
        description={a.rulesHint}
        actions={
          <Button size="sm" icon={<Plus />} onClick={() => openRule()}>
            {a.addRule}
          </Button>
        }
      >
        {rules.isPending ? (
          <div className="p-4">
            <Skeleton height={32} />
          </div>
        ) : rules.isError ? (
          <ErrorState size="sm" error={rules.error} onRetry={() => void rules.refetch()} />
        ) : ruleList.length === 0 ? (
          <p className="px-4 py-5 text-sm text-fg-muted">{a.noRules}</p>
        ) : (
          <motion.ul initial="initial" animate="animate" variants={stagger(0.03)} className="divide-y divide-line-subtle" aria-label={a.rules}>
            {ruleList.map((r) => (
              <RuleRow key={r.id} rule={r} channels={channelList} onEdit={() => openRule(r)} onDelete={() => setDeleting({ kind: "rule", item: r })} />
            ))}
          </motion.ul>
        )}
      </Section>

      <QuietHoursCard />
      {settings && <Advanced settings={settings} />}
      <DeliveryLog channels={channelList} />

      <ChannelSheet key={`c-${channelForm.key}`} open={channelForm.open} onOpenChange={(o) => setChannelForm((f) => ({ ...f, open: o }))} channel={channelForm.channel} existing={channelList} />
      <RuleSheet key={`r-${ruleForm.key}`} open={ruleForm.open} onOpenChange={(o) => setRuleForm((f) => ({ ...f, open: o }))} rule={ruleForm.rule} channels={channelList} />
      <LinkDialog channel={linking} onOpenChange={(o) => !o && setLinking(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? (deleting.kind === "channel" ? a.deleteTitle(deleting.item.name) : `“${deleting.item.name}” silinsin mi?`) : ""}
        description={deleting?.kind === "channel" ? a.deleteBody : undefined}
        confirmLabel={s.common.delete}
        loading={delChannel.isPending || delRule.isPending}
        onConfirm={() => {
          const d = deleting;
          if (!d) return;
          const done = {
            onSuccess: () => {
              toast.success(s.common.deleted, { description: d.item.name });
              setDeleting(null);
            },
            onError: (e: unknown) => toast.error(s.common.saveFailed, { description: errorMessage(e) }),
          };
          if (d.kind === "channel") delChannel.mutate(d.item.id, done);
          else delRule.mutate(d.item.id, done);
        }}
      />
    </SectionPage>
  );
}
