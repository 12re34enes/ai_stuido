"""Demo team (Ekip) and native-subagent scenarios for ``demo_server.py``.

Every Claude session of the demo runs the same fake CLI, so team members pick their own script by
a phrase in their system prompt (``by_system_prompt``; Codex: ``byInstructions`` in the developer
instructions). Members really write files into their worktrees, so studiod commits and merges them
up the hierarchy like a real run.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SUBAGENT_FIXTURE = ROOT / "fixtures" / "claude" / "scenario_subagents.json"
SUBAGENT_KEY = "Alt ajanlarla paralel araştır"
MODEL = "claude-opus-5-5"

# ----------------------------------------------------------------------------- the team


def _m(
    member_id: str, name: str, role: str, parent: str | None, provider: str, effort: str, x: float, y: float, **kw: Any
) -> dict[str, Any]:
    return {
        "id": member_id,
        "name": name,
        "role": role,
        "parent_id": parent,
        "provider": provider,
        "effort": effort,
        "position": {"x": x, "y": y},
        **kw,
    }


TEAM_SPEC: dict[str, Any] = {
    "members": [
        _m(
            "advisor",
            "Danışman",
            "advisor",
            "lead",
            "codex",
            "high",
            -300,
            0,
            instructions="Mimari, risk ve kalite açısından lideri yönlendir; kod yazma.",
        ),
        _m(
            "lead",
            "Lider",
            "lead",
            None,
            "claude",
            "high",
            0,
            0,
            instructions="İşi böl, sonuçları birleştir, kaliteden sorumlu ol.",
        ),
        _m(
            "ui",
            "Arayüz geliştirici",
            "worker",
            "lead",
            "claude",
            "medium",
            -340,
            190,
            instructions="İade formu ve etkileşimler.",
        ),
        _m("comp", "Bileşen ajanı", "worker", "ui", "claude", "low", -450, 380, instructions="React bileşenleri."),
        _m(
            "style", "Stil ajanı", "worker", "ui", "codex", "low", -230, 380, instructions="Stiller ve erişilebilirlik."
        ),
        _m(
            "api", "API geliştirici", "worker", "lead", "codex", "medium", 0, 190, instructions="İade servisi ve uçlar."
        ),
        _m("data", "Veri geliştirici", "worker", "lead", "claude", "medium", 340, 190, instructions="Şema ve göçler."),
        _m(
            "qa-ui",
            "Arayüz test ajanı",
            "tester",
            "ui",
            "codex",
            "low",
            -560,
            190,
            test_mode="dependent",
            tests_member_id="ui",
            instructions="Formu klavye ve ekran okuyucuyla dener.",
        ),
        _m(
            "qa-e2e",
            "E2E test ajanı",
            "tester",
            "lead",
            "claude",
            "low",
            340,
            380,
            test_mode="independent",
            instructions="Uçtan uca iade senaryosunu çalıştırır.",
        ),
    ],
    "settings": {"report_mode": "each_assignment", "max_parallel_members": 6, "test_max_rounds": 2},
}

TEAM_TASK = {
    "title": "Kısmi iade desteği (ekip)",
    "prompt": "Ödeme servisine kısmi iade ekle: iade formu, API ucu ve veritabanı göçü. Toplam iade orijinal "
    "tutarı aşmasın; her iade denetim kaydına düşsün.",
}

# ----------------------------------------------------------------------------- Claude steps


def _usage(context: int, out: int = 300) -> dict[str, int]:
    return {
        "input_tokens": 900,
        "output_tokens": out,
        "cache_read_input_tokens": max(0, context - 900),
        "cache_creation_input_tokens": 0,
    }


def _text(text: str, msg_id: str, context: int = 24_000) -> dict[str, Any]:
    return {
        "op": "emit",
        "msg": {
            "type": "assistant",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "model": MODEL,
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "usage": _usage(context),
            },
            "parent_tool_use_id": None,
            "session_id": "$SESSION",
            "uuid": f"a-{msg_id}",
        },
    }


def _tool(
    name: str, tool_input: dict[str, Any], output: str, tool_id: str, context: int = 30_000
) -> list[dict[str, Any]]:
    use = {
        "op": "emit",
        "msg": {
            "type": "assistant",
            "message": {
                "id": f"m-{tool_id}",
                "type": "message",
                "role": "assistant",
                "model": MODEL,
                "content": [{"type": "tool_use", "id": tool_id, "name": name, "input": tool_input}],
                "stop_reason": "tool_use",
                "usage": _usage(context, 120),
            },
            "parent_tool_use_id": None,
            "session_id": "$SESSION",
            "uuid": f"a-{tool_id}",
        },
    }
    result = {
        "op": "emit",
        "msg": {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": output}],
            },
            "parent_tool_use_id": None,
            "session_id": "$SESSION",
            "uuid": f"u-{tool_id}",
        },
    }
    return [use, result]


def _mcp(tool: str, arguments: dict[str, Any], tool_id: str) -> dict[str, Any]:
    return {"op": "mcp_call", "tool": tool, "arguments": arguments, "tool_use_id": tool_id}


def _result(text: str, context: int) -> dict[str, Any]:
    return {
        "op": "result",
        "result": text,
        "duration_ms": 8200,
        "num_turns": 4,
        "usage": _usage(context, 1400),
        "modelUsage": {MODEL: {"inputTokens": 900, "outputTokens": 1400, "contextWindow": 200_000}},
    }


def _plain(text: str = "Tamam.") -> list[dict[str, Any]]:
    return [_text(text, "plain"), _result(text, 26_000)]


def _write_and_finish(
    path: str, content: str, summary: str, tool_id: str, *, wait: float, context: int
) -> list[dict[str, Any]]:
    return [
        {"op": "sleep", "seconds": wait / 2},
        *_tool("Read", {"file_path": "README.md"}, "# Ödeme servisi", f"{tool_id}-read", context - 6000),
        {"op": "sleep", "seconds": wait / 2},
        *_tool("Write", {"file_path": path, "content": content}, "Dosya yazıldı.", f"{tool_id}-write", context),
        {"op": "write", "path": path, "content": content},
        _mcp("team_finish", {"summary": summary}, f"{tool_id}-finish"),
        _text(summary, f"{tool_id}-done", context + 2000),
        _result(summary, context + 2000),
    ]


LEAD_SUMMARY = (
    "Kısmi iade tamamlandı: iade formu (tutar girişi, kalan tutar göstergesi), POST /refunds/{id}/partial ucu ve "
    "0042 göçü birleştirildi. Toplam iade, veritabanı kısıtı ve servis doğrulamasıyla orijinal tutarla sınırlı."
)


def _lead_turn() -> list[dict[str, Any]]:
    return [
        _text(
            "Görevi üç parçaya bölüyorum: iade formu, kısmi iade ucu ve veri göçü. Önce tutar modelini danışmana soruyorum.",
            "l1",
            18_000,
        ),
        _mcp(
            "team_consult",
            {
                "question": "Kısmi iadede tutarları nasıl tutalım; toplamın orijinal tutarı aşmamasını nerede güvenceye alalım?"
            },
            "l-consult",
        ),
        _mcp(
            "team_delegate",
            {
                "member_id": "ui",
                "title": "İade formu arayüzü",
                "instructions": "İade ekranına kısmi tutar girişi, kalan iade edilebilir tutar göstergesi ve doğrulama mesajları ekle. Tutarlar kuruş cinsinden tamsayı.",
            },
            "l-d1",
        ),
        _mcp(
            "team_delegate",
            {
                "member_id": "api",
                "title": "Kısmi iade API ucu",
                "instructions": "POST /refunds/{payment_id}/partial ucunu ekle: tutar doğrulaması, toplam kontrolü, denetim kaydı.",
            },
            "l-d2",
        ),
        _mcp(
            "team_delegate",
            {
                "member_id": "data",
                "title": "İade tablosu göçü",
                "instructions": "refunds tablosuna partial_amount_cents ve toplamı orijinal tutarla sınırlayan kısıt ekleyen göçü yaz.",
            },
            "l-d3",
        ),
        _mcp("team_wait", {"timeout_s": 600}, "l-wait"),
        _text("Üç iş de tamamlandı ve branch'ime birleştirildi; son kontrolü yapıp özetliyorum.", "l2", 64_000),
        _mcp("team_finish", {"summary": LEAD_SUMMARY}, "l-finish"),
        _text(LEAD_SUMMARY, "l3", 71_000),
        _result(LEAD_SUMMARY, 71_000),
    ]


def _ui_turn() -> list[dict[str, Any]]:
    form = (
        "import { RefundAmountInput } from './RefundAmountInput';\n\n"
        "export function RefundForm({ payment }: { payment: Payment }) {\n"
        "  const remaining = payment.amountCents - payment.refundedCents;\n"
        "  return <RefundAmountInput max={remaining} />;\n}\n"
    )
    summary = "İade formu: tutar girişi, kalan tutar göstergesi ve doğrulama mesajları eklendi; stiller bağlandı."
    return [
        _text("Formu iki alt ajana bölüyorum: bileşen ve stiller. Birleştirmeyi ben yapacağım.", "u1", 16_000),
        _mcp(
            "team_delegate",
            {
                "member_id": "comp",
                "title": "Tutar giriş bileşeni",
                "instructions": "RefundAmountInput: kuruş cinsinden tamsayı, en fazla kalan tutar, hata mesajı.",
            },
            "u-d1",
        ),
        _mcp(
            "team_delegate",
            {
                "member_id": "style",
                "title": "Form stilleri",
                "instructions": "Formun stilleri ve odak halkaları; kontrast AA.",
            },
            "u-d2",
        ),
        _mcp("team_wait", {"timeout_s": 600}, "u-wait"),
        *_tool(
            "Write", {"file_path": "src/refund/RefundForm.tsx", "content": form}, "Dosya yazıldı.", "u-write", 41_000
        ),
        {"op": "write", "path": "src/refund/RefundForm.tsx", "content": form},
        _mcp("team_finish", {"summary": summary}, "u-finish"),
        _text(summary, "u2", 44_000),
        _result(summary, 44_000),
    ]


def _verdict(summary: str, findings: list[dict[str, Any]] | None = None) -> str:
    body = {"verdict": "pass", "summary": summary, "findings": findings or []}
    return f"{summary}\n\n```json\n{json.dumps(body, ensure_ascii=False)}\n```"


def claude_team_overrides() -> dict[str, Any]:
    comp = "export function RefundAmountInput({ max }: { max: number }) {\n  /* kuruş cinsinden tamsayı */\n}\n"
    sql = (
        "ALTER TABLE refunds ADD COLUMN partial_amount_cents INTEGER NOT NULL DEFAULT 0;\n"
        "-- toplam iade orijinal tutarı aşamaz\n"
    )
    e2e = _verdict(
        "Uçtan uca senaryo geçti: kısmi iade, ikinci kısmi iade ve tutarı aşan iade reddi doğrulandı.",
        [
            {
                "severity": "low",
                "file": "src/refund/RefundForm.tsx",
                "line": 4,
                "message": "Kalan tutar sıfırken düğme devre dışı olabilir.",
            }
        ],
    )
    return {
        "**Lider** olarak": {"model": MODEL, "turns": [_lead_turn(), *[_plain()] * 6]},
        "**Arayüz geliştirici** olarak": {"model": MODEL, "turns": [_ui_turn(), *[_plain("Düzeltildi.")] * 4]},
        "**Bileşen ajanı** olarak": {
            "model": MODEL,
            "turns": [
                _write_and_finish(
                    "src/refund/RefundAmountInput.tsx",
                    comp,
                    "RefundAmountInput eklendi: kuruş doğrulaması ve üst sınır.",
                    "c",
                    wait=4,
                    context=28_000,
                ),
                *[_plain()] * 3,
            ],
        },
        "**Veri geliştirici** olarak": {
            "model": MODEL,
            "turns": [
                _write_and_finish(
                    "migrations/0042_partial_refunds.sql",
                    sql,
                    "0042 göçü: partial_amount_cents ve toplam kısıtı.",
                    "d",
                    wait=6,
                    context=33_000,
                ),
                *[_plain()] * 3,
            ],
        },
        "test ajanısın (E2E test ajanı)": {
            "model": MODEL,
            "turns": [
                [
                    {"op": "sleep", "seconds": 3},
                    *_tool("Bash", {"command": "pnpm e2e refund"}, "3 passed", "e-run", 22_000),
                    _text(e2e, "e1", 25_000),
                    _result(e2e, 25_000),
                ]
            ]
            * 4,
        },
    }


# ----------------------------------------------------------------------------- Codex steps


def _codex_usage(context: int, out: int = 600) -> dict[str, Any]:
    """thread/tokenUsage/updated with ``context`` tokens in the window (drives the context ring)."""
    last = {
        "totalTokens": context,
        "inputTokens": context - out,
        "cachedInputTokens": max(0, context - out - 2000),
        "cacheWriteInputTokens": 0,
        "outputTokens": out,
        "reasoningOutputTokens": out // 3,
    }
    return {
        "notify": "thread/tokenUsage/updated",
        "params": {
            "threadId": "$THREAD",
            "turnId": "$TURN",
            "tokenUsage": {"total": last, "last": last, "modelContextWindow": 258_400},
        },
    }


def codex_message(text: str, msg_id: str, context: int = 30_000) -> list[dict[str, Any]]:
    return [
        {"item": {"type": "agentMessage", "id": msg_id, "text": "", "phase": "final_answer"}, "phase": "started"},
        _codex_usage(context),
        {"item": {"type": "agentMessage", "id": msg_id, "text": text, "phase": "final_answer"}, "phase": "completed"},
    ]


def codex_team_overrides() -> dict[str, Any]:
    advice = (
        "Tutarları kuruş cinsinden tamsayı tutun. Toplamı iki yerde koruyun: serviste doğrulama ve veritabanında "
        "kısıt. İade kaydını aynı işlemde yazın ki yarım kalan iade olmasın."
    )
    api_py = "def partial_refund(payment_id: str, amount_cents: int) -> Refund:\n    ...  # toplam kontrolü + denetim kaydı\n"
    css = ".refund-form :focus-visible { outline: 2px solid var(--accent); }\n"
    qa = _verdict("Form klavyeyle tamamen kullanılabiliyor; ekran okuyucu etiketleri doğru.")
    return {
        "danışmanısın (Danışman)": {"turnScripts": [[{"sleep": 1500}, *codex_message(advice, "adv", 52_000)]] * 16},
        "**API geliştirici** olarak": {
            "turnScripts": [
                [
                    {"sleep": 5000},
                    {"write": {"path": "src/api/refunds.py", "content": api_py}},
                    *codex_message(
                        "POST /refunds/{payment_id}/partial eklendi: tutar doğrulaması, toplam kontrolü ve denetim kaydı.",
                        "api",
                        88_000,
                    ),
                ],
                *[codex_message("Düzeltildi.", "api-fix")] * 3,
            ]
        },
        "**Stil ajanı** olarak": {
            "turnScripts": [
                [
                    {"sleep": 3500},
                    {"write": {"path": "src/refund/refund.css", "content": css}},
                    *codex_message("Form stilleri ve odak halkaları eklendi.", "sty", 34_000),
                ],
                *[codex_message("Düzeltildi.", "sty-fix")] * 3,
            ]
        },
        "test ajanısın (Arayüz test ajanı)": {"turnScripts": [[{"sleep": 2500}, *codex_message(qa, "qa", 21_000)]] * 6},
    }


# ----------------------------------------------------------------------------- native subagents


def claude_subagent_override() -> dict[str, Any]:
    """A plain (non-flow) session whose turn spawns parallel, nested and background subagents."""
    fixture = json.loads(SUBAGENT_FIXTURE.read_text())
    return {SUBAGENT_KEY: {"model": fixture.get("model", MODEL), "turns": fixture["turns"]}}
