import { FileDiff, ScrollText } from "lucide-react";

import { openDrawer } from "@/lib/drawer";
import { DiffView, LogView, ProviderMark, Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui";

import { diffModified, diffOriginal, streamLines } from "./demo";

/** Opens the global drawer with live output + diff, as a feature would. */
export function openDemoDrawer() {
  openDrawer({
    id: "demo:live",
    title: "Canlı çıktı",
    subtitle: "Claude · Limit çubukları · aistudio/task-142/claude-1",
    icon: <ProviderMark provider="claude" size={16} />,
    content: (
      <Tabs defaultValue="out" className="h-full min-h-0">
        <TabsList className="shrink-0 px-4">
          <TabsTrigger value="out" icon={<ScrollText />}>
            Çıktı
          </TabsTrigger>
          <TabsTrigger value="diff" icon={<FileDiff />}>
            Diff
          </TabsTrigger>
        </TabsList>
        <TabsContent value="out" className="min-h-0 flex-1">
          <LogView lines={streamLines} lineNumbers className="h-full" />
        </TabsContent>
        <TabsContent value="diff" className="min-h-0 flex-1 overflow-auto p-4">
          <DiffView original={diffOriginal} modified={diffModified} filename="src/ui/limits.ts" />
        </TabsContent>
      </Tabs>
    ),
  });
}
