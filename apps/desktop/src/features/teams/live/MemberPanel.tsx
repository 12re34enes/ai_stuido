/**
 * Quick panel of the selected member (floats over the canvas): status, current work, a button to
 * the live stream (drawer) and a "Mesaj gönder / Yönlendir" box that talks to the member through
 * the engine (`POST /runs/{run}/team/members/{id}/message`).
 */
import { ArrowUp, PanelRightOpen, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { spring, transition } from "@/motion/tokens";
import { Button, cn, IconButton, ProviderMark, SegmentedControl, StatusDot, Textarea, toast } from "@/ui";

import { errorText } from "../../flows/util";
import { useMemberMessage } from "../api";
import { nameFont } from "../chart/looks";
import { memberDot } from "../model/live";
import { roleLabel } from "../model/spec";
import { memberStatusStrings, s } from "../strings";
import type { MessageMode } from "../types";
import { useLive } from "./context";

export function MemberPanel() {
  const { state, selected, select, openStream, runId } = useLive();
  const member = selected ? state.spec?.members.find((m) => m.id === selected) : undefined;
  const live = member ? state.members[member.id] : undefined;
  const send = useMemberMessage(runId, state.nodeId);
  const [mode, setMode] = useState<MessageMode>("send");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const text = member ? (drafts[member.id] ?? "") : "";
  const assignment = live?.assignmentId ? state.assignments[live.assignmentId] : undefined;

  const submit = () => {
    if (!member || !text.trim() || send.isPending) return;
    send.mutate(
      { memberId: member.id, text: text.trim(), mode },
      {
        onSuccess: (res) => {
          toast.success(s.live.delivered[res.delivered](member.name));
          setDrafts((d) => ({ ...d, [member.id]: "" }));
        },
        onError: (e) => toast.error(s.live.sendFailed, { description: errorText(e) }),
      },
    );
  };

  return (
    <AnimatePresence>
      {member && (
        <motion.section
          key="panel"
          aria-label={member.name}
          className="pointer-events-auto flex w-[340px] flex-col gap-2.5 rounded-xl border border-line bg-surface/95 p-3 shadow-3 backdrop-blur-md"
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: spring.smooth }}
          exit={{ opacity: 0, y: 10, transition: transition.exit }}
          data-testid="member-panel"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={member.id} className="flex flex-col gap-2.5" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: spring.smooth }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              <header className="flex items-center gap-2">
                <ProviderMark provider={member.provider} variant="tile" size={22} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("truncate text-fg", nameFont(member.provider))}>{member.name}</span>
                  <span className="flex items-center gap-1.5 text-2xs text-fg-muted">
                    <StatusDot status={memberDot(live)} tone={member.provider} size={9} />
                    {roleLabel(member)} · {memberStatusStrings[live?.status ?? "idle"]}
                  </span>
                </div>
                <IconButton size="sm" label={s.live.openStream} icon={<PanelRightOpen />} disabled={!live?.sessionId} onClick={() => openStream(member.id)} data-testid="open-stream" />
                <IconButton size="sm" label={s.inspector.close} icon={<X />} onClick={() => select(null)} />
              </header>
              {assignment && <p className="line-clamp-2 rounded-md bg-surface-sunken px-2.5 py-1.5 text-xs text-fg">{assignment.title}</p>}
              <SegmentedControl<MessageMode>
                size="sm"
                fullWidth
                aria-label={s.live.message}
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "send", label: s.live.message, hint: s.live.messageHint },
                  { value: "steer", label: s.live.steer, hint: s.live.messageHint },
                ]}
              />
              <div className="relative">
                <Textarea
                  aria-label={mode === "send" ? s.live.message : s.live.steer}
                  minRows={2}
                  maxRows={6}
                  value={text}
                  placeholder={mode === "send" ? s.live.messagePlaceholder(member.name) : s.live.steerPlaceholder(member.name)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [member.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  className="pr-11"
                />
                {/* Button is `relative` itself (cn doesn't merge), so the wrapper does the positioning. */}
                <span className="absolute right-1.5 bottom-1.5 flex">
                  <Button size="sm" variant="primary" icon={<ArrowUp strokeWidth={2.25} />} aria-label={s.live.send} loading={send.isPending} disabled={!text.trim()} onClick={submit} className="px-2" data-testid="member-send">
                    <span className="sr-only">{s.live.send}</span>
                  </Button>
                </span>
              </div>
            </motion.div>
          </AnimatePresence>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
