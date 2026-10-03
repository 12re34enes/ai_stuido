"""studiod command line.

studiod serve              run the backend (launchd runs this)
studiod install-agent      install/refresh the launchd LaunchAgent (macOS)
studiod uninstall-agent    remove the LaunchAgent
studiod info               print runtime info (port, pid) as JSON
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import socket
import sys

from aistudio import __version__
from aistudio.core.clock import utcnow
from aistudio.core.config import Settings

LAUNCH_AGENT_LABEL = "app.aistudio.studiod"


def _bind(host: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(128)
    sock.set_inheritable(True)
    return sock


async def _serve(settings: Settings) -> None:
    import uvicorn

    from aistudio.bootstrap import build_app, build_context

    ctx = build_context(settings)
    app, _token = build_app(ctx)
    sock = _bind(settings.host, settings.port)
    port = sock.getsockname()[1]
    runtime = {"port": port, "pid": os.getpid(), "version": __version__, "started_at": utcnow().isoformat()}
    settings.paths.runtime_file.write_text(json.dumps(runtime))
    os.chmod(settings.paths.runtime_file, 0o600)
    config = uvicorn.Config(
        app, log_level="info" if settings.dev else "warning", ws_ping_interval=20, ws_ping_timeout=20, lifespan="on"
    )
    server = uvicorn.Server(config)
    try:
        await server.serve(sockets=[sock])
    finally:
        with contextlib.suppress(FileNotFoundError):
            current = json.loads(settings.paths.runtime_file.read_text())
            if current.get("pid") == os.getpid():
                settings.paths.runtime_file.unlink()


def _plist(executable: list[str], settings: Settings) -> str:
    args = "".join(f"\n      <string>{a}</string>" for a in [*executable, "serve"])
    log_dir = settings.paths.logs
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>{LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>{args}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardOutPath</key><string>{log_dir}/studiod.out.log</string>
    <key>StandardErrorPath</key><string>{log_dir}/studiod.err.log</string>
  </dict>
</plist>
"""


def _install_agent(settings: Settings, executable: list[str]) -> int:
    if sys.platform != "darwin":
        print("LaunchAgent yalnız macOS'ta kurulabilir.", file=sys.stderr)
        return 1
    import subprocess
    from pathlib import Path

    settings.paths.ensure()
    target = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCH_AGENT_LABEL}.plist"
    target.parent.mkdir(parents=True, exist_ok=True)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{domain}/{LAUNCH_AGENT_LABEL}"], capture_output=True)
    target.write_text(_plist(executable, settings))
    result = subprocess.run(["launchctl", "bootstrap", domain, str(target)], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        return result.returncode
    print(f"LaunchAgent kuruldu: {target}")
    return 0


def _uninstall_agent() -> int:
    if sys.platform != "darwin":
        return 0
    import subprocess
    from pathlib import Path

    target = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCH_AGENT_LABEL}.plist"
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LAUNCH_AGENT_LABEL}"], capture_output=True)
    target.unlink(missing_ok=True)
    print("LaunchAgent kaldırıldı.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="studiod", description="AI Studio backend")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve")
    inst = sub.add_parser("install-agent")
    inst.add_argument(
        "--executable",
        nargs="+",
        default=None,
        help="Command that starts studiod (default: this interpreter + -m aistudio)",
    )
    sub.add_parser("uninstall-agent")
    sub.add_parser("info")
    args = parser.parse_args(argv)

    settings = Settings.from_env()
    logging.basicConfig(
        level=logging.INFO if settings.dev else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if args.cmd == "serve":
        asyncio.run(_serve(settings))
        return 0
    if args.cmd == "install-agent":
        return _install_agent(settings, args.executable or [sys.executable, "-m", "aistudio"])
    if args.cmd == "uninstall-agent":
        return _uninstall_agent()
    if args.cmd == "info":
        try:
            print(settings.paths.runtime_file.read_text())
        except FileNotFoundError:
            print(json.dumps({"running": False}))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
