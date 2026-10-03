import { getBezierPath, type ConnectionLineComponentProps } from "@xyflow/react";

/** The line drawn while dragging a new connection: marching accent dashes, solid when it can land. */
export function ConnectionLine({ fromX, fromY, toX, toY, fromPosition, toPosition, connectionStatus }: ConnectionLineComponentProps) {
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: toX, targetY: toY, targetPosition: toPosition });
  const valid = connectionStatus === "valid";
  return (
    <g pointerEvents="none">
      <path
        d={path}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={valid ? 2 : 1.75}
        strokeLinecap="round"
        strokeDasharray={valid ? undefined : "4 6"}
        className={valid ? undefined : "animate-[studio-dash_0.9s_linear_infinite]"}
      />
      <circle cx={toX} cy={toY} r={valid ? 5 : 3.5} fill="var(--accent)" style={{ transition: "r 150ms var(--ease-out)" }} />
      {valid && <circle cx={toX} cy={toY} r={10} fill="var(--accent-soft)" opacity={0.8} />}
    </g>
  );
}
