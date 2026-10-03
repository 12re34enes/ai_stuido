import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { ChevronLeft, Hourglass, Inbox, PlugZap, RotateCcw, ShieldAlert, Unplug } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useReducer, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { wsUrl } from "@/lib/backend";
import { useEnvironmentScope } from "@/lib/environment";
import { variants } from "@/motion/tokens";
import { Button, cn, EnvBadge, Skeleton, Spinner, StatusDot, type DotStatus } from "@/ui";

import { useHost } from "../api";
import { ErrorState } from "../kit";
import { connStrings as s } from "../strings";
import type { Host } from "../types";
import { initialTerminalState, inputMessage, parseServerMessage, resizeMessage, terminalReducer, type TerminalPhase } from "./protocol";
import { onThemeChange, readMonoFont, readXtermTheme } from "./xtermTheme";

const t = s.terminal;

const dot: Record<TerminalPhase, DotStatus> = {
  connecting: "running",
  waiting_approval: "waiting",
  open: "success",
  closed: "offline",
  error: "error",
};

export function TerminalPage() {
  const { id = "" } = useParams();
  const host = useHost(id);
  if (host.isPending)
    return (
      <div className="flex h-full flex-col gap-3 p-6">
        <Skeleton height={20} width={240} />
        <Skeleton className="flex-1" />
      </div>
    );
  if (host.isError || !host.data)
    return (
      <div className="p-8">
        <ErrorState error={host.error} title={s.common.notFound} onRetry={() => void host.refetch()} />
      </div>
    );
  return <RemoteTerminal host={host.data} />;
}

/**
 * Interactive remote terminal (spec §12 "Uzak terminal"): xterm.js over the authenticated
 * WebSocket, resized with the window and themed from the design tokens. Production hosts wait for
 * an approval before the shell opens; every submitted line lands in the audit log server-side.
 */
function RemoteTerminal({ host }: { host: Host }) {
  useEnvironmentScope(host.environment, host.name);
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const userClosedRef = useRef(false);
  const [state, dispatch] = useReducer(terminalReducer, initialTerminalState);
  const [attempt, setAttempt] = useState(0);
  const production = host.environment === "production";
  const back = `/connections/hosts/${encodeURIComponent(host.id)}`;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: readMonoFont(el),
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: false,
      scrollback: 5000,
      theme: readXtermTheme(el),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      // container not measurable yet (hidden): the ResizeObserver fits it later
    }
    let disposed = false;
    let open = false;

    const send = (payload: string) => {
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
    };

    void wsUrl(`/api/remote/hosts/${encodeURIComponent(host.id)}/terminal`, { cols: term.cols, rows: term.rows }).then((url) => {
      if (disposed) return;
      const ws = new WebSocket(url);
      socketRef.current = ws;
      ws.onmessage = (ev) => {
        const msg = parseServerMessage(ev.data);
        if (!msg) return;
        if (msg.kind === "output") term.write(msg.data);
        else {
          if (msg.kind === "status" && msg.state === "open") {
            open = true;
            send(resizeMessage(term.cols, term.rows));
            term.focus();
          }
          if (msg.kind === "exit" || msg.kind === "error") open = false;
          dispatch(msg);
        }
      };
      ws.onclose = () => {
        open = false;
        if (disposed) return;
        if (userClosedRef.current) dispatch({ kind: "exit", code: null });
        else dispatch({ kind: "socket_closed", message: t.lostConnection });
      };
    });

    const dataSub = term.onData((data) => {
      if (open) send(inputMessage(data));
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (open) send(resizeMessage(term.cols, term.rows));
    });
    ro.observe(el);
    const offTheme = onThemeChange(() => {
      term.options.theme = readXtermTheme(el);
    });

    return () => {
      disposed = true;
      offTheme();
      ro.disconnect();
      dataSub.dispose();
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
    };
  }, [host.id, attempt]);

  const reconnect = () => {
    userClosedRef.current = false;
    dispatch({ kind: "reset" });
    setAttempt((a) => a + 1);
  };

  const status = state.phase === "error" ? t.status.error : t.status[state.phase];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-canvas px-4">
        <Link
          to={back}
          className="-ml-1 flex items-center gap-0.5 rounded-md py-1 pr-1.5 pl-0.5 text-sm text-fg-muted outline-none transition-colors hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {host.name}
        </Link>
        <span aria-hidden className="h-4 w-px bg-line" />
        <h1 className="truncate font-sans text-sm font-medium text-fg">{t.title(host.name)}</h1>
        <EnvBadge environment={host.environment} />
        <span className="flex items-center gap-1.5 rounded-full bg-surface-sunken py-0.5 pr-2.5 pl-1.5 text-xs text-fg-muted" role="status" aria-live="polite" data-testid="terminal-status">
          <StatusDot status={dot[state.phase]} size={12} label={status} />
          {status}
        </span>
        <span className="flex-1" />
        <span className="hidden truncate text-2xs text-fg-faint xl:block">{t.auditNote}</span>
        {(state.phase === "closed" || state.phase === "error") && (
          <Button size="sm" icon={<RotateCcw />} onClick={reconnect}>
            {t.reconnect}
          </Button>
        )}
        {state.phase === "open" && (
          <Button size="sm" variant="ghost" icon={<Unplug />} onClick={() => {
              userClosedRef.current = true;
              socketRef.current?.close();
            }}
          >
            {t.disconnect}
          </Button>
        )}
      </header>
      <div className={cn("relative min-h-0 flex-1 bg-code p-3", production && "shadow-[inset_0_0_0_1px_var(--env-production)]")}>
        <div ref={containerRef} className="size-full" data-testid="terminal" aria-label={t.title(host.name)} />
        <AnimatePresence>
          {state.phase !== "open" && (
            <motion.div key={state.phase} {...variants.fade} className="absolute inset-0 grid place-items-center bg-code/85 p-6 backdrop-blur-[2px]">
              <motion.div {...variants.pop} className="flex max-w-md flex-col items-center gap-3 text-center">
                {state.phase === "connecting" && (
                  <>
                    <Spinner size={20} className="text-fg-muted" />
                    <p className="text-sm text-fg-muted">{t.status.connecting}</p>
                  </>
                )}
                {state.phase === "waiting_approval" && (
                  <>
                    <span className="grid size-11 place-items-center rounded-full bg-env-production text-fg-on-accent shadow-[0_0_0_4px_var(--env-production-soft)]">
                      <Hourglass className="size-5 animate-pulse" aria-hidden />
                    </span>
                    <p className="font-serif text-md text-fg">{t.waitingTitle}</p>
                    <p className="text-sm text-fg-muted">{t.waitingBody}</p>
                    <Button
                      size="sm"
                      icon={<Inbox />}
                      onClick={() => void navigate(state.approvalId ? `/approvals/${encodeURIComponent(state.approvalId)}` : "/approvals")}
                    >
                      {t.openApproval}
                    </Button>
                  </>
                )}
                {state.phase === "closed" && (
                  <>
                    <span className="grid size-11 place-items-center rounded-full bg-surface-sunken text-fg-muted">
                      <Unplug className="size-5" aria-hidden />
                    </span>
                    <p className="text-sm text-fg">{t.exited(state.exitCode)}</p>
                    <Button size="sm" variant="primary" icon={<RotateCcw />} onClick={reconnect}>
                      {t.reconnect}
                    </Button>
                  </>
                )}
                {state.phase === "error" && (
                  <>
                    <span className="grid size-11 place-items-center rounded-full bg-danger-soft text-danger">
                      {state.errorCode === "approval_denied" ? <ShieldAlert className="size-5" aria-hidden /> : <PlugZap className="size-5" aria-hidden />}
                    </span>
                    <p className="text-sm text-fg" role="alert">
                      {state.error}
                    </p>
                    <Button size="sm" variant="primary" icon={<RotateCcw />} onClick={reconnect}>
                      {t.reconnect}
                    </Button>
                  </>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
