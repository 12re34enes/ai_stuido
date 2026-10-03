/**
 * History feature (`/history/*`): event explorer, replay hub (+ session replay page), remote
 * audit log and agent performance. Tabs are routes; each tab manages its own scrolling so the
 * event and audit lists can virtualize inside the viewport.
 */
import { BarChart3, ChevronLeft, History, ScrollText, ServerCog } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router";

import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { variants } from "@/motion/tokens";
import { Button, Tabs, TabsList, TabsTrigger } from "@/ui";

import { SessionStream } from "../sessions/SessionStream";
import { backdrop, drill } from "../sessions/kit/motion";
import { PageColumn, PageHeader } from "../sessions/kit/Page";
import { AgentPerformance } from "./AgentPerformance";
import { EventExplorer } from "./EventExplorer";
import { RemoteAudit } from "./RemoteAudit";
import { ReplayHub } from "./ReplayHub";
import { historyStrings as t } from "./strings";

type Tab = "events" | "replay" | "audit" | "performance";
const PATHS: Record<Tab, string> = { events: "/history", replay: "/history/replay", audit: "/history/audit", performance: "/history/performance" };

function tabOf(pathname: string): Tab {
  const seg = pathname.split("/")[2];
  return seg === "replay" || seg === "audit" || seg === "performance" ? seg : "events";
}

function HistoryHome() {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = tabOf(location.pathname);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageColumn size="wide" className="shrink-0">
        <PageHeader title={t.title} description={t.description} />
        <Tabs value={tab} onValueChange={(v) => void navigate(PATHS[v as Tab])}>
          <TabsList aria-label={t.title} className="mb-4">
            <TabsTrigger value="events" icon={<ScrollText />}>
              {t.tabs.events}
            </TabsTrigger>
            <TabsTrigger value="replay" icon={<History />}>
              {t.tabs.replay}
            </TabsTrigger>
            <TabsTrigger value="audit" icon={<ServerCog />}>
              {t.tabs.audit}
            </TabsTrigger>
            <TabsTrigger value="performance" icon={<BarChart3 />}>
              {t.tabs.performance}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </PageColumn>
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={tab} {...variants.fadeUp} className="absolute inset-0" role="tabpanel" aria-label={t.tabs[tab]}>
            {tab === "events" ? <EventExplorer /> : tab === "replay" ? <ReplayHub /> : tab === "audit" ? <RemoteAudit /> : <AgentPerformance />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function SessionReplayPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center px-3">
        <Button size="sm" variant="ghost" icon={<ChevronLeft />} onClick={() => void navigate("/history/replay")}>
          {t.replay.back}
        </Button>
      </div>
      <div className="min-h-0 flex-1 border-t border-line-subtle">
        <SessionStream sessionId={id} replay interactive={false} />
      </div>
    </div>
  );
}

export default function HistoryFeature() {
  const location = useLocation();
  const navigate = useNavigate();
  const replayMatch = /^\/history\/replay\/([^/]+)/.exec(location.pathname);
  const commands = useMemo<StudioCommand[]>(
    () =>
      (Object.keys(PATHS) as Tab[]).map((k) => ({
        id: `history.${k}`,
        title: `Geçmiş: ${t.tabs[k]}`,
        group: commandGroups.navigation,
        keywords: ["history", "geçmiş", k],
        run: () => void navigate(PATHS[k]),
      })),
    [navigate],
  );
  useRegisterCommands(commands);
  return (
    <div className="relative h-full">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={replayMatch ? `replay:${replayMatch[1]}` : "home"}
          variants={replayMatch ? drill : backdrop}
          initial="initial"
          animate="animate"
          exit="exit"
          className="absolute inset-0 overflow-hidden"
        >
          <Routes location={location}>
            <Route path="replay/:id" element={<SessionReplayPage />} />
            <Route path="*" element={<HistoryHome />} />
          </Routes>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
