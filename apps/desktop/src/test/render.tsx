/** Test helpers: render with the app's providers (query client, motion config, tooltips, router). */
/* eslint-disable react-refresh/only-export-components -- test utilities, never hot-reloaded */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { TooltipProvider } from "@/ui/Tooltip";

export function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
}

export function Providers({ children, client = testQueryClient() }: { children: ReactNode; client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <MotionConfig reducedMotion="always">
        <TooltipProvider>{children}</TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}

export function renderUI(ui: ReactElement, options?: RenderOptions & { client?: QueryClient }) {
  return render(ui, { wrapper: ({ children }) => <Providers client={options?.client}>{children}</Providers>, ...options });
}

/** Render inside a memory router (for components using links / navigation). */
export function renderWithRouter(ui: ReactElement, { path = "/", client }: { path?: string; client?: QueryClient } = {}) {
  const router = createMemoryRouter([{ path: "*", element: ui }], { initialEntries: [path] });
  const result = render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...result, router };
}
