/**
 * Frontend mirrors of the memory API (backend/src/aistudio/memory/api.py, contracts/memory.py,
 * contracts/agents.py::Boundaries). Field names are identical.
 */
export type MemoryLayer = "facts" | "decisions" | "boundaries" | "sessions";

export interface MemoryDoc {
  path: string;
  layer: MemoryLayer;
  title: string;
  content: string;
  updated_at?: string | null;
}

export interface MemoryCommit {
  sha: string;
  short_sha: string;
  message: string;
  body?: string;
  author: string;
  /** "user", "agent:<session>", "external", "system". */
  actor?: string | null;
  committed_at: string;
  paths: string[];
}

export interface MemoryDiff {
  base: string;
  head: string;
  path?: string | null;
  diff: string;
  truncated: boolean;
}

export type ProposalStatus = "pending" | "applied" | "rejected";

export interface MemoryProposal {
  id: string;
  workspace_id: string;
  layer: MemoryLayer;
  path: string;
  old_content: string | null;
  new_content: string;
  diff: string;
  rationale?: string | null;
  source_session_id?: string | null;
  approval_id?: string | null;
  status: ProposalStatus;
  created_at: string;
  base_commit?: string | null;
  commit_sha?: string | null;
  edited?: boolean;
  note?: string | null;
  decided_at?: string | null;
}

export type SandboxLevel = "read_only" | "workspace_write" | "full";
export type RemoteAccess = "none" | "read" | "limited" | "full";

export interface Boundaries {
  forbidden_paths: string[];
  readonly_paths: string[];
  allowed_commands: string[];
  denied_commands: string[];
  network: boolean;
  sandbox: SandboxLevel;
  remote_access: RemoteAccess;
}

export type AgentRole = "writer" | "advisor" | "reviewer" | "planner" | "tester" | "judge" | "synthesizer";

export interface ContextResult {
  role: AgentRole;
  text: string;
  chars: number;
}

export interface WriteResult {
  commit: string;
  doc: MemoryDoc;
}
