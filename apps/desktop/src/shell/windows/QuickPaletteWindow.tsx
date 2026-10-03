/**
 * Global quick palette window (#/palette, opened with ⌃⌥Space while the app is in the background;
 * spec §18). Placeholder: the real actions (yeni görev, onay ver, ajana git, çalışma alanı
 * değiştir) are routed to the main window once the native bridge lands.
 */
import { Bot, Inbox, ListPlus, Search, Shuffle } from "lucide-react";

import { Kbd } from "@/ui";

import { WindowSurface } from "./WindowSurface";

const upcoming = [
  { icon: ListPlus, title: "Yeni görev" },
  { icon: Inbox, title: "Onay ver" },
  { icon: Bot, title: "Ajana git" },
  { icon: Shuffle, title: "Çalışma alanı değiştir" },
];

export default function QuickPaletteWindow() {
  return (
    <WindowSurface className="rounded-xl">
      <div className="flex items-center gap-3 border-b border-line-subtle px-4">
        <Search className="size-4 shrink-0 text-fg-faint" aria-hidden />
        <input
          autoFocus
          placeholder="Ne yapmak istersiniz?"
          aria-label="Hızlı palet"
          className="h-12 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-faint focus-visible:shadow-none"
        />
        <Kbd keys={["Esc"]} />
      </div>
      <ul className="flex flex-col p-2">
        {upcoming.map(({ icon: Icon, title }) => (
          <li key={title} className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm text-fg-muted">
            <Icon className="size-4" strokeWidth={1.75} aria-hidden />
            {title}
            <span className="ml-auto text-2xs text-fg-faint">yakında</span>
          </li>
        ))}
      </ul>
    </WindowSurface>
  );
}
