/** Test fixtures: the team from the spec (§25) — advisor, lead, 3 workers with 2 sub-agents each, testers. */
import { defaultMember, defaultSettings } from "../spec";
import type { Assignment, TeamMember, TeamRunView, TeamSpec } from "../../types";

export function member(role: TeamMember["role"], id: string, over: Partial<TeamMember> = {}): TeamMember {
  return defaultMember(role, id, { name: id, ...over });
}

export function exampleSpec(): TeamSpec {
  return {
    settings: defaultSettings(),
    members: [
      member("advisor", "advisor", { parent_id: "lead", name: "Danışman" }),
      member("lead", "lead", { name: "Lider" }),
      member("worker", "dev-a", { parent_id: "lead", name: "Arayüz" }),
      member("worker", "dev-a-1", { parent_id: "dev-a" }),
      member("worker", "dev-a-2", { parent_id: "dev-a" }),
      member("worker", "dev-b", { parent_id: "lead", name: "Sunucu", provider: "codex" }),
      member("worker", "dev-b-1", { parent_id: "dev-b", provider: "codex" }),
      member("worker", "dev-b-2", { parent_id: "dev-b", provider: "codex" }),
      member("worker", "dev-c", { parent_id: "lead", name: "Veri" }),
      member("worker", "dev-c-1", { parent_id: "dev-c" }),
      member("worker", "dev-c-2", { parent_id: "dev-c", provider: "codex" }),
      member("tester", "qa-b", { parent_id: "dev-b", tests_member_id: "dev-b", test_mode: "dependent", provider: "claude" }),
      member("tester", "qa-all", { parent_id: "lead", test_mode: "independent", provider: "codex" }),
    ],
  };
}

/** A `TeamRunDetail` of `exampleSpec` with nothing started yet. */
export function emptyRunView(over: Partial<TeamRunView> = {}): TeamRunView {
  return {
    run_id: "run_1",
    node_id: "team",
    spec: exampleSpec(),
    members: [],
    assignments: [],
    team_id: null,
    team_version: null,
    team_name: "",
    status: "running",
    summary: null,
    error: null,
    attempt: 1,
    active: true,
    ...over,
  };
}

/** An engine assignment (contract + extras) with defaults. */
export function assignmentRow(id: string, to: string, over: Partial<Assignment> = {}): Assignment {
  return {
    id,
    run_id: "run_1",
    node_id: "team",
    from_member: "lead",
    to_member: to,
    title: id,
    instructions: "",
    depends_on: [],
    status: "completed",
    round: 1,
    session_id: null,
    worktree_id: null,
    result_summary: null,
    error: null,
    merge: null,
    created_at: "2026-10-03T08:00:00Z",
    started_at: null,
    finished_at: null,
    seq: 0,
    kind: "work",
    parent_id: null,
    target_id: null,
    phase: "work",
    tests: [],
    delivered: false,
    ...over,
  };
}
