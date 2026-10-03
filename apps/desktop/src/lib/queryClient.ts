import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      // Don't retry client errors (4xx); retry network/5xx a few times.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 3,
    },
  },
});
