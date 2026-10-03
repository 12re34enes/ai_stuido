import { FileText, MoreHorizontal } from "lucide-react";

import { Badge, Button, Card, CardFooter, CardHeader, Divider, IconButton, ScrollArea } from "@/ui";

import { Block } from "../kit";

const files = [
  "facts.md",
  "boundaries.md",
  "decisions/2026-09-12-sqlite-wal.md",
  "decisions/2026-09-20-worktree-per-agent.md",
  "decisions/2026-10-01-limit-esikleri.md",
  "sessions/2026-10-02-claude-limit-bars.md",
  "sessions/2026-10-02-codex-review.md",
  "sessions/2026-10-03-kurul-mimari.md",
  "sessions/2026-10-03-flaky-test.md",
];

export function SurfacesSection() {
  return (
    <div className="grid grid-cols-2 gap-6">
      <Block title="Kartlar">
        <Card>
          <CardHeader
            title="Ödeme servisi"
            description="3 repo · 2 etkin görev"
            actions={<IconButton label="Daha fazla" icon={<MoreHorizontal />} size="sm" />}
          />
          <CardFooter>
            <Button size="sm" variant="ghost">
              Ayarlar
            </Button>
            <Button size="sm" variant="primary">
              Aç
            </Button>
          </CardFooter>
        </Card>
        <Card interactive padding="sm" className="flex items-center gap-3">
          <FileText className="size-4 text-fg-muted" />
          <span className="flex-1 text-sm">Etkileşimli kart (üzerine gel)</span>
          <Badge tone="accent">Yeni</Badge>
        </Card>
      </Block>
      <Block title="Ayırıcı ve kaydırma alanı">
        <Divider label="Bugün" />
        <ScrollArea className="h-40 rounded-lg border border-line bg-surface">
          <ul className="flex flex-col py-1">
            {files.map((f) => (
              <li key={f} className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs text-fg-muted hover:bg-surface-hover">
                <FileText className="size-3.5 shrink-0" />
                <span className="truncate">{f}</span>
              </li>
            ))}
          </ul>
        </ScrollArea>
        <div className="flex h-5 items-center gap-3 text-xs text-fg-muted">
          <span>Sol</span>
          <Divider orientation="vertical" />
          <span>Sağ</span>
          <Divider orientation="vertical" subtle />
          <span>İnce</span>
        </div>
      </Block>
    </div>
  );
}
