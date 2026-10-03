import "@xyflow/react/dist/base.css";

import { Background, MarkerType, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { ArrowRightLeft, Check, RotateCcw, StepForward, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/ui";
import { BatonEdge, FlowNodeCard, FlowStrip, GateMark, type BatonEdgeData, type FlowNodeCardProps, type FlowNodeStatus, type FlowStep, type GateStatus } from "@/ui/flow";

import { flowSteps } from "../demo";
import { Block, Row } from "../kit";
import { useDemoInterval, useGalleryStatic } from "../mode";

type CardNode = Node<Pick<FlowNodeCardProps, "kind" | "title" | "subtitle" | "provider" | "status">, "card">;

function CardNodeView({ data, selected }: NodeProps<CardNode>) {
  return <FlowNodeCard {...data} selected={selected} handles />;
}

const nodeTypes = { card: CardNodeView };
const edgeTypes = { baton: BatonEdge };

interface Stage {
  writer: FlowNodeStatus;
  gate: FlowNodeStatus;
  reviewer: FlowNodeStatus;
  handoff: boolean;
}

const START: Stage = { writer: "active", gate: "pending", reviewer: "pending", handoff: false };

function useCanvas(stage: Stage) {
  return useMemo(() => {
    const nodes: CardNode[] = [
      { id: "dev", type: "card", position: { x: 0, y: 0 }, data: { kind: "agent", title: "Geliştirici", subtitle: "src/ui/LimitBar.tsx", provider: "claude", status: stage.writer } },
      { id: "gate", type: "card", position: { x: 280, y: 0 }, data: { kind: "gate", title: "Build/test kanıtı", subtitle: "lint · typecheck · test · build", status: stage.gate } },
      { id: "rev", type: "card", position: { x: 560, y: 0 }, data: { kind: "agent", title: "review/limit-bars", subtitle: "Çapraz inceleme", provider: "codex", status: stage.reviewer } },
    ];
    const edge = (id: string, source: string, target: string, data: BatonEdgeData): Edge<BatonEdgeData, "baton"> => ({
      id,
      source,
      target,
      type: "baton",
      data,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--line-strong)" },
    });
    const edges = [
      edge("e2", "dev", "gate", { state: stage.gate === "pending" ? "idle" : stage.gate === "failed" ? "failed" : "done" }),
      edge("e3", "gate", "rev", { state: stage.handoff ? "active" : stage.reviewer === "pending" ? "idle" : "done", provider: "codex", label: stage.handoff ? "devrediliyor" : undefined }),
    ];
    return { nodes, edges };
  }, [stage]);
}

function advance(steps: FlowStep[]): FlowStep[] {
  const i = steps.findIndex((s) => s.status === "active");
  if (i === -1) return flowSteps.map((s, j) => ({ ...s, status: j === 0 ? "active" : "pending" }));
  return steps.map((s, j) => (j === i ? { ...s, status: "done" } : j === i + 1 ? { ...s, status: "active" } : s));
}

const gateStates: GateStatus[] = ["pending", "running", "passed", "failed", "skipped"];

export function FlowSection() {
  const isStatic = useGalleryStatic();
  const [stage, setStage] = useState<Stage>(isStatic ? { writer: "done", gate: "done", reviewer: "active", handoff: true } : START);
  const [steps, setSteps] = useState<FlowStep[]>(flowSteps);
  useDemoInterval(() => setSteps(advance), 2200);
  const { nodes, edges } = useCanvas(stage);

  return (
    <div className="flex flex-col gap-6">
      <Block title="Tuval: devretme izi, nefes alan düğüm, kapı">
        <div className="h-[200px] overflow-hidden rounded-lg border border-line bg-canvas-subtle">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
          >
            <Background gap={16} size={1} color="var(--line-strong)" />
          </ReactFlow>
        </div>
        <Row>
          <Button size="sm" icon={<Check />} onClick={() => setStage((s) => ({ ...s, writer: "done", gate: "done" }))}>
            Kapı geçti
          </Button>
          <Button size="sm" icon={<X />} onClick={() => setStage((s) => ({ ...s, writer: "done", gate: "failed" }))}>
            Kapı başarısız
          </Button>
          <Button size="sm" icon={<ArrowRightLeft />} onClick={() => setStage((s) => ({ ...s, gate: "done", writer: "done", reviewer: "active", handoff: true }))}>
            Devret
          </Button>
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => setStage(START)}>
            Sıfırla
          </Button>
        </Row>
      </Block>
      <Block title="Kapı işaretleri">
        <Row className="gap-5">
          {gateStates.map((g) => (
            <span key={g} className="flex items-center gap-2 text-xs text-fg-muted">
              <GateMark status={g} /> {g}
            </span>
          ))}
        </Row>
      </Block>
      <Block title="Akış şeridi (ana ekran)">
        <div className="flex flex-col gap-5 rounded-lg border border-line bg-surface p-4">
          <FlowStrip steps={steps} size="md" handoff aria-label="Görev 142" />
          <FlowStrip steps={flowSteps} aria-label="Görev 141" />
          <FlowStrip
            aria-label="Görev 140"
            steps={flowSteps.map((s, i) => ({ ...s, status: i < 3 ? "done" : i === 3 ? "failed" : "pending" }))}
          />
        </div>
        <Row>
          <Button size="sm" icon={<StepForward />} onClick={() => setSteps(advance)}>
            İlerlet
          </Button>
        </Row>
      </Block>
    </div>
  );
}
