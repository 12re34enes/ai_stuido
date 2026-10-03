import { Check, RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { useNow } from "@/hooks/useNow";
import { formatDuration } from "@/i18n/format";
import { useEventStream } from "@/lib/events";
import { spring, stagger, variants } from "@/motion/tokens";
import { Button, CopyButton, Dialog, Spinner, toast } from "@/ui";

import { Callout, errorMessage } from "@/features/connections/kit";

import { useLinkChannel } from "../api";
import { setStrings as s } from "../strings";
import type { Channel } from "../types";
import { ChannelTile } from "./channelUi";

const a = s.alerts;

/**
 * Telegram / Slack account linking: studiod issues a 6-digit code; the user sends it to the bot;
 * `alert.channel_linked` arrives live and the dialog turns into a success state.
 */
export function LinkDialog({ channel, onOpenChange }: { channel: Channel | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={channel !== null} onOpenChange={onOpenChange} size="sm" title={a.linkTitle} description={a.linkBody}>
      {channel && <LinkBody channel={channel} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function LinkBody({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const link = useLinkChannel();
  const [linked, setLinked] = useState(false);
  const now = useNow(1000);
  const { mutate } = link;

  useEffect(() => {
    mutate(channel.id);
  }, [channel.id, mutate]);

  useEventStream(linked ? null : { types: ["alert.channel_linked"] }, (batch) => {
    if (batch.some((ev) => ev.payload.channel_id === channel.id)) {
      setLinked(true);
      toast.success(a.linked, { description: channel.name });
    }
  });

  const code = link.data;
  const left = code ? new Date(code.expires_at).getTime() - now : 0;
  const expired = Boolean(code) && left <= 0;

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <ChannelTile kind={channel.kind} size={40} />
      <AnimatePresence mode="popLayout" initial={false}>
        {linked ? (
          <motion.div key="ok" {...variants.pop} className="flex flex-col items-center gap-3">
            <motion.span initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={spring.bouncy} className="grid size-12 place-items-center rounded-full bg-success text-fg-on-accent">
              <Check className="size-6" strokeWidth={3} aria-hidden />
            </motion.span>
            <p className="font-serif text-md text-fg">{a.linked}</p>
            <Button variant="primary" onClick={onClose}>
              {s.common.done}
            </Button>
          </motion.div>
        ) : link.isError ? (
          <motion.div key="err" {...variants.fadeUp} className="w-full">
            <Callout tone="danger" actions={<Button size="sm" icon={<RefreshCw />} onClick={() => mutate(channel.id)}>{a.linkNew}</Button>}>
              {errorMessage(link.error)}
            </Callout>
          </motion.div>
        ) : !code ? (
          <motion.div key="loading" {...variants.fade} className="py-6">
            <Spinner size={20} className="text-fg-muted" />
          </motion.div>
        ) : (
          <motion.div key={code.code} {...variants.fadeUp} className="flex w-full flex-col items-center gap-3">
            <motion.div initial="initial" animate="animate" variants={stagger(0.05)} className="flex items-center gap-1.5" aria-label={code.code} data-testid="link-code">
              {code.code.split("").map((d, i) => (
                <motion.span
                  key={i}
                  variants={variants.pop}
                  aria-hidden
                  className={`grid h-12 w-9 place-items-center rounded-lg border border-line bg-surface font-mono text-2xl font-medium text-fg shadow-1 tabular ${expired ? "opacity-40" : ""}`}
                >
                  {d}
                </motion.span>
              ))}
              <CopyButton value={code.code} size="sm" className="ml-1" />
            </motion.div>
            <p className="text-sm text-fg">{code.instructions}</p>
            {expired ? (
              <div className="flex flex-col items-center gap-2">
                <span className="text-xs text-danger">{a.linkExpired}</span>
                <Button size="sm" icon={<RefreshCw />} loading={link.isPending} onClick={() => mutate(channel.id)}>
                  {a.linkNew}
                </Button>
              </div>
            ) : (
              <span className="flex items-center gap-2 text-xs text-fg-muted">
                <Spinner size={12} label="" />
                {a.linkWaiting} · {a.linkExpires(formatDuration(left))}
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
