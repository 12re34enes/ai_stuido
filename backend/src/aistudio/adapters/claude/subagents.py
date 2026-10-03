"""CLI-native subagents of a Claude Code session (the ``Agent`` tool, formerly ``Task``).

Turns the CLI's subagent signals into :class:`SubagentStarted` / :class:`SubagentCompleted` and
remembers which subagent every tool call belongs to. Used for live sessions and for history
replay. Wire facts (CLI 2.1.288, details in ``PROTOCOL.md`` "Subagents"):

* A subagent is spawned by a ``tool_use`` named ``Agent``/``Task`` with input ``description``,
  ``prompt``, ``subagent_type?``, ``model?`` (alias), ``run_in_background?``, ``name?``,
  ``isolation?``. Its ``subagent_id`` is that ``tool_use`` id.
* Every frame produced inside it carries ``parent_tool_use_id`` = the spawning ``tool_use`` id
  (for nested subagents: the inner spawner's id) plus ``subagent_type`` / ``task_description``.
  Tool use/result frames are always forwarded; text and thinking only with
  ``--forward-subagent-text``. No partial ``stream_event`` frames are produced for subagents.
* Foreground: the spawning ``tool_use``'s ``tool_result`` ends it; ``tool_use_result`` is
  ``{status: "completed", agentId, agentType, content: [{type: "text", text}], resolvedModel,
  totalDurationMs, totalTokens, totalToolUseCount, usage}`` where ``usage``/``totalTokens``
  describe only the *last* API call, so token totals are summed from the frames instead.
* Background (the default for ``Agent`` in 2.1.x): the ``tool_result`` comes back at once with
  ``{status: "async_launched", agentId, ...}``; the end is ``system/task_notification``
  ``{task_id: agentId, tool_use_id, status: completed | failed | stopped, summary,
  usage: {total_tokens, tool_uses, duration_ms}}`` (transcripts: a ``<task-notification>``
  queued command / prompt).
* ``system/task_started`` ``{task_id: agentId, tool_use_id, subagent_type, is_backgrounded,
  spawn_depth, task_type: "local_agent", prompt}``; ``task_updated`` patches the status.
* ``can_use_tool`` inside a subagent carries ``agent_id`` (= ``agentId`` = ``task_id``).
"""

from __future__ import annotations

import re
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Literal

from aistudio.adapters.claude.protocol import as_dict, as_int, as_list, as_str
from aistudio.contracts.agents import SubagentCompleted, SubagentStarted, Usage
from aistudio.core.text import truncate

SUBAGENT_TOOLS = frozenset({"Agent", "Task"})
PROMPT_LIMIT = 2000
RESULT_LIMIT = 4000
DESCRIPTION_LIMIT = 200
_ASYNC_STATUSES = frozenset({"async_launched", "remote_launched"})
_ASYNC_TEXT = "Async agent launched"
_INTERRUPT_TEXT = "[Request interrupted"
_MODEL_ALIASES = frozenset({"sonnet", "opus", "haiku", "fable", "inherit"})  # Agent tool `model` values

SubagentStatus = Literal["success", "error", "interrupted"]
TASK_STATUS: dict[str, SubagentStatus] = {
    "completed": "success",
    "failed": "error",
    "error": "error",
    "stopped": "interrupted",
    "killed": "interrupted",
}

_TAG_RE = {
    name: re.compile(rf"<{name}>([\s\S]*?)</{name}>")
    for name in ("task-id", "tool-use-id", "status", "summary", "result", "subagent_tokens", "tool_uses", "duration_ms")
}


def _context_tokens(usage: dict[str, Any]) -> int | None:
    total = 0
    seen = False
    for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"):
        value = as_int(usage.get(key))
        if value is not None:
            total += value
            seen = True
    return total if seen else None


def _short(text: str | None, limit: int) -> str | None:
    if not text or not text.strip():
        return None
    return truncate(text.strip(), limit, marker="…")


def parse_task_notification(text: str) -> dict[str, str] | None:
    """Fields of a ``<task-notification>`` block (transcripts / queued commands)."""
    if "<task-notification>" not in text:
        return None
    out: dict[str, str] = {}
    for name, rx in _TAG_RE.items():
        m = rx.search(text)
        if m:
            out[name] = m.group(1).strip()
    return out


@dataclass
class _Sub:
    id: str
    parent: str | None = None
    name: str | None = None
    description: str | None = None
    prompt: str | None = None
    model: str | None = None
    parent_call_id: str | None = None
    agent_id: str | None = None
    background: bool = False
    done: bool = False
    usages: OrderedDict[str, dict[str, Any]] = field(default_factory=OrderedDict)  # API message id -> usage
    last_text: str | None = None

    def started(self) -> SubagentStarted:
        return SubagentStarted(
            subagent_id=self.id,
            parent_call_id=self.parent_call_id,
            parent_subagent_id=self.parent,
            name=self.name,
            description=self.description,
            prompt=self.prompt,
            model=self.model,
        )


class SubagentTracker:
    """Per-session subagent bookkeeping. Methods return the payloads to emit (in order)."""

    def __init__(self) -> None:
        self.context_window: int | None = None  # the session's, learned from turn results
        self._subs: dict[str, _Sub] = {}
        self._by_agent: dict[str, str] = {}  # CLI agentId / task_id -> subagent id
        self._call_owner: dict[str, str] = {}  # tool_use id made inside a subagent -> subagent id

    # ------------------------------------------------------------------ queries

    def known(self, subagent_id: str) -> bool:
        return subagent_id in self._subs

    def running(self) -> list[str]:
        return [s.id for s in self._subs.values() if not s.done]

    def owner_of_call(self, call_id: str) -> str | None:
        return self._call_owner.get(call_id)

    def agent_subagent(self, agent_id: str) -> str | None:
        return self._by_agent.get(agent_id)

    def permission_subagent(self, tool_use_id: str | None, agent_id: str | None) -> str | None:
        """Subagent a ``can_use_tool`` request comes from (None = main thread)."""
        if tool_use_id and tool_use_id in self._call_owner:
            return self._call_owner[tool_use_id]
        if agent_id:
            if agent_id in self._by_agent:
                return self._by_agent[agent_id]
            running = [s for s in self._subs.values() if not s.done]
            if len(running) == 1:  # the only candidate (agentId not announced yet)
                return running[0].id
        return None

    # ------------------------------------------------------------------ spawn

    def note_call(self, call_id: str, subagent_id: str | None) -> None:
        if subagent_id:
            self._call_owner[call_id] = subagent_id

    def spawned(self, block: dict[str, Any], *, parent: str | None) -> list[SubagentStarted]:
        """A completed ``tool_use`` block named Agent/Task (``parent``: subagent it ran in)."""
        call_id = as_str(block.get("id"))
        if not call_id:
            return []
        args = as_dict(block.get("input"))
        existing = self._subs.get(call_id)
        if existing is not None:
            return self._enrich(
                existing,
                name=as_str(args.get("subagent_type")),
                description=_short(as_str(args.get("description")), DESCRIPTION_LIMIT),
                prompt=_short(as_str(args.get("prompt")), PROMPT_LIMIT),
            )
        sub = _Sub(
            id=call_id,
            parent=parent,
            parent_call_id=call_id,
            name=as_str(args.get("subagent_type")) or None,
            description=_short(as_str(args.get("description")), DESCRIPTION_LIMIT),
            prompt=_short(as_str(args.get("prompt")), PROMPT_LIMIT),
            model=as_str(args.get("model")) or None,
            background=args.get("run_in_background") is True,
        )
        self._subs[call_id] = sub
        return [sub.started()]

    def _lazy(self, subagent_id: str, frame: dict[str, Any]) -> tuple[_Sub, list[SubagentStarted]]:
        """Frames of a subagent whose spawn we did not see (e.g. resumed process)."""
        sub = self._subs.get(subagent_id)
        if sub is not None:
            return sub, []
        sub = _Sub(
            id=subagent_id,
            parent=self._call_owner.get(subagent_id),
            parent_call_id=subagent_id,
            name=as_str(frame.get("subagent_type")) or None,
            description=_short(as_str(frame.get("task_description")), DESCRIPTION_LIMIT),
        )
        self._subs[subagent_id] = sub
        return sub, [sub.started()]

    @staticmethod
    def _fill(sub: _Sub, **values: str | None) -> bool:
        """Set fields that are still unknown; True when something was added."""
        changed = False
        for key, value in values.items():
            if value and getattr(sub, key) is None:
                setattr(sub, key, value)
                changed = True
        return changed

    def _enrich(self, sub: _Sub, **values: str | None) -> list[SubagentStarted]:
        """Fill fields still unknown; re-announce the subagent when something was added."""
        return [sub.started()] if self._fill(sub, **values) else []

    # ------------------------------------------------------------------ frames inside a subagent

    def frame(self, subagent_id: str, msg: dict[str, Any], *, assistant: bool) -> list[SubagentStarted | Usage]:
        """An assistant/user frame with ``parent_tool_use_id``: register lazily, learn the model
        and track token usage. Returns payloads to emit before the frame's own payloads.

        A new API call's usage is emitted as the subagent's running total with ``partial=True``
        (live tokens and context in the UI); per-task sums skip partial usage, and the final
        totals arrive in ``SubagentCompleted.usage``."""
        sub, registered = self._lazy(subagent_id, msg)
        announce = bool(registered)
        if sub.done and assistant:  # resumed (SendMessage to a finished agent)
            sub.done = False
            announce = True
        model = as_str(as_dict(msg.get("message")).get("model"))
        if (
            assistant
            and model
            and not model.startswith("<")
            and sub.model != model
            and (sub.model is None or sub.model in _MODEL_ALIASES)
        ):
            sub.model = model  # the resolved id beats the alias given to the tool
            announce = True
        out: list[SubagentStarted | Usage] = [sub.started()] if announce else []
        if assistant and self._track_usage(sub, msg):
            out.append(self.usage(sub.id).model_copy(update={"partial": True}))
        return out

    @staticmethod
    def _track_usage(sub: _Sub, msg: dict[str, Any]) -> bool:
        """Latest usage per API message (one frame per content block, the last one wins);
        True when it changed."""
        message = as_dict(msg.get("message"))
        msg_id = as_str(message.get("id"))
        usage = as_dict(message.get("usage"))
        if not msg_id or not usage or sub.usages.get(msg_id) == usage:
            return False
        sub.usages[msg_id] = usage
        sub.usages.move_to_end(msg_id)
        return True

    def note_text(self, subagent_id: str, text: str) -> None:
        sub = self._subs.get(subagent_id)
        if sub is not None and text.strip():
            sub.last_text = text

    def usage(self, subagent_id: str, *, duration_ms: int | None = None, context_used: int | None = None) -> Usage:
        """Cumulative usage of a subagent so far (summed over its API calls)."""
        sub = self._subs[subagent_id]
        values = list(sub.usages.values())
        last = values[-1] if values else {}
        return Usage(
            input_tokens=sum(as_int(u.get("input_tokens")) or 0 for u in values),
            output_tokens=sum(as_int(u.get("output_tokens")) or 0 for u in values),
            cache_read_tokens=sum(as_int(u.get("cache_read_input_tokens")) or 0 for u in values),
            cache_write_tokens=sum(as_int(u.get("cache_creation_input_tokens")) or 0 for u in values),
            reasoning_tokens=sum(
                as_int(as_dict(u.get("output_tokens_details")).get("thinking_tokens")) or 0 for u in values
            ),
            context_used=context_used if context_used is not None else _context_tokens(last),
            context_window=self.context_window,
            duration_ms=duration_ms,
            turns=len(values) or None,
            subagent_id=subagent_id,
        )

    # ------------------------------------------------------------------ completion

    def _complete(
        self,
        sub: _Sub,
        status: SubagentStatus,
        text: str | None,
        *,
        duration_ms: int | None = None,
        context_used: int | None = None,
    ) -> list[SubagentCompleted]:
        if sub.done:
            return []
        sub.done = True
        usage = self.usage(sub.id, duration_ms=duration_ms, context_used=context_used)
        return [
            SubagentCompleted(
                subagent_id=sub.id, status=status, result_text=_short(text or sub.last_text, RESULT_LIMIT), usage=usage
            )
        ]

    def tool_result(
        self, call_id: str, *, is_error: bool, output: str, structured: Any
    ) -> list[SubagentStarted | SubagentCompleted]:
        """The ``tool_result`` of a spawning ``tool_use``: ends a foreground subagent; for a
        background one it only announces the CLI's agent id."""
        sub = self._subs.get(call_id)
        if sub is None:
            return []
        res = as_dict(structured)
        status = as_str(res.get("status"))
        agent_id = as_str(res.get("agentId"))
        if agent_id:
            sub.agent_id = agent_id
            self._by_agent[agent_id] = sub.id
        out: list[SubagentStarted | SubagentCompleted] = []
        out += self._enrich(
            sub,
            name=as_str(res.get("agentType")),
            description=_short(as_str(res.get("description")), DESCRIPTION_LIMIT),
            model=as_str(res.get("resolvedModel")),
        )
        if not is_error and (status in _ASYNC_STATUSES or (status is None and output.startswith(_ASYNC_TEXT))):
            sub.background = True
            return out
        if is_error:
            interrupted = _INTERRUPT_TEXT in output or "interrupted by user" in output.lower()
            return [*out, *self._complete(sub, "interrupted" if interrupted else "error", output or None)]
        texts = [as_str(as_dict(b).get("text")) or "" for b in as_list(res.get("content"))]
        text = "\n".join(t for t in texts if t).strip() or output
        out += self._complete(
            sub,
            "success",
            text,
            duration_ms=as_int(res.get("totalDurationMs")),
            context_used=as_int(res.get("totalTokens")),
        )
        return out

    def task_started(self, msg: dict[str, Any]) -> list[SubagentStarted]:
        """``system/task_started`` (only ``local_agent`` tasks are subagents)."""
        task_type = as_str(msg.get("task_type"))
        call_id = as_str(msg.get("tool_use_id"))
        if not call_id or (task_type is not None and task_type != "local_agent"):
            return []
        if task_type is None and msg.get("subagent_type") is None:
            return []
        task_id = as_str(msg.get("task_id"))
        sub = self._subs.get(call_id)
        out: list[SubagentStarted] = []
        if sub is None:
            sub = _Sub(
                id=call_id,
                parent=self._call_owner.get(call_id),
                parent_call_id=call_id,
                name=as_str(msg.get("subagent_type")) or None,
                description=_short(as_str(msg.get("description")), DESCRIPTION_LIMIT),
                prompt=_short(as_str(msg.get("prompt")), PROMPT_LIMIT),
            )
            self._subs[call_id] = sub
            out.append(sub.started())
        else:
            resumed = sub.done  # e.g. a SendMessage to a finished agent
            sub.done = False
            changed = self._fill(
                sub,
                name=as_str(msg.get("subagent_type")),
                description=_short(as_str(msg.get("description")), DESCRIPTION_LIMIT),
            )
            if resumed or changed:
                out.append(sub.started())
        if task_id:
            sub.agent_id = task_id
            self._by_agent[task_id] = sub.id
        if msg.get("is_backgrounded") is True:
            sub.background = True
        return out

    def _find(self, call_id: str | None, task_id: str | None) -> _Sub | None:
        if call_id and call_id in self._subs:
            return self._subs[call_id]
        if task_id and task_id in self._by_agent:
            return self._subs.get(self._by_agent[task_id])
        return None

    def task_updated(self, msg: dict[str, Any]) -> list[SubagentCompleted]:
        sub = self._find(None, as_str(msg.get("task_id")))
        if sub is None:
            return []
        patch = as_dict(msg.get("patch"))
        if patch.get("is_backgrounded") is True:
            sub.background = True
        status = TASK_STATUS.get(as_str(patch.get("status")) or "")
        if status is None:
            return []
        return self._complete(sub, status, as_str(patch.get("error")) if status == "error" else None)

    def task_notification(
        self,
        *,
        call_id: str | None,
        task_id: str | None,
        status: str | None,
        summary: str | None = None,
        result: str | None = None,
        total_tokens: int | None = None,
        duration_ms: int | None = None,
    ) -> list[SubagentCompleted]:
        """End of a (background) subagent: ``system/task_notification`` live, or a
        ``<task-notification>`` record in a transcript."""
        sub = self._find(call_id, task_id)
        if sub is None:
            return []
        mapped = TASK_STATUS.get(status or "", "success")
        text = result or (sub.last_text if mapped == "success" else None) or summary
        return self._complete(sub, mapped, text, duration_ms=duration_ms, context_used=total_tokens)

    def system_task_notification(self, msg: dict[str, Any]) -> list[SubagentCompleted]:
        usage = as_dict(msg.get("usage"))
        return self.task_notification(
            call_id=as_str(msg.get("tool_use_id")),
            task_id=as_str(msg.get("task_id")),
            status=as_str(msg.get("status")),
            summary=as_str(msg.get("summary")),
            total_tokens=as_int(usage.get("total_tokens")),
            duration_ms=as_int(usage.get("duration_ms")),
        )

    def text_notification(self, text: str, usage: Any = None) -> list[SubagentCompleted]:
        """A ``<task-notification>`` block (transcript prompt or queued command)."""
        fields = parse_task_notification(text)
        if not fields:
            return []
        u = as_dict(usage)
        tokens = as_int(u.get("totalTokens"))
        duration = as_int(u.get("durationMs"))
        if tokens is None and fields.get("subagent_tokens", "").isdigit():
            tokens = int(fields["subagent_tokens"])
        if duration is None and fields.get("duration_ms", "").isdigit():
            duration = int(fields["duration_ms"])
        result = fields.get("result")
        if result and result.startswith("This agent's report was delivered"):
            result = None
        return self.task_notification(
            call_id=fields.get("tool-use-id"),
            task_id=fields.get("task-id"),
            status=fields.get("status"),
            summary=fields.get("summary"),
            result=result,
            total_tokens=tokens,
            duration_ms=duration,
        )

    def finish(self, status: SubagentStatus, *, foreground_only: bool = False) -> list[SubagentCompleted]:
        """End subagents that cannot continue: foreground ones when their turn ended, all of
        them when the process exits."""
        out: list[SubagentCompleted] = []
        for sub in list(self._subs.values()):
            if sub.done or (foreground_only and sub.background):
                continue
            out += self._complete(sub, status, None)
        return out
