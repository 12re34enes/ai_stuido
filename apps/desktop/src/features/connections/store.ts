/** Which create/import dialog is open on the connections page (palette commands open them too). */
import { create } from "zustand";

export type ConnectionsDialog = "host.new" | "host.import" | "db.new" | "deploy.new" | "git.new";

interface ConnectionsUiState {
  dialog: ConnectionsDialog | null;
  /** Bumped on every open so forms remount with fresh state. */
  seq: number;
  open: (d: ConnectionsDialog) => void;
  close: () => void;
}

export const useConnectionsUi = create<ConnectionsUiState>()((set, get) => ({
  dialog: null,
  seq: 0,
  open: (dialog) => set({ dialog, seq: get().seq + 1 }),
  close: () => set({ dialog: null }),
}));
