/**
 * Remote terminal WebSocket protocol (backend `remote/terminal.py`), as a pure reducer.
 *
 * Client → server: {"type": "input", "data"} · {"type": "resize", "cols", "rows"}
 * Server → client: {"kind": "status", "state": "waiting_approval" | "connecting" | "open", "approval_id"?}
 *                  {"kind": "output", "data"} · {"kind": "exit", "code"} · {"kind": "error", "message", "code"}
 */

export type TerminalPhase = "connecting" | "waiting_approval" | "open" | "closed" | "error";

export interface TerminalState {
  phase: TerminalPhase;
  approvalId: string | null;
  exitCode: number | null;
  error: string | null;
  errorCode: string | null;
}

export type ServerMessage =
  | { kind: "status"; state: "waiting_approval" | "connecting" | "open"; approval_id?: string | null }
  | { kind: "output"; data: string }
  | { kind: "exit"; code: number | null }
  | { kind: "error"; message: string; code?: string | null };

export type TerminalAction = ServerMessage | { kind: "socket_closed"; message: string } | { kind: "reset" };

export const initialTerminalState: TerminalState = { phase: "connecting", approvalId: null, exitCode: null, error: null, errorCode: null };

export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    switch (m.kind) {
      case "status":
        return m.state === "waiting_approval" || m.state === "connecting" || m.state === "open"
          ? { kind: "status", state: m.state, approval_id: typeof m.approval_id === "string" ? m.approval_id : null }
          : null;
      case "output":
        return typeof m.data === "string" ? { kind: "output", data: m.data } : null;
      case "exit":
        return { kind: "exit", code: typeof m.code === "number" ? m.code : null };
      case "error":
        return { kind: "error", message: typeof m.message === "string" ? m.message : "Terminal hatası.", code: typeof m.code === "string" ? m.code : null };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function terminalReducer(state: TerminalState, action: TerminalAction): TerminalState {
  switch (action.kind) {
    case "reset":
      return initialTerminalState;
    case "status":
      return { ...state, phase: action.state, approvalId: action.approval_id ?? state.approvalId, error: null, errorCode: null };
    case "output":
      return state;
    case "exit":
      return { ...state, phase: "closed", exitCode: action.code };
    case "error":
      return { ...state, phase: "error", error: action.message, errorCode: action.code ?? null };
    case "socket_closed":
      // A close after exit/error keeps that outcome; otherwise the connection was lost.
      if (state.phase === "closed" || state.phase === "error") return state;
      return { ...state, phase: "error", error: action.message, errorCode: "socket_closed" };
  }
}

export const inputMessage = (data: string) => JSON.stringify({ type: "input", data });
export const resizeMessage = (cols: number, rows: number) => JSON.stringify({ type: "resize", cols, rows });
