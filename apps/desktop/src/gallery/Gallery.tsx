/**
 * Dev-only component gallery (#/__gallery): every component in its states, light and dark side by
 * side, with motion demos. `?static=1` freezes auto-playing demos for screenshots.
 */
import { ArrowLeft, Bell, PanelRight } from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import { useLocation, useNavigate } from "react-router";

import { useAppearance } from "@/lib/appearance";
import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { CommandPalette } from "@/shell/CommandPalette";
import { DrawerHost } from "@/shell/DrawerHost";
import { ProductionFrame } from "@/shell/ProductionFrame";
import { Button, cn, SegmentedControl, Switch, ThemeScope, toast, Toaster } from "@/ui";

import { openDemoDrawer } from "./actions";
import { GalleryMode } from "./mode";
import { AgentsSection } from "./sections/agents";
import { BadgesSection, ButtonsSection, FormsSection, FoundationsSection, PickersSection } from "./sections/basics";
import { CodeSection, LogSection } from "./sections/code";
import { MetersSection, StatusSection, TimelineSection, ToastsSection } from "./sections/feedback";
import { FlowSection } from "./sections/flow";
import { OverlaysSection, ShellSection } from "./sections/overlays";
import { SurfacesSection } from "./sections/surfaces";

interface SectionDef {
  id: string;
  title: string;
  description: string;
  Component: ComponentType;
}

const sections: SectionDef[] = [
  { id: "foundations", title: "Temeller", description: "Tipografi, renk belirteçleri, köşe ve derinlik ölçekleri.", Component: FoundationsSection },
  { id: "buttons", title: "Butonlar", description: "Türler, boyutlar, yükleniyor (dönüşen spinner) ve basma yayı.", Component: ButtonsSection },
  { id: "forms", title: "Form", description: "Alan, kendiliğinden büyüyen metin, seçim, anahtar, onay kutusu.", Component: FormsSection },
  { id: "pickers", title: "Seçiciler", description: "Kayan göstergeli segment kontrolü ve alt çizgili sekmeler.", Component: PickersSection },
  { id: "surfaces", title: "Yüzeyler", description: "Kart, ayırıcı ve macOS tarzı kaydırma alanı.", Component: SurfacesSection },
  { id: "badges", title: "Rozetler ve işaretler", description: "Rozet tonları, ortam etiketleri, sağlayıcı işaretleri, kısayollar.", Component: BadgesSection },
  { id: "status", title: "Durum", description: "Biçim değiştiren durum noktası: boşta → nabız → onay → hata.", Component: StatusSection },
  { id: "meters", title: "Göstergeler", description: "Limit çubukları, ilerleme, kayan rakamlar, sayaç, iskelet, boş durum.", Component: MetersSection },
  { id: "agents", title: "Ajan kartları", description: "Claude sıcak ve serif, Codex tek renkli ve keskin. Karta tıklayınca genişler.", Component: AgentsSection },
  { id: "overlays", title: "Katmanlar", description: "İpucu, açılır kart, menü, diyalog, sayfa ve sağ çekmece.", Component: OverlaysSection },
  { id: "toasts", title: "Bildirimler", description: "Yığılan, kaydırarak kapanan bildirimler.", Component: ToastsSection },
  { id: "code", title: "Kod", description: "Belirteç renkli kod bloğu, CodeMirror diff ve güvenli Markdown.", Component: CodeSection },
  { id: "log", title: "Canlı çıktı", description: "Sanallaştırılmış, ANSI renkli, alta yapışan günlük görünümü.", Component: LogSection },
  { id: "timeline", title: "Zaman çizelgesi", description: "Kademeli giren olay akışı.", Component: TimelineSection },
  { id: "flow", title: "Akış", description: "Devretme izi, nefes alan etkin düğüm, kapı geçti/başarısız ve akış şeridi.", Component: FlowSection },
  { id: "shell", title: "Kabuk", description: "Ortam bağlamı, production çerçevesi ve komut paleti.", Component: ShellSection },
];

type View = "both" | "light" | "dark";

function SectionRow({ section, view }: { section: SectionDef; view: View }) {
  const themes: ("light" | "dark")[] = view === "both" ? ["light", "dark"] : [view];
  return (
    <section id={section.id} data-section={section.id} className="flex scroll-mt-20 flex-col gap-4">
      <header className="flex items-baseline gap-3 px-1">
        <h2 className="text-lg text-fg">{section.title}</h2>
        <p className="text-sm text-fg-muted">{section.description}</p>
      </header>
      <div className={cn("grid gap-4", themes.length === 2 ? "grid-cols-2" : "grid-cols-1")}>
        {themes.map((t) => (
          <ThemeScope key={t} theme={t} className="min-w-0 rounded-xl border border-line p-6" >
            <div data-theme-column={t} className="min-w-0">
              <section.Component />
            </div>
          </ThemeScope>
        ))}
      </div>
    </section>
  );
}

export default function Gallery() {
  const navigate = useNavigate();
  const location = useLocation();
  const isStatic = new URLSearchParams(location.search).get("static") === "1";
  const [view, setView] = useState<View>("both");
  const reduceMotion = useAppearance((s) => s.reduceMotion);
  const setReduceMotion = useAppearance((s) => s.setReduceMotion);

  const commands = useMemo<StudioCommand[]>(
    () => [
      { id: "gallery.drawer", title: "Örnek çekmeceyi aç", group: commandGroups.developer, icon: PanelRight, run: openDemoDrawer },
      { id: "gallery.toast", title: "Örnek bildirim göster", group: commandGroups.developer, icon: Bell, run: () => void toast.success("Merhaba", { description: "Komut paletinden gönderildi." }) },
      { id: "gallery.back", title: "Uygulamaya dön", group: commandGroups.navigation, icon: ArrowLeft, run: () => void navigate("/") },
    ],
    [navigate],
  );
  useRegisterCommands(commands);

  return (
    <GalleryMode.Provider value={{ static: isStatic }}>
      <div className="h-full overflow-y-auto bg-canvas-subtle" data-testid="gallery">
        <header
          data-tauri-drag-region
          className="drag-region sticky top-0 z-(--z-topbar) flex h-14 items-center gap-4 border-b border-line bg-canvas/90 pr-6 pl-[calc(var(--traffic-lights-width)+8px)] backdrop-blur-xl"
        >
          <Button size="sm" variant="ghost" icon={<ArrowLeft />} className="no-drag" onClick={() => void navigate("/")}>
            Uygulama
          </Button>
          <div className="flex min-w-0 flex-col">
            <h1 className="text-md leading-5 text-fg">Bileşen galerisi</h1>
            <span className="text-2xs text-fg-muted">{isStatic ? "Statik mod — otomatik demolar durduruldu" : "Tüm bileşenler, tüm durumlar"}</span>
          </div>
          <div className="flex-1" data-tauri-drag-region />
          <div className="no-drag flex items-center gap-4">
            <Switch
              size="sm"
              label={<span className="text-xs">Hareketi azalt</span>}
              checked={reduceMotion === "on"}
              onCheckedChange={(on) => setReduceMotion(on ? "on" : "system")}
            />
            <SegmentedControl
              size="sm"
              aria-label="Tema"
              value={view}
              onValueChange={setView}
              options={[
                { value: "both", label: "Yan yana" },
                { value: "light", label: "Açık" },
                { value: "dark", label: "Koyu" },
              ]}
            />
          </div>
        </header>
        <nav aria-label="Bölümler" className="mx-auto flex max-w-[1600px] flex-wrap gap-1.5 px-6 pt-5">
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#/__gallery${isStatic ? "?static=1" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              {s.title}
            </a>
          ))}
        </nav>
        <main className="mx-auto flex max-w-[1600px] flex-col gap-12 px-6 pt-6 pb-24">
          {sections.map((s) => (
            <SectionRow key={s.id} section={s} view={view} />
          ))}
        </main>
      </div>
      <DrawerHost top="56px" />
      <CommandPalette />
      <Toaster />
      <ProductionFrame />
    </GalleryMode.Provider>
  );
}
