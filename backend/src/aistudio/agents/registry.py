"""Adapter registry (provider -> AgentAdapter). Registered by the agents module in ``setup`` so
adapter modules (set up later) can register themselves."""

from __future__ import annotations

from aistudio.contracts.agents import AgentAdapter
from aistudio.contracts.common import Provider
from aistudio.core.errors import Unavailable


class AdapterRegistryImpl:
    def __init__(self) -> None:
        self._adapters: dict[str, AgentAdapter] = {}

    def register(self, adapter: AgentAdapter) -> None:
        if adapter.provider in self._adapters:
            raise RuntimeError(f"adapter for {adapter.provider} registered twice")
        self._adapters[adapter.provider] = adapter

    def get(self, provider: Provider) -> AgentAdapter:
        try:
            return self._adapters[provider]
        except KeyError:
            raise Unavailable(f"{provider} adaptörü yüklü değil.") from None

    def all(self) -> list[AgentAdapter]:
        return list(self._adapters.values())
