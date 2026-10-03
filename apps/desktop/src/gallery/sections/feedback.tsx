import { Bot, GitPullRequest, Minus, Plus, RefreshCw, Rocket, ShieldCheck, Shuffle, Sparkles } from "lucide-react";
import { useState } from "react";

import {
  AnimatedNumber,
  Button,
  CountBadge,
  EmptyState,
  IconButton,
  LimitBar,
  ProgressBar,
  Skeleton,
  SkeletonText,
  Spinner,
  StatusDot,
  Timeline,
  TimelineItem,
  toast,
  type DotStatus,
} from "@/ui";

import { hoursFromNow } from "../demo";
import { Block, Row } from "../kit";
import { useDemoInterval, useGalleryStatic } from "../mode";

const statuses: DotStatus[] = ["idle", "running", "waiting", "success", "error", "offline"];
const cycle: DotStatus[] = ["idle", "running", "running", "success", "idle", "running", "error"];

export function StatusSection() {
  const isStatic = useGalleryStatic();
  const [step, setStep] = useState(0);
  useDemoInterval(() => setStep((s) => (s + 1) % cycle.length), 1400);
  const current = isStatic ? "success" : (cycle[step] ?? "idle");
  return (
    <div className="flex flex-col gap-6">
      <Block title="Durum noktaları">
        <Row className="gap-6">
          {statuses.map((st) => (
            <span key={st} className="flex items-center gap-2 text-xs text-fg-muted">
              <StatusDot status={st} size={14} />
              {st}
            </span>
          ))}
        </Row>
        <Row className="gap-6">
          <span className="flex items-center gap-2 text-xs text-fg-muted">
            <StatusDot status="running" tone="claude" size={14} /> claude
          </span>
          <span className="flex items-center gap-2 text-xs text-fg-muted">
            <StatusDot status="running" tone="codex" size={14} /> codex
          </span>
          <span className="flex items-center gap-2 text-xs text-fg-muted">
            <StatusDot status="success" size={18} /> 18 px
          </span>
          <span className="flex items-center gap-2 text-xs text-fg-muted">
            <StatusDot status="error" size={10} /> 10 px
          </span>
        </Row>
      </Block>
      <Block title="Biçim değiştirme (döngü)">
        <Row className="gap-4">
          <StatusDot status={current} size={22} />
          <span className="w-20 font-mono text-xs text-fg-muted">{current}</span>
          {statuses.map((st) => (
            <Button key={st} size="sm" variant="ghost" onClick={() => setStep(Math.max(0, cycle.indexOf(st)))}>
              {st}
            </Button>
          ))}
        </Row>
      </Block>
    </div>
  );
}

export function MetersSection() {
  const isStatic = useGalleryStatic();
  const [fill, setFill] = useState(isStatic ? 64 : 18);
  const [count, setCount] = useState(3);
  const [num, setNum] = useState(12840);
  useDemoInterval(() => setFill((f) => (f >= 96 ? 12 : f + 13)), 1500);
  return (
    <div className="flex flex-col gap-6">
      <Block title="Limit çubukları (%70 amber, %90 kırmızı)">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <LimitBar label="5 saat" value={34} resetsAt={hoursFromNow(2.3)} />
          <LimitBar label="Haftalık" value={72} resetsAt={hoursFromNow(61)} />
          <LimitBar label="Haftalık (Opus)" value={94} resetsAt={hoursFromNow(30)} />
          <LimitBar label="5 saat" value={100} status="exhausted" resetsAt={hoursFromNow(0.4)} />
          <LimitBar label="Canlı dolum" value={fill} resetsAt={null} />
          <div className="flex flex-col justify-center gap-2">
            <span className="text-xs text-fg-muted">Üst çubuk (mini)</span>
            <div className="flex flex-col gap-[3px]">
              <LimitBar size="mini" value={fill} />
              <LimitBar size="mini" value={Math.min(100, fill + 22)} />
            </div>
          </div>
        </div>
      </Block>
      <Block title="İlerleme">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <ProgressBar value={fill} />
          <ProgressBar value={fill} tone="claude" size="md" />
          <ProgressBar value={80} tone="codex" size="xs" />
          <ProgressBar tone="accent" aria-label="Belirsiz" />
        </div>
        <Row className="gap-4 text-fg-muted">
          <Spinner size={12} />
          <Spinner size={16} />
          <Spinner size={20} className="text-accent" />
          <Spinner size={24} className="text-fg" />
        </Row>
      </Block>
      <Block title="Sayılar">
        <Row className="gap-6">
          <span className="font-serif text-2xl text-fg">
            <AnimatedNumber value={num} />
          </span>
          <IconButton label="Rastgele" icon={<Shuffle />} variant="secondary" onClick={() => setNum(Math.round(Math.random() * 99999))} />
          <span className="text-md text-fg">
            <AnimatedNumber value={fill} prefix="%" />
          </span>
          <span className="flex items-center gap-2">
            <IconButton label="Azalt" icon={<Minus />} size="sm" variant="secondary" onClick={() => setCount((c) => Math.max(0, c - 1))} />
            <span className="relative grid size-8 place-items-center rounded-md border border-line bg-surface text-fg-muted">
              <Bot className="size-4" />
              <CountBadge count={count} className="absolute -top-1.5 -right-1.5" />
            </span>
            <IconButton label="Artır" icon={<Plus />} size="sm" variant="secondary" onClick={() => setCount((c) => c + 1)} />
            <CountBadge count={128} tone="danger" />
            <CountBadge count={0} showZero tone="neutral" />
          </span>
        </Row>
      </Block>
      <Block title="İskelet ve boş durum">
        <div className="grid grid-cols-2 gap-6">
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center gap-3">
              <Skeleton circle width={28} height={28} />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton height={10} width="60%" />
                <Skeleton height={8} width="35%" />
              </div>
            </div>
            <SkeletonText lines={3} />
          </div>
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState
              size="sm"
              icon={<Sparkles />}
              title="Henüz görev yok"
              description="İlk görevini yaz, mod ve stüdyo seç."
              action={
                <Button size="sm" variant="primary">
                  Yeni görev
                </Button>
              }
            />
          </div>
        </div>
      </Block>
    </div>
  );
}

export function ToastsSection() {
  return (
    <Row>
      <Button size="sm" onClick={() => toast.success("Onay verildi", { description: "Plan onayı · Ödeme servisi" })}>
        Başarılı
      </Button>
      <Button size="sm" onClick={() => toast.info("Ajan devretti", { description: "Claude → Codex (inceleme)" })}>
        Bilgi
      </Button>
      <Button size="sm" onClick={() => toast.warning("Limit %80", { description: "Claude 5 saatlik pencere" })}>
        Uyarı
      </Button>
      <Button size="sm" onClick={() => toast.error("Deploy başarısız", { description: "production · sağlık kontrolü geçmedi" })}>
        Hata
      </Button>
      <Button
        size="sm"
        onClick={() =>
          toast({
            title: "Bağlantı koptu",
            description: "Uzak terminal oturumu kapandı.",
            tone: "danger",
            action: { label: "Yeniden bağlan", onClick: () => toast.success("Bağlandı") },
          })
        }
      >
        Eylemli
      </Button>
      <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={() => ["Görev oluşturuldu", "Hafıza önerisi", "PR açıldı"].forEach((t, i) => setTimeout(() => toast({ title: t }), i * 180))}>
        Yığın
      </Button>
    </Row>
  );
}

export function TimelineSection() {
  return (
    <Timeline className="max-w-md">
      <TimelineItem title="Plan onaylandı" time="14:02" status="success">
        Kullanıcı planı düzenleyip onayladı.
      </TimelineItem>
      <TimelineItem title="Build/test kanıtı" time="14:09" icon={<ShieldCheck className="text-success" />}>
        lint, typecheck, test ve build geçti (studiod çalıştırdı).
      </TimelineItem>
      <TimelineItem title="Codex inceliyor" time="14:11" status="running" current>
        2 bulgu, biri engelleyici.
      </TimelineItem>
      <TimelineItem title="PR açılacak" icon={<GitPullRequest className="text-fg-faint" />} />
      <TimelineItem title="Test ortamına deploy" icon={<Rocket className="text-fg-faint" />} connector={false} />
    </Timeline>
  );
}
