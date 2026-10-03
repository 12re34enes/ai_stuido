/**
 * Shared memory (spec §10) for the current workspace: documents by layer (view, edit with a commit
 * message, history, diff, restore), the agents' proposals inbox (edit-before-approve), the
 * boundaries map, the per-role agent context preview and the repo history.
 */
import { BookOpen, FilePen, FilePlus2, History, Inbox, ScrollText, ShieldHalf } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router";

import { useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, transition } from "@/motion/tokens";
import { EmptyState } from "@/ui";

import { useMemoryDocs, useMemoryLive, useProposals } from "./api";
import { MemoryNav } from "./components/MemoryNav";
import { NewDecisionDialog } from "./components/NewDecisionDialog";
import { docHref } from "./links";
import { BoundariesPage } from "./pages/BoundariesPage";
import { ContextPage } from "./pages/ContextPage";
import { DocPage } from "./pages/DocPage";
import { HistoryPage } from "./pages/HistoryPage";
import { ProposalsPage } from "./pages/ProposalsPage";
import { memoryStrings as s } from "./strings";
import { buildTree } from "./tree";

function contentKey(pathname: string): string {
  const rest = pathname.replace(/^\/memory\/?/, "");
  if (!rest) return "doc:facts.md";
  if (rest.startsWith("doc/")) return `doc:${rest.slice(4)}`;
  return rest.split("/")[0] ?? "doc:facts.md";
}

const contentVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { ...spring.smooth, opacity: transition.standard } },
  exit: { opacity: 0, transition: transition.exit },
};

function DocRoute({ ws }: { ws: string }) {
  const params = useParams();
  const path = (params["*"] ?? "").split("/").map(decodeURIComponent).join("/");
  return <DocPage ws={ws} path={path || "facts.md"} />;
}

function useMemoryCommands(groups: ReturnType<typeof buildTree>, openNewDecision: () => void) {
  const navigate = useNavigate();
  const commands = useMemo<StudioCommand[]>(() => {
    const list: StudioCommand[] = [
      { id: "memory.proposals", title: s.commandProposals, group: s.commandGroup, icon: Inbox, keywords: ["öneri", "proposal", "onay"], order: 0, run: () => void navigate("/memory/proposals") },
      { id: "memory.boundaries", title: s.commandBoundaries, group: s.commandGroup, icon: ShieldHalf, keywords: ["sınır", "boundaries", "izin"], order: 1, run: () => void navigate("/memory/boundaries") },
      { id: "memory.context", title: s.commandContext, group: s.commandGroup, icon: ScrollText, keywords: ["context", "sistem istemi", "prompt"], order: 2, run: () => void navigate("/memory/context") },
      { id: "memory.history", title: s.commandHistory, group: s.commandGroup, icon: History, keywords: ["git", "log", "geçmiş"], order: 3, run: () => void navigate("/memory/history") },
      { id: "memory.facts.edit", title: s.commandFacts, group: s.commandGroup, icon: FilePen, keywords: ["facts", "gerçekler"], order: 4, run: () => void navigate(docHref("facts.md", "edit")) },
      { id: "memory.decision.new", title: s.commandNewDecision, group: s.commandGroup, icon: FilePlus2, keywords: ["adr", "karar", "decision"], order: 5, run: openNewDecision },
    ];
    let order = 10;
    for (const g of groups) {
      for (const item of g.items) {
        if (item.guide) continue;
        list.push({
          id: `memory.open.${item.path}`,
          title: s.commandOpen(item.title),
          subtitle: item.path,
          group: s.commandGroup,
          icon: BookOpen,
          keywords: [item.path, g.label],
          order: order++,
          run: () => void navigate(docHref(item.path)),
        });
      }
    }
    return list;
  }, [groups, navigate, openNewDecision]);
  useRegisterCommands(commands);
}

function MemoryWorkspace({ ws, workspaceName }: { ws: string; workspaceName: string }) {
  useMemoryLive(ws);
  const location = useLocation();
  const docs = useMemoryDocs(ws);
  const proposals = useProposals(ws);
  const groups = useMemo(() => buildTree(docs.data ?? []), [docs.data]);
  const pending = (proposals.data ?? []).filter((p) => p.status === "pending").length;
  const [newDecision, setNewDecision] = useState(false);
  const openNewDecision = useMemo(() => () => setNewDecision(true), []);
  useMemoryCommands(groups, openNewDecision);

  return (
    <div className="absolute inset-0 flex">
      <MemoryNav workspaceName={workspaceName} groups={groups} loading={docs.isPending} pending={pending} onNewDecision={openNewDecision} />
      <div className="relative min-w-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={contentKey(location.pathname)} variants={contentVariants} initial="initial" animate="animate" exit="exit" className="absolute inset-0 overflow-y-auto overscroll-contain">
            <Routes location={location}>
              <Route index element={<DocPage ws={ws} path="facts.md" />} />
              <Route path="doc/*" element={<DocRoute ws={ws} />} />
              <Route path="proposals" element={<ProposalsPage ws={ws} />} />
              <Route path="boundaries" element={<BoundariesPage ws={ws} />} />
              <Route path="context" element={<ContextPage ws={ws} />} />
              <Route path="history" element={<HistoryPage ws={ws} />} />
            </Routes>
          </motion.div>
        </AnimatePresence>
      </div>
      <NewDecisionDialog ws={ws} open={newDecision} onOpenChange={setNewDecision} existing={(docs.data ?? []).map((d) => d.path)} />
    </div>
  );
}

export default function MemoryFeature() {
  const { workspace, query } = useCurrentWorkspace();
  if (!workspace) {
    return (
      <div className="absolute inset-0 grid place-items-center">
        {query.isPending ? null : <EmptyState icon={<BookOpen />} title={s.noWorkspace} description={s.noWorkspaceHint} />}
      </div>
    );
  }
  // Keyed by workspace: switching workspaces swaps the whole memory view.
  return <MemoryWorkspace key={workspace.id} ws={workspace.id} workspaceName={workspace.name} />;
}
