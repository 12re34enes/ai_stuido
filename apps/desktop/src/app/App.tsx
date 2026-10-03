import { lazy, Suspense } from "react";
import { createHashRouter, RouterProvider, type RouteObject } from "react-router";

import { features } from "@/app/routes";
import { RouteFallback } from "@/shell/RouteFallback";
import { Shell } from "@/shell/Shell";

const shellRoutes: RouteObject[] = features.map((f) => {
  const Page = lazy(f.load);
  return {
    path: f.path,
    element: (
      <Suspense fallback={<RouteFallback />}>
        <Page />
      </Suspense>
    ),
  };
});

// Small borderless native windows render OUTSIDE the shell (no sidebar / top bar).
const MenubarWindow = lazy(() => import("@/shell/windows/MenubarWindow"));
const QuickPaletteWindow = lazy(() => import("@/shell/windows/QuickPaletteWindow"));

const windowRoutes: RouteObject[] = [
  {
    path: "/menubar",
    element: (
      <Suspense fallback={null}>
        <MenubarWindow />
      </Suspense>
    ),
  },
  {
    path: "/palette",
    element: (
      <Suspense fallback={null}>
        <QuickPaletteWindow />
      </Suspense>
    ),
  },
];

// Dev-only component gallery (#/__gallery). Dead code in production builds.
const devRoutes: RouteObject[] = [];
if (import.meta.env.DEV) {
  const Gallery = lazy(() => import("@/gallery/Gallery"));
  devRoutes.push({
    path: "/__gallery",
    element: (
      <Suspense fallback={<RouteFallback />}>
        <Gallery />
      </Suspense>
    ),
  });
}

const router = createHashRouter([...windowRoutes, ...devRoutes, { element: <Shell />, children: shellRoutes }]);

export function App() {
  return <RouterProvider router={router} />;
}
