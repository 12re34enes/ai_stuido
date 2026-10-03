/**
 * Sessions feature (`/sessions/*`): list + discovery tabs, the full session page and the
 * new-session dialog. Inner navigation drills in/out with the shared motion tokens.
 */
import { ChevronLeft, FolderSearch, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router";

import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { useActiveSessions } from "@/lib/queries";
import { Button, CountBadge, Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui";

import { DiscoverPanel } from "./DiscoverPanel";
import { HealthChips } from "./HealthChips";
import { backdrop, drill } from "./kit/motion";
import { PageColumn, PageHeader } from "./kit/Page";
import { NewSessionDialog } from "./NewSessionDialog";
import { SessionList } from "./SessionList";
import { SessionStream } from "./SessionStream";
import { sessionStrings as t } from "./strings";

type Tab = "sessions" | "discover";

function SessionsHome({ tab }: { tab: Tab }) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const active = useActiveSessions();
  const commands = useMemo<StudioCommand[]>(
    () => [
      {
        id: "sessions.new",
        title: "Yeni ajan oturumu",
        group: commandGroups.actions,
        icon: Plus,
        keywords: ["session", "oturum", "ajan", "başlat"],
        run: () => setCreating(true),
      },
      {
        id: "sessions.discover",
        title: "Mevcut oturumları keşfet",
        group: commandGroups.actions,
        icon: FolderSearch,
        keywords: ["discover", "import", "ekle", "claude", "codex"],
        run: () => void navigate("/sessions/discover"),
      },
    ],
    [navigate],
  );
  useRegisterCommands(commands);

  return (
    <PageColumn>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <>
            <HealthChips />
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t.newSession}
            </Button>
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => void navigate(v === "discover" ? "/sessions/discover" : "/sessions")}>
        <TabsList aria-label={t.title} className="mb-5">
          <TabsTrigger value="sessions" trailing={<CountBadge count={active.data?.length ?? 0} tone="neutral" aria-label={t.sections.active} />}>
            {t.tabs.sessions}
          </TabsTrigger>
          <TabsTrigger value="discover">{t.tabs.discover}</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions">
          <SessionList onNew={() => setCreating(true)} />
        </TabsContent>
        <TabsContent value="discover">
          <DiscoverPanel />
        </TabsContent>
      </Tabs>
      <NewSessionDialog open={creating} onOpenChange={setCreating} />
    </PageColumn>
  );
}

function SessionPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center px-3">
        <Button size="sm" variant="ghost" icon={<ChevronLeft />} onClick={() => void navigate("/sessions")}>
          {t.back}
        </Button>
      </div>
      <div className="min-h-0 flex-1 border-t border-line-subtle">
        <SessionStream sessionId={id} focusSubagent={params.get("subagent")} />
      </div>
    </div>
  );
}

export default function SessionsFeature() {
  const location = useLocation();
  const rest = location.pathname.replace(/^\/sessions\/?/, "");
  const detail = rest !== "" && rest !== "discover";
  return (
    <div className="relative h-full">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={detail ? `detail:${rest}` : "home"}
          variants={detail ? drill : backdrop}
          initial="initial"
          animate="animate"
          exit="exit"
          className={detail ? "absolute inset-0 overflow-hidden" : "absolute inset-0 overflow-y-auto overscroll-contain"}
        >
          <Routes location={location}>
            <Route index element={<SessionsHome tab="sessions" />} />
            <Route path="discover" element={<SessionsHome tab="discover" />} />
            <Route path=":id" element={<SessionPage />} />
          </Routes>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
