"""Sandboxed Jinja2 rendering for prompt templates and condition expressions.

Variables (see ``contracts/flows.py``): ``input``, ``nodes.<id>.output|data|status``,
``memory.context|facts|boundaries|decisions``, ``review.findings``, ``gate.<id>.evidence``,
``task``, ``workspace``, ``repo.<name>``. The engine adds ``feedback.text|gate|round`` (why a
node is re-run inside a loop) and ``attempt``. Missing values render as empty strings.
"""

from __future__ import annotations

import json
from typing import Any

from jinja2 import ChainableUndefined, TemplateError, TemplateSyntaxError
from jinja2.sandbox import SandboxedEnvironment

from aistudio.core.errors import ValidationFailed
from aistudio.core.text import truncate


class TemplateFailed(ValidationFailed):
    code = "template_failed"


def _json_filter(value: Any, indent: int | None = 2) -> str:
    """``| json`` (indented) or ``| json(0)`` (compact, one line)."""
    return json.dumps(value, ensure_ascii=False, indent=indent or None, default=str)


def format_findings(findings: Any) -> str:
    """Markdown bullet list of normalized findings."""
    if not isinstance(findings, list) or not findings:
        return ""
    lines: list[str] = []
    for f in findings:
        if not isinstance(f, dict):
            lines.append(f"- {f}")
            continue
        loc = ""
        if f.get("file"):
            loc = f" `{f['file']}" + (f":{f['line']}" if f.get("line") else "") + "`"
        lines.append(f"- [{str(f.get('severity', 'medium')).upper()}]{loc} {f.get('message', '')}".rstrip())
    return "\n".join(lines)


def _make_env() -> SandboxedEnvironment:
    env = SandboxedEnvironment(
        undefined=ChainableUndefined,
        autoescape=False,
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=False,
    )
    env.filters["json"] = _json_filter
    env.filters["findings"] = format_findings
    env.filters["clip"] = lambda value, limit=4000: truncate(str(value), int(limit))
    return env


_ENV = _make_env()


def render(template: str, variables: dict[str, Any]) -> str:
    if not template:
        return ""
    try:
        return _ENV.from_string(template).render(**variables).strip()
    except TemplateSyntaxError as e:
        raise TemplateFailed(f"Şablon hatası (satır {e.lineno}): {e.message}") from e
    except TemplateError as e:
        raise TemplateFailed(f"Şablon işlenemedi: {e}") from e
    except (ArithmeticError, TypeError, ValueError, LookupError) as e:  # sandbox limits, bad filters
        raise TemplateFailed(f"Şablon işlenemedi: {e}") from e


def evaluate(expression: str, variables: dict[str, Any]) -> bool:
    try:
        fn = _ENV.compile_expression(expression, undefined_to_none=True)
        return bool(fn(**variables))
    except TemplateSyntaxError as e:
        raise TemplateFailed(f"Koşul ifadesi hatalı: {e.message}") from e
    except (TemplateError, ArithmeticError, TypeError, ValueError, LookupError) as e:
        raise TemplateFailed(f"Koşul ifadesi değerlendirilemedi: {e}") from e


def check_template(template: str | None) -> str | None:
    """Return a Turkish error message when the template does not parse."""
    if not template:
        return None
    try:
        _ENV.parse(template)
    except TemplateSyntaxError as e:
        return f"Şablon hatası (satır {e.lineno}): {e.message}"
    return None


def check_expression(expression: str) -> str | None:
    if not expression.strip():
        return "Koşul ifadesi boş olamaz."
    try:
        _ENV.compile_expression(expression)
    except TemplateSyntaxError as e:
        return f"Koşul ifadesi hatalı: {e.message}"
    return None
