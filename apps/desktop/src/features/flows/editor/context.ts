/**
 * Data the canvas and inspector share that doesn't belong in the undoable editor store:
 * the workspace and the lookup tables from pickers (profiles, deploy profiles, repos).
 */
import { createContext, useContext } from "react";

import type { AgentProfile, DeployProfile, ModelConfig, NodeConfig, Provider, Repo } from "../types";

export interface EditorEnv {
  workspaceId: string | null;
  profiles: AgentProfile[];
  profilesById: Map<string, AgentProfile>;
  deployProfilesById: Map<string, DeployProfile>;
  repos: Repo[];
  /** Saved teams / templates (team nodes): name and member count by id. */
  teamsById?: Map<string, { name: string; members: number }>;
}

export const EMPTY_ENV: EditorEnv = { workspaceId: null, profiles: [], profilesById: new Map(), deployProfilesById: new Map(), repos: [], teamsById: new Map() };

export const EditorEnvContext = createContext<EditorEnv>(EMPTY_ENV);

export function useEditorEnv(): EditorEnv {
  return useContext(EditorEnvContext);
}

/** The provider a node runs on: explicit, else from its profile. */
export function resolveProvider(config: NodeConfig, profiles: Map<string, AgentProfile>): Provider | null {
  if (config.kind !== "agent" && config.kind !== "advisor" && config.kind !== "synthesis") return null;
  const c = config as ModelConfig;
  if (c.profile_id) return profiles.get(c.profile_id)?.provider ?? c.provider;
  return c.provider;
}
