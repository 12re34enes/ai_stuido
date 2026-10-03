/**
 * Studios (spec §16): gallery, studio page (flow preview, team, gates, run form, results),
 * output reader, and the YAML editor with live validation and version history.
 *
 * Pages animate as whole surfaces inside this feature (the shell keeps the section still), so a
 * gallery card can morph into the studio page header through shared layout ids.
 */
import { FilePlus2, Pencil, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router";

import { useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { duration, ease, transition } from "@/motion/tokens";

import { useStudios, useStudiosLive } from "./api";
import { EditorPage } from "./pages/EditorPage";
import { GalleryPage } from "./pages/GalleryPage";
import { OutputPage } from "./pages/OutputPage";
import { StudioPage } from "./pages/StudioPage";
import { studioStrings as s } from "./strings";

/** One key per page: navigating between pages swaps surfaces; staying on a page keeps it. */
function studioPageKey(pathname: string): string {
  const parts = pathname.replace(/^\/studios\/?/, "").split("/").filter(Boolean);
  if (parts.length === 0) return "gallery";
  if (parts[0] === "_new") return "new";
  if (parts[1] === "edit") return `edit:${parts[0]}`;
  if (parts[1] === "outputs") return `output:${parts[0]}:${parts[2] ?? ""}`;
  return `studio:${parts[0]}`;
}

/**
 * Pages fade, except the gallery ⇄ studio pair: there the incoming page stays opaque so the card
 * that morphs into the header (shared layout ids) is visible in flight; its sections fade in.
 */
const pageVariants = {
  initial: { opacity: 0 },
  shared: { opacity: 1 },
  animate: { opacity: 1, transition: transition.standard },
  exit: { opacity: 0, transition: { duration: duration.exit, ease: ease.out } },
};

function sharesElements(key: string): boolean {
  return key === "gallery" || key.startsWith("studio:");
}

function StudioRoute() {
  const { studioId = "" } = useParams();
  return <StudioPage studioId={studioId} />;
}

function EditorRoute() {
  const { studioId = "" } = useParams();
  return <EditorPage studioId={studioId} />;
}

function OutputRoute() {
  const { studioId = "", taskId = "" } = useParams();
  return <OutputPage studioId={studioId} taskId={taskId} />;
}

function useStudioCommands(openNew: () => void) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: studios } = useStudios();
  const key = studioPageKey(location.pathname);
  const currentId = key.startsWith("studio:") ? key.slice("studio:".length) : null;
  const commands = useMemo<StudioCommand[]>(() => {
    const list: StudioCommand[] = [
      { id: "studios.new", title: s.commandNew, group: s.commandGroup, icon: FilePlus2, keywords: ["new studio", "şablon", "yeni"], order: 0, run: openNew },
    ];
    if (currentId) {
      list.push({
        id: "studios.edit",
        title: s.commandEdit,
        group: s.commandGroup,
        icon: Pencil,
        shortcut: "⌘E",
        keywords: ["yaml", "edit", "düzenle"],
        order: 1,
        run: () => void navigate(`/studios/${encodeURIComponent(currentId)}/edit`),
      });
    }
    (studios ?? []).forEach((st, i) =>
      list.push({
        id: `studios.open.${st.id}`,
        title: s.commandOpen(st.name),
        subtitle: st.id,
        group: s.commandGroup,
        icon: Sparkles,
        keywords: [st.id, "studio", "stüdyo"],
        order: 10 + i,
        run: () => void navigate(`/studios/${encodeURIComponent(st.id)}`),
      }),
    );
    return list;
  }, [currentId, navigate, openNew, studios]);
  useRegisterCommands(commands);
}

export default function StudiosFeature() {
  useStudiosLive();
  const location = useLocation();
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = useState(false);
  // Previous page key, derived during render: the gallery needs to know which card to fly back to.
  const pageKey = studioPageKey(location.pathname);
  const [keys, setKeys] = useState<{ current: string; previous: string | null }>({ current: pageKey, previous: null });
  if (keys.current !== pageKey) setKeys({ current: pageKey, previous: keys.current });
  const returningFrom = keys.previous?.startsWith("studio:") ? keys.previous.slice("studio:".length) : null;
  const openNew = useMemo(
    () => () => {
      if (studioPageKey(location.pathname) !== "gallery") void navigate("/studios");
      setNewOpen(true);
    },
    [location.pathname, navigate],
  );
  useStudioCommands(openNew);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={studioPageKey(location.pathname)}
          variants={pageVariants}
          initial={sharesElements(studioPageKey(location.pathname)) ? "shared" : "initial"}
          animate="animate"
          exit="exit"
          className="absolute inset-0"
        >
          <Routes location={location}>
            <Route index element={<GalleryPage newOpen={newOpen} onNewOpenChange={setNewOpen} returningFrom={returningFrom} />} />
            <Route path="_new" element={<EditorPage />} />
            <Route path=":studioId" element={<StudioRoute />} />
            <Route path=":studioId/edit" element={<EditorRoute />} />
            <Route path=":studioId/outputs/:taskId" element={<OutputRoute />} />
          </Routes>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
