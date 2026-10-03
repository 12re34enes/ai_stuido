import { Copy, GitBranch, Info, MoreHorizontal, Pencil, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";

import { useActiveEnvironment, useEnvironment } from "@/lib/environment";
import { useShell } from "@/lib/shell";
import {
  Button,
  Dialog,
  EnvBadge,
  Field,
  HoverCard,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Popover,
  ProviderMark,
  Sheet,
  StatusDot,
  Tooltip,
} from "@/ui";

import { openDemoDrawer } from "../actions";
import { Block, Row } from "../kit";

export function OverlaysSection() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <Block title="Yerinde açılanlar">
        <Row>
          <Tooltip content="Ayarları aç" shortcut="⌘,">
            <Button icon={<Info />}>İpucu</Button>
          </Tooltip>
          <Popover
            align="start"
            className="w-72 p-4"
            trigger={<Button icon={<GitBranch />}>Açılır kart</Button>}
          >
            {(close) => (
              <div className="flex flex-col gap-3">
                <span className="text-sm font-medium">Branch adı</span>
                <Input size="sm" defaultValue="aistudio/task-142" autoFocus />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={close}>
                    Vazgeç
                  </Button>
                  <Button size="sm" variant="primary" onClick={close}>
                    Kaydet
                  </Button>
                </div>
              </div>
            )}
          </Popover>
          <HoverCard
            className="w-64 p-3"
            trigger={
              <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-fg-muted hover:bg-surface-hover">
                <StatusDot status="running" tone="claude" /> Üzerine gel
              </button>
            }
          >
            <div className="flex items-center gap-2.5">
              <ProviderMark provider="claude" variant="tile" size={24} />
              <div className="flex flex-col">
                <span className="font-serif text-sm">Limit çubukları</span>
                <span className="text-2xs text-fg-muted">Araç çalıştırıyor · claude-opus-5-5</span>
              </div>
            </div>
          </HoverCard>
          <Menu trigger={<IconButton label="Daha fazla" icon={<MoreHorizontal />} variant="secondary" tooltip={false} />}>
            <MenuLabel>Görev</MenuLabel>
            <MenuItem icon={<Pencil />} shortcut="⌘E">
              Düzenle
            </MenuItem>
            <MenuItem icon={<Copy />} shortcut="⌘D">
              Çoğalt
            </MenuItem>
            <MenuItem icon={<Settings2 />} trailing="3">
              Kapılar
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} tone="danger">
              Sil
            </MenuItem>
          </Menu>
        </Row>
      </Block>
      <Block title="Pencereler ve çekmece">
        <Row>
          <Button onClick={() => setDialog(true)}>Diyalog</Button>
          <Button onClick={() => setSheet(true)}>Sayfa (sheet)</Button>
          <Button variant="primary" onClick={openDemoDrawer}>
            Çekmeceyi aç
          </Button>
        </Row>
      </Block>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Worktree silinsin mi?"
        description="aistudio/task-142/claude-1 ve içindeki kaydedilmemiş değişiklikler silinir."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Vazgeç
            </Button>
            <Button variant="danger" onClick={() => setDialog(false)}>
              Sil
            </Button>
          </>
        }
      />
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        size="md"
        title="Yeni host"
        description="SSH bağlantısı; anahtar Anahtar Zinciri'nde saklanır."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheet(false)}>
              Vazgeç
            </Button>
            <Button variant="primary" onClick={() => setSheet(false)}>
              Ekle
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Ad" htmlFor="sheet-name">
            <Input id="sheet-name" placeholder="db-test-1" />
          </Field>
          <Field label="Adres" htmlFor="sheet-host">
            <Input id="sheet-host" placeholder="10.0.0.12" />
          </Field>
        </div>
      </Sheet>
    </div>
  );
}

export function ShellSection() {
  const env = useActiveEnvironment();
  const push = useEnvironment((s) => s.push);
  const remove = useEnvironment((s) => s.remove);
  const openPalette = useShell((s) => s.setPaletteOpen);
  return (
    <div className="flex flex-col gap-6">
      <Block title="Ortam bağlamı">
        <Row>
          <EnvBadge environment={env.environment} label={env.label} size="md" />
          <Button size="sm" onClick={() => push({ id: "gallery", environment: "test", label: "staging-2" })}>
            Test
          </Button>
          <Button size="sm" variant="danger" onClick={() => push({ id: "gallery", environment: "production", label: "db-prod-1" })}>
            Production çerçevesi
          </Button>
          <Button size="sm" variant="ghost" onClick={() => remove("gallery")}>
            Yerel
          </Button>
        </Row>
      </Block>
      <Block title="Komut paleti">
        <Row>
          <Button onClick={() => openPalette(true)}>Paleti aç</Button>
          <span className="text-xs text-fg-muted">⌘K da çalışır</span>
        </Row>
      </Block>
    </div>
  );
}
