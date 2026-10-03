import { Pause, Send } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useId, useState } from "react";

import type { AgentRole, AgentState, Provider, Usage } from "@/lib/types";
import { variants } from "@/motion/tokens";
import { AgentCard, Button, IconButton, LogView, MarkdownView, stripAnsi } from "@/ui";

import { streamLines } from "../demo";
import { useDemoInterval, useGalleryStatic } from "../mode";

interface DemoAgent {
  id: string;
  provider: Provider;
  title: string;
  model: string;
  role: AgentRole;
  state: AgentState;
  lastLine: string;
  usage: Usage;
}

const agents: DemoAgent[] = [
  {
    id: "a1",
    provider: "claude",
    title: "Limit çubukları",
    model: "claude-opus-5-5",
    role: "writer",
    state: "running_tool",
    lastLine: "$ pnpm test --run src/ui/limits.test.ts",
    usage: { input_tokens: 48210, output_tokens: 6120, context_used: 84000, context_window: 200000 },
  },
  {
    id: "a2",
    provider: "codex",
    title: "review/limit-bars",
    model: "gpt-5.5-codex",
    role: "reviewer",
    state: "waiting_permission",
    lastLine: "apply_patch src/ui/LimitBar.tsx izni bekliyor",
    usage: { input_tokens: 21400, output_tokens: 1880, context_used: 172000, context_window: 192000 },
  },
  {
    id: "a3",
    provider: "claude",
    title: "Mimari kurul · danışman",
    model: "claude-sonnet-5",
    role: "advisor",
    state: "done",
    lastLine: "Karar belgesi hafızaya öneri olarak gönderildi.",
    usage: { input_tokens: 9300, output_tokens: 2400, context_used: 22000, context_window: 200000 },
  },
  {
    id: "a4",
    provider: "codex",
    title: "fix/flaky-test",
    model: "gpt-5.5-codex",
    role: "tester",
    state: "error",
    lastLine: "exit 1 · 3 test başarısız",
    usage: { input_tokens: 15020, output_tokens: 920, context_used: 140000, context_window: 192000 },
  },
];

export function AgentsSection() {
  const isStatic = useGalleryStatic();
  const groupId = useId();
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useDemoInterval(() => setTick((t) => t + 1), 1800);
  const selected = agents.find((a) => a.id === open);
  const live = streamLines[tick % streamLines.length] ?? "";

  return (
    <LayoutGroup id={groupId}>
      <div className="grid grid-cols-2 gap-4">
        {agents.map((a, i) => (
          <div key={a.id} className="min-h-[150px]">
            {open !== a.id && (
              <AgentCard
                layoutId={`${groupId}-${a.id}`}
                provider={a.provider}
                title={a.title}
                model={a.model}
                role={a.role}
                state={a.state}
                lastLine={i === 0 && !isStatic ? stripAnsi(live) : a.lastLine}
                usage={a.usage}
                onClick={() => setOpen(a.id)}
              />
            )}
          </div>
        ))}
      </div>
      <AnimatePresence>
        {selected && (
          <>
            <motion.div key="scrim" {...variants.overlay} className="fixed inset-0 z-(--z-overlay) bg-overlay" onClick={() => setOpen(null)} />
            <div key="detail" className="pointer-events-none fixed inset-0 z-(--z-overlay) grid place-items-center p-10">
              <AgentCard
                layoutId={`${groupId}-${selected.id}`}
                provider={selected.provider}
                title={selected.title}
                model={selected.model}
                role={selected.role}
                state={selected.state}
                lastLine={selected.lastLine}
                usage={selected.usage}
                expanded
                className="pointer-events-auto w-[560px] shadow-3"
                actions={
                  <>
                    <IconButton label="Duraklat" icon={<Pause />} size="sm" />
                    <IconButton label="Mesaj gönder" icon={<Send />} size="sm" />
                  </>
                }
              >
                <div className="flex flex-col gap-3">
                  <MarkdownView density="compact" source={"**Plan:** limit çubuklarını ekle, eşik renklerini uygula, testleri yaz.\n\n- `LimitBar` bileşeni\n- `limitTone` eşikleri"} />
                  <LogView lines={streamLines} className="h-40 rounded-md border border-line" />
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => setOpen(null)}>
                      Kapat
                    </Button>
                  </div>
                </div>
              </AgentCard>
            </div>
          </>
        )}
      </AnimatePresence>
    </LayoutGroup>
  );
}
