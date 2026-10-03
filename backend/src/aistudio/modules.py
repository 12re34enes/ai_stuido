"""Ordered list of feature modules. Each path must contain ``module.py`` exposing ``module``.

Order = setup order. Services are looked up lazily, so order only matters for work done
inside ``setup`` itself. Foundation modules come first.
"""

MODULES: tuple[str, ...] = (
    "aistudio.workspaces",
    "aistudio.approvals",
    "aistudio.tools",
    "aistudio.agents",  # agent manager, profiles, sessions, policy, local transport, discovery
    "aistudio.limits",
    "aistudio.adapters.claude",
    "aistudio.adapters.codex",
    "aistudio.gitops",  # worktrees, merge, checkpoints, conflict watch
    "aistudio.memory",
    "aistudio.engine",  # flows, tasks, runs, gates, scheduler, replay/export
    "aistudio.studios",
    "aistudio.remote",  # ssh/db profiles, classification, audit, ssh transport
    "aistudio.deploy",
    "aistudio.git_hosting",
    "aistudio.alerts",
    "aistudio.backup",
)
