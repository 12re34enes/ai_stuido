/**
 * Tool call rows: kind icon, a Turkish one-liner that follows the call's state, exit code /
 * diffstat / duration, and a spring disclosure with the input and output (commands in a
 * LogView, edits as inline diffs). File changes outside a tool call use the same row.
 */
import { ChevronRight, FileDiff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, type ReactNode } from "react";

import { formatDuration } from "@/i18n/format";
import { spring, transition } from "@/motion/tokens";
import { Badge, cn, CodeBlock, CopyButton, LogView, Spinner } from "@/ui";

import { diffStats } from "@/ui/code/diffStats";

import { Collapse } from "../kit/Collapse";
import { InlineCode } from "../kit/InlineCode";
import { PatchFileView } from "../kit/PatchFileView";
import { parsePatch, type PatchFile } from "../kit/patch";
import { sessionStrings as t } from "../strings";
import { useStreamContext } from "./context";
import type { FileChangeData, FileItem, ToolItem } from "./model";
import { describeTool, describeToolText, toolCommand, toolIcon, toolKindLabel } from "./tools";

function Stats({ additions, deletions }: { additions: number; deletions: number }) {
  if (!additions && !deletions) return null;
  return (
    <span className="flex items-center gap-1 font-mono text-2xs tabular">
      <span className="text-success">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
    </span>
  );
}

function IconTile({ children, running }: { children: ReactNode; running?: boolean }) {
  const { provider, compact } = useStreamContext();
  const claude = provider === "claude";
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center transition-colors duration-300",
        compact ? "size-[18px] [&_svg]:size-3" : "size-[22px] [&_svg]:size-3.5",
        claude ? "rounded-[6px]" : "rounded-[3px] border",
        running
          ? claude
            ? "bg-claude-soft text-claude-strong"
            : "border-codex bg-codex-soft text-codex"
          : claude
            ? "bg-surface-sunken text-fg-muted"
            : "border-codex-line bg-codex-surface text-fg-muted",
      )}
    >
      <span className={cn("flex", running && "session-breathe")}>{children}</span>
    </span>
  );
}

/** Clickable header shared by tool and file rows. */
function RowButton({
  open,
  onToggle,
  controls,
  icon,
  label,
  trailing,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const { compact } = useStreamContext();
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "group -mx-1.5 grid w-[calc(100%+12px)] items-center rounded-md px-1.5 text-left outline-none transition-colors duration-150",
        "hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]",
        compact ? "h-[26px] grid-cols-[18px_minmax(0,1fr)_auto] gap-x-2.5 text-xs" : "h-8 grid-cols-[22px_minmax(0,1fr)_auto] gap-x-3 text-sm",
      )}
    >
      {icon}
      <span className="min-w-0 truncate text-fg">{children}</span>
      <span className="flex shrink-0 items-center gap-2 pl-2">
        {trailing}
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={spring.snappy}
          className="flex text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 data-[open=true]:opacity-100"
          data-open={open}
        >
          <ChevronRight className="size-3.5" aria-hidden />
        </motion.span>
      </span>
    </button>
  );
}

function Described({ item }: { item: ToolItem }) {
  const { cwd, provider } = useStreamContext();
  const d = describeTool(item, cwd);
  return (
    <>
      {d.text && <InlineCode text={d.text} className={cn(d.code && "mr-1.5", item.result?.isError ? "text-danger" : "text-fg")} />}
      {d.code && (
        <code
          className={cn("rounded-[4px] px-1 py-px font-mono text-[0.92em]", provider === "claude" ? "bg-surface-sunken text-fg" : "bg-codex-soft text-codex")}
        >
          {d.code}
        </code>
      )}
      {d.after && <span className={cn("ml-1.5", item.result?.isError ? "text-danger" : "text-fg-muted")}>{d.after}</span>}
    </>
  );
}

/** Line stats as DiffView will show them (LCS over the reconstructed sides). */
function totalsOf(files: PatchFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (t, f) => {
      if (f.empty) return t;
      const s = diffStats(f.original, f.modified);
      return { additions: t.additions + s.added, deletions: t.deletions + s.removed };
    },
    { additions: 0, deletions: 0 },
  );
}

function filesOf(files: FileChangeData[]): PatchFile[] {
  return files.flatMap((f) => {
    const parsed = parsePatch(f.diff, f.path);
    return parsed.length
      ? parsed.map((p) => ({ ...p, path: f.path || p.path, oldPath: f.oldPath ?? p.oldPath }))
      : [{ path: f.path, oldPath: f.oldPath, original: "", modified: "", additions: 0, deletions: 0, empty: true }];
  });
}

function FileDiffs({ files }: { files: PatchFile[] }) {
  return (
    <div className="flex flex-col gap-2">
      {files.map((f, i) => (
        <PatchFileView key={`${f.path}-${i}`} file={f} />
      ))}
    </div>
  );
}

function SectionTitle({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex h-6 items-center justify-between gap-2">
      <span className="text-2xs font-medium tracking-[0.04em] text-fg-faint uppercase">{children}</span>
      {trailing}
    </div>
  );
}

function CommandOutput({ item, command }: { item: ToolItem; command: string }) {
  const output = item.result?.output;
  const lines = useMemo(() => (output ? output.replace(/\n$/, "").split("\n") : []), [output]);
  const height = Math.min(280, Math.max(56, lines.length * 20 + 16));
  const code = item.result?.exitCode;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-code">
      <div className="flex h-8 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3">
        <span className="shrink-0 font-mono text-2xs text-fg-faint select-none">$</span>
        <span data-selectable className="min-w-0 flex-1 truncate font-mono text-2xs text-fg" title={command}>
          {command}
        </span>
        {code !== null && code !== undefined && (
          <Badge tone={code === 0 ? "neutral" : "danger"} className="font-mono">
            {t.stream.exit(code)}
          </Badge>
        )}
        <CopyButton value={command} size="xs" />
      </div>
      {item.result ? (
        <div style={{ height }}>
          <LogView lines={lines} follow={false} wrap emptyLabel={t.stream.noOutput} className="h-full" aria-label={t.stream.toolOutput} />
        </div>
      ) : (
        <div className="flex h-10 items-center gap-2 px-3 text-xs text-fg-muted">
          <Spinner size={12} label="" />
          {t.stream.running}
        </div>
      )}
    </div>
  );
}

function ToolDetail({ item }: { item: ToolItem }) {
  const command = toolCommand(item);
  const files = useMemo(() => filesOf(item.files), [item.files]);
  if (command) return <CommandOutput item={item} command={command} />;
  const inputJson = Object.keys(item.input).length ? JSON.stringify(item.input, null, 2) : null;
  return (
    <div className="flex flex-col gap-2">
      {files.length > 0 ? (
        <FileDiffs files={files} />
      ) : (
        inputJson && (
          <div>
            <SectionTitle>{t.stream.toolInput}</SectionTitle>
            <CodeBlock code={inputJson} language="json" maxHeight={220} wrap />
          </div>
        )
      )}
      {item.result && item.result.output.trim() && (files.length === 0 || item.result.isError) && (
        <div>
          <SectionTitle>{t.stream.toolOutput}</SectionTitle>
          <CodeBlock code={item.result.output} maxHeight={260} wrap className={item.result.isError ? "border-danger/40" : undefined} />
        </div>
      )}
      {item.result?.blobRef && <p className="text-2xs text-fg-faint">{t.stream.truncated}</p>}
    </div>
  );
}

export function ToolRow({ item }: { item: ToolItem }) {
  const { cwd, isOpen, toggle, compact } = useStreamContext();
  const open = isOpen(item.key);
  const Icon = toolIcon[item.toolKind];
  const running = item.result === null;
  const failed = item.result?.isError === true;
  const totals = useMemo(() => totalsOf(filesOf(item.files)), [item.files]);
  const ms = item.doneTs ? Date.parse(item.doneTs) - Date.parse(item.ts) : null;
  const exit = item.result?.exitCode;
  const panelId = `tool-${item.callId}`;
  return (
    <div>
      <RowButton
        open={open}
        onToggle={() => toggle(item.key)}
        controls={panelId}
        label={`${toolKindLabel[item.toolKind]}: ${describeToolText(item, cwd)}`}
        icon={
          <IconTile running={running}>
            <Icon aria-hidden />
          </IconTile>
        }
        trailing={
          <>
            <Stats additions={totals.additions} deletions={totals.deletions} />
            {ms !== null && ms >= 1000 && <span className="text-2xs text-fg-faint tabular">{formatDuration(ms)}</span>}
            <AnimatePresence mode="popLayout" initial={false}>
              {running ? (
                <motion.span
                  key="run"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
                  exit={{ opacity: 0, scale: 0.6, transition: transition.exit }}
                  className="flex text-fg-faint"
                >
                  <Spinner size={12} label={t.stream.running} />
                </motion.span>
              ) : exit !== null && exit !== undefined && item.toolKind === "command" ? (
                <motion.span key="exit" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1, transition: spring.bouncy }} className="flex">
                  <Badge tone={exit === 0 ? "neutral" : "danger"} className="font-mono">
                    {t.stream.exit(exit)}
                  </Badge>
                </motion.span>
              ) : failed ? (
                <motion.span key="err" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1, transition: spring.bouncy }} className="flex">
                  <Badge tone="danger">{t.stream.failed}</Badge>
                </motion.span>
              ) : null}
            </AnimatePresence>
          </>
        }
      >
        <Described item={item} />
      </RowButton>
      <Collapse open={open} id={panelId} className={compact ? "pt-1 pb-2 pl-[28px]" : "pt-1.5 pb-2.5 pl-[34px]"}>
        <ToolDetail item={item} />
      </Collapse>
    </div>
  );
}

export function FileRow({ item }: { item: FileItem }) {
  const { isOpen, toggle, compact, provider } = useStreamContext();
  const open = isOpen(item.key);
  const files = useMemo(() => filesOf([item]), [item]);
  const totals = useMemo(() => totalsOf(files), [files]);
  const panelId = `file-${item.key}`;
  const label = `${item.path} ${t.stream.change[item.change]}`;
  return (
    <div>
      <RowButton
        open={open}
        onToggle={() => toggle(item.key)}
        controls={panelId}
        label={label}
        icon={
          <IconTile>
            <FileDiff aria-hidden />
          </IconTile>
        }
        trailing={<Stats additions={totals.additions} deletions={totals.deletions} />}
      >
        <code
          className={cn("rounded-[4px] px-1 py-px font-mono text-[0.92em]", provider === "claude" ? "bg-surface-sunken text-fg" : "bg-codex-soft text-codex")}
        >
          {item.oldPath ? `${item.oldPath} → ${item.path}` : item.path}
        </code>
        <span className="ml-1.5 text-fg-muted">{t.stream.change[item.change]}</span>
      </RowButton>
      <Collapse open={open} id={panelId} className={compact ? "pt-1 pb-2 pl-[28px]" : "pt-1.5 pb-2.5 pl-[34px]"}>
        <FileDiffs files={files} />
      </Collapse>
    </div>
  );
}
