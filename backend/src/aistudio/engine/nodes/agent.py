"""``agent`` (writes code in its own worktrees) and ``advisor`` (read-only opinion) nodes."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aistudio.contracts.agents import StartSessionRequest
from aistudio.contracts.common import Provider
from aistudio.contracts.flows import AdvisorNodeConfig, AgentNodeConfig, GateKind, GateNodeConfig
from aistudio.contracts.gitops import Worktree
from aistudio.contracts.workspaces import Repo
from aistudio.engine.graph import nearest_writer
from aistudio.engine.nodes.base import NodeContext, NodeFailure, NodeOutcome, ResolvedAgent
from aistudio.engine.structured import (
    format_instructions,
    parse_structured,
    retry_instructions,
    strip_json_block,
)

PROVIDER_LABEL: dict[str, str] = {"claude": "Claude", "codex": "Codex"}


def workspace_dir(nctx: NodeContext) -> str:
    path = nctx.rt.ctx.settings.paths.workspace_dir(nctx.ex.workspace.slug)
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def read_only_location(nctx: NodeContext, repos: list[Repo]) -> tuple[str, list[str]]:
    local = [r for r in repos if r.host_id is None and Path(r.path).is_dir()]
    if local:
        return local[0].path, [r.path for r in local[1:]]
    return workspace_dir(nctx), []


async def _reviewer_provider_for(nctx: NodeContext) -> Provider | None:
    """Provider of a fixed reviewer profile that will review this node (switching the author to it
    would break the cross-review rule)."""
    topo = nctx.ex.topo
    mgr = nctx.rt.maybe_agents()
    for node in nctx.ex.graph.nodes:
        cfg = node.config
        if not isinstance(cfg, GateNodeConfig) or cfg.gate != GateKind.cross_review or not cfg.reviewer_profile_id:
            continue
        author = cfg.target_node_id or nearest_writer(topo, node.id)
        if author != nctx.node_id or mgr is None:
            continue
        try:
            return (await mgr.resolve_profile(cfg.reviewer_profile_id)).provider
        except Exception:
            return None
    return None


async def ensure_worktrees(nctx: NodeContext, repos: list[Repo]) -> list[Worktree]:
    """Own worktrees from an earlier round, else the nearest upstream writer's (sequential writers
    continue each other's work), else new worktrees for every target repo."""
    ex = nctx.ex
    wm = nctx.rt.worktrees()
    own = ex.state.worktrees.get(nctx.node_id) or {}
    if own and len(own) >= len(repos):
        return [await wm.get(w) for w in own.values()]
    if not own:
        upstream = nearest_writer(ex.topo, nctx.node_id)
        target = nctx.writer_target(upstream)
        if target is not None and target.worktree_ids:
            wts = [await wm.get(w) for w in target.worktree_ids]
            active = [w for w in wts if w.status == "active"]
            if active:
                ex.state.worktrees[nctx.node_id] = {w.repo_id: w.id for w in active}
                await ex.persist_state()
                return active
    created: dict[str, str] = dict(own)
    for repo in repos:
        if repo.id in created:
            continue
        wt = await wm.create(
            repo.id,
            base_ref=ex.task.base_ref,
            task_id=ex.task.id,
            run_id=ex.run_id,
            label=nctx.node_id,
        )
        created[repo.id] = wt.id
        ex.state.worktrees[nctx.node_id] = dict(created)
        await ex.persist_state()
        await nctx.emit("node.worktree", {"worktree_id": wt.id, "repo_id": repo.id, "branch": wt.branch})
    return [await wm.get(created[r.id]) for r in repos if r.id in created]


def _commit_message(nctx: NodeContext, agent: ResolvedAgent) -> str:
    round_note = f" · tur {nctx.attempt}" if nctx.attempt > 1 else ""
    return (
        f"{nctx.ex.task.title}\n\n"
        f"{nctx.node.label} · {PROVIDER_LABEL.get(agent.provider, agent.provider)}{round_note}\n"
        f"AI Studio görev: {nctx.ex.task.id} · koşu: {nctx.ex.run_id}"
    )


async def structured_turns(
    nctx: NodeContext,
    *,
    fmt: Any,
    text: str,
    provider: Provider,
    build_request: Any,
    reuse_key: str,
    key: str = "format",
) -> tuple[dict[str, Any] | None, str]:
    """Parse the structured part of an answer; ask once more in the same session if unreadable."""
    if fmt == "text":
        return None, text
    parsed = parse_structured(fmt, text)
    if parsed is not None:
        return parsed, text
    retry = await nctx.run_turn(
        key=key, message=retry_instructions(fmt), provider=provider, build_request=build_request, reuse_key=reuse_key
    )
    parsed = parse_structured(fmt, retry.text)
    if parsed is not None:
        return parsed, f"{text}\n\n{retry.text}" if text.strip() else retry.text
    return None, text


async def run_agent_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, AgentNodeConfig)
    ex = nctx.ex
    nctx.rt.agents()  # fail fast (Turkish Unavailable) when no agent manager is registered
    agent = await nctx.resolve_agent(
        profile_id=cfg.profile_id,
        provider=cfg.provider,
        model=cfg.model,
        effort=cfg.effort,
        role=cfg.role,
        explicit=set(cfg.model_fields_set),
        node_boundaries=cfg.boundaries,
        read_only=not cfg.writes,
    )
    forbidden = await _reviewer_provider_for(nctx)
    provider, limit_info = await nctx.ensure_provider(agent.provider, purpose=nctx.node.label, forbidden=forbidden)
    if provider != agent.provider:
        agent.switched_from = agent.provider
        agent.provider, agent.model, agent.effort = provider, None, None
    nctx.partial.update(provider=agent.provider, model=agent.model, role=agent.role, profile_id=agent.profile_id)

    repos = ex.target_repos(cfg.repo_ids)
    worktrees: list[Worktree] = []
    if cfg.writes:
        if not repos:
            raise NodeFailure("Bu görev için çalışma alanında repo yok; kod yazan düğüm çalıştırılamaz.")
        worktrees = await ensure_worktrees(nctx, repos)
        await nctx.add_worktrees([w.id for w in worktrees])
        cwd, extra_dirs = worktrees[0].path, [w.path for w in worktrees[1:]]
    else:
        cwd, extra_dirs = read_only_location(nctx, repos)

    prompt = await nctx.render(cfg.prompt_template, role=agent.role)
    if not prompt.strip():
        prompt = ex.task.prompt
    prompt += format_instructions(cfg.output_format)
    system = await nctx.system_append(agent.role, agent.instructions)

    async def build_request() -> StartSessionRequest:
        return nctx.session_request(
            agent,
            cwd=cwd,
            system_append=system,
            extra_dirs=extra_dirs,
            worktree_id=worktrees[0].id if worktrees else None,
            tool_names=cfg.tool_names,
        )

    reuse_key = f"node:{nctx.node_id}:{agent.provider}"
    turn = await nctx.run_turn(
        key="main", message=prompt, provider=agent.provider, build_request=build_request, reuse_key=reuse_key
    )
    structured, text = await structured_turns(
        nctx,
        fmt=cfg.output_format,
        text=turn.text,
        provider=agent.provider,
        build_request=build_request,
        reuse_key=reuse_key,
    )
    data: dict[str, Any] = {
        "session_id": turn.session_id,
        "provider": agent.provider,
        "model": agent.model,
        "role": agent.role,
        "profile_id": agent.profile_id,
        "boundaries": agent.boundaries.model_dump(mode="json"),
        "format": cfg.output_format,
        **limit_info,
    }
    if turn.result.usage is not None:
        data["usage"] = turn.result.usage.model_dump(mode="json")
    if cfg.output_format != "text":
        data["structured"] = structured
        if structured is None:
            data["structured_error"] = "Yapılandırılmış çıktı okunamadı."
    output = strip_json_block(text) if structured is not None else text

    if cfg.writes:
        wm = nctx.rt.worktrees()
        by_repo: dict[str, list[str]] = {}
        commits: dict[str, str | None] = {}
        for wt in worktrees:
            by_repo[wt.repo_id] = await wm.changed_files(wt.id)
            commits[wt.id] = await wm.commit_all(wt.id, _commit_message(nctx, agent))
        multi = len(worktrees) > 1
        names = {r.id: r.name for r in repos}
        flat = [
            f"{names.get(repo_id, repo_id)}/{p}" if multi else p for repo_id, paths in by_repo.items() for p in paths
        ]
        data.update(
            worktree_ids=[w.id for w in worktrees],
            branches={w.id: w.branch for w in worktrees},
            changed_files=flat,
            changed_files_by_repo=by_repo,
            commits=commits,
        )
    return NodeOutcome(status="passed", output=output, data=data)


async def run_advisor_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, AdvisorNodeConfig)
    ex = nctx.ex
    nctx.rt.agents()
    agent = await nctx.resolve_agent(
        profile_id=cfg.profile_id,
        provider=cfg.provider,
        model=cfg.model,
        effort=cfg.effort,
        role="advisor",
        explicit=set(cfg.model_fields_set) | {"role"},
        read_only=True,
    )
    provider, limit_info = await nctx.ensure_provider(agent.provider, purpose=nctx.node.label)
    if provider != agent.provider:
        agent.switched_from = agent.provider
        agent.provider, agent.model, agent.effort = provider, None, None
    nctx.partial.update(provider=agent.provider, model=agent.model, role="advisor", profile_id=agent.profile_id)
    cwd, extra_dirs = read_only_location(nctx, ex.target_repos(None))
    prompt = await nctx.render(cfg.prompt_template, role="advisor")
    if not prompt.strip():
        prompt = ex.task.prompt
    if cfg.perspective.strip():
        prompt += f"\n\n## Bakış açın\n{cfg.perspective.strip()}"
    system = await nctx.system_append("advisor", agent.instructions)

    async def build_request() -> StartSessionRequest:
        return nctx.session_request(agent, cwd=cwd, system_append=system, extra_dirs=extra_dirs, network=cfg.web_access)

    turn = await nctx.run_turn(
        key="main",
        message=prompt,
        provider=agent.provider,
        build_request=build_request,
        reuse_key=f"node:{nctx.node_id}:{agent.provider}",
    )
    data: dict[str, Any] = {
        "session_id": turn.session_id,
        "provider": agent.provider,
        "model": agent.model,
        "role": "advisor",
        "profile_id": agent.profile_id,
        "perspective": cfg.perspective,
        **limit_info,
    }
    return NodeOutcome(status="passed", output=turn.text, data=data)
