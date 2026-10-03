import { Hash, Laptop, Mail, MessageSquare, Send, Smartphone, Users, Webhook, type LucideIcon } from "lucide-react";

import { cn } from "@/ui";

import type { ChannelKind } from "../types";

const channelIcon: Record<ChannelKind, LucideIcon> = {
  macos: Laptop,
  slack: Hash,
  telegram: Send,
  discord: MessageSquare,
  teams: Users,
  email: Mail,
  ntfy: Smartphone,
  webhook: Webhook,
};

export function ChannelTile({ kind, size = 32, className }: { kind: ChannelKind; size?: number; className?: string }) {
  const Icon = channelIcon[kind];
  return (
    <span aria-hidden style={{ width: size, height: size }} className={cn("grid shrink-0 place-items-center rounded-[9px] bg-surface-sunken text-fg-muted [&_svg]:size-4", className)}>
      <Icon />
    </span>
  );
}
