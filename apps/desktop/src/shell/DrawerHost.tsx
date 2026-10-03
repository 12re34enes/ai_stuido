import { useCallback } from "react";

import { useDrawer } from "@/lib/drawer";
import { Drawer } from "@/ui";

/**
 * Renders the global drawer from `useDrawer`. While closing, AnimatePresence keeps the last frame
 * for the exit animation; after that nothing of the entry stays mounted.
 */
export function DrawerHost({ top }: { top?: string }) {
  const entry = useDrawer((s) => s.entry);
  const width = useDrawer((s) => s.width);
  const setWidth = useDrawer((s) => s.setWidth);
  const closeDrawer = useDrawer((s) => s.closeDrawer);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeDrawer();
    },
    [closeDrawer],
  );

  return (
    <Drawer
      open={entry !== null}
      onOpenChange={onOpenChange}
      title={entry?.title ?? ""}
      subtitle={entry?.subtitle}
      icon={entry?.icon}
      actions={entry?.actions}
      contentKey={entry?.id}
      width={width}
      onWidthChange={setWidth}
      top={top}
    >
      {entry?.content}
    </Drawer>
  );
}
