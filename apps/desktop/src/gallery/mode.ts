import { createContext, useContext, useEffect, useRef } from "react";

/** `static` mode (#/__gallery?static=1) freezes auto-playing demos for screenshots. */
export const GalleryMode = createContext({ static: false });

export function useGalleryStatic(): boolean {
  return useContext(GalleryMode).static;
}

/** Run `fn` every `ms` while enabled (and not in static mode). */
export function useDemoInterval(fn: () => void, ms: number, enabled = true) {
  const isStatic = useGalleryStatic();
  const saved = useRef(fn);
  useEffect(() => {
    saved.current = fn;
  });
  useEffect(() => {
    if (!enabled || isStatic) return;
    const t = setInterval(() => saved.current(), ms);
    return () => clearInterval(t);
  }, [enabled, isStatic, ms]);
}
