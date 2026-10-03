"""SSHTransport and the connection pool against a real local asyncssh server."""

from __future__ import annotations

import asyncio
import hashlib
import os
import stat
from pathlib import Path

import asyncssh
import pytest
from remote_testlib import RemoteEnv, SshServer, start_echo_server, start_ssh_server

from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.contracts.remote import RemoteService
from aistudio.core.errors import Conflict, PermissionDenied, ValidationFailed
from aistudio.core.events import ET
from aistudio.remote.models import HostRecord, HostUpdate
from aistudio.remote.ssh import HostKeyChanged, HostKeyUnknown, SSHTransport, build_command


async def _host(renv: RemoteEnv, server: SshServer, **kw: object) -> HostRecord:
    defaults: dict[str, object] = {
        "port": server.port,
        "auth": "key",
        "key_path": str(server.client_key_path),
        "username": server.username,
    }
    defaults.update(kw)
    return await renv.add_host(**defaults)


def _trust_app(renv: RemoteEnv, server: SshServer) -> None:
    path = renv.ctx.settings.paths.home / "known_hosts"
    with path.open("a") as f:
        f.write(server.known_hosts_line())


async def _trusted_host(renv: RemoteEnv, server: SshServer, **kw: object) -> HostRecord:
    host = await _host(renv, server, **kw)
    _trust_app(renv, server)
    return host


# ----------------------------------------------------------------------------- host keys


async def test_unknown_host_key_then_trust(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _host(renv, ssh_server)
    with pytest.raises(HostKeyUnknown) as exc:
        await renv.svc.transport(host.id)
    err = exc.value
    assert err.code == "host_key_unknown" and err.status_code == 409
    assert err.details["fingerprint"] == ssh_server.fingerprint
    assert err.details["key_type"] == "ssh-ed25519"
    assert "Bilinmeyen host anahtarı" in err.message

    with pytest.raises(ValidationFailed, match="Parmak izi eşleşmiyor"):
        await renv.svc.trust_host(host.id, "SHA256:not-the-right-one", replace=False)

    result = await renv.svc.trust_host(host.id, ssh_server.fingerprint, replace=False)
    assert result.fingerprint == ssh_server.fingerprint and not result.already_trusted
    app_file = Path(result.known_hosts_path)
    assert f"[127.0.0.1]:{ssh_server.port} ssh-ed25519" in app_file.read_text()
    assert stat.S_IMODE(app_file.stat().st_mode) == 0o600

    transport = await renv.svc.transport(host.id)
    res = await transport.run(["echo", "merhaba"])
    assert res.returncode == 0 and res.stdout == "merhaba\n"

    again = await renv.svc.trust_host(host.id, ssh_server.fingerprint, replace=False)
    assert again.already_trusted
    events = await renv.events("remote.host.trusted")
    assert len(events) == 1
    assert events[0].payload["fingerprint_sha256_hex"] == hashlib.sha256(ssh_server.host_key.public_data).hexdigest()


async def test_trust_accepts_fingerprint_without_prefix(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _host(renv, ssh_server)
    result = await renv.svc.trust_host(host.id, ssh_server.fingerprint.removeprefix("SHA256:"), replace=False)
    assert result.fingerprint == ssh_server.fingerprint


async def test_changed_host_key_is_refused(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _host(renv, ssh_server)
    other = asyncssh.generate_private_key("ssh-ed25519")
    (renv.ctx.settings.paths.home / "known_hosts").write_text(ssh_server.known_hosts_line(key=other))
    with pytest.raises(HostKeyChanged) as exc:
        await renv.svc.transport(host.id)
    assert "ortadaki adam" in exc.value.message
    assert exc.value.details["fingerprint"] == ssh_server.fingerprint
    with pytest.raises(Conflict):
        await renv.svc.trust_host(host.id, ssh_server.fingerprint, replace=False)
    await renv.svc.trust_host(host.id, ssh_server.fingerprint, replace=True)
    content = (renv.ctx.settings.paths.home / "known_hosts").read_text()
    assert content.count(f"[127.0.0.1]:{ssh_server.port}") == 1
    transport = await renv.svc.transport(host.id)
    assert (await transport.run(["true"])).returncode == 0


async def test_users_known_hosts_is_honoured(renv: RemoteEnv, ssh_server: SshServer, user_home: Path) -> None:
    (user_home / ".ssh" / "known_hosts").write_text(ssh_server.known_hosts_line())
    host = await _host(renv, ssh_server)
    transport = await renv.svc.transport(host.id)
    assert (await transport.run(["true"])).returncode == 0
    assert not (renv.ctx.settings.paths.home / "known_hosts").exists()


async def test_test_host_reports_unknown_key(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _host(renv, ssh_server)
    result = await renv.svc.test_host(host.id)
    assert not result.ok and result.error_code == "host_key_unknown"
    assert result.details["fingerprint"] == ssh_server.fingerprint
    _trust_app(renv, ssh_server)
    result = await renv.svc.test_host(host.id)
    assert result.ok and result.uname and result.latency_ms is not None


# ----------------------------------------------------------------------------- auth


async def test_password_auth(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _trusted_host(renv, ssh_server, auth="password", key_path=None, password=ssh_server.password)
    assert host.has_password
    transport = await renv.svc.transport(host.id)
    assert (await transport.run(["true"])).returncode == 0

    bad = await _host(
        renv, ssh_server, name="bad", auth="password", key_path=None, password="wrong-" + os.urandom(4).hex()
    )
    with pytest.raises(PermissionDenied, match="kimlik doğrulaması başarısız"):
        await renv.svc.transport(bad.id)


async def test_encrypted_key_with_passphrase(renv: RemoteEnv, ssh_server: SshServer, tmp_path: Path) -> None:
    passphrase = "pp-" + os.urandom(6).hex()
    key_path = tmp_path / "id_encrypted"
    ssh_server.client_key.write_private_key(str(key_path), format_name="pkcs8-pem", passphrase=passphrase)
    host = await _trusted_host(renv, ssh_server, key_path=str(key_path), passphrase=passphrase)
    assert host.has_passphrase
    assert (await (await renv.svc.transport(host.id)).run(["true"])).returncode == 0

    no_pass = await _host(renv, ssh_server, name="nopass", key_path=str(key_path))
    with pytest.raises(ValidationFailed, match="Özel anahtar"):
        await renv.svc.transport(no_pass.id)


async def test_missing_key_file(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _trusted_host(renv, ssh_server, key_path="/nonexistent/id_x")
    with pytest.raises(ValidationFailed, match="Anahtar dosyası bulunamadı"):
        await renv.svc.transport(host.id)


# ----------------------------------------------------------------------------- transport


async def test_run_env_cwd_and_quoting(renv: RemoteEnv, ssh_server: SshServer, tmp_path: Path) -> None:
    host = await _trusted_host(renv, ssh_server)
    t = await renv.svc.transport(host.id)
    workdir = tmp_path / "work dir"
    workdir.mkdir()
    res = await t.run(
        ["sh", "-c", 'printf "%s|%s|%s" "$FOO" "${HOME-unset}" "$(pwd)"'],
        cwd=str(workdir),
        env={"FOO": "a b'c $x", "PATH": os.environ["PATH"]},
    )
    assert res.returncode == 0, res.stderr
    assert res.stdout == f"a b'c $x|unset|{workdir}"
    # argv is passed literally: no shell injection through arguments
    res = await t.run(["echo", "a; echo pwned", "$(id)"])
    assert res.stdout == "a; echo pwned $(id)\n"
    res = await t.run(["cat"], input=b"stdin-data")
    assert res.stdout == "stdin-data"
    res = await t.run(["sh", "-c", "echo err >&2; exit 3"])
    assert res.returncode == 3 and res.stderr == "err\n"


async def test_run_timeout(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _trusted_host(renv, ssh_server)
    t = await renv.svc.transport(host.id)
    with pytest.raises(TimeoutError):
        await t.run(["sleep", "5"], timeout=0.3)


async def test_spawn_process(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _trusted_host(renv, ssh_server)
    t = await renv.svc.transport(host.id)
    proc = await t.spawn(["cat"], env={"PATH": os.environ["PATH"]})
    assert proc.pid is None
    await proc.write(b"line1\n")
    assert await proc.readline() == b"line1\n"
    await proc.write(b"line2\n")
    assert await proc.readline() == b"line2\n"
    await proc.close_stdin()
    assert await proc.readline() == b""
    assert await proc.wait() == 0
    assert await proc.read_stderr() == b""


async def test_files_over_sftp(renv: RemoteEnv, ssh_server: SshServer, tmp_path: Path) -> None:
    host = await _trusted_host(renv, ssh_server)
    t = await renv.svc.transport(host.id)
    target = tmp_path / "remote" / "nested" / "f.txt"
    assert not await t.exists(str(target))
    await t.write_file(str(target), b"hello")
    assert target.read_bytes() == b"hello"
    assert await t.exists(str(target))
    assert await t.read_file(str(target)) == b"hello"
    await t.write_file(str(target), b"replaced")
    assert await t.read_file(str(target)) == b"replaced"
    assert [p.name for p in target.parent.iterdir()] == ["f.txt"]  # temp file was renamed away
    with pytest.raises(FileNotFoundError):
        await t.read_file(str(tmp_path / "missing"))


async def test_glob_home_which(renv: RemoteEnv, ssh_server: SshServer, tmp_path: Path, user_home: Path) -> None:
    host = await _trusted_host(renv, ssh_server)
    t = await renv.svc.transport(host.id)
    root = tmp_path / "g"
    (root / "b" / "c").mkdir(parents=True)
    for rel in ("x.txt", "b/y.txt", "b/c/z.txt", "b/c/w.log", ".hidden.txt"):
        (root / rel).write_text("1")
    found = await t.glob(f"{root}/**/*.txt")
    assert found == sorted(str(root / r) for r in ("x.txt", "b/y.txt", "b/c/z.txt", ".hidden.txt"))
    assert await t.glob(f"{root}/*.log") == []
    assert await t.glob(f"{root}/b/c/*.log") == [str(root / "b/c/w.log")]
    assert await t.glob(f"{root}/x.txt") == [str(root / "x.txt")]
    assert await t.glob(str(tmp_path / "nope" / "*.txt")) == []
    assert await t.home() == str(user_home)
    (user_home / "notes.md").write_text("n")
    assert await t.glob("~/*.md") == [str(user_home / "notes.md")]
    assert await t.read_file("~/notes.md") == b"n"
    sh_path = await t.which("sh")
    assert sh_path is not None and sh_path.endswith("/sh")
    assert await t.which("definitely-not-a-binary-xyz") is None
    with pytest.raises(ValueError, match="invalid binary name"):
        await t.which("sh; rm -rf /")


async def test_run_shell_output_bounds(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _trusted_host(renv, ssh_server)
    t = SSHTransport(renv.svc.pool, host.id)
    res = await t.run_shell("echo out; echo err >&2; exit 4", timeout=10)
    assert res.exit_code == 4 and "out" in res.output and "err" in res.output and not res.truncated
    big = await t.run_shell("seq 1 20000", timeout=10, limit=2048)
    assert big.truncated and "kısaltıldı" in big.output and big.output.rstrip().endswith("20000")
    slow = await t.run_shell("sleep 5", timeout=0.3)
    assert slow.timed_out and slow.exit_code is None


async def test_pool_reuses_and_reconnects(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _trusted_host(renv, ssh_server)
    pool = renv.svc.pool
    first = await pool.connection(host.id)
    assert await pool.connection(host.id) is first
    first.close()
    await first.wait_closed()
    second = await pool.connection(host.id)
    assert second is not first
    t = await renv.svc.transport(host.id)
    assert (await t.run(["true"])).returncode == 0
    await renv.svc.store.update_host(host.id, HostUpdate(name="renamed"))


async def test_remote_service_is_registered(renv: RemoteEnv, ssh_server: SshServer) -> None:
    svc = renv.ctx.services.get(RemoteService)  # type: ignore[type-abstract]
    host = await _trusted_host(renv, ssh_server)
    t = await svc.transport(host.id)
    assert t.kind == "ssh" and t.host_id == host.id
    assert (await svc.get_host(host.id)).id == host.id


# ----------------------------------------------------------------------------- end-to-end exec


async def test_exec_end_to_end_over_ssh(renv: RemoteEnv, ssh_server: SshServer, tmp_path: Path) -> None:
    host = await _trusted_host(renv, ssh_server, environment=Environment.test, permission_level=PermissionLevel.full)
    marker = tmp_path / "marker"
    read = await renv.svc.exec(host.id, f"ls {tmp_path}", actor="user")
    assert read.exit_code == 0 and not read.denied
    write = await renv.svc.exec(host.id, f"touch {marker}", actor="user")
    assert write.exit_code == 0 and marker.exists()
    events = await renv.events(ET.REMOTE_COMMAND)
    assert [e.payload["classification"]["klass"] for e in events] == ["read", "write"]
    assert events[1].payload["outcome"] == "executed" and events[1].payload["exit_code"] == 0


async def test_production_write_over_ssh_runs_only_after_approval(
    renv: RemoteEnv, ssh_server: SshServer, tmp_path: Path
) -> None:
    host = await _trusted_host(
        renv, ssh_server, environment=Environment.production, permission_level=PermissionLevel.full
    )
    marker = tmp_path / "prod-marker"
    task = asyncio.create_task(renv.svc.exec(host.id, f"touch {marker}", actor="user"))
    pending = await renv.next_pending()
    await asyncio.sleep(0.1)
    assert not marker.exists()
    await renv.approvals.decide(pending.id, approve=True)
    result = await task
    assert result.exit_code == 0 and marker.exists() and result.approved_by == "user"


async def test_host_key_error_is_audited(renv: RemoteEnv, ssh_server: SshServer) -> None:
    host = await _host(renv, ssh_server)
    with pytest.raises(HostKeyUnknown):
        await renv.svc.exec(host.id, "uptime", actor="user")
    (event,) = await renv.events(ET.REMOTE_COMMAND)
    assert event.payload["outcome"] == "failed" and "Bilinmeyen host anahtarı" in event.payload["error"]


# ----------------------------------------------------------------------------- ProxyJump / tunnels


async def test_proxy_jump(renv: RemoteEnv, tmp_path: Path) -> None:
    jump_srv = await start_ssh_server(tmp_path / "jump", allow_forwarding=True)
    target_srv = await start_ssh_server(tmp_path / "target")
    try:
        jump = await _trusted_host(renv, jump_srv, name="bastion")
        target = await _trusted_host(renv, target_srv, name="inner", jump_host_id=jump.id)
        t = await renv.svc.transport(target.id)
        res = await t.run(["echo", "via-jump"])
        assert res.stdout == "via-jump\n"
        # the jump connection is pooled and shared
        assert await renv.svc.pool.connection(jump.id) is await renv.svc.pool.connection(jump.id)
    finally:
        await renv.svc.pool.close()
        await target_srv.close()
        await jump_srv.close()


async def test_proxy_jump_target_key_must_be_trusted(renv: RemoteEnv, tmp_path: Path) -> None:
    jump_srv = await start_ssh_server(tmp_path / "jump", allow_forwarding=True)
    target_srv = await start_ssh_server(tmp_path / "target")
    try:
        jump = await _trusted_host(renv, jump_srv, name="bastion")
        target = await _host(renv, target_srv, name="inner", jump_host_id=jump.id)
        with pytest.raises(HostKeyUnknown):
            await renv.svc.transport(target.id)
        await renv.svc.trust_host(target.id, target_srv.fingerprint, replace=False)
        assert (await (await renv.svc.transport(target.id)).run(["true"])).returncode == 0
    finally:
        await renv.svc.pool.close()
        await target_srv.close()
        await jump_srv.close()


async def test_db_tunnel_through_host(renv: RemoteEnv, tmp_path: Path) -> None:
    srv = await start_ssh_server(tmp_path / "fwd", allow_forwarding=True)
    echo, echo_port = await start_echo_server()
    try:
        host = await _trusted_host(renv, srv, name="db-bastion")
        profile = await renv.add_db(
            name="pg-tunnel", kind="postgres", host="127.0.0.1", port=echo_port, via_host_id=host.id
        )
        async with renv.svc.db_target(profile) as target:
            assert target.tunneled and target.host == "127.0.0.1" and target.port != echo_port
            assert target.port is not None
            reader, writer = await asyncio.open_connection(target.host, target.port)
            writer.write(b"ping-through-tunnel")
            await writer.drain()
            assert await reader.readexactly(19) == b"ping-through-tunnel"
            writer.close()
    finally:
        echo.close()
        await renv.svc.pool.close()
        await srv.close()


async def test_detect_agents(
    renv: RemoteEnv, ssh_server: SshServer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "claude"
    fake.write_text("#!/bin/sh\necho '2.1.288 (Claude Code)'\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    host = await _trusted_host(renv, ssh_server)
    infos = {i.provider: i for i in await renv.svc.detect_agents(host.id)}
    assert infos["claude"].installed and infos["claude"].path == str(fake)
    assert infos["claude"].version == "2.1.288 (Claude Code)"
    assert "codex" in infos


def test_build_command_quoting() -> None:
    assert build_command(["ls", "-la"]) == "exec ls -la"
    assert build_command(["echo", "a b"], cwd="/srv/my app") == "cd '/srv/my app' && exec echo 'a b'"
    assert build_command(["ls"], cwd="~/x y") == "cd ~/'x y' && exec ls"
    assert build_command(["cmd"], env={"A": "1", "B": "x y"}) == "exec env -i A=1 'B=x y' cmd"
    with pytest.raises(ValueError, match="invalid environment variable"):
        build_command(["cmd"], env={"BAD-NAME": "1"})
    with pytest.raises(ValueError, match="not allowed with env"):
        build_command(["-rf"], env={})
    with pytest.raises(ValueError, match="must not be empty"):
        build_command([])
