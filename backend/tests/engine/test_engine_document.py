"""GET /engine/tasks/{id}/document: studio output_template rendered server-side."""

from __future__ import annotations

from typing import Any

from engine_support import EngineEnv, writes

from aistudio.contracts.approvals import ApprovalKind
from aistudio.contracts.flows import FlowMode
from aistudio.contracts.studios import Studio


async def _finish(env: EngineEnv, **create: Any) -> str:
    env.agents.on(writes(env, "README.md", reply="README güncellendi; testler geçti."), node_id="dev")
    task = await env.create(FlowMode.single, **create)
    run_id = await env.run_of(task.id)
    await env.next_approval(ApprovalKind.final)
    await env.decide(ApprovalKind.final)
    await env.wait_run(run_id)
    return task.id


async def test_document_falls_back_to_last_output(env: EngineEnv) -> None:
    task_id = await _finish(env)
    doc = await env.engine.task_document(task_id)
    assert doc.source == "last_output"
    assert "README güncellendi" in doc.markdown


async def test_document_renders_studio_template(env: EngineEnv) -> None:
    graph = await env.engine.graph_for_mode(FlowMode.single, workspace_id=env.workspace.id)
    studio = Studio(
        id="doc",
        name="Dokümantasyon",
        description="Belge üretir",
        graph=graph,
        output_template="# {{ task.title }}\n\n{{ nodes.dev.output }}\n\nİstek: {{ input.prompt }}",
    )
    env.studios.graphs["doc"] = graph

    async def get(studio_id: str, version: int | None = None) -> Studio:
        return studio

    env.studios.get = get  # type: ignore[method-assign]
    task_id = await _finish(env, studio_id="doc")
    doc = await env.engine.task_document(task_id)
    assert doc.source == "template", doc
    assert doc.markdown.startswith("# Kurulum belgesi")
    assert "README güncellendi" in doc.markdown and "İstek: README'ye kurulum" in doc.markdown


async def test_broken_template_falls_back_with_warning(env: EngineEnv) -> None:
    graph = await env.engine.graph_for_mode(FlowMode.single, workspace_id=env.workspace.id)
    studio = Studio(id="bad", name="Bozuk", description="x", graph=graph, output_template="{% for %}")
    env.studios.graphs["bad"] = graph

    async def get(studio_id: str, version: int | None = None) -> Studio:
        return studio

    env.studios.get = get  # type: ignore[method-assign]
    task_id = await _finish(env, studio_id="bad")
    doc = await env.engine.task_document(task_id)
    assert doc.source == "last_output" and doc.warning and "Şablon" in doc.warning


async def test_template_sees_gate_evidence_and_workspace(env: EngineEnv) -> None:
    from aistudio.core.clock import utcnow
    from aistudio.core.ids import new_id
    from aistudio.engine.models import Evidence

    graph = await env.engine.graph_for_mode(FlowMode.single, workspace_id=env.workspace.id)
    studio = Studio(
        id="ev",
        name="Kanıtlı",
        description="Kapı kanıtı içerir",
        graph=graph,
        output_template="# {{ workspace.name }}\n\n{% if nodes.nope %}\n\n\n{% endif %}{{ gate.tests.evidence }}",
    )
    env.studios.graphs["ev"] = graph

    async def get(studio_id: str, version: int | None = None) -> Studio:
        return studio

    env.studios.get = get  # type: ignore[method-assign]
    task_id = await _finish(env, studio_id="ev")
    task = await env.engine.get_task(task_id)
    assert task.current_run_id
    await env.engine.store.insert_evidence(
        Evidence(
            id=new_id("ev"),
            task_id=task_id,
            run_id=task.current_run_id,
            node_id="tests",
            source="gate",
            kind="command",
            title="pytest",
            content="3 passed",
            created_at=utcnow(),
        )
    )
    doc = await env.engine.task_document(task_id)
    assert doc.source == "template", doc
    assert doc.markdown == "# Deneme Alanı\n\n**pytest**\n\n```\n3 passed\n```\n"


async def test_empty_rendered_template_falls_back(env: EngineEnv) -> None:
    graph = await env.engine.graph_for_mode(FlowMode.single, workspace_id=env.workspace.id)
    studio = Studio(
        id="hollow", name="Boş", description="x", graph=graph, output_template="## \n\n{{ nodes.nope.output }}\n---"
    )
    env.studios.graphs["hollow"] = graph

    async def get(studio_id: str, version: int | None = None) -> Studio:
        return studio

    env.studios.get = get  # type: ignore[method-assign]
    task_id = await _finish(env, studio_id="hollow")
    doc = await env.engine.task_document(task_id)
    assert doc.source == "last_output" and "README güncellendi" in doc.markdown
