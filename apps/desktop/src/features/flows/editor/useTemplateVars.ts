/**
 * Template-variable suggestions for one node, from the graph structure (upstream nodes first).
 * Subscribes to a structural key so dragging nodes doesn't recompute anything.
 */
import { useMemo } from "react";

import { buildTopology, upstream } from "../model/topology";
import { templateVariables, type TemplateVar } from "../model/templateVars";
import type { EdgeCondition, NodeKind } from "../types";
import { useEditorEnv } from "./context";
import { useEditor } from "./store";

const SEP = "\u0001";
const ROW = "\u0002";

export function useGraphStructure() {
  const nodeKey = useEditor((st) => st.nodes.map((n) => [n.id, n.data.label, n.data.config.kind].join(SEP)).join(ROW));
  const edgeKey = useEditor((st) => st.edges.map((e) => [e.id, e.source, e.target, e.data?.condition ?? "default"].join(SEP)).join(ROW));
  return useMemo(() => {
    const nodes = nodeKey
      ? nodeKey.split(ROW).map((row) => {
          const [id, label, kind] = row.split(SEP) as [string, string, NodeKind];
          return { id, label, kind };
        })
      : [];
    const edges = edgeKey
      ? edgeKey.split(ROW).map((row) => {
          const [id, source, target, condition] = row.split(SEP) as [string, string, string, EdgeCondition];
          return { id, source, target, condition };
        })
      : [];
    return { nodes, edges };
  }, [nodeKey, edgeKey]);
}

export function useTemplateVars(nodeId: string | null): { vars: TemplateVar[]; nodeIds: string[] } {
  const { nodes, edges } = useGraphStructure();
  const inputs = useEditor((st) => st.inputs);
  const { repos } = useEditorEnv();
  return useMemo(() => {
    const topo = buildTopology(
      nodes.map((n) => n.id),
      edges,
    );
    const up = nodeId ? upstream(topo, nodeId) : [];
    return {
      vars: templateVariables({ nodes, currentId: nodeId, upstream: up, inputs, repos }),
      nodeIds: nodes.map((n) => n.id),
    };
  }, [edges, inputs, nodeId, nodes, repos]);
}
