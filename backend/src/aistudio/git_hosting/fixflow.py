"""Task graphs and prompts for PR takibi fix tasks (spec §13).

Every fix task runs the same explicit graph::

    [fix: agent] -> [build_test gate] -> [cross_review gate] -> [push onto the PR branch]
          ^------------- failed --------------|------- failed -------|

The push node uses ``push_branch_template = "{{ input.push_branch }}"`` so the fix lands on the
existing PR head branch instead of a new branch.
"""

from __future__ import annotations

from typing import Literal

from aistudio.contracts.flows import (
    AgentNodeConfig,
    FlowEdge,
    FlowGraph,
    FlowNode,
    FlowSettings,
    GateKind,
    GateNodeConfig,
    GateToggles,
    GitNodeConfig,
    Position,
)
from aistudio.contracts.git_hosting import CheckRun, ReviewComment

FixKind = Literal["ci", "review", "conflict"]

_FIX_LABELS: dict[FixKind, str] = {
    "ci": "CI düzeltmesi",
    "review": "Review yorumlarını ele al",
    "conflict": "Çakışmayı çöz",
}


def build_fix_graph(kind: FixKind) -> FlowGraph:
    return FlowGraph(
        nodes=[
            FlowNode(
                id="fix",
                label=_FIX_LABELS[kind],
                config=AgentNodeConfig(role="writer", prompt_template="{{ input.prompt }}"),
                position=Position(x=0, y=0),
            ),
            FlowNode(
                id="build",
                label="Build/test kanıtı",
                config=GateNodeConfig(gate=GateKind.build_test, target_node_id="fix"),
                position=Position(x=260, y=0),
            ),
            FlowNode(
                id="review",
                label="Çapraz inceleme",
                config=GateNodeConfig(gate=GateKind.cross_review, target_node_id="fix"),
                position=Position(x=520, y=0),
            ),
            FlowNode(
                id="push",
                label="PR branch'ine push",
                config=GitNodeConfig(
                    action="push", push_branch_template="{{ input.push_branch }}", watch=False, autofix=False
                ),
                position=Position(x=780, y=0),
            ),
        ],
        edges=[
            FlowEdge(id="fix-build", source="fix", target="build"),
            FlowEdge(id="build-review", source="build", target="review", condition="passed"),
            FlowEdge(id="build-fix", source="build", target="fix", condition="failed"),
            FlowEdge(id="review-push", source="review", target="push", condition="passed"),
            FlowEdge(id="review-fix", source="review", target="fix", condition="failed"),
        ],
        settings=FlowSettings(gates=GateToggles(plan_approval=False, user_final=False)),
        inputs={
            "push_branch": {"type": "string", "description": "PR head branch"},
            "pr_number": {"type": "integer"},
        },
    )


def _quote_block(text: str, limit: int = 2000) -> str:
    text = text.strip()
    if len(text) > limit:
        text = text[:limit] + " …"
    return "\n".join(f"   {line}" if line else "" for line in text.splitlines())


def ci_title(number: int, failing: list[CheckRun]) -> str:
    names = ", ".join(c.name for c in failing[:3])
    more = f" +{len(failing) - 3}" if len(failing) > 3 else ""
    return f"PR #{number}: CI düzeltmesi ({names}{more})" if names else f"PR #{number}: CI düzeltmesi"


def ci_prompt(*, number: int, title: str, head: str, sha: str, failing: list[CheckRun], logs: dict[str, str]) -> str:
    lines = [
        f"PR #{number} ({title}) için CI kırıldı. Branch: {head}, head commit: {sha[:12]}.",
        "",
        "Kırılan kontroller:",
    ]
    for c in failing:
        url = f" — {c.url}" if c.url else ""
        lines.append(f"- {c.name}: {c.conclusion or 'failure'}{url}")
    if logs:
        lines += ["", "Logların son kısımları:"]
        for name, text in logs.items():
            lines += ["", f"### {name}", "```", text, "```"]
    lines += [
        "",
        "Görev: hatanın kök nedenini bul ve düzelt. CI'ı geçirmek için testleri silme, atlama ya da "
        "devre dışı bırakma; gerekiyorsa testi gerekçesiyle güncelle.",
        f"Değişiklikler build/test ve çapraz inceleme kapılarından geçtikten sonra {head} branch'ine push edilecek.",
    ]
    return "\n".join(lines)


def review_title(number: int, count: int) -> str:
    return f"PR #{number}: review yorumlarını ele al ({count} yorum)"


def review_prompt(*, number: int, title: str, head: str, comments: list[ReviewComment]) -> str:
    lines = [f"PR #{number} ({title}) için çözülmemiş review yorumları var. Branch: {head}.", "", "Yorumlar:"]
    for i, c in enumerate(comments, 1):
        where = f"[{c.path}:{c.line}] " if c.path and c.line else (f"[{c.path}] " if c.path else "")
        lines.append(f"{i}. {where}@{c.author} (yorum id: {c.id})")
        lines.append(_quote_block(c.body))
    lines += [
        "",
        "Her yorum için ya kodu düzelt ya da düzeltme gerekmiyorsa gerekçeli bir yanıt yaz: "
        "`pr_comment_reply` aracını ilgili `comment_id` ile kullan.",
        "Kodla ele alınan yorumlar, düzeltme push edildikten sonra otomatik olarak yanıtlanır ve "
        "çözüldü olarak işaretlenir.",
        f"Değişiklikler kapılardan geçtikten sonra {head} branch'ine push edilecek.",
    ]
    return "\n".join(lines)


def conflict_title(number: int, base: str) -> str:
    return f"PR #{number}: {base} ile çakışmayı çöz"


def conflict_prompt(*, number: int, title: str, head: str, base: str) -> str:
    return "\n".join(
        [
            f"PR #{number} ({title}) branch'i ({head}) hedef branch {base} ile çakışıyor.",
            "",
            f"Görev: `git fetch origin {base}` ile hedef branch'in son halini al, `git merge origin/{base}` "
            "ile birleştir ve çakışmaları iki tarafın amacını da koruyarak çöz. Birleştirme commit'ini oluştur; "
            "rebase yapma (PR geçmişi korunmalı).",
            f"Değişiklikler kapılardan geçtikten sonra {head} branch'ine push edilecek.",
        ]
    )
