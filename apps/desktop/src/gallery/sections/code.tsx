import { Pause, Play, WrapText } from "lucide-react";
import { useState } from "react";

import { Button, CodeBlock, DiffView, IconButton, LogView, MarkdownView } from "@/ui";

import { diffModified, diffOriginal, sampleCode, sampleLog, sampleMarkdown, streamLines } from "../demo";
import { Block, Row } from "../kit";
import { useDemoInterval, useGalleryStatic } from "../mode";

export function CodeSection() {
  return (
    <div className="flex flex-col gap-6">
      <Block title="Kod bloğu">
        <CodeBlock code={sampleCode} language="ts" filename="src/features/tasks/useActiveTasks.ts" lineNumbers highlight={[7]} />
      </Block>
      <Block title="Diff">
        <DiffView original={diffOriginal} modified={diffModified} filename="src/ui/limits.ts" />
      </Block>
      <Block title="Markdown">
        <div className="rounded-lg border border-line bg-surface p-5">
          <MarkdownView source={sampleMarkdown} />
        </div>
      </Block>
    </div>
  );
}

export function LogSection() {
  const isStatic = useGalleryStatic();
  const [lines, setLines] = useState<string[]>(() => [...sampleLog]);
  const [running, setRunning] = useState(!isStatic);
  const [wrap, setWrap] = useState(false);
  useDemoInterval(
    () => setLines((l) => [...l, streamLines[l.length % streamLines.length] ?? ""].slice(-5000)),
    450,
    running,
  );
  return (
    <Block title="Canlı çıktı (sanallaştırılmış, ANSI, alta yapışık)">
      <Row>
        <Button size="sm" icon={running ? <Pause /> : <Play />} onClick={() => setRunning((r) => !r)}>
          {running ? "Durdur" : "Akışı başlat"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setLines((l) => [...l, ...Array.from({ length: 2000 }, (_, i) => `satır ${l.length + i + 1} · \x1b[2mtoplu ekleme\x1b[0m`)])}>
          +2000 satır
        </Button>
        <IconButton label="Satırları kaydır" icon={<WrapText />} active={wrap} onClick={() => setWrap((w) => !w)} />
        <span className="text-xs text-fg-muted tabular">{lines.length} satır</span>
      </Row>
      <LogView lines={lines} lineNumbers wrap={wrap} className="h-64 rounded-lg border border-line" aria-label="Demo çıktı" />
    </Block>
  );
}
