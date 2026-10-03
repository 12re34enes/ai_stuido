import { lazy, Suspense } from "react";
import { createHashRouter, RouterProvider } from "react-router";

import { features } from "@/app/routes";
import { Shell } from "@/shell/Shell";

const router = createHashRouter([
  {
    element: <Shell />,
    children: features.map((f) => {
      const Page = lazy(f.load);
      return {
        path: f.path,
        element: (
          <Suspense fallback={null}>
            <Page />
          </Suspense>
        ),
      };
    }),
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
