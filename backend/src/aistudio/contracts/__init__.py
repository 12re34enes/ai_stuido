"""Cross-module contracts: shared models and service Protocols.

Modules depend on each other ONLY through these. A module registers its implementation
with ``ctx.services.register(<Protocol>, impl)`` and consumers call
``ctx.services.get(<Protocol>)``. Changing a contract is a cross-team change: update the
implementer and every consumer in the same commit.
"""
