/** Remote command, database write, tool permission and deploy details. */
import { ArrowRight, ExternalLink, RotateCcw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Link } from "react-router";

import { Badge, CodeBlock, EnvBadge, MarkdownView, ProviderMark, uiStrings } from "@/ui";

import { CommandLine } from "../../sessions/kit/InlineCode";
import { deployPayload, remotePayload, toolPayload, type CommandClass } from "../payload";
import { approvalStrings as s } from "../strings";
import { Facts, Mono, Section, type DetailProps } from "./common";
import { DiffstatTable } from "./code";

const SHORT_CLASS: Record<CommandClass, string> = { read: "Okuma", write: "Yazma", unknown: "Bilinmiyor" };

export function ClassChip({ klass, short }: { klass: CommandClass | null; short?: boolean }) {
  if (!klass) return null;
  const tone = klass === "read" ? "success" : klass === "write" ? "danger" : "warning";
  const Icon = klass === "read" ? ShieldCheck : klass === "write" ? ShieldAlert : ShieldQuestion;
  return (
    <Badge tone={tone} icon={<Icon aria-hidden />} title={s.remote.klass[klass]}>
      {short ? SHORT_CLASS[klass] : s.remote.klass[klass]}
    </Badge>
  );
}

export function RemoteDetail({ approval, variant }: DetailProps) {
  const kind = approval.kind === "db_write" ? "db_write" : "remote_command";
  const p = remotePayload(approval.payload, kind);
  const environment = approval.production ? "production" : p.environment;
  const command =
    p.language === "sql" ? (
      <CodeBlock code={p.command} language="sql" wrap maxHeight={variant === "full" ? 320 : 120} />
    ) : (
      <CommandLine command={p.command} className={variant === "full" ? "text-[13px] leading-6" : undefined} />
    );
  if (variant === "compact") {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {environment && <EnvBadge environment={environment} label={p.target} />}
          {!environment && <span className="text-xs font-medium text-fg">{p.target}</span>}
          {p.targetDetail && <span className="truncate font-mono text-2xs text-fg-muted">{p.targetDetail}</span>}
          <span className="ml-auto">
            <ClassChip klass={p.klass} />
          </span>
        </div>
        {command}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        {environment && <EnvBadge environment={environment} label={p.target} size="md" />}
        {p.targetDetail && <span className="font-mono text-xs text-fg-muted">{p.targetDetail}</span>}
      </div>
      <Section title={kind === "db_write" ? s.remote.query : s.remote.command}>{command}</Section>
      <Section title={s.remote.classification} trailing={<ClassChip klass={p.klass} />}>
        {p.reasons.length > 0 ? (
          <ul className="flex flex-col gap-1 pl-4 text-sm text-fg marker:text-fg-faint [list-style:disc]">
            {p.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
      </Section>
      <Facts
        rows={[
          [kind === "db_write" ? s.remote.database : s.remote.host, p.target],
          [s.remote.environment, environment ? uiStrings.environment[environment] : null],
          [s.remote.permission, p.permission ? (s.remote.levels[p.permission] ?? p.permission) : null],
          [s.remote.policy, p.policyReason],
          [s.remote.reason, p.reason],
          [s.remote.source, p.source],
        ]}
      />
    </div>
  );
}

export function ToolPermissionDetail({ approval, variant }: DetailProps) {
  const p = toolPayload(approval.payload);
  const sessionId = p.sessionId ?? approval.session_id;
  const inputJson = Object.keys(p.input).length ? JSON.stringify(p.input, null, 2) : null;
  const agent = (
    <span className="inline-flex items-center gap-1.5">
      {p.provider && <ProviderMark provider={p.provider} size={13} label="" />}
      <span>{p.label ?? sessionId ?? "—"}</span>
    </span>
  );
  if (variant === "compact") {
    return (
      <div className="flex flex-col gap-2">
        {p.command ? (
          <CommandLine command={p.command} />
        ) : (
          <span className="text-xs text-fg-muted">
            {s.tool.tool}: <Mono>{p.tool}</Mono>
          </span>
        )}
        {p.paths.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {p.paths.slice(0, 4).map((x) => (
              <Mono key={x} className="text-2xs">
                {x}
              </Mono>
            ))}
            {p.paths.length > 4 && <span className="text-2xs text-fg-faint">+{p.paths.length - 4}</span>}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {p.command && (
        <Section title={s.tool.command}>
          <CommandLine command={p.command} className="text-[13px] leading-6" />
        </Section>
      )}
      <Facts
        rows={[
          [s.tool.agent, agent],
          [s.tool.tool, <Mono key="t">{p.tool}</Mono>],
          [s.tool.cwd, p.cwd ? <span className="font-mono text-2xs">{p.cwd}</span> : null],
          [
            s.tool.paths,
            p.paths.length ? (
              <span className="flex flex-wrap gap-1">
                {p.paths.map((x) => (
                  <Mono key={x} className="text-2xs">
                    {x}
                  </Mono>
                ))}
              </span>
            ) : null,
          ],
          [s.tool.policy, p.policyReason],
        ]}
      />
      {inputJson && (
        <Section title={s.tool.input}>
          <CodeBlock code={inputJson} language="json" maxHeight={260} wrap />
        </Section>
      )}
      {sessionId && (
        <Link to={`/sessions/${sessionId}`} className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-accent hover:underline">
          <ExternalLink className="size-3.5" aria-hidden />
          {s.meta.session}
        </Link>
      )}
    </div>
  );
}

export function DeployDetail({ approval, variant }: DetailProps) {
  const p = deployPayload(approval.payload);
  const environment = approval.production ? "production" : p.environment;
  const head = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-fg">{p.profile || "deploy"}</span>
      {p.kind && <Badge>{p.kind}</Badge>}
      <ArrowRight className="size-3.5 text-fg-faint" aria-hidden />
      {environment ? <EnvBadge environment={environment} /> : null}
      {p.ref && <Mono className="text-2xs">{p.ref.slice(0, 12)}</Mono>}
      {p.rollbackOf && (
        <Badge tone="warning" icon={<RotateCcw aria-hidden />}>
          {s.deploy.rollback}
        </Badge>
      )}
    </div>
  );
  if (variant === "compact") return head;
  return (
    <div className="flex flex-col gap-5">
      {head}
      {p.targets.length > 1 && (
        <Section title={s.deploy.targets}>
          <ul className="flex flex-col gap-1.5">
            {p.targets.map((t, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="text-fg">{t.name}</span>
                {t.kind && <Badge>{t.kind}</Badge>}
                {t.environment && <EnvBadge environment={t.environment} />}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Facts
        rows={[
          [s.deploy.ref, p.ref ? <Mono>{p.ref}</Mono> : null],
          [s.deploy.strategy, p.strategy],
          [s.deploy.workflow, p.workflow],
          [s.deploy.healthCheck, p.healthCheck ? <span className="font-mono text-2xs">{p.healthCheck}</span> : null],
          [s.deploy.reason, p.reason],
        ]}
      />
      {(p.command || p.script) && (
        <Section title={p.command ? s.deploy.command : s.deploy.script}>
          {p.command ? <CommandLine command={p.command} /> : <CodeBlock code={p.script ?? ""} language="bash" maxHeight={260} wrap />}
        </Section>
      )}
      {p.summary && (
        <Section title={s.deploy.summary}>
          <MarkdownView source={p.summary} density="compact" />
        </Section>
      )}
      {p.diff.length > 0 && <DiffstatTable diff={p.diff} />}
    </div>
  );
}
