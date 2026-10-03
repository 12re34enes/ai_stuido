"""~/.ssh/config parsing and import."""

from __future__ import annotations

from pathlib import Path

import pytest
from remote_testlib import RemoteEnv

from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.core.errors import NotFound
from aistudio.remote.models import SshImportRequest
from aistudio.remote.sshconfig import parse_jump, parse_ssh_config

CONFIG = """\
Host web web-alias
    HostName 10.0.0.5
    Port 2222
    IdentityFile ~/.ssh/id_web

Host bastion
    HostName bastion.example.com
    User admin

Host db-*
    ProxyJump bastion
    User dbadmin

Host db-primary
    HostName 10.0.1.10

Host *.internal !secret.internal
    IdentityFile %d/.ssh/id_%h

Host app.internal
    HostName=app.internal

Host secret.internal

Host none-jump
    HostName nj
    ProxyJump none

Match host foo
    User matched

Include conf.d/*

# defaults last: OpenSSH uses the first value it sees
Host *
    User fallback
"""


def test_parse_ssh_config(tmp_path: Path) -> None:
    ssh_dir = tmp_path / ".ssh"
    (ssh_dir / "conf.d").mkdir(parents=True)
    (ssh_dir / "conf.d" / "extra").write_text("Host extra\n  HostName extra.example\n  ProxyJump ops@hop:2200,second\n")
    entries = {e.alias: e for e in parse_ssh_config(CONFIG, base_dir=ssh_dir, home=tmp_path)}
    assert set(entries) == {
        "web",
        "web-alias",
        "bastion",
        "db-primary",
        "app.internal",
        "secret.internal",
        "none-jump",
        "extra",
    }
    web = entries["web"]
    assert (web.hostname, web.port, web.user, web.identity_file) == (
        "10.0.0.5",
        2222,
        "fallback",
        f"{tmp_path}/.ssh/id_web",
    )
    assert entries["web-alias"].hostname == "10.0.0.5"
    assert entries["bastion"].user == "admin"
    db = entries["db-primary"]
    assert (db.hostname, db.user, db.proxy_jump) == ("10.0.1.10", "dbadmin", "bastion")
    assert entries["app.internal"].identity_file == f"{tmp_path}/.ssh/id_app.internal"
    assert entries["secret.internal"].identity_file is None
    assert entries["none-jump"].proxy_jump is None
    assert entries["extra"].proxy_jump == "ops@hop:2200"


def test_parse_jump() -> None:
    assert parse_jump("bastion") == (None, "bastion", 22)
    assert parse_jump("ops@hop:2200") == ("ops", "hop", 2200)
    assert parse_jump("[::1]:2022") == (None, "::1", 2022)
    assert parse_jump("me@[fe80::1]") == ("me", "fe80::1", 22)


async def test_import_ssh_config(renv: RemoteEnv, user_home: Path) -> None:
    (user_home / ".ssh" / "config").write_text(
        "Host bastion\n  HostName bastion.example.com\n  User admin\n"
        "Host db-primary\n  HostName 10.0.1.10\n  User dbadmin\n  ProxyJump bastion\n  IdentityFile ~/.ssh/id_db\n"
        "Host edge\n  HostName edge.example\n  ProxyJump ops@hop.example:2200\n"
        "Host existing\n  HostName x\n"
        "Host bad\n  HostName 'bad host name'\n"
    )
    await renv.add_host(name="existing")
    preview = {e.alias: e for e in await renv.svc.list_ssh_config(None, None)}
    assert preview["existing"].exists and not preview["bastion"].exists

    result = await renv.svc.import_ssh_config(
        SshImportRequest(environment=Environment.production, permission_level=PermissionLevel.read)
    )
    created = {h.name: h for h in result.created}
    assert set(created) == {"bastion", "db-primary", "edge"}
    skipped = {s.alias: s.reason for s in result.skipped}
    assert "existing" in skipped and "bad" in skipped
    db = created["db-primary"]
    assert db.auth == "key" and db.key_path == f"{user_home}/.ssh/id_db"
    assert db.jump_host_id == created["bastion"].id
    assert db.environment == Environment.production and db.permission_level == PermissionLevel.read
    assert created["bastion"].auth == "agent"
    hosts = {h.name: h for h in await renv.svc.store.list_hosts()}
    hop = hosts["hop.example:2200"]
    assert (hop.hostname, hop.port, hop.username) == ("hop.example", 2200, "ops")
    assert created["edge"].jump_host_id == hop.id


async def test_import_selected_aliases_and_missing_file(renv: RemoteEnv, user_home: Path, tmp_path: Path) -> None:
    cfg = tmp_path / "custom_config"
    cfg.write_text("Host a\n  HostName a.example\nHost b\n  HostName b.example\n")
    result = await renv.svc.import_ssh_config(SshImportRequest(path=str(cfg), aliases=["b"]))
    assert [h.name for h in result.created] == ["b"]
    with pytest.raises(NotFound):
        await renv.svc.import_ssh_config(SshImportRequest(path=str(tmp_path / "missing")))
