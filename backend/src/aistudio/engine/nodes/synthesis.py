"""``synthesis`` node (Kurul): optional counter-thesis, then a single Turkish decision document.

With ``propose_memory`` the decision is proposed to ``decisions/YYYY-MM-DD-<slug>.md``; the memory
module turns that into an approval, so nothing is written to memory without the user.
"""

from __future__ import annotations

import re
from typing import Any

from aistudio.contracts.agents import StartSessionRequest
from aistudio.contracts.common import other_provider
from aistudio.contracts.flows import SynthesisNodeConfig
from aistudio.core.clock import utcnow
from aistudio.core.text import slugify, truncate
from aistudio.engine.graph import is_opinion, upstream_branch_heads
from aistudio.engine.nodes.agent import PROVIDER_LABEL, read_only_location
from aistudio.engine.nodes.base import NodeContext, NodeFailure, NodeOutcome, ResolvedAgent
from aistudio.engine.structured import DECISION_SECTIONS, missing_sections, strip_json_block

_H1 = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


def decision_structure_instructions() -> str:
    headings = "\n".join(f"## {s}" for s in DECISION_SECTIONS)
    return (
        "Belgeyi Türkçe Markdown olarak yaz. İlk satır `# <kısa karar başlığı>` olsun, ardından tam olarak şu "
        f"başlıklar sırayla gelsin:\n{headings}\n"
        "Seçenekler bölümünde her seçeneğin artı ve eksilerini yaz; Karar bölümünde tek ve net bir karar ver."
    )


def ensure_decision_structure(doc: str, title: str) -> str:
    doc = strip_json_block(doc).strip()
    if not _H1.search(doc.split("\n", 1)[0] if doc else ""):
        doc = f"# {title}\n\n{doc}"
    for section in missing_sections(doc):
        doc += f"\n\n## {section}\n_Belirtilmedi._"
    return doc.strip() + "\n"


async def run_synthesis_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, SynthesisNodeConfig)
    ex = nctx.ex
    sources = [s for s in upstream_branch_heads(ex.topo, nctx.node_id, is_opinion) if ex.results.get(s) is not None]
    opinions = [(s, ex.results[s]) for s in sources if ex.results[s].status == "passed" and ex.output_of(s).strip()]
    if not opinions:
        raise NodeFailure("Sentezlenecek görüş yok: danışmanların hiçbiri sonuç üretmedi.")
    agent = await nctx.resolve_agent(
        profile_id=cfg.profile_id,
        provider=cfg.provider,
        model=cfg.model,
        effort=None,
        role="synthesizer",
        explicit=set(cfg.model_fields_set) | {"role"},
        read_only=True,
    )
    provider, limit_info = await nctx.ensure_provider(agent.provider, purpose=nctx.node.label)
    if provider != agent.provider:
        agent.provider, agent.model, agent.effort = provider, None, None
    nctx.partial.update(provider=agent.provider, model=agent.model, role="synthesizer", profile_id=agent.profile_id)
    cwd, extra_dirs = read_only_location(nctx, ex.target_repos(None))

    opinion_md = "\n\n".join(
        f"### {ex.topo.nodes[s].label}"
        + (
            f" ({PROVIDER_LABEL.get(str((r.data or {}).get('provider')), '')})"
            if (r.data or {}).get("provider")
            else ""
        )
        + f"\n{truncate(ex.output_of(s), 12000)}"
        for s, r in opinions
    )
    data: dict[str, Any] = {"sources": [s for s, _ in opinions], **limit_info}

    counter = ""
    if cfg.devil_advocate:
        devil = ResolvedAgent(
            provider=other_provider(agent.provider),
            model=None,
            effort=None,
            role="advisor",
            boundaries=agent.boundaries,
        )
        devil_provider, _ = await nctx.ensure_provider(devil.provider, purpose="Karşı tez")
        devil.provider = devil_provider
        devil_system = await nctx.system_append("advisor", "Görevin karşı tez üretmek: şeytanın avukatlığını yap.")

        async def devil_request() -> StartSessionRequest:
            return nctx.session_request(
                devil, cwd=cwd, system_append=devil_system, extra_dirs=extra_dirs, label="Karşı tez"
            )

        devil_prompt = (
            f"## Soru\n{ex.task.prompt}\n\n## Kurulun görüşleri\n{opinion_md}\n\n---\n"
            "Bu görüşlere karşı en güçlü karşı tezi yaz: zayıf varsayımlar, gözden kaçan seçenekler, uzun vadeli "
            "riskler ve görüşlerin çeliştiği noktalar."
        )
        devil_turn = await nctx.run_turn(
            key="devil", message=devil_prompt, provider=devil.provider, build_request=devil_request
        )
        counter = devil_turn.text
        data.update(counter_thesis=counter, devil_provider=devil.provider, devil_session_id=devil_turn.session_id)
        await nctx.emit("node.counter_thesis", {"provider": devil.provider, "preview": truncate(counter, 400)})

    custom = (await nctx.render(cfg.prompt_template, role="synthesizer")) if cfg.prompt_template else ""
    parts = [custom or "Kurulun görüşlerini tart ve tek bir sonuç belgesi yaz.", f"## Soru\n{ex.task.prompt}"]
    parts.append(f"## Kurulun görüşleri\n{opinion_md}")
    if counter.strip():
        parts.append(f"## Karşı tez\n{truncate(counter, 12000)}")
    if cfg.output_format == "decision":
        parts.append(decision_structure_instructions())
    elif cfg.output_format == "report":
        parts.append("Türkçe, kaynaklı ve bölümlere ayrılmış bir Markdown rapor yaz.")
    prompt = "\n\n".join(parts)
    system = await nctx.system_append("synthesizer", agent.instructions)

    async def build_request() -> StartSessionRequest:
        return nctx.session_request(agent, cwd=cwd, system_append=system, extra_dirs=extra_dirs, label="Sentez")

    reuse_key = f"node:{nctx.node_id}:{agent.provider}"
    turn = await nctx.run_turn(
        key="synthesis", message=prompt, provider=agent.provider, build_request=build_request, reuse_key=reuse_key
    )
    doc = turn.text
    if cfg.output_format == "decision":
        missing = missing_sections(doc)
        if missing:
            fix = await nctx.run_turn(
                key="synthesis_fix",
                message=(
                    "Karar belgesinde şu başlıklar eksik: "
                    + ", ".join(missing)
                    + ". Belgenin tamamını bu başlıkları da içerecek şekilde yeniden yaz.\n\n"
                    + decision_structure_instructions()
                ),
                provider=agent.provider,
                build_request=build_request,
                reuse_key=reuse_key,
            )
            if len(missing_sections(fix.text)) < len(missing):
                doc = fix.text
        doc = ensure_decision_structure(doc, ex.task.title)
    data.update(
        session_id=turn.session_id,
        provider=agent.provider,
        model=agent.model,
        role="synthesizer",
        format=cfg.output_format,
        document=doc,
    )

    if cfg.propose_memory and cfg.output_format == "decision":
        mem = nctx.rt.memory()
        if mem is None:
            data["memory_skipped"] = "Hafıza servisi hazır değil; karar hafızaya önerilmedi."
        else:
            match = _H1.search(doc)
            title = match.group(1).strip() if match else ex.task.title
            path = f"decisions/{utcnow().date().isoformat()}-{slugify(title, fallback='karar')}.md"
            proposal = await mem.propose(
                ex.task.workspace_id,
                path=path,
                new_content=doc,
                rationale=f"Kurul kararı: {ex.task.title}",
                source_session_id=turn.session_id,
            )
            data.update(memory_proposal_id=proposal.id, memory_path=path, memory_approval_id=proposal.approval_id)
            await nctx.emit("node.memory_proposed", {"proposal_id": proposal.id, "path": path})
    return NodeOutcome(status="passed", output=doc, data=data)
