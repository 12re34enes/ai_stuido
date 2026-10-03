"""Run.node_states: current status per node, not the history of attempts."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from aistudio.contracts.engine import NodeRun
from aistudio.engine.service import latest_node_states

T0 = datetime(2026, 10, 3, 12, 0, tzinfo=UTC)


def nr(node_id: str, status: str, attempt: int, minute: int) -> NodeRun:
    return NodeRun(
        id=f"nr_{node_id}_{attempt}",
        run_id="run_1",
        node_id=node_id,
        status=status,  # type: ignore[arg-type]
        attempt=attempt,
        started_at=T0 + timedelta(minutes=minute),
    )


def test_latest_attempt_wins_after_a_loop() -> None:
    history = [
        nr("dev", "passed", 1, 0),
        nr("build", "passed", 1, 1),
        nr("review", "failed", 1, 2),  # review fails -> loops back to dev
        nr("dev", "running", 2, 3),
    ]
    states = latest_node_states(history)
    assert states == {"dev": "running", "build": "passed", "review": "failed"}


def test_same_attempt_prefers_latest_start() -> None:
    states = latest_node_states([nr("gate", "failed", 1, 0), nr("gate", "passed", 1, 5)])
    assert states == {"gate": "passed"}


def test_empty_history() -> None:
    assert latest_node_states([]) == {}
