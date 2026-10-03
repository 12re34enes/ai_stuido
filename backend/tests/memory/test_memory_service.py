from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from memory_helpers import MemEnv, eventually

from aistudio.contracts.agents import Boundaries, SandboxLevel
from aistudio.core.errors import NotFound, ValidationFailed
from aistudio.core.events import EventFilter
from aistudio.memory.service import normalize_path
from aistudio.workspaces.service import WorkspaceCreate


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


def _root(env: MemEnv) -> Path:
    return env.ctx.settings.paths.memory_dir(env.ws.slug)


async def test_ensure_creates_repo_with_turkish_starter_files(mem: MemEnv) -> None:
    await mem.svc.ensure(mem.ws.id)
    root = _root(mem)
    assert (root / ".git").is_dir()
    for rel in ("facts.md", "boundaries.md", "decisions/README.md", "sessions/README.md"):
        assert (root / rel).is_file(), rel
    facts = (root / "facts.md").read_text()
    assert facts.startswith("# Proje gerçekleri")
    assert "## Teknoloji yığını" in facts
    log = _git(root, "log", "--format=%an|%s")
    assert log.strip() == "AI Studio|Hafıza başlatıldı"

    await mem.svc.ensure(mem.ws.id)  # idempotent: no second commit
    assert len(_git(root, "log", "--format=%H").split()) == 1
    events = await mem.ctx.events.query(EventFilter(types=["memory.initialized"]))
    assert len(events) == 1 and events[0].workspace_id == mem.ws.id


async def test_list_and_read_docs(mem: MemEnv) -> None:
    docs = await mem.svc.list_docs(mem.ws.id)
    assert [(d.path, d.layer) for d in docs] == [
        ("facts.md", "facts"),
        ("boundaries.md", "boundaries"),
        ("decisions/README.md", "decisions"),
        ("sessions/README.md", "sessions"),
    ]
    titles = {d.path: d.title for d in docs}
    assert titles["facts.md"] == "Proje gerçekleri"
    assert titles["boundaries.md"] == "Sınırlar"
    assert titles["decisions/README.md"] == "Karar kayıtları"
    assert all(d.updated_at is not None for d in docs)

    doc = await mem.svc.read(mem.ws.id, "boundaries.md")
    assert doc.content.startswith("---\n")
    with pytest.raises(NotFound):
        await mem.svc.read(mem.ws.id, "decisions/2026-01-01-yok.md")


@pytest.mark.parametrize(
    "bad",
    ["../facts.md", "/etc/passwd", "notes.txt", "random.md", ".git/config", "decisions/../facts.md", "", "sessions/"],
)
def test_path_validation_rejects(bad: str) -> None:
    with pytest.raises(ValidationFailed):
        normalize_path(bad)


def test_path_validation_layers() -> None:
    assert normalize_path("facts.md") == ("facts.md", "facts")
    assert normalize_path(" decisions/2026-10-01-veritabanı.md ") == ("decisions/2026-10-01-veritabanı.md", "decisions")
    assert normalize_path("sessions/2026/x.md")[1] == "sessions"


async def test_write_commits_and_history_records_actor(mem: MemEnv) -> None:
    content = "# Proje gerçekleri\n\n## Amaç\nÖdeme altyapısı.\n"
    sha = await mem.svc.write(mem.ws.id, "facts.md", content, message="Amaç yazıldı")
    assert sha == await mem.svc.head(mem.ws.id)
    assert (await mem.svc.read(mem.ws.id, "facts.md")).content == content

    history = await mem.svc.history(mem.ws.id)
    assert history[0].sha == sha
    assert history[0].message == "Amaç yazıldı"
    assert history[0].actor == "user"
    assert history[0].author == "AI Studio"
    assert history[0].paths == ["facts.md"]
    assert history[-1].message == "Hafıza başlatıldı"

    only_facts = await mem.svc.history(mem.ws.id, path="facts.md")
    assert [c.sha for c in only_facts] == [sha, history[-1].sha]

    # Writing identical content creates no new commit.
    again = await mem.svc.write(mem.ws.id, "facts.md", content, message="Aynı")
    assert again == sha
    assert len(await mem.svc.history(mem.ws.id)) == 2

    updated = await mem.ctx.events.query(EventFilter(types=["memory.updated"]))
    assert [e.payload["path"] for e in updated] == ["facts.md"]


async def test_new_decision_file_and_crlf_normalization(mem: MemEnv) -> None:
    await mem.svc.write(mem.ws.id, "decisions/2026-10-01-postgres.md", "# PostgreSQL\r\n\r\nKarar.", message="Karar")
    doc = await mem.svc.read(mem.ws.id, "decisions/2026-10-01-postgres.md")
    assert doc.content == "# PostgreSQL\n\nKarar.\n"
    assert doc.layer == "decisions" and doc.title == "PostgreSQL"


async def test_diff_and_restore_never_rewrite_history(mem: MemEnv) -> None:
    first = await mem.svc.head(mem.ws.id)
    assert first is not None
    await mem.svc.write(mem.ws.id, "facts.md", "# Proje gerçekleri\n\nSürüm 2\n", message="v2")
    await mem.svc.write(mem.ws.id, "decisions/2026-10-02-x.md", "# X\n", message="karar")
    head = await mem.svc.head(mem.ws.id)
    assert head is not None

    d = await mem.svc.diff(mem.ws.id, first, head)
    assert "+Sürüm 2" in d.diff and "decisions/2026-10-02-x.md" in d.diff
    only = await mem.svc.diff(mem.ws.id, first, head, path="facts.md")
    assert "decisions/" not in only.diff

    await mem.svc.restore(mem.ws.id, first, actor="user")
    history = await mem.svc.history(mem.ws.id)
    assert len(history) == 4  # init, v2, karar, restore
    assert history[0].message.startswith("Hafıza ") and "geri yüklendi" in history[0].message
    assert history[0].actor == "user"
    root = _root(mem)
    assert not (root / "decisions/2026-10-02-x.md").exists()
    assert (root / "facts.md").read_text().startswith("# Proje gerçekleri\n\n<!--")
    assert _git(root, "status", "--porcelain").strip() == ""
    restored = await mem.ctx.events.query(EventFilter(types=["memory.restored"]))
    assert restored[0].payload["commit"] == first

    with pytest.raises(ValidationFailed):
        await mem.svc.restore(mem.ws.id, "--orphan")
    with pytest.raises(NotFound):
        await mem.svc.restore(mem.ws.id, "deadbeef")


async def test_external_edits_are_committed_before_head(mem: MemEnv) -> None:
    await mem.svc.ensure(mem.ws.id)
    root = _root(mem)
    (root / "facts.md").write_text("# Proje gerçekleri\n\nDışarıdan düzenlendi.\n")
    (root / "decisions" / "2026-10-03-harici.md").write_text("# Harici karar\n")
    head = await mem.svc.head(mem.ws.id)
    history = await mem.svc.history(mem.ws.id)
    assert history[0].sha == head
    assert history[0].message == "Harici düzenlemeler kaydedildi"
    assert history[0].actor == "external"
    assert sorted(history[0].paths) == ["decisions/2026-10-03-harici.md", "facts.md"]


async def test_user_global_git_config_does_not_interfere(
    mem: MemEnv, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hooks = tmp_path / "hooks"
    hooks.mkdir()
    hook = hooks / "pre-commit"
    hook.write_text("#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)
    cfg = tmp_path / "gitconfig"
    cfg.write_text(f"[commit]\n\tgpgsign = true\n[core]\n\thooksPath = {hooks}\n\tautocrlf = true\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(cfg))
    sha = await mem.svc.write(mem.ws.id, "facts.md", "# Proje gerçekleri\n\nx\n", message="imzasız")
    assert sha == await mem.svc.head(mem.ws.id)


async def test_boundaries_parsing_and_warning_event(mem: MemEnv) -> None:
    assert await mem.svc.boundaries(mem.ws.id) == Boundaries()

    valid = (
        "---\nforbidden_paths: [.env, 'secrets/**']\nreadonly_paths: migrations/**\n"
        "network: false\nsandbox: read_only\nremote_access: read\n---\n# Sınırlar\n"
    )
    await mem.svc.write(mem.ws.id, "boundaries.md", valid, message="sınırlar")
    b = await mem.svc.boundaries(mem.ws.id)
    assert b.forbidden_paths == [".env", "secrets/**"]
    assert b.readonly_paths == ["migrations/**"]
    assert b.network is False and b.sandbox == SandboxLevel.read_only and b.remote_access == "read"
    assert await mem.ctx.events.query(EventFilter(types=["memory.boundaries_invalid"])) == []

    partial = "---\nforbidden_paths: [.env]\nsandbox: uçuk\nfoo: 1\n---\n"
    await mem.svc.write(mem.ws.id, "boundaries.md", partial, message="hatalı alan")
    b = await mem.svc.boundaries(mem.ws.id)
    assert b.forbidden_paths == [".env"] and b.sandbox == SandboxLevel.workspace_write
    warned = await mem.ctx.events.query(EventFilter(types=["memory.boundaries_invalid"]))
    assert len(warned) == 1  # write + read of the same content warn only once
    assert any("sandbox" in w for w in warned[0].payload["warnings"])

    await mem.svc.write(mem.ws.id, "boundaries.md", "---\nforbidden_paths: [a\n---\n", message="bozuk")
    assert await mem.svc.boundaries(mem.ws.id) == Boundaries()
    warned = await mem.ctx.events.query(EventFilter(types=["memory.boundaries_invalid"]))
    assert len(warned) == 2
    assert "YAML" in warned[-1].payload["warnings"][0]


async def test_workspace_created_event_initializes_memory(mem: MemEnv) -> None:
    mem.svc.start()
    ws2 = await mem.workspaces.create(WorkspaceCreate(name="İkinci Alan"))
    root = mem.ctx.settings.paths.memory_dir(ws2.slug)

    async def ready() -> bool:
        return (root / "facts.md").is_file() and (root / ".git").is_dir()

    await eventually(ready)


async def test_unknown_workspace_is_not_found(mem: MemEnv) -> None:
    with pytest.raises(NotFound):
        await mem.svc.list_docs("ws_missing")
