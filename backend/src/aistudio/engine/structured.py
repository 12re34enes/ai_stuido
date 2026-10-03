"""Structured agent output: format instructions and robust JSON extraction.

Agents are asked to end their answer with a fenced ```json block. Models are not always
tidy, so extraction tries (in order) the last ```json fence, any fence that parses, and the
last balanced ``{...}`` object, and tolerates trailing commas and smart quotes.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

OutputFormat = Literal["text", "plan", "findings", "decision"]
SEVERITIES: tuple[str, ...] = ("critical", "high", "medium", "low")

_SEVERITY_ALIASES: dict[str, str] = {
    "critical": "critical",
    "blocker": "critical",
    "kritik": "critical",
    "engelleyici": "critical",
    "high": "high",
    "major": "high",
    "error": "high",
    "yüksek": "high",
    "yuksek": "high",
    "medium": "medium",
    "moderate": "medium",
    "warning": "medium",
    "orta": "medium",
    "low": "low",
    "minor": "low",
    "info": "low",
    "nit": "low",
    "trivial": "low",
    "düşük": "low",
    "dusuk": "low",
}

_FENCE = re.compile(r"```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n(.*?)```", re.DOTALL)
_TRAILING_COMMA = re.compile(r",(\s*[}\]])")

PLAN_SCHEMA = (
    '{"summary": "kısa özet", "steps": [{"title": "adım", "detail": "ayrıntı", "files": ["yol"]}], "risks": ["risk"]}'
)
FINDINGS_SCHEMA = (
    '{"verdict": "pass" | "fail", "summary": "kısa değerlendirme", "findings": '
    '[{"severity": "critical" | "high" | "medium" | "low", "file": "yol veya null", '
    '"line": 12, "message": "bulgu"}]}'
)
DECISION_SCHEMA = (
    '{"decision": "karar", "rationale": "gerekçe", "options": ["seçenek"], "risks": ["risk"], "next_steps": ["adım"]}'
)
JUDGE_SCHEMA = '{"winner": "<aday düğüm kimliği>", "rationale": "gerekçe"}'


def format_instructions(fmt: OutputFormat) -> str:
    if fmt == "plan":
        return (
            "\n\n---\nYanıtını önce okunabilir bir plan olarak yaz. En sonda, tek bir ```json bloğu içinde "
            f"şu yapıda bir özet ver:\n{PLAN_SCHEMA}"
        )
    if fmt == "findings":
        return (
            "\n\n---\nYanıtının en sonunda tek bir ```json bloğu içinde bulgularını şu yapıda ver:\n"
            f"{FINDINGS_SCHEMA}\nÖnem dereceleri yalnız critical, high, medium, low olabilir. "
            "Bulgu yoksa findings boş liste olsun."
        )
    if fmt == "decision":
        return f"\n\n---\nYanıtının en sonunda tek bir ```json bloğu içinde kararını şu yapıda ver:\n{DECISION_SCHEMA}"
    return ""


def retry_instructions(fmt: OutputFormat) -> str:
    schema = {"plan": PLAN_SCHEMA, "findings": FINDINGS_SCHEMA, "decision": DECISION_SCHEMA}.get(fmt, "{}")
    return (
        "Önceki yanıtındaki JSON bloğu okunamadı. Lütfen yalnız tek bir ```json bloğu gönder, başka metin "
        f"ekleme. Yapı:\n{schema}"
    )


def _loads(text: str) -> Any:
    candidates = [text]
    cleaned = text.replace("“", '"').replace("”", '"').replace("’", "'")
    cleaned = _TRAILING_COMMA.sub(r"\1", cleaned)
    if cleaned != text:
        candidates.append(cleaned)
    for c in candidates:
        try:
            return json.loads(c)
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def _balanced_objects(text: str) -> list[str]:
    """Top-level ``{...}`` substrings (string-aware brace matching)."""
    out: list[str] = []
    depth = 0
    start = -1
    in_str = False
    escape = False
    for i, ch in enumerate(text):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                out.append(text[start : i + 1])
                start = -1
    return out


def extract_json(text: str | None) -> dict[str, Any] | None:
    """Best-effort extraction of the final JSON object from an agent answer."""
    if not text:
        return None
    fences = _FENCE.findall(text)
    json_fences = [body for lang, body in fences if lang.lower() in ("json", "jsonc")]
    for body in reversed(json_fences):
        value = _loads(body.strip())
        if isinstance(value, dict):
            return value
    for _lang, body in reversed(fences):
        value = _loads(body.strip())
        if isinstance(value, dict):
            return value
    for chunk in reversed(_balanced_objects(text)):
        value = _loads(chunk)
        if isinstance(value, dict):
            return value
    return None


def strip_json_block(text: str) -> str:
    """The answer without its trailing JSON fence (for display)."""
    matches = list(_FENCE.finditer(text))
    if not matches:
        return text.strip()
    last = matches[-1]
    if last.group(1).lower() in ("json", "jsonc", "") and not text[last.end() :].strip():
        return text[: last.start()].rstrip().rstrip("-").rstrip()
    return text.strip()


def normalize_severity(value: Any) -> str:
    key = str(value or "").strip().lower()
    return _SEVERITY_ALIASES.get(key, "medium")


def normalize_findings(obj: dict[str, Any] | None) -> list[dict[str, Any]] | None:
    """Return normalized findings or None when the object has no findings list."""
    if obj is None:
        return None
    raw = obj.get("findings")
    if raw is None:
        raw = obj.get("issues")
    if raw is None:
        return None
    if not isinstance(raw, list):
        return None
    out: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, str):
            out.append({"severity": "medium", "file": None, "line": None, "message": item})
            continue
        if not isinstance(item, dict):
            continue
        line = item.get("line")
        try:
            line_no = int(line) if line not in (None, "") else None
        except (TypeError, ValueError):
            line_no = None
        file = item.get("file") or item.get("path")
        message = item.get("message") or item.get("description") or item.get("title") or ""
        out.append(
            {
                "severity": normalize_severity(item.get("severity") or item.get("level")),
                "file": str(file) if file else None,
                "line": line_no,
                "message": str(message).strip(),
            }
        )
    return out


def normalize_plan(obj: dict[str, Any] | None) -> dict[str, Any] | None:
    if obj is None:
        return None
    steps_raw = obj.get("steps")
    if not isinstance(steps_raw, list):
        return None
    steps: list[dict[str, Any]] = []
    for s in steps_raw:
        if isinstance(s, str):
            steps.append({"title": s, "detail": "", "files": []})
        elif isinstance(s, dict):
            files = s.get("files") or []
            steps.append(
                {
                    "title": str(s.get("title") or s.get("name") or ""),
                    "detail": str(s.get("detail") or s.get("description") or ""),
                    "files": [str(f) for f in files] if isinstance(files, list) else [],
                }
            )
    risks = obj.get("risks") or []
    return {
        "summary": str(obj.get("summary") or ""),
        "steps": steps,
        "risks": [str(r) for r in risks] if isinstance(risks, list) else [],
    }


def normalize_decision(obj: dict[str, Any] | None) -> dict[str, Any] | None:
    if obj is None or not obj.get("decision"):
        return None

    def as_list(v: Any) -> list[str]:
        return [str(x) for x in v] if isinstance(v, list) else ([str(v)] if v else [])

    return {
        "decision": str(obj.get("decision")),
        "rationale": str(obj.get("rationale") or ""),
        "options": as_list(obj.get("options")),
        "risks": as_list(obj.get("risks")),
        "next_steps": as_list(obj.get("next_steps")),
    }


def parse_structured(fmt: OutputFormat, text: str | None) -> dict[str, Any] | None:
    """Parse the structured part of an answer for the given format; None when unreadable."""
    obj = extract_json(text)
    if fmt == "plan":
        return normalize_plan(obj)
    if fmt == "findings":
        findings = normalize_findings(obj)
        if findings is None:
            return None
        assert obj is not None
        verdict = str(obj.get("verdict") or "").lower()
        return {"verdict": verdict or None, "summary": str(obj.get("summary") or ""), "findings": findings}
    if fmt == "decision":
        return normalize_decision(obj)
    return None


DECISION_SECTIONS: tuple[str, ...] = ("Bağlam", "Seçenekler", "Karar", "Gerekçe", "Riskler", "Sonraki adımlar")


def missing_sections(markdown: str) -> list[str]:
    """Decision-document sections (``## Başlık``) that are missing from the Markdown."""
    headings = {
        m.group(1).strip().lower() for m in re.finditer(r"^#{1,4}\s+(.+?)\s*#*\s*$", markdown, flags=re.MULTILINE)
    }
    return [s for s in DECISION_SECTIONS if s.lower() not in headings]
