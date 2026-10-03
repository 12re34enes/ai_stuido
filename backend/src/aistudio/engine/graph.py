"""Graph topology: entry node, forward/back edges, regions and canvas layout.

Semantics used by the executor and the validator:

* A **loop edge** has condition ``failed`` / ``false`` / ``rejected``. Loop edges are the only
  edges allowed to close a cycle; the ones that do are **back edges** (found with a DFS from
  the entry that explores non-loop edges first). Everything else is a **forward edge** and the
  forward edges form a DAG.
* The **entry** is the single node whose incoming edges (if any) are all back edges.
* A node fires when all its incoming forward edges are resolved (live or dead) and at least
  one is live (implicit join-all), or immediately when a back edge delivers to it.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from aistudio.contracts.flows import (
    AdvisorNodeConfig,
    AgentNodeConfig,
    CompareNodeConfig,
    FlowEdge,
    FlowGraph,
    FlowNode,
    Position,
)

LOOP_CONDITIONS: frozenset[str] = frozenset({"failed", "false", "rejected"})
PASS_CONDITIONS: frozenset[str] = frozenset({"default", "passed", "approved"})
FAIL_CONDITIONS: frozenset[str] = frozenset({"failed", "rejected"})

COLUMN_WIDTH = 280.0
ROW_HEIGHT = 170.0
ORIGIN_X = 80.0
CENTER_Y = 240.0


@dataclass
class Topology:
    graph: FlowGraph
    nodes: dict[str, FlowNode] = field(default_factory=dict)
    outgoing: dict[str, list[FlowEdge]] = field(default_factory=dict)
    incoming: dict[str, list[FlowEdge]] = field(default_factory=dict)
    edges: dict[str, FlowEdge] = field(default_factory=dict)
    entry: str | None = None
    entry_candidates: list[str] = field(default_factory=list)
    back_edges: set[str] = field(default_factory=set)
    reachable: set[str] = field(default_factory=set)

    @classmethod
    def build(cls, graph: FlowGraph) -> Topology:
        topo = cls(graph=graph)
        for n in graph.nodes:
            topo.nodes.setdefault(n.id, n)
            topo.outgoing.setdefault(n.id, [])
            topo.incoming.setdefault(n.id, [])
        for e in graph.edges:
            if e.source not in topo.nodes or e.target not in topo.nodes:
                continue
            topo.edges.setdefault(e.id, e)
            topo.outgoing[e.source].append(e)
            topo.incoming[e.target].append(e)
        topo._find_entry()
        if topo.entry is not None:
            topo._classify()
        return topo

    # ------------------------------------------------------------------ analysis
    def _reach_all(self, start: str) -> set[str]:
        seen = {start}
        stack = [start]
        while stack:
            cur = stack.pop()
            for e in self.outgoing.get(cur, []):
                if e.target not in seen:
                    seen.add(e.target)
                    stack.append(e.target)
        return seen

    def _find_entry(self) -> None:
        candidates: list[str] = []
        for nid in self.nodes:
            inc = self.incoming[nid]
            if any(e.condition not in LOOP_CONDITIONS for e in inc):
                continue
            if not inc:
                candidates.append(nid)
                continue
            reach = self._reach_all(nid)
            if all(e.source in reach for e in inc):
                candidates.append(nid)
        self.entry_candidates = candidates
        self.entry = candidates[0] if len(candidates) == 1 else None

    def _classify(self) -> None:
        assert self.entry is not None
        white, gray, black = 0, 1, 2
        color = dict.fromkeys(self.nodes, white)

        def ordered(nid: str) -> list[FlowEdge]:
            out = self.outgoing[nid]
            return [e for e in out if e.condition not in LOOP_CONDITIONS] + [
                e for e in out if e.condition in LOOP_CONDITIONS
            ]

        color[self.entry] = gray
        stack: list[tuple[str, Iterator[FlowEdge]]] = [(self.entry, iter(ordered(self.entry)))]
        while stack:
            nid, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                color[nid] = black
                stack.pop()
                continue
            t = nxt.target
            if color[t] == gray:
                self.back_edges.add(nxt.id)
            elif color[t] == white:
                color[t] = gray
                stack.append((t, iter(ordered(t))))
        self.reachable = {n for n, c in color.items() if c != white}

    # ------------------------------------------------------------------ queries
    def is_back(self, edge: FlowEdge | str) -> bool:
        eid = edge if isinstance(edge, str) else edge.id
        return eid in self.back_edges

    def forward_in(self, nid: str) -> list[FlowEdge]:
        return [e for e in self.incoming.get(nid, []) if e.id not in self.back_edges]

    def forward_out(self, nid: str) -> list[FlowEdge]:
        return [e for e in self.outgoing.get(nid, []) if e.id not in self.back_edges]

    def back_in(self, nid: str) -> list[FlowEdge]:
        return [e for e in self.incoming.get(nid, []) if e.id in self.back_edges]

    def descendants(self, nid: str) -> set[str]:
        """Nodes reachable from ``nid`` over forward edges (excluding ``nid``)."""
        seen: set[str] = set()
        stack = [nid]
        while stack:
            cur = stack.pop()
            for e in self.forward_out(cur):
                if e.target not in seen:
                    seen.add(e.target)
                    stack.append(e.target)
        seen.discard(nid)
        return seen

    def ancestors(self, nid: str) -> set[str]:
        seen: set[str] = set()
        stack = [nid]
        while stack:
            cur = stack.pop()
            for e in self.forward_in(cur):
                if e.source not in seen:
                    seen.add(e.source)
                    stack.append(e.source)
        seen.discard(nid)
        return seen

    def between(self, start: str, end: str) -> set[str]:
        """Nodes on forward paths from ``start`` to ``end`` (inclusive)."""
        down = self.descendants(start) | {start}
        up = self.ancestors(end) | {end}
        return down & up

    def sinks(self) -> list[str]:
        return [n for n in self.nodes if n in self.reachable and not self.forward_out(n)]

    def upstream(self, nid: str) -> Iterator[str]:
        """Forward ancestors in BFS order (nearest first)."""
        seen = {nid}
        queue: deque[str] = deque([nid])
        while queue:
            cur = queue.popleft()
            for e in self.forward_in(cur):
                if e.source not in seen:
                    seen.add(e.source)
                    yield e.source
                    queue.append(e.source)

    def layers(self) -> dict[str, int]:
        """Longest-path layer of each node over forward edges (unreachable nodes go last)."""
        order = self.topological_order()
        layer: dict[str, int] = {}
        for nid in order:
            preds = [layer[e.source] for e in self.forward_in(nid) if e.source in layer]
            layer[nid] = (max(preds) + 1) if preds else 0
        top = max(layer.values(), default=-1)
        for nid in self.nodes:
            if nid not in layer:
                top += 1
                layer[nid] = top
        return layer

    def topological_order(self) -> list[str]:
        indeg = {n: 0 for n in self.nodes}
        for n in self.nodes:
            for e in self.forward_out(n):
                indeg[e.target] += 1
        queue: deque[str] = deque(n for n in self.nodes if indeg[n] == 0)
        out: list[str] = []
        while queue:
            cur = queue.popleft()
            out.append(cur)
            for e in self.forward_out(cur):
                indeg[e.target] -= 1
                if indeg[e.target] == 0:
                    queue.append(e.target)
        return out


def is_writer(node: FlowNode) -> bool:
    """Nodes whose result is a set of worktrees (a writing agent, or a race winner)."""
    cfg = node.config
    return (isinstance(cfg, AgentNodeConfig) and cfg.writes) or isinstance(cfg, CompareNodeConfig)


def is_opinion(node: FlowNode) -> bool:
    """Nodes whose text output is an opinion a synthesis can use."""
    return isinstance(node.config, AdvisorNodeConfig | AgentNodeConfig)


def nearest_writer(topo: Topology, node_id: str) -> str | None:
    for up in topo.upstream(node_id):
        if is_writer(topo.nodes[up]):
            return up
    return None


def upstream_branch_heads(topo: Topology, node_id: str, predicate: Callable[[FlowNode], bool]) -> list[str]:
    """For each incoming branch, the nearest node matching ``predicate`` (walks through
    parallel/join and other non-matching nodes). Used by compare and synthesis."""
    found: list[str] = []
    seen = {node_id}
    stack = [e.source for e in topo.forward_in(node_id)]
    while stack:
        cur = stack.pop(0)
        if cur in seen:
            continue
        seen.add(cur)
        if predicate(topo.nodes[cur]):
            found.append(cur)
            continue
        stack.extend(e.source for e in topo.forward_in(cur))
    return found


def auto_layout(graph: FlowGraph, *, only_missing: bool = False) -> FlowGraph:
    """Assign canvas positions: one column per layer, nodes of a layer centred vertically."""
    topo = Topology.build(graph)
    layers = topo.layers()
    by_layer: dict[int, list[str]] = {}
    for n in graph.nodes:
        by_layer.setdefault(layers.get(n.id, 0), []).append(n.id)
    positions: dict[str, Position] = {}
    for layer, ids in by_layer.items():
        count = len(ids)
        for i, nid in enumerate(ids):
            positions[nid] = Position(
                x=ORIGIN_X + COLUMN_WIDTH * layer,
                y=CENTER_Y + (i - (count - 1) / 2) * ROW_HEIGHT,
            )
    nodes = [
        n if (only_missing and n.position is not None) else n.model_copy(update={"position": positions[n.id]})
        for n in graph.nodes
    ]
    return graph.model_copy(update={"nodes": nodes})
