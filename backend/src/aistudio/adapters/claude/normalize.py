"""Translate Claude Code's native messages (live stream-json frames and transcript records) into
the normalized payloads of ``contracts/agents.py``.

The normalizer is stateful per session: it remembers tool calls (to attach file changes to the
right tool result), the partially streamed content blocks (to give a streamed block and its final
assistant frame the same ``message_id``), the latest context size and the CLI-native subagents
(``SubagentTracker``): frames with ``parent_tool_use_id`` become payloads tagged with
``subagent_id`` and never change the main thread's state.
"""

from __future__ import annotations

import re
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from aistudio.adapters.claude.protocol import as_dict, as_float, as_int, as_list, as_str
from aistudio.adapters.claude.subagents import SUBAGENT_TOOLS, SubagentTracker
from aistudio.adapters.claude.toolinfo import EDIT_TOOLS, rel_path, tool_kind, tool_summary
from aistudio.contracts.agents import (
    AgentErrorEv,
    AgentEventPayload,
    AgentState,
    FileChanged,
    Message,
    MessageDelta,
    Thinking,
    ThinkingDelta,
    ToolCall,
    ToolResultEv,
    Usage,
)
from aistudio.core.text import truncate

TOOL_OUTPUT_LIMIT = 64 * 1024
DIFF_LIMIT = 64 * 1024
_STREAM_MEMORY = 8  # message ids whose streamed blocks we remember
_BLOCK_MEMORY = 256  # message ids whose used block indexes we remember (parallel subagents interleave)
_EXIT_CODE_RE = re.compile(r"Exit code (-?\d+)")

# Turkish texts for the CLI's assistant-message error codes.
_API_ERRORS: dict[str, tuple[str, bool]] = {
    "authentication_failed": ("Claude girişi geçersiz. Terminalde `claude auth login` çalıştırın.", False),
    "oauth_org_not_allowed": ("Bu Claude hesabının organizasyonu bu kullanıma izin vermiyor.", False),
    "account_on_hold": ("Claude hesabı askıya alınmış.", False),
    "verification_required": ("Claude hesabı doğrulama bekliyor.", False),
    "billing_error": ("Claude faturalandırma hatası.", False),
    "rate_limit": ("Claude kullanım limitine ulaşıldı.", True),
    "overloaded": ("Claude şu anda aşırı yüklü, biraz sonra tekrar denenecek.", True),
    "invalid_request": ("Claude isteği geçersiz buldu.", False),
    "model_not_found": ("İstenen Claude modeli bulunamadı.", False),
    "server_error": ("Claude sunucu hatası.", True),
    "max_output_tokens": ("Yanıt azami çıktı uzunluğuna ulaştı.", False),
    "unknown": ("Claude bilinmeyen bir hata döndürdü.", True),
}


def api_error_event(code: str, detail: str | None = None) -> AgentErrorEv:
    message, retryable = _API_ERRORS.get(code, (f"Claude hatası: {code}", False))
    if detail:
        message = f"{message} ({truncate(detail, 300, marker='…')})"
    return AgentErrorEv(message=message, retryable=retryable, code=code)


def content_text(content: Any) -> str:
    """Text of a message/tool_result ``content`` (string or block list)."""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for block in as_list(content):
        b = as_dict(block)
        btype = as_str(b.get("type"))
        if btype == "text":
            parts.append(as_str(b.get("text")) or "")
        elif btype == "image":
            parts.append("[görsel]")
        elif btype == "document":
            parts.append("[belge]")
        elif btype == "tool_reference":
            name = as_str(b.get("tool_name"))
            if name:
                parts.append(f"[araç: {name}]")
    return "\n".join(p for p in parts if p)


def diff_from_structured_patch(path: str, hunks: list[Any]) -> str | None:
    """Unified diff from the CLI's ``structuredPatch`` hunks."""
    lines = [f"--- a/{path}", f"+++ b/{path}"]
    count = 0
    for raw in hunks:
        hunk = as_dict(raw)
        body = [line for line in as_list(hunk.get("lines")) if isinstance(line, str)]
        old_start = as_int(hunk.get("oldStart")) or 0
        old_lines = as_int(hunk.get("oldLines")) or 0
        new_start = as_int(hunk.get("newStart")) or 0
        new_lines = as_int(hunk.get("newLines")) or 0
        lines.append(f"@@ -{old_start},{old_lines} +{new_start},{new_lines} @@")
        lines.extend(body)
        count += 1
    if not count:
        return None
    return truncate("\n".join(lines) + "\n", DIFF_LIMIT)


def diff_for_new_file(path: str, content: str) -> str:
    body = content.splitlines()
    head = ["--- /dev/null", f"+++ b/{path}", f"@@ -0,0 +1,{len(body)} @@"]
    return truncate("\n".join([*head, *(f"+{line}" for line in body)]) + "\n", DIFF_LIMIT)


def file_change(tool: str, args: dict[str, Any], result: Any, cwd: str | None, *, is_error: bool) -> FileChanged | None:
    """``FileChanged`` for a finished edit tool call, using the structured tool output
    (``tool_use_result`` live / ``toolUseResult`` in transcripts) when available."""
    if tool not in EDIT_TOOLS or is_error:
        return None
    res = as_dict(result)
    path = as_str(res.get("filePath")) or as_str(args.get("file_path")) or as_str(args.get("notebook_path"))
    if not path:
        return None
    rel = rel_path(path, cwd)
    change: str = "modify"
    if tool == "Write":
        kind = as_str(res.get("type"))
        if kind == "create" or (kind is None and "originalFile" in res and res.get("originalFile") is None):
            change = "add"
    diff: str | None = None
    hunks = as_list(res.get("structuredPatch"))
    if hunks:
        diff = diff_from_structured_patch(rel, hunks)
    elif change == "add":
        content = as_str(res.get("content")) or as_str(args.get("content"))
        if content is not None:
            diff = diff_for_new_file(rel, content)
    return FileChanged(path=rel, change="add" if change == "add" else "modify", diff=diff)


def context_tokens(usage: Any) -> int | None:
    """Tokens in context for one API call: everything sent plus what was generated."""
    u = as_dict(usage)
    if not u:
        return None
    total = 0
    seen = False
    for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"):
        value = as_int(u.get(key))
        if value is not None:
            total += value
            seen = True
    return total if seen else None


def context_window(model_usage: Any, model: str | None) -> int | None:
    entries = as_dict(model_usage)
    if not entries:
        return None
    if model:
        for key in (model, model.split("[", 1)[0]):
            win = as_int(as_dict(entries.get(key)).get("contextWindow"))
            if win:
                return win
    best: tuple[int, int] | None = None  # (output tokens, window) of the busiest model
    for raw in entries.values():
        e = as_dict(raw)
        win = as_int(e.get("contextWindow"))
        if not win:
            continue
        key = (as_int(e.get("outputTokens")) or 0, win)
        if best is None or key > best:
            best = key
    return best[1] if best else None


def build_usage(
    result: dict[str, Any], *, model: str | None, context_used: int | None, cost_delta: float | None
) -> Usage:
    u = as_dict(result.get("usage"))
    details = as_dict(u.get("output_tokens_details"))
    return Usage(
        input_tokens=as_int(u.get("input_tokens")) or 0,
        output_tokens=as_int(u.get("output_tokens")) or 0,
        cache_read_tokens=as_int(u.get("cache_read_input_tokens")) or 0,
        cache_write_tokens=as_int(u.get("cache_creation_input_tokens")) or 0,
        reasoning_tokens=as_int(details.get("thinking_tokens")) or 0,
        context_used=context_used,
        context_window=context_window(result.get("modelUsage"), model),
        duration_ms=as_int(result.get("duration_ms")),
        api_equivalent_usd=cost_delta,
        turns=as_int(result.get("num_turns")),
    )


def exit_code_of(tool: str, output: str, is_error: bool) -> int | None:
    if tool not in ("Bash", "PowerShell"):
        return None
    if not is_error:
        return 0
    m = _EXIT_CODE_RE.search(output)
    return int(m.group(1)) if m else None


@dataclass
class Normalized:
    payloads: list[AgentEventPayload] = field(default_factory=list)
    state: AgentState | None = None  # suggested status for the main thread
    detail: str | None = None


@dataclass
class _Call:
    name: str
    args: dict[str, Any]
    main: bool


def _family(block_type: str) -> str:
    if block_type in ("thinking", "redacted_thinking"):
        return "thinking"
    if block_type in ("tool_use", "server_tool_use"):
        return "tool_use"
    return block_type


class ClaudeNormalizer:
    def __init__(self, cwd: str | None) -> None:
        self.cwd = cwd
        self.model: str | None = None
        self.context_used: int | None = None
        self._calls: dict[str, _Call] = {}
        self._pending_main: set[str] = set()
        self._streams: OrderedDict[str, dict[int, str]] = OrderedDict()  # msg id -> index -> type
        self._consumed: OrderedDict[str, set[int]] = OrderedDict()  # msg id -> block indexes used
        self._stream_msg: str | None = None
        self._prompt_tokens: int | None = None  # context of the streaming call before output
        self.subagents = SubagentTracker()

    @property
    def pending_main_tools(self) -> int:
        return len(self._pending_main)

    def tool_name(self, call_id: str) -> str | None:
        call = self._calls.get(call_id)
        return call.name if call else None

    def reset_turn(self) -> None:
        """Forget per-turn transient state (pending tool calls of an aborted turn)."""
        self._pending_main.clear()

    # ------------------------------------------------------------------ stream events

    def stream_event(self, msg: dict[str, Any]) -> Normalized:
        if msg.get("parent_tool_use_id"):
            # The CLI streams partial events for the main thread only (verified in 2.1.288);
            # subagent text arrives as complete frames (--forward-subagent-text).
            return Normalized()
        event = as_dict(msg.get("event"))
        etype = as_str(event.get("type"))
        out = Normalized()
        if etype == "message_start":
            message = as_dict(event.get("message"))
            msg_id = as_str(message.get("id")) or as_str(msg.get("uuid")) or "msg"
            self._stream_msg = msg_id
            self._remember_stream(msg_id)
            usage = as_dict(message.get("usage"))
            prompt = context_tokens({**usage, "output_tokens": 0}) if usage else None
            if prompt:
                self._prompt_tokens = prompt
                self.context_used = prompt + (as_int(usage.get("output_tokens")) or 0)
        elif etype == "content_block_start":
            index = as_int(event.get("index")) or 0
            block = as_dict(event.get("content_block"))
            btype = as_str(block.get("type")) or "text"
            if self._stream_msg is not None:
                self._streams.setdefault(self._stream_msg, {})[index] = btype
            if _family(btype) == "thinking":
                out.state = AgentState.thinking
            else:
                out.state = AgentState.responding
        elif etype == "content_block_delta":
            index = as_int(event.get("index")) or 0
            delta = as_dict(event.get("delta"))
            dtype = as_str(delta.get("type"))
            msg_id = f"{self._stream_msg or 'msg'}:{index}"
            if dtype == "text_delta":
                text = as_str(delta.get("text")) or ""
                if text:
                    out.payloads.append(MessageDelta(message_id=msg_id, text=text))
                    out.state = AgentState.responding
            elif dtype == "thinking_delta":
                text = as_str(delta.get("thinking")) or ""
                if text:
                    out.payloads.append(ThinkingDelta(message_id=msg_id, text=text))
                    out.state = AgentState.thinking
        elif etype == "message_delta":
            # final output token count of the streaming call
            out_tokens = as_int(as_dict(event.get("usage")).get("output_tokens"))
            if out_tokens is not None and self._prompt_tokens is not None:
                self.context_used = self._prompt_tokens + out_tokens
        return out

    def _remember_stream(self, msg_id: str) -> None:
        self._streams[msg_id] = {}
        self._streams.move_to_end(msg_id)
        while len(self._streams) > _STREAM_MEMORY:
            self._streams.popitem(last=False)

    def _consumed_for(self, msg_id: str) -> set[int]:
        consumed = self._consumed.get(msg_id)
        if consumed is None:
            consumed = self._consumed[msg_id] = set()
            while len(self._consumed) > _BLOCK_MEMORY:
                self._consumed.popitem(last=False)
        return consumed

    def _block_index(self, msg_id: str, block_type: str) -> int:
        """Index of this content block within its API message. The CLI emits one assistant frame
        per completed block; we pair it with the streamed block of the same family."""
        consumed = self._consumed_for(msg_id)
        streamed = self._streams.get(msg_id)
        if streamed:
            fam = _family(block_type)
            for idx in sorted(streamed):
                if idx not in consumed and _family(streamed[idx]) == fam:
                    consumed.add(idx)
                    return idx
        n = 0
        while n in consumed:
            n += 1
        consumed.add(n)
        return n

    # ------------------------------------------------------------------ complete frames

    def assistant(self, msg: dict[str, Any]) -> Normalized:
        parent = as_str(msg.get("parent_tool_use_id"))
        main = not parent
        message = as_dict(msg.get("message"))
        msg_id = as_str(message.get("id")) or as_str(msg.get("uuid")) or "msg"
        model = as_str(message.get("model"))
        out = Normalized()
        if parent:
            out.payloads += self.subagents.frame(parent, msg, assistant=True)
        if main and model and not model.startswith("<"):
            self.model = model
        if main and msg_id != self._stream_msg:
            # not streamed (partial messages off, or a transcript record): use the frame usage
            ctx = context_tokens(message.get("usage"))
            if ctx:
                self.context_used = ctx
        error = as_str(msg.get("error"))
        if error:
            if main:
                out.payloads.append(api_error_event(error, content_text(message.get("content")) or None))
            return out  # inside a subagent: surfaces as the subagent's failed result
        for raw in as_list(message.get("content")):
            block = as_dict(raw)
            btype = as_str(block.get("type")) or ""
            if btype in ("text", "thinking", "redacted_thinking", "tool_use"):
                index = self._block_index(msg_id, btype)
            else:
                continue
            block_id = f"{msg_id}:{index}"
            if btype == "text":
                text = as_str(block.get("text")) or ""
                if text.strip():
                    out.payloads.append(Message(message_id=block_id, role="assistant", text=text, subagent_id=parent))
                    if parent:
                        self.subagents.note_text(parent, text)
            elif btype == "thinking":
                text = as_str(block.get("thinking")) or ""
                if text.strip():
                    out.payloads.append(Thinking(message_id=block_id, text=text, subagent_id=parent))
            elif btype == "tool_use":
                call = self.tool_call(block, main=main, subagent_id=parent)
                if call is not None:
                    out.payloads.append(call)
                    if call.tool in SUBAGENT_TOOLS:
                        out.payloads += self.subagents.spawned(block, parent=parent)
                    if main:
                        out.state = AgentState.running_tool
                        out.detail = call.summary
        return out

    def tool_call(self, block: dict[str, Any], *, main: bool, subagent_id: str | None = None) -> ToolCall | None:
        call_id = as_str(block.get("id"))
        name = as_str(block.get("name"))
        if not call_id or not name:
            return None
        args = as_dict(block.get("input"))
        self._calls[call_id] = _Call(name=name, args=args, main=main)
        self.subagents.note_call(call_id, subagent_id)
        if main:
            self._pending_main.add(call_id)
        return ToolCall(
            call_id=call_id,
            tool=name,
            kind=tool_kind(name),
            input=args,
            summary=tool_summary(name, args, self.cwd),
            subagent_id=subagent_id,
        )

    def user(self, msg: dict[str, Any], *, tool_use_result: Any = None) -> Normalized:
        """Tool results (and the file changes they imply). Plain user text is not echoed."""
        parent = as_str(msg.get("parent_tool_use_id"))
        main = not parent
        message = as_dict(msg.get("message"))
        content = message.get("content")
        out = Normalized()
        results = [as_dict(b) for b in as_list(content) if as_dict(b).get("type") == "tool_result"]
        if parent and results:
            out.payloads += self.subagents.frame(parent, msg, assistant=False)
        structured = tool_use_result if tool_use_result is not None else msg.get("tool_use_result")
        for block in results:
            call_id = as_str(block.get("tool_use_id"))
            if not call_id:
                continue
            is_error = bool(block.get("is_error"))
            output = content_text(block.get("content"))
            call = self._calls.get(call_id)
            name = call.name if call else ""
            single = structured if len(results) == 1 else None
            out.payloads.append(
                ToolResultEv(
                    call_id=call_id,
                    output=truncate(output, TOOL_OUTPUT_LIMIT),
                    is_error=is_error,
                    exit_code=exit_code_of(name, output, is_error),
                    subagent_id=parent,
                )
            )
            if call is not None:
                change = file_change(call.name, call.args, single, self.cwd, is_error=is_error)
                if change is not None:
                    out.payloads.append(change.model_copy(update={"subagent_id": parent}) if parent else change)
            out.payloads += self.subagents.tool_result(call_id, is_error=is_error, output=output, structured=single)
            self._pending_main.discard(call_id)
        if results and main and not self._pending_main:
            out.state = AgentState.thinking
        return out


def cost_of(result: dict[str, Any]) -> float | None:
    return as_float(result.get("total_cost_usd"))
