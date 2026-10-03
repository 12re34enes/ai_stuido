import { BadgeCheck, ChevronDown, ExternalLink, FolderGit2, GitBranch, Lock, MoreHorizontal, Plus, Search, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { useNow } from "@/hooks/useNow";
import { openExternal } from "@/native";
import { stagger, variants } from "@/motion/tokens";
import { Badge, Button, EmptyState, IconButton, Input, Menu, MenuItem, RelativeTime, Skeleton, toast } from "@/ui";

import { useDeleteGitAccount, useGitAccounts, useGitRepos, useVerifyGitAccount } from "../api";
import { ConfirmDialog, errorMessage, ErrorState, ListSkeleton } from "../kit";
import { useConnectionsUi } from "../store";
import { connStrings as s } from "../strings";
import type { GitAccount } from "../types";
import { GitAccountSheet } from "./GitAccountForm";
import { HostingMark } from "./marks";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function RepoList({ account }: { account: GitAccount }) {
  const repos = useGitRepos(account.id, true);
  const now = useNow(60_000);
  const [q, setQ] = useState("");
  if (repos.isPending)
    return (
      <div className="flex flex-col gap-2 px-4 py-3">
        <Skeleton height={12} width="55%" />
        <Skeleton height={12} width="40%" />
        <Skeleton height={12} width="62%" />
      </div>
    );
  if (repos.isError) return <ErrorState size="sm" error={repos.error} onRetry={() => void repos.refetch()} />;
  const all = repos.data ?? [];
  if (all.length === 0) return <EmptyState size="sm" icon={<FolderGit2 />} title={s.git.reposEmpty} />;
  const needle = q.trim().toLocaleLowerCase("tr-TR");
  const list = needle ? all.filter((r) => `${r.full_name} ${r.description ?? ""}`.toLocaleLowerCase("tr-TR").includes(needle)) : all;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <Input size="sm" icon={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder={s.git.reposSearch} aria-label={s.git.reposSearch} wrapperClassName="w-64" />
        <span className="text-xs text-fg-faint tabular">{s.git.reposCount(list.length)}</span>
      </div>
      <motion.ul initial="initial" animate="animate" variants={stagger(0.015)} className="max-h-80 divide-y divide-line-subtle overflow-y-auto border-t border-line-subtle">
        {list.slice(0, 200).map((r) => (
          <motion.li key={r.full_name} variants={variants.fade} className="group flex items-center gap-3 px-4 py-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-xs text-fg">{r.full_name}</span>
                {r.private && (
                  <Badge tone="neutral" size="sm" icon={<Lock aria-hidden />}>
                    {s.git.private}
                  </Badge>
                )}
              </span>
              {r.description && <span className="truncate text-2xs text-fg-muted">{r.description}</span>}
            </div>
            {r.default_branch && (
              <span className="hidden items-center gap-1 font-mono text-2xs text-fg-faint md:flex">
                <GitBranch className="size-3" aria-hidden />
                {r.default_branch}
              </span>
            )}
            {r.updated_at && <RelativeTime value={r.updated_at} now={now} className="w-24 text-right text-2xs text-fg-faint" />}
            <IconButton size="sm" label="Tarayıcıda aç" icon={<ExternalLink />} onClick={() => void openExternal(r.web_url)} className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" />
          </motion.li>
        ))}
      </motion.ul>
    </div>
  );
}

function AccountCard({ account, onDelete }: { account: GitAccount; onDelete: () => void }) {
  const verify = useVerifyGitAccount();
  const [expanded, setExpanded] = useState(false);
  const host = hostOf(account.web_url);
  const scopes = account.scopes;
  return (
    <motion.li layout="position" variants={variants.listItem} className="overflow-hidden rounded-lg border border-line bg-surface shadow-1">
      <div className="flex items-center gap-3.5 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-surface-sunken text-fg">
          <HostingMark kind={account.kind} size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{account.name}</span>
            <Badge tone="neutral" size="sm">
              {s.git.kind[account.kind]}
            </Badge>
          </span>
          <span className="truncate font-mono text-xs text-fg-muted">
            {account.username} · {host}
          </span>
        </div>
        <div className="hidden max-w-[280px] flex-wrap justify-end gap-1 lg:flex" aria-label={s.git.scopes}>
          {scopes.length === 0 ? (
            <span className="text-2xs text-fg-faint">{s.git.scopesNone}</span>
          ) : (
            <>
              {scopes.slice(0, 4).map((sc) => (
                <Badge key={sc} tone="neutral" variant="outline" size="sm" className="font-mono">
                  {sc}
                </Badge>
              ))}
              {scopes.length > 4 && (
                <Badge tone="neutral" variant="outline" size="sm">
                  +{scopes.length - 4}
                </Badge>
              )}
            </>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<BadgeCheck />}
          loading={verify.isPending}
          onClick={() =>
            verify.mutate(account.id, {
              onSuccess: (a) => toast.success(s.git.verified, { description: `${a.username} · ${a.scopes.join(", ") || s.git.scopesNone}` }),
              onError: (e) => toast.error(s.git.verifyFailed, { description: errorMessage(e) }),
            })
          }
        >
          {s.git.verify}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded((x) => !x)}
          iconRight={
            <motion.span animate={{ rotate: expanded ? 180 : 0 }} className="flex">
              <ChevronDown className="size-3.5" aria-hidden />
            </motion.span>
          }
        >
          {s.git.repos}
        </Button>
        <Menu align="end" trigger={<IconButton label={s.common.more} icon={<MoreHorizontal />} tooltip={false} />}>
          <MenuItem icon={<ExternalLink />} onSelect={() => void openExternal(account.web_url)}>
            {host}
          </MenuItem>
          <MenuItem icon={<Trash2 />} tone="danger" onSelect={onDelete}>
            {s.common.delete}
          </MenuItem>
        </Menu>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div key="repos" {...variants.fadeUp} className="border-t border-line-subtle bg-canvas-subtle/50">
            <RepoList account={account} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export function GitTab() {
  const accounts = useGitAccounts();
  const dialog = useConnectionsUi((st) => st.dialog);
  const seq = useConnectionsUi((st) => st.seq);
  const openDialog = useConnectionsUi((st) => st.open);
  const closeDialog = useConnectionsUi((st) => st.close);
  const del = useDeleteGitAccount();
  const [deleting, setDeleting] = useState<GitAccount | null>(null);
  const list = accounts.data ?? [];

  let body;
  if (accounts.isPending) body = <ListSkeleton rows={2} />;
  else if (accounts.isError) body = <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />;
  else if (list.length === 0)
    body = (
      <EmptyState
        icon={<FolderGit2 />}
        title={s.git.emptyTitle}
        description={s.git.emptyHint}
        action={
          <Button variant="primary" icon={<Plus />} onClick={() => openDialog("git.new")}>
            {s.git.add}
          </Button>
        }
      />
    );
  else
    body = (
      <motion.ul initial="initial" animate="animate" variants={stagger(0.04)} className="flex flex-col gap-3" aria-label={s.tabs.git}>
        {list.map((a) => (
          <AccountCard key={a.id} account={a} onDelete={() => setDeleting(a)} />
        ))}
      </motion.ul>
    );

  return (
    <>
      {body}
      <GitAccountSheet key={seq} open={dialog === "git.new"} onOpenChange={(o) => !o && closeDialog()} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? s.git.deleteTitle(deleting.name) : ""}
        description={s.git.deleteBody}
        confirmLabel={s.common.delete}
        loading={del.isPending}
        onConfirm={() => {
          const a = deleting;
          if (!a) return;
          del.mutate(a.id, {
            onSuccess: () => {
              toast.success(s.common.deleted, { description: a.name });
              setDeleting(null);
            },
            onError: (err) => toast.error(s.common.deleteFailed, { description: errorMessage(err) }),
          });
        }}
      />
    </>
  );
}
