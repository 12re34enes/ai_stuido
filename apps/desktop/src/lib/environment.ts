/**
 * Active environment context (spec §12 "Ortam etiketi"): local / test / production.
 *
 * Contexts stack: a page showing a production host pushes a context; when it unmounts the
 * previous one is active again. Whatever is on top drives the top-bar EnvBadge and, for
 * production, the red window frame. Default is local.
 *
 *   useEnvironmentScope("production", "db-prod-1");      // inside a component
 *   const pop = pushEnvironment({ environment: "test" }); // imperative
 */
import { useEffect, useId } from "react";
import { create } from "zustand";

import type { Environment } from "./types";

export interface EnvironmentContext {
  id: string;
  environment: Environment;
  /** What the context is about: host, database or deploy target name. */
  label?: string;
}

const LOCAL: EnvironmentContext = { id: "local", environment: "local" };

interface EnvironmentState {
  stack: EnvironmentContext[];
  push: (ctx: EnvironmentContext) => void;
  remove: (id: string) => void;
  reset: () => void;
}

export const useEnvironment = create<EnvironmentState>()((set) => ({
  stack: [],
  push: (ctx) => set((s) => ({ stack: [...s.stack.filter((c) => c.id !== ctx.id), ctx] })),
  remove: (id) => set((s) => ({ stack: s.stack.filter((c) => c.id !== id) })),
  reset: () => set({ stack: [] }),
}));

const selectActive = (s: EnvironmentState) => s.stack[s.stack.length - 1] ?? LOCAL;

/** The context on top of the stack (local when none). */
export function useActiveEnvironment(): EnvironmentContext {
  return useEnvironment(selectActive);
}

export function activeEnvironment(): EnvironmentContext {
  return selectActive(useEnvironment.getState());
}

let seq = 0;

/** Push a context imperatively; returns a function that removes it. */
export function pushEnvironment(ctx: Omit<EnvironmentContext, "id"> & { id?: string }): () => void {
  const id = ctx.id ?? `env-${++seq}`;
  useEnvironment.getState().push({ ...ctx, id });
  return () => useEnvironment.getState().remove(id);
}

/** Keep an environment context active while the calling component is mounted. */
export function useEnvironmentScope(environment: Environment | null | undefined, label?: string): void {
  const id = useId();
  useEffect(() => {
    if (!environment) return;
    useEnvironment.getState().push({ id, environment, label });
    return () => useEnvironment.getState().remove(id);
  }, [environment, id, label]);
}
