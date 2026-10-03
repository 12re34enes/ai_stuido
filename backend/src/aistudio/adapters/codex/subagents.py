"""Codex sub-agents of one session -> :class:`SubagentStarted` / :class:`SubagentCompleted`.

Facts (codex-rs 0.160.0 source: ``app-server/src/lib.rs``, ``bespoke_event_handling.rs``,
``app-server-protocol/src/protocol/v2/item.rs``, ``core/src/tools/handlers/multi_agents*``):

* AI Studio runs one app-server process per session, so every thread in it is ours: the main
  thread and the sub-agent threads spawned below it. The app-server attaches a listener to every
  thread its ThreadManager creates (``thread_created`` -> ``try_attach_thread_listener``), so a
  sub-agent's items, deltas, turns, token usage and approval requests arrive on our connection
  with the sub-agent's ``threadId``. **No ``thread/started`` is sent for spawned sub-agents.**
* Multi-agent v1 tools surface as ``collabAgentToolCall`` items in the *sender's* thread:
  ``{id, tool: spawnAgent | sendInput | resumeAgent | wait | closeAgent, status, senderThreadId,
  receiverThreadIds, prompt, model, reasoningEffort, agentsStates: {threadId: {status, message}}}``.
  ``spawnAgent`` starts with ``receiverThreadIds: []`` and completes with the new thread id;
  ``agentsStates[..].status`` is ``pendingInit | running | interrupted | completed | errored |
  shutdown | notFound`` and ``message`` is the agent's final answer (completed) or error.
* Multi-agent v2 surfaces ``subAgentActivity`` items ``{id, kind: started | interacted |
  interrupted | completed, agentThreadId, agentPath}`` in the initiating thread (``started`` uses
  the spawn call id; ``agentPath`` looks like ``/root/task_3``).
* ``thread/read`` of a sub-agent thread gives ``parentThreadId``, ``agentNickname`` and
  ``agentRole`` (``source.subAgent.thread_spawn`` carries the same plus ``depth``).

``subagent_id`` is the sub-agent's thread id. Methods return the payloads to emit, in order.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Literal

from aistudio.adapters.codex import protocol as p
from aistudio.contracts.agents import SubagentCompleted, SubagentStarted, Usage
from aistudio.core.text import truncate

PROMPT_LIMIT = 2000
RESULT_LIMIT = 4000
DESCRIPTION_LIMIT = 120

SubStatus = Literal["success", "error", "interrupted"]
AGENT_STATE_END: dict[str, SubStatus] = {
    "completed": "success",
    "errored": "error",
    "notFound": "error",
    "interrupted": "interrupted",
    "shutdown": "interrupted",
}
TURN_END: dict[str, SubStatus] = {"completed": "success", "failed": "error", "interrupted": "interrupted"}


def _short(text: str | None, limit: int) -> str | None:
    if not text or not text.strip():
        return None
    return truncate(text.strip(), limit, marker="…")


def _description(prompt: str | None) -> str | None:
    if not prompt:
        return None
    first = next((ln.strip() for ln in prompt.splitlines() if ln.strip()), "")
    return _short(" ".join(first.split()), DESCRIPTION_LIMIT)


def _name_from_path(path: str | None) -> str | None:
    if not path:
        return None
    return path.rstrip("/").rsplit("/", 1)[-1] or None


def thread_name(thread: p.Thread) -> str | None:
    """Role (``explorer``, ``worker``) when it says something, else the nickname."""
    role = thread.agent_role
    if role and role != "default":
        return role
    if thread.agent_nickname:
        return thread.agent_nickname
    if role:
        return role
    source = thread.source
    if isinstance(source, dict):
        sub = source.get("subAgent")
        if isinstance(sub, str):  # review | compact | memory_consolidation
            return sub
    return None


def thread_parent(thread: p.Thread) -> str | None:
    if thread.parent_thread_id:
        return thread.parent_thread_id
    source = thread.source
    if isinstance(source, dict):
        spawn = (source.get("subAgent") or {}).get("thread_spawn") if isinstance(source.get("subAgent"), dict) else None
        if isinstance(spawn, dict) and isinstance(spawn.get("parent_thread_id"), str):
            return spawn["parent_thread_id"]
    return None


@dataclass
class CodexSub:
    id: str
    parent: str | None = None
    parent_call_id: str | None = None
    name: str | None = None
    description: str | None = None
    prompt: str | None = None
    model: str | None = None
    done: bool = False
    last_text: str | None = None
    enriched: bool = False

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


@dataclass
class _PendingSpawn:
    call_id: str
    sender: str
    prompt: str | None
    model: str | None
    claimed_by: str | None = None


class CodexSubagents:
    def __init__(self, main_thread_id: str | None = None) -> None:
        self.main_thread_id = main_thread_id
        self.subs: dict[str, CodexSub] = {}
        self._pending: OrderedDict[str, _PendingSpawn] = OrderedDict()  # spawnAgent call id -> spawn
        self._usage: dict[str, Usage] = {}

    # ------------------------------------------------------------------ queries

    def is_main(self, thread_id: str | None) -> bool:
        return thread_id is None or thread_id == self.main_thread_id

    def get(self, thread_id: str) -> CodexSub | None:
        return self.subs.get(thread_id)

    def running(self) -> list[str]:
        return [s.id for s in self.subs.values() if not s.done]

    def usage(self, thread_id: str) -> Usage | None:
        return self._usage.get(thread_id)

    def _parent_of(self, sender: str | None) -> str | None:
        """Subagent id of the thread that spawned something (None = the main thread)."""
        if sender is None or self.is_main(sender):
            return None
        return sender if sender in self.subs else None

    # ------------------------------------------------------------------ registration

    def _register(self, sub: CodexSub) -> list[SubagentStarted]:
        self.subs[sub.id] = sub
        return [sub.started()]

    @staticmethod
    def _fill(sub: CodexSub, **values: str | None) -> bool:
        """Set fields that are still unknown; True when something was added."""
        changed = False
        for key, value in values.items():
            if value and getattr(sub, key) is None:
                setattr(sub, key, value)
                changed = True
        return changed

    def adopt(self, thread_id: str, *, activity: bool) -> tuple[CodexSub | None, list[SubagentStarted]]:
        """A notification for a thread we do not know yet: a freshly spawned sub-agent. It is
        matched to the oldest unclaimed in-progress ``spawnAgent``; without one it is adopted only
        on real activity (turn/item events), not on a bare status change."""
        sub = self.subs.get(thread_id)
        if sub is not None:
            return sub, []
        if self.is_main(thread_id):
            return None, []
        spawn = next((s for s in self._pending.values() if s.claimed_by is None), None)
        if spawn is None and not activity:
            return None, []
        sub = CodexSub(id=thread_id)
        if spawn is not None:
            spawn.claimed_by = thread_id
            sub.parent = self._parent_of(spawn.sender)
            sub.parent_call_id = spawn.call_id
            sub.prompt = spawn.prompt
            sub.description = _description(spawn.prompt)
            sub.model = spawn.model
        return sub, self._register(sub)

    def thread_started(self, thread: p.Thread) -> list[SubagentStarted]:
        """``thread/started`` for a thread with a parent (not sent for collab spawns in 0.160.0,
        but handled for detached reviews and future versions)."""
        if self.is_main(thread.id):
            return []
        if thread.id not in self.subs and thread_parent(thread) is None:
            return []
        sub, registered = self.adopt(thread.id, activity=True)
        if sub is None:
            return []
        changed = self._apply_thread(sub, thread)
        return [sub.started()] if registered or changed else []

    def enrich(self, thread_id: str, thread: p.Thread) -> list[SubagentStarted]:
        """Name / model / parent from ``thread/read``; re-announces when something was learned."""
        sub = self.subs.get(thread_id)
        if sub is None:
            return []
        return [sub.started()] if self._apply_thread(sub, thread) else []

    def _apply_thread(self, sub: CodexSub, thread: p.Thread) -> bool:
        sub.enriched = True
        changed = self._fill(sub, name=thread_name(thread), model=thread.model)
        parent = thread_parent(thread)
        if parent and not self.is_main(parent) and parent in self.subs and sub.parent != parent:
            sub.parent = parent
            changed = True
        return changed

    # ------------------------------------------------------------------ items

    def collab_started(self, item: p.CollabAgentToolCallItem, thread_id: str | None) -> list[SubagentStarted]:
        if item.tool == "spawnAgent" and item.id not in self._pending:
            self._pending[item.id] = _PendingSpawn(
                call_id=item.id,
                sender=item.sender_thread_id or thread_id or "",
                prompt=_short(item.prompt, PROMPT_LIMIT),
                model=item.model or None,
            )
        return []

    def collab_completed(
        self, item: p.CollabAgentToolCallItem, thread_id: str | None
    ) -> list[SubagentStarted | SubagentCompleted]:
        out: list[SubagentStarted | SubagentCompleted] = []
        sender = item.sender_thread_id or thread_id
        if item.tool == "spawnAgent":
            spawn = self._pending.pop(item.id, None)
            prompt = _short(item.prompt, PROMPT_LIMIT) or (spawn.prompt if spawn else None)
            model = item.model or (spawn.model if spawn else None)
            for tid in item.receiver_thread_ids:
                sub = self.subs.get(tid)
                if sub is None:
                    out += self._register(
                        CodexSub(
                            id=tid,
                            parent=self._parent_of(sender),
                            parent_call_id=item.id,
                            prompt=prompt,
                            description=_description(prompt),
                            model=model,
                        )
                    )
                    continue
                if sub.parent_call_id != item.id:
                    # adopted from another in-progress spawn (parallel spawns started out of
                    # order): this completion is authoritative; free the spawn it claimed
                    for pending in self._pending.values():
                        if pending.claimed_by == tid:
                            pending.claimed_by = None
                    sub.parent_call_id = item.id
                    sub.prompt = prompt
                    sub.description = _description(prompt)
                    sub.model = model or sub.model
                    changed = True
                else:
                    changed = self._fill(sub, prompt=prompt, model=model)
                    if sub.description is None and prompt:
                        sub.description = _description(prompt)
                        changed = True
                parent = self._parent_of(sender)
                if sub.parent != parent:
                    sub.parent = parent
                    changed = True
                if changed:
                    out.append(sub.started())
        for tid, state in (item.agents_states or {}).items():
            out += self.agent_state(tid, state)
        return out

    def agent_state(self, thread_id: str, state: Any) -> list[SubagentCompleted]:
        """``agentsStates`` entry of a collab item: terminal states end the sub-agent."""
        sub = self.subs.get(thread_id)
        if sub is None or sub.done or not isinstance(state, dict):
            return []
        status = AGENT_STATE_END.get(str(state.get("status")))
        if status is None:
            return []
        message = state.get("message") if isinstance(state.get("message"), str) else None
        return self.complete(thread_id, status, message)

    def activity(
        self, item: p.SubAgentActivityItem, thread_id: str | None
    ) -> list[SubagentStarted | SubagentCompleted]:
        """Multi-agent v2 ``subAgentActivity`` (idempotent across item/started and completed)."""
        tid = item.agent_thread_id
        sub = self.subs.get(tid)
        out: list[SubagentStarted | SubagentCompleted] = []
        if sub is None:
            if item.kind not in ("started", "interacted"):
                return []
            out += self._register(
                CodexSub(
                    id=tid,
                    parent=self._parent_of(thread_id),
                    parent_call_id=item.id if item.kind == "started" else None,
                    name=_name_from_path(item.agent_path),
                )
            )
            return out
        if item.kind in ("started", "interacted"):
            changed = self._fill(sub, name=_name_from_path(item.agent_path))
            if item.kind == "started" and sub.parent_call_id is None:
                sub.parent_call_id = item.id
                changed = True
            if sub.done:
                sub.done = False
                changed = True
            return [sub.started()] if changed else []
        if item.kind == "completed":
            return list(self.complete(tid, "success", None))
        if item.kind == "interrupted":
            return list(self.complete(tid, "interrupted", None))
        return []

    # ------------------------------------------------------------------ sub-agent thread events

    def note_text(self, thread_id: str, text: str) -> None:
        sub = self.subs.get(thread_id)
        if sub is not None and text.strip():
            sub.last_text = text

    def turn_started(self, thread_id: str) -> list[SubagentStarted]:
        sub = self.subs.get(thread_id)
        if sub is None or not sub.done:
            return []
        sub.done = False  # a finished sub-agent got new input (sendInput / followup)
        return [sub.started()]

    def turn_completed(self, thread_id: str, status: str, text: str | None) -> list[SubagentCompleted]:
        return self.complete(thread_id, TURN_END.get(status, "error"), text)

    def token_usage(self, thread_id: str, usage: p.ThreadTokenUsage) -> Usage:
        """Remember the sub-agent thread's cumulative usage (``total`` is per thread); reported
        in ``SubagentCompleted.usage``."""
        t = usage.total
        value = Usage(
            input_tokens=max(0, t.input_tokens - t.cached_input_tokens),
            output_tokens=t.output_tokens,
            cache_read_tokens=t.cached_input_tokens,
            cache_write_tokens=t.cache_write_input_tokens,
            reasoning_tokens=t.reasoning_output_tokens,
            context_used=usage.last.total_tokens or None,
            context_window=usage.model_context_window,
            subagent_id=thread_id,
        )
        self._usage[thread_id] = value
        return value

    def closed(self, thread_id: str) -> list[SubagentCompleted]:
        return self.complete(thread_id, "interrupted", None)

    def complete(self, thread_id: str, status: SubStatus, text: str | None) -> list[SubagentCompleted]:
        sub = self.subs.get(thread_id)
        if sub is None or sub.done:
            return []
        sub.done = True
        return [
            SubagentCompleted(
                subagent_id=thread_id,
                status=status,
                result_text=_short(text or sub.last_text, RESULT_LIMIT),
                usage=self._usage.get(thread_id),
            )
        ]

    def finish_all(self, status: SubStatus) -> list[SubagentCompleted]:
        out: list[SubagentCompleted] = []
        for tid in self.running():
            out += self.complete(tid, status, None)
        return out
