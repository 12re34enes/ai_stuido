/** "Nereden başlayalım?": mode templates, studios and a blank canvas (new flows and "Şablondan başla"). */
import { motion } from "motion/react";
import { useMemo } from "react";

import { stagger } from "@/motion/tokens";
import { Skeleton } from "@/ui";

import { useModes, useStudios } from "../api";
import { BlankCard, ModeCard, StudioCard, type TemplatePick } from "../components/TemplateCards";
import { s } from "../strings";

export function TemplateChooser({ workspaceId, onPick, compact = false }: { workspaceId: string | null; onPick: (p: TemplatePick) => void; compact?: boolean }) {
  const modes = useModes();
  const studios = useStudios();
  const modeList = useMemo(() => (modes.data ?? []).filter((m) => m.mode !== "custom"), [modes.data]);
  const cols = compact ? "grid-cols-3" : "grid-cols-3 xl:grid-cols-4";
  return (
    <div className="flex flex-col gap-6" data-testid="template-chooser">
      <section className="flex flex-col gap-3">
        <h3 className="font-sans text-2xs font-medium tracking-wide text-fg-faint uppercase">{s.chooser.modes}</h3>
        {modes.isPending ? (
          <div className={`grid gap-3 ${cols}`}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={172} className="rounded-xl" />
            ))}
          </div>
        ) : (
          <motion.div className={`grid gap-3 ${cols}`} initial="initial" animate="animate" variants={stagger(0.04)}>
            <BlankCard onPick={onPick} />
            {modeList.map((m, i) => (
              <ModeCard key={m.mode} info={m} index={i} workspaceId={workspaceId} onPick={onPick} />
            ))}
          </motion.div>
        )}
        {modes.isError && <p className="text-sm text-danger">{s.modesError}</p>}
      </section>
      {(studios.data?.length ?? 0) > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="font-sans text-2xs font-medium tracking-wide text-fg-faint uppercase">{s.chooser.studios}</h3>
          <motion.div className={`grid gap-3 ${cols}`} initial="initial" animate="animate" variants={stagger(0.04, 0.1)}>
            {studios.data!.map((st, i) => (
              <StudioCard key={st.id} studio={st} index={i} onPick={onPick} />
            ))}
          </motion.div>
        </section>
      )}
    </div>
  );
}
