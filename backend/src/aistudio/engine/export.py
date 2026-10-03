"""Replay timeline and run/task exports (Markdown, self-contained HTML, JSON).

Everything exported passes through the masker (spec §18: exports are masked too).
"""

from __future__ import annotations

import html
import json
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from aistudio.contracts.flows import FlowGraph
from aistudio.core.clock import utcnow
from aistudio.core.events import Event, EventFilter
from aistudio.core.text import truncate
from aistudio.engine.models import TimelinePage

if TYPE_CHECKING:
    from aistudio.engine.runtime import EngineRuntime

ExportFormat = Literal["md", "html", "json"]

STATUS_TR: dict[str, str] = {
    "draft": "Taslak",
    "queued": "Kuyrukta",
    "running": "Çalışıyor",
    "waiting": "Bekliyor",
    "completed": "Tamamlandı",
    "failed": "Başarısız",
    "cancelled": "İptal edildi",
    "pending": "Bekliyor",
    "passed": "Geçti",
    "skipped": "Atlandı",
}
GATE_TR: dict[str, str] = {
    "plan_approval": "Plan onayı",
    "boundary_check": "Sınır denetimi",
    "build_test": "Build/test kanıtı",
    "cross_review": "Çapraz inceleme",
    "user_final": "Son onay",
    "deploy_approval": "Deploy onayı",
    "custom_command": "Özel komut",
}
OUTPUT_LIMIT = 20000


async def run_session_ids(rt: EngineRuntime, run_id: str) -> list[str]:
    ids: list[str] = []
    for row in await rt.store.node_run_rows(run_id):
        for sid in row["session_ids"] or []:
            if sid not in ids:
                ids.append(sid)
    return ids


async def timeline(rt: EngineRuntime, run_id: str, *, after_id: int | None = None, limit: int = 2000) -> TimelinePage:
    run = await rt.store.get_run(run_id)
    limit = max(1, min(limit, 10000))
    sessions = await run_session_ids(rt, run_id)
    merged: dict[int, Event] = {}
    for ev in await rt.ctx.events.query(EventFilter(run_id=run_id), after_id=after_id, limit=limit + 1):
        merged[ev.id] = ev
    for sid in sessions:
        for ev in await rt.ctx.events.query(EventFilter(session_id=sid), after_id=after_id, limit=limit + 1):
            merged[ev.id] = ev
    ordered = [merged[k] for k in sorted(merged)]
    return TimelinePage(run=run, events=ordered[:limit], session_ids=sessions, has_more=len(ordered) > limit)


async def build_export(rt: EngineRuntime, *, task_id: str, run_ids: list[str] | None = None) -> dict[str, Any]:
    task_row = await rt.store.task_row(task_id)
    task = (await rt.store.get_task(task_id)).model_dump(mode="json")
    summaries = await rt.store.run_summaries(task_id)
    ids = run_ids if run_ids is not None else [s.id for s in summaries]
    runs: list[dict[str, Any]] = []
    for rid in ids:
        run = await rt.store.get_run(rid)
        row = await rt.store.run_row(rid)
        events = await rt.ctx.events.query(EventFilter(run_id=rid), limit=5000)
        runs.append(
            {
                "id": run.id,
                "status": run.status,
                "error": row["error"],
                "started_at": run.started_at.isoformat(),
                "finished_at": run.finished_at.isoformat() if run.finished_at else None,
                "graph": run.graph.model_dump(mode="json"),
                "nodes": [n.model_dump(mode="json") for n in run.nodes],
                "gates": [g.model_dump(mode="json") for g in await rt.store.gate_results(rid)],
                "evidence": [e.model_dump(mode="json") for e in await rt.store.evidence(run_id=rid)],
                "checkpoints": [c.model_dump(mode="json") for c in await rt.store.checkpoints(rid)],
                "quality": row["quality"],
                "events": [
                    {
                        "id": e.id,
                        "ts": e.ts.isoformat(),
                        "type": e.type,
                        "severity": e.severity.value,
                        "actor": e.actor,
                        "payload": e.payload,
                    }
                    for e in events
                ],
            }
        )
    doc = {
        "format": "aistudio.export.v1",
        "exported_at": utcnow().isoformat(),
        "task": task,
        "quality": task_row["quality"],
        "rating": task_row["rating"],
        "runs": runs,
    }
    return rt.ctx.masker.mask_obj(doc)


def _fmt_ts(value: str | None) -> str:
    if not value:
        return "—"
    try:
        return datetime.fromisoformat(value).strftime("%d.%m.%Y %H:%M:%S")
    except ValueError:
        return value


def _labels(run: dict[str, Any]) -> dict[str, str]:
    graph = FlowGraph.model_validate(run["graph"])
    return {n.id: n.label for n in graph.nodes}


def to_markdown(doc: dict[str, Any]) -> str:
    task = doc["task"]
    lines: list[str] = [f"# {task['title']}", ""]
    lines += [
        "| Alan | Değer |",
        "|---|---|",
        f"| Durum | {STATUS_TR.get(task['status'], task['status'])} |",
        f"| Mod | {task['mode']} |",
        f"| Oluşturulma | {_fmt_ts(task['created_at'])} |",
        f"| Kalite puanı | {task.get('quality_score') if task.get('quality_score') is not None else '—'} |",
        f"| Görev kimliği | `{task['id']}` |",
        "",
        "## İstem",
        "",
        task["prompt"],
        "",
    ]
    quality = doc.get("quality")
    if quality and quality.get("components"):
        lines += ["## Kalite puanı", "", f"**{quality.get('score')} / 100**", "", quality.get("formula", ""), ""]
        lines += ["| Bileşen | Ağırlık | Değer | Açıklama |", "|---|---|---|---|"]
        for c in quality["components"]:
            value = "—" if c.get("value") is None else f"{c['value'] * 100:.0f}%"
            lines.append(f"| {c['label']} | %{c['weight']:g} | {value} | {c.get('detail', '')} |")
        lines.append("")
    for idx, run in enumerate(doc["runs"], 1):
        labels = _labels(run)
        lines += [
            f"## Koşu {idx}: {STATUS_TR.get(run['status'], run['status'])}",
            "",
            f"- Başlangıç: {_fmt_ts(run['started_at'])}",
            f"- Bitiş: {_fmt_ts(run['finished_at'])}",
        ]
        if run.get("error"):
            lines.append(f"- Hata: {run['error']}")
        lines += ["", "### Düğümler", "", "| Düğüm | Deneme | Durum | Başlangıç | Bitiş |", "|---|---|---|---|---|"]
        for n in run["nodes"]:
            lines.append(
                f"| {labels.get(n['node_id'], n['node_id'])} | {n['attempt']} | "
                f"{STATUS_TR.get(n['status'], n['status'])} | {_fmt_ts(n['started_at'])} | "
                f"{_fmt_ts(n['finished_at'])} |"
            )
        lines.append("")
        if run["gates"]:
            lines += ["### Kapılar ve kanıtlar", ""]
            for g in run["gates"]:
                lines.append(
                    f"- **{GATE_TR.get(g['kind'], g['kind'])}** ({labels.get(g['node_id'], g['node_id'])}, deneme "
                    f"{g['attempt']}): {STATUS_TR.get(g['status'], g['status'])} — {g['summary']} "
                    f"_(karar: {g['decided_by']})_"
                )
            lines.append("")
        if run["evidence"]:
            lines += ["### Kanıt kayıtları", ""]
            for e in run["evidence"]:
                lines.append(f"#### {e['title']}")
                lines.append(f"_{e.get('label', '')}_")
                if e.get("content"):
                    lines += ["", "```", truncate(e["content"], 4000), "```"]
                lines.append("")
        lines += ["### Çıktılar", ""]
        for n in run["nodes"]:
            if not n.get("output"):
                continue
            lines += [
                f"#### {labels.get(n['node_id'], n['node_id'])} (deneme {n['attempt']})",
                "",
                truncate(n["output"], OUTPUT_LIMIT),
                "",
            ]
        if run["events"]:
            lines += ["### Zaman çizelgesi", ""]
            for e in run["events"]:
                lines.append(f"- `{_fmt_ts(e['ts'])}` {e['type']}")
            lines.append("")
    lines.append(f"_AI Studio dışa aktarımı · {_fmt_ts(doc['exported_at'])}_")
    return "\n".join(lines) + "\n"


_CSS = """
:root { --bg:#faf9f5; --surface:#ffffff; --fg:#1f1e1c; --muted:#6b6862; --line:#e6e1d8; --accent:#c96442;
  --ok:#2f7d4f; --bad:#b3261e; --warn:#a46a00; --code:#f3f0ea; }
@media (prefers-color-scheme: dark) { :root { --bg:#262624; --surface:#30302e; --fg:#f2efe8; --muted:#a8a49c;
  --line:#3d3c39; --accent:#e08a6b; --ok:#6fcf97; --bad:#f28b82; --warn:#f2c46f; --code:#1f1f1d; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system, "SF Pro Text", system-ui,
  sans-serif; }
main { max-width:960px; margin:0 auto; padding:32px 16px 64px; }
h1, h2, h3 { font-family: ui-serif, "New York", Georgia, serif; font-weight:600; line-height:1.25; }
h1 { font-size:30px; margin:0 0 8px; } h2 { font-size:22px; margin:32px 0 12px; }
h3 { font-size:17px; margin:24px 0 8px; }
.meta { color:var(--muted); font-size:13px; }
.card { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:16px 20px; margin:12px 0; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:500; }
pre { background:var(--code); border-radius:8px; padding:12px; overflow:auto; font:12.5px/1.5 ui-monospace,
  "SF Mono", Menlo, monospace; white-space:pre-wrap; word-break:break-word; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); }
.passed, .completed { color:var(--ok); } .failed { color:var(--bad); }
.waiting, .skipped, .cancelled { color:var(--warn); }
.score { font-size:40px; font-family: ui-serif, "New York", Georgia, serif; color:var(--accent); }
.output { white-space:pre-wrap; }
.label { color:var(--muted); font-size:12px; font-style:italic; }
"""


def _e(value: Any) -> str:
    return html.escape("" if value is None else str(value))


def _pct(value: Any) -> str:
    return "—" if value is None else f"{float(value) * 100:.0f}%"


def _badge(status: str) -> str:
    return f'<span class="badge {_e(status)}">{_e(STATUS_TR.get(status, status))}</span>'


def to_html(doc: dict[str, Any]) -> str:
    task = doc["task"]
    out: list[str] = [
        "<!doctype html>",
        '<html lang="tr"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{_e(task['title'])} · AI Studio</title>",
        f"<style>{_CSS}</style></head><body><main>",
        f"<h1>{_e(task['title'])}</h1>",
        f'<p class="meta">{_badge(task["status"])} · Mod: {_e(task["mode"])} · {_e(_fmt_ts(task["created_at"]))} · '
        f"<code>{_e(task['id'])}</code></p>",
        f'<div class="card"><h3>İstem</h3><div class="output">{_e(task["prompt"])}</div></div>',
    ]
    quality = doc.get("quality")
    if quality and quality.get("components"):
        rows = "".join(
            f"<tr><td>{_e(c['label'])}</td><td>%{c['weight']:g}</td><td>{_pct(c.get('value'))}</td>"
            f"<td>{_e(c.get('detail'))}</td></tr>"
            for c in quality["components"]
        )
        out.append(
            f'<h2>Kalite puanı</h2><div class="card"><div class="score">{_e(quality.get("score"))}</div>'
            f'<p class="meta">{_e(quality.get("formula"))}</p>'
            f"<table><tr><th>Bileşen</th><th>Ağırlık</th><th>Değer</th><th>Açıklama</th></tr>{rows}</table></div>"
        )
    for idx, run in enumerate(doc["runs"], 1):
        labels = _labels(run)
        out.append(f"<h2>Koşu {idx} {_badge(run['status'])}</h2>")
        out.append(
            f'<p class="meta">Başlangıç {_e(_fmt_ts(run["started_at"]))} · Bitiş {_e(_fmt_ts(run["finished_at"]))}</p>'
        )
        if run.get("error"):
            out.append(f'<div class="card failed">{_e(run["error"])}</div>')
        node_rows = "".join(
            f"<tr><td>{_e(labels.get(n['node_id'], n['node_id']))}</td><td>{_e(n['attempt'])}</td>"
            f"<td>{_badge(n['status'])}</td><td>{_e(_fmt_ts(n['started_at']))}</td><td>{_e(_fmt_ts(n['finished_at']))}</td></tr>"
            for n in run["nodes"]
        )
        out.append(
            '<div class="card"><h3>Düğümler</h3><table><tr><th>Düğüm</th><th>Deneme</th><th>Durum</th>'
            f"<th>Başlangıç</th><th>Bitiş</th></tr>{node_rows}</table></div>"
        )
        if run["gates"]:
            gate_rows = "".join(
                f"<tr><td>{_e(GATE_TR.get(g['kind'], g['kind']))}</td>"
                f"<td>{_e(labels.get(g['node_id'], g['node_id']))}</td>"
                f"<td>{_e(g['attempt'])}</td><td>{_badge(g['status'])}</td><td>{_e(g['summary'])}</td>"
                f"<td>{_e(g['decided_by'])}</td></tr>"
                for g in run["gates"]
            )
            out.append(
                '<div class="card"><h3>Kapılar</h3><table><tr><th>Kapı</th><th>Düğüm</th><th>Deneme</th><th>Sonuç</th>'
                f"<th>Özet</th><th>Karar</th></tr>{gate_rows}</table></div>"
            )
        for e in run["evidence"]:
            out.append(
                f'<div class="card"><h3>{_e(e["title"])}</h3><p class="label">{_e(e.get("label"))}</p>'
                + (f"<pre>{_e(truncate(e['content'], 4000))}</pre>" if e.get("content") else "")
                + "</div>"
            )
        for n in run["nodes"]:
            if n.get("output"):
                out.append(
                    f'<div class="card"><h3>{_e(labels.get(n["node_id"], n["node_id"]))} '
                    f'<span class="meta">deneme {_e(n["attempt"])}</span></h3>'
                    f'<div class="output">{_e(truncate(n["output"], OUTPUT_LIMIT))}</div></div>'
                )
        if run["events"]:
            items = "".join(f"<tr><td>{_e(_fmt_ts(e['ts']))}</td><td>{_e(e['type'])}</td></tr>" for e in run["events"])
            out.append(f'<div class="card"><h3>Zaman çizelgesi</h3><table>{items}</table></div>')
    out.append(f'<p class="meta">AI Studio dışa aktarımı · {_e(_fmt_ts(doc["exported_at"]))}</p>')
    out.append("</main></body></html>")
    return "\n".join(out)


def render_export(doc: dict[str, Any], fmt: ExportFormat) -> tuple[str, str]:
    """Return (content, media type)."""
    if fmt == "json":
        return json.dumps(doc, ensure_ascii=False, indent=2), "application/json"
    if fmt == "html":
        return to_html(doc), "text/html; charset=utf-8"
    return to_markdown(doc), "text/markdown; charset=utf-8"
