from __future__ import annotations

from pathlib import Path

import pytest
from studio_helpers import StudioEnv, make_studio_env, sample_inputs

from aistudio.contracts.common import Environment
from aistudio.contracts.flows import (
    AgentNodeConfig,
    DeployNodeConfig,
    FlowGraph,
    FlowNode,
    GateKind,
    GateNodeConfig,
)
from aistudio.contracts.studios import Studio, StudioInput, StudioService
from aistudio.core.context import AppContext
from aistudio.core.errors import NotFound, ValidationFailed
from aistudio.core.events import EventFilter
from aistudio.studios.binding import bind_inputs
from aistudio.workspaces.service import WorkspaceCreate


def _custom_studio(studio_id: str = "ozel-akis", name: str = "Özel akış") -> Studio:
    return Studio(
        id=studio_id,
        name=name,
        description="Kullanıcı tanımlı",
        builtin=True,  # ignored on save
        inputs=[StudioInput(name="topic", label="Konu")],
        graph=FlowGraph(
            nodes=[
                FlowNode(
                    id="write",
                    label="Yaz",
                    config=AgentNodeConfig(prompt_template="Konu: {{ input.topic }}"),
                )
            ]
        ),
        output_template="{{ nodes.write.output }}",
    )


async def test_service_satisfies_protocol(studio_env: StudioEnv) -> None:
    svc: StudioService = studio_env.svc
    assert len(await svc.list()) == 8


async def test_save_creates_new_versions_and_keeps_builtin_v1(studio_env: StudioEnv) -> None:
    svc = studio_env.svc
    original = await svc.get("architecture")
    assert original.builtin and original.version == 1

    edited = original.model_copy(update={"name": "Mimari tasarım (ekip)"})
    v2 = await svc.save(edited, note="Ekip adı")
    assert v2.version == 2 and v2.builtin is False and v2.updated_at is not None
    v3 = await svc.save(v2.model_copy(update={"description": "Yeni açıklama"}))
    assert v3.version == 3

    latest = await svc.get("architecture")
    assert latest.version == 3 and latest.description == "Yeni açıklama"
    assert (await svc.get("architecture", version=2)).name == "Mimari tasarım (ekip)"
    v1 = await svc.get("architecture", version=1)
    assert v1.builtin and v1.name == "Mimari tasarım"

    versions = await svc.versions("architecture")
    assert [(v.version, v.builtin) for v in versions] == [(3, False), (2, False), (1, True)]
    assert versions[1].note == "Ekip adı"

    listed = {s.id: s for s in await svc.list()}
    assert listed["architecture"].version == 3
    assert len(listed) == 8

    saved_events = await studio_env.ctx.events.query(EventFilter(types=["studio.saved"]))
    assert [e.payload["version"] for e in saved_events] == [2, 3]

    with pytest.raises(NotFound) as exc:
        await svc.get("architecture", version=9)
    assert exc.value.message == "Stüdyonun bu sürümü bulunamadı."


async def test_custom_studio_versions_start_at_one(studio_env: StudioEnv) -> None:
    svc = studio_env.svc
    v1 = await svc.save(_custom_studio())
    assert v1.version == 1 and v1.builtin is False
    v2 = await svc.save(_custom_studio(name="Özel akış 2"))
    assert v2.version == 2
    studios = await svc.list()
    assert [s.id for s in studios][-1] == "ozel-akis" and studios[-1].version == 2
    assert [v.version for v in await svc.versions("ozel-akis")] == [2, 1]
    with pytest.raises(NotFound):
        await svc.get("yok")
    with pytest.raises(NotFound):
        await svc.versions("yok")


async def test_save_rejects_invalid_studio(studio_env: StudioEnv) -> None:
    bad = _custom_studio(studio_id="Geçersiz Kimlik")
    with pytest.raises(ValidationFailed) as exc:
        await studio_env.svc.save(bad)
    codes = {e["code"] for e in exc.value.details["errors"]}
    assert "bad_studio_id" in codes

    broken = _custom_studio()
    broken.graph.nodes[0] = FlowNode(
        id="write", label="Yaz", config=AgentNodeConfig(prompt_template="{{ nodes.yok.output }} {% if %}")
    )
    with pytest.raises(ValidationFailed) as exc:
        await studio_env.svc.save(broken)
    assert {e["code"] for e in exc.value.details["errors"]} == {"template_syntax"}
    assert await studio_env.svc.versions("architecture") != []  # nothing stored for the broken one
    with pytest.raises(NotFound):
        await studio_env.svc.get("ozel-akis")


async def test_instantiate_resolves_defaults_and_binds(studio_env: StudioEnv) -> None:
    graph = await studio_env.svc.instantiate(
        "database",
        workspace_id=studio_env.ws.id,
        inputs={**sample_inputs("database"), "change": "  Para birimi  ", "extra": "geçer"},
    )
    assert graph.inputs["change"] == "Para birimi"
    assert graph.inputs["dialect"] == "PostgreSQL"  # default
    assert graph.inputs["production_deploy_profile"] == ""  # optional, always defined
    assert graph.inputs["repo"] == studio_env.repo.id  # repo name normalized to id
    assert graph.inputs["extra"] == "geçer"  # undeclared keys pass through
    migrate = graph.node("migrate_test").config
    assert isinstance(migrate, DeployNodeConfig) and migrate.profile_id == "dp_test"
    schema = graph.node("schema").config
    assert isinstance(schema, AgentNodeConfig)
    assert schema.repo_ids == [studio_env.repo.id]
    assert "{{ input.change }}" in schema.prompt_template  # runtime template untouched

    # The stored template itself is unchanged.
    stored = await studio_env.svc.get("database")
    assert stored.graph.node("migrate_test").config.profile_id == "{{ input.test_deploy_profile }}"  # type: ignore[union-attr]


async def test_instantiate_validates_inputs(studio_env: StudioEnv) -> None:
    svc, wid = studio_env.svc, studio_env.ws.id
    with pytest.raises(ValidationFailed) as exc:
        await svc.instantiate("debugging", workspace_id=wid, inputs={"symptom": "  "})
    errors = exc.value.details["errors"]
    assert errors["symptom"] == "“Hata belirtisi” alanı zorunlu."
    assert errors["repo"] == "“Repo” alanı zorunlu."

    with pytest.raises(ValidationFailed) as exc:
        await svc.instantiate(
            "debugging", workspace_id=wid, inputs={**sample_inputs("debugging"), "environment": "Mars"}
        )
    assert exc.value.details["errors"]["environment"].startswith("Geçersiz seçim.")

    with pytest.raises(ValidationFailed) as exc:
        await svc.instantiate("code-review", workspace_id=wid, inputs={"target": "x", "repo": "baska-repo"})
    assert exc.value.details["errors"]["repo"] == "Bu çalışma alanında böyle bir repo yok."

    with pytest.raises(NotFound):
        await svc.instantiate("code-review", workspace_id="ws_yok", inputs=sample_inputs("code-review"))


async def test_database_studio_accepts_only_test_profile_for_migration(studio_env: StudioEnv) -> None:
    svc, wid = studio_env.svc, studio_env.ws.id
    base = sample_inputs("database")
    with pytest.raises(ValidationFailed) as exc:
        await svc.instantiate("database", workspace_id=wid, inputs={**base, "test_deploy_profile": "dp_prod"})
    assert "yalnız test ortamındaki" in exc.value.details["errors"]["test_deploy_profile"]

    with pytest.raises(ValidationFailed) as exc:
        await svc.instantiate("database", workspace_id=wid, inputs={**base, "production_deploy_profile": "dp_test"})
    assert "yalnız production ortamındaki" in exc.value.details["errors"]["production_deploy_profile"]

    graph = await svc.instantiate("database", workspace_id=wid, inputs={**base, "production_deploy_profile": "dp_prod"})
    prod = graph.node("prod_apply").config
    assert isinstance(prod, DeployNodeConfig) and prod.profile_id == "dp_prod"

    other_ws = await studio_env.workspaces.create(WorkspaceCreate(name="Diğer"))
    studio_env.deploy.add("dp_foreign", other_ws.id, Environment.test)
    with pytest.raises(ValidationFailed) as exc:
        await svc.instantiate("database", workspace_id=wid, inputs={**base, "test_deploy_profile": "dp_foreign"})
    assert exc.value.details["errors"]["test_deploy_profile"] == "Seçilen deploy profili bu çalışma alanına ait değil."


async def test_environment_checks_fail_closed_without_deploy_service(ctx: AppContext, git_repo: Path) -> None:
    env = await make_studio_env(ctx, git_repo, with_deploy=False)
    with pytest.raises(ValidationFailed) as exc:
        await env.svc.instantiate("database", workspace_id=env.ws.id, inputs=sample_inputs("database"))
    assert "doğrulanamadı" in exc.value.details["errors"]["test_deploy_profile"]


def test_binding_semantics() -> None:
    graph = FlowGraph(
        nodes=[
            FlowNode(
                id="a",
                label="A",
                config=AgentNodeConfig(
                    repo_ids=["{{ input.repo }}"],
                    profile_id="{{ input.profile }}",
                    prompt_template="{{ input.repo }} {{ nodes.x.output }}",
                ),
            ),
            FlowNode(
                id="g",
                label="G",
                config=GateNodeConfig(gate=GateKind.custom_command, command="make check ARGS='{{ input.args }}'"),
            ),
            FlowNode(id="d", label="D", config=DeployNodeConfig(profile_id="{{ input.dp }}")),
        ]
    )
    bound = bind_inputs(graph, {"repo": "", "profile": "", "args": "{{ 7*7 }}", "dp": ""})
    a = bound.node("a").config
    assert isinstance(a, AgentNodeConfig)
    assert a.repo_ids is None  # empty optional repo -> all repos
    assert a.profile_id is None
    assert a.prompt_template == "{{ input.repo }} {{ nodes.x.output }}"
    g = bound.node("g").config
    assert isinstance(g, GateNodeConfig)
    assert g.command == "make check ARGS='{{ 7*7 }}'"  # user input is substituted, never rendered
    d = bound.node("d").config
    assert isinstance(d, DeployNodeConfig) and d.profile_id == ""  # required field stays a string
    assert bound.inputs["args"] == "{{ 7*7 }}"
    assert graph.node("a").config.repo_ids == ["{{ input.repo }}"]  # type: ignore[union-attr]
