import { ArrowRight, Bell, Check, Command, GitBranch, Play, Plus, Search, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  Badge,
  Button,
  Checkbox,
  EnvBadge,
  Field,
  IconButton,
  Input,
  Kbd,
  ProviderMark,
  SegmentedControl,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  type BadgeTone,
} from "@/ui";

import { modeOptions } from "../demo";
import { Block, Row } from "../kit";

const swatches = [
  ["canvas", "bg-canvas"],
  ["canvas-subtle", "bg-canvas-subtle"],
  ["surface", "bg-surface"],
  ["surface-sunken", "bg-surface-sunken"],
  ["line", "bg-line"],
  ["line-strong", "bg-line-strong"],
  ["fg", "bg-fg"],
  ["fg-muted", "bg-fg-muted"],
  ["fg-faint", "bg-fg-faint"],
  ["accent", "bg-accent"],
  ["accent-soft", "bg-accent-soft"],
  ["success", "bg-success"],
  ["warning", "bg-warning"],
  ["danger", "bg-danger"],
  ["info", "bg-info"],
  ["claude", "bg-claude"],
  ["claude-surface", "bg-claude-surface"],
  ["codex", "bg-codex"],
  ["codex-surface", "bg-codex-surface"],
  ["env-test", "bg-env-test"],
  ["env-production", "bg-env-production"],
] as const;

export function FoundationsSection() {
  return (
    <div className="flex flex-col gap-8">
      <Block title="Tipografi">
        <div className="flex flex-col gap-2">
          <span className="font-serif text-2xl">Görevler akıyor</span>
          <span className="font-serif text-xl">Akış tuvali ve kapılar</span>
          <span className="font-serif text-lg">Ajan kartı başlığı</span>
          <span className="text-base text-fg">Gövde 14 — Kanıtsız iş tamamlanmış sayılmaz.</span>
          <span className="text-sm text-fg">Arayüz 13 — çalışma alanı, ortam etiketi, limit çubukları, onay sayacı.</span>
          <span className="text-xs text-fg-muted">Yardımcı 12 — 3 dk önce güncellendi · CLI olayı</span>
          <span className="text-2xs tracking-wide text-fg-faint uppercase">Etiket 11 — İğdır, Işık, Şişli</span>
          <code className="font-mono text-xs text-fg">pnpm test --run · ~/projects/ödeme-servisi</code>
        </div>
      </Block>
      <Block title="Renk belirteçleri">
        <div className="grid grid-cols-7 gap-2">
          {swatches.map(([name, cls]) => (
            <div key={name} className="flex flex-col gap-1">
              <span className={`h-9 rounded-md border border-line ${cls}`} />
              <span className="truncate font-mono text-2xs text-fg-muted">{name}</span>
            </div>
          ))}
        </div>
      </Block>
      <Block title="Köşe ve derinlik">
        <Row className="gap-4">
          {(["rounded-xs", "rounded-sm", "rounded-md", "rounded-lg", "rounded-xl"] as const).map((r) => (
            <span key={r} className={`grid size-14 place-items-center border border-line bg-surface font-mono text-2xs text-fg-muted ${r}`}>
              {r.replace("rounded-", "")}
            </span>
          ))}
          {(["shadow-1", "shadow-2", "shadow-3"] as const).map((sh) => (
            <span key={sh} className={`grid size-14 place-items-center rounded-lg bg-surface font-mono text-2xs text-fg-muted ${sh}`}>
              {sh.replace("shadow-", "s")}
            </span>
          ))}
        </Row>
      </Block>
    </div>
  );
}

export function ButtonsSection() {
  const [loading, setLoading] = useState(false);
  const trigger = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 1600);
  };
  return (
    <div className="flex flex-col gap-6">
      <Block title="Türler">
        <Row>
          <Button variant="primary" icon={<Play />}>
            Görevi başlat
          </Button>
          <Button variant="secondary" icon={<GitBranch />}>
            Branch seç
          </Button>
          <Button variant="ghost">Vazgeç</Button>
          <Button variant="danger" icon={<Trash2 />}>
            Sil
          </Button>
        </Row>
      </Block>
      <Block title="Boyutlar">
        <Row>
          <Button size="sm" variant="primary">
            Küçük
          </Button>
          <Button size="md" variant="primary">
            Orta
          </Button>
          <Button size="lg" variant="primary" iconRight={<ArrowRight />}>
            Büyük
          </Button>
          <Button size="sm">Küçük</Button>
          <Button>Orta</Button>
          <Button size="lg">Büyük</Button>
        </Row>
      </Block>
      <Block title="Yükleniyor ve devre dışı">
        <Row>
          <Button variant="primary" icon={<Check />} loading={loading} onClick={trigger}>
            Onayla
          </Button>
          <Button variant="secondary" loading={loading} onClick={trigger}>
            Kaydet
          </Button>
          <Button variant="primary" loading>
            Gönderiliyor
          </Button>
          <Button variant="primary" disabled>
            Devre dışı
          </Button>
          <Button disabled icon={<Settings2 />}>
            Devre dışı
          </Button>
        </Row>
      </Block>
      <Block title="İkon butonlar">
        <Row>
          <IconButton label="Ara" shortcut="⌘K" icon={<Search />} />
          <IconButton label="Bildirimler" icon={<Bell />} variant="secondary" />
          <IconButton label="Yeni" icon={<Plus />} variant="primary" />
          <IconButton label="Sil" icon={<Trash2 />} variant="danger" />
          <IconButton label="Komutlar" icon={<Command />} active />
          <IconButton label="Küçük" icon={<Plus />} size="sm" />
          <IconButton label="Çok küçük" icon={<Plus />} size="xs" />
          <IconButton label="Yükleniyor" icon={<Plus />} loading />
        </Row>
      </Block>
    </div>
  );
}

export function FormsSection() {
  const [prompt, setPrompt] = useState("Limit çubuklarını üst çubuğa ekle; renk %70 ve %90'da değişsin.\nTestleri de yaz.");
  const [repo, setRepo] = useState<string | undefined>("web");
  const [on, setOn] = useState(true);
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5">
      <Field label="Çalışma alanı adı" htmlFor="g-name" hint="Kısa ve ayırt edici olsun.">
        <Input id="g-name" placeholder="ör. Ödeme servisi" />
      </Field>
      <Field label="Ara" htmlFor="g-search">
        <Input id="g-search" icon={<Search />} placeholder="Görev, ajan, dosya…" trailing={<Kbd shortcut="⌘K" />} />
      </Field>
      <Field label="Host" htmlFor="g-host" error="Bu host'a bağlanılamadı.">
        <Input id="g-host" defaultValue="db-prod-1.internal" invalid />
      </Field>
      <Field label="Repo" htmlFor="g-repo">
        <Select
          id="g-repo"
          value={repo}
          onValueChange={setRepo}
          options={[
            { value: "web", label: "web", description: "~/src/web · main", icon: <GitBranch /> },
            { value: "api", label: "api", description: "~/src/api · develop", icon: <GitBranch /> },
            { value: "infra", label: "infra", description: "~/src/infra · main", icon: <GitBranch /> },
          ]}
        />
      </Field>
      <Field label="Görev" htmlFor="g-prompt" className="col-span-2" hint="Satır ekledikçe büyür (en fazla 6 satır).">
        <Textarea id="g-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} minRows={2} maxRows={6} />
      </Field>
      <div className="flex flex-col gap-3">
        <Switch label="Çapraz inceleme" description="İnceleyen farklı sağlayıcıdan olur." checked={on} onCheckedChange={setOn} />
        <Switch label="Production onayları kanaldan" description="Kilitli" disabled />
        <Row>
          <Switch aria-label="Küçük" size="sm" defaultChecked />
          <Switch aria-label="Kapalı" />
        </Row>
      </div>
      <div className="flex flex-col gap-3">
        <Checkbox label="Build/test kanıtı" description="studiod lint, test ve build çalıştırır." defaultChecked />
        <Checkbox label="Sınır denetimi" defaultChecked="indeterminate" />
        <Checkbox label="Kullanıcı son onayı" />
        <Checkbox label="Devre dışı" disabled />
      </div>
    </div>
  );
}

export function PickersSection() {
  const [mode, setMode] = useState("ikili");
  const [view, setView] = useState("unified");
  return (
    <div className="flex flex-col gap-6">
      <Block title="Mod seçici">
        <SegmentedControl aria-label="Mod" value={mode} onValueChange={setMode} options={modeOptions} />
        <SegmentedControl
          aria-label="Görünüm"
          size="sm"
          value={view}
          onValueChange={setView}
          options={[
            { value: "unified", label: "Birleşik" },
            { value: "split", label: "Yan yana" },
          ]}
        />
      </Block>
      <Block title="Sekmeler">
        <Tabs defaultValue="output">
          <TabsList aria-label="Ajan">
            <TabsTrigger value="output">Canlı çıktı</TabsTrigger>
            <TabsTrigger value="diff" trailing={<Badge size="sm">3</Badge>}>
              Diff
            </TabsTrigger>
            <TabsTrigger value="memory">Hafıza</TabsTrigger>
            <TabsTrigger value="disabled" disabled>
              Tekrar oynatma
            </TabsTrigger>
          </TabsList>
          <TabsContent value="output" className="pt-3 text-sm text-fg-muted">
            Ajanın canlı çıktısı burada akar.
          </TabsContent>
          <TabsContent value="diff" className="pt-3 text-sm text-fg-muted">
            Üç dosyada değişiklik var.
          </TabsContent>
          <TabsContent value="memory" className="pt-3 text-sm text-fg-muted">
            Bir hafıza önerisi bekliyor.
          </TabsContent>
        </Tabs>
      </Block>
    </div>
  );
}

const tones: BadgeTone[] = ["neutral", "accent", "success", "warning", "danger", "info", "claude", "codex"];

export function BadgesSection() {
  return (
    <div className="flex flex-col gap-6">
      <Block title="Rozetler">
        {(["soft", "solid", "outline"] as const).map((variant) => (
          <Row key={variant} className="gap-2">
            {tones.map((t) => (
              <Badge key={t} tone={t} variant={variant} dot={variant !== "solid"}>
                {t}
              </Badge>
            ))}
          </Row>
        ))}
      </Block>
      <Block title="Ortam etiketleri">
        <Row>
          <EnvBadge environment="local" />
          <EnvBadge environment="test" />
          <EnvBadge environment="production" />
          <EnvBadge environment="test" label="staging-2" size="md" />
          <EnvBadge environment="production" label="db-prod-1" size="md" />
        </Row>
      </Block>
      <Block title="Sağlayıcı işaretleri">
        <Row className="gap-4">
          <ProviderMark provider="claude" size={20} />
          <ProviderMark provider="codex" size={20} />
          <ProviderMark provider="claude" variant="tile" size={28} />
          <ProviderMark provider="codex" variant="tile" size={28} />
          <ProviderMark provider="claude" variant="tile" size={18} />
          <ProviderMark provider="codex" variant="tile" size={18} />
          <span className="text-fg-muted">
            <ProviderMark provider="claude" variant="mono" size={18} />
          </span>
          <span className="text-fg-muted">
            <ProviderMark provider="codex" variant="mono" size={18} />
          </span>
        </Row>
      </Block>
      <Block title="Kısayollar">
        <Row>
          <Kbd shortcut="⌘K" />
          <Kbd shortcut="⌘⇧P" />
          <Kbd shortcut="⌃⌘S" />
          <Kbd shortcut="⌘," />
          <Kbd keys={["Esc"]} />
          <Kbd keys={["↑", "↓"]} />
        </Row>
      </Block>
    </div>
  );
}
