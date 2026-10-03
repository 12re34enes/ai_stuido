/**
 * The builder in a macOS-style sheet: customize a team for one task (composer) or one flow node
 * (inline team) without touching the template. "Uygula" hands the edited spec back; "Ekip olarak
 * kaydet" also stores it as a new team.
 */
import { ReactFlowProvider } from "@xyflow/react";
import { Check, Save } from "lucide-react";
import { useState } from "react";

import { useCurrentWorkspace } from "@/lib/workspace";
import { Button, Sheet, toast } from "@/ui";

import { errorText } from "../../flows/util";
import { reportFromSaveError, useCreateTeam, useProfiles } from "../api";
import { withPositions } from "../model/graph";
import { s } from "../strings";
import type { Team, TeamSpec } from "../types";
import { ValidationStatus } from "./parts";
import { BuilderStoreContext, createBuilderStore, useBuilder, useBuilderStore } from "./store";
import { TeamBuilder } from "./TeamBuilder";
import { useAutoValidate } from "./useAutoValidate";
import { useBuilderLayout } from "./useBuilderLayout";

export interface TeamBuilderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spec: TeamSpec;
  /** Name shown on "Ekip olarak kaydet" (e.g. the template's name). */
  name: string;
  title?: string;
  description?: string;
  applyLabel?: string;
  onApply: (spec: TeamSpec) => void;
  onSaved?: (team: Team) => void;
}

function SheetBody({ onCancel, onApply, onSaved, applyLabel, name }: { onCancel: () => void; onApply: (spec: TeamSpec) => void; onSaved?: (team: Team) => void; applyLabel: string; name: string }) {
  const store = useBuilderStore();
  const { workspace } = useCurrentWorkspace();
  const profiles = useProfiles(workspace?.id ?? null);
  const create = useCreateTeam();
  const layout = useBuilderLayout();
  const errors = useBuilder((st) => st.issues.errorCount);
  useAutoValidate(true);

  const saveAsTeam = async () => {
    try {
      const t = await create.mutateAsync({ workspace_id: workspace?.id ?? null, name: `${name}${s.copySuffix}`, description: "", spec: withPositions(store.getState().spec, layout) });
      toast.success(s.builder.createdToast, { description: t.name });
      onSaved?.(t);
    } catch (e) {
      const report = reportFromSaveError(e);
      if (report) store.getState().setReport(report, { explicit: true });
      toast.error(s.builder.saveFailed, { description: errorText(e) });
    }
  };

  return (
    <div className="flex h-[min(74vh,760px)] flex-col gap-3" data-testid="team-builder-sheet">
      <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-lg border border-line">
        <TeamBuilder profiles={profiles.data ?? []} scope="sheet" />
      </div>
      <div className="flex items-center gap-2">
        <ValidationStatus />
        <p className="min-w-0 flex-1 truncate text-xs text-fg-muted">{s.builder.applyHint}</p>
        <Button variant="ghost" onClick={onCancel}>
          {s.cancel}
        </Button>
        <Button variant="secondary" icon={<Save />} loading={create.isPending} onClick={() => void saveAsTeam()}>
          {s.builder.saveAsTeam}
        </Button>
        <Button variant="primary" icon={<Check />} disabled={errors > 0} onClick={() => onApply(withPositions(store.getState().spec, layout))} data-testid="team-sheet-apply">
          {applyLabel}
        </Button>
      </div>
    </div>
  );
}

export function TeamBuilderSheet({ open, onOpenChange, spec, name, title = s.builder.customizeTitle, description = s.builder.customizeDescription, applyLabel = s.builder.apply, onApply, onSaved }: TeamBuilderSheetProps) {
  // A fresh store per opening, seeded with the spec being customized.
  const [store, setStore] = useState(() => createBuilderStore({ spec, meta: { name } }));
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setStore(createBuilderStore({ spec, meta: { name } }));
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg" title={title} description={description} className="max-w-[min(1240px,94vw)]">
      <BuilderStoreContext.Provider value={store}>
        <ReactFlowProvider>
          <SheetBody
            name={name}
            applyLabel={applyLabel}
            onCancel={() => onOpenChange(false)}
            onSaved={onSaved}
            onApply={(next) => {
              onApply(next);
              onOpenChange(false);
            }}
          />
        </ReactFlowProvider>
      </BuilderStoreContext.Provider>
    </Sheet>
  );
}
