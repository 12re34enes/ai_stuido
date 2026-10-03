/** The builder's tidy-tree layout of the current spec (all builder cards share one size). */
import { useMemo } from "react";

import { layoutTeam, type TeamLayout } from "../model/layout";
import { CARD_H, CARD_W } from "./MemberNode";
import { useBuilder } from "./store";

export const BUILDER_LAYOUT = { hGap: 32, satGap: 76, vGap: 76 };

/** fitView options that keep the chart clear of the floating tool row and the inspector. */
export function builderFit(inspectorOpen: boolean, duration = 0) {
  const right: `${number}px` = inspectorOpen ? "404px" : "40px";
  return { padding: { top: "68px", left: "40px", bottom: "64px", right } as const, duration, maxZoom: 1.05, minZoom: 0.3 };
}

export function useBuilderLayout(): TeamLayout {
  const spec = useBuilder((st) => st.spec);
  return useMemo(() => layoutTeam(spec, () => ({ w: CARD_W, h: CARD_H }), BUILDER_LAYOUT), [spec]);
}
